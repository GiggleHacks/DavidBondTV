// Dependency-free chart + formatting helpers for the DataBond GigaBrain dashboard.
// Salvaged and generalised from the previous Control Deck (admin-analytics.js):
// pure SVG drawers and small formatters, with no chart library — the dashboard
// keeps the zero-dependency build. All drawers mutate the passed element's
// innerHTML; formatters are side-effect free.

export const nf = (n) => Number(n || 0).toLocaleString();
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Money in minor units (cents) → "$1,234.56" (or "1 234,56 EUR" for non-USD).
export function fmtMoney(cents, currency) {
  const v = (cents || 0) / 100;
  const cur = (currency || 'usd').toUpperCase();
  const body = v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cur === 'USD' ? `$${body}` : `${body} ${cur}`;
}

// Relative "time ago" from an epoch-ms timestamp.
export function fmtAgo(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Engagement seconds → compact duration ("0s", "45s", "2m 05s", "1h 03m").
export function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return `${m}m ${String(rs).padStart(2, '0')}s`;
  const h = Math.floor(m / 60), rm = m % 60;
  return `${h}h ${String(rm).padStart(2, '0')}m`;
}

// Delta chip: returns the className + label for a percentage change vs the prior
// period. `goodWhenDown` flips the colour (e.g. bounce rate, where lower is better).
export function deltaChip(pct, goodWhenDown = false) {
  if (pct == null || Number.isNaN(pct)) return { cls: 'flat', text: '—' };
  const up = pct >= 0;
  const good = goodWhenDown ? !up : up;
  const cls = pct === 0 ? 'flat' : good ? 'up' : 'down';
  return { cls, text: `${up ? '▲' : '▼'} ${Math.abs(pct)}%` };
}

// Minimal spark polyline (120×26 viewBox).
export function sparkline(svg, values, color) {
  if (!svg) return;
  const v = values && values.length ? values : [0, 0];
  const max = Math.max(...v, 1), min = Math.min(...v, 0);
  const span = max - min || 1;
  const step = 120 / Math.max(v.length - 1, 1);
  const pts = v.map((n, i) => `${(i * step).toFixed(1)},${(26 - ((n - min) / span) * 24).toFixed(1)}`).join(' ');
  svg.innerHTML = `<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}"/>`;
}

// Traffic-over-time: filled page-views area + dashed visitors line. `series` is
// GigaBrain's overview.series: [{ bucket, pageviews, visitors }].
export function drawTraffic(svg, series) {
  if (!svg) return;
  const W = 640, H = 200, pad = 6;
  const data = Array.isArray(series) ? series : [];
  if (!data.length) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" fill="#64748b" font-size="13" text-anchor="middle" font-family="monospace">awaiting data…</text>`; return; }
  const xs = (i) => pad + (i * (W - pad * 2)) / Math.max(data.length - 1, 1);
  const maxAll = Math.max(1, ...data.flatMap((d) => [d.pageviews || 0, d.visitors || 0]));
  const ys = (n) => H - pad - (n / maxAll) * (H - pad * 2);
  const line = (key, color, dash, fill) => {
    const pts = data.map((d, i) => `${xs(i).toFixed(1)},${ys(d[key] || 0).toFixed(1)}`).join(' ');
    let out = '';
    if (fill) out += `<polygon points="${pad},${H - pad} ${pts} ${W - pad},${H - pad}" fill="${color}" opacity="0.08"/>`;
    out += `<polyline fill="none" stroke="${color}" stroke-width="2" ${dash ? 'stroke-dasharray="5 4"' : ''} points="${pts}"/>`;
    return out;
  };
  let grid = '';
  for (let i = 1; i < 4; i++) grid += `<line x1="0" y1="${(H / 4) * i}" x2="${W}" y2="${(H / 4) * i}" stroke="#1e2030" stroke-width="0.5"/>`;
  svg.innerHTML = grid
    + line('pageviews', '#38bdf8', false, true)
    + line('visitors', '#fbbf24', true, false)
    + `<g font-family="monospace" font-size="10" fill="#94a3b8">
      <circle cx="20" cy="18" r="4" fill="#38bdf8"/><text x="30" y="22">Page views</text>
      <circle cx="118" cy="18" r="4" fill="#fbbf24"/><text x="128" y="22">Visitors</text>
    </g>`;
}

const DONUT_COLORS = ['#818cf8', '#22d3ee', '#f59e0b', '#a78bfa', '#34d399', '#fb7185', '#60a5fa'];

// Generic donut. `slices` = [{ label, value }]; top 5 + "others". `centerLabel`
// is the small caption under the total. Renders into svg + optional legend el.
export function drawDonut(svg, legendEl, slices, centerLabel = '') {
  if (!svg) return;
  const entries = (slices || []).map((s) => [s.label, Number(s.value) || 0]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { svg.innerHTML = `<text x="110" y="80" fill="#64748b" font-size="13" text-anchor="middle" font-family="monospace">no data yet</text>`; if (legendEl) legendEl.innerHTML = ''; return; }
  const top = entries.slice(0, 5);
  const otherN = entries.slice(5).reduce((a, [, n]) => a + n, 0);
  const list = top.slice();
  if (otherN > 0) list.push(['others', otherN]);
  const total = list.reduce((a, [, n]) => a + n, 0) || 1;
  const cx = 110, cy = 78, r = 58, rin = 36;
  let a0 = -Math.PI / 2, paths = '';
  list.forEach(([, n], i) => {
    const a1 = a0 + (n / total) * Math.PI * 2;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const xi1 = cx + rin * Math.cos(a1), yi1 = cy + rin * Math.sin(a1);
    const xi0 = cx + rin * Math.cos(a0), yi0 = cy + rin * Math.sin(a0);
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    paths += `<path d="M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} L${xi1.toFixed(1)},${yi1.toFixed(1)} A${rin},${rin} 0 ${large} 0 ${xi0.toFixed(1)},${yi0.toFixed(1)} Z" fill="${DONUT_COLORS[i % DONUT_COLORS.length]}" stroke="#0e0f14" stroke-width="1.5"/>`;
    a0 = a1;
  });
  svg.innerHTML = paths + `<text x="${cx}" y="${cy - 2}" fill="#e2e8f0" font-size="18" text-anchor="middle" font-family="monospace">${nf(total)}</text><text x="${cx}" y="${cy + 12}" fill="#64748b" font-size="9" text-anchor="middle" font-family="monospace">${esc(centerLabel || '')}</text>`;
  if (legendEl) {
    legendEl.innerHTML = list.map(([label, n], i) => {
      const pct = Math.round((n / total) * 100);
      return `<span><i style="background:${DONUT_COLORS[i % DONUT_COLORS.length]}"></i>${esc(label)} ${pct}%</span>`;
    }).join('');
  }
}

// Horizontal bar list (reuses .dbars markup). `items` = [{ label, value, sub? }].
// `opts.accent` overrides the fill; `opts.fmt` formats the value column.
export function barList(el, items, opts = {}) {
  if (!el) return;
  const list = Array.isArray(items) ? items.filter((i) => Number(i.value) > 0) : [];
  if (!list.length) { el.innerHTML = `<p class="muted">${esc(opts.empty || 'No data yet.')}</p>`; return; }
  const max = Math.max(1, ...list.map((i) => Number(i.value) || 0));
  const fmt = opts.fmt || nf;
  el.innerHTML = list.map((i) => {
    const pct = Math.max(3, Math.round((Number(i.value) || 0) / max * 100));
    const sub = i.sub ? `<span class="bl-sub">${esc(i.sub)}</span>` : '';
    const style = `width:${pct}%${opts.accent ? `;background:${opts.accent}` : ''}`;
    return `<div class="b"><div><div class="lab">${esc(i.label)}${sub}</div><div class="track"><div class="fill" style="${style}"></div></div></div><div class="n">${esc(fmt(i.value))}</div></div>`;
  }).join('');
}
