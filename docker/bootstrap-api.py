#!/usr/bin/env python3
import hashlib
import hmac
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import SimpleCookie
from pathlib import Path

DATA_DIR = Path.home() / ".kubeman-bootstrap"
STATE_FILE = DATA_DIR / "system.json"
CODE_FILE = DATA_DIR / "startup-code"
GOOGLE_SECRET_FILE = DATA_DIR / "google-client-secret"
OAUTH_STATE_FILE = DATA_DIR / "oauth-state.json"
SESSIONS_FILE = DATA_DIR / "sessions.json"
ALLOWED_ORIGINS = {"http://localhost:3080", "http://127.0.0.1:3080"}
FAILED_ATTEMPTS = []


def protected_write(path, value):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".new")
    temp.write_text(value)
    os.chmod(temp, 0o600)
    temp.replace(path)


def startup_code():
    if CODE_FILE.exists():
        return CODE_FILE.read_text().strip()
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    groups = ["".join(secrets.choice(alphabet) for _ in range(5)) for _ in range(4)]
    code = "KMAN-" + "-".join(groups)
    protected_write(CODE_FILE, code)
    return code


def read_state():
    if not STATE_FILE.exists():
        return None
    try:
        return json.loads(STATE_FILE.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def public_status():
    state = read_state()
    if not state:
        return {
            "initialized": False,
            "builtInGoogleAvailable": bool(os.getenv("KUBEMAN_GOOGLE_CLIENT_ID") and os.getenv("KUBEMAN_GOOGLE_CLIENT_SECRET")),
        }
    return {
        "initialized": True,
        "adminEmail": state.get("adminEmail", ""),
        "googleMode": state.get("googleMode", "custom"),
        "googleClientId": state.get("googleClientId", ""),
        "configuredAt": state.get("configuredAt", ""),
    }


def read_json(path, fallback):
    try:
        return json.loads(path.read_text()) if path.exists() else fallback
    except (OSError, json.JSONDecodeError):
        return fallback


def cookie_value(headers, name):
    cookie = SimpleCookie()
    cookie.load(headers.get("Cookie", ""))
    return cookie[name].value if name in cookie else ""


def session_user(headers):
    token = cookie_value(headers, "kubeman_session")
    if not token:
        return None
    sessions = read_json(SESSIONS_FILE, {})
    record = sessions.get(hashlib.sha256(token.encode()).hexdigest())
    if not record or record.get("expiresAt", 0) < time.time():
        return None
    return {"email": record.get("email", ""), "name": record.get("name", ""), "isAdmin": record.get("isAdmin", False)}


def google_redirect_uri(host):
    hostname = host.split(":", 1)[0] or "localhost"
    return f"http://{hostname}:7683/auth/google/callback"


def google_authorization_url(host):
    state = secrets.token_urlsafe(32)
    protected_write(OAUTH_STATE_FILE, json.dumps({"stateHash": hashlib.sha256(state.encode()).hexdigest(), "createdAt": time.time()}))
    config = read_state()
    query = urllib.parse.urlencode({
        "client_id": config["googleClientId"],
        "redirect_uri": google_redirect_uri(host),
        "response_type": "code",
        "scope": "openid email",
        "state": state,
        "prompt": "select_account",
    })
    return f"https://accounts.google.com/o/oauth2/v2/auth?{query}", state


def exchange_google_code(host, code):
    config = read_state()
    client_secret = Path(config["googleClientSecretFile"]).read_text().strip()
    body = urllib.parse.urlencode({
        "code": code,
        "client_id": config["googleClientId"],
        "client_secret": client_secret,
        "redirect_uri": google_redirect_uri(host),
        "grant_type": "authorization_code",
    }).encode()
    token_request = urllib.request.Request("https://oauth2.googleapis.com/token", data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(token_request, timeout=20) as response:
        token = json.loads(response.read()).get("access_token", "")
    user_request = urllib.request.Request("https://openidconnect.googleapis.com/v1/userinfo", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(user_request, timeout=20) as response:
        return json.loads(response.read())


def authorize_user(profile):
    config = read_state()
    email = str(profile.get("email", "")).strip().lower()
    if not profile.get("email_verified") or not validate_email(email):
        raise PermissionError("Google did not return a verified email")
    admin_email = config.get("adminEmail", "")
    allowed_domain = config.get("allowedDomain", "")
    if email != admin_email and (not allowed_domain or not email.endswith("@" + allowed_domain)):
        raise PermissionError("This Google account is not allowed to access KubeMan")
    token = secrets.token_urlsafe(48)
    sessions = read_json(SESSIONS_FILE, {})
    now = time.time()
    sessions = {key: value for key, value in sessions.items() if value.get("expiresAt", 0) > now}
    sessions[hashlib.sha256(token.encode()).hexdigest()] = {
        "email": email,
        "name": email.split("@", 1)[0],
        "isAdmin": email == admin_email,
        "expiresAt": now + 43200,
    }
    protected_write(SESSIONS_FILE, json.dumps(sessions, indent=2))
    return token


def validate_email(value):
    return bool(re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value))


def initialize(payload):
    if read_state():
        raise ValueError("KubeMan is already initialized")
    now = time.time()
    FAILED_ATTEMPTS[:] = [attempt for attempt in FAILED_ATTEMPTS if now - attempt < 900]
    if len(FAILED_ATTEMPTS) >= 5:
        raise PermissionError("Too many failed attempts. Try again in 15 minutes")

    supplied_code = str(payload.get("startupCode", "")).strip().upper()
    expected_code = startup_code()
    if not hmac.compare_digest(supplied_code, expected_code):
        FAILED_ATTEMPTS.append(now)
        raise PermissionError("Startup code is incorrect")

    admin_email = str(payload.get("adminEmail", "")).strip().lower()
    if not validate_email(admin_email):
        raise ValueError("Enter a valid administrator email")
    google_mode = str(payload.get("googleMode", "custom"))
    if google_mode not in ("custom", "builtin"):
        raise ValueError("Choose a supported Google application mode")

    if google_mode == "builtin":
        client_id = os.getenv("KUBEMAN_GOOGLE_CLIENT_ID", "").strip()
        client_secret = os.getenv("KUBEMAN_GOOGLE_CLIENT_SECRET", "").strip()
        if not client_id or not client_secret:
            raise ValueError("The preconfigured Google application is not available")
    else:
        client_id = str(payload.get("googleClientId", "")).strip()
        client_secret = str(payload.get("googleClientSecret", "")).strip()
        if not client_id.endswith(".apps.googleusercontent.com"):
            raise ValueError("Enter a valid Google OAuth client ID")
        if len(client_secret) < 12:
            raise ValueError("Enter the Google OAuth client secret")

    allowed_domain = str(payload.get("allowedDomain", "")).strip().lower()
    if allowed_domain and not re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", allowed_domain):
        raise ValueError("Enter a valid allowed email domain")

    protected_write(GOOGLE_SECRET_FILE, client_secret)
    state = {
        "version": 1,
        "adminEmail": admin_email,
        "googleMode": google_mode,
        "googleClientId": client_id,
        "googleClientSecretFile": str(GOOGLE_SECRET_FILE),
        "allowedDomain": allowed_domain,
        "configuredAt": datetime.now(timezone.utc).isoformat(),
    }
    protected_write(STATE_FILE, json.dumps(state, indent=2))
    CODE_FILE.unlink(missing_ok=True)
    return public_status()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def cors(self):
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Credentials", "true")
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

    def redirect(self, location, cookies=None):
        self.send_response(302)
        if cookies:
            for value in cookies:
                self.send_header("Set-Cookie", value)
        self.send_header("Location", location)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            return self.respond(200, {"ok": True})
        if parsed.path == "/status":
            return self.respond(200, public_status())
        if parsed.path == "/session":
            user = session_user(self.headers)
            return self.respond(200, {"authenticated": bool(user), "user": user})
        if parsed.path == "/auth/google/start":
            if not read_state():
                return self.respond(409, {"error": "KubeMan is not initialized"})
            location, state = google_authorization_url(self.headers.get("Host", "localhost:7683"))
            return self.redirect(location, [f"kubeman_oauth_state={state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600"])
        if parsed.path == "/auth/google/callback":
            query = urllib.parse.parse_qs(parsed.query)
            state = query.get("state", [""])[0]
            code = query.get("code", [""])[0]
            saved = read_json(OAUTH_STATE_FILE, {})
            expected_state = cookie_value(self.headers, "kubeman_oauth_state")
            state_ok = expected_state and hmac.compare_digest(state, expected_state) and hmac.compare_digest(saved.get("stateHash", ""), hashlib.sha256(state.encode()).hexdigest()) and time.time() - saved.get("createdAt", 0) < 600
            if not state_ok or not code:
                return self.redirect("http://localhost:3080/?auth_error=invalid_oauth_response")
            try:
                profile = exchange_google_code(self.headers.get("Host", "localhost:7683"), code)
                session_token = authorize_user(profile)
                OAUTH_STATE_FILE.unlink(missing_ok=True)
                return self.redirect("http://localhost:3080/", [
                    f"kubeman_session={session_token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200",
                    "kubeman_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
                ])
            except (PermissionError, urllib.error.URLError, ValueError, KeyError):
                return self.redirect("http://localhost:3080/?auth_error=google_sign_in_failed")
        self.respond(404, {"error": "Not found"})

    def do_POST(self):
        if self.path == "/logout":
            token = cookie_value(self.headers, "kubeman_session")
            sessions = read_json(SESSIONS_FILE, {})
            sessions.pop(hashlib.sha256(token.encode()).hexdigest(), None)
            protected_write(SESSIONS_FILE, json.dumps(sessions, indent=2))
            self.send_response(204)
            self.cors()
            self.send_header("Set-Cookie", "kubeman_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0")
            self.end_headers()
            return
        if self.path != "/initialize":
            return self.respond(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 32768:
                raise ValueError("Invalid request size")
            payload = json.loads(self.rfile.read(length))
            self.respond(200, initialize(payload))
        except PermissionError as error:
            self.respond(429 if "Too many" in str(error) else 403, {"error": str(error)})
        except (ValueError, json.JSONDecodeError) as error:
            self.respond(400, {"error": str(error)})
        except Exception:
            self.respond(500, {"error": "System initialization failed unexpectedly"})


if __name__ == "__main__":
    if not read_state():
        code = startup_code()
        print("\n" + "=" * 68, flush=True)
        print(" KubeMan one-time startup code", flush=True)
        print(f" {code}", flush=True)
        print(" Open http://localhost:3080 and enter this code.", flush=True)
        print("=" * 68 + "\n", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 7683), Handler).serve_forever()
