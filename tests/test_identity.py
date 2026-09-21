"""Integration tests for the identity service (docker/bootstrap-api.py).

Run with:  python3 -m unittest discover -s tests -p "test_*.py"
Google sign-in itself is not exercised; sessions are created directly through
the service's own functions so the HTTP, RBAC and safety rules are tested.
"""
import http.client
import importlib.util
import json
import os
import socket
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

SOURCE = Path(__file__).resolve().parent.parent / "docker" / "bootstrap-api.py"


def load_service(data_dir):
    os.environ["KUBEMAN_DATA_DIR"] = data_dir
    os.environ["KUBEMAN_PUBLIC_URL"] = "https://kubeman.example.com"
    spec = importlib.util.spec_from_file_location("identity_service", SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class IdentityServiceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        cls.svc = load_service(cls.dir.name)
        cls.svc.init_db()
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            cls.port = probe.getsockname()[1]
        cls.server = ThreadingHTTPServer(("127.0.0.1", cls.port), cls.svc.Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.dir.cleanup()

    def request(self, method, path, body=None, token=None, csrf=True, origin=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Cookie"] = f"kubeman_session={token}"
        if csrf:
            headers["X-KubeMan-Request"] = "1"
        if origin:
            headers["Origin"] = origin
        connection = http.client.HTTPConnection("127.0.0.1", self.port)
        connection.request(method, path, json.dumps(body) if body is not None else None, headers)
        response = connection.getresponse()
        raw = response.read()
        connection.close()
        return response.status, (json.loads(raw) if raw else {})

    def login(self, email):
        with self.svc.tx() as conn:
            user = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
            conn.execute("UPDATE users SET status = 'active' WHERE id = ? AND status = 'invited'", (user["id"],))
            return self.svc.create_session(conn, user["id"])

    def initialize(self):
        status, _ = self.request("POST", "/initialize", {
            "startupCode": self.svc.startup_code(), "adminEmail": "Admin@Example.com", "googleMode": "custom",
            "googleClientId": "abc.apps.googleusercontent.com", "googleClientSecret": "x" * 20,
        }, csrf=False)
        self.assertEqual(status, 200)

    def test_full_flow(self):
        self.assertFalse(self.request("GET", "/status")[1]["initialized"])
        self.initialize()
        self.assertEqual(self.request("POST", "/initialize", {}, csrf=False)[0], 400)  # cannot re-initialize
        admin = self.login("admin@example.com")

        # Session and permissions
        status, session = self.request("GET", "/session", token=admin)
        self.assertTrue(session["authenticated"])
        self.assertIn("users:manage", session["user"]["permissions"])
        self.assertFalse(self.request("GET", "/session")[1]["authenticated"])

        # Gateway check
        self.assertEqual(self.request("GET", "/auth/check?permission=terminal:use", token=admin)[0], 200)
        self.assertEqual(self.request("GET", "/auth/check?permission=terminal:use")[0], 401)

        # Invite users with different roles
        status, data = self.request("POST", "/api/users", {"email": "op@example.com", "roleId": "operator"}, token=admin)
        self.assertEqual(status, 201)
        self.request("POST", "/api/users", {"email": "view@example.com", "roleId": "viewer"}, token=admin)
        self.assertEqual(self.request("POST", "/api/users", {"email": "op@example.com"}, token=admin)[0], 409)
        self.assertEqual(self.request("POST", "/api/users", {"email": "nope"}, token=admin)[0], 400)
        viewer = self.login("view@example.com")
        operator = self.login("op@example.com")

        # Permission enforcement
        self.assertEqual(self.request("GET", "/api/users", token=viewer)[0], 403)
        self.assertEqual(self.request("POST", "/api/users", {"email": "x@example.com"}, token=viewer)[0], 403)
        self.assertEqual(self.request("GET", "/auth/check?permission=terminal:use", token=viewer)[0], 403)
        self.assertEqual(self.request("GET", "/auth/check?permission=terminal:use", token=operator)[0], 200)
        self.assertEqual(self.request("GET", "/api/audit", token=operator)[0], 403)

        # CSRF protections
        self.assertEqual(self.request("POST", "/api/users", {"email": "y@example.com"}, token=admin, csrf=False)[0], 403)
        self.assertEqual(self.request("POST", "/api/users", {"email": "y@example.com"}, token=admin, origin="https://evil.example")[0], 403)
        self.assertEqual(self.request("POST", "/api/users", {"email": "y@example.com"}, token=admin, origin="https://kubeman.example.com")[0], 201)

        # Custom role: create, assign, edit is live, cannot delete while assigned
        status, data = self.request("POST", "/api/roles", {"name": "Terminal only", "permissions": ["terminal:use"]}, token=admin)
        self.assertEqual(status, 201)
        role_id = next(role["id"] for role in data["roles"] if role["name"] == "Terminal only")
        self.assertEqual(self.request("POST", "/api/roles", {"name": "Bad", "permissions": ["nope:nope"]}, token=admin)[0], 400)
        users = self.request("GET", "/api/users", token=admin)[1]["users"]
        viewer_id = next(user["id"] for user in users if user["email"] == "view@example.com")
        self.assertEqual(self.request("PATCH", f"/api/users/{viewer_id}", {"roleId": role_id}, token=admin)[0], 200)
        self.assertEqual(self.request("GET", "/auth/check?permission=terminal:use", token=viewer)[0], 200)
        self.assertEqual(self.request("DELETE", f"/api/roles/{role_id}", token=admin)[0], 409)
        self.assertEqual(self.request("PATCH", "/api/roles/admin", {"permissions": []}, token=admin)[0], 400)
        self.assertEqual(self.request("PATCH", f"/api/roles/{role_id}", {"permissions": ["events:view"]}, token=admin)[0], 200)
        self.assertEqual(self.request("GET", "/auth/check?permission=terminal:use", token=viewer)[0], 403)

        # Disabling revokes sessions immediately
        self.assertEqual(self.request("PATCH", f"/api/users/{viewer_id}", {"status": "disabled"}, token=admin)[0], 200)
        self.assertEqual(self.request("GET", "/session", token=viewer)[1]["authenticated"], False)

        # Last-admin and owner safety rules
        admin_id = next(user["id"] for user in users if user["email"] == "admin@example.com")
        self.assertEqual(self.request("PATCH", f"/api/users/{admin_id}", {"status": "disabled"}, token=admin)[0], 400)
        self.assertEqual(self.request("PATCH", f"/api/users/{admin_id}", {"roleId": "viewer"}, token=admin)[0], 400)
        self.assertEqual(self.request("DELETE", f"/api/users/{admin_id}", token=admin)[0], 400)

        # A second admin can exist, but the last manager cannot be demoted
        self.request("POST", "/api/users", {"email": "two@example.com", "roleId": "admin"}, token=admin)
        two = self.login("two@example.com")
        users = self.request("GET", "/api/users", token=admin)[1]["users"]
        two_id = next(user["id"] for user in users if user["email"] == "two@example.com")
        self.assertEqual(self.request("PATCH", f"/api/users/{two_id}", {"roleId": "viewer"}, token=admin)[0], 200)
        self.assertEqual(self.request("GET", "/api/users", token=two)[0], 403)

        # Audit trail records the changes
        events = self.request("GET", "/api/audit", token=admin)[1]["events"]
        actions = {event["action"] for event in events}
        self.assertTrue({"system.initialized", "user.invited", "user.role_changed", "role.created"} <= actions)

        # Removing a user works and unknown ids 404
        self.assertEqual(self.request("DELETE", f"/api/users/{viewer_id}", token=admin)[0], 200)
        self.assertEqual(self.request("DELETE", f"/api/users/{viewer_id}", token=admin)[0], 404)

    def test_public_origin_uses_forwarded_headers_when_unset(self):
        saved = os.environ.pop("KUBEMAN_PUBLIC_URL")
        try:
            headers = {"X-Forwarded-Proto": "https", "X-Forwarded-Host": "km.example.org", "Host": "internal:7683"}
            self.assertEqual(self.svc.public_origin(headers), "https://km.example.org")
            self.assertEqual(self.svc.google_redirect_uri(headers), "https://km.example.org/auth/google/callback")
        finally:
            os.environ["KUBEMAN_PUBLIC_URL"] = saved


if __name__ == "__main__":
    unittest.main()
