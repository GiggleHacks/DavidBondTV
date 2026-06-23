import { requireAdmin } from './god-auth.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let coupons = [];

function fmtDate(ms) {
  if (!ms) return 'No expiry';
  try { return new Date(ms).toLocaleString(); } catch { return 'Invalid date'; }
}

function state(c) {
  if (!c.active) return 'disabled';
  if (c.expiresAt && c.expiresAt <= Date.now()) return 'expired';
  return 'active';
}

function stateBadge(c) {
  const s = state(c);
  return `<span class="badge ${s === 'active' ? 'sub' : s === 'expired' ? 'blk' : 'none'}">${s}</span>`;
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (res.status === 401) { location.reload(); return null; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

async function load() {
  const data = await api('/api/admin/coupons');
  coupons = data?.coupons || [];
  render();
}

function filtered() {
  const q = $('coupon-search').value.trim().toLowerCase();
  const st = $('coupon-state').value;
  return coupons.filter((c) => {
    if (st && state(c) !== st) return false;
    if (q && !`${c.code} ${c.label || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

async function showHistory(c, body) {
  const data = await api(`/api/admin/coupons/${encodeURIComponent(c.id)}/redemptions`);
  const rows = data.redemptions || [];
  body.innerHTML = rows.length ? rows.map((r) => `
    <div class="coupon-history-row">
      <span><b>${esc(r.userId || 'Unknown user')}</b><small>${esc(r.kind || '')}${r.productId ? ` · ${esc(r.productId)}` : ''}</small></span>
      <span>${fmtDate(r.ts)}</span>
    </div>`).join('') : '<p class="muted">No redemptions yet.</p>';
}

function row(c) {
  const el = document.createElement('div');
  el.className = 'coupon-row';
  const stats = c.stats || {};
  el.innerHTML = `
    <div class="coupon-main">
      <b>${esc(c.code)}</b>
      <span>${esc(c.label || `${c.percentOff}% off`)}</span>
    </div>
    <div>${stateBadge(c)}</div>
    <div class="coupon-stat"><b>${c.percentOff}%</b><span>discount</span></div>
    <div class="coupon-stat"><b>${stats.timesRedeemed || 0}</b><span>uses</span></div>
    <div class="coupon-meta">${fmtDate(c.expiresAt)}</div>
    <div class="coupon-actions">
      <button class="btn sm ghost coupon-history" type="button">History</button>
      <button class="btn sm ghost coupon-edit" type="button">Edit</button>
      <button class="btn sm danger coupon-delete" type="button">Delete</button>
    </div>
    <div class="coupon-history-panel" hidden></div>`;
  el.querySelector('.coupon-edit').addEventListener('click', () => openDialog(c));
  el.querySelector('.coupon-delete').addEventListener('click', async () => {
    if (!confirm(`Delete coupon ${c.code}? Redemption history remains in the ledger file.`)) return;
    await api(`/api/admin/coupons/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
    await load();
  });
  el.querySelector('.coupon-history').addEventListener('click', async () => {
    const panel = el.querySelector('.coupon-history-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) await showHistory(c, panel);
  });
  return el;
}

function render() {
  const wrap = $('coupon-list');
  const rows = filtered();
  wrap.replaceChildren(...rows.map(row));
  if (!rows.length) wrap.innerHTML = '<p class="muted">No coupons match this view.</p>';
}

function localToMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function msToLocal(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openDialog(c = null) {
  $('coupon-dialog-title').textContent = c ? `Edit ${c.code}` : 'New coupon';
  $('coupon-id').value = c?.id || '';
  $('coupon-code').value = c?.code || '';
  $('coupon-code').disabled = !!c;
  $('coupon-label').value = c?.label || '';
  $('coupon-percent').value = c?.percentOff || 20;
  $('coupon-duration').value = c?.duration || 'once';
  $('coupon-months').value = c?.durationInMonths || '';
  $('coupon-cap').value = c?.maxRedemptions || '';
  $('coupon-expires').value = msToLocal(c?.expiresAt);
  $('coupon-once').checked = !!c?.oncePerCustomer;
  $('coupon-active').checked = c ? !!c.active : true;
  $('coupon-msg').textContent = '';
  $('coupon-dialog').showModal();
}

async function save(e) {
  e.preventDefault();
  const id = $('coupon-id').value;
  const body = {
    label: $('coupon-label').value.trim(),
    percentOff: Number($('coupon-percent').value),
    duration: $('coupon-duration').value,
    durationInMonths: $('coupon-months').value ? Number($('coupon-months').value) : null,
    maxRedemptions: $('coupon-cap').value ? Number($('coupon-cap').value) : null,
    expiresAt: localToMs($('coupon-expires').value),
    oncePerCustomer: $('coupon-once').checked,
    active: $('coupon-active').checked,
  };
  if (!id) body.code = $('coupon-code').value.trim();
  try {
    await api(id ? `/api/admin/coupons/${encodeURIComponent(id)}` : '/api/admin/coupons', {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    $('coupon-dialog').close();
    await load();
  } catch (err) {
    $('coupon-msg').textContent = err.message || 'Could not save coupon.';
  }
}

async function main() {
  await requireAdmin();
  $('new-coupon').addEventListener('click', () => openDialog());
  $('coupon-search').addEventListener('input', render);
  $('coupon-state').addEventListener('change', render);
  $('coupon-form').addEventListener('submit', save);
  await load();
}

main();
