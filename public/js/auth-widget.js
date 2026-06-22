// Renders the header auth controls: "Sign in / Sign up" when logged out, or an
// avatar + dropdown menu (Profile, Account, Logout) when logged in.
import { fetchMe, postJSON } from './account.js';

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

  if (user.username) {
    const profile = document.createElement('a');
    profile.href = `/u/${encodeURIComponent(user.username)}`;
    profile.textContent = 'My public profile';
    menu.append(profile);
  } else {
    const setup = document.createElement('a');
    setup.href = '/profile-setup.html';
    setup.textContent = 'Finish your profile';
    menu.append(setup);
  }
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
      ['/god', 'Dashboard'],
      ['/god-videos.html', 'Manage videos'],
      ['/god-users.html', 'Users'],
      ['/god-community.html', 'Community'],
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

(async function init() {
  if (!mount) return;
  const user = await fetchMe();
  if (user) loggedIn(user); else loggedOut();
}());
