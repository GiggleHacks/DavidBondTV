// Renders the multi-video homepage grid from the generated manifest, with a
// YouTube-style hover preview (a small baked montage that plays on hover),
// category chips (Recently Uploaded / All), a sidebar section filter
// (All Videos / Exclusive Videos / Courses) and a lock layer for non-entitled
// viewers (premium membership OR one-time course purchase).
import { canWatchVideo } from '/js/viewer-access.js';
import { startPurchase, fmtMoney } from '/js/course-buy.js';
import { categoryDisplayName, categoryVisualMarkup, resolveCategoryVisual } from '/js/category-visuals.js';
import { renderThumbProgress } from '/js/watch-progress.js';
const PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const LOCK = '<svg viewBox="0 0 24 24"><path d="M12 1a5 5 0 00-5 5v3H6a2 2 0 00-2 2v9a2 2 0 002 2h12a2 2 0 002-2v-9a2 2 0 00-2-2h-1V6a5 5 0 00-5-5zm3 8H9V6a3 3 0 016 0v3z"/></svg>';

// Only do video previews on devices with a real hovering pointer (skip touch).
const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

// One shared <video> element, reparented into whichever card is hovered.
let preview = null;
let hoverTimer = null;

// View state. sort: 'recent' (default) | 'all'. section: 'all' | 'exclusive' |
// 'courses'. category: '' (all) | <slug> — for 'courses' it's the course slug.
// `me` mirrors /api/auth/me so canWatchVideo() can decide course/premium access.
// videoCourseMap: videoId → [published productId, …]; products: published list.
const state = {
  videos: [], sort: 'recent', section: 'all', category: '',
  isAdmin: false, isMember: false, loggedIn: false,
  me: null, products: [], videoCourseMap: new Map(), views: {}, newWin: null,
};

/** "No views" / "1 view" / "1,234 views" — compact, human view-count label. */
function formatViews(n) {
  if (typeof n !== 'number' || n <= 0) return 'No views';
  return n === 1 ? '1 view' : `${n.toLocaleString()} views`;
}

function hydrateStateFromUrl() {
  const params = new URLSearchParams(location.search);
  const section = params.get('section') || '';
  state.section = section === 'exclusive' ? 'exclusive' : section === 'courses' ? 'courses' : 'all';
  state.category = params.get('category') || '';
  state.sort = ['recent', 'popular', 'oldest'].includes(params.get('sort'))
    ? params.get('sort') : 'recent';
}

/** Published product ids this video is assigned to (for the access gate). */
function courseIdsFor(id) { return state.videoCourseMap.get(id) || []; }

/** The product whose branded gate/modal should represent a locked course video. */
function courseForVideo(id) {
  const ids = courseIdsFor(id);
  return ids.length ? (state.products.find((p) => p.id === ids[0]) || null) : null;
}

// Windowed rendering: only ~BATCH cards in the DOM up front; more append as the
// sentinel scrolls into view (YouTube-style infinite scroll, no DOM bloat).
const BATCH = 24;
let currentList = [];
let shown = 0;
let io = null;
let sentinel = null;

function ensurePreviewEl() {
  if (preview) return preview;
  preview = document.createElement('video');
  preview.className = 'vpreview';
  preview.muted = true;
  preview.loop = true;
  preview.playsInline = true;
  preview.preload = 'none';
  preview.setAttribute('disablepictureinpicture', '');
  preview.addEventListener('playing', () => preview.classList.add('show'));
  return preview;
}

function startPreview(cardEl) {
  const src = cardEl.dataset.preview;
  if (!src) return; // no baked preview → stay on the static thumbnail
  const v = ensurePreviewEl();
  cardEl.querySelector('.vthumb').appendChild(v);
  v.src = src;
  v.currentTime = 0;
  v.play().catch(() => {}); // swallow autoplay / rapid-hover AbortError
}

function stopPreview() {
  if (!preview) return;
  preview.classList.remove('show');
  preview.pause();
  preview.removeAttribute('src');
  preview.load(); // release the network/decoder
  preview.remove();
}

// Per-user "NEW" badge window, persisted in localStorage keyed per account (so
// different viewers / devices don't share state). A video is NEW to this viewer if
// it was published after their PREVIOUS visit, for up to 24h measured from whichever
// is later: their return, or the video's publish time. So a viewer away for a month
// comes back to everything-since-then flagged NEW for one day, then it clears —
// instead of every recent upload showing "NEW" to everyone forever.
const NEW_TTL = 24 * 60 * 60 * 1000;

function loadNewWindow(userKey) {
  const key = `dbtv_newwin_${userKey || 'guest'}`;
  const now = Date.now();
  let st = null;
  try { st = JSON.parse(localStorage.getItem(key) || 'null'); } catch { /* ignore */ }
  if (!st || typeof st.lastVisit !== 'number' || typeof st.windowStart !== 'number') {
    // First visit on this device/account: don't flag the whole existing library —
    // start the clock now so only genuinely-new uploads get badged from here on.
    st = { lastVisit: now, windowStart: now, baseline: now };
  } else if (now - st.windowStart >= NEW_TTL) {
    // The previous 24h window elapsed → open a fresh one whose baseline is the last
    // time the viewer was actually here (so everything from the gap counts as new).
    st = { lastVisit: now, windowStart: now, baseline: st.lastVisit };
  } else {
    // Still inside an active window → keep its baseline; just record this visit.
    st = { baseline: st.baseline, windowStart: st.windowStart, lastVisit: now };
  }
  try { localStorage.setItem(key, JSON.stringify(st)); } catch { /* ignore */ }
  return st;
}

const isNew = (v) => {
  const w = state.newWin;
  if (!w) return false;
  const ts = sortTs(v);
  if (!ts || ts <= w.baseline) return false;            // not published since last visit
  return Date.now() - Math.max(ts, w.windowStart) < NEW_TTL;
};

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Optional "flag + category name" meta row for a card, when the video's category
// has an admin-assigned country flag. Empty string when there's no flag.
function catVisualRow(v) {
  const cat = v.category && state.categoryMap ? state.categoryMap.get(v.category) : null;
  if (!cat || !resolveCategoryVisual(cat)) return '';
  return `<div class="vcatflag">${categoryVisualMarkup(cat, 'vcf-img')}<span>${escHtml(categoryDisplayName(cat))}</span></div>`;
}

function card(v) {
  const status = v.status || 'ready';
  // Access gate (mirrors the server): admin > course-ownership > premium-member >
  // free. A course-assigned video is locked unless owned (membership doesn't
  // count); a plain premium video is locked unless member/admin.
  const courseProds = courseIdsFor(v.id);
  const lockedByCourse = courseProds.length > 0 && !canWatchVideo(state.me, v, courseProds);
  const locked = !canWatchVideo(state.me, v, courseProds);
  // Per-video thumbnail blur level (admin-configured). Default medium for premium.
  const blur = ['strongest', 'strong', 'medium', 'off'].includes(v.blur) ? v.blur
    : (v.visibility === 'premium' ? 'medium' : 'off');
  // Premium cards always carry their blur level (even when unlocked) so the
  // header "eye" toggle can preview the exact blur a non-subscriber would see.
  const isPremium = v.visibility === 'premium';
  const a = document.createElement('a');
  a.className = `vcard${status !== 'ready' ? ` is-${status}` : ''}`
    + `${isPremium || locked ? ` blur-${blur}` : ''}`
    + `${isPremium ? ' is-premium' : ''}${locked ? ' is-locked' : ''}`;
  // Locked cards get NO real href, so middle-click / ctrl-click can't open the
  // watch page in a new tab and skip the lock; they act as a button instead.
  if (locked) { a.setAttribute('role', 'button'); a.tabIndex = 0; }
  else a.href = `/watch?v=${encodeURIComponent(v.id)}`; // open this video's watch page
  a.innerHTML = `
    <div class="vthumb"${v.thumb ? ` style="--thumb-bg:url('${v.thumb}')"` : ''}>
      ${v.thumb ? `<img loading="lazy" alt="" src="${v.thumb}" />` : '<div class="vthumb-ph"></div>'}
      <span class="vdur"></span>
      ${v.visibility === 'premium' ? `<span class="vexcl">${LOCK}Exclusive</span>` : ''}
      ${locked ? `<span class="vlock">${LOCK}</span>` : ''}
      ${status === 'ready' && isNew(v) ? '<span class="vnew">NEW</span>' : ''}
      ${status === 'processing' ? '<span class="vstate">Processing…</span>' : ''}
      ${status === 'failed' ? '<span class="vstate vstate-err">Failed</span>' : ''}
    </div>
    <div class="vinfo">
      <div class="vavatar">${PLAY}</div>
      <div class="vmeta">
        <div class="vtitle"></div>
        <div class="vviews"></div>
        ${catVisualRow(v)}
        <div class="vdesc"></div>
        <div class="vstats"></div>
      </div>
    </div>`;
  // user-facing text via textContent (XSS-safe)
  a.querySelector('.vdur').textContent = v.durLabel || '';
  // YouTube-style "continue watching" bar (from this device's saved progress).
  if (!locked) renderThumbProgress(a.querySelector('.vthumb'), v.id);
  a.querySelector('.vtitle').textContent = v.title || '';
  a.querySelector('.vviews').textContent = formatViews(state.views[v.id] || 0);
  a.querySelector('.vdesc').textContent = v.description || '';
  a.querySelector('.vstats').textContent = v.uploaded || '';

  // A locked card skips the generic "Unlock Now" interstitial: course-gated
  // videos still open their branded course modal (own pricing/checkout), but a
  // plain premium video goes straight to the membership page, which shows the
  // upfront + monthly pricing immediately (one click, no middle screen).
  if (locked) {
    const course = lockedByCourse ? courseForVideo(v.id) : null;
    const open = (e) => {
      e.preventDefault();
      if (course) { openCourseModal(course, v); return; }
      const videoUrl = `/watch?v=${encodeURIComponent(v.id)}`;
      window.location.href = `/membership.html?next=${encodeURIComponent(videoUrl)}`;
    };
    a.addEventListener('click', open);
    a.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') open(e); });
  }

  // Only wire hover previews for ready, unlocked cards that have a baked montage.
  if (canHover && status === 'ready' && v.preview && !locked) {
    a.dataset.preview = v.preview;
    a.addEventListener('mouseenter', () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => startPreview(a), 450); // hover-intent delay
    });
    a.addEventListener('mouseleave', () => {
      clearTimeout(hoverTimer);
      stopPreview();
    });
  }
  return a;
}

/** Append the next BATCH of cards from currentList; hide the sentinel at the end. */
function appendBatch() {
  const grid = document.getElementById('grid');
  const next = currentList.slice(shown, shown + BATCH);
  for (const v of next) grid.appendChild(card(v));
  shown += next.length;
  if (sentinel) sentinel.style.display = shown < currentList.length ? '' : 'none';
}

/** Lazily create + observe a sentinel after the grid that triggers more batches. */
function ensureObserver() {
  const grid = document.getElementById('grid');
  if (!sentinel) {
    sentinel = document.createElement('div');
    sentinel.className = 'grid-sentinel';
    grid.after(sentinel);
  }
  if (!io && window.IntersectionObserver) {
    io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && shown < currentList.length) appendBatch();
    }, { rootMargin: '700px' });
    io.observe(sentinel);
  }
}

/** Apply the current section/category filters + sort, then paint the first window. */
function render() {
  // Re-rendering detaches every card; tear down any in-flight hover preview first
  // so the shared <video> never ends up orphaned in a removed node, still playing.
  clearTimeout(hoverTimer);
  stopPreview();
  const grid = document.getElementById('grid');
  // Only surface fully-processed videos publicly. Records still `processing`
  // or `failed` are kept in the manifest (visible/deletable in admin) but must
  // never appear in the public grid. Missing status = legacy `ready`.
  let list = state.videos.filter((v) => v.published !== false && (v.status || 'ready') === 'ready');
  // Course content is sold + watched under its course (the Courses section + the
  // sales page), so keep course-assigned videos out of the general "All Videos"
  // library and category views. They still surface under section === 'courses'.
  if (state.section === 'all') list = list.filter((v) => courseIdsFor(v.id).length === 0);
  const activeCourse = state.section === 'courses' ? state.products.find((p) => p.slug === state.category) : null;
  renderCourseHeader(activeCourse);
  if (state.section === 'exclusive') list = list.filter((v) => v.visibility === 'premium');
  else if (state.section === 'courses') {
    // Show only the selected course's assigned videos (in its configured order).
    const ids = activeCourse ? activeCourse.videoIds : [];
    list = ids.map((id) => list.find((v) => v.id === id)).filter(Boolean);
  } else if (state.category) list = list.filter((v) => v.category === state.category);
  // A course is a curriculum: keep its configured lesson order (Chapter 1 → N) and
  // never re-sort by recency/popularity. Other sections honor the sort dropdown.
  if (state.section !== 'courses') {
    if (state.sort === 'popular') {
      list = list.slice().sort((a, b) => (state.views[b.id] || 0) - (state.views[a.id] || 0));
    } else if (state.sort === 'oldest') {
      list = list.slice().sort((a, b) => sortTs(a) - sortTs(b));
    } else {
      // 'recent' — newest first (default)
      list = list.slice().sort((a, b) => sortTs(b) - sortTs(a));
    }
  }
  grid.replaceChildren();
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'browse-empty';
    empty.textContent = state.section === 'exclusive' ? 'No exclusive videos yet.'
      : state.section === 'courses' ? 'No videos in this course yet.'
      : state.category ? 'No videos in this category yet.' : 'No videos yet.';
    grid.appendChild(empty);
    if (sentinel) sentinel.style.display = 'none';
    return;
  }
  // Reset the window and paint the first batch; the observer feeds the rest.
  currentList = list;
  shown = 0;
  appendBatch();
  ensureObserver();
}

const sortTs = (v) => (typeof v.uploadedAt === 'number' ? v.uploadedAt
  : (Date.parse(v.uploaded) || 0));

// --- course landing banner + branded unlock modal ---------------------------

const ownsCourse = (p) => !!(p && state.me && Array.isArray(state.me.ownedProductIds) && state.me.ownedProductIds.includes(p.id));

/** Load the course trailer (a free, published video) into the banner player and
 *  autoplay it muted. Mirrors the sales-page trailer (course.js). Best-effort. */
async function loadCourseTrailer(banner, product) {
  const trailerId = product && product.trailer;
  if (!trailerId) return;
  try {
    const res = await fetch(`/api/videos/${encodeURIComponent(trailerId)}/playback`);
    if (!res.ok) return;
    const { video } = await res.json();
    const levels = (video && Array.isArray(video.qualityLevels)) ? video.qualityLevels : [];
    if (!levels.length) return;
    const best = levels.slice().sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    if (!best || !best.url) return;
    // Bail if the viewer already navigated to a different course while we fetched.
    if (banner.dataset.slug !== product.slug) return;
    const wrap = banner.querySelector('.cb-trailer');
    const el = banner.querySelector('.cb-trailer-video');
    if (!wrap || !el) return;
    if (product.branding && product.branding.bgImage) el.poster = product.branding.bgImage;
    el.muted = true;
    el.src = best.url;
    wrap.hidden = false;
    el.play().catch(() => { /* autoplay blocked → controls stay, viewer can press play */ });
  } catch { /* no trailer → banner just shows logo + copy */ }
}

/** Branded header above the grid when viewing a course; removed otherwise. */
function renderCourseHeader(product) {
  const grid = document.getElementById('grid');
  let banner = document.getElementById('course-banner');
  if (!product) { if (banner) banner.remove(); return; }
  if (!banner) {
    banner = document.createElement('section');
    banner.id = 'course-banner';
    banner.className = 'course-banner';
    grid.before(banner);
  }
  const b = product.branding || {};
  const owned = ownsCourse(product) || state.isAdmin;
  banner.style.setProperty('--course-primary', b.primary || '#7c3aed');
  banner.style.setProperty('--course-accent', b.accent || '#22d3ee');
  // A branded hero image (e.g. the black "hacker" backdrop) replaces the default
  // colour gradient behind the banner.
  banner.style.backgroundImage = b.bgImage
    ? `linear-gradient(180deg, rgba(0,0,0,.45), rgba(0,0,0,.78)), url('${b.bgImage}')`
    : '';
  banner.style.backgroundSize = b.bgImage ? 'cover' : '';
  banner.style.backgroundPosition = b.bgImage ? 'center' : '';
  // Build the shell once per course so the autoplaying trailer isn't restarted on
  // unrelated re-renders (a sort change while staying in the same course view).
  if (banner.dataset.slug !== product.slug) {
    banner.dataset.slug = product.slug;
    banner.innerHTML = `
      <div class="cb-trailer" hidden><video class="cb-trailer-video" muted autoplay playsinline controls preload="metadata"></video></div>
      <div class="cb-inner">
        ${b.logo ? `<img class="cb-logo" src="${b.logo}" alt="" />` : ''}
        <div class="cb-text">
          <h2 class="cb-name"></h2>
          <p class="cb-headline"></p>
          <p class="cb-body"></p>
        </div>
        <div class="cb-cta"></div>
      </div>`;
    loadCourseTrailer(banner, product);
  }
  banner.querySelector('.cb-name').textContent = product.name || '';
  banner.querySelector('.cb-headline').textContent = (product.sales && product.sales.headline) || '';
  banner.querySelector('.cb-body').textContent = (product.sales && product.sales.body) || product.description || '';
  const cta = banner.querySelector('.cb-cta');
  cta.replaceChildren();
  if (owned) {
    cta.innerHTML = '<span class="cb-owned">✓ You own this course</span>';
  } else {
    const btn = document.createElement('button');
    btn.className = 'cb-buy gold-cta';
    btn.textContent = (product.sales && product.sales.ctaLabel) || `Purchase ${fmtMoney(product.price, product.currency)}`;
    btn.addEventListener('click', () => startPurchase(product, '', btn));
    cta.appendChild(btn);
  }
}

/** Branded, per-course unlock modal (the course's colors / copy / price). */
function openCourseModal(product, v) {
  let modal = document.getElementById('course-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'course-modal';
    modal.className = 'pm-overlay';
    modal.innerHTML = `
      <div class="pm-card cm-card" role="dialog" aria-modal="true" aria-labelledby="cm-title">
        <button class="pm-close" aria-label="Close">×</button>
        <img class="cm-logo" alt="" hidden />
        <span class="pm-badge cm-badge">Course</span>
        <h2 id="cm-title" class="cm-name"></h2>
        <p class="cm-headline"></p>
        <p class="pm-body cm-body"></p>
        <div class="cm-price"></div>
        <button class="pm-sub cm-buy gold-cta"></button>
        <a class="pm-alt" href="#">Learn more about this course</a>
      </div>`;
    document.body.appendChild(modal);
    const close = () => modal.classList.remove('show');
    modal.querySelector('.pm-close').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.classList.contains('show')) close(); });
  }
  const b = product.branding || {};
  const card = modal.querySelector('.cm-card');
  card.style.setProperty('--course-primary', b.primary || '#7c3aed');
  card.style.setProperty('--course-accent', b.accent || '#22d3ee');
  const logo = modal.querySelector('.cm-logo');
  if (b.logo) { logo.src = b.logo; logo.hidden = false; } else { logo.hidden = true; }
  modal.querySelector('.cm-name').textContent = product.name || 'Course';
  modal.querySelector('.cm-headline').textContent = (product.sales && product.sales.headline) || '';
  modal.querySelector('.cm-body').textContent = (product.sales && product.sales.body)
    || `"${(v && v.title) || 'This video'}" is part of the ${product.name} course. One purchase unlocks every video in the course.`;
  modal.querySelector('.cm-price').textContent = fmtMoney(product.price, product.currency);
  const buy = modal.querySelector('.cm-buy');
  buy.textContent = (product.sales && product.sales.ctaLabel) || `Purchase ${fmtMoney(product.price, product.currency)}`;
  buy.onclick = () => startPurchase(product, v ? `/watch?v=${encodeURIComponent(v.id)}` : '', buy);
  const alt = modal.querySelector('.pm-alt');
  alt.onclick = (e) => { e.preventDefault(); location.href = `/course.html?slug=${encodeURIComponent(product.slug)}`; };
  modal.classList.add('show');
}

// --- chips + sidebar wiring --------------------------------------------------

function wireSortDropdown() {
  const LABELS = { recent: 'Latest', popular: 'Most Viewed', oldest: 'Oldest' };
  const wrap = document.getElementById('sort-wrap');
  const btn = document.getElementById('sort-btn');
  const menu = document.getElementById('sort-menu');
  const label = document.getElementById('sort-label');
  if (!wrap) return;

  function open() { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); }
  function close() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  function syncLabel() { label.textContent = LABELS[state.sort] || 'Latest'; }

  btn.addEventListener('click', () => (menu.hidden ? open() : close()));
  menu.addEventListener('click', (e) => {
    const opt = e.target.closest('button[data-sort]');
    if (!opt) return;
    state.sort = opt.dataset.sort;
    syncLabel();
    close();
    render();
  });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  syncLabel();
}

// The sidebar (sidebar.js) emits this when a nav item (All / Exclusive / a
// category) is chosen. Section and category are set together so one sidebar pick
// = one filtered view.
window.addEventListener('dbtv:nav', (e) => {
  const d = e.detail || {};
  state.section = d.section === 'exclusive' ? 'exclusive'
    : d.section === 'courses' ? 'courses' : 'all';
  state.category = d.category || '';
  render();
});

async function init() {
  const grid = document.getElementById('grid');
  hydrateStateFromUrl();
  wireSortDropdown();
  // Know whether the viewer can see premium (admin or active member) + which
  // one-time products they own, and the published product catalog (for courses).
  try {
    const me = (await (await fetch('/api/auth/me')).json()).user;
    state.me = me || null;
    state.loggedIn = !!me;
    state.isAdmin = !!(me && Array.isArray(me.roles) && me.roles.includes('admin'));
    state.isMember = !!(me && me.membership && me.membership.active);
  } catch { /* anonymous */ }
  // Resolve the per-user "NEW" badge window now that we know who's viewing.
  state.newWin = loadNewWindow(state.me ? state.me.id : 'guest');
  try {
    state.products = (await (await fetch('/api/products')).json()).products || [];
    const map = new Map();
    for (const p of state.products) {
      for (const vid of (p.videoIds || [])) {
        const arr = map.get(vid) || [];
        arr.push(p.id);
        map.set(vid, arr);
      }
    }
    state.videoCourseMap = map;
  } catch { /* no products */ }
  try {
    // Category registry (slug → {name, flag?}) so cards can show a category flag.
    const cats = (await (await fetch('/api/categories')).json()).categories || [];
    state.categoryMap = new Map(cats.map((c) => [c.slug, c]));
  } catch { /* no categories */ }
  try {
    // Per-video view counts for the card byline (best-effort; cards still render
    // without it, just showing "No views").
    state.views = await (await fetch('/api/videos/views')).json();
  } catch { /* views unavailable */ }
  try {
    const res = await fetch('/thumbs/videos.json');
    state.videos = await res.json();
    render();
  } catch {
    grid.textContent = 'Could not load videos.';
  }
}

init();
