// Interactive flat world map for the traffic panel — a dependency-free, Google-
// Maps-style alternative to the WebGL globe (admin-map.js). It renders an inline
// SVG of the public-domain Natural Earth land outline (world-map-paths.js) in the
// same 0..360 × 0..180 equirectangular space as world-data.js's project(), then
// plots one dot per marker. Pan by dragging, zoom toward the cursor with the
// scroll wheel (or the +/−/reset buttons). Exposes the SAME { dispose, update }
// contract as renderGlobe so admin-analytics can swap them.
import { WORLD_LAND } from './world-map-paths.js';
import { project } from './world-data.js';

const NS = 'http://www.w3.org/2000/svg';
const COLORS = { watch: '#22d3ee', subscriber: '#eab308', blocked: '#fb7185' };

// World extent + zoom limits (viewBox width in equirectangular units).
const FULL_W = 360, FULL_H = 180;
const MIN_VBW = 24;          // furthest zoom-in (360/24 = 15×)
const MAX_VBW = FULL_W;      // can't zoom out past the whole world
const WHEEL_STEP = 1.18;     // per wheel notch
const DRAG_THRESHOLD = 4;    // px before a press counts as a pan (vs a click)

function el(name, attrs = {}) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function renderFlatMap(container, markers = [], { onSelect, onHover } = {}) {
  if (!container) return { dispose() {}, update() {} };
  container.innerHTML = '';
  container.style.position = 'relative';

  // viewBox is the camera: shrink it to zoom, slide it to pan.
  const vb = { x: 0, y: 0, w: FULL_W, h: FULL_H };

  const svg = el('svg', {
    viewBox: `0 0 ${FULL_W} ${FULL_H}`, class: 'traffic-flatmap',
    preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'Interactive traffic map',
  });

  // Static base (ocean + graticule + land) — built once, zooms with the camera.
  const base = el('g', {});
  base.appendChild(el('rect', { x: 0, y: 0, width: FULL_W, height: FULL_H, fill: '#0a1626' }));
  const grid = el('g', { stroke: 'rgba(255,255,255,.06)', 'stroke-width': '0.4', 'vector-effect': 'non-scaling-stroke', fill: 'none' });
  for (let lon = 0; lon <= FULL_W; lon += 30) grid.appendChild(el('line', { x1: lon, y1: 0, x2: lon, y2: FULL_H, 'vector-effect': 'non-scaling-stroke' }));
  for (let lat = 0; lat <= FULL_H; lat += 30) grid.appendChild(el('line', { x1: 0, y1: lat, x2: FULL_W, y2: lat, 'vector-effect': 'non-scaling-stroke' }));
  base.appendChild(grid);
  base.appendChild(el('path', { d: WORLD_LAND, fill: 'rgba(74,222,128,.16)', stroke: 'rgba(74,222,128,.34)', 'stroke-width': '0.5', 'vector-effect': 'non-scaling-stroke' }));
  svg.appendChild(base);

  const dots = el('g', { class: 'flatmap-dots' });
  svg.appendChild(dots);
  container.appendChild(svg);

  // Zoom controls overlay.
  const ui = document.createElement('div');
  ui.className = 'flatmap-ui';
  ui.innerHTML = `
    <button type="button" data-act="in"  title="Zoom in"  aria-label="Zoom in">+</button>
    <button type="button" data-act="out" title="Zoom out" aria-label="Zoom out">−</button>
    <button type="button" data-act="reset" title="Reset view" aria-label="Reset view">⤢</button>`;
  container.appendChild(ui);
  const hint = document.createElement('div');
  hint.className = 'flatmap-hint';
  hint.textContent = 'Scroll to zoom · drag to pan';
  container.appendChild(hint);

  // Keep markers a constant on-screen size regardless of zoom.
  function markerScale() { return vb.w / FULL_W; }
  function applyMarkerScale() {
    const s = markerScale();
    dots.querySelectorAll('[data-r]').forEach((c) => {
      c.setAttribute('r', (parseFloat(c.getAttribute('data-r')) * s).toFixed(2));
    });
  }

  function apply() {
    svg.setAttribute('viewBox', `${vb.x.toFixed(3)} ${vb.y.toFixed(3)} ${vb.w.toFixed(3)} ${vb.h.toFixed(3)}`);
    applyMarkerScale();
    ui.querySelector('[data-act="out"]').disabled = vb.w >= MAX_VBW - 0.01;
    ui.querySelector('[data-act="in"]').disabled = vb.w <= MIN_VBW + 0.01;
  }

  // Clamp the camera so it never leaves the world rectangle.
  function clampPan() {
    vb.x = clamp(vb.x, 0, FULL_W - vb.w);
    vb.y = clamp(vb.y, 0, FULL_H - vb.h);
  }

  // Map a client (screen) point to scene (0..360 × 0..180) coordinates, honoring
  // the current viewBox + letterboxing from preserveAspectRatio.
  function toScene(clientX, clientY) {
    const pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const m = svg.getScreenCTM();
    return m ? pt.matrixTransform(m.inverse()) : { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 };
  }

  // Zoom by `factor` (>1 zooms out) keeping the scene point under (cx,cy) fixed.
  function zoomAt(cx, cy, factor) {
    const focus = toScene(cx, cy);
    let nw = clamp(vb.w * factor, MIN_VBW, MAX_VBW);
    let nh = nw / 2;                         // keep the world's 2:1 aspect
    vb.x = focus.x - (focus.x - vb.x) * (nw / vb.w);
    vb.y = focus.y - (focus.y - vb.y) * (nh / vb.h);
    vb.w = nw; vb.h = nh;
    clampPan();
    apply();
  }

  // ---- wheel zoom -------------------------------------------------------
  const onWheel = (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1 / WHEEL_STEP : WHEEL_STEP);
  };
  svg.addEventListener('wheel', onWheel, { passive: false });

  // ---- drag to pan ------------------------------------------------------
  let dragging = null;   // { startX, startY, vbx, vby, moved }
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    dragging = { startX: e.clientX, startY: e.clientY, vbx: vb.x, vby: vb.y, moved: false };
    svg.setPointerCapture?.(e.pointerId);
    svg.classList.add('is-panning');
  };
  const onPointerMove = (e) => {
    if (!dragging) return;
    const a = toScene(dragging.startX, dragging.startY);
    const b = toScene(e.clientX, e.clientY);
    if (!dragging.moved && Math.hypot(e.clientX - dragging.startX, e.clientY - dragging.startY) > DRAG_THRESHOLD) dragging.moved = true;
    vb.x = dragging.vbx - (b.x - a.x);
    vb.y = dragging.vby - (b.y - a.y);
    clampPan();
    apply();
  };
  const endDrag = (e) => {
    if (!dragging) return;
    try { svg.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    // Suppress the click that follows a real pan so we don't select a marker.
    if (dragging.moved) { suppressClickUntil = Date.now() + 250; }
    dragging = null;
    svg.classList.remove('is-panning');
  };
  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  let suppressClickUntil = 0;

  // ---- zoom buttons -----------------------------------------------------
  const onUiClick = (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const rect = svg.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    if (btn.dataset.act === 'in') zoomAt(cx, cy, 1 / (WHEEL_STEP * WHEEL_STEP));
    else if (btn.dataset.act === 'out') zoomAt(cx, cy, WHEEL_STEP * WHEEL_STEP);
    else { vb.x = 0; vb.y = 0; vb.w = FULL_W; vb.h = FULL_H; apply(); }
  };
  ui.addEventListener('click', onUiClick);

  // ---- markers ----------------------------------------------------------
  function build(list) {
    dots.replaceChildren();
    const coords = (list || []).filter((m) => typeof m.lat === 'number' && typeof m.lon === 'number');
    coords.forEach((marker) => {
      const { x, y } = project(marker.lat, marker.lon);
      const color = marker.type === 'blocked' ? COLORS.blocked : marker.subscriber ? COLORS.subscriber : COLORS.watch;
      const g = el('g', { class: 'flatmap-dot', transform: `translate(${x} ${y})`, tabindex: '0' });
      g.appendChild(el('circle', { 'data-r': '3.4', r: '3.4', fill: color, opacity: '0.18' }));   // halo
      g.appendChild(el('circle', { 'data-r': '1.6', r: '1.6', fill: color }));                     // core
      g.appendChild(el('circle', { 'data-r': '5', r: '5', fill: 'transparent', class: 'flatmap-hit' })); // hit area
      g.addEventListener('mouseenter', () => onHover && onHover(marker));
      g.addEventListener('mouseleave', () => onHover && onHover(null));
      g.addEventListener('focus', () => onHover && onHover(marker));
      g.addEventListener('click', () => { if (Date.now() < suppressClickUntil) return; onSelect && onSelect(marker); });
      g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect && onSelect(marker); } });
      dots.appendChild(g);
    });
    applyMarkerScale();
  }
  build(markers);
  apply();

  return {
    dispose() {
      svg.removeEventListener('wheel', onWheel);
      container.innerHTML = '';
      container.style.position = '';
    },
    update(next) { build(next || []); },
  };
}
