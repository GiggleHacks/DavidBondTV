# Admin Visual Upgrade — A: Date Filters · B: Visual Monitoring · C: Users Redesign

**Date:** 2026-06-24 · **Status:** Approved (user said "go, I approve everything")

The three low-risk, zero-dependency "quick wins" from the dashboard overhaul.
Projects D (Logs) and E (3D globe) come later and need a data-capture foundation
(city geo + device/UA/session) that does NOT exist yet — out of scope here.

## A — Dashboard date filters (24h / 7d / 30d / 90d / custom)

Server `/api/admin/analytics/overview` ([server.mjs:1147](../../../server.mjs)) gains
`?range=24h|7d|30d|90d|custom&from=YYYY-MM-DD&to=YYYY-MM-DD`.
- **Day ranges (7/30/90d, custom):** window the cross-video `byDay` map to the
  range; `totals` = sum of windowed series; `topVideos` = sum each video's `byDay`
  within window; `blocked` windowed from `blocked.byDay`.
- **24h:** hourly series from `getRecentEvents()` filtered to `t >= now-24h`,
  bucketed by hour; totals summed from those events.
- **Countries/map:** stays all-time (no per-day country rollup exists) — label it
  "all-time" in the UI. Windowing the map is project E.
- Client ([public/js/admin-analytics.js](../../../public/js/admin-analytics.js),
  [public/god.html](../../../public/god.html)): segmented control
  `[24h][7d][30d][90d][Custom]` + two date inputs for custom; default 30d; refetch
  overview on change; trend chart x-axis adapts (hours for 24h, days otherwise).

## B — Visual server monitoring (rings + live graphs)

Data already exists in `getSystemMetrics()` ([lib/ingest.mjs:108](../../../lib/ingest.mjs))
— CPU load, memory, disk, real filesystem capacity (statfs). No server changes.
- **Client rolling buffer:** poll `/api/admin/metrics` ~every 3s, keep last ~40
  samples of CPU (`load[0]/cores`) and memory (`used/total`); render animated
  SVG area/line graphs (zero-dep, same hand-rolled SVG style as admin-map.js).
- **Storage donut/ring:** content+media vs total capacity (`storage.pctUsed`,
  used/total GB).
- **CPU + memory utilization rings** (current %) beside their live graphs.
- Emphasis on visual status (color thresholds: green/amber/red) over raw numbers;
  raw numbers available but secondary. Lives in the dashboard monitoring panel
  (reuse/extend dashboard-layouts.js ring gauges).

## C — Users redesign + IP lookup

[public/god-users.html](../../../public/god-users.html) +
[public/js/admin-users.js](../../../public/js/admin-users.js). Reuse the admin
design system (badges `.vb-*`/`.badge`, `.card`, `.kv`, `.stat-grid`, `.tone-*`,
`icon()`), section accent teal `#2dd4bf`.
- **List:** cleaner rows with avatar (initial chip), username + email stacked,
  country flag, status badges (Member / Free / Blocked / Admin), watched stat;
  better hierarchy + readability; keep verified/unverified/all tabs + search.
- **Detail:** header card (avatar, name, status badges, quick actions row),
  organized sections — Identity, Activity (stat cards + viewing history),
  Security (password/recovery/sessions), Billing (membership + Resync), Danger
  (block/delete). 
- **IP lookup:** each IP gets a quick-action — a small lookup button opening
  `https://ipinfo.io/<ip>` in a new tab + a copy button. Applies to the detail
  IP list and the list-view lastIp.

## Verification
- `npm test` green (no test regressions; add tests for the overview range
  windowing helper if extracted to a pure function).
- Manual: pick each range, confirm KPIs/chart change; watch monitoring graphs
  animate; Users list/detail render with badges + working IP lookup.
- On full completion: `node scripts/notify.mjs "✅ …"` (per David's standing ask).
