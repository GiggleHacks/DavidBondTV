// First-run onboarding overlay (shown on the feed once, right after a new user
// finishes profile setup). profile-setup.html sets localStorage.dbtv_onboard='1'
// on success; this module shows a welcome modal with a "next steps" checklist and
// then sets localStorage.dbtv_onboarded='1' so it never reappears. Pure client —
// no server round-trips. Accessible: role=dialog, ESC / overlay-click to close,
// focus trapped while open.
import { THEMES, applyTheme, getTheme } from './theme.js';

const FLAG = 'dbtv_onboard';      // set by profile-setup → "show me once"
const DONE = 'dbtv_onboarded';    // set here → "never again"
const CHECKS = 'dbtv_onboard_checks';

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }

function loadChecks() {
  try { return JSON.parse(lsGet(CHECKS) || '{}') || {}; } catch { return {}; }
}
function saveChecks(obj) { lsSet(CHECKS, JSON.stringify(obj)); }

// The checklist. `action` runs on click (returns true to also tick the box).
const STEPS = [
  { id: 'browse', icon: '🎬', title: 'Browse the latest videos',
    desc: 'Travel films, documentaries and vlogs — start watching.',
    cta: 'Start watching', action: (ov) => { close(ov); return true; } },
  { id: 'member', icon: '⭐', title: 'Explore membership',
    desc: 'Unlock premium videos and support the channel.',
    cta: 'See membership', href: '/membership.html' },
  { id: 'theme', icon: '🎨', title: 'Pick your theme',
    desc: 'Make it yours — choose an accent colour.', theme: true },
  { id: 'profile', icon: '✍️', title: 'Add a bio to your profile',
    desc: 'Tell the community a little about yourself.',
    cta: 'Edit profile', href: '/account.html' },
];

let lastFocus = null;

function close(ov) {
  if (!ov || ov.dataset.closing) return;
  ov.dataset.closing = '1';
  lsSet(DONE, '1');
  lsDel(FLAG);
  ov.classList.add('ob-hide');
  setTimeout(() => { ov.remove(); document.removeEventListener('keydown', ov._onKey); }, 220);
  if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch { /* ignore */ } }
}

function buildThemeRow() {
  const row = document.createElement('div');
  row.className = 'ob-themes';
  const current = getTheme();
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `ob-swatch${t.id === current ? ' active' : ''}`;
    b.style.setProperty('--sw', t.swatch);
    b.title = t.name;
    b.setAttribute('aria-label', `Use the ${t.name} theme`);
    b.addEventListener('click', () => {
      applyTheme(t.id);
      row.querySelectorAll('.ob-swatch').forEach((s) => s.classList.remove('active'));
      b.classList.add('active');
    });
    row.appendChild(b);
  }
  return row;
}

function injectStyles() {
  if (document.getElementById('ob-styles')) return;
  const css = `
  .ob-overlay{position:fixed;inset:0;z-index:2147482000;display:flex;align-items:center;
    justify-content:center;padding:20px;background:rgba(2,6,23,.62);backdrop-filter:blur(4px);
    animation:ob-fade .22s ease;}
  .ob-overlay.ob-hide{opacity:0;transition:opacity .2s ease;}
  @keyframes ob-fade{from{opacity:0}to{opacity:1}}
  .ob-card{width:min(560px,100%);max-height:90vh;overflow:auto;border-radius:20px;
    background:var(--surface);color:var(--text);border:1px solid var(--border);
    box-shadow:0 24px 70px rgba(0,0,0,.5);animation:ob-pop .26s cubic-bezier(.2,.9,.3,1.2);}
  @keyframes ob-pop{from{transform:translateY(14px) scale(.97);opacity:0}to{transform:none;opacity:1}}
  .ob-head{position:relative;padding:26px 26px 6px;text-align:center;}
  .ob-spark{font-size:34px;line-height:1;}
  .ob-head h2{margin:10px 0 4px;font-size:22px;}
  .ob-head p{margin:0;color:var(--text-dim);font-size:14px;}
  .ob-x{position:absolute;top:14px;right:14px;width:32px;height:32px;border-radius:50%;
    border:1px solid var(--border);background:var(--surface-2);color:var(--text-dim);
    font-size:16px;cursor:pointer;line-height:1;transition:background .15s,color .15s;}
  .ob-x:hover{background:var(--surface);color:var(--text);}
  .ob-list{display:grid;gap:10px;padding:18px 22px;}
  .ob-item{display:flex;align-items:flex-start;gap:12px;padding:12px 14px;border-radius:14px;
    border:1px solid var(--border);background:var(--surface-2);transition:border-color .15s,transform .05s;}
  .ob-item:hover{border-color:color-mix(in srgb,var(--accent) 55%,var(--border));}
  .ob-item.done{border-color:color-mix(in srgb,#22c55e 55%,var(--border));}
  .ob-tick{flex:none;width:24px;height:24px;border-radius:50%;border:2px solid var(--border);
    display:flex;align-items:center;justify-content:center;font-size:13px;color:transparent;
    margin-top:2px;transition:all .15s;}
  .ob-item.done .ob-tick{background:#22c55e;border-color:#22c55e;color:#fff;}
  .ob-ico{font-size:20px;line-height:1.2;flex:none;}
  .ob-body{flex:1;min-width:0;}
  .ob-body h3{margin:0 0 2px;font-size:15px;}
  .ob-body p{margin:0 0 8px;font-size:13px;color:var(--text-dim);}
  .ob-cta{display:inline-block;font-size:13px;font-weight:600;padding:6px 14px;border-radius:999px;
    background:var(--accent);color:var(--accent-contrast);border:none;cursor:pointer;text-decoration:none;}
  .ob-cta.ghost{background:transparent;color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 50%,var(--border));}
  .ob-themes{display:flex;gap:8px;flex-wrap:wrap;}
  .ob-swatch{width:30px;height:30px;border-radius:50%;background:var(--sw);cursor:pointer;
    border:2px solid var(--border);box-shadow:0 0 0 2px transparent;transition:box-shadow .15s,transform .05s;}
  .ob-swatch:hover{transform:scale(1.08);}
  .ob-swatch.active{border-color:#fff;box-shadow:0 0 0 2px var(--sw);}
  .ob-foot{padding:6px 22px 22px;text-align:center;}
  .ob-done{font-size:14px;font-weight:600;padding:10px 22px;border-radius:999px;border:1px solid var(--border);
    background:var(--surface-2);color:var(--text);cursor:pointer;transition:background .15s;}
  .ob-done:hover{background:var(--surface);}`;
  const style = document.createElement('style');
  style.id = 'ob-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

function render() {
  injectStyles();
  const checks = loadChecks();
  lastFocus = document.activeElement;

  const ov = document.createElement('div');
  ov.className = 'ob-overlay';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', 'Welcome to David Bond TV');

  const card = document.createElement('div');
  card.className = 'ob-card';
  card.innerHTML = `
    <div class="ob-head">
      <button type="button" class="ob-x" aria-label="Close">✕</button>
      <div class="ob-spark">🎉</div>
      <h2>Welcome to David Bond TV!</h2>
      <p>You're all set. Here are a few things to get you started.</p>
    </div>
    <div class="ob-list"></div>
    <div class="ob-foot"><button type="button" class="ob-done">Got it — take me to the videos</button></div>`;

  const list = card.querySelector('.ob-list');
  for (const step of STEPS) {
    const item = document.createElement('div');
    item.className = `ob-item${checks[step.id] ? ' done' : ''}`;
    item.dataset.id = step.id;
    item.innerHTML = `
      <span class="ob-tick">✓</span>
      <span class="ob-ico">${step.icon}</span>
      <div class="ob-body">
        <h3>${step.title}</h3>
        <p>${step.desc}</p>
      </div>`;
    const body = item.querySelector('.ob-body');

    const tick = (on = true) => {
      const c = loadChecks(); c[step.id] = on; saveChecks(c);
      item.classList.toggle('done', on);
    };

    if (step.theme) {
      body.appendChild(buildThemeRow());
      // Ticking the theme step: any swatch click marks it explored.
      item.querySelectorAll('.ob-swatch').forEach((s) => s.addEventListener('click', () => tick(true)));
    } else if (step.href) {
      const a = document.createElement('a');
      a.className = 'ob-cta';
      a.href = step.href;
      a.textContent = step.cta;
      a.addEventListener('click', () => tick(true));
      body.appendChild(a);
    } else if (step.action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ob-cta';
      b.textContent = step.cta;
      b.addEventListener('click', () => { if (step.action(ov)) tick(true); });
      body.appendChild(b);
    }
    list.appendChild(item);
  }

  ov.appendChild(card);
  document.body.appendChild(ov);

  card.querySelector('.ob-x').addEventListener('click', () => close(ov));
  card.querySelector('.ob-done').addEventListener('click', () => close(ov));
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(ov); });

  // Focus trap + ESC.
  ov._onKey = (e) => {
    if (e.key === 'Escape') { close(ov); return; }
    if (e.key !== 'Tab') return;
    const f = ov.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    const first = f[0]; const lastEl = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', ov._onKey);
  setTimeout(() => { try { card.querySelector('.ob-done').focus(); } catch { /* ignore */ } }, 60);
}

// Show only for a freshly-onboarded user who hasn't seen it yet.
if (lsGet(FLAG) === '1' && lsGet(DONE) !== '1') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
}
