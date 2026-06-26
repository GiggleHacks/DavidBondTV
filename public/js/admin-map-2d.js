// Interactive flat world map for the traffic panel — a dependency-free, Google-
// Maps-style alternative to the WebGL globe (admin-map.js). It renders one inline
// SVG <path> per country (world-countries.js, Natural Earth 110m) in the same
// 0..360 × 0..180 equirectangular space as world-data.js's project(), so it can
// draw real borders, choropleth fills (by traffic count), and country labels —
// then plots one dot per marker on top. Pan by dragging, zoom toward the cursor
// with the wheel (or the +/−/reset buttons). Panning moves a single camera <g>
// transform (rAF-throttled, GPU-composited) instead of re-laying-out the viewBox,
// which keeps dragging smooth. Exposes the SAME { dispose, update } contract as
// renderGlobe so admin-analytics can swap them.
import { WORLD_COUNTRIES } from './world-countries.js';
import { project, flagIcon } from './world-data.js';

const NS = 'http://www.w3.org/2000/svg';
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COLORS = { watch: '#22d3ee', subscriber: '#eab308', blocked: '#fb7185' };

// Choropleth: untrafficked land stays neutral; trafficked countries tint toward
// the active mode's hue (intensity ∝ √share so a couple of big countries don't
// flatten everyone else). Markers sit on top in their own brighter colours.
const LAND_NEUTRAL = '#2b3a55';
const CHORO_BRIGHT = { viewers: '#38bdf8', subscribers: '#fbbf24', blocked: '#fb7185' };

// World extent + zoom limits (viewBox width in equirectangular units).
const FULL_W = 360, FULL_H = 180;
const MIN_VBW = 24;          // furthest zoom-in (360/24 = 15×)
const MAX_VBW = FULL_W;      // can't zoom out past the whole world
const WHEEL_STEP = 1.18;     // per wheel notch
const DRAG_THRESHOLD = 4;    // px before a press counts as a pan (vs a click)
const LABEL_ALL_SCALE = 2.6; // camera scale at/above which every country is labelled
const LABEL_MIN_AREA = 4;    // skip labelling tiny countries until well zoomed in

function el(name, attrs = {}) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hex = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
function mix(a, b, t) {
  const [ar, ag, ab] = hex(a), [br, bg, bb] = hex(b);
  const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
  return `rgb(${r},${g},${bl})`;
}

export function renderFlatMap(container, markers = [], opts = {}) {
  if (!container) return { dispose() {}, update() {} };
  const { onSelect, onHover } = opts;
  let counts = opts.counts || {};
  let mode = opts.mode || 'viewers';
  container.innerHTML = '';
  container.style.position = 'relative';

  // viewBox is the camera: shrink it to zoom, slide it to pan. Rather than rewrite
  // the SVG viewBox each frame, we map it onto a single <g> transform.
  const vb = { x: 0, y: 0, w: FULL_W, h: FULL_H };

  const svg = el('svg', {
    viewBox: `0 0 ${FULL_W} ${FULL_H}`, class: 'traffic-flatmap',
    preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'Interactive traffic map',
  });

  // Everything that pans/zooms lives under one camera group.
  const camera = el('g', { class: 'flatmap-cam' });
  svg.appendChild(camera);

  // Ocean. The camera is clamped to the world rectangle, so it only needs to cover
  // the world extent (plus a small bleed so edges never show a seam while panning).
  camera.appendChild(el('rect', { x: -8, y: -8, width: FULL_W + 16, height: FULL_H + 16, class: 'fm-ocean' }));
  // Graticule (subtle).
  const grid = el('g', { class: 'fm-grid', fill: 'none' });
  for (let lon = 0; lon <= FULL_W; lon += 30) grid.appendChild(el('line', { x1: lon, y1: 0, x2: lon, y2: FULL_H, 'vector-effect': 'non-scaling-stroke' }));
  for (let lat = 0; lat <= FULL_H; lat += 30) grid.appendChild(el('line', { x1: 0, y1: lat, x2: FULL_W, y2: lat, 'vector-effect': 'non-scaling-stroke' }));
  camera.appendChild(grid);

  // Countries — one path each (borders + choropleth fill), plus a labels layer.
  const landLayer = el('g', { class: 'fm-land' });
  const labelLayer = el('g', { class: 'fm-labels' });
  const countryNodes = []; // { cc, path }
  const labelNodes = [];   // { cc, area, text }
  for (const c of WORLD_COUNTRIES) {
    const path = el('path', { d: c.d, class: 'fm-country', 'vector-effect': 'non-scaling-stroke' });
    if (c.cc) path.dataset.cc = c.cc;
    landLayer.appendChild(path);
    countryNodes.push({ cc: c.cc, path });
    if (c.name && (c.area >= LABEL_MIN_AREA || c.cc)) {
      const t = el('text', { x: c.cx, y: c.cy, class: 'fm-label', 'text-anchor': 'middle' });
      t.textContent = c.name;
      labelLayer.appendChild(t);
      labelNodes.push({ cc: c.cc, area: c.area, text: t });
    }
  }
  camera.appendChild(landLayer);
  camera.appendChild(labelLayer);

  const dots = el('g', { class: 'flatmap-dots' });
  camera.appendChild(dots);
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

  // Floating hover tooltip (profile + IP + location), anchored to the hovered marker.
  const tip = document.createElement('div');
  tip.className = 'flatmap-tip';
  tip.hidden = true;
  container.appendChild(tip);
  let hovered = null; // { _x, _y } scene coords of the hovered marker

  // Info popup anchored to the selected marker (repositioned on every pan/zoom).
  const popup = document.createElement('div');
  popup.className = 'flatmap-popup';
  popup.hidden = true;
  container.appendChild(popup);
  let selected = null; // the selected marker (its lat/lon drives the popup)

  function labelFor(m) {
    return [m.city, m.region, m.country || m.cc].filter(Boolean).join(', ') || 'Unknown';
  }
  // Map a scene point (0..360 × 0..180) to a container-relative pixel position,
  // honouring the live camera transform + viewBox letterboxing.
  function sceneToClient(x, y) {
    const m = camera.getScreenCTM();
    if (!m) return null;
    const pt = svg.createSVGPoint(); pt.x = x; pt.y = y;
    const p = pt.matrixTransform(m);
    const rect = container.getBoundingClientRect();
    return { x: p.x - rect.left, y: p.y - rect.top };
  }
  function inView(x, y) { return x >= vb.x && x <= vb.x + vb.w && y >= vb.y && y <= vb.y + vb.h; }

  function showTip(marker) {
    const p = project(marker.lat, marker.lon);
    hovered = { _x: p.x, _y: p.y };
    const ip = marker.ip ? `<span class="ft-ip">${escHtml(marker.ip)}</span>` : '';
    tip.innerHTML = `<div class="ft-loc">${marker.cc ? flagIcon(marker.cc) : ''}<b>${escHtml(labelFor(marker))}</b></div>`
      + `<div class="ft-who">${escHtml(marker.username || 'Guest')}</div>`
      + (ip ? `<div class="ft-ipline">IP ${ip}</div>` : '');
    tip.hidden = false;
    positionTip();
  }
  function hideTip() { hovered = null; tip.hidden = true; }
  function positionTip() {
    if (!hovered || tip.hidden) return;
    const c = inView(hovered._x, hovered._y) ? sceneToClient(hovered._x, hovered._y) : null;
    if (c) { tip.style.display = ''; tip.style.left = `${c.x}px`; tip.style.top = `${c.y}px`; }
    else tip.style.display = 'none';
  }

  function positionPopup() {
    if (!selected || popup.hidden) return;
    const c = inView(selected._x, selected._y) ? sceneToClient(selected._x, selected._y) : null;
    if (c) { popup.style.display = ''; popup.style.left = `${c.x}px`; popup.style.top = `${c.y}px`; }
    else popup.style.display = 'none';
  }
  function openPopup(marker) {
    const p = project(marker.lat, marker.lon);
    selected = { ...marker, _x: p.x, _y: p.y };
    const extra = escHtml(marker.videoTitle || marker.reason || marker.ip || '');
    popup.innerHTML = `<button class="flatmap-popup-x" type="button" aria-label="Close">×</button>`
      + `<div class="gp-loc">${marker.cc ? flagIcon(marker.cc) : ''}<b>${escHtml(labelFor(marker))}</b></div>`
      + `<div class="gp-who">${escHtml(marker.username || 'Guest')}</div>`
      + (extra ? `<div class="gp-extra">${extra}</div>` : '');
    popup.hidden = false;
    popup.querySelector('.flatmap-popup-x').addEventListener('click', () => { selected = null; popup.hidden = true; });
    positionPopup();
  }

  // ---- camera ----------------------------------------------------------
  const camScale = () => FULL_W / vb.w;
  // Pan only: rewrite the camera transform + reposition overlays. Cheap enough to
  // run every frame; rAF-coalesced so a fast drag still maps to one update/frame.
  function renderCamera() {
    const s = camScale();
    camera.setAttribute('transform', `scale(${s.toFixed(5)}) translate(${(-vb.x).toFixed(4)} ${(-vb.y).toFixed(4)})`);
    positionTip();
    positionPopup();
  }
  // Keep markers + labels a constant on-screen size, toggle label de-clutter, and
  // refresh the zoom-button state. Only needed when the zoom (scale) changes.
  function onZoomChanged() {
    const s = camScale();
    dots.querySelectorAll('[data-r]').forEach((c) => {
      c.setAttribute('r', (parseFloat(c.getAttribute('data-r')) / s).toFixed(3));
    });
    labelLayer.style.fontSize = (4.4 / s).toFixed(3) + 'px';
    for (const l of labelNodes) {
      const show = (l.cc && counts[l.cc] > 0) || (s >= LABEL_ALL_SCALE && l.area >= LABEL_MIN_AREA);
      l.text.style.display = show ? '' : 'none';
    }
    ui.querySelector('[data-act="out"]').disabled = vb.w >= MAX_VBW - 0.01;
    ui.querySelector('[data-act="in"]').disabled = vb.w <= MIN_VBW + 0.01;
    renderCamera();
  }

  let rafPending = false;
  function schedulePan() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; renderCamera(); });
  }

  function clampPan() {
    vb.x = clamp(vb.x, 0, FULL_W - vb.w);
    vb.y = clamp(vb.y, 0, FULL_H - vb.h);
  }

  // Map a client (screen) point to scene coords using a given camera matrix.
  function toSceneWith(m, clientX, clientY) {
    const pt = svg.createSVGPoint(); pt.x = clientX; pt.y = clientY;
    return m ? pt.matrixTransform(m.inverse()) : { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 };
  }

  // Zoom by `factor` (>1 zooms out) keeping the scene point under (cx,cy) fixed.
  function zoomAt(cx, cy, factor) {
    const focus = toSceneWith(camera.getScreenCTM(), cx, cy);
    const nw = clamp(vb.w * factor, MIN_VBW, MAX_VBW);
    const nh = nw / 2;                       // keep the world's 2:1 aspect
    vb.x = focus.x - (focus.x - vb.x) * (nw / vb.w);
    vb.y = focus.y - (focus.y - vb.y) * (nh / vb.h);
    vb.w = nw; vb.h = nh;
    clampPan();
    onZoomChanged();
  }

  // ---- wheel zoom -------------------------------------------------------
  const onWheel = (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1 / WHEEL_STEP : WHEEL_STEP);
  };
  svg.addEventListener('wheel', onWheel, { passive: false });

  // ---- drag to pan ------------------------------------------------------
  // Cache the camera matrix at press time: the scale is constant during a drag, so
  // a start-frame matrix gives a stable screen→scene delta with no feedback loop.
  let dragging = null;
  let suppressClickUntil = 0;
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    dragging = { startX: e.clientX, startY: e.clientY, vbx: vb.x, vby: vb.y, m: camera.getScreenCTM(), moved: false };
    svg.setPointerCapture?.(e.pointerId);
    svg.classList.add('is-panning');
  };
  const onPointerMove = (e) => {
    if (!dragging) return;
    const a = toSceneWith(dragging.m, dragging.startX, dragging.startY);
    const b = toSceneWith(dragging.m, e.clientX, e.clientY);
    if (!dragging.moved && Math.hypot(e.clientX - dragging.startX, e.clientY - dragging.startY) > DRAG_THRESHOLD) dragging.moved = true;
    vb.x = dragging.vbx - (b.x - a.x);
    vb.y = dragging.vby - (b.y - a.y);
    clampPan();
    schedulePan();
  };
  const endDrag = (e) => {
    if (!dragging) return;
    try { svg.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    if (dragging.moved) suppressClickUntil = Date.now() + 250; // swallow the click after a real pan
    dragging = null;
    svg.classList.remove('is-panning');
  };
  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  // ---- zoom buttons -----------------------------------------------------
  const onUiClick = (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const rect = svg.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    if (btn.dataset.act === 'in') zoomAt(cx, cy, 1 / (WHEEL_STEP * WHEEL_STEP));
    else if (btn.dataset.act === 'out') zoomAt(cx, cy, WHEEL_STEP * WHEEL_STEP);
    else { vb.x = 0; vb.y = 0; vb.w = FULL_W; vb.h = FULL_H; onZoomChanged(); }
  };
  ui.addEventListener('click', onUiClick);

  // ---- choropleth -------------------------------------------------------
  function paintChoropleth() {
    const bright = CHORO_BRIGHT[mode] || CHORO_BRIGHT.viewers;
    let max = 0;
    for (const k in counts) if (counts[k] > max) max = counts[k];
    for (const { cc, path } of countryNodes) {
      const n = cc ? (counts[cc] || 0) : 0;
      if (n > 0 && max > 0) {
        const t = 0.18 + 0.82 * Math.sqrt(n / max); // floor so even 1 hit reads as tinted
        path.setAttribute('fill', mix(LAND_NEUTRAL, bright, t));
        path.classList.add('has-traffic');
      } else {
        path.setAttribute('fill', LAND_NEUTRAL);
        path.classList.remove('has-traffic');
      }
    }
  }

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
      g.addEventListener('mouseenter', () => { showTip(marker); onHover && onHover(marker); });
      g.addEventListener('mouseleave', () => { hideTip(); onHover && onHover(null); });
      g.addEventListener('focus', () => { showTip(marker); onHover && onHover(marker); });
      g.addEventListener('blur', () => { hideTip(); onHover && onHover(null); });
      g.addEventListener('click', () => { if (Date.now() < suppressClickUntil) return; openPopup(marker); onSelect && onSelect(marker); });
      g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openPopup(marker); onSelect && onSelect(marker); } });
      dots.appendChild(g);
    });
  }

  build(markers);
  paintChoropleth();
  onZoomChanged();

  return {
    dispose() {
      svg.removeEventListener('wheel', onWheel);
      container.innerHTML = '';
      container.style.position = '';
    },
    update(next, nextOpts = {}) {
      selected = null; popup.hidden = true; hideTip();
      if (nextOpts.counts) counts = nextOpts.counts;
      if (nextOpts.mode) mode = nextOpts.mode;
      build(next || []);
      paintChoropleth();
      onZoomChanged();
    },
  };
}
