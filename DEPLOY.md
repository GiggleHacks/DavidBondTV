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

## Content wipe (server)
`node scripts/wipe-content.mjs --yes` on the server, OR the manual equivalent: set `public/thumbs/videos.json` to `[]`, `rm -rf public/{videos,previews,storyboards}/*`, empty `data/{comments,reactions}.json` and `data/analytics/*`. Preserves accounts.

## Rollback
- Data backups: `/root/davidbondtv-data-backup-*.tgz` (restore with `tar xzf <file> -C /opt/davidbondtv`).
- Code: re-deploy a previous build; the service auto-restarts on failure.

## Operator checklist / follow-ups
- **Rotate the Cloudflare + Hostinger API tokens** that were shared in chat.
- In the Cloudflare dashboard, set **SSL/TLS → Full (strict)** so the CF→origin hop is encrypted (the origin has a valid LE cert; this API token couldn't read/set the SSL mode).
- Geo-blocking is currently **disabled** (clean launch). Re-enable per-country in `/god` when desired.
- Admin login: username `davidbond` (password in `data/admin-credentials.txt`).
