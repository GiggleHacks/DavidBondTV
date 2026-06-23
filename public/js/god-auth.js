// Shared admin gate for every /god* page. Uses the normal session cookie (sent
// automatically with same-origin fetches) — no bearer tokens. If the visitor
// isn't a signed-in admin, it renders a self-contained sign-in overlay right on
// the page. Resolves to the admin user, or
// never resolves (the overlay takes over) for non-admins.
export async function requireAdmin() {
  const appRoot = findAdminAppRoot();
  const me = await fetchMe();
  if (isAdmin(me)) {
    releaseAdminGateState(appRoot, document.body);
    return me;
  }
  applyAdminGateState(appRoot, document.body);
  renderGate();
  return new Promise(() => {}); // page waits; the overlay drives sign-in + reload
}

export function isAdmin(u) {
  return !!(u && Array.isArray(u.roles) && u.roles.includes('admin'));
}

async function fetchMe() {
  try { return (await (await fetch('/api/auth/me')).json()).user; } catch { return null; }
}

function findAdminAppRoot() {
  return document.querySelector('.admin-app-shell') || document.getElementById('app');
}

export function applyAdminGateState(appRoot, body = document.body) {
  if (appRoot) {
    appRoot.setAttribute('aria-hidden', 'true');
    appRoot.setAttribute('inert', '');
  }
  if (body) body.classList.add('admin-gated');
  if (typeof document !== 'undefined') document.documentElement.classList.remove('admin-auth-pending');
}

export function releaseAdminGateState(appRoot, body = document.body) {
  if (appRoot) {
    appRoot.removeAttribute('aria-hidden');
    appRoot.removeAttribute('inert');
  }
  if (body) body.classList.remove('admin-gated');
  if (typeof document !== 'undefined') document.documentElement.classList.remove('admin-auth-pending');
}

function renderGate() {
  if (document.getElementById('god-gate')) return;
  const wrap = document.createElement('div');
  wrap.id = 'god-gate';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.innerHTML = createAdminGateMarkup();
  document.body.appendChild(wrap);
  injectStyles();

  const $ = (id) => document.getElementById(id);
  const showErr = (m) => { const e = $('gg-err'); e.textContent = m; e.classList.remove('hidden'); };
  const clearErr = () => $('gg-err').classList.add('hidden');

  $('gg-go').addEventListener('click', signIn);
  $('gg-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });
  async function signIn() {
    clearErr();
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('gg-id').value.trim(), password: $('gg-pw').value }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return showErr(d.error || 'Sign in failed.');
    if (!isAdmin(d.user)) return showErr('That account is not an administrator.');
    location.reload();
  }
}

export function createAdminGateMarkup() {
  return `
    <div class="gg-card">
      <div class="gg-logo"><span class="wm-pre">David Bond</span><span class="wm-box">TV</span></div>
      <h2 id="gg-title">Admin sign-in</h2>
      <div id="gg-err" class="gg-err hidden"></div>
      <div id="gg-login">
        <input id="gg-id" placeholder="Username or email" autocomplete="username" />
        <input id="gg-pw" type="password" placeholder="Password" autocomplete="current-password" />
        <button id="gg-go" class="gg-btn">Sign in</button>
        <p class="gg-muted">Admin recovery is server-only. Use the local break-glass reset script over SSH.</p>
      </div>
    </div>`;
}

function injectStyles() {
  const s = document.createElement('style');
  s.textContent = `
    .admin-auth-pending .admin-app-shell,
    body.admin-gated .admin-app-shell { display: none !important; }
    body.admin-gated { overflow: hidden; }
    #god-gate { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center;
      background: radial-gradient(1200px 600px at 50% -10%, var(--bg-2), var(--bg)); padding: 24px; }
    #god-gate .gg-card { width: min(380px, 100%); background: var(--surface); border: 1px solid var(--border);
      border-radius: 16px; padding: 28px; box-shadow: 0 18px 50px var(--shadow); }
    #god-gate .gg-logo { font-family: Arial, sans-serif; font-weight: 800; font-size: 24px; letter-spacing: -.6px; margin-bottom: 14px; }
    #god-gate .wm-pre { color: var(--text); } #god-gate .wm-box { background: var(--accent); color: var(--accent-contrast); border-radius: 6px; padding: 1px 8px 3px; margin-left: 5px; }
    #god-gate h2 { font-size: 18px; margin: 0 0 16px; }
    #god-gate input { width: 100%; box-sizing: border-box; background: var(--surface-2); color: var(--text);
      border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; font-size: 15px; margin-bottom: 12px; min-height: 44px; }
    #god-gate input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); }
    #god-gate .gg-btn { width: 100%; background: var(--accent); color: var(--accent-contrast); border: none; border-radius: 999px;
      padding: 12px; font-size: 15px; font-weight: 700; cursor: pointer; transition: filter .15s, transform .05s; min-height: 44px; }
    #god-gate .gg-btn:hover { filter: brightness(1.08); } #god-gate .gg-btn:active { transform: scale(.98); }
    #god-gate .gg-link { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 13px; margin-top: 12px; display: inline-flex; align-items: center; min-height: 44px; }
    #god-gate .gg-muted { color: var(--text-dim); font-size: 14px; margin: 0 0 12px; }
    #god-gate .gg-err { background: color-mix(in srgb, #ef4444 16%, transparent); border: 1px solid color-mix(in srgb, #ef4444 40%, transparent);
      color: #fecaca; border-radius: 10px; padding: 9px 12px; font-size: 13px; margin-bottom: 14px; }
    #god-gate .hidden { display: none !important; }`;
  document.head.appendChild(s);
}
