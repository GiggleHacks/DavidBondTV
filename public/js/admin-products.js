// Manage Products page (/god-products.html). Cookie-authenticated. Lists every
// product (courses/bundles/digital), and a full editor: name, slug, type, price
// (dynamic — dollars → cents), branding colors + logo/bg uploads, sales copy,
// per-video assignment, and publish toggle. Mirrors the admin-videos.js style
// (requireAdmin gate + plain JSON fetches; raw image body for asset uploads).
import { requireAdmin } from './god-auth.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (cents, cur) => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: (cur || 'usd').toUpperCase(), minimumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100); }
  catch { return `$${(cents / 100).toFixed(2)}`; }
};

let products = [];
let videos = [];
let editingId = null; // null = creating a new product

async function load() {
  try { products = (await (await fetch('/api/admin/products')).json()).products || []; } catch { products = []; }
  try { videos = ((await (await fetch(`/api/admin/videos?_=${Date.now()}`)).json()).videos || []).filter((v) => (v.status || 'ready') === 'ready'); } catch { videos = []; }
  renderList();
}

function renderList() {
  $('pcount').textContent = `(${products.length})`;
  const wrap = $('prod-list');
  if (!products.length) { wrap.innerHTML = '<p class="muted">No products yet. Create your first course.</p>'; return; }
  wrap.replaceChildren(...products.map((p) => {
    const row = document.createElement('div');
    row.className = 'prod-row';
    const logo = p.branding && p.branding.logo;
    row.innerHTML = `
      ${logo ? `<img class="pr-logo" src="${esc(logo)}" alt="" />` : '<div class="pr-logo"></div>'}
      <div class="pr-main">
        <div class="pr-name">${esc(p.name)} <span class="pr-tag ${p.published ? 'live' : 'draft'}">${p.published ? 'Published' : 'Draft'}</span></div>
        <div class="pr-sub">${esc(p.type)} · ${fmt(p.price, p.currency)} · ${p.videoIds.length} video${p.videoIds.length === 1 ? '' : 's'} · /course.html?slug=${esc(p.slug)}</div>
      </div>
      <button class="btn sm" data-edit="${esc(p.id)}">Edit</button>`;
    row.querySelector('[data-edit]').addEventListener('click', () => openEditor(p.id));
    return row;
  }));
}

function syncColor(colorId, hexId) {
  const c = $(colorId); const h = $(hexId);
  c.addEventListener('input', () => { h.value = c.value; });
  h.addEventListener('input', () => { if (/^#[0-9a-fA-F]{3,8}$/.test(h.value)) c.value = h.value; });
}

function renderVideoPicker(selectedIds) {
  const sel = new Set(selectedIds || []);
  const wrap = $('f-videos');
  wrap.replaceChildren(...videos.map((v) => {
    const r = document.createElement('label');
    r.className = 'pe-vrow';
    r.innerHTML = `<input type="checkbox" value="${esc(v.id)}" ${sel.has(v.id) ? 'checked' : ''} />
      ${v.thumb ? `<img src="${esc(v.thumb)}" alt="" />` : '<span style="width:54px"></span>'}
      <span>${esc(v.title || v.id)}</span>`;
    r.querySelector('input').addEventListener('change', updateVselCount);
    return r;
  }));
  updateVselCount();
}

function selectedVideoIds() {
  return [...$('f-videos').querySelectorAll('input:checked')].map((c) => c.value);
}
function updateVselCount() { $('vsel-count').textContent = `(${selectedVideoIds().length} selected)`; }

function openEditor(id) {
  editingId = id;
  const p = id ? products.find((x) => x.id === id) : null;
  $('editor-title').textContent = p ? `Edit: ${p.name}` : 'New product';
  $('f-name').value = p ? p.name : '';
  $('f-slug').value = p ? p.slug : '';
  $('f-type').value = p ? p.type : 'course';
  $('f-price').value = p ? (p.price / 100).toFixed(2).replace(/\.00$/, '') : '';
  $('f-description').value = p ? p.description : '';
  const br = (p && p.branding) || { primary: '#7c3aed', accent: '#22d3ee', logo: null, bgImage: null };
  $('f-primary').value = br.primary || '#7c3aed'; $('f-primary-hex').value = br.primary || '#7c3aed';
  $('f-accent').value = br.accent || '#22d3ee'; $('f-accent-hex').value = br.accent || '#22d3ee';
  const sales = (p && p.sales) || {};
  $('f-headline').value = sales.headline || '';
  $('f-body').value = sales.body || '';
  $('f-bullets').value = (sales.bullets || []).join('\n');
  $('f-cta').value = sales.ctaLabel || '';
  $('f-published').checked = !!(p && p.published);
  const showLogo = (el, url) => { if (url) { el.src = url; el.hidden = false; } else el.hidden = true; };
  showLogo($('logo-prev'), br.logo); showLogo($('bg-prev'), br.bgImage);
  $('f-logo').value = ''; $('f-bg').value = '';
  $('delete-btn').hidden = !p;
  renderVideoPicker(p ? p.videoIds : []);
  $('editor-msg').textContent = '';
  $('list-card').hidden = true;
  $('editor-card').hidden = false;
  window.scrollTo(0, 0);
}

function closeEditor() {
  $('editor-card').hidden = true;
  $('list-card').hidden = false;
}

function gatherBase() {
  const dollars = parseFloat($('f-price').value);
  const price = Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
  const bullets = $('f-bullets').value.split('\n').map((s) => s.trim()).filter(Boolean);
  return {
    name: $('f-name').value.trim(),
    slug: $('f-slug').value.trim(),
    type: $('f-type').value,
    description: $('f-description').value.trim(),
    price,
    currency: 'usd',
    branding: { primary: $('f-primary-hex').value.trim(), accent: $('f-accent-hex').value.trim() },
    sales: { headline: $('f-headline').value.trim(), body: $('f-body').value.trim(), bullets, ctaLabel: $('f-cta').value.trim() },
  };
}

async function postJSON(path, body, method = 'POST') {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function uploadAsset(id, kind, file) {
  const res = await fetch(`/api/admin/products/${encodeURIComponent(id)}/asset?kind=${kind}`, {
    method: 'POST', headers: { 'Content-Type': file.type }, body: file,
  });
  return res.ok;
}

async function save() {
  const msg = $('editor-msg');
  msg.textContent = 'Saving…';
  const base = gatherBase();
  if (!base.name) { msg.textContent = 'Name is required.'; return; }

  let id = editingId;
  // Create or update the core record.
  let r;
  if (id) r = await postJSON(`/api/admin/products/${encodeURIComponent(id)}`, { ...base, published: $('f-published').checked, videoIds: selectedVideoIds() });
  else r = await postJSON('/api/admin/products', base);
  if (!r.ok || !r.data.product) { msg.textContent = r.data.error || 'Could not save.'; return; }
  id = r.data.product.id;

  // For a freshly-created product, add/publish set videos + published in a follow-up.
  if (!editingId) {
    await postJSON(`/api/admin/products/${encodeURIComponent(id)}/videos`, { videoIds: selectedVideoIds() });
    if ($('f-published').checked) await postJSON(`/api/admin/products/${encodeURIComponent(id)}/publish`, { published: true });
  }

  // Upload any chosen assets (after the record exists so setBranding has a target).
  const logoFile = $('f-logo').files[0];
  const bgFile = $('f-bg').files[0];
  if (logoFile) await uploadAsset(id, 'logo', logoFile);
  if (bgFile) await uploadAsset(id, 'bg', bgFile);

  await load();
  closeEditor();
}

async function del() {
  if (!editingId) return;
  if (!confirm('Delete this product? Buyers keep their purchase record, but the product disappears from the site.')) return;
  const res = await fetch(`/api/admin/products/${encodeURIComponent(editingId)}`, { method: 'DELETE' });
  if (res.ok) { await load(); closeEditor(); } else $('editor-msg').textContent = 'Could not delete.';
}

async function init() {
  await requireAdmin();
  syncColor('f-primary', 'f-primary-hex');
  syncColor('f-accent', 'f-accent-hex');
  $('new-btn').addEventListener('click', () => openEditor(null));
  $('cancel-btn').addEventListener('click', closeEditor);
  $('save-btn').addEventListener('click', save);
  $('delete-btn').addEventListener('click', del);
  // Auto-suggest a slug from the name while creating.
  $('f-name').addEventListener('input', () => {
    if (editingId) return;
    $('f-slug').value = $('f-name').value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  });
  await load();
}

init();
