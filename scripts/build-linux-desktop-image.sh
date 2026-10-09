#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "Usage: scripts/build-linux-desktop-image.sh <k3d-cluster-name>" >&2
  exit 2
fi

repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$repo_root"
cluster_name=$1
revision=$(git rev-parse HEAD)
image="coke-dots-linux-desktop:sha-${revision}"
image_inputs=(
  deploy/linux-desktop
  package.json
  package-lock.json
  src/server/computer-home.mjs
  src/shared/public-web-policy.mjs
  src/web/assets/dots-files.png
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
else
  docker build \
    --build-arg "COKE_DOTS_GIT_REVISION=$revision" \
    --file deploy/linux-desktop/Dockerfile \
    --tag "$image" \
    .
fi

k3d image import "$image" --cluster "$cluster_name"
printf 'DOTS_LINUX_DESKTOP_IMAGE=%s\n' "$image"
