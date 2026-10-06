#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PINS="$ROOT/scripts/pins.json"
TOOLS="$ROOT/tools/sing-box"

read_pin() {
  node -e '
const pins = require(process.argv[1])
let value = pins
for (const part of process.argv.slice(2)) value = value && value[part]
if (value === undefined || value === null) process.exit(2)
process.stdout.write(String(value))
' "$PINS" "$@"
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Run this downloader on macOS" >&2; exit 1
fi

case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="amd64" ;;
  *) echo "unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

VERSION="$(read_pin singBox version)"
URL="$(read_pin singBox darwin "$ARCH" url)"
ARCHIVE_SHA="$(read_pin singBox darwin "$ARCH" archiveSha256)"
BINARY_SHA="$(read_pin singBox darwin "$ARCH" binarySha256)"
BINARY_PATH="$(read_pin singBox darwin "$ARCH" binaryPathInArchive)"
URL="${URL//\{version\}/$VERSION}"
BINARY_PATH="${BINARY_PATH//\{version\}/$VERSION}"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/magnetgate-singbox.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

mkdir -p "$TOOLS"
ARCHIVE="$TMP/sing-box.tar.gz"
curl -L -f -o "$ARCHIVE" "$URL"
GOT="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
if [[ "$GOT" != "$ARCHIVE_SHA" ]]; then
  echo "sing-box archive checksum mismatch: got $GOT, expected $ARCHIVE_SHA" >&2
  exit 1
fi

tar -xzf "$ARCHIVE" -C "$TMP"
GOT="$(shasum -a 256 "$TMP/$BINARY_PATH" | awk '{print $1}')"
if [[ "$GOT" != "$BINARY_SHA" ]]; then
  echo "sing-box binary checksum mismatch: got $GOT, expected $BINARY_SHA" >&2
  exit 1
fi
install -m 755 "$TMP/$BINARY_PATH" "$TOOLS/sing-box"

for NAME in refilter-domains.srs refilter-ip.srs; do
  RULE_URL="$(read_pin ruleSets "$NAME" url)"
  RULE_SHA="$(read_pin ruleSets "$NAME" sha256)"
  RULE_TMP="$TMP/$NAME"
  curl -L -f -o "$RULE_TMP" "$RULE_URL"
  GOT="$(shasum -a 256 "$RULE_TMP" | awk '{print $1}')"
  if [[ "$GOT" != "$RULE_SHA" ]]; then
    echo "$NAME checksum mismatch: got $GOT, expected $RULE_SHA" >&2
    exit 1
  fi
  install -m 644 "$RULE_TMP" "$TOOLS/$NAME"
done

echo "ok  sing-box $VERSION for darwin-$ARCH installed at $TOOLS/sing-box"
