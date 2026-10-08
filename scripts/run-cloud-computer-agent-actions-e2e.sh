#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cluster=${DOTS_K3D_CLUSTER:-tp1121-sandbox-dev}
image=coke-dots-linux-desktop:pi-cloud-computer-actions
context=$(kubectl config current-context)
if [ "$context" != "k3d-$cluster" ]; then
  printf 'Refusing to run against Kubernetes context %s (expected k3d-%s)\n' "$context" "$cluster" >&2
  exit 1
fi

docker build -t "$image" -f "$repo_root/deploy/linux-desktop/Dockerfile" "$repo_root"
k3d image import "$image" --cluster "$cluster"
cd "$repo_root"
DOTS_K3D_LIVE_AGENT_KERNELS=1 \
DOTS_K3D_DEMO_SCENARIO=cloud-computer-agent-actions \
DOTS_LINUX_DESKTOP_IMAGE="$image" \
node --import tsx tests/e2e/k3d-cloud-computer.e2e.ts
