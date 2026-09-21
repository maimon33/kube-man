#!/usr/bin/env bash
# Runs on the server (started over SSH by .github/workflows/deploy.yml).
# Reads an ECR login password from stdin, pulls the images for IMAGE_TAG,
# restarts the stack, waits until it is healthy and rolls back if it is not.
set -euo pipefail
cd "$(dirname "$0")"

: "${ECR_REGISTRY:?ECR_REGISTRY is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"

compose() { docker compose -f compose.yaml -f compose.prod.yml "$@"; }
export ECR_REGISTRY

PORT="$(grep -E '^KUBEMAN_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 || true)"
PORT="${PORT:-3080}"
PREVIOUS_TAG="$(cat .deployed-tag 2>/dev/null || true)"

echo "→ Authenticating with ECR..."
docker login --username AWS --password-stdin "$ECR_REGISTRY" >/dev/null

start() {
  export IMAGE_TAG="$1"
  echo "→ Pulling images for $IMAGE_TAG..."
  compose pull
  echo "→ Starting stack..."
  compose up -d --no-build --remove-orphans
}

healthy() {
  for name in kubeman kubeman-bootstrap kubeman-shell kubeman-aws; do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null)" = "healthy" ] || return 1
  done
  # Gateway answers (a redirect is fine when it terminates HTTPS itself).
  curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/status" | grep -qE '^[23]'
}

wait_healthy() {
  for i in $(seq 1 60); do
    if healthy; then echo "✓ KubeMan healthy"; return 0; fi
    printf '[%2d/60]\r' "$i"
    sleep 2
  done
  return 1
}

start "$IMAGE_TAG"
if wait_healthy; then
  echo "$IMAGE_TAG" > .deployed-tag
  docker image prune -f >/dev/null || true
  exit 0
fi

echo "✗ Health check failed" >&2
compose ps >&2 || true
compose logs --tail 20 >&2 || true
if [ -n "$PREVIOUS_TAG" ] && [ "$PREVIOUS_TAG" != "$IMAGE_TAG" ]; then
  echo "→ Rolling back to $PREVIOUS_TAG..." >&2
  start "$PREVIOUS_TAG" && wait_healthy || echo "✗ Rollback also failed; manual intervention required" >&2
fi
exit 1
