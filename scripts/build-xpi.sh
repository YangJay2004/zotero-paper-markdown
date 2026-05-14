#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist"
VERSION="$(node -e "process.stdout.write(require('$ROOT/manifest.json').version)")"
NAME="paper-markdown-$VERSION.xpi"
STAGE="$(mktemp -d)"

trap 'rm -rf "$STAGE"' EXIT

rm -rf "$OUT"
mkdir -p "$OUT"

FILES=(
  manifest.json
  chrome.manifest
  bootstrap.js
  prefs.js
  preferences.xhtml
  preferences.js
  preferences.css
  task-center.xhtml
  task-center.js
  task-center.css
  icons
  locale
  src
)

for file in "${FILES[@]}"; do
  cp -R "$ROOT/$file" "$STAGE/$file"
done

if [[ -n "${ADDON_ID:-}" || -n "${HOMEPAGE_URL:-}" || -n "${UPDATE_URL:-}" ]]; then
  MANIFEST_PATH="$STAGE/manifest.json" \
  ADDON_ID="${ADDON_ID:-}" \
  HOMEPAGE_URL="${HOMEPAGE_URL:-}" \
  UPDATE_URL="${UPDATE_URL:-}" \
  node <<'NODE'
const fs = require("fs");

const path = process.env.MANIFEST_PATH;
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));

manifest.applications = manifest.applications || {};
manifest.applications.zotero = manifest.applications.zotero || {};

if (process.env.ADDON_ID) {
  manifest.applications.zotero.id = process.env.ADDON_ID;
}

if (process.env.HOMEPAGE_URL) {
  manifest.homepage_url = process.env.HOMEPAGE_URL;
}

if (process.env.UPDATE_URL) {
  manifest.applications.zotero.update_url = process.env.UPDATE_URL;
}

fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
NODE
fi

cd "$STAGE"
zip -r "$OUT/$NAME" \
  manifest.json \
  chrome.manifest \
  bootstrap.js \
  prefs.js \
  preferences.xhtml \
  preferences.js \
  preferences.css \
  task-center.xhtml \
  task-center.js \
  task-center.css \
  icons \
  locale \
  src \
  -x '*.DS_Store'

echo "$OUT/$NAME"
