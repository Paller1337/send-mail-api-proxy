#!/usr/bin/env sh
set -euo pipefail

export DOCKER_BUILDKIT=1

echo "Bringing up mail-api-proxy via docker compose..."
docker compose pull || true
docker compose up -d --build
docker compose ps

