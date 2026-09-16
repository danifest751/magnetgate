#!/usr/bin/env bash
# Snapshot everything needed to rebuild this exit on a fresh host, into a root-only archive.
#   bash /opt/magnetgate/scripts/backup-node.sh [destination-dir]
#
# Contents: the env file (PSK, port, advertised host), the sing-box identity (Reality keypair, hy2
# key/cert, obfs password, rotation state), the currently advertised dp, the durable publication
# sequence, and the systemd drop-ins that make this host the node it is (slot, name, country).
#
# Restore on a fresh host: install Node and the repo, run scripts/setup-singbox.sh with the same
# MAGNETGATE_PUBLIC_HOST (it creates a *new* identity if keep.json is absent) and then unpack this
# archive over the root filesystem, so the identity and the slot/country come back unchanged:
#   tar -xzf <archive> -C /
#   systemctl daemon-reload && systemctl restart magnetgate-exit sing-box
#
# A backup holds secrets: it is written 0600, keeps only the newest MAGNETGATE_BACKUP_KEEP archives
# (default 14) and should never be copied to a machine that does not already hold the PSK.
set -euo pipefail
dest="${1:-/var/backups/magnetgate}"
keep="${MAGNETGATE_BACKUP_KEEP:-14}"
host="$(hostname -s)"
stamp="$(date +%Y%m%d-%H%M%S)"
out="$dest/${host}-${stamp}.tar.gz"
umask 077
mkdir -p "$dest"

items=()
for candidate in \
  /etc/magnetgate.env \
  /etc/magnetgate-dp.json \
  /etc/sing-box/keep.json \
  /etc/sing-box/hy2.crt \
  /etc/sing-box/hy2.key \
  /etc/sing-box/rotation-state.json \
  /etc/sing-box/config.json \
  /var/lib/magnetgate/seq; do
  [ -f "$candidate" ] && items+=("$candidate")
done
# the drop-ins are what make this host its own slot/country
while IFS= read -r file; do
  [ -n "$file" ] && items+=("$file")
done < <(find /etc/systemd/system -maxdepth 2 -path '*magnetgate*' -name '*.conf' 2>/dev/null | sort)
while IFS= read -r file; do
  [ -n "$file" ] && items+=("$file")
done < <(find /etc/systemd/system -maxdepth 1 -path '*magnetgate*' -name '*.service' 2>/dev/null | sort)

if [ "${#items[@]}" -eq 0 ]; then
  echo 'backup: nothing to archive' >&2
  exit 1
fi

tar -czf "$out" "${items[@]}"
# prove the archive is readable before declaring success
tar -tzf "$out" >/dev/null
chmod 600 "$out"

pruned=0
while IFS= read -r old; do
  [ -n "$old" ] && rm -f -- "$old" && pruned=$((pruned + 1))
done < <(ls -1t "$dest/${host}-"*.tar.gz 2>/dev/null | tail -n +$((keep + 1)))

echo "backup: $out ($(du -h "$out" | cut -f1), ${#items[@]} files, pruned $pruned)"
