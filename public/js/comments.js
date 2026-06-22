// Comments UI: loads + posts comments against the backend API. Logged-in users
// post under their profile (clickable name + avatar, no name field, no math
// check); everyone else posts anonymously behind a signed math human-check. All
// user text is rendered via textContent (never innerHTML) — XSS-safe.
import { fetchMe } from './account.js';

// Standard 12-hour date + time, e.g. "Jun 21, 2026, 3:45 PM".
function formatDateTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

// Deterministic hue so each anonymous commenter gets a visually distinct avatar.
function seededColor(seed) {
  let h = 0;
  for (const ch of String(seed || 'anon')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 45%)`;
}

// ISO-2 country code → flag emoji (regional indicator pair). '' if unknown.
function flagEmoji(cc) {
  const up = typeof cc === 'string' ? cc.toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(up)) return '';
  const A = 'A'.charCodeAt(0);
  return String.fromCodePoint(0x1f1e6 + up.charCodeAt(0) - A, 0x1f1e6 + up.charCodeAt(1) - A);
}

export function initComments(videoId) {
  const form = document.getElementById('comment-form');
  if (!form) return;

  const VIDEO = videoId || 'bikinis';
  const nameInput = document.getElementById('cf-name');
  const anonInput = document.getElementById('cf-anon');
  const nameRow = document.querySelector('.comment-form .cf-row');
  const textInput = document.getElementById('cf-text');
  const answerInput = document.getElementById('cf-answer');
  const questionEl = document.getElementById('cf-question');
  const challengeEl = document.querySelector('.cf-challenge');
  const msgEl = document.getElementById('cf-msg');
  const submitBtn = document.getElementById('cf-submit');
  const listEl = document.getElementById('comment-list');
  const countEl = document.getElementById('comment-count');

  let token = null;
  let me = null;
  let cooling = false; // true while a rate-limit countdown is running

  function setMsg(text, kind) {
    if (!text) { msgEl.hidden = true; return; }
    msgEl.hidden = false;
    msgEl.textContent = text;
    msgEl.className = `cf-msg ${kind || ''}`.trim();
  }

  function updateCount() {
    countEl.textContent = String(listEl.querySelectorAll('.comment').length);
  }

  // --- admin moderation ---
  const amAdmin = () => !!(me && Array.isArray(me.roles) && me.roles.includes('admin'));

  async function removeComment(c, li) {
    if (!window.confirm('Delete this comment?')) return;
    try {
      const res = await fetch(`/api/comments?video=${encodeURIComponent(VIDEO)}&id=${encodeURIComponent(c.id)}`, { method: 'DELETE' });
      if (res.ok) {
        li.remove();
        updateCount();
        if (!listEl.querySelector('.comment')) renderEmpty();
      }
    } catch { /* ignore */ }
  }

  async function banAuthor(c) {
    if (!c.userId) return;
    if (!window.confirm(`Ban ${c.name || 'this user'}? They’ll be blocked from the site and their comments hidden.`)) return;
    try {
      await fetch(`/api/admin/users/${encodeURIComponent(c.userId)}/block`, { method: 'POST' });
      // Drop every comment by this author from the current view.
      listEl.querySelectorAll('.comment').forEach((el) => { if (el.dataset.uid === c.userId) el.remove(); });
      updateCount();
      if (!listEl.querySelector('.comment')) renderEmpty();
    } catch { /* ignore */ }
  }

  // Specific, friendly cooldown message with a live countdown (no vague text).
  function startCooldown(seconds) {
    cooling = true;
    submitBtn.disabled = true;
    let remaining = Math.max(1, Number(seconds) || 1);
    const tick = () => {
      if (remaining <= 0) {
        cooling = false;
        submitBtn.disabled = false;
        setMsg('');
        return;
      }
      setMsg(`Please wait ${remaining} second${remaining === 1 ? '' : 's'} before posting another comment.`, 'error');
      remaining -= 1;
      setTimeout(tick, 1000);
    };
    tick();
  }

  function makeCommentEl(c) {
    const li = document.createElement('li');
    li.className = 'comment';
    if (c.userId) li.dataset.uid = c.userId;

    const avatar = document.createElement('div');
    avatar.className = 'comment-avatar';
    if (c.avatar) {
      const img = document.createElement('img');
      img.src = c.avatar; img.alt = '';
      avatar.append(img);
    } else {
      const isAnon = !c.name || c.name === 'Anonymous';
      avatar.style.background = seededColor(c.avatarSeed || c.name);
      avatar.textContent = isAnon ? '?' : c.name.trim().charAt(0).toUpperCase() || '?';
    }

    const body = document.createElement('div');
    body.className = 'comment-body';

    const head = document.createElement('div');
    head.className = 'comment-head';

    let nameEl;
    if (c.username) {
      nameEl = document.createElement('a');
      nameEl.className = 'comment-name';
      nameEl.href = `/u/${encodeURIComponent(c.username)}`;
    } else {
      const isAnon = !c.name || c.name === 'Anonymous';
      nameEl = document.createElement('span');
      nameEl.className = `comment-name${isAnon ? ' anon' : ''}`;
    }
    nameEl.textContent = c.name || 'Anonymous';
    head.append(nameEl);

    if (c.admin) {
      const badge = document.createElement('span');
      badge.className = 'admin-badge mini';
      badge.title = 'Site administrator';
      badge.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 8l4.5 3.2L12 4l5.5 7.2L22 8l-2 11H4L2 8z"/></svg>';
      head.append(badge);
    } else if (c.member) {
      // Paid members get a blue star — distinct from the admin gold crown.
      li.classList.add('is-member');
      const badge = document.createElement('span');
      badge.className = 'member-badge mini';
      badge.title = 'David Bond TV member';
      badge.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.2l2.95 5.98 6.6.96-4.77 4.65 1.13 6.57L12 17.98 6.09 20.33l1.13-6.57L2.45 9.14l6.6-.96z"/></svg>';
      head.append(badge);
    }

    const flag = flagEmoji(c.country);
    if (flag) {
      const flagEl = document.createElement('span');
      flagEl.className = 'comment-flag';
      flagEl.textContent = flag;
      flagEl.title = c.country;
      head.append(flagEl);
    }

    const timeEl = document.createElement('span');
    timeEl.className = 'comment-time';
    timeEl.textContent = formatDateTime(c.ts);
    head.append(timeEl);

    const textEl = document.createElement('div');
    textEl.className = 'comment-text';
    textEl.textContent = c.text;

    body.append(head, textEl);

    // Admin-only moderation controls.
    if (amAdmin()) {
      const mod = document.createElement('div');
      mod.className = 'comment-mod';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'cmod-btn';
      del.textContent = 'Delete';
      del.addEventListener('click', () => removeComment(c, li));
      mod.append(del);
      if (c.userId && !c.admin) {
        const ban = document.createElement('button');
        ban.type = 'button';
        ban.className = 'cmod-btn danger';
        ban.textContent = 'Ban author';
        ban.addEventListener('click', () => banAuthor(c));
        mod.append(ban);
      }
      body.append(mod);
    }

    li.append(avatar, body);
    return li;
  }

  function renderEmpty() {
    listEl.replaceChildren();
    const li = document.createElement('li');
    li.className = 'comment-empty';
    li.textContent = 'No comments yet. Be the first!';
    listEl.appendChild(li);
  }

  async function loadChallenge() {
    try {
      const res = await fetch('/api/challenge');
      const data = await res.json();
      token = data.token;
      questionEl.textContent = data.question;
    } catch {
      questionEl.textContent = 'Verification unavailable';
    }
  }

  async function loadComments() {
    try {
      const res = await fetch(`/api/comments?video=${encodeURIComponent(VIDEO)}`);
      const data = await res.json();
      const comments = data.comments || [];
      if (comments.length === 0) renderEmpty();
      else listEl.replaceChildren(...comments.map(makeCommentEl));
      updateCount();
    } catch {
      renderEmpty();
    }
  }

  if (anonInput) {
    anonInput.addEventListener('change', () => {
      nameInput.disabled = anonInput.checked;
      if (anonInput.checked) nameInput.value = '';
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (cooling) return;
    const text = textInput.value.trim();
    if (!text) { setMsg('Please write a comment first.', 'error'); return; }
    const authed = me && me.profileComplete;
    if (!authed && !answerInput.value.trim()) {
      setMsg('Please answer the verification question.', 'error');
      return;
    }

    submitBtn.disabled = true;
    setMsg('');
    try {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video: VIDEO,
          name: nameInput ? nameInput.value : '',
          anonymous: anonInput ? anonInput.checked : false,
          text,
          answer: answerInput.value,
          token,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.ok) {
        const empty = listEl.querySelector('.comment-empty');
        if (empty) empty.remove();
        listEl.prepend(makeCommentEl(data.comment));
        updateCount();
        textInput.value = '';
        answerInput.value = '';
        setMsg('Comment posted!', 'ok');
      } else if (res.status === 429) {
        startCooldown(data.retryAfter);
      } else {
        setMsg(data.error || 'Could not post your comment.', 'error');
      }
    } catch {
      setMsg('Network error — please try again.', 'error');
    } finally {
      if (!(me && me.profileComplete)) {
        answerInput.value = '';
        await loadChallenge(); // single-use token — refresh after every attempt
      }
      if (!cooling) submitBtn.disabled = false;
    }
  });

  // Render the form for the current auth state, then load the thread.
  (async function start() {
    me = await fetchMe();
    if (me && me.profileComplete) {
      // Logged in: drop the name field + math check; show identity.
      if (nameRow) nameRow.remove();
      if (challengeEl) challengeEl.remove();
      const asEl = document.createElement('div');
      asEl.className = 'cf-as';
      const img = document.createElement('img');
      img.src = me.avatarUrl;
      img.alt = '';
      const span = document.createElement('span');
      span.textContent = `Commenting as ${me.username}`;
      asEl.append(img, span);
      form.prepend(asEl);
    } else {
      // Logged out: keep name + anon + math check, add a sign-in nudge.
      const hint = document.createElement('p');
      hint.className = 'cf-hint';
      const a = document.createElement('a');
      a.href = '/login.html';
      a.textContent = 'Sign in';
      hint.append(a, document.createTextNode(' to comment as yourself, or post below.'));
      form.prepend(hint);
      await loadChallenge();
    }
    await loadComments();
  }());
}
