#!/usr/bin/env sh
set -euo pipefail

IMAGE_NAME=${IMAGE_NAME:-mail-api-proxy}
CONTAINER_NAME=${CONTAINER_NAME:-mail-api-proxy}
PORT=${PORT:-8080}

echo "Building image $IMAGE_NAME..."
docker build -t "$IMAGE_NAME" .

echo "Stopping and removing existing container (if any)..."
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

echo "Starting container $CONTAINER_NAME on port $PORT..."
if [ -f .env ]; then
  docker run -d --name "$CONTAINER_NAME" --restart unless-stopped --env-file .env -p "$PORT:$PORT" "$IMAGE_NAME"
else
  docker run -d --name "$CONTAINER_NAME" --restart unless-stopped -e PORT="$PORT" -p "$PORT:$PORT" "$IMAGE_NAME"
fi

echo "Container started. Logs: docker logs -f $CONTAINER_NAME"

