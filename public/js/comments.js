// Comments UI: loads + posts comments against the backend API, with a signed
// math human-check and friendly handling of validation / rate-limit errors.
// All user text is rendered via textContent (never innerHTML) — XSS-safe.

const VIDEO = 'bikinis';

function relativeTime(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function avatarColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 45%)`;
}

export function initComments() {
  const form = document.getElementById('comment-form');
  if (!form) return;

  const nameInput = document.getElementById('cf-name');
  const anonInput = document.getElementById('cf-anon');
  const textInput = document.getElementById('cf-text');
  const answerInput = document.getElementById('cf-answer');
  const questionEl = document.getElementById('cf-question');
  const msgEl = document.getElementById('cf-msg');
  const submitBtn = document.getElementById('cf-submit');
  const listEl = document.getElementById('comment-list');
  const countEl = document.getElementById('comment-count');

  let token = null;

  function setMsg(text, kind) {
    if (!text) { msgEl.hidden = true; return; }
    msgEl.hidden = false;
    msgEl.textContent = text;
    msgEl.className = `cf-msg ${kind || ''}`.trim();
  }

  function updateCount() {
    const n = listEl.querySelectorAll('.comment').length;
    countEl.textContent = String(n);
  }

  function makeCommentEl(c) {
    const isAnon = c.name === 'Anonymous';
    const li = document.createElement('li');
    li.className = 'comment';

    const avatar = document.createElement('div');
    avatar.className = 'comment-avatar';
    avatar.style.background = isAnon ? '#5a5a5a' : avatarColor(c.name);
    avatar.textContent = isAnon ? '?' : c.name.trim().charAt(0).toUpperCase() || '?';

    const body = document.createElement('div');
    body.className = 'comment-body';

    const head = document.createElement('div');
    head.className = 'comment-head';
    const nameEl = document.createElement('span');
    nameEl.className = `comment-name${isAnon ? ' anon' : ''}`;
    nameEl.textContent = c.name;
    const timeEl = document.createElement('span');
    timeEl.className = 'comment-time';
    timeEl.textContent = relativeTime(c.ts);
    head.append(nameEl, timeEl);

    const textEl = document.createElement('div');
    textEl.className = 'comment-text';
    textEl.textContent = c.text;

    body.append(head, textEl);
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
      if (comments.length === 0) {
        renderEmpty();
      } else {
        listEl.replaceChildren(...comments.map(makeCommentEl));
      }
      updateCount();
    } catch {
      renderEmpty();
    }
  }

  anonInput.addEventListener('change', () => {
    nameInput.disabled = anonInput.checked;
    if (anonInput.checked) nameInput.value = '';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textInput.value.trim();
    const answer = answerInput.value.trim();
    if (!text) { setMsg('Please write a comment first.', 'error'); return; }
    if (!answer) { setMsg('Please answer the verification question.', 'error'); return; }

    submitBtn.disabled = true;
    setMsg('');
    try {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video: VIDEO,
          name: nameInput.value,
          anonymous: anonInput.checked,
          text,
          answer,
          token,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.ok) {
        // Remove the "no comments yet" placeholder if present.
        const empty = listEl.querySelector('.comment-empty');
        if (empty) empty.remove();
        listEl.prepend(makeCommentEl(data.comment));
        updateCount();
        textInput.value = '';
        answerInput.value = '';
        setMsg('Comment posted!', 'ok');
      } else {
        setMsg(data.error || 'Could not post your comment.', 'error');
      }
    } catch {
      setMsg('Network error — please try again.', 'error');
    } finally {
      answerInput.value = '';
      await loadChallenge(); // each token is single-use; refresh after every attempt
      submitBtn.disabled = false;
    }
  });

  loadChallenge();
  loadComments();
}
