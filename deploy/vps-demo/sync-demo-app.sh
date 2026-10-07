#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
demo_root="$HOME/Library/Application Support/Coke Dots Demo"
app_root="$demo_root/app"
mkdir -p "$app_root"
for directory in src dist node_modules; do
  mkdir -p "$app_root/$directory"
  rsync -a --delete "$repo_root/$directory/" "$app_root/$directory/"
done
cp "$repo_root/package.json" "$app_root/package.json"
cat > "$app_root/run-demo-server.sh" <<'EOF'
#!/bin/sh
set -eu
cd "/Users/shangguan/Library/Application Support/Coke Dots Demo/app"
export PATH=/Users/shangguan/.local/bin:/opt/homebrew/bin:/usr/bin:/bin
export NODE_ENV=production
export DOTS_ENV_FILE="/Users/shangguan/Library/Application Support/Coke Dots Demo/demo.env"
exec /Users/shangguan/.local/bin/node --import tsx src/server/index.ts
EOF
chmod 755 "$app_root/run-demo-server.sh"
chmod 700 "$demo_root" "$app_root"
