// Flat 2D world map for the traffic panel — a dependency-free alternative to the
// WebGL globe (admin-map.js). Renders an inline SVG using the public-domain Natural
// Earth land outline (world-map-paths.js) in the same 0..360 × 0..180 equirectangular
// viewBox as world-data.js's project(), then plots one dot per marker. Exposes the
// SAME { dispose, update } contract as renderGlobe so admin-analytics can swap them.
import { WORLD_LAND } from './world-map-paths.js';
import { project } from './world-data.js';

const NS = 'http://www.w3.org/2000/svg';
const COLORS = { watch: '#22d3ee', subscriber: '#eab308', blocked: '#fb7185' };

function el(name, attrs = {}) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

export function renderFlatMap(container, markers = [], { onSelect, onHover } = {}) {
  if (!container) return { dispose() {}, update() {} };
  container.innerHTML = '';

  const svg = el('svg', {
    viewBox: '0 0 360 180', class: 'traffic-flatmap',
    preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': 'Traffic map',
  });

  // Ocean + graticule + landmass.
  svg.appendChild(el('rect', { x: 0, y: 0, width: 360, height: 180, fill: '#0a1626' }));
  const grid = el('g', { stroke: 'rgba(255,255,255,.06)', 'stroke-width': '0.4', fill: 'none' });
  for (let lon = 0; lon <= 360; lon += 30) grid.appendChild(el('line', { x1: lon, y1: 0, x2: lon, y2: 180 }));
  for (let lat = 0; lat <= 180; lat += 30) grid.appendChild(el('line', { x1: 0, y1: lat, x2: 360, y2: lat }));
  svg.appendChild(grid);
  svg.appendChild(el('path', { d: WORLD_LAND, fill: 'rgba(74,222,128,.16)', stroke: 'rgba(74,222,128,.30)', 'stroke-width': '0.25' }));

  const dots = el('g', { class: 'flatmap-dots' });
  svg.appendChild(dots);
  container.appendChild(svg);

  function build(list) {
    dots.replaceChildren();
    const coords = (list || []).filter((m) => typeof m.lat === 'number' && typeof m.lon === 'number');
    coords.forEach((marker) => {
      const { x, y } = project(marker.lat, marker.lon);
      const color = marker.type === 'blocked' ? COLORS.blocked : marker.subscriber ? COLORS.subscriber : COLORS.watch;
      const g = el('g', { class: 'flatmap-dot', transform: `translate(${x} ${y})`, tabindex: '0' });
      g.appendChild(el('circle', { r: '3.2', fill: color, opacity: '0.18' }));      // halo
      g.appendChild(el('circle', { r: '1.5', fill: color }));                        // core
      g.appendChild(el('circle', { r: '5', fill: 'transparent', class: 'flatmap-hit' })); // hit area
      g.addEventListener('mouseenter', () => onHover && onHover(marker));
      g.addEventListener('mouseleave', () => onHover && onHover(null));
      g.addEventListener('focus', () => onHover && onHover(marker));
      g.addEventListener('click', () => onSelect && onSelect(marker));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect && onSelect(marker); } });
      dots.appendChild(g);
    });
  }
  build(markers);

  return {
    dispose() { container.innerHTML = ''; },
    update(next) { build(next || []); },
  };
}
