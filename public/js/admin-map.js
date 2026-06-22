// Renders a minimalist equirectangular bubble map of viewers / subscribers /
// blocked traffic by country into an <svg viewBox="0 0 360 180">. Bubbles are
// placed at country centroids, sized by count, coloured by the theme accent.
import { CENTROIDS, flagIcon, project } from './world-data.js';
import { WORLD_LAND } from './world-map-paths.js';

const SVGNS = 'http://www.w3.org/2000/svg';

function el(tag, attrs) {
  const node = document.createElementNS(SVGNS, tag);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

// Draw the continents once as a base layer (behind bubbles, above the graticule)
// so the map reads as a world even before any viewer data arrives.
function ensureLand(svg) {
  if (svg.querySelector('.land')) return;
  const path = el('path', { class: 'land', d: WORLD_LAND });
  const graticule = svg.querySelector('#graticule');
  if (graticule && graticule.nextSibling) svg.insertBefore(path, graticule.nextSibling);
  else svg.appendChild(path);
}

/**
 * renderMap(svg, counts, { onHover }) — counts is { CC: number }. onHover
 * receives an HTML string (flag icon + label) or '' on mouse-leave.
 * Returns the list of country codes that had data but no centroid (unmapped).
 */
export function renderMap(svg, counts, { onHover } = {}) {
  ensureLand(svg);
  // Clear previous bubbles (keep the static graticule + land base layers).
  [...svg.querySelectorAll('.bubble')].forEach((n) => n.remove());

  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  const max = entries.reduce((m, [, n]) => Math.max(m, n), 0) || 1;
  const unmapped = [];

  for (const [cc, n] of entries) {
    const c = CENTROIDS[cc];
    if (!c) { unmapped.push(cc); continue; }
    const { x, y } = project(c[0], c[1]);
    const r = 2 + 7 * Math.sqrt(n / max); // area ∝ count

    const g = el('g', { class: 'bubble' });
    const dot = el('circle', {
      cx: x, cy: y, r,
      fill: 'var(--accent)', 'fill-opacity': 0.55,
      stroke: 'var(--accent)', 'stroke-width': 0.4,
    });
    g.appendChild(dot);
    g.style.cursor = 'pointer';
    const text = `${cc} · ${n.toLocaleString()}`;
    const html = `${flagIcon(cc)} ${text}`;
    g.addEventListener('mouseenter', () => { dot.setAttribute('fill-opacity', '0.85'); onHover && onHover(html); });
    g.addEventListener('mouseleave', () => { dot.setAttribute('fill-opacity', '0.55'); onHover && onHover(''); });
    const title = el('title', {}); // SVG <title> is text-only
    title.textContent = text;
    g.appendChild(title);
    svg.appendChild(g);
  }
  return unmapped;
}
