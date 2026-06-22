// Per-video like / dislike bar. Counts are public; voting requires login
// (anonymous click shows a sign-in hint). Renders into #reactions.
import { postJSON, getJSON } from './account.js';

const THUMB_UP = '<svg viewBox="0 0 24 24"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-1z"/></svg>';
const THUMB_DOWN = '<svg viewBox="0 0 24 24"><path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z"/></svg>';

export function initReactions(videoId) {
  const mount = document.getElementById('reactions');
  if (!mount) return;
  const video = videoId || 'bikinis';

  const likeBtn = document.createElement('button');
  likeBtn.type = 'button';
  likeBtn.className = 'react-btn react-like';
  const dislikeBtn = document.createElement('button');
  dislikeBtn.type = 'button';
  dislikeBtn.className = 'react-btn react-dislike';
  const hint = document.createElement('span');
  hint.className = 'react-hint';
  hint.hidden = true;

  function paint(state) {
    likeBtn.innerHTML = `${THUMB_UP}<span>${state.likes}</span>`;
    dislikeBtn.innerHTML = `${THUMB_DOWN}<span>${state.dislikes}</span>`;
    likeBtn.classList.toggle('active', state.mine === 1);
    dislikeBtn.classList.toggle('active', state.mine === -1);
  }

  async function vote(v) {
    const r = await postJSON('/api/reactions', { video, vote: v });
    if (r.ok && r.data.ok) {
      hint.hidden = true;
      paint(r.data);
    } else if (r.status === 401) {
      hint.replaceChildren();
      const a = document.createElement('a');
      a.href = '/login.html'; a.textContent = 'Sign in';
      hint.append(a, document.createTextNode(' to like'));
      hint.hidden = false;
    }
  }

  likeBtn.addEventListener('click', () => vote(1));
  dislikeBtn.addEventListener('click', () => vote(-1));
  mount.append(likeBtn, dislikeBtn, hint);

  (async function start() {
    const state = await getJSON(`/api/reactions?video=${encodeURIComponent(video)}`);
    paint(state || { likes: 0, dislikes: 0, mine: 0 });
  }());
}
