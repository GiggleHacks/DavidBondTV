# Large video uploads — design spec

**Date:** 2026-06-22
**Goal:** Let the admin upload large videos (up to 25 GB) reliably, and make the uploader always tell the user *why* something failed. The transcode pipeline already compresses aggressively to 720p/360p and deletes the original, so this work is about getting the bytes in past the gateways and surfacing clear feedback — not about storage or transcoding.

## Background — why large uploads currently get stuck

The uploader (`public/js/admin.js` → `startUpload`) sends the **entire file as one raw POST** to `/api/admin/upload` (same-origin), streamed to disk server-side (`server.mjs` `streamUpload`). That single request must pass three size ceilings:

| Layer | Limit | Source |
|---|---|---|
| Cloudflare proxy (Free/Pro) | **100 MB** per request | Confirmed live (`Server: cloudflare`, `CF-RAY`) |
| nginx | `client_max_body_size 2g` | deploy notes |
| App | `UPLOAD_MAX_BYTES = 2 GB` | `server.mjs:90` (aborts 413 "File too large") |

The binding ceiling is **Cloudflare's 100 MB**: a 5 GB upload dies at ~100 MB (~2% of the bar). The client's only failure handler is a generic `xhr.onerror` → "Network error during upload" (`admin.js:195`), and there is **no proactive size check**, so the user gets a vague/no explanation.

### Already in place (no change needed)
- **Aggressive transcode:** `LIVE_VARIANTS=360p,720p` (`lib/ingest.mjs:24`) → encodes only 720p + 360p (libx264, ~2.8 Mbps / ~0.8 Mbps); never stores anything above 720p.
- **Original cleanup:** `KEEP_ORIGINALS=0` default → original `unlink`ed `ORIGINAL_RETENTION_MS=90000` (90s) after processing, with a boot-sweep fallback (`sweepOrphanOriginals`).

## Decisions (locked with owner)
- **Approach:** dedicated grey-cloud upload subdomain to bypass Cloudflare (not chunked/resumable — that remains a possible future upgrade).
- **Max upload size:** **25 GB**.
- **Lockdown:** existing admin-auth + add rate-limiting. Accept origin-IP exposure for the upload host (documented).
- **No silent failures:** proactive client size pre-check + specific, plain-language error messages.

## Architecture

`upload.davidbondtv.com` is a **DNS-only (grey-cloud)** A record → origin `72.62.241.93`. It is served by the **same nginx + same Node app** as the main site; the only difference is it skips Cloudflare's proxy and its 100 MB cap. The admin opens the upload page **on that host**, so the file POST is **same-origin to the upload host** → no CORS, no preflight, no cross-origin credential handling.

Auth across both hosts is made to work by widening the session cookie to `Domain=davidbondtv.com` (covers all subdomains), so a single login on the main site also authenticates the upload host.

## Part 1 — Bypass Cloudflare (code)

### `lib/cookies.js`
- Add a `domain` option to `serializeCookie`: when `opts.domain` is set, append `Domain=<value>`. (Currently supports maxAge/path/httpOnly/sameSite/secure/expires only.)

### `server.mjs`
- New env `COOKIE_DOMAIN` (e.g. `davidbondtv.com`). When set, every auth/session `Set-Cookie` passes `domain: COOKIE_DOMAIN`. Unset in dev → host-only cookies, so localhost is unaffected.
- `UPLOAD_MAX_BYTES`: make it env-configurable, default **25 GB** (`Number(process.env.UPLOAD_MAX_BYTES) || 25*1024**3`). Used by `streamUpload`'s existing over-limit check (already returns `413 {error:'File too large.'}`).
- Rate-limit the upload endpoint using the existing `lib/rate-limit.js` (`createRateLimiter`) — a modest cap (e.g. N starts/min/IP) returning a clear `429 {error}`.
- SameSite stays `Lax`: `upload.davidbondtv.com` and `davidbondtv.com` are the same registrable site, so Lax cookies are sent on the same-site upload page. No `SameSite=None` needed.

### `public/js/admin.js` / `public/god-upload.html`
- Determine the upload base URL: if `location.hostname === 'davidbondtv.com'` (or a configured main host), the page is the *entry point* and should hand off to the upload host — i.e. the main-site "Upload" nav links to `https://upload.davidbondtv.com/god-upload.html`. On the upload host (or localhost), uploads POST same-origin as today. Net effect: the big POST is always same-origin to whatever host the page is on; the main site just links across.
- No `withCredentials`/CORS code paths are introduced.

## Part 2 — Transcode/cleanup
No code changes. Spec-level requirements to **verify** at rollout:
- Prod env keeps `KEEP_ORIGINALS` unset/`0` and `LIVE_VARIANTS=360p,720p`.
- Disk-peak awareness: a 25 GB original lives on disk during upload + transcode + 90 s. The client allows **3 concurrent uploads** (`MAX_CONCURRENT=3`), so transient peak ≈ 3×25 GB + renditions. **Verify prod free disk** before enabling; optionally reduce concurrency for very large files (see Open question).

## Part 3 — Never fail silently (code)

### Expose the limit
- Add `maxUploadBytes` to the existing `GET /api/admin/status` response (the upload page already fetches it for the ffmpeg banner). Client caches it on load.

### `public/js/admin.js`
- **Proactive size pre-check:** in `enqueueFiles`, before queuing, if `file.size > maxUploadBytes`, mark the row `failed` immediately with a specific message, e.g. `"'<name>' is <X> GB — over the <limit> GB upload limit."`, and do **not** start the upload.
- **Specific failure messages** in `startUpload`:
  - `xhr.onload` non-202: show `data.error` when present; else map status — `413` → "File too large (max 25 GB)", `415` → "Only .mp4/.mov/.m4v video files are accepted.", `429` → "Too many uploads — wait a moment and retry.", `401` → (existing reload), other → `Upload failed (<status>)`.
  - `xhr.onerror` / `xhr.upload.onerror` / `xhr.onabort` / `xhr.ontimeout`: "Upload interrupted — check your connection (or the file may be too large)." (Add the upload-level and abort/timeout handlers; today only `xhr.onerror` exists.)
- Failed rows already render with a red dot + title; keep that, ensure the message text is the human-readable string above.

### Principle
Apply "always tell the user why" to the whole upload flow. A broader audit of other silent-failure points across the site is **out of scope** here (noted as a possible follow-up).

## Prod infra (one-time; via SSH + Cloudflare, not in `scripts/deploy.sh`)
1. **DNS:** Cloudflare → add `upload` A record → `72.62.241.93`, **DNS-only (grey cloud)**. (Token can edit DNS.)
2. **nginx:** new `server` block for `upload.davidbondtv.com` → `proxy_pass http://127.0.0.1:3000`; `client_max_body_size 26g`; **`proxy_request_buffering off`** (stream body straight to the app, don't buffer 25 GB to disk first); raise `proxy_read_timeout`/`proxy_send_timeout` (e.g. 3600s) for long uploads; reuse the same TLS cert. Scope changes to the davidbondtv vhost only (shared box).
3. **TLS:** expand the Let's Encrypt cert to include `upload.davidbondtv.com` (same ACME webroot `/var/www/davidbondtv-acme`), e.g. `certbot --expand`.
4. **Env:** set `COOKIE_DOMAIN=davidbondtv.com` and (optionally) `UPLOAD_MAX_BYTES` via the systemd drop-in `env.conf`; `daemon-reload` + restart.

## Testing
- **Unit (vitest):**
  - `tests/cookies.test.js` — `serializeCookie` emits `Domain=` when `domain` set, omits it otherwise; existing attributes unchanged.
  - Upload-limit env parsing helper (extract a small pure function for `UPLOAD_MAX_BYTES` if it aids testing).
  - Rate-limiter wiring (reuse existing `rate-limit` tests pattern).
- **Live verification (after infra):**
  - Single login on main site → upload page on subdomain is authenticated (cookie shared).
  - Upload a >100 MB file end-to-end via the subdomain → succeeds (proves CF bypass).
  - Upload a multi-GB file → succeeds; confirm original deleted ~90 s post-processing; only 360p/720p remain.
  - Pre-check: try a file > 25 GB → immediate clear "over the limit" message, no upload attempt.
  - Kill network mid-upload → clear "interrupted" message.
  - Main site + rest of admin still work through Cloudflare.

## Security / risks
- Origin IP exposed for `upload.davidbondtv.com` only (no Cloudflare shield on that host). Mitigated by admin-auth + rate-limit; endpoint is admin-only. Documented tradeoff.
- Cookie-domain change re-issues cookies → everyone is logged out once. Minor, one-time.
- Single-shot upload: a network blip restarts from zero (no resume). Acceptable for now; chunked/resumable is the future upgrade.

## Open question (resolve in plan or rollout)
- Concurrency for very large files: keep `MAX_CONCURRENT=3`, or drop to 1 when any queued file is above a threshold (e.g. >2 GB) to bound disk peak? Default: keep 3, document the disk requirement; revisit if disk pressure appears.

## Versioning
Bump `package.json` version `1.14.1` → `1.15.0` (new user-facing capability).
