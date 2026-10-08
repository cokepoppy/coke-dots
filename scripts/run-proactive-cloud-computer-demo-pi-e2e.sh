#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cluster=${DOTS_K3D_CLUSTER:-tp1121-sandbox-dev}
image=coke-dots-linux-desktop:pi-proactive-demo
context=$(kubectl config current-context)
if [ "$context" != "k3d-$cluster" ]; then
  printf 'Refusing to run against Kubernetes context %s (expected k3d-%s)\n' "$context" "$cluster" >&2
  exit 1
fi

docker build -t "$image" -f "$repo_root/deploy/linux-desktop/Dockerfile" "$repo_root"
docker run --rm --entrypoint sh "$image" -lc 'grep -q "function computerUiTool" /opt/coke-dots/cloud-kernel-adapter.mjs && grep -q "toPublicComputerActionRecord" /opt/coke-dots/computer-action-log.mjs && node --check /opt/coke-dots/agent-runtime.mjs'
k3d image import "$image" --cluster "$cluster"

cd "$repo_root"
DOTS_PROACTIVE_DEMO_LIVE_KERNELS=1 \
DOTS_PROACTIVE_DEMO_ENGINE=pi \
DOTS_LINUX_DESKTOP_IMAGE="$image" \
node --import tsx tests/e2e/proactive-research-demo.e2e.ts
