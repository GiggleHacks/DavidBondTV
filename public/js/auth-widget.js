// Renders the header auth controls: "Sign in / Sign up" when logged out, or an
// avatar + dropdown menu (Profile, Account, Logout) when logged in.
import { fetchMe, postJSON } from './account.js';
import { ADMIN_PATHS } from './admin-paths.js';

const mount = document.getElementById('auth-widget');

function loggedOut() {
  mount.replaceChildren();
  const signin = document.createElement('a');
  signin.className = 'aw-link';
  signin.href = '/login.html';
  signin.textContent = 'Sign in';
  const signup = document.createElement('a');
  signup.className = 'aw-link primary';
  signup.href = '/signup.html';
  signup.textContent = 'Sign up';
  mount.append(signin, signup);
}

function loggedIn(user) {
  mount.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'aw-user';

  const trigger = document.createElement('button');
  trigger.className = 'aw-trigger';
  trigger.type = 'button';
  const img = document.createElement('img');
  img.src = user.avatarUrl;
  img.alt = '';
  const label = document.createElement('span');
  label.textContent = user.username || 'Account';
  trigger.append(img, label);
  if (Array.isArray(user.roles) && user.roles.includes('admin')) {
    const badge = document.createElement('span');
    badge.className = 'admin-badge mini';
    badge.title = 'Site administrator';
    badge.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 8l4.5 3.2L12 4l5.5 7.2L22 8l-2 11H4L2 8z"/></svg>';
    trigger.append(badge);
  } else if (user.membership && user.membership.active) {
    const badge = document.createElement('span');
    badge.className = 'member-badge mini';
    badge.title = 'David Bond TV member';
    badge.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.2l2.95 5.98 6.6.96-4.77 4.65 1.13 6.57L12 17.98 6.09 20.33l1.13-6.57L2.45 9.14l6.6-.96z"/></svg>';
    trigger.append(badge);
  }

  const menu = document.createElement('div');
  menu.className = 'aw-menu';
  menu.hidden = true;

  const account = document.createElement('a');
  account.href = '/account.html';
  account.textContent = 'Account settings';
  menu.append(account);

  // Admin section: dashboard + management links, replacing the old top-nav button.
  if (Array.isArray(user.roles) && user.roles.includes('admin')) {
    menu.append(document.createElement('hr'));
    const label = document.createElement('div');
    label.className = 'aw-section';
    label.textContent = 'Admin';
    menu.append(label);
    for (const [href, text] of [
      [ADMIN_PATHS.dashboard, 'Dashboard'],
      [ADMIN_PATHS.videos, 'Manage videos'],
      [ADMIN_PATHS.users, 'Users'],
      [ADMIN_PATHS.community, 'Community'],
    ]) {
      const a = document.createElement('a');
      a.href = href;
      a.textContent = text;
      menu.append(a);
    }
  }

  menu.append(document.createElement('hr'));
  const logout = document.createElement('button');
  logout.type = 'button';
  logout.textContent = 'Sign out';
  logout.addEventListener('click', async () => {
    await postJSON('/api/auth/logout');
    window.location.reload();
  });
  menu.append(logout);

  trigger.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener('click', () => { menu.hidden = true; });

  wrap.append(trigger, menu);
  mount.append(wrap);
}

// Gentle post-signup nudge: verification no longer blocks login or checkout,
// so this slim banner (plus the player's free-view gate) is where it happens.
const VERIFY_DISMISS_KEY = 'dbtv_verify_dismissed';

function verifyBanner(user) {
  if (user.verified) return;
  try { if (sessionStorage.getItem(VERIFY_DISMISS_KEY)) return; } catch { /* ignore */ }

  const bar = document.createElement('div');
  bar.className = 'verify-banner';
  const text = document.createElement('span');
  text.className = 'vb-text';
  text.textContent = `Verify your email — enter the code we sent to ${user.email}`;
  const input = document.createElement('input');
  input.className = 'vb-input';
  input.type = 'text';
  input.inputMode = 'numeric';
  input.maxLength = 6;
  input.autocomplete = 'one-time-code';
  input.placeholder = '6-digit code';
  const verify = document.createElement('button');
  verify.type = 'button';
  verify.className = 'vb-btn primary';
  verify.textContent = 'Verify';
  const resend = document.createElement('button');
  resend.type = 'button';
  resend.className = 'vb-btn';
  resend.textContent = 'Resend';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'vb-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';

  verify.addEventListener('click', async () => {
    const code = input.value.replace(/\D/g, '');
    if (code.length !== 6) { text.textContent = 'Enter the 6-digit code from your email.'; return; }
    verify.disabled = true;
    const r = await postJSON('/api/auth/verify-code', { email: user.email, code });
    if (r.ok && r.data.ok) { window.location.reload(); return; }
    text.textContent = (r.data && r.data.error) || 'That code did not work — try again.';
    verify.disabled = false;
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') verify.click(); });
  resend.addEventListener('click', async () => {
    resend.disabled = true;
    const r = await postJSON('/api/auth/resend-code', { email: user.email });
    text.textContent = r.ok ? `A new code is on its way to ${user.email}.` : 'Could not resend — try again shortly.';
    resend.disabled = false;
  });
  close.addEventListener('click', () => {
    try { sessionStorage.setItem(VERIFY_DISMISS_KEY, '1'); } catch { /* ignore */ }
    bar.remove();
  });

  bar.append(text, input, verify, resend, close);
  document.body.prepend(bar);
}

(async function init() {
  if (!mount) return;
  const user = await fetchMe();
  if (user) { loggedIn(user); verifyBanner(user); } else loggedOut();
}());
