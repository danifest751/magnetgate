#!/usr/bin/env bash
# One-time sing-box (Reality + hysteria2) data-plane setup on the exit VPS. Run as root.
#   MAGNETGATE_PUBLIC_HOST=<public-ip> [MAGNETGATE_REALITY_SNI=www.microsoft.com] bash scripts/setup-singbox.sh
# Config generation lives in rotate-dp.mjs (single source of truth); this script installs sing-box,
# creates the service user, the hy2 cert and the stable identity (keep.json), lays down the systemd
# units, then calls rotate-dp.mjs to generate the config + advertised dp and start sing-box.
set -euo pipefail
V="${SINGBOX_VERSION:-1.14.0}"
SHA="${SINGBOX_SHA256:-2375de6999f4f56ab46b4fc5ddf26a6aba1d3e61a0f4e7ddec2f4690457d5f63}" # sing-box-1.14.0-linux-amd64.tar.gz
EXIT_IP="${MAGNETGATE_PUBLIC_HOST:?set MAGNETGATE_PUBLIC_HOST=<public ip>}"
SNI="${MAGNETGATE_REALITY_SNI:-www.microsoft.com}"
REPO="${MAGNETGATE_REPO:-/opt/magnetgate}"

# 1. install sing-box (pinned)
if ! command -v sing-box >/dev/null 2>&1; then
  cd /tmp
  curl -fsSL -o sb.tar.gz "https://github.com/SagerNet/sing-box/releases/download/v${V}/sing-box-${V}-linux-amd64.tar.gz"
  echo "${SHA}  sb.tar.gz" | sha256sum -c -
  tar xzf sb.tar.gz && install -m0755 "sing-box-${V}-linux-amd64/sing-box" /usr/local/bin/sing-box
fi
sing-box version | head -1

# 2. service user + config dir
id -u sing-box >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin sing-box
install -d -o root -g sing-box -m 750 /etc/sing-box

# 3. hy2 self-signed EC cert (once). Include a subjectAltName so clients can PIN it and still pass
# Go's TLS hostname check (which ignores the legacy CN) with server_name=magnetgate.
if [ ! -f /etc/sing-box/hy2.crt ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout /etc/sing-box/hy2.key -out /etc/sing-box/hy2.crt -days 3650 -nodes \
    -subj "/CN=magnetgate" -addext "subjectAltName=DNS:magnetgate" >/dev/null 2>&1
  chgrp sing-box /etc/sing-box/hy2.key /etc/sing-box/hy2.crt; chmod 640 /etc/sing-box/hy2.key /etc/sing-box/hy2.crt
fi

# 4. stable identity (once): Reality keypair + hy2 obfs password
if [ ! -f /etc/sing-box/keep.json ]; then
  RK=$(sing-box generate reality-keypair)
  RPRIV=$(echo "$RK" | awk -F'[: ]+' '/PrivateKey/{print $2}')
  RPUB=$(echo "$RK"  | awk -F'[: ]+' '/PublicKey/{print $2}')
  umask 077
  printf '{ "rpriv":"%s", "rpub":"%s", "hy2obfs":"%s" }\n' "$RPRIV" "$RPUB" "$(openssl rand -hex 16)" > /etc/sing-box/keep.json
  chgrp sing-box /etc/sing-box/keep.json; chmod 640 /etc/sing-box/keep.json
fi

# 5. systemd units: sing-box (hardened, CAP_NET_BIND_SERVICE for :443) + daily rotation
cat > /etc/systemd/system/sing-box.service <<'UNIT'
[Unit]
Description=sing-box (Reality + hysteria2 data plane)
After=network-online.target
Wants=network-online.target
[Service]
User=sing-box
Group=sing-box
ExecStart=/usr/local/bin/sing-box run -c /etc/sing-box/config.json
Restart=always
RestartSec=5
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK
ReadOnlyPaths=/etc/sing-box
[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/magnetgate-rotate.service <<UNIT
[Unit]
Description=magnetgate data-plane credential rotation
After=network-online.target
[Service]
Type=oneshot
Environment=MAGNETGATE_PUBLIC_HOST=${EXIT_IP}
Environment=MAGNETGATE_REALITY_SNI=${SNI}
ExecStart=/usr/bin/node ${REPO}/scripts/rotate-dp.mjs
UNIT

cat > /etc/systemd/system/magnetgate-rotate.timer <<'UNIT'
[Unit]
Description=rotate magnetgate data-plane credentials daily
[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload

# 6. generate config + advertised dp from keep, and start sing-box (rotate-dp.mjs restarts it)
MAGNETGATE_PUBLIC_HOST="$EXIT_IP" MAGNETGATE_REALITY_SNI="$SNI" node "${REPO}/scripts/rotate-dp.mjs"
systemctl enable sing-box magnetgate-rotate.timer >/dev/null 2>&1
systemctl start magnetgate-rotate.timer

# 7. firewall
ufw allow 443/tcp >/dev/null 2>&1 || true
ufw allow 443/udp >/dev/null 2>&1 || true

echo "sing-box: $(systemctl is-active sing-box); rotate timer: $(systemctl is-active magnetgate-rotate.timer)"
echo "the magnetgate exit reads /etc/magnetgate-dp.json and advertises Reality + hysteria2 in the offer"
