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
administrator email. Use this authorized redirect URI in Google Cloud:

```text
http://localhost:7683/auth/google/callback
```

To offer the public Google application created for the KubeMan open-source
project during setup, copy `.env.example` to `.env` and provide its two Google
OAuth values before starting Docker. The app is used only to pass a verified
email identity to KubeMan for user matching and authentication. The
startup code is deleted after initialization. Google secrets and system state
remain in the dedicated `kubeman-bootstrap-data` volume and are not written to source files.

The container restarts automatically after Docker Desktop restarts. The named
`kubeman-data` volume is retained when the container is replaced.

The terminal pane is a real non-root Bash shell in the companion
`kubeman-shell` container. Its home directory and command history persist in the
`kubeman-shell-home` volume. `kubectl`, Helm, AWS CLI, Git, curl, jq/yq, Vim,
Nano, networking tools, and standard Linux utilities are installed. Your Mac's
`~/.kube` and `~/.aws` directories are mounted read-only. The Docker socket and
Mac filesystem are not exposed.

To use a different port, run `KUBEMAN_PORT=8080 docker compose up --build -d`.

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
docker compose logs -f kubeman
```

## Local development without Docker

Requires Node.js 22.13 or newer.

```bash
npm ci
npm run dev
```

The current build is the web-console and control-plane foundation. Connecting real
clusters, executing shell commands, and storing credentials requires the isolated
cluster-agent and secret-broker services.

See [Future features](docs/FUTURE_FEATURES.md) for the monitoring, alerting, and
Slack integration roadmap.
