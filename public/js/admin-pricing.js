// Pricing management page (/god-pricing.html). Cookie-authenticated. Edits the
// membership pricing config (monthly recurring, optional intro first-month,
// yearly) — saved to data/pricing.json via /api/admin/pricing and live instantly
// across the site. Also shows a read-only list of course/product prices (edited
// on the Products page) so all pricing is visible in one place.
import { requireAdmin } from './god-auth.js';
import { ADMIN_PATHS } from './admin-paths.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let currency = 'usd';

const fmt = (cents, cur) => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: (cur || currency).toUpperCase(), minimumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100); }
  catch { return `$${(cents / 100).toFixed(2)}`; }
};
const toCents = (dollars) => { const n = parseFloat(dollars); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const toDollars = (cents) => (cents ? (cents / 100).toFixed(2).replace(/\.00$/, '') : '');

function currentCents() {
  return {
    monthly: toCents($('f-monthly').value),
    intro: toCents($('f-intro').value),
    yearly: toCents($('f-yearly').value),
    yearEnabled: $('f-year-enabled').checked,
  };
}

function refreshPreview() {
  const c = currentCents();
  currency = ($('f-currency').value || 'usd').toLowerCase();
  // Live "what customers see" line.
  let line;
  if (c.intro > 0) line = `<b>${fmt(c.intro)}</b> first month, then <b>${fmt(c.monthly)}</b>/mo`;
  else line = `<b>${fmt(c.monthly)}</b> / month`;
  if (c.yearEnabled && c.yearly > 0) line += ` · or <b>${fmt(c.yearly)}</b>/yr`;
  $('preview').innerHTML = `Customers see: ${line}`;
  // Yearly savings readout.
  const ro = $('year-readout');
  if (c.yearEnabled && c.yearly > 0 && c.monthly > 0 && c.yearly < c.monthly * 12) {
    ro.textContent = `Saves ${Math.round((1 - c.yearly / (c.monthly * 12)) * 100)}% vs paying monthly.`;
  } else ro.textContent = '';
}

async function loadConfig() {
  let cfg = null;
  try { cfg = (await (await fetch('/api/admin/pricing')).json()).config; } catch { /* defaults */ }
  if (!cfg) return;
  currency = cfg.currency || 'usd';
  $('f-monthly').value = toDollars(cfg.monthly.amount);
  $('f-intro').value = toDollars(cfg.monthly.introAmount);
  $('f-intro-label').value = cfg.monthly.introLabel || '';
  $('f-yearly').value = toDollars(cfg.yearly.amount);
  $('f-year-enabled').checked = !!cfg.yearly.enabled;
  $('f-currency').value = (cfg.currency || 'usd').toUpperCase();
  refreshPreview();
}

async function loadProducts() {
  let products = [];
  try { products = (await (await fetch('/api/admin/products')).json()).products || []; } catch { /* none */ }
  const wrap = $('prod-list');
  if (!products.length) { wrap.innerHTML = '<p class="muted">No products yet.</p>'; return; }
  wrap.innerHTML = products.map((p) => `
    <div class="pr-prodrow">
      <span>${esc(p.name)} <span class="muted">· ${esc(p.type)}${p.published ? '' : ' · draft'}</span></span>
      <span><b>${fmt(p.price, p.currency)}</b> &nbsp;<a class="back" href="${ADMIN_PATHS.products}">edit →</a></span>
    </div>`).join('');
}

async function save() {
  const c = currentCents();
  const msg = $('msg');
  msg.textContent = 'Saving…';
  const body = {
    currency: ($('f-currency').value || 'usd').toLowerCase(),
    monthly: { amount: c.monthly, introAmount: c.intro, introLabel: $('f-intro-label').value.trim() || 'First month' },
    yearly: { enabled: c.yearEnabled, amount: c.yearly },
  };
  const res = await fetch('/api/admin/pricing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.ok) { msg.textContent = 'Saved — live everywhere.'; setTimeout(() => { msg.textContent = ''; }, 2500); }
  else msg.textContent = data.error || 'Could not save.';
}

async function init() {
  await requireAdmin();
  ['f-monthly', 'f-intro', 'f-yearly', 'f-currency', 'f-year-enabled', 'f-intro-label'].forEach((id) => {
    $(id).addEventListener('input', refreshPreview);
  });
  $('save-btn').addEventListener('click', save);
  await Promise.all([loadConfig(), loadProducts()]);
}

init();
