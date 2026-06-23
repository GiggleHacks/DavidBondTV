# David Bond TV — Deployment Runbook

Production runs at **https://davidbondtv.com** (Cloudflare → nginx → Node app).

## Topology
- **Host:** `root@72.62.241.93` (Ubuntu, Node 22, ffmpeg) — *shared box with many other sites; only touch `/opt/davidbondtv` + its nginx vhost.*
- **App dir:** `/opt/davidbondtv` (plain files, NOT a git repo). Port **3000**.
- **Service:** systemd `davidbondtv.service` (`WorkingDirectory=/opt/davidbondtv`, `ExecStart=/usr/bin/node server.mjs`, `Restart=always`).
- **Env drop-ins:** `/etc/systemd/system/davidbondtv.service.d/`
  - `admin.conf` — `ADMIN_PASSWORD`, `ADMIN_SECRET` (legacy admin fallback; leave as-is).
  - `env.conf` — `AUTH_SECRET` (stable — **never change** or all sessions drop), `BASE_URL=https://davidbondtv.com`, `TRUST_CLOUDFLARE=1`.
- **nginx vhost:** `/etc/nginx/sites-available/davidbondtv` (+ symlink in `sites-enabled`). Serves `:80` and `:443` (LE cert), both proxy to `127.0.0.1:3000`, no forced redirect (works under any Cloudflare SSL mode), `client_max_body_size 2g`.
- **TLS:** Let's Encrypt cert `davidbondtv.com` + `www` (`/etc/letsencrypt/live/davidbondtv.com/`), auto-renews. ACME webroot: `/var/www/davidbondtv-acme`.
- **DNS (Cloudflare):** zone `davidbondtv.com`, `A davidbondtv.com → 72.62.241.93` (proxied), `CNAME www → davidbondtv.com` (proxied).

## Redeploy (code only — the normal case)
From the repo root on the dev machine (no rsync available → tar over ssh). **Excludes `data/` and `media/` so live accounts, analytics, and uploaded videos are preserved.**

```bash
tar czf - server.mjs package.json lib public build scripts .env.example \
  | ssh root@72.62.241.93 'tar xzf - -C /opt/davidbondtv'
ssh root@72.62.241.93 'systemctl restart davidbondtv && systemctl is-active davidbondtv'
```

> ⚠️ Do **NOT** include `data/` in a normal redeploy — it would clobber live accounts/analytics. `data/` was only seeded once at launch.

## Publishing videos (local → server)
Transcoding is heavy, so process videos on the **local** machine and push the finished
artifacts to production over HTTPS — the server does no ffmpeg work.

**One-time setup:**
1. Generate a shared secret: `openssl rand -hex 32`.
2. On the **server**, add `SYNC_TOKEN=<secret>` to the service env (e.g. a systemd drop-in
   `/etc/systemd/system/davidbondtv.service.d/sync.conf` with `[Service]` / `Environment=SYNC_TOKEN=…`),
   then `systemctl daemon-reload && systemctl restart davidbondtv`. When `SYNC_TOKEN` is unset
   the `/api/sync/*` endpoints stay 404 (disabled).
3. On the **local** machine's `.env`, set the SAME `SYNC_TOKEN` plus `SYNC_TARGET_URL=https://davidbondtv.com`.

**Each time:** upload + let videos process locally, then open the Videos admin page →
**Publish to server**. It diffs against the server (by id + fingerprint), uploads only
missing/changed videos' artifacts in resumable chunks (each verified by SHA-256), and merges
the manifest entry last. Re-running is safe/idempotent; a mid-push interruption resumes cleanly.
Only the manifest + content artifacts sync — never users, payments, comments, analytics, or config.

## Content wipe (server)
`node scripts/wipe-content.mjs --yes` on the server, OR the manual equivalent: set `public/thumbs/videos.json` to `[]`, `rm -rf public/{videos,previews,storyboards}/*`, empty `data/{comments,reactions}.json` and `data/analytics/*`. Preserves accounts.

## Rollback
- Data backups: `/root/davidbondtv-data-backup-*.tgz` (restore with `tar xzf <file> -C /opt/davidbondtv`).
- Code: re-deploy a previous build; the service auto-restarts on failure.

## Operator checklist / follow-ups
- After deploying the admin hardening change, run `node scripts/reset-admin-password.mjs` on the server and set a new long random password. This rotates the admin `securityStamp`, which expires any session minted through the old recovery flow.
- **Rotate the Cloudflare + Hostinger API tokens** that were shared in chat.
- In the Cloudflare dashboard, set **SSL/TLS → Full (strict)** so the CF→origin hop is encrypted (the origin has a valid LE cert; this API token couldn't read/set the SSL mode).
- Geo-blocking is currently **disabled** (clean launch). Re-enable per-country in `/gigglehacksclicking85hgfd7845789drghudr789rdhkjrtbi8r5eg9875g789` when desired.
- Admin login: username `davidbond` at `/gigglehacksclicking85hgfd7845789drghudr789rdhkjrtbi8r5eg9875g789` (password in `data/admin-credentials.txt`, or reset with `node scripts/reset-admin-password.mjs`).
