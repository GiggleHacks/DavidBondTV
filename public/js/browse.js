// Renders the multi-video homepage grid from the generated manifest, with a
// YouTube-style hover preview (a small baked montage that plays on hover),
// category chips (Recently Uploaded / All), a sidebar section filter
// (All Videos / Exclusive Videos) and a premium lock layer for non-admins.
const PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const LOCK = '<svg viewBox="0 0 24 24"><path d="M12 1a5 5 0 00-5 5v3H6a2 2 0 00-2 2v9a2 2 0 002 2h12a2 2 0 002-2v-9a2 2 0 00-2-2h-1V6a5 5 0 00-5-5zm3 8H9V6a3 3 0 016 0v3z"/></svg>';
// Polished gold padlock for the premium unlock modal (richer than the card LOCK).
const PREMIUM_LOCK = (sfx) => `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
  <defs><linearGradient id="lk-${sfx}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe7a3"/><stop offset="1" stop-color="#f4a300"/></linearGradient></defs>
  <path d="M16 22v-5a8 8 0 0 1 16 0v5" stroke="url(#lk-${sfx})" stroke-width="3.6" stroke-linecap="round"/>
  <rect x="9.5" y="21.5" width="29" height="20" rx="5.5" fill="url(#lk-${sfx})"/>
  <circle cx="24" cy="29.5" r="3.2" fill="#3a2600"/><rect x="22.5" y="30.5" width="3" height="6.5" rx="1.5" fill="#3a2600"/>
</svg>`;

// Only do video previews on devices with a real hovering pointer (skip touch).
const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

// One shared <video> element, reparented into whichever card is hovered.
let preview = null;
let hoverTimer = null;

// View state. sort: 'recent' (default) | 'all'. section: 'all' | 'exclusive'.
// category: '' (all) | <slug>.
const state = { videos: [], sort: 'recent', section: 'all', category: '', isAdmin: false, isMember: false, loggedIn: false };

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

const NEW_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // "NEW" badge visible for 3 days
const isNew = (v) => typeof v.uploadedAt === 'number' && (Date.now() - v.uploadedAt) < NEW_WINDOW_MS;

function card(v) {
  const status = v.status || 'ready';
  // Premium clips are watchable by admins + active members; everyone else gets
  // the lock layer.
  const locked = v.visibility === 'premium' && !state.isAdmin && !state.isMember;
  // Per-video thumbnail blur level (admin-configured). Default medium for premium.
  const blur = ['strong', 'medium', 'off'].includes(v.blur) ? v.blur
    : (v.visibility === 'premium' ? 'medium' : 'off');
  const a = document.createElement('a');
  a.className = `vcard${status !== 'ready' ? ` is-${status}` : ''}${locked ? ` is-locked blur-${blur}` : ''}`;
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
        <div class="vchannel">David Bond TV <span class="check">✔</span></div>
        <div class="vdesc"></div>
        <div class="vstats"></div>
      </div>
    </div>`;
  // user-facing text via textContent (XSS-safe)
  a.querySelector('.vdur').textContent = v.durLabel || '';
  a.querySelector('.vtitle').textContent = v.title || '';
  a.querySelector('.vdesc').textContent = v.description || '';
  a.querySelector('.vstats').textContent = v.uploaded || '';

  // A locked premium card opens the subscribe modal instead of navigating.
  if (locked) {
    const open = (e) => { e.preventDefault(); openPremiumModal(v); };
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
  if (state.section === 'exclusive') list = list.filter((v) => v.visibility === 'premium');
  if (state.category) list = list.filter((v) => v.category === state.category);
  if (state.sort === 'recent') {
    // Newest first, keyed on uploadedAt (falls back to the parsed `uploaded`
    // date). Ties keep manifest order via the engine's stable sort.
    list = list.slice().sort((a, b) => sortTs(b) - sortTs(a));
  }
  grid.replaceChildren();
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'browse-empty';
    empty.textContent = state.section === 'exclusive' ? 'No exclusive videos yet.'
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

// --- Premium subscribe modal -------------------------------------------------

function openPremiumModal(v) {
  let modal = document.getElementById('premium-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'premium-modal';
    modal.className = 'pm-overlay';
    modal.innerHTML = `
      <div class="pm-card" role="dialog" aria-modal="true" aria-labelledby="pm-title">
        <button class="pm-close" aria-label="Close">×</button>
        <span class="pm-badge">★ Members only</span>
        <div class="pm-lock">${PREMIUM_LOCK('pm')}</div>
        <h2 id="pm-title">Unlock the full library</h2>
        <p class="pm-body"></p>
        <button class="pm-sub gold-cta">Unlock Now</button>
        <a class="pm-alt" href="#">Already a member? Sign in</a>
      </div>`;
    document.body.appendChild(modal);
    const close = () => modal.classList.remove('show');
    modal.querySelector('.pm-close').addEventListener('click', close);
    // Logged-in → membership offer; logged-out → sign up first, then back to the
    // offer (which carries `next` to the original video). Stash for the onboarding
    // chain so email-verify / profile-setup return here too.
    modal.querySelector('.pm-sub').addEventListener('click', () => {
      const dest = modal._membershipUrl;
      if (state.loggedIn) { window.location.href = dest; return; }
      try { localStorage.setItem('dbtv_after_auth', dest); } catch { /* ignore */ }
      window.location.href = `/signup.html?next=${encodeURIComponent(dest)}`;
    });
    modal.querySelector('.pm-alt').addEventListener('click', (e) => {
      e.preventDefault();
      window.location.href = `/login.html?next=${encodeURIComponent(modal._membershipUrl)}`;
    });
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('show')) close();
    });
  }
  const videoUrl = `/watch?v=${encodeURIComponent(v.id)}`;
  modal._membershipUrl = `/membership.html?next=${encodeURIComponent(videoUrl)}`;
  modal.querySelector('.pm-body').textContent =
    `"${v.title || 'This video'}" is part of David Bond TV membership. Join to stream it and every exclusive — new drops first, no ads, cancel anytime.`;
  modal.classList.add('show');
}

// --- chips + sidebar wiring --------------------------------------------------

function wireChips() {
  const chips = [...document.querySelectorAll('.browse-chips .chip')];
  const sync = () => chips.forEach((c) => c.classList.toggle('active', c.dataset.sort === state.sort));
  chips.forEach((c) => c.addEventListener('click', () => {
    state.sort = c.dataset.sort || 'recent';
    sync();
    render();
  }));
  sync();
}

// The sidebar (sidebar.js) emits this when a nav item (All / Exclusive / a
// category) is chosen. Section and category are set together so one sidebar pick
// = one filtered view.
window.addEventListener('dbtv:nav', (e) => {
  const d = e.detail || {};
  state.section = d.section === 'exclusive' ? 'exclusive' : 'all';
  state.category = d.category || '';
  render();
});

async function init() {
  const grid = document.getElementById('grid');
  wireChips();
  // Know whether the viewer can see premium (admin or active member).
  try {
    const me = (await (await fetch('/api/auth/me')).json()).user;
    state.loggedIn = !!me;
    state.isAdmin = !!(me && Array.isArray(me.roles) && me.roles.includes('admin'));
    state.isMember = !!(me && me.membership && me.membership.active);
  } catch { /* anonymous */ }
  try {
    const res = await fetch('/thumbs/videos.json');
    state.videos = await res.json();
    render();
  } catch {
    grid.textContent = 'Could not load videos.';
  }
}

init();
