# Deploying GigaBrain Analytics ("Analytics 2.0")

GigaBrain is a **separate Next.js + SQLite service** that runs alongside davidbondtv
on the same VPS. davidbondtv feeds it traffic (the tracker snippet) and embeds its
dashboard as the **Analytics 2.0** admin tile. The two never share a process.

- **Sidecar project (local):** `D:\Local\Digital Products\gigabrain-analytics`
- **Origin:** `https://analytics.davidbondtv.com` → `127.0.0.1:3001`
- **DB:** SQLite at `/var/lib/gigabrain-analytics/analytics.db` (outside the app dir)

Local dev is already wired: set `GIGABRAIN_PUBLIC_URL=http://localhost:3001` on
davidbondtv and run the sidecar with `npx next dev -p 3001`.

---

## 1. DNS (Cloudflare)

Add an **A record**: `analytics.davidbondtv.com → 72.62.241.93`, **Proxied** (orange
cloud). Proxying is what supplies the `cf-ip*` geo headers GigaBrain reads.

## 2. Build + ship the sidecar to the VPS

On the VPS install the native-build toolchain once (better-sqlite3 compiles):
```bash
apt-get update && apt-get install -y build-essential python3
```
Deploy the project to `/opt/gigabrain-analytics` (exclude `node_modules`, `.next`,
`data`), then on the server:
```bash
cd /opt/gigabrain-analytics
npm ci
npm run build
mkdir -p /var/lib/gigabrain-analytics
node scripts/set-admin.mjs '<STRONG_DASHBOARD_PASSWORD>' /var/lib/gigabrain-analytics/analytics.db
```

## 3. systemd unit — `gigabrain-analytics.service`

`/etc/systemd/system/gigabrain-analytics.service`:
```ini
[Unit]
Description=GigaBrain analytics (Next.js)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/gigabrain-analytics
ExecStart=/usr/bin/npx next start -p 3001 -H 127.0.0.1
Restart=always
Environment=NODE_ENV=production
Environment=ADMIN_SESSION_SECRET=<LONG_RANDOM_STRING>
Environment=ANALYTICS_DB_PATH=/var/lib/gigabrain-analytics/analytics.db
# Optional: Environment=CRON_SECRET=<random>   (for /api/cron/maintain)

[Install]
WantedBy=multi-user.target
```
```bash
systemctl daemon-reload && systemctl enable --now gigabrain-analytics
systemctl is-active gigabrain-analytics
```
Binding `-H 127.0.0.1` keeps it private; nginx is the only public door.

## 4. nginx — new server block

`/etc/nginx/sites-available/analytics.davidbondtv.com`:
```nginx
server {
    listen 443 ssl;
    server_name analytics.davidbondtv.com;

    ssl_certificate     /etc/letsencrypt/live/davidbondtv.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/davidbondtv.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Geo + real-IP headers GigaBrain reads (lib/geoheaders.ts):
        proxy_set_header CF-Connecting-IP  $http_cf_connecting_ip;
        proxy_set_header CF-IPCountry      $http_cf_ipcountry;
        proxy_set_header CF-IPCity         $http_cf_ipcity;
        proxy_set_header CF-IPLatitude     $http_cf_iplatitude;
        proxy_set_header CF-IPLongitude    $http_cf_iplongitude;
        proxy_set_header CF-Region         $http_cf_region;
    }
}
```
Expand the existing Let's Encrypt cert to cover the subdomain (keeps one cert):
```bash
certbot --nginx -d davidbondtv.com -d www.davidbondtv.com -d analytics.davidbondtv.com
nginx -t && systemctl reload nginx
```

## 5. Cloudflare geo headers (David must toggle)

Cloudflare dashboard → **Rules → Transform Rules → Managed Transforms** → enable
**"Add visitor location headers"**. Without it the dashboards still work but lose
city/lat-lon precision (country falls back to centroids). I can't change Cloudflare
settings — this step is David's.

## 6. Turn it on in davidbondtv

Add to davidbondtv's systemd env drop-in (e.g. `…/davidbondtv.service.d/env.conf`):
```ini
Environment=GIGABRAIN_PUBLIC_URL=https://analytics.davidbondtv.com
```
Redeploy davidbondtv code (the changed `server.mjs`, `lib/`, `public/`) and:
```bash
systemctl daemon-reload && systemctl restart davidbondtv
```
This makes davidbondtv (a) inject the tracker on public pages, (b) allow the sidecar
origin in its CSP (`connect-src` + `frame-src`, see `lib/http-util.js`), and (c) stamp
the iframe URL into the Analytics 2.0 tile.

## 7. Verify in prod

- Visit `https://davidbondtv.com/` → DevTools Network shows a `POST` to
  `https://analytics.davidbondtv.com/api/collect` returning **204**.
- Open the admin → **Analytics 2.0** tile → sign in to the embedded dashboard once →
  Overview/Real-time show live traffic, geo now populated.

---

## Notes & gotchas

- **Same-site cookie:** `analytics.davidbondtv.com` and `davidbondtv.com` share the
  registrable domain, so the dashboard's `SameSite=Lax` login cookie works inside the
  iframe and the tracker's cross-subdomain beacon is a simple (no-preflight) request.
- **iframe headers:** the sidecar sets `Content-Security-Policy: frame-ancestors`
  allowing `davidbondtv.com` (`next.config.ts`); davidbondtv allows the sidecar in
  `frame-src`/`connect-src` (`lib/http-util.js`). Both sides must list prod origins —
  already configured; just keep them in sync if the domain changes.
- **DB safety:** never put `ANALYTICS_DB_PATH` inside `/opt/gigabrain-analytics` — a
  redeploy would wipe it. Keep it in `/var/lib/...`.
- **Retention:** optional cron `curl "https://analytics.davidbondtv.com/api/cron/maintain?key=$CRON_SECRET"`
  daily prunes old rows.
- **GSC panels** stay disabled until `GSC_KEY_PATH` + `GSC_SITE_URL` are set; harmless.
- **Two analytics systems run in parallel** (davidbondtv's own `/api/track` + GigaBrain)
  — by design, fully additive.
