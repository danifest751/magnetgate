#!/usr/bin/env bash
# Validate a complete candidate before changing the live checkout; rollback on activation failure.
set -euo pipefail
root=/opt/magnetgate
state=/var/lib/magnetgate-deploy
mkdir -p "$state"
exec 9>"$state/lock"
flock -n 9 || exit 0
cd "$root"
export GIT_TERMINAL_PROMPT=0
# Local working changes are never overwritten by the unattended updater.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo 'deploy refused: checkout has local changes' >&2
  exit 1
fi
git fetch origin main --quiet
remote_rev=$(git rev-parse origin/main)
local_rev=$(git rev-parse HEAD)
applied=$(cat "$state/revision" 2>/dev/null || true)
healthy() { systemctl is-active --quiet magnetgate-exit && systemctl is-active --quiet magnetgate-dht; }
if [ "$applied" = "$remote_rev" ] && healthy; then exit 0; fi
if [ -f "$root/.deploy-verify" ]; then git verify-commit "$remote_rev"; fi
stage=$(mktemp -d /opt/magnetgate-candidate.XXXXXX)
activated=0
rollback() {
  rc=$?
  trap - EXIT
  rollback_ok=1
  if [ "$activated" = 1 ] && [ "$rc" != 0 ]; then
    set +e
    systemctl stop magnetgate-exit magnetgate-dht || rollback_ok=0
    git reset --hard "$local_rev" || rollback_ok=0
    if [ -d "$stage/old-deps" ]; then
      if [ -d node_modules ]; then mv node_modules "$stage/failed-deps" || rollback_ok=0; fi
      mv "$stage/old-deps" node_modules || rollback_ok=0
    fi
    for unit in "$stage"/old-units/*; do if [ -f "$unit" ]; then cp "$unit" /etc/systemd/system/ || rollback_ok=0; fi; done
    while IFS= read -r name; do rm -f -- "/etc/systemd/system/$name" || rollback_ok=0; done < "$stage/new-units"
    systemctl daemon-reload || rollback_ok=0
    systemctl start magnetgate-exit magnetgate-dht || rollback_ok=0
    sleep 3
    healthy || rollback_ok=0
    if [ "$rollback_ok" = 1 ]; then echo "deploy failed; restored $local_rev" >&2
    else echo "rollback incomplete; recovery files preserved in $stage" >&2; fi
  fi
  # Candidate is a mktemp directory under the fixed /opt prefix, never a computed user path.
  if [ "$rollback_ok" = 1 ]; then case "$stage" in /opt/magnetgate-candidate.*) rm -rf -- "$stage" ;; esac; fi
  exit "$rc"
}
trap rollback EXIT
git archive "$remote_rev" | tar -x -C "$stage"
(cd "$stage" && npm ci --omit=dev --loglevel=error && npm test)
mkdir -p "$stage/old-units"
: > "$stage/new-units"
for unit in "$stage"/systemd/*.service "$stage"/systemd/*.timer; do
  [ -f "$unit" ] || continue
  name=$(basename "$unit")
  if [ -f "/etc/systemd/system/$name" ]; then cp "/etc/systemd/system/$name" "$stage/old-units/"; else printf '%s\n' "$name" >> "$stage/new-units"; fi
done
activated=1
systemctl stop magnetgate-exit magnetgate-dht
if [ -d node_modules ]; then mv node_modules "$stage/old-deps"; fi
mv "$stage/node_modules" node_modules
git reset --hard "$remote_rev" --quiet
for unit in systemd/*.service systemd/*.timer; do cp "$unit" /etc/systemd/system/; done
systemctl daemon-reload
systemctl start magnetgate-exit magnetgate-dht
sleep 3
healthy
# Success is recorded only after activation; a failed npm ci/check/restart remains retryable.
printf '%s\n' "$remote_rev" > "$state/revision.tmp"
mv "$state/revision.tmp" "$state/revision"
activated=0
echo "$(date -Is) deployed $remote_rev" >> /var/log/magnetgate-deploy.log
