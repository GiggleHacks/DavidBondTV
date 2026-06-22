#!/usr/bin/env bash
# ONE-TIME cutover: move generated/uploaded content out of public/ into content/.
#
# Before the content-dir refactor, the manifest + thumbnails + previews +
# renditions + storyboards lived under public/, which deploys ship — so a stale
# local copy could wipe the live library. The server now reads/writes content/
# (outside public/). This script relocates any pre-existing prod content to match.
#
# Safe to re-run: it only moves a dir that still exists under public/, merges into
# content/ if that already exists, verifies the manifest survived, and removes the
# public/ copy only after a successful merge. Run it ON the server, e.g.:
#   ssh root@SERVER 'bash -s' < scripts/migrate-content.sh
set -euo pipefail

APP="${APP:-/opt/davidbondtv}"
TS="$(date +%Y%m%d-%H%M%S)"
cd "$APP"

DIRS=(thumbs previews videos storyboards)

# Nothing to do if no content remains under public/.
have_public=0
for d in "${DIRS[@]}"; do [ -d "public/$d" ] && have_public=1; done
if [ "$have_public" -eq 0 ]; then
  echo "migrate-content: nothing under public/ to move — already migrated."
  exit 0
fi

echo "==> Backing up before migration…"
tar czf "/root/dbtv-premigrate-$TS.tgz" data public/thumbs public/previews public/videos public/storyboards 2>/dev/null || true
echo "backup: /root/dbtv-premigrate-$TS.tgz"

BEFORE=$(node -e 'try{console.log(require(process.argv[1]).length)}catch(e){console.log(0)}' "$APP/public/thumbs/videos.json" 2>/dev/null || echo 0)
echo "manifest entries (public, before): $BEFORE"

mkdir -p content
for d in "${DIRS[@]}"; do
  [ -d "public/$d" ] || { echo "  - public/$d: absent, skip"; continue; }
  if [ -e "content/$d" ]; then
    echo "  - merging public/$d -> content/$d"
    cp -a "public/$d/." "content/$d/"
    rm -rf "public/$d"
  else
    echo "  - moving public/$d -> content/$d"
    mv "public/$d" "content/$d"
  fi
done

AFTER=$(node -e 'try{console.log(require(process.argv[1]).length)}catch(e){console.log(0)}' "$APP/content/thumbs/videos.json" 2>/dev/null || echo 0)
echo "manifest entries (content, after): $AFTER"
if [ "$AFTER" -lt "$BEFORE" ]; then
  echo "!!! WARNING: manifest count dropped ($BEFORE -> $AFTER) — restore from /root/dbtv-premigrate-$TS.tgz"
  exit 1
fi
echo "OK: content migrated. Restart the service to pick up the new code paths."
