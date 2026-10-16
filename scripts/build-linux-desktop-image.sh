#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "Usage: scripts/build-linux-desktop-image.sh <k3d-cluster-name>" >&2
  exit 2
fi

repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$repo_root"
cluster_name=$1
context="k3d-${cluster_name}"
node_arches=$(kubectl --context "$context" get nodes \
  -o jsonpath='{range .items[*]}{.status.nodeInfo.architecture}{"\n"}{end}' | sort -u)
if [[ -z "$node_arches" || "$node_arches" == *$'\n'* ]]; then
  echo "Expected one architecture for Kubernetes context $context, found: ${node_arches:-none}" >&2
  exit 1
fi
case "$node_arches" in
  amd64|arm64) ;;
  *) echo "Unsupported Kubernetes node architecture: $node_arches" >&2; exit 1 ;;
esac
platform="linux/${node_arches}"
revision=$(git rev-parse HEAD)
image="coke-dots-linux-desktop:sha-${revision}"
image_inputs=(
  deploy/linux-desktop
  package.json
  package-lock.json
  scripts/build-linux-desktop-image.sh
)

dirty_inputs=$(git status --porcelain --untracked-files=all -- "${image_inputs[@]}")
if [[ -n "$dirty_inputs" ]]; then
  echo "Commit all cloud desktop image inputs before building its release tag:" >&2
  echo "$dirty_inputs" >&2
  exit 1
fi

if docker image inspect "$image" >/dev/null 2>&1; then
  existing_revision=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")
  if [[ "$existing_revision" != "$revision" ]]; then
    echo "Refusing to overwrite $image: its recorded source revision is $existing_revision" >&2
    exit 1
  fi
  existing_platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")
  if [[ "$existing_platform" != "$platform" ]]; then
    echo "Refusing to import $image: it is $existing_platform but cluster $context requires $platform" >&2
    exit 1
  fi
else
  if [[ -n "${COKE_DOTS_DOCKER_BUILD_PROXY:-}" ]]; then
    docker build \
      --platform "$platform" \
      --pull \
      --build-arg "http_proxy=${COKE_DOTS_DOCKER_BUILD_PROXY}" \
      --build-arg "https_proxy=${COKE_DOTS_DOCKER_BUILD_PROXY}" \
      --build-arg "COKE_DOTS_GIT_REVISION=$revision" \
      --file deploy/linux-desktop/Dockerfile --tag "$image" .
  else
    docker build \
      --platform "$platform" \
      --pull \
      --build-arg "COKE_DOTS_GIT_REVISION=$revision" \
      --file deploy/linux-desktop/Dockerfile --tag "$image" .
  fi
  built_platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")
  if [[ "$built_platform" != "$platform" ]]; then
    echo "Refusing to import $image: build produced $built_platform but cluster $context requires $platform" >&2
    exit 1
  fi
fi

k3d image import "$image" --cluster "$cluster_name"
printf 'DOTS_LINUX_DESKTOP_IMAGE=%s\n' "$image"
