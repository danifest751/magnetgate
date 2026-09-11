#!/usr/bin/env bash
# magnetgate pull-based autodeploy:
# fetch origin/main -> reset -> deps (only if lock changed) -> units -> restart services
set -euo pipefail
cd /opt/magnetgate
export GIT_TERMINAL_PROMPT=0

git fetch origin main --quiet
remote_rev=$(git rev-parse origin/main)
local_rev=$(git rev-parse HEAD 2>/dev/null || echo none)

if [ "$local_rev" = "$remote_rev" ]; then
  exit 0
fi

git reset --hard origin/main --quiet

# install/update dependencies only when they actually changed
deps_changed=1
if [ "$local_rev" != "none" ] && git diff --quiet "$local_rev" "$remote_rev" -- package.json package-lock.json 2>/dev/null; then
  deps_changed=0
fi
if [ "$deps_changed" -eq 1 ]; then
  npm install --omit=dev --loglevel=error
fi

# copy systemd units when they changed
for unit in systemd/*.service systemd/*.timer; do
  [ -e "$unit" ] || continue
  name=$(basename "$unit")
  if ! cmp -s "$unit" "/etc/systemd/system/$name"; then
    cp "$unit" "/etc/systemd/system/$name"
    systemctl daemon-reload
  fi
done

systemctl restart magnetgate-exit.service magnetgate-dht.service
echo "$(date -Is) deployed ${remote_rev:0:12}" >> /var/log/magnetgate-deploy.log
