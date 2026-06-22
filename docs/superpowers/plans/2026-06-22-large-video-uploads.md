# Large Video Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow admin uploads up to 25 GB by routing them through a Cloudflare-bypassing upload subdomain, and make the uploader always explain failures clearly.

**Architecture:** Code changes (cookie domain sharing, configurable 25 GB cap, rate-limit, exposed limit, client size pre-check + specific errors) ship via `scripts/deploy.sh`. One-time prod infra (grey-cloud DNS, nginx vhost, TLS, env) is done over SSH/Cloudflare. The transcode pipeline already downscales to 720p/360p and deletes the original — verify-only, no code.

**Tech Stack:** Node.js (vanilla `http`), nginx, Cloudflare, Let's Encrypt/certbot, systemd, vitest.

**Spec:** `docs/superpowers/specs/2026-06-22-large-video-uploads-design.md`

---

## File structure

**Code (ships via `scripts/deploy.sh`):**
- `lib/cookies.js` — add optional `Domain` attribute to `serializeCookie`.
- `lib/accounts.js` — thread a `cookieDomain` config into `setSession`/`clearSession`.
- `server.mjs` — `COOKIE_DOMAIN` env → accounts; env-configurable `UPLOAD_MAX_BYTES` (25 GB default); expose `maxUploadBytes` in `/api/admin/status`; rate-limit the upload endpoint.
- `public/js/admin.js` — hand off to the upload host on the main domain; fetch the limit; proactive size pre-check; specific failure messages + missing xhr handlers.
- `tests/cookies.test.js` — new unit tests for the cookie change.
- `package.json` — version `1.14.1` → `1.15.0`.

**Prod infra (SSH / Cloudflare, not in the tar):** Cloudflare DNS, nginx vhost, TLS cert, systemd `env.conf`.

---

# PART A — Code changes

## Task 1: Add `Domain` support to `serializeCookie`

**Files:**
- Modify: `lib/cookies.js:24-33`
- Test: `tests/cookies.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/cookies.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { serializeCookie } from '../lib/cookies.js';

describe('serializeCookie — Domain', () => {
  it('omits Domain when not provided', () => {
    expect(serializeCookie('s', 'v', { httpOnly: true })).not.toMatch(/Domain=/);
  });

  it('includes Domain when provided', () => {
    expect(serializeCookie('s', 'v', { domain: 'davidbondtv.com' }))
      .toMatch(/; Domain=davidbondtv\.com/);
  });

  it('keeps the other attributes alongside Domain', () => {
    const c = serializeCookie('s', 'v', {
      maxAge: 60, httpOnly: true, sameSite: 'Lax', secure: true, domain: 'davidbondtv.com',
    });
    expect(c).toMatch(/^s=v/);
    expect(c).toMatch(/Max-Age=60/);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).toMatch(/Secure/);
    expect(c).toMatch(/Domain=davidbondtv\.com/);
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npx vitest run tests/cookies.test.js`
Expected: FAIL — "includes Domain when provided" / "keeps the other attributes" fail (no `Domain=` emitted yet).

- [ ] **Step 3: Implement**

In `lib/cookies.js`, update the JSDoc and add the `Domain` segment. Replace lines 20-33:

```js
/**
 * serializeCookie(name, value, opts)
 * opts: { maxAge (seconds), path, domain, httpOnly, sameSite, secure, expires (Date) }
 */
export function serializeCookie(name, value, opts = {}) {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  segments.push(`Path=${opts.path || '/'}`);
  if (opts.domain) segments.push(`Domain=${opts.domain}`);
  if (typeof opts.maxAge === 'number') segments.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires instanceof Date) segments.push(`Expires=${opts.expires.toUTCString()}`);
  if (opts.httpOnly) segments.push('HttpOnly');
  segments.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.secure) segments.push('Secure');
  return segments.join('; ');
}
```

- [ ] **Step 4: Run it; verify it passes**

Run: `npx vitest run tests/cookies.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add lib/cookies.js tests/cookies.test.js
git commit -m "feat(cookies): optional Domain attribute on serializeCookie"
```

---

## Task 2: Thread `cookieDomain` through the session cookie

**Files:**
- Modify: `lib/accounts.js:63` (config destructure), `:92-94` (`setSession`), `:97-100` (`clearSession`)

- [ ] **Step 1: Accept the config option**

In `lib/accounts.js`, the factory config destructure currently reads (line ~63):

```js
  tokenSecret, challengeSecret, baseUrl, usersFile, mediaDir, isSecure = false,
```

Add `cookieDomain = ''`:

```js
  tokenSecret, challengeSecret, baseUrl, usersFile, mediaDir, isSecure = false, cookieDomain = '',
```

- [ ] **Step 2: Apply it in `setSession` and `clearSession`**

Replace the `setSession` Set-Cookie call (lines ~92-94):

```js
    res.setHeader('Set-Cookie', serializeCookie(COOKIE, token, {
      httpOnly: true, maxAge: SESSION_TTL / 1000, sameSite: 'Lax', secure: isSecure, domain: cookieDomain || undefined,
    }));
```

Replace the `clearSession` Set-Cookie call (lines ~98-100):

```js
    res.setHeader('Set-Cookie', serializeCookie(COOKIE, '', {
      httpOnly: true, maxAge: 0, sameSite: 'Lax', secure: isSecure, domain: cookieDomain || undefined,
    }));
```

(`domain: undefined` → `serializeCookie` skips it, so dev/unset behaviour is unchanged.)

- [ ] **Step 3: Verify nothing broke**

Run: `npm test`
Expected: all suites pass (no accounts test exercises the cookie domain; this confirms no regression).

- [ ] **Step 4: Commit**

```bash
git add lib/accounts.js
git commit -m "feat(accounts): optional cookieDomain to share session across subdomains"
```

---

## Task 3: Server — COOKIE_DOMAIN, 25 GB cap, exposed limit, upload rate-limit

**Files:**
- Modify: `server.mjs:90` (`UPLOAD_MAX_BYTES`), `:96` (add `COOKIE_DOMAIN` + upload limiter), `:128-134` (`createAccounts`), `:718-728` (`/api/admin/status`), `:1097-1106` (upload handler)

- [ ] **Step 1: Make `UPLOAD_MAX_BYTES` configurable (25 GB default)**

Replace line 90:

```js
const UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB cap
```

with:

```js
// Max accepted upload size. Configurable so the grey-cloud upload host can take
// large masters; default 25 GB. (Cloudflare still caps the main host at ~100 MB,
// so large uploads go via the DNS-only upload subdomain — see deploy docs.)
const UPLOAD_MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES) || 25 * 1024 * 1024 * 1024;
```

- [ ] **Step 2: Add `COOKIE_DOMAIN` and an upload rate-limiter**

After line 96 (`const COOKIE_SECURE = ...`), add:

```js
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || ''; // e.g. 'davidbondtv.com' → session shared with upload subdomain
const uploadLimiter = createRateLimiter(60_000, 30); // 30 upload starts/min per IP
```

(`createRateLimiter` is already imported and used for `recoverLimiter`.)

- [ ] **Step 3: Pass `cookieDomain` into accounts**

In the `createAccounts({ … })` call (starts line 128), add the option next to `isSecure` (line ~134 `isSecure: BASE_URL.startsWith('https'),`):

```js
  isSecure: BASE_URL.startsWith('https'),
  cookieDomain: COOKIE_DOMAIN,
```

- [ ] **Step 4: Expose `maxUploadBytes` in `/api/admin/status`**

Replace the two `sendJson` lines in the status handler (lines ~725 and ~727):

```js
    if (jobId) {
      sendJson(res, 200, { job: getJob(jobId), ffmpeg: hasFfmpeg(), maxUploadBytes: UPLOAD_MAX_BYTES });
    } else {
      sendJson(res, 200, { jobs: listJobs(), ffmpeg: hasFfmpeg(), maxUploadBytes: UPLOAD_MAX_BYTES });
    }
```

- [ ] **Step 5: Rate-limit the upload endpoint**

In the upload handler, right after the admin check (the `if (!isAdminReq(req)) { … }` block ending ~line 1101), insert before the `const name = …` line:

```js
    if (!uploadLimiter.hit(clientIp(req)).allowed) {
      sendJson(res, 429, { error: 'Too many uploads — wait a minute and try again.' });
      return true;
    }
```

(`clientIp` is already imported from `./lib/http-util.js`.)

- [ ] **Step 6: Verify**

Run: `npm test`
Expected: all suites pass.

Run: `node --check server.mjs`
Expected: no output (syntax OK).

- [ ] **Step 7: Commit**

```bash
git add server.mjs
git commit -m "feat(upload): 25GB configurable cap, COOKIE_DOMAIN, rate-limit, expose maxUploadBytes"
```

---

## Task 4: Client — upload-host handoff, size pre-check, honest errors

**Files:**
- Modify: `public/js/admin.js` — top (after imports), `enqueueFiles` (lines ~128-152), `startUpload` (lines ~160-196), `checkFfmpeg` (the `/api/admin/status` fetch, ~lines 248-251)

- [ ] **Step 1: Hand off to the upload host + a size helper + the cached limit**

Near the top of `public/js/admin.js`, just after the `import { requireAdmin } …` line, add:

```js
// Large uploads must skip Cloudflare's ~100MB proxy cap, so the upload page is
// served from a DNS-only subdomain. If we're on the main (proxied) host, hand off
// before doing any work. (No effect on localhost or the upload host itself.)
const UPLOAD_HOST = 'upload.davidbondtv.com';
const MAIN_HOSTS = ['davidbondtv.com', 'www.davidbondtv.com'];
if (MAIN_HOSTS.includes(location.hostname)) {
  location.replace(`https://${UPLOAD_HOST}/god-upload.html${location.search}`);
}

// Upload size limit (overwritten from /api/admin/status on load). 25 GB fallback.
let maxUploadBytes = 25 * 1024 * 1024 * 1024;

function fmtSize(bytes) {
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function uploadErrorFor(status) {
  if (status === 413) return `File too large (max ${fmtSize(maxUploadBytes)}).`;
  if (status === 415) return 'Only .mp4/.mov/.m4v video files are accepted.';
  if (status === 429) return 'Too many uploads — wait a minute and try again.';
  return `Upload failed (${status || 'no response from server'}).`;
}
```

- [ ] **Step 2: Pull the real limit from the status endpoint**

Find the status fetch in `checkFfmpeg` (≈ lines 248-251):

```js
    const data = await (await fetch('/api/admin/status')).json();
    $('ffmpeg-banner').classList.toggle('hidden', data.ffmpeg !== false);
```

Replace with:

```js
    const data = await (await fetch('/api/admin/status')).json();
    $('ffmpeg-banner').classList.toggle('hidden', data.ffmpeg !== false);
    if (typeof data.maxUploadBytes === 'number' && data.maxUploadBytes > 0) maxUploadBytes = data.maxUploadBytes;
```

- [ ] **Step 3: Proactive size pre-check in `enqueueFiles`**

In `enqueueFiles`, replace the `list.forEach((file, i) => { … })` body (lines ~143-151) with:

```js
  list.forEach((file, i) => {
    const publishAt = sched && i > 0 ? base + i * sched.interval : 0;
    const rowId = `row-${Date.now()}-${Math.round(performance.now())}-${Math.random().toString(36).slice(2, 6)}`;
    const tag = visibility === 'premium' ? '  · Premium' : '';
    const when = publishAt ? `  · ⏱ ${new Date(publishAt).toLocaleString()}` : '';
    renderJob(rowId, `${file.name}${tag}${when}`);
    if (file.size > maxUploadBytes) {
      setState(rowId, 'failed', { title: `Too large — ${fmtSize(file.size)} exceeds the ${fmtSize(maxUploadBytes)} upload limit.` });
      return; // never even attempt the upload
    }
    setStats(rowId, 'Waiting…');
    uploadQueue.push({ file, rowId, visibility, blur, category, publishAt });
  });
```

- [ ] **Step 4: Specific failure messages + once-only `done()` + extra handlers**

In `startUpload`, replace the `done`/`onload`/`onerror`/`send` block (lines ~180-196) with:

```js
  let finished = false;
  const done = () => { if (finished) return; finished = true; inFlight--; pump(); };
  xhr.onload = () => {
    done();
    if (xhr.status === 401) { location.reload(); return; }
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON (e.g. gateway error) */ }
    if (xhr.status === 202 && data.jobId) {
      setProgress(rowId, 100);
      setStats(rowId, 'Uploaded · processing on server');
      setState(rowId, 'processing', { title: 'Processing…' });
      pollJob(rowId, data.jobId, publishAt);
    } else {
      setState(rowId, 'failed', { title: data.error || uploadErrorFor(xhr.status) });
    }
  };
  const failNetwork = () => {
    done();
    setState(rowId, 'failed', { title: 'Upload interrupted — check your connection (or the file may be too large).' });
  };
  xhr.onerror = failNetwork;
  xhr.upload.onerror = failNetwork;
  xhr.ontimeout = failNetwork;
  xhr.onabort = () => { done(); setState(rowId, 'failed', { title: 'Upload canceled.' }); };
  xhr.send(file);
```

- [ ] **Step 5: Verify (syntax + manual)**

Run: `node --check public/js/admin.js`
Expected: no output.

(Browser behaviour is verified live in Part B / the membership-style preview check; there is no DOM unit harness in this repo.)

- [ ] **Step 6: Commit**

```bash
git add public/js/admin.js
git commit -m "feat(upload-ui): host handoff, size pre-check, specific failure messages"
```

---

## Task 5: Version bump

**Files:**
- Modify: `package.json:3`

- [ ] **Step 1: Bump**

Change line 3 from `"version": "1.14.1",` to `"version": "1.15.0",`.

- [ ] **Step 2: Verify**

Run: `node -e "console.log(require('./package.json').version)"`
Expected: `1.15.0`

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 1.15.0 (large uploads)"
```

---

## Task 6: Full test sweep (code gate before infra)

- [ ] **Step 1: Run everything**

Run: `npm test`
Expected: all suites pass (incl. the new `tests/cookies.test.js`).

- [ ] **Step 2: Syntax-check the edited server/client**

Run: `node --check server.mjs && node --check public/js/admin.js && echo OK`
Expected: `OK`

---

# PART B — Prod infra (SSH / Cloudflare; one-time)

> These run against prod (`root@72.62.241.93`). Do them in order. Scope every change to the davidbondtv vhost / service only (shared box).

## Task 7: Pre-flight — confirm free disk

- [ ] **Step 1: Check disk**

Run: `ssh root@72.62.241.93 "df -h /opt/davidbondtv / && echo '---' && du -sh /opt/davidbondtv/content 2>/dev/null"`
Expected: enough free space for the transient peak — a 25 GB original + renditions per upload, ×3 concurrent ≈ **80 GB+ headroom**. If free space is below that, either lower `UPLOAD_MAX_BYTES`, reduce client concurrency, or expand the disk before continuing. Record the numbers.

## Task 8: Cloudflare DNS — grey-cloud upload record

- [ ] **Step 1: Add the record**

In the Cloudflare dashboard (zone `davidbondtv.com`) → DNS → Add record:
- Type `A`, Name `upload`, IPv4 `72.62.241.93`, **Proxy status: DNS only (grey cloud)**, TTL Auto.

(Or via API with the DNS-scoped token; ensure `proxied: false`.)

- [ ] **Step 2: Verify it resolves to the origin (not Cloudflare)**

Run: `nslookup upload.davidbondtv.com` (or `dig +short upload.davidbondtv.com`)
Expected: returns `72.62.241.93` directly (a single origin IP, **not** Cloudflare's 104.x/172.x ranges).

## Task 9: nginx — HTTP vhost for ACME, then HTTPS vhost for uploads

- [ ] **Step 1: Add an HTTP (port 80) server block for the upload host**

SSH in and edit `/etc/nginx/sites-available/davidbondtv`. Add a port-80 server block (so certbot's webroot challenge can be served). Model paths on the existing acme webroot `/var/www/davidbondtv-acme`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name upload.davidbondtv.com;
    location /.well-known/acme-challenge/ { root /var/www/davidbondtv-acme; }
    location / { return 404; }   # nothing served over plain HTTP except ACME
}
```

Run: `ssh root@72.62.241.93 "nginx -t && systemctl reload nginx"`
Expected: `nginx: configuration file ... test is successful` then reload, no errors.

## Task 10: TLS — expand the Let's Encrypt cert to cover the upload host

- [ ] **Step 1: Expand the cert (webroot challenge)**

Run:
```bash
ssh root@72.62.241.93 "certbot certonly --webroot -w /var/www/davidbondtv-acme \
  -d davidbondtv.com -d www.davidbondtv.com -d upload.davidbondtv.com \
  --expand --non-interactive --agree-tos"
```
Expected: "Successfully received certificate" / the cert now lists `upload.davidbondtv.com`. Note the `fullchain.pem` / `privkey.pem` paths it prints (same lineage as the existing cert, e.g. `/etc/letsencrypt/live/davidbondtv.com/`).

- [ ] **Step 2: Verify the cert covers the host**

Run: `ssh root@72.62.241.93 "certbot certificates | grep -A2 davidbondtv.com"`
Expected: the Domains line includes `upload.davidbondtv.com`.

## Task 11: nginx — HTTPS (443) vhost for uploads with the big-body settings

- [ ] **Step 1: Add the HTTPS server block**

Edit `/etc/nginx/sites-available/davidbondtv`; add a 443 block for the upload host. Use the **same cert paths** the main davidbondtv 443 block uses (from Task 10). Key directives:

```nginx
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name upload.davidbondtv.com;

    ssl_certificate     /etc/letsencrypt/live/davidbondtv.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/davidbondtv.com/privkey.pem;

    # Large uploads: allow up to 25 GB (+headroom) and stream straight to the app.
    client_max_body_size 26g;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    location /.well-known/acme-challenge/ { root /var/www/davidbondtv-acme; }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
    }
}
```

(If the existing main vhost sets `client_max_body_size 2g` at the `http{}` or main-server level, the per-server `26g` here overrides it for this host. Leave the main site's value as-is.)

- [ ] **Step 2: Test + reload**

Run: `ssh root@72.62.241.93 "nginx -t && systemctl reload nginx"`
Expected: test successful, reload clean.

- [ ] **Step 3: Verify the upload host serves over HTTPS and is NOT proxied by Cloudflare**

Run: `curl -sI https://upload.davidbondtv.com/ | grep -iE "^(server|cf-ray|http)"`
Expected: a normal response (e.g. `Server: nginx`), and **no `CF-RAY` header** (confirms Cloudflare is bypassed).

## Task 12: systemd env — COOKIE_DOMAIN + UPLOAD_MAX_BYTES

- [ ] **Step 1: Write the drop-in and reload the unit**

Run:
```bash
ssh root@72.62.241.93 "mkdir -p /etc/systemd/system/davidbondtv.service.d && \
cat > /etc/systemd/system/davidbondtv.service.d/upload.conf <<'EOF'
[Service]
Environment=\"COOKIE_DOMAIN=davidbondtv.com\"
Environment=\"UPLOAD_MAX_BYTES=26843545600\"
EOF
systemctl daemon-reload"
```
(`26843545600` = 25 × 1024³ bytes. nginx's `26g` leaves headroom above this app cap.)

Expected: no output (success). Do **not** restart yet — Task 13 deploys the new code and restarts together.

## Task 13: Deploy code + restart

- [ ] **Step 1: Deploy (this also restarts the service, picking up the new env)**

Run: `bash scripts/deploy.sh`
Expected: backup printed, code shipped, `active`, `videos before=15 after=15`, `OK: library intact.`

- [ ] **Step 2: Confirm the live version + env took effect**

Run: `curl -s https://davidbondtv.com/membership.html | grep -oE "v1\.[0-9]+\.[0-9]+" | head -1`
Expected: `v1.15.0`

Run: `ssh root@72.62.241.93 "systemctl show davidbondtv -p Environment | tr ' ' '\n' | grep -E 'COOKIE_DOMAIN|UPLOAD_MAX_BYTES'"`
Expected: shows `COOKIE_DOMAIN=davidbondtv.com` and `UPLOAD_MAX_BYTES=26843545600`.

---

# PART C — Live verification

## Task 14: End-to-end checks

- [ ] **Step 1: Session shared across hosts (cookie domain)**

In a browser: log in on `https://davidbondtv.com`, then open `https://upload.davidbondtv.com/god-upload.html`.
Expected: the upload page loads **already authenticated** (no second login). If it bounces to login, the cookie domain didn't apply — re-check Task 12 + that you logged in *after* the deploy (old host-only cookies must be replaced; log out/in once).

- [ ] **Step 2: Large upload actually works (the whole point)**

Upload a **>100 MB** file (ideally a multi-GB one) via the upload page.
Expected: progress climbs past ~100 MB and completes (proves the Cloudflare cap is bypassed); the job moves to "Processing…" then "ready".

- [ ] **Step 3: Transcode + original cleanup (verify-only)**

Run: `ssh root@72.62.241.93 "ls -la /opt/davidbondtv/content/videos/<id>/ ; echo '--- originals (should be empty ~90s after processing) ---' ; ls -la /opt/davidbondtv/media/originals/"`
Expected: the video folder has `360p`/`720p` renditions; the original is gone from `media/originals` within ~90 s of processing completing. (Replace `<id>` with the new video's id from the manifest.)

- [ ] **Step 4: Honest failure feedback**

- Try a file **larger than 25 GB** (or temporarily a smaller `UPLOAD_MAX_BYTES`): the row immediately shows "Too large — … exceeds the … limit." and never uploads.
- Kill your network mid-upload: the row shows "Upload interrupted — check your connection…".

- [ ] **Step 5: Main site unaffected**

Run: `for p in / /membership.html /god-pricing.html; do printf "%-18s " "$p"; curl -s -o /dev/null -w "%{http_code}\n" "https://davidbondtv.com$p"; done`
Expected: all `200`, and the homepage still shows `Server: cloudflare` (main site still proxied/protected).

---

## Self-review checklist (run before handoff)

- [ ] **Spec coverage:** CF bypass (Tasks 8-11), 25 GB caps (Task 3 + nginx Task 11 + env Task 12), cookie sharing (Tasks 1-3 + env 12 + verify 14.1), rate-limit (Task 3), exposed limit + size pre-check + specific errors (Tasks 3-4), transcode/cleanup verify-only (Task 14.3), disk check (Task 7), version bump (Task 5).
- [ ] **No placeholders:** every code step has full code; every infra step has exact commands + expected output.
- [ ] **Name/interface consistency:** `cookieDomain` (accounts config) ↔ `COOKIE_DOMAIN` (env) ↔ `domain` (serializeCookie opt); `maxUploadBytes` (status JSON + client var) ↔ `UPLOAD_MAX_BYTES` (server/env); `uploadLimiter.hit(clientIp(req)).allowed` matches the rate-limiter API.
- [ ] **Dev safety:** `COOKIE_DOMAIN` unset on localhost → host-only cookies; upload-host handoff only triggers on the two prod main hosts; `UPLOAD_MAX_BYTES` default 25 GB.
