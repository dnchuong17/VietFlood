#!/bin/bash

set -e

DOCKERHUB_USER="nguyenchuong1712"
TAG="${1:-latest}"
SERVICES=("api-gateway" "auth-service" "reports-service")

echo "Building application images..."
docker compose build "${SERVICES[@]}"

for service in "${SERVICES[@]}"; do
  local_image="vietflood-${service}:latest"
  remote_image="${DOCKERHUB_USER}/vietflood-${service}:${TAG}"
  remote_latest="${DOCKERHUB_USER}/vietflood-${service}:latest"

  echo "Tagging ${local_image} as ${remote_image} ..."
  docker tag "${local_image}" "${remote_image}"

  if [ "$TAG" != "latest" ]; then
    echo "Tagging ${local_image} as ${remote_latest} ..."
    docker tag "${local_image}" "${remote_latest}"
  fi

  echo "Pushing ${remote_image} ..."
  docker push "${remote_image}"

  if [ "$TAG" != "latest" ]; then
    echo "Pushing ${remote_latest} ..."
    docker push "${remote_latest}"
  fi
done

echo ""
echo "Done."
for service in "${SERVICES[@]}"; do
  echo "Pull with: docker pull ${DOCKERHUB_USER}/vietflood-${service}:${TAG}"
done
