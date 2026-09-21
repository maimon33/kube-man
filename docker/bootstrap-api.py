#!/usr/bin/env python3
"""KubeMan identity service.

Handles first-run initialization, Google sign-in, sessions, users, roles and the
permission checks used by the gateway (Caddy `forward_auth`) and the console UI.
Runs behind the gateway on a single origin, so it needs no CORS and derives all
public URLs from KUBEMAN_PUBLIC_URL or the forwarded request headers.
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DATA_DIR = Path(os.getenv("KUBEMAN_DATA_DIR", str(Path.home() / ".kubeman-bootstrap")))
STATE_FILE = DATA_DIR / "system.json"
CODE_FILE = DATA_DIR / "startup-code"
GOOGLE_SECRET_FILE = DATA_DIR / "google-client-secret"
OAUTH_STATE_FILE = DATA_DIR / "oauth-state.json"
DB_FILE = DATA_DIR / "identity.db"
LEGACY_SESSIONS_FILE = DATA_DIR / "sessions.json"
PORT = int(os.getenv("KUBEMAN_IDENTITY_PORT", "7683"))
SESSION_SECONDS = 43200
FAILED_ATTEMPTS = []
DB_LOCK = threading.RLock()

# Permission catalog. Keys are stable identifiers; enforcement points reference
# them by name. Add new permissions here and (optionally) to the built-in roles.
PERMISSIONS = {
    "clusters:view": ("Clusters", "View discovered clusters and their infrastructure"),
    "clusters:manage": ("Clusters", "Add, refresh and remove clusters and tunnels"),
    "credentials:manage": ("Clusters", "Connect AWS credentials and run discovery"),
    "resources:view": ("Kubernetes", "View workloads, services and topology"),
    "resources:manage": ("Kubernetes", "Change or delete Kubernetes resources"),
    "events:view": ("Kubernetes", "View events and history"),
    "terminal:use": ("Terminal", "Open a live shell with the mounted kubeconfig"),
    "users:view": ("Administration", "View members and their roles"),
    "users:manage": ("Administration", "Invite, edit, disable and remove members"),
    "roles:manage": ("Administration", "Create and edit custom roles"),
    "audit:view": ("Administration", "View the audit log"),
    "settings:manage": ("Administration", "Change system-wide settings"),
}

# Built-in roles are re-seeded on every start so new permissions propagate.
# They cannot be edited or deleted; create a custom role to tailor access.
SYSTEM_ROLES = {
    "admin": ("Administrator", "Full access, including users, roles and settings", list(PERMISSIONS)),
    "operator": ("Operator", "Operate clusters and use the terminal", [
        "clusters:view", "resources:view", "resources:manage", "events:view", "terminal:use",
    ]),
    "viewer": ("Viewer", "Read-only access to clusters, resources and events", [
        "clusters:view", "resources:view", "events:view",
    ]),
}
DEFAULT_ROLE = "viewer"


# ---------------------------------------------------------------- storage ---

def protected_write(path, value):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".new")
    temp.write_text(value)
    os.chmod(temp, 0o600)
    temp.replace(path)


def read_json(path, fallback):
    try:
        return json.loads(path.read_text()) if path.exists() else fallback
    except (OSError, json.JSONDecodeError):
        return fallback


def now_ts():
    return int(time.time())


def db():
    connection = sqlite3.connect(DB_FILE, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


@contextmanager
def tx():
    """Serialized transaction that commits on success and always closes."""
    with DB_LOCK:
        conn = db()
        try:
            with conn:
                yield conn
        finally:
            conn.close()


def init_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with tx() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS roles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                is_system INTEGER NOT NULL DEFAULT 0,
                permissions TEXT NOT NULL DEFAULT '[]',
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL DEFAULT '',
                role_id TEXT NOT NULL REFERENCES roles(id),
                status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
                is_owner INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                created_by TEXT,
                last_login_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS audit_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                at INTEGER NOT NULL,
                actor TEXT,
                action TEXT NOT NULL,
                target TEXT,
                detail TEXT
            );
        """)
        for role_id, (name, description, permissions) in SYSTEM_ROLES.items():
            conn.execute(
                """INSERT INTO roles (id, name, description, is_system, permissions, created_at)
                   VALUES (?, ?, ?, 1, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
                   is_system = 1, permissions = excluded.permissions""",
                (role_id, name, description, json.dumps(permissions), now_ts()),
            )
        seed_owner(conn)


def seed_owner(conn):
    """Make sure the administrator chosen during initialization exists as a user.

    This also upgrades installations created before user management existed.
    """
    state = read_json(STATE_FILE, None)
    if not state or not state.get("adminEmail"):
        return
    email = state["adminEmail"]
    if conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
        return
    conn.execute(
        "INSERT INTO users (id, email, name, role_id, status, is_owner, created_at) VALUES (?, ?, ?, 'admin', 'active', 1, ?)",
        (str(uuid.uuid4()), email, email.split("@", 1)[0], now_ts()),
    )


def audit(conn, actor, action, target="", detail=None):
    conn.execute(
        "INSERT INTO audit_events (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)",
        (now_ts(), actor, action, target, json.dumps(detail) if detail else None),
    )


# ------------------------------------------------------------ system state ---

def startup_code():
    if CODE_FILE.exists():
        return CODE_FILE.read_text().strip()
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    groups = ["".join(secrets.choice(alphabet) for _ in range(5)) for _ in range(4)]
    code = "KMAN-" + "-".join(groups)
    protected_write(CODE_FILE, code)
    return code


def read_state():
    state = read_json(STATE_FILE, None)
    return state if isinstance(state, dict) else None


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
        "allowedDomain": state.get("allowedDomain", ""),
        "configuredAt": state.get("configuredAt", ""),
    }


def validate_email(value):
    return bool(re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value))


# ------------------------------------------------------------- public URL ---

def public_origin(headers):
    """Browser-facing origin, e.g. https://kubeman.example.com (no trailing slash)."""
    configured = os.getenv("KUBEMAN_PUBLIC_URL", "").strip().rstrip("/")
    if configured:
        return configured
    proto = headers.get("X-Forwarded-Proto", "http").split(",")[0].strip() or "http"
    host = headers.get("X-Forwarded-Host") or headers.get("Host") or "localhost:3080"
    return f"{proto}://{host.split(',')[0].strip()}"


def google_redirect_uri(headers):
    return public_origin(headers) + "/auth/google/callback"


# ------------------------------------------------------------- sessions/RBAC ---

def cookie_value(headers, name):
    cookie = SimpleCookie()
    try:
        cookie.load(headers.get("Cookie", ""))
    except Exception:
        return ""
    return cookie[name].value if name in cookie else ""


def user_payload(row, permissions):
    return {
        "id": row["id"], "email": row["email"], "name": row["name"] or row["email"].split("@", 1)[0],
        "roleId": row["role_id"], "isOwner": bool(row["is_owner"]), "permissions": permissions,
        "isAdmin": "users:manage" in permissions,
    }


def session_user(headers):
    token = cookie_value(headers, "kubeman_session")
    if not token:
        return None
    with tx() as conn:
        row = conn.execute(
            """SELECT u.*, r.permissions AS role_permissions FROM sessions s
               JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id
               WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'""",
            (hashlib.sha256(token.encode()).hexdigest(), now_ts()),
        ).fetchone()
    if not row:
        return None
    return user_payload(row, json.loads(row["role_permissions"]))


def create_session(conn, user_id):
    token = secrets.token_urlsafe(48)
    conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now_ts(),))
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
        (hashlib.sha256(token.encode()).hexdigest(), user_id, now_ts() + SESSION_SECONDS),
    )
    return token


def authorize_google_profile(profile):
    """Match a verified Google identity to a user and open a session."""
    config = read_state()
    email = str(profile.get("email", "")).strip().lower()
    if not profile.get("email_verified") or not validate_email(email):
        raise PermissionError("Google did not return a verified email")
    allowed_domain = config.get("allowedDomain", "")
    denied = ""
    token = ""
    with tx() as conn:
        user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if user and user["status"] == "disabled":
            audit(conn, email, "login.denied", email, {"reason": "disabled"})
            denied = "This account has been disabled"
        elif not user and (not allowed_domain or not email.endswith("@" + allowed_domain)):
            audit(conn, email, "login.denied", email, {"reason": "not_invited"})
            denied = "This Google account is not allowed to access KubeMan"
        else:
            if not user:
                user_id = str(uuid.uuid4())
                conn.execute(
                    "INSERT INTO users (id, email, name, role_id, status, created_at, created_by) VALUES (?, ?, ?, ?, 'active', ?, 'domain-policy')",
                    (user_id, email, str(profile.get("name") or email.split("@", 1)[0]), DEFAULT_ROLE, now_ts()),
                )
                audit(conn, email, "user.autoprovisioned", email, {"role": DEFAULT_ROLE, "domain": allowed_domain})
            else:
                user_id = user["id"]
            conn.execute(
                "UPDATE users SET status = 'active', last_login_at = ?, name = CASE WHEN name = '' THEN ? ELSE name END WHERE id = ?",
                (now_ts(), str(profile.get("name") or ""), user_id),
            )
            token = create_session(conn, user_id)
            audit(conn, email, "login", email)
    if denied:
        raise PermissionError(denied)
    return token


def exchange_google_code(headers, code):
    config = read_state()
    client_secret = Path(config["googleClientSecretFile"]).read_text().strip()
    body = urllib.parse.urlencode({
        "code": code,
        "client_id": config["googleClientId"],
        "client_secret": client_secret,
        "redirect_uri": google_redirect_uri(headers),
        "grant_type": "authorization_code",
    }).encode()
    token_request = urllib.request.Request("https://oauth2.googleapis.com/token", data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(token_request, timeout=20) as response:
        token = json.loads(response.read()).get("access_token", "")
    user_request = urllib.request.Request("https://openidconnect.googleapis.com/v1/userinfo", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(user_request, timeout=20) as response:
        return json.loads(response.read())


def google_authorization_url(headers):
    state = secrets.token_urlsafe(32)
    protected_write(OAUTH_STATE_FILE, json.dumps({"stateHash": hashlib.sha256(state.encode()).hexdigest(), "createdAt": time.time()}))
    config = read_state()
    query = urllib.parse.urlencode({
        "client_id": config["googleClientId"],
        "redirect_uri": google_redirect_uri(headers),
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "prompt": "select_account",
    })
    return f"https://accounts.google.com/o/oauth2/v2/auth?{query}", state


# --------------------------------------------------------- initialization ---

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
        "version": 2,
        "adminEmail": admin_email,
        "googleMode": google_mode,
        "googleClientId": client_id,
        "googleClientSecretFile": str(GOOGLE_SECRET_FILE),
        "allowedDomain": allowed_domain,
        "configuredAt": datetime.now(timezone.utc).isoformat(),
    }
    protected_write(STATE_FILE, json.dumps(state, indent=2))
    with tx() as conn:
        seed_owner(conn)
        audit(conn, admin_email, "system.initialized", "", {"googleMode": google_mode, "allowedDomain": allowed_domain})
    CODE_FILE.unlink(missing_ok=True)
    return public_status()


# ------------------------------------------------------------ admin logic ---

class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def user_row_payload(row):
    return {
        "id": row["id"], "email": row["email"], "name": row["name"] or row["email"].split("@", 1)[0],
        "roleId": row["role_id"], "roleName": row["role_name"], "status": row["status"],
        "isOwner": bool(row["is_owner"]), "createdAt": row["created_at"], "lastLoginAt": row["last_login_at"],
    }


def list_users(conn):
    rows = conn.execute(
        "SELECT u.*, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.is_owner DESC, u.email"
    ).fetchall()
    return [user_row_payload(row) for row in rows]


def role_payload(row, user_count):
    return {
        "id": row["id"], "name": row["name"], "description": row["description"], "isSystem": bool(row["is_system"]),
        "permissions": json.loads(row["permissions"]), "userCount": user_count,
    }


def list_roles(conn):
    counts = {row["role_id"]: row["n"] for row in conn.execute("SELECT role_id, COUNT(*) AS n FROM users GROUP BY role_id")}
    rows = conn.execute("SELECT * FROM roles ORDER BY is_system DESC, name").fetchall()
    return [role_payload(row, counts.get(row["id"], 0)) for row in rows]


def require_role(conn, role_id):
    if not conn.execute("SELECT 1 FROM roles WHERE id = ?", (role_id,)).fetchone():
        raise ApiError(400, "Choose an existing role")


def clean_permissions(values):
    if not isinstance(values, list) or not all(isinstance(item, str) for item in values):
        raise ApiError(400, "Permissions must be a list")
    unknown = [item for item in values if item not in PERMISSIONS]
    if unknown:
        raise ApiError(400, f"Unknown permission: {unknown[0]}")
    return sorted(set(values))


def active_managers(conn, excluding_user=None, excluding_role=None):
    """Active users whose role still grants users:manage (protects the last admin)."""
    count = 0
    for row in conn.execute("SELECT u.id, u.role_id, r.permissions FROM users u JOIN roles r ON r.id = u.role_id WHERE u.status = 'active'"):
        if row["id"] == excluding_user:
            continue
        if row["role_id"] == excluding_role:
            continue
        if "users:manage" in json.loads(row["permissions"]):
            count += 1
    return count


def create_user(conn, actor, payload):
    email = str(payload.get("email", "")).strip().lower()
    if not validate_email(email):
        raise ApiError(400, "Enter a valid email address")
    role_id = str(payload.get("roleId", DEFAULT_ROLE))
    require_role(conn, role_id)
    if conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
        raise ApiError(409, "A user with this email already exists")
    user_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO users (id, email, name, role_id, status, created_at, created_by) VALUES (?, ?, ?, ?, 'invited', ?, ?)",
        (user_id, email, str(payload.get("name", "")).strip()[:120], role_id, now_ts(), actor["email"]),
    )
    audit(conn, actor["email"], "user.invited", email, {"role": role_id})
    return user_id


def update_user(conn, actor, user_id, payload):
    user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if not user:
        raise ApiError(404, "User not found")
    role_id = str(payload.get("roleId", user["role_id"]))
    status = str(payload.get("status", user["status"]))
    name = str(payload.get("name", user["name"])).strip()[:120]
    if status not in ("active", "disabled", "invited"):
        raise ApiError(400, "Unsupported status")
    require_role(conn, role_id)
    if user["is_owner"] and (status == "disabled" or role_id != user["role_id"]):
        raise ApiError(400, "The initial administrator cannot be disabled or reassigned")
    if user["id"] == actor["id"] and (status == "disabled" or role_id != user["role_id"]):
        raise ApiError(400, "You cannot change your own role or disable your own account")
    new_permissions = json.loads(conn.execute("SELECT permissions FROM roles WHERE id = ?", (role_id,)).fetchone()["permissions"])
    still_manager = status == "active" and "users:manage" in new_permissions
    if not still_manager and active_managers(conn, excluding_user=user_id) == 0:
        raise ApiError(400, "At least one active user must keep the ability to manage users")
    conn.execute("UPDATE users SET role_id = ?, status = ?, name = ? WHERE id = ?", (role_id, status, name, user_id))
    if status == "disabled":
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    if role_id != user["role_id"]:
        audit(conn, actor["email"], "user.role_changed", user["email"], {"from": user["role_id"], "to": role_id})
    if status != user["status"]:
        audit(conn, actor["email"], "user.status_changed", user["email"], {"from": user["status"], "to": status})


def delete_user(conn, actor, user_id):
    user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if not user:
        raise ApiError(404, "User not found")
    if user["is_owner"]:
        raise ApiError(400, "The initial administrator cannot be removed")
    if user["id"] == actor["id"]:
        raise ApiError(400, "You cannot remove your own account")
    if active_managers(conn, excluding_user=user_id) == 0:
        raise ApiError(400, "At least one active user must keep the ability to manage users")
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    audit(conn, actor["email"], "user.removed", user["email"])


def role_id_from_name(name):
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if not slug:
        raise ApiError(400, "Enter a role name")
    return "custom-" + slug[:40]


def create_role(conn, actor, payload):
    name = str(payload.get("name", "")).strip()[:60]
    role_id = role_id_from_name(name)
    if conn.execute("SELECT 1 FROM roles WHERE id = ?", (role_id,)).fetchone():
        raise ApiError(409, "A role with this name already exists")
    permissions = clean_permissions(payload.get("permissions", []))
    conn.execute(
        "INSERT INTO roles (id, name, description, is_system, permissions, created_at) VALUES (?, ?, ?, 0, ?, ?)",
        (role_id, name, str(payload.get("description", "")).strip()[:200], json.dumps(permissions), now_ts()),
    )
    audit(conn, actor["email"], "role.created", role_id, {"permissions": permissions})
    return role_id


def update_role(conn, actor, role_id, payload):
    role = conn.execute("SELECT * FROM roles WHERE id = ?", (role_id,)).fetchone()
    if not role:
        raise ApiError(404, "Role not found")
    if role["is_system"]:
        raise ApiError(400, "Built-in roles cannot be edited. Create a custom role instead")
    name = str(payload.get("name", role["name"])).strip()[:60] or role["name"]
    permissions = clean_permissions(payload.get("permissions", json.loads(role["permissions"])))
    if "users:manage" not in permissions and active_managers(conn, excluding_role=role_id) == 0:
        raise ApiError(400, "At least one active user must keep the ability to manage users")
    conn.execute(
        "UPDATE roles SET name = ?, description = ?, permissions = ? WHERE id = ?",
        (name, str(payload.get("description", role["description"])).strip()[:200], json.dumps(permissions), role_id),
    )
    audit(conn, actor["email"], "role.updated", role_id, {"permissions": permissions})


def delete_role(conn, actor, role_id):
    role = conn.execute("SELECT * FROM roles WHERE id = ?", (role_id,)).fetchone()
    if not role:
        raise ApiError(404, "Role not found")
    if role["is_system"]:
        raise ApiError(400, "Built-in roles cannot be deleted")
    if conn.execute("SELECT 1 FROM users WHERE role_id = ?", (role_id,)).fetchone():
        raise ApiError(409, "Reassign the users in this role before deleting it")
    conn.execute("DELETE FROM roles WHERE id = ?", (role_id,))
    audit(conn, actor["email"], "role.deleted", role_id)


def list_audit(conn, limit):
    rows = conn.execute("SELECT * FROM audit_events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [{
        "id": row["id"], "at": row["at"], "actor": row["actor"], "action": row["action"],
        "target": row["target"], "detail": json.loads(row["detail"]) if row["detail"] else None,
    } for row in rows]


# ------------------------------------------------------------------- HTTP ---

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def secure_cookie(self):
        return "; Secure" if public_origin(self.headers).startswith("https://") else ""

    def respond(self, status, payload, cookies=None):
        body = json.dumps(payload).encode()
        self.send_response(status)
        for value in cookies or []:
            self.send_header("Set-Cookie", value)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def redirect(self, location, cookies=None):
        self.send_response(302)
        for value in cookies or []:
            self.send_header("Set-Cookie", value)
        self.send_header("Location", location)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def require(self, permission=None):
        user = session_user(self.headers)
        if not user:
            raise ApiError(401, "Sign in required")
        if permission and permission not in user["permissions"]:
            raise ApiError(403, "You do not have permission to do this")
        return user

    def check_csrf(self):
        """State-changing requests must come from the console itself."""
        if self.headers.get("X-KubeMan-Request") != "1":
            raise ApiError(403, "Missing request header")
        origin = self.headers.get("Origin", "")
        if origin and origin.rstrip("/") != public_origin(self.headers):
            raise ApiError(403, "Cross-origin request rejected")

    def read_body(self, limit=32768):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > limit:
            raise ValueError("Invalid request size")
        payload = json.loads(self.rfile.read(length))
        if not isinstance(payload, dict):
            raise ValueError("Invalid request body")
        return payload

    def dispatch(self, handler):
        try:
            handler()
        except ApiError as error:
            self.respond(error.status, {"error": str(error)})
        except PermissionError as error:
            self.respond(429 if "Too many" in str(error) else 403, {"error": str(error)})
        except (ValueError, json.JSONDecodeError) as error:
            self.respond(400, {"error": str(error)})
        except Exception:
            self.respond(500, {"error": "The request failed unexpectedly"})

    # -- GET ---------------------------------------------------------------
    def do_GET(self):
        self.dispatch(self.handle_get)

    def handle_get(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        if path == "/health":
            return self.respond(200, {"ok": True})
        if path == "/status":
            return self.respond(200, public_status())
        if path == "/session":
            user = session_user(self.headers)
            return self.respond(200, {"authenticated": bool(user), "user": user})
        if path == "/auth/check":
            # Used by the gateway (forward_auth) to protect shell and AWS routes.
            user = self.require(query.get("permission", [None])[0])
            self.send_response(200)
            self.send_header("X-KubeMan-User", user["email"])
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/auth/google/start":
            if not read_state():
                raise ApiError(409, "KubeMan is not initialized")
            location, state = google_authorization_url(self.headers)
            return self.redirect(location, [f"kubeman_oauth_state={state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600{self.secure_cookie()}"])
        if path == "/auth/google/callback":
            return self.handle_google_callback(query)
        if path == "/api/permissions":
            self.require()
            return self.respond(200, {"permissions": [{"id": key, "group": group, "description": text} for key, (group, text) in PERMISSIONS.items()]})
        if path == "/api/users":
            self.require("users:view")
            with tx() as conn:
                return self.respond(200, {"users": list_users(conn)})
        if path == "/api/roles":
            self.require("users:view")
            with tx() as conn:
                return self.respond(200, {"roles": list_roles(conn)})
        if path == "/api/audit":
            self.require("audit:view")
            limit = min(max(int(query.get("limit", ["100"])[0]), 1), 500)
            with tx() as conn:
                return self.respond(200, {"events": list_audit(conn, limit)})
        raise ApiError(404, "Not found")

    def handle_google_callback(self, query):
        state = query.get("state", [""])[0]
        code = query.get("code", [""])[0]
        saved = read_json(OAUTH_STATE_FILE, {})
        expected_state = cookie_value(self.headers, "kubeman_oauth_state")
        state_ok = (
            expected_state and hmac.compare_digest(state, expected_state)
            and hmac.compare_digest(saved.get("stateHash", ""), hashlib.sha256(state.encode()).hexdigest())
            and time.time() - saved.get("createdAt", 0) < 600
        )
        home = public_origin(self.headers) + "/"
        if not state_ok or not code:
            return self.redirect(home + "?auth_error=invalid_oauth_response")
        clear_state = f"kubeman_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0{self.secure_cookie()}"
        try:
            profile = exchange_google_code(self.headers, code)
            session_token = authorize_google_profile(profile)
            OAUTH_STATE_FILE.unlink(missing_ok=True)
            return self.redirect(home, [
                f"kubeman_session={session_token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_SECONDS}{self.secure_cookie()}",
                clear_state,
            ])
        except PermissionError as error:
            reason = "account_disabled" if "disabled" in str(error) else "not_allowed"
            return self.redirect(f"{home}?auth_error={reason}", [clear_state])
        except (urllib.error.URLError, ValueError, KeyError):
            return self.redirect(home + "?auth_error=google_sign_in_failed", [clear_state])

    # -- POST / PATCH / DELETE ---------------------------------------------
    def do_POST(self):
        self.dispatch(self.handle_post)

    def do_PATCH(self):
        self.dispatch(self.handle_patch)

    def do_DELETE(self):
        self.dispatch(self.handle_delete)

    def handle_post(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/initialize":
            return self.respond(200, initialize(self.read_body()))
        self.check_csrf()
        if path == "/logout":
            token = cookie_value(self.headers, "kubeman_session")
            with tx() as conn:
                conn.execute("DELETE FROM sessions WHERE token_hash = ?", (hashlib.sha256(token.encode()).hexdigest(),))
            return self.respond(200, {"ok": True}, [f"kubeman_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0{self.secure_cookie()}"])
        if path == "/api/users":
            actor = self.require("users:manage")
            with tx() as conn:
                create_user(conn, actor, self.read_body())
                return self.respond(201, {"users": list_users(conn)})
        if path == "/api/roles":
            actor = self.require("roles:manage")
            with tx() as conn:
                create_role(conn, actor, self.read_body())
                return self.respond(201, {"roles": list_roles(conn)})
        raise ApiError(404, "Not found")

    def handle_patch(self):
        path = urllib.parse.urlparse(self.path).path
        self.check_csrf()
        match = re.fullmatch(r"/api/users/([0-9a-f-]{36})", path)
        if match:
            actor = self.require("users:manage")
            with tx() as conn:
                update_user(conn, actor, match.group(1), self.read_body())
                return self.respond(200, {"users": list_users(conn)})
        match = re.fullmatch(r"/api/roles/([a-z0-9-]{1,60})", path)
        if match:
            actor = self.require("roles:manage")
            with tx() as conn:
                update_role(conn, actor, match.group(1), self.read_body())
                return self.respond(200, {"roles": list_roles(conn)})
        raise ApiError(404, "Not found")

    def handle_delete(self):
        path = urllib.parse.urlparse(self.path).path
        self.check_csrf()
        match = re.fullmatch(r"/api/users/([0-9a-f-]{36})", path)
        if match:
            actor = self.require("users:manage")
            with tx() as conn:
                delete_user(conn, actor, match.group(1))
                return self.respond(200, {"users": list_users(conn)})
        match = re.fullmatch(r"/api/roles/([a-z0-9-]{1,60})", path)
        if match:
            actor = self.require("roles:manage")
            with tx() as conn:
                delete_role(conn, actor, match.group(1))
                return self.respond(200, {"roles": list_roles(conn)})
        raise ApiError(404, "Not found")


if __name__ == "__main__":
    init_db()
    LEGACY_SESSIONS_FILE.unlink(missing_ok=True)  # Sessions moved to SQLite; users sign in again once.
    if not read_state():
        code = startup_code()
        print("\n" + "=" * 68, flush=True)
        print(" KubeMan one-time startup code", flush=True)
        print(f" {code}", flush=True)
        print(" Open KubeMan in your browser and enter this code.", flush=True)
        print("=" * 68 + "\n", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
