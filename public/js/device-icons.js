// Inline SVG glyphs for operating systems and browsers, plus device types.
// Self-hosted and dependency-free so they render identically on Windows,
// Android, macOS and everywhere else (unlike vendor emoji/webfonts). Each
// helper returns a small <svg> string sized to the current font (1em) and
// tinted with the vendor's brand colour so the dashboard reads at a glance.
//
// Usage: osIcon('Windows'), browserIcon('Chrome'), deviceIcon('mobile').
// Unknown / missing names fall back to a neutral chip so the UI never breaks.

const wrap = (inner, label) =>
  `<svg class="dvi" viewBox="0 0 16 16" width="1em" height="1em" role="img" aria-label="${label}" focusable="false" style="vertical-align:-0.14em">${inner}</svg>`;

// ---- operating systems ----
const OS = {
  windows: ['#38bdf8', '<path fill="#38bdf8" d="M1.4 3.3 7 2.5v5H1.4zM7.7 2.4 14.6 1.4v6.1H7.7zM1.4 8.2H7v5L1.4 12.4zM7.7 8.2h6.9v6.4L7.7 13.6z"/>'],
  macos: ['#e5e7eb', '<path fill="#e5e7eb" d="M11 8.5c0-1.6 1.3-2.4 1.4-2.5-.8-1.1-1.9-1.3-2.4-1.3-1-.1-2 .6-2.5.6s-1.3-.6-2.1-.6C2.9 5.3 1.7 6.4 1.7 8.7c0 1 .4 2 .9 2.8.5.7 1 1.5 1.8 1.4.7 0 1-.4 1.9-.4s1.1.4 1.9.4 1.3-.7 1.8-1.4c.5-.8.7-1.5.7-1.5-.1 0-1.4-.6-1.4-2zM9.4 3.7c.4-.5.7-1.2.6-1.9-.6 0-1.3.4-1.7.9-.4.5-.7 1.1-.6 1.8.6 0 1.3-.3 1.7-.8z"/>'],
  ios: ['#e5e7eb', '<path fill="#e5e7eb" d="M11 8.5c0-1.6 1.3-2.4 1.4-2.5-.8-1.1-1.9-1.3-2.4-1.3-1-.1-2 .6-2.5.6s-1.3-.6-2.1-.6C2.9 5.3 1.7 6.4 1.7 8.7c0 1 .4 2 .9 2.8.5.7 1 1.5 1.8 1.4.7 0 1-.4 1.9-.4s1.1.4 1.9.4 1.3-.7 1.8-1.4c.5-.8.7-1.5.7-1.5-.1 0-1.4-.6-1.4-2zM9.4 3.7c.4-.5.7-1.2.6-1.9-.6 0-1.3.4-1.7.9-.4.5-.7 1.1-.6 1.8.6 0 1.3-.3 1.7-.8z"/>'],
  android: ['#3ddc84', '<g fill="#3ddc84"><path d="M4.2 6.7a.8.8 0 0 1 .8.8v3.1a.8.8 0 0 1-1.6 0V7.5a.8.8 0 0 1 .8-.8zm7.6 0a.8.8 0 0 1 .8.8v3.1a.8.8 0 0 1-1.6 0V7.5a.8.8 0 0 1 .8-.8zM5.3 6.6C5.3 5 6.5 3.9 8 3.9s2.7 1.1 2.7 2.7zM5.3 7h5.4v4.3a.7.7 0 0 1-.7.7H9.4v1.3a.8.8 0 0 1-1.6 0V12H6.7v1.3a.8.8 0 0 1-1.4 0V7z"/><circle cx="6.6" cy="5.4" r=".4" fill="#0b0e13"/><circle cx="9.4" cy="5.4" r=".4" fill="#0b0e13"/></g>'],
  linux: ['#fbbf24', '<path fill="#fbbf24" d="M8 1.8c-1.7 0-2.4 1.6-2.3 3 0 .9-.1 1.4-.6 2.2-.5.8-1.4 1.7-1.4 3 0 .5.2.8.5 1 .2-.9.9-1.7 1-1.9.4-.6.5-1.2.5-1.2s.2 1 .9 1.7c.6.6 1.9.6 2.7 0 .7-.7.9-1.7.9-1.7s.1.6.5 1.2c.1.2.8 1 1 1.9.3-.2.5-.5.5-1 0-1.3-.9-2.2-1.4-3-.5-.8-.6-1.3-.6-2.2.1-1.4-.6-3-2.3-3z"/><circle cx="6.9" cy="4.7" r=".5" fill="#0b0e13"/><circle cx="9.1" cy="4.7" r=".5" fill="#0b0e13"/><path fill="#f59e0b" d="M7 6.1c.3.3.7.3 1 0z"/>'],
  chromeos: ['#22d3ee', '<circle cx="8" cy="8" r="5.4" fill="none" stroke="#22d3ee" stroke-width="1.6"/><circle cx="8" cy="8" r="2.1" fill="#38bdf8"/>'],
};

// ---- browsers ----
const BR = {
  chrome: ['<circle cx="8" cy="8" r="6" fill="#e2e8f0"/><path fill="#ea4335" d="M8 2a6 6 0 0 1 5.2 3H8a3 3 0 0 0-2.6 1.5L3.1 3.6A6 6 0 0 1 8 2z"/><path fill="#34a853" d="M2.8 4 5.4 8.6A3 3 0 0 0 8 11l-1.4 2.9A6 6 0 0 1 2.8 4z"/><path fill="#fbbc05" d="M13.4 5A6 6 0 0 1 8 14l2.6-4.5A3 3 0 0 0 11 6z"/><circle cx="8" cy="8" r="2.6" fill="#4285f4"/>'],
  firefox: ['<circle cx="8" cy="8" r="6" fill="#ff7139"/><path fill="#ffce44" d="M12 4.5c.6 1 .3 2.3-.5 3 .7.2 1.3 1 1.3 1.9 0 2.5-2.1 4.1-4.6 4.1A5 5 0 0 1 3.5 6c.4 1 1.4 1.7 2.5 1.6C4.6 6.3 5.4 4 7.4 3.7c-.5.5-.6 1.3-.1 1.9.6-1 1.9-1.6 3-1.4-.5.1-.9.5-.9 1 1 .1 1.9-.3 2.6-.7z"/>'],
  safari: ['<circle cx="8" cy="8" r="6" fill="#1aa3ff"/><circle cx="8" cy="8" r="6" fill="none" stroke="#e2e8f0" stroke-width=".6"/><path fill="#ff4b4b" d="M8 8 10.6 5.4 9 8z"/><path fill="#e2e8f0" d="M8 8 5.4 10.6 7 8z"/>'],
  edge: ['<path fill="#22d3ee" d="M13.6 9.4c0 2.2-2.4 3.6-4.8 3.6-3 0-5.4-2-5.4-4.8 0-1.6.9-2.9 1.9-3.6-.2 1 .3 2.2 1.7 2.6z"/><path fill="#38bdf8" d="M13.9 8.3C13.9 5 11.2 3 8.2 3 5.7 3 4 4.4 3.3 6.1c1-1 2.4-1.4 3.8-1.2 2.3.4 3.4 2 3.6 3.4z"/>'],
  opera: ['<ellipse cx="8" cy="8" rx="6" ry="6" fill="#ff1b2d"/><ellipse cx="8" cy="8" rx="2.6" ry="4" fill="#e2e8f0"/>'],
  samsung: ['<circle cx="8" cy="8" r="6" fill="#1f6fff"/><path fill="#e2e8f0" d="M4.5 9.2c0 1 .9 1.5 2 1.5 1.4 0 2.2-.7 2.2-1.7 0-2-3.4-1.4-3.4-2.4 0-.4.4-.6.9-.6.6 0 1 .3 1 .8h1.4c0-1-.9-1.7-2.3-1.7-1.3 0-2.3.6-2.3 1.7 0 2 3.4 1.3 3.4 2.4 0 .4-.4.6-1 .6s-1-.3-1-.9z"/>'],
  brave: ['<path fill="#fb542b" d="M8 1.6 12.6 3l.9 2.4-.5.9.7 1.7-3 4.3L8 14.4l-2.7-2.1-3-4.3.7-1.7-.5-.9L3.4 3z"/><path fill="#fff" d="M8 5.2 9.6 7l-1.6 3.2L6.4 7z" opacity=".85"/>'],
};

const GENERIC_BROWSER = '<circle cx="8" cy="8" r="6" fill="none" stroke="#64748b" stroke-width="1.2"/><path fill="none" stroke="#64748b" stroke-width="1" d="M2.2 8h11.6M8 2.2c1.8 1.6 1.8 10.4 0 11.6M8 2.2C6.2 3.8 6.2 12.2 8 13.8"/>';
const GENERIC_OS = '<rect x="2.4" y="3.2" width="11.2" height="7.6" rx="1.2" fill="none" stroke="#64748b" stroke-width="1.2"/><path stroke="#64748b" stroke-width="1.2" d="M6 13h4"/>';

const norm = (s) => String(s || '').toLowerCase();

function pickOs(name) {
  const n = norm(name);
  if (/(iphone|ipad|ios)/.test(n)) return OS.ios;
  if (/(mac|os ?x|darwin)/.test(n)) return OS.macos;
  if (/win/.test(n)) return OS.windows;
  if (/android/.test(n)) return OS.android;
  if (/(chrome ?os|cros)/.test(n)) return OS.chromeos;
  if (/(linux|ubuntu|debian|fedora|arch)/.test(n)) return OS.linux;
  return null;
}
function pickBrowser(name) {
  const n = norm(name);
  if (/edge|edg/.test(n)) return BR.edge;
  if (/brave/.test(n)) return BR.brave;
  if (/samsung/.test(n)) return BR.samsung;
  if (/opera|opr/.test(n)) return BR.opera;
  if (/firefox|fxios|mozilla/.test(n)) return BR.firefox;
  if (/edg|chromium|chrome|crios/.test(n)) return BR.chrome; // after edge/brave/samsung/opera
  if (/safari/.test(n)) return BR.safari;
  return null;
}

/** OS name → inline SVG glyph (neutral fallback for unknowns). */
export function osIcon(name) {
  const hit = pickOs(name);
  return wrap(hit ? hit[1] : GENERIC_OS, name || 'OS');
}
/** Browser name → inline SVG glyph (neutral globe fallback). */
export function browserIcon(name) {
  const hit = pickBrowser(name);
  return wrap(hit ? hit[0] : GENERIC_BROWSER, name || 'Browser');
}
/** Device type (desktop/mobile/tablet/tv) → inline SVG glyph. */
export function deviceIcon(type) {
  const n = norm(type);
  if (/mobile|phone/.test(n)) return wrap('<rect x="4.5" y="1.8" width="7" height="12.4" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="12.2" r=".6" fill="currentColor"/>', 'mobile');
  if (/tablet/.test(n)) return wrap('<rect x="3" y="2.2" width="10" height="11.6" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="11.8" r=".6" fill="currentColor"/>', 'tablet');
  if (/tv|console/.test(n)) return wrap('<rect x="2" y="3" width="12" height="8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path stroke="currentColor" stroke-width="1.3" d="M6 13.4h4"/>', 'tv');
  return wrap('<rect x="1.8" y="3" width="12.4" height="7.6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path stroke="currentColor" stroke-width="1.3" d="M5.5 13.2h5M8 10.8v2.4"/>', 'desktop');
}

/** Label helper: "<icon> Name" with the icon coloured, for inline table cells. */
export function osLabel(name) { return name ? `${osIcon(name)} ${escapeText(name)}` : ''; }
export function browserLabel(name) { return name ? `${browserIcon(name)} ${escapeText(name)}` : ''; }

function escapeText(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
