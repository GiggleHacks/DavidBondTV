// Dedicated per-video edit page (/god-edit.html?v=<id>). Cookie-authenticated.
// Loads the video's manifest record and lets the admin change title,
// description, visibility (free/premium), category, and pick a thumbnail from
// frames auto-extracted across the clip. Categories can be created inline.
// Reuses the existing admin endpoint:
//   POST /api/admin/edit   { id, title, description, visibility, blur, category, thumb }
import { requireAdmin } from './god-auth.js';

const $ = (id) => document.getElementById(id);
const videoId = new URLSearchParams(location.search).get('v') || '';

function setMsg(text, kind) {
  const el = $('ev-msg');
  el.textContent = text || '';
  el.className = `ev-msg ${kind || ''}`.trim();
}

async function loadEntry(id) {
  try {
    const videos = await (await fetch(`/thumbs/videos.json?_=${Date.now()}`)).json();
    return Array.isArray(videos) ? videos.find((v) => v.id === id) || null : null;
  } catch { return null; }
}

function paintThumb(url) {
  const wrap = $('ev-thumb');
  const img = $('ev-thumb-img');
  if (url) {
    const bust = `${url}?_=${Date.now()}`;
    img.src = bust;
    img.style.display = '';
    wrap.style.setProperty('--thumb-bg', `url('${bust}')`);
  } else {
    img.removeAttribute('src');
    img.style.display = 'none';
    wrap.style.removeProperty('--thumb-bg');
  }
}

async function main() {
  await requireAdmin();
  const entry = videoId ? await loadEntry(videoId) : null;
  if (!entry) { $('edit-missing').classList.remove('hidden'); return; }

  $('edit-body').classList.remove('hidden');
  document.title = `Edit · ${entry.title || entry.id} — David Bond TV`;
  $('ev-title').value = entry.title || '';
  $('ev-desc').value = entry.description || '';
  paintThumb(entry.thumb);
  $('ev-view').href = `/watch?v=${encodeURIComponent(entry.id)}`;
  $('ev-analytics').href = `/god-analytics.html?v=${encodeURIComponent(entry.id)}`;

  // Visibility (Free/Premium) + thumbnail blur. Blur only matters for Premium,
  // so its field is shown only when Premium is selected.
  const vis = entry.visibility === 'premium' ? 'premium' : 'free';
  const visEl = document.querySelector(`input[name="ev-vis"][value="${vis}"]`);
  if (visEl) visEl.checked = true;
  $('ev-blur').value = ['strong', 'medium', 'off'].includes(entry.blur) ? entry.blur
    : (vis === 'premium' ? 'medium' : 'off');
  const currentVis = () => (document.querySelector('input[name="ev-vis"]:checked') || {}).value || 'free';
  const syncBlur = () => $('ev-blur-field').classList.toggle('hidden', currentVis() !== 'premium');
  document.querySelectorAll('input[name="ev-vis"]').forEach((r) => r.addEventListener('change', syncBlur));
  syncBlur();

  // Category — editable dropdown populated from the registry, with inline create.
  // Saved together with the rest of the form (POST /api/admin/edit { category }).
  const catSel = $('ev-category');
  function paintCats(cats, selected) {
    catSel.replaceChildren();
    const u = document.createElement('option');
    u.value = ''; u.textContent = 'Uncategorized';
    catSel.appendChild(u);
    for (const c of cats) {
      const o = document.createElement('option');
      o.value = c.slug; o.textContent = c.name;
      catSel.appendChild(o);
    }
    catSel.value = selected || '';
  }
  async function loadCats(selected) {
    try {
      const { categories: cats } = await (await fetch('/api/categories')).json();
      paintCats(cats || [], selected);
    } catch { paintCats([], selected); }
  }
  await loadCats(entry.category || '');

  function setCatMsg(text, kind) {
    const el = $('ev-cat-msg');
    el.textContent = text || '';
    el.className = kind || '';
  }
  $('ev-cat-add').addEventListener('click', async () => {
    const input = $('ev-cat-new');
    const name = input.value.trim();
    if (!name) return;
    const btn = $('ev-cat-add'); btn.disabled = true; setCatMsg('');
    try {
      const res = await fetch('/api/admin/categories', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', name }),
      });
      if (res.status === 401) { location.reload(); return; }
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.ok) {
        // Repopulate from the authoritative list and select the new category.
        paintCats(d.categories || [], d.category ? d.category.slug : catSel.value);
        input.value = '';
        setCatMsg(`Added “${d.category ? d.category.name : name}” — remember to Save changes.`, 'ok');
      } else setCatMsg(d.error || 'Could not add category.', 'error');
    } catch { setCatMsg('Network error.', 'error'); }
    finally { btn.disabled = false; }
  });

  // Scheduled-drip status + a one-click "Publish now" (reuses the bulk endpoint).
  if (typeof entry.publishAt === 'number' && entry.publishAt > Date.now()) {
    $('ev-sched-field').classList.remove('hidden');
    $('ev-sched-text').textContent = `Scheduled to publish ${new Date(entry.publishAt).toLocaleString()}.`;
    $('ev-publish-now').addEventListener('click', async () => {
      const btn = $('ev-publish-now'); btn.disabled = true;
      try {
        const res = await fetch('/api/admin/bulk', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [entry.id], action: 'publish' }),
        });
        if (res.status === 401) { location.reload(); return; }
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          entry.publishAt = null; entry.published = true;
          $('ev-sched-field').classList.add('hidden');
          setMsg('Published.', 'ok');
        } else setMsg(data.error || 'Could not publish.', 'error');
      } catch { setMsg('Network error.', 'error'); }
      finally { btn.disabled = false; }
    });
  }

  // Candidate thumbnails — auto-generated from frames across the clip. Click one
  // to make it the active thumbnail (POST /api/admin/edit { thumb }). Videos
  // uploaded before this feature simply have no candidates → grid stays hidden.
  const cands = Array.isArray(entry.thumbCandidates) ? entry.thumbCandidates : [];
  async function selectCandidate(url, btn) {
    if (url === entry.thumb) return;
    try {
      const res = await fetch('/api/admin/edit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: entry.id, thumb: url }),
      });
      if (res.status === 401) { location.reload(); return; }
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        entry.thumb = url;
        paintThumb(url);
        $('ev-candidates').querySelectorAll('.ev-cand').forEach((el) => el.classList.remove('selected'));
        btn.classList.add('selected');
        setMsg('Thumbnail updated.', 'ok');
      } else setMsg(data.error || 'Could not set thumbnail.', 'error');
    } catch { setMsg('Network error.', 'error'); }
  }
  if (cands.length) {
    $('ev-candidates').replaceChildren(...cands.map((url) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `ev-cand${url === entry.thumb ? ' selected' : ''}`;
      const img = document.createElement('img');
      img.src = url; img.alt = '';
      b.append(img);
      b.addEventListener('click', () => selectCandidate(url, b));
      return b;
    }));
  } else {
    // Older uploads predate frame-candidate generation — explain rather than
    // offering a custom upload (thumbnails come only from video frames now).
    $('ev-cands-none').classList.remove('hidden');
  }

  // Save title + description.
  $('ev-save').addEventListener('click', async () => {
    const btn = $('ev-save');
    btn.disabled = true; setMsg('Saving…');
    try {
      const visibility = currentVis();
      const res = await fetch('/api/admin/edit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: entry.id, title: $('ev-title').value, description: $('ev-desc').value,
          visibility, blur: $('ev-blur').value, category: catSel.value,
        }),
      });
      if (res.status === 401) { location.reload(); return; }
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        entry.title = $('ev-title').value.trim();
        entry.visibility = visibility; entry.blur = $('ev-blur').value;
        entry.category = catSel.value;
        setMsg('Saved.', 'ok');
      }
      else setMsg(data.error || 'Save failed.', 'error');
    } catch { setMsg('Network error.', 'error'); }
    finally { btn.disabled = false; }
  });
}
main();
