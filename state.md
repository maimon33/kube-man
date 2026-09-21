# KubeMan — project state

Working log for process and progress. Update it at the end of each work session.
Last updated: 2026-09-22.

## What exists today

| Area | State | Notes |
|---|---|---|
| Console UI (tiles: resources, terminal, flow, events) | Prototype | Resources, flow and events tiles show **mock data**. Only the terminal is live. |
| Live terminal | Working | ttyd in `kubeman-shell`, non-root, mounted `~/.kube` and `~/.aws` read-only. Now behind the gateway and gated by `terminal:use`. |
| AWS EKS discovery | Working | `kubeman-aws`; results persisted per install (not per user). Gated by `clusters:view` / `credentials:manage`. |
| First-run bootstrap | Fixed for remote use | See "Bootstrap fix" below. |
| Google sign-in | Working | Redirect URI derived from public URL. Needs HTTPS off localhost. |
| Users, roles, permissions | **New base** | SQLite in the identity service. See below. |
| Audit log | Basic | Identity events only (sign-in, user/role changes). No cluster actions yet. |
| Tenant separation | Not started (by request) | See "Extension points". |
| Bastion / SSM tunnels | UI mock | Modal saves nothing. |
| Storage & persistence panel, stat cards | UI mock | "2.4 GB", "90 days", "1,284 events" are placeholders. |

## Deployment

`.github/workflows/deploy.yml` (push to `main` or manual): runs the identity tests, builds
both images, pushes them to ECR repository `kubeman` (tags `web-<sha>` and `shell-<sha>`),
then deploys over SSH. The workflow copies `compose.yaml`, `compose.prod.yml`, `deploy.sh`
and `docker/Caddyfile` to the server, pipes an ECR login token over SSH stdin, and runs
`deploy.sh`, which pulls, restarts, health-checks all services and rolls back to the
previous tag on failure. Server-side settings live in `<DEPLOY_PATH>/.env` (see `.env.example`).

Prerequisites, none yet done (this workflow will fail until they are):
- ECR repository `kubeman` in account 236565801201 (eu-central-1). In `maimons-infra`
  repositories come from the `services` map, so this needs a change there.
- The OIDC role `maimons-infra-github-ssm` must trust `repo:maimon33/kube-man:*`
  and be allowed to push to that repository.
- GitHub secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`
  (output of `ssh-keyscan host`). Optional variables: `DEPLOY_PATH` (default `/opt/kubeman`),
  `DEPLOY_PORT` (default 22).
- Server: Docker with the compose plugin, `DEPLOY_USER` able to run docker and write
  `DEPLOY_PATH`, an amd64 CPU (CI builds amd64 only), and `~/.kube` / `~/.aws` present
  for the shell containers.

## Architecture

```
browser ──► kubeman-gateway (Caddy, the only published port)
              /                → kubeman          (Next/vinext web app)
              /status /session /initialize /logout /auth/* /api/*
                               → kubeman-bootstrap (identity service, Python + SQLite)
              /_km/shell/*     → kubeman-shell     (ttyd)       ┐ forward_auth to identity:
              /_km/aws/*       → kubeman-aws       (discovery)  ┘ /auth/check?permission=…
```

- The identity service is still named `kubeman-bootstrap` (container, volume, file
  `docker/bootstrap-api.py`) to avoid breaking existing installs. It now owns
  identity: init, Google OAuth, sessions, users, roles, audit.
- State lives in the `kubeman-bootstrap-data` volume: `system.json` (init config),
  `google-client-secret`, `identity.db` (users, roles, sessions, audit).
- `db/schema.ts` + `drizzle/` (Cloudflare D1) are template leftovers and **not used**
  by the Docker deployment. Decide whether to delete them or migrate identity there.
- `app/chatgpt-auth.ts` is unused template residue (no longer imported).

## Bootstrap fix (remote server)

Root causes found by reading the code (not by reproducing on your server, so if
the failure you saw differs, send me the browser console error and
`docker compose logs`):

1. The browser called `:7681`, `:7682`, `:7683` directly, and compose bound all of
   them to `127.0.0.1`. From a remote browser every call failed, so setup showed
   "Bootstrap service is unavailable".
2. CORS origins were hardcoded to `http://localhost:3080`.
3. OAuth redirect URI and post-login redirects were hardcoded to `localhost`/`:7683`.
4. The terminal and AWS ports had **no authentication**. Anyone who could reach
   them got a shell with the mounted kubeconfig.

Fix: a single-origin gateway; identity derives its public URL from
`KUBEMAN_PUBLIC_URL` or forwarded headers; CORS removed; shell and AWS routes
require a valid session and permission; CSRF header + Origin check on mutations;
`Secure` cookies when served over HTTPS; sign-in failures now show a message.

Verified locally (Docker Desktop): all services healthy; unauthenticated
shell/AWS requests return 401; viewer gets 403 on shell and discovery; ttyd
websocket upgrades through the gateway with a session; identity issues https
redirect URIs behind a TLS proxy; UI (console, admin, invite) exercised in Chrome.
**Not verified:** a real Google sign-in round trip, Caddy's automatic HTTPS
(`KUBEMAN_SITE_ADDRESS`), and a real remote host.

**Breaking change:** the Google redirect URI is now
`<public url>/auth/google/callback` (was `http://localhost:7683/…`). Add the new
URI to the Google OAuth client. The shared "public KubeMan Google app" only
works if `http://localhost:3080/auth/google/callback` is registered on it. Existing
sessions are dropped once on upgrade.

## Users and permissions (base)

- Permission catalog: `PERMISSIONS` in `docker/bootstrap-api.py` (12 permissions
  across clusters, Kubernetes, terminal, administration).
- Built-in roles (re-seeded each start, read-only): `admin`, `operator`, `viewer`.
  Custom roles: create/edit/delete in Admin → Roles & permissions.
- One role per user. The initial administrator is the protected owner. The last
  user able to manage users cannot be disabled, demoted or removed.
- Invite = pre-register an email; the person signs in with Google. No email is sent.
  Allowed domain (set at init) auto-creates unknown users as Viewers.
- Enforcement points today: gateway (shell, AWS), identity API, UI tile visibility.
  `resources:view/manage` and `events:view` only gate UI tiles because those tiles
  are still mock. When real Kubernetes APIs are added they must check these server-side.
- Tests: `python3 -m unittest discover -s tests -p "test_*.py"` (RBAC, last-admin
  safety, CSRF, disabled-user revocation, audit).

### Known gaps / caution

- `terminal:use` is effectively "whatever the mounted kubeconfig and AWS profile can
  do". Permissions such as `resources:manage` do **not** constrain the shell. Treat
  it as an admin-grade permission until per-user kube credentials exist.
- The AWS cluster list is shared by all users (no per-user or per-tenant scoping).
- No login rate limiting beyond the setup code; no session list / "sign out everywhere".
- Admin UI has no editing of the allowed domain or Google settings after init
  (`settings:manage` exists but nothing uses it yet).
- `npm test` is broken: `tests/rendered-html.test.mjs` is the old starter-template test.
- Pre-existing lint errors (`react-hooks/set-state-in-effect`) in `ConsoleApp.tsx` and
  `BootstrapGate.tsx`; `tsc` errors only in `db/` and `worker/` (Cloudflare types).

## Extension points for tenant separation (not started)

- Add a `tenants` table and a `tenant_id` on users, roles (or a role-binding table
  `user_id, role_id, scope_type, scope_id` replacing `users.role_id`).
- `/auth/check` already receives the user; extend it with scope (cluster/namespace)
  and have the gateway pass the target.
- AWS discovery store and audit events need a tenant column.
- Terminal needs per-user/tenant kubeconfig homes (currently one shared `operator` home).

## Next steps (proposed order)

1. Confirm the remote deployment works on your server (HTTPS choice, redirect URI).
2. Real Kubernetes API layer (server-side, uses per-request identity + permission
   checks) to replace mock resource/event data.
3. Per-user impersonation or scoped kubeconfigs, so `resources:*` really constrains actions.
4. Audit every cluster action (exec, delete, scale, edit) through the same audit log.
5. Tenant separation (design above).
6. Feature backlog below; monitoring/alerting/Slack detail in `docs/FUTURE_FEATURES.md`.

## Feature ideas from other Kubernetes UIs

Compared from knowledge of Kubernetes Dashboard, Headlamp, Lens/OpenLens, Rancher,
Portainer, Aptakube, k9s and Argo CD (not re-checked against their current releases).
KubeMan's differentiators already: multi-pane tiles, AWS/EKS infrastructure view,
real shell, Google-identity RBAC.

**Baseline every k8s GUI has (KubeMan lacks these; highest value):**
- Real resource browser for all kinds, incl. CRDs: list, filter, sort, namespace picker, labels/annotations.
- Resource detail with YAML view/edit + diff before apply, and related objects (owner refs, pods of a Deployment).
- Pod logs: live stream, multi-container, previous instance, search, download, multi-pod tail by selector.
- Exec into a container and port-forward from the browser.
- Events per resource and cluster-wide, with warning filtering.
- Actions: scale, restart rollout, rollback, delete, cordon/drain nodes, edit resources.
- Global search / command palette across clusters and resources (the ⌘K button is a stub).
- Metrics: CPU/memory per pod/node (metrics-server), with charts.

**Where Headlamp / Lens / Rancher go further:**
- Headlamp: plugin system, map/graph view of resources, OIDC login with RBAC-aware UI
  (hides what the user's own Kubernetes RBAC forbids), per-cluster settings. Worth copying: **use the user's own
  identity against the API server via impersonation** so Kubernetes RBAC and KubeMan RBAC agree.
- Lens: multi-cluster catalog with grouping, built-in terminal per cluster, Helm chart
  browser/install, node shell, extensions.
- Rancher: teams/projects with tenant-scoped RBAC (matches your upcoming tenant work),
  cluster provisioning, app catalog, fleet-wide policy.
- Portainer: deployment from Git/manifests/templates, registry credentials, per-environment access.
- Aptakube: fast multi-cluster view, side-by-side cluster comparison, offline-friendly.
- k9s: keyboard-driven navigation, pulse dashboard, "xray" dependency view, saved aliases.
- Argo CD: application-centric health/sync status, drift detection, rollback history.

**Suggested additions specific to KubeMan (grouped):**

*Operations*
- Helm releases: list, values, history, diff, rollback, install from repo.
- Workload health inbox: crash loops, pending pods, failed probes, image-pull errors, with one-click "explain".
- Node view: capacity, pressure conditions, taints, pods per node, drain with confirmation.
- Cost/right-sizing hints from requests vs usage.
- Manifest apply from Git URL or paste, with server-side dry-run and diff.
- Secrets handling: masked by default, reveal requires a dedicated permission and is audited.

*Platform / admin*
- Approval workflow for risky actions (delete, scale to zero, prod exec) with two-person rule.
- Time-boxed access (temporary elevation) and break-glass roles.
- Session management: active sessions, sign out everywhere, idle timeout.
- Audit export (CSV/JSON, webhook/SIEM), retention setting, tamper-evident chain.
- Additional identity providers (Microsoft Entra, Okta/generic OIDC), SSO group → role mapping, optional SCIM.
- Email invitation delivery, and API tokens for automation.
- Cluster onboarding beyond EKS: GKE, AKS, kubeconfig upload, in-cluster agent for private clusters (removes the bastion problem).

*Experience*
- Saved views and shareable deep links to a resource/log/namespace (the schema already has `saved_views`).
- Compare two clusters/namespaces (config drift).
- Dark mode and keyboard shortcuts; per-user default cluster/namespace.
- Notifications center tied to the alert/Slack plan in `docs/FUTURE_FEATURES.md`.

## Decisions to make

- Where should durable app data live long term: keep SQLite in the identity service,
  or move to a shared database (Postgres) before adding tenants and cluster inventory?
- Impersonation (Kubernetes RBAC as source of truth) vs KubeMan-only RBAC vs both.
- Is the shell a normal feature or an admin/break-glass feature?
- Rename `kubeman-bootstrap` to `kubeman-identity` (needs a volume migration).

## Session log

- 2026-09-22 — Added deploy workflow (ECR build + SSH deploy), modeled on mosar's
  build-and-push; SSH replaces its SSM step. Not yet run.
- 2026-09-22 — Diagnosed and fixed remote bootstrap (gateway, public URL, auth on shell/AWS);
  added users/roles/permissions base, audit log, admin UI, tests, README, this file.
