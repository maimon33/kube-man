# KubeMan Console

KubeMan is a multi-pane Kubernetes operations console for resources, shell commands,
traffic flow, events, saved views, and workspace administration.

## Run on macOS with Docker Desktop

1. Open Docker Desktop and wait until it reports that the engine is running.
2. Open Terminal in this project folder.
3. Start KubeMan:

   ```bash
   docker compose up --build -d
   ```

4. Open [http://localhost:3080](http://localhost:3080).

On the first launch, KubeMan opens the secure initialization page. Retrieve the
one-time startup code with:

```bash
docker compose logs kubeman-bootstrap
```

Enter the code, configure a Google OAuth web application, and set the first
administrator email. The setup page shows the exact **authorized redirect URI**
to register in Google Cloud. It is the address you open KubeMan with plus
`/auth/google/callback`, for example:

```text
http://localhost:3080/auth/google/callback
```

To offer the public Google application created for the KubeMan open-source
project during setup, copy `.env.example` to `.env` and provide its two Google
OAuth values before starting Docker. That application only works where its
redirect URI is registered with Google. The app is used only to pass a verified
email identity to KubeMan for user matching and authentication. The
startup code is deleted after initialization. Google secrets and system state
remain in the dedicated `kubeman-bootstrap-data` volume and are not written to source files.

### Running on a remote server

KubeMan is served through one gateway container (`kubeman-gateway`); the web app,
identity service, terminal and AWS discovery stay on a private Docker network.
The gateway is the only published port and it also enforces sign-in and
permissions for the terminal and AWS routes.

1. Copy `.env.example` to `.env` and set `KUBEMAN_BIND=0.0.0.0`.
2. Serve KubeMan over **HTTPS**. Google only accepts `https` redirect URIs
   (except for localhost). Either put your own TLS proxy/load balancer in front
   of `KUBEMAN_PORT` and set `KUBEMAN_PUBLIC_URL=https://your.domain`, or let the
   gateway obtain a certificate: set `KUBEMAN_SITE_ADDRESS=your.domain`,
   `KUBEMAN_PORT=80`, `KUBEMAN_HTTPS_PORT=443` and open both ports.
3. `docker compose up --build -d`, read the startup code from the bootstrap
   logs, open your URL and complete setup. Register the redirect URI shown on
   the setup page in Google Cloud.

The default deployment does not expose any port beyond loopback, so an SSH tunnel
(`ssh -L 3080:localhost:3080 server`) also works without HTTPS.

### Users, roles and permissions

The initial administrator is the system owner. From **Admin → Users & access**
they can invite people by Google email, assign a role, disable or remove them.
Built-in roles are Administrator, Operator and Viewer; custom roles pick exactly
which permissions apply (see `PERMISSIONS` in `docker/bootstrap-api.py`).
Permissions are checked on every request, so changes take effect immediately.
Setting an allowed email domain during setup auto-creates unknown users from
that domain as Viewers. Sign-ins and membership changes are recorded in the audit log.

The container restarts automatically after Docker Desktop restarts. The named
`kubeman-data` volume is retained when the container is replaced.

The terminal pane is a real non-root Bash shell in the companion
`kubeman-shell` container. Its home directory and command history persist in the
`kubeman-shell-home` volume. `kubectl`, Helm, AWS CLI, Git, curl, jq/yq, Vim,
Nano, networking tools, and standard Linux utilities are installed. Your Mac's
`~/.kube` and `~/.aws` directories are mounted read-only. The Docker socket and
Mac filesystem are not exposed.

To use a different port, run `KUBEMAN_PORT=8080 docker compose up --build -d`
(the redirect URI changes with it).

### Stop or restart

```bash
docker compose stop
docker compose start
```

### Remove the container

```bash
docker compose down
```

The data volume remains after `docker compose down`. To deliberately remove it too,
run `docker compose down --volumes`.

### View logs

```bash
docker compose logs -f kubeman kubeman-gateway kubeman-bootstrap
```

## Local development without Docker

Requires Node.js 22.13 or newer. The app expects the gateway and services from
`compose.yaml` on the same origin, so for a working sign-in run the compose stack;
`npm run dev` alone only serves the UI shell.

```bash
npm ci
npm run dev
```

The current build is the web-console and control-plane foundation. Connecting real
clusters, executing shell commands, and storing credentials requires the isolated
cluster-agent and secret-broker services.

See [Future features](docs/FUTURE_FEATURES.md) for the monitoring, alerting, and
Slack integration roadmap.

## Tests

```bash
python3 -m unittest discover -s tests -p "test_*.py"   # identity service and RBAC
```

Project status and roadmap: [state.md](state.md).
