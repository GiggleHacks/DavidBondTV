#!/usr/bin/env bash
# Automated backup of David Bond TV's live data + content. Run by cron twice a
# month (1st & 15th). Snapshots everything that ISN'T in git/the code deploy:
#   data/      → accounts, comments, payments, memberships, geo rules
#   content/   → the video manifest (videos.json), thumbnails, hover previews,
#                quality renditions, and storyboards (all live outside public/)
# Keeps the 6 most recent snapshots (≈3 months at twice-monthly). Original
# uploads in media/ are intentionally NOT included (large; renditions in content/
# are re-derivable — back originals up separately if desired).
set -euo pipefail

APP="/opt/davidbondtv"
DEST="/root/backups"
mkdir -p "$DEST"
TS="$(date +%Y%m%d-%H%M%S)"

cd "$APP"
tar czf "$DEST/dbtv-auto-$TS.tgz" data content 2>/dev/null || true
echo "$(date -Is) backup -> $DEST/dbtv-auto-$TS.tgz ($(du -h "$DEST/dbtv-auto-$TS.tgz" | cut -f1))"

# Rotate: keep the 6 newest auto backups, delete older ones.
ls -1t "$DEST"/dbtv-auto-*.tgz 2>/dev/null | tail -n +7 | xargs -r rm -f
