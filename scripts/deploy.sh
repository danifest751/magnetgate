#!/usr/bin/env bash
# magnetgate pull-based autodeploy (runs as root):
# fetch origin/main -> [verify signature] -> reset -> deps (npm ci, only if lock changed)
# -> units -> restart services.
set -euo pipefail
cd /opt/magnetgate
export GIT_TERMINAL_PROMPT=0

git fetch origin main --quiet
remote_rev=$(git rev-parse origin/main)
local_rev=$(git rev-parse HEAD 2>/dev/null || echo none)

if [ "$local_rev" = "$remote_rev" ]; then
  exit 0
fi

# Optional supply-chain guard: if /opt/magnetgate/.deploy-verify exists, the incoming commit
# MUST carry a good signature (git must be configured with the trusted key / allowedSignersFile),
# otherwise the deploy aborts instead of running unverified code as root.
if [ -f /opt/magnetgate/.deploy-verify ]; then
  if ! git verify-commit "$remote_rev" 2>/dev/null; then
    echo "$(date -Is) deploy aborted: unverified commit ${remote_rev:0:12}" >> /var/log/magnetgate-deploy.log
    exit 1
  fi
fi

git reset --hard origin/main --quiet

# install/update dependencies only when they actually changed (reproducible: npm ci)
deps_changed=1
if [ "$local_rev" != "none" ] && git diff --quiet "$local_rev" "$remote_rev" -- package.json package-lock.json 2>/dev/null; then
  deps_changed=0
fi
if [ "$deps_changed" -eq 1 ]; then
  npm ci --omit=dev --loglevel=error
fi

# make sure the seq/state dir is owned by the service user (non-root exit)
if id -u magnetgate >/dev/null 2>&1; then
  install -d -o magnetgate -g magnetgate -m 750 /var/lib/magnetgate
fi

# copy systemd units when they changed
units_changed=0
for unit in systemd/*.service systemd/*.timer; do
  [ -e "$unit" ] || continue
  name=$(basename "$unit")
  if ! cmp -s "$unit" "/etc/systemd/system/$name"; then
    cp "$unit" "/etc/systemd/system/$name"
    units_changed=1
  fi
done
[ "$units_changed" -eq 1 ] && systemctl daemon-reload

systemctl restart magnetgate-exit.service magnetgate-dht.service
echo "$(date -Is) deployed ${remote_rev:0:12}" >> /var/log/magnetgate-deploy.log
