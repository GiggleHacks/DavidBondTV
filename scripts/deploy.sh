#!/usr/bin/env bash
# Safe production deploy for David Bond TV.
#
# Ships CODE only. Never touches live content or user data:
#   - data/      → user accounts, comments, payments, memberships, geo rules
#   - media/     → uploaded video sources (originals)
#   - content/   → THE VIDEO MANIFEST (videos.json) + thumbnails, hover previews,
#                  quality renditions, storyboards — all live outside public/
# data/, media/ and content/ live OUTSIDE public/ and are simply never named in
# the tar below, so a deploy physically cannot wipe the live library or accounts
# (the bug where "all the videos vanished" after a deploy).
#
# It also: (1) backs up prod data+content first, (2) records the video count
# before/after and ABORTS-LOUDLY in the output if the count dropped.
#
# Usage:  bash scripts/deploy.sh   (run scripts/migrate-content.sh ONCE first if
#         prod still has content under public/ from before the content-dir move)
set -euo pipefail

SERVER="root@72.62.241.93"
APP="/opt/davidbondtv"
TS="$(date +%Y%m%d-%H%M%S)"

echo "==> [1/4] Backing up prod data + content…"
ssh "$SERVER" "cd $APP && tar czf /root/dbtv-backup-$TS.tgz data content 2>/dev/null || true; \
  echo 'backup: /root/dbtv-backup-$TS.tgz'; \
  BEFORE=\$(node -e 'try{console.log(require(\"$APP/content/thumbs/videos.json\").length)}catch(e){console.log(0)}'); \
  echo \"videos before: \$BEFORE\" > /tmp/dbtv-deploy-before"

echo "==> [2/4] Deploying code (content + data excluded)…"
tar czf - \
  server.mjs package.json lib public build scripts .env.example \
  | ssh "$SERVER" "tar xzf - -C $APP"

echo "==> [3/4] Restarting service…"
ssh "$SERVER" "systemctl restart davidbondtv && sleep 1 && systemctl is-active davidbondtv"

echo "==> [4/4] Verifying the video library is intact…"
ssh "$SERVER" "BEFORE=\$(sed 's/[^0-9]//g' /tmp/dbtv-deploy-before); \
  AFTER=\$(node -e 'try{console.log(require(\"$APP/content/thumbs/videos.json\").length)}catch(e){console.log(0)}'); \
  echo \"videos before=\$BEFORE after=\$AFTER\"; \
  if [ \"\$AFTER\" -lt \"\$BEFORE\" ]; then echo '!!! WARNING: video count DROPPED — restore from /root/dbtv-backup-$TS.tgz'; exit 1; fi; \
  echo 'OK: library intact.'"

echo "==> Done. Backup: /root/dbtv-backup-$TS.tgz"
