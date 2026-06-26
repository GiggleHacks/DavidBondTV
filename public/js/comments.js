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

// Only embed GIFs from Tenor (matches the server-side allowlist) — defense in
// depth so a tampered stored value can't inject an arbitrary image.
function isTenorGif(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:'
      && (x.hostname === 'tenor.com' || x.hostname.endsWith('.tenor.com'))
      && x.pathname.toLowerCase().endsWith('.gif');
  } catch { return false; }
}

// ISO-2 country code → normalized lowercase code, or '' if invalid.
// (Emoji flags don't render on Windows / most Android browsers, so we use
// self-hosted SVGs under /vendor/flags/4x3 — the same set the admin UI uses.)
function flagCode(cc) {
  const up = typeof cc === 'string' ? cc.toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(up)) return '';
  return up.toLowerCase();
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
  let pendingGif = null; // { url, preview } chosen from the GIF picker, or null

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

  // Shared POST path for both the top-level form and inline reply boxes — keeps
  // auth, anti-spam, and challenge handling in one place. Returns { res, data }.
  async function postComment({ text, gif, parentId, name, anonymous, answer, token: tok, hp }) {
    const res = await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video: VIDEO,
        name: name || '',
        anonymous: !!anonymous,
        text,
        gif,
        answer: answer || '',
        token: tok || token,
        parentId,
        hp: hp || '',
      }),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  // Build an inline reply composer. `rootId` is the thread root the reply attaches
  // to; `mentionName` pre-fills an @mention when replying to another reply. Anon
  // viewers get their own name field + a freshly fetched math challenge. On a
  // successful post `onPosted(comment)` runs so the caller can nest the new reply.
  function buildReplyBox(rootId, mentionName, onPosted) {
    const box = document.createElement('div');
    box.className = 'comment-reply-box';
    const authed = me && me.profileComplete;

    const ta = document.createElement('textarea');
    ta.className = 'cf-text'; ta.rows = 2; ta.maxLength = 1000;
    ta.placeholder = 'Add a reply…';
    if (mentionName) ta.value = `@${mentionName} `;
    box.append(ta);

    let nameInputR = null; let answerInputR = null; let boxToken = null;
    if (!authed) {
      const row = document.createElement('div');
      row.className = 'crb-row';
      nameInputR = document.createElement('input');
      nameInputR.type = 'text'; nameInputR.className = 'cf-input'; nameInputR.placeholder = 'Your name'; nameInputR.maxLength = 60;
      const challenge = document.createElement('span');
      challenge.className = 'cf-challenge';
      const q = document.createElement('label'); q.className = 'crb-q'; q.textContent = '…';
      answerInputR = document.createElement('input');
      answerInputR.type = 'text'; answerInputR.className = 'cf-answer'; answerInputR.inputMode = 'numeric'; answerInputR.placeholder = '?'; answerInputR.maxLength = 4;
      challenge.append(q, answerInputR);
      row.append(nameInputR, challenge);
      box.append(row);
      // Fetch a dedicated single-use challenge for this reply box.
      fetch('/api/challenge').then((r) => r.json()).then((d) => { boxToken = d.token; q.textContent = d.question; }).catch(() => { q.textContent = 'Verification unavailable'; });
    }

    const msg = document.createElement('p'); msg.className = 'cf-msg'; msg.hidden = true;
    const actions = document.createElement('div');
    actions.className = 'crb-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'crb-cancel'; cancel.textContent = 'Cancel';
    const submit = document.createElement('button');
    submit.type = 'button'; submit.className = 'cf-submit sm'; submit.textContent = 'Reply';
    actions.append(cancel, submit);
    box.append(msg, actions);

    const setBoxMsg = (t, kind) => { if (!t) { msg.hidden = true; return; } msg.hidden = false; msg.textContent = t; msg.className = `cf-msg ${kind || ''}`.trim(); };
    cancel.addEventListener('click', () => box.remove());

    submit.addEventListener('click', async () => {
      const text = ta.value.trim();
      if (!text) { setBoxMsg('Please write a reply.', 'error'); return; }
      if (!authed && !(answerInputR && answerInputR.value.trim())) { setBoxMsg('Please answer the verification question.', 'error'); return; }
      submit.disabled = true; setBoxMsg('');
      try {
        const { res, data } = await postComment({
          text,
          parentId: rootId,
          name: nameInputR ? nameInputR.value : '',
          answer: answerInputR ? answerInputR.value : '',
          token: boxToken,
        });
        if (res.ok && data.ok && data.comment) {
          onPosted(data.comment);
          box.remove();
        } else if (res.status === 429) {
          setBoxMsg(data.error || "You're posting too fast. Please wait a moment.", 'error');
          submit.disabled = false;
        } else {
          setBoxMsg(data.error || 'Could not post your reply.', 'error');
          submit.disabled = false;
        }
      } catch {
        setBoxMsg('Network error — please try again.', 'error');
        submit.disabled = false;
      }
    });

    setTimeout(() => ta.focus(), 0);
    return box;
  }

  function makeCommentEl(c, opts = {}) {
    const isReply = !!opts.isReply;
    const li = document.createElement('li');
    li.className = isReply ? 'comment is-reply' : 'comment';
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

    // Commenter names are plain text — there are no public profiles to link to.
    const isAnon = !c.name || c.name === 'Anonymous';
    const nameEl = document.createElement('span');
    nameEl.className = `comment-name${isAnon && !c.username ? ' anon' : ''}`;
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

    const code = flagCode(c.country);
    if (code) {
      const flagEl = document.createElement('img');
      flagEl.className = 'comment-flag';
      flagEl.src = `/vendor/flags/4x3/${code}.svg`;
      flagEl.alt = c.country;
      flagEl.title = c.country;
      flagEl.loading = 'lazy';
      flagEl.addEventListener('error', () => flagEl.remove());
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

    // Optional GIF attachment (only render trusted Tenor URLs).
    if (c.gifUrl && isTenorGif(c.gifUrl)) {
      const gif = document.createElement('img');
      gif.className = 'comment-gif';
      gif.src = c.gifUrl; gif.alt = 'GIF'; gif.loading = 'lazy';
      body.append(gif);
    }

    // Action row: Reply (everyone) + admin moderation buttons.
    const actions = document.createElement('div');
    actions.className = 'comment-actions';
    const replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.className = 'comment-reply-btn';
    replyBtn.textContent = 'Reply';
    actions.append(replyBtn);
    if (amAdmin()) {
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'cmod-btn'; del.textContent = 'Delete';
      del.addEventListener('click', () => removeComment(c, li));
      actions.append(del);
      if (c.userId && !c.admin) {
        const ban = document.createElement('button');
        ban.type = 'button'; ban.className = 'cmod-btn danger'; ban.textContent = 'Ban author';
        ban.addEventListener('click', () => banAuthor(c));
        actions.append(ban);
      }
    }
    body.append(actions);

    if (isReply) {
      // Replying to a reply re-targets the thread root and @mentions the author.
      replyBtn.addEventListener('click', () => opts.onReply && opts.onReply(c));
    } else {
      // Thread root: a collapsible replies list + a show/hide toggle.
      const toggle = document.createElement('button');
      toggle.type = 'button'; toggle.className = 'comment-replies-toggle'; toggle.hidden = true;
      const repliesUl = document.createElement('ul');
      repliesUl.className = 'comment-replies'; repliesUl.hidden = true;
      body.append(toggle, repliesUl);

      let open = false;
      const setToggleLabel = () => {
        const n = repliesUl.querySelectorAll('.comment').length;
        if (n === 0) { toggle.hidden = true; repliesUl.hidden = true; return; }
        toggle.hidden = false;
        toggle.classList.toggle('open', open);
        const chev = document.createElement('span'); chev.className = 'chev'; chev.setAttribute('aria-hidden', 'true'); chev.textContent = '▾';
        const lab = document.createElement('span');
        lab.textContent = `${open ? 'Hide' : 'View'} ${n} ${n === 1 ? 'reply' : 'replies'}`;
        toggle.replaceChildren(chev, lab);
      };
      toggle.addEventListener('click', () => { open = !open; repliesUl.hidden = !open; setToggleLabel(); });

      const openReplyBox = (mentionName) => {
        const existing = body.querySelector('.comment-reply-box');
        if (existing) { existing.remove(); }
        const box = buildReplyBox(c.id, mentionName, (reply) => {
          repliesUl.append(makeCommentEl(reply, { isReply: true, onReply: (rc) => openReplyBox(rc.name) }));
          open = true; repliesUl.hidden = false;
          setToggleLabel();
          updateCount();
        });
        actions.after(box);
      };
      replyBtn.addEventListener('click', () => openReplyBox());

      for (const r of (c.replies || [])) {
        repliesUl.append(makeCommentEl(r, { isReply: true, onReply: (rc) => openReplyBox(rc.name) }));
      }
      setToggleLabel();
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
      else listEl.replaceChildren(...comments.map((c) => makeCommentEl(c)));
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

  // --- GIF picker (Tenor) -----------------------------------------------------
  function clearGif() {
    pendingGif = null;
    const pv = document.getElementById('cf-gifpreview');
    if (pv) { pv.hidden = true; const i = pv.querySelector('img'); if (i) i.src = ''; }
  }

  async function setupGifPicker() {
    // Probe availability; if Tenor isn't configured the feature stays hidden.
    let first;
    try { first = await (await fetch('/api/gifs/trending')).json(); } catch { return; }
    if (!first || !first.enabled) return;

    const bottom = form.querySelector('.cf-bottom');
    if (!bottom) return;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'cf-gif-btn'; btn.textContent = 'GIF';
    bottom.insertBefore(btn, submitBtn);

    // Chosen-GIF preview chip (shown above the bottom row).
    const preview = document.createElement('div');
    preview.id = 'cf-gifpreview'; preview.className = 'cf-gifpreview'; preview.hidden = true;
    const pImg = document.createElement('img'); pImg.alt = 'Selected GIF';
    const pRm = document.createElement('button');
    pRm.type = 'button'; pRm.className = 'cf-gif-remove'; pRm.setAttribute('aria-label', 'Remove GIF'); pRm.textContent = '×';
    pRm.addEventListener('click', clearGif);
    preview.append(pImg, pRm);
    form.insertBefore(preview, bottom);

    // Picker panel: search box + results grid.
    const panel = document.createElement('div');
    panel.className = 'cf-gifpanel'; panel.hidden = true;
    const search = document.createElement('input');
    search.type = 'text'; search.className = 'cf-gifsearch'; search.placeholder = 'Search GIFs…'; search.maxLength = 100;
    const grid = document.createElement('div'); grid.className = 'cf-gifgrid';
    const credit = document.createElement('div'); credit.className = 'cf-gifcredit'; credit.textContent = 'Powered by Tenor';
    panel.append(search, grid, credit);
    form.insertBefore(panel, bottom);

    function renderGifs(list) {
      grid.replaceChildren();
      const safe = (list || []).filter((g) => g && isTenorGif(g.url));
      if (!safe.length) {
        const e = document.createElement('div'); e.className = 'cf-gifempty'; e.textContent = 'No GIFs found.'; grid.append(e); return;
      }
      for (const g of safe) {
        const cell = document.createElement('button');
        cell.type = 'button'; cell.className = 'cf-gifcell';
        const im = document.createElement('img'); im.src = g.preview || g.url; im.alt = g.desc || 'GIF'; im.loading = 'lazy';
        cell.append(im);
        cell.addEventListener('click', () => {
          pendingGif = { url: g.url, preview: g.preview || g.url };
          pImg.src = pendingGif.preview; preview.hidden = false;
          panel.hidden = true;
        });
        grid.append(cell);
      }
    }
    renderGifs(first.gifs);

    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      const q = search.value.trim();
      timer = setTimeout(async () => {
        try {
          const url = q ? `/api/gifs/search?q=${encodeURIComponent(q)}` : '/api/gifs/trending';
          const r = await (await fetch(url)).json();
          renderGifs(r.gifs);
        } catch { /* ignore */ }
      }, 300);
    });

    btn.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) search.focus();
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (cooling) return;
    const text = textInput.value.trim();
    if (!text && !pendingGif) { setMsg('Please write a comment or pick a GIF.', 'error'); return; }
    const authed = me && me.profileComplete;
    if (!authed && !answerInput.value.trim()) {
      setMsg('Please answer the verification question.', 'error');
      return;
    }

    submitBtn.disabled = true;
    setMsg('');
    try {
      const { res, data } = await postComment({
        name: nameInput ? nameInput.value : '',
        anonymous: anonInput ? anonInput.checked : false,
        text,
        gif: pendingGif ? pendingGif.url : undefined,
        answer: answerInput.value,
        token,
        hp: (document.getElementById('cf-hp') || {}).value || '',
      });

      if (res.ok && data.ok) {
        if (data.comment) {
          const empty = listEl.querySelector('.comment-empty');
          if (empty) empty.remove();
          listEl.prepend(makeCommentEl(data.comment));
          updateCount();
        }
        textInput.value = '';
        answerInput.value = '';
        clearGif();
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
    setupGifPicker();
    await loadComments();
  }());
}
