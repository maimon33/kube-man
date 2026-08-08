#!/usr/bin/env python3
import json
import os
import socket
import subprocess
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

STORE = Path.home() / ".kubeman" / "aws-clusters.json"
ALLOWED_ORIGINS = {
    "http://localhost:3080",
    "http://127.0.0.1:3080",
}


def aws(env, *args):
    command = ["aws", *args, "--output", "json", "--no-cli-pager"]
    result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=45)
    if result.returncode:
        message = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "AWS request failed"
        raise RuntimeError(message)
    return json.loads(result.stdout or "{}")


def role_name(arn):
    return arn.rsplit("/", 1)[-1] if arn else "Unknown role"


def endpoint_ips(endpoint):
    try:
        host = urlparse(endpoint).hostname
        return sorted({item[4][0] for item in socket.getaddrinfo(host, 443)}) if host else []
    except OSError:
        return []


def build_environment(payload):
    env = os.environ.copy()
    region = payload.get("region") or "us-east-1"
    env["AWS_DEFAULT_REGION"] = region
    env["AWS_REGION"] = region
    access_key = payload.get("accessKeyId", "").strip()
    secret_key = payload.get("secretAccessKey", "").strip()
    session_token = payload.get("sessionToken", "").strip()
    profile = payload.get("profile", "").strip()
    if access_key and secret_key:
        env["AWS_ACCESS_KEY_ID"] = access_key
        env["AWS_SECRET_ACCESS_KEY"] = secret_key
        env.pop("AWS_PROFILE", None)
        if session_token:
            env["AWS_SESSION_TOKEN"] = session_token
    elif profile:
        env["AWS_PROFILE"] = profile

    requested_role = payload.get("roleArn", "").strip()
    if requested_role:
        assumed = aws(
            env,
            "sts", "assume-role",
            "--role-arn", requested_role,
            "--role-session-name", "kubeman-cluster-discovery",
        )["Credentials"]
        env["AWS_ACCESS_KEY_ID"] = assumed["AccessKeyId"]
        env["AWS_SECRET_ACCESS_KEY"] = assumed["SecretAccessKey"]
        env["AWS_SESSION_TOKEN"] = assumed["SessionToken"]
        env.pop("AWS_PROFILE", None)
    return env, region


def discover(payload):
    env, requested_region = build_environment(payload)
    identity = aws(env, "sts", "get-caller-identity")
    assigned_role = identity.get("Arn", "")
    if requested_region == "all":
        region_rows = aws(env, "ec2", "describe-regions", "--all-regions").get("Regions", [])
        regions = [row["RegionName"] for row in region_rows if row.get("OptInStatus") in ("opt-in-not-required", "opted-in")]
    else:
        regions = [requested_region]

    clusters = []
    for region in regions:
        region_env = env.copy()
        region_env["AWS_DEFAULT_REGION"] = region
        region_env["AWS_REGION"] = region
        try:
            names = aws(region_env, "eks", "list-clusters").get("clusters", [])
        except RuntimeError:
            if requested_region == "all":
                continue
            raise
        for name in names:
            cluster = aws(region_env, "eks", "describe-cluster", "--name", name).get("cluster", {})
            vpc_config = cluster.get("resourcesVpcConfig", {})
            subnet_ids = vpc_config.get("subnetIds", [])
            security_group_ids = list(dict.fromkeys(
                ([vpc_config.get("clusterSecurityGroupId")] if vpc_config.get("clusterSecurityGroupId") else [])
                + vpc_config.get("securityGroupIds", [])
            ))
            subnet_rows = aws(region_env, "ec2", "describe-subnets", "--subnet-ids", *subnet_ids).get("Subnets", []) if subnet_ids else []
            security_rows = aws(region_env, "ec2", "describe-security-groups", "--group-ids", *security_group_ids).get("SecurityGroups", []) if security_group_ids else []
            vpc_id = vpc_config.get("vpcId", "")
            vpc_rows = aws(region_env, "ec2", "describe-vpcs", "--vpc-ids", vpc_id).get("Vpcs", []) if vpc_id else []
            endpoint = cluster.get("endpoint", "")
            clusters.append({
                "name": name,
                "region": region,
                "status": cluster.get("status", "UNKNOWN"),
                "version": cluster.get("version", ""),
                "platformVersion": cluster.get("platformVersion", ""),
                "createdAt": cluster.get("createdAt", ""),
                "endpoint": endpoint,
                "endpointIps": endpoint_ips(endpoint),
                "assignedRoleArn": assigned_role,
                "assignedRoleName": role_name(assigned_role),
                "clusterServiceRoleArn": cluster.get("roleArn", ""),
                "accountId": identity.get("Account", ""),
                "vpc": vpc_rows[0] if vpc_rows else {"VpcId": vpc_id},
                "subnets": subnet_rows,
                "securityGroups": security_rows,
                "endpointPublicAccess": vpc_config.get("endpointPublicAccess", False),
                "endpointPrivateAccess": vpc_config.get("endpointPrivateAccess", False),
                "publicAccessCidrs": vpc_config.get("publicAccessCidrs", []),
                "networkConfig": cluster.get("kubernetesNetworkConfig", {}),
                "discoveredAt": datetime.now(timezone.utc).isoformat(),
            })

    existing = []
    if STORE.exists():
        try:
            existing = json.loads(STORE.read_text()).get("clusters", [])
        except (OSError, json.JSONDecodeError):
            existing = []
    account_id = identity.get("Account", "")
    if requested_region == "all":
        retained = [item for item in existing if item.get("accountId") != account_id]
    else:
        retained = [item for item in existing if not (item.get("accountId") == account_id and item.get("region") == requested_region)]
    clusters = retained + clusters

    STORE.parent.mkdir(parents=True, exist_ok=True)
    temp = STORE.with_suffix(".tmp")
    temp.write_text(json.dumps({"clusters": clusters}, indent=2))
    os.chmod(temp, 0o600)
    temp.replace(STORE)
    return {"clusters": clusters, "identity": identity}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def cors(self):
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Cache-Control", "no-store")

    def respond(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            return self.respond(200, {"ok": True})
        if self.path == "/clusters":
            try:
                return self.respond(200, json.loads(STORE.read_text()) if STORE.exists() else {"clusters": []})
            except (OSError, json.JSONDecodeError):
                return self.respond(500, {"error": "Saved cluster metadata could not be read"})
        self.respond(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/discover":
            return self.respond(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 65536:
                raise ValueError("Invalid request size")
            payload = json.loads(self.rfile.read(length))
            self.respond(200, discover(payload))
        except (ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired) as error:
            self.respond(400, {"error": str(error)})
        except Exception:
            self.respond(500, {"error": "Cluster discovery failed unexpectedly"})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 7682), Handler).serve_forever()
