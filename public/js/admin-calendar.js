// Publishing calendar for the Videos page. Renders a month grid of scheduled
// video publications (manifest entries with a future numeric `publishAt`), plus
// an "Upcoming" list with exact dates/times. Pure view layer: it's handed the
// already-loaded video list and an onSelect callback (used to open the editor).
//
//   const cal = createCalendar(container, { onSelect });
//   cal.update(videos);   // re-render with the latest library snapshot

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ymd = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (d) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

// A scheduled video = published:false + a future publishAt. All pending slots
// are shown regardless of approval/encoding state so the calendar reflects the
// full planned schedule. (releaseScheduled() still guards approval+ready before
// actually publishing.)
export function scheduledVideos(videos) {
  const now = Date.now();
  return (videos || [])
    .filter((v) => typeof v.publishAt === 'number' && v.publishAt > now
      && v.published === false)
    .sort((a, b) => a.publishAt - b.publishAt);
}

export function createCalendar(container, { onSelect } = {}) {
  let videos = [];
  const today = new Date();
  let view = new Date(today.getFullYear(), today.getMonth(), 1);

  function byDay(list) {
    const map = new Map();
    for (const v of list) {
      const key = ymd(new Date(v.publishAt));
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(v);
    }
    return map;
  }

  function render() {
    const sched = scheduledVideos(videos);
    const map = byDay(sched);
    const year = view.getFullYear();
    const month = view.getMonth();
    const first = new Date(year, month, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayKey = ymd(new Date());

    const cells = [];
    for (let i = 0; i < startPad; i += 1) cells.push('<div class="cal-cell cal-pad"></div>');
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = new Date(year, month, day);
      const key = ymd(date);
      const items = map.get(key) || [];
      const isToday = key === todayKey;
      const chips = items.map((v) => {
        const isReady = (v.approval || 'approved') === 'approved' && (v.status || 'ready') === 'ready';
        const badgeLabel = !isReady ? ((v.approval || 'approved') !== 'approved' ? 'review' : 'encoding') : null;
        return `
        <button type="button" class="cal-chip${isReady ? '' : ' cal-chip--pending'}" data-vid="${esc(v.id)}" title="${esc(v.title || v.id)} — ${esc(fmtTime(new Date(v.publishAt)))}">
          <span class="cal-chip-time">${esc(fmtTime(new Date(v.publishAt)))}</span>
          <span class="cal-chip-title">${esc(v.title || v.id)}</span>
          ${badgeLabel ? `<span class="cal-chip-badge">${badgeLabel}</span>` : ''}
        </button>`;
      }).join('');
      cells.push(`<div class="cal-cell${isToday ? ' is-today' : ''}${items.length ? ' has-items' : ''}">
        <span class="cal-daynum">${day}</span>
        <div class="cal-chips">${chips}</div>
      </div>`);
    }
    // Pad the trailing week so the grid stays rectangular.
    while (cells.length % 7 !== 0) cells.push('<div class="cal-cell cal-pad"></div>');

    const dowHead = DOW.map((d) => `<div class="cal-dow">${d}</div>`).join('');

    const upcoming = sched.length
      ? sched.map((v) => {
        const d = new Date(v.publishAt);
        const isReady = (v.approval || 'approved') === 'approved' && (v.status || 'ready') === 'ready';
        const badgeLabel = !isReady ? ((v.approval || 'approved') !== 'approved' ? 'review' : 'encoding') : null;
        return `<li class="cal-up-item${isReady ? '' : ' cal-up-item--pending'}" data-vid="${esc(v.id)}" role="button" tabindex="0">
          <span class="cal-up-when">${esc(fmtDay(d))} · ${esc(fmtTime(d))}</span>
          <span class="cal-up-title">${esc(v.title || v.id)}</span>
          ${badgeLabel ? `<span class="cal-chip-badge">${badgeLabel}</span>` : ''}
          ${v.visibility === 'premium' ? '<span class="vb vb-prem">Premium</span>' : ''}
        </li>`;
      }).join('')
      : '<li class="cal-up-empty muted">No videos are scheduled. Set a publish date when uploading to see it here.</li>';

    container.innerHTML = `
      <div class="cal-wrap">
        <div class="cal-main">
          <div class="cal-bar">
            <button type="button" class="btn sm ghost" data-cal="prev" aria-label="Previous month">‹</button>
            <div class="cal-month">${MONTHS[month]} ${year}</div>
            <button type="button" class="btn sm ghost" data-cal="next" aria-label="Next month">›</button>
            <button type="button" class="btn sm ghost cal-today" data-cal="today">Today</button>
          </div>
          <div class="cal-grid cal-dow-row">${dowHead}</div>
          <div class="cal-grid cal-days">${cells.join('')}</div>
        </div>
        <aside class="cal-side">
          <h3 class="cal-side-title">Upcoming <span class="muted">(${sched.length})</span></h3>
          <ul class="cal-up-list">${upcoming}</ul>
        </aside>
      </div>`;

    container.querySelector('[data-cal="prev"]').addEventListener('click', () => { view = new Date(year, month - 1, 1); render(); });
    container.querySelector('[data-cal="next"]').addEventListener('click', () => { view = new Date(year, month + 1, 1); render(); });
    container.querySelector('[data-cal="today"]').addEventListener('click', () => { view = new Date(today.getFullYear(), today.getMonth(), 1); render(); });

    const pick = (id) => { const v = sched.find((x) => x.id === id); if (v && onSelect) onSelect(v); };
    container.querySelectorAll('.cal-chip').forEach((b) => b.addEventListener('click', () => pick(b.dataset.vid)));
    container.querySelectorAll('.cal-up-item').forEach((li) => {
      li.addEventListener('click', () => pick(li.dataset.vid));
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(li.dataset.vid); } });
    });
  }

  render();
  return {
    update(list) { videos = list || []; render(); },
  };
}
