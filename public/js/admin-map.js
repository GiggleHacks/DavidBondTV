// Renders a minimalist equirectangular bubble map of viewers / subscribers /
// blocked traffic by country into an <svg viewBox="0 0 360 180">. Bubbles are
// placed at country centroids, sized by count, coloured by the theme accent.
import { CENTROIDS, flagEmoji, project } from './world-data.js';

const SVGNS = 'http://www.w3.org/2000/svg';

function el(tag, attrs) {
  const node = document.createElementNS(SVGNS, tag);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

/**
 * renderMap(svg, counts, { onHover }) — counts is { CC: number }.
 * Returns the list of country codes that had data but no centroid (unmapped).
 */
export function renderMap(svg, counts, { onHover } = {}) {
  // Clear previous bubbles (keep the static graticule layer with id="graticule").
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
    const label = `${flagEmoji(cc)} ${cc} · ${n.toLocaleString()}`;
    g.addEventListener('mouseenter', () => { dot.setAttribute('fill-opacity', '0.85'); onHover && onHover(label); });
    g.addEventListener('mouseleave', () => { dot.setAttribute('fill-opacity', '0.55'); onHover && onHover(''); });
    const title = el('title', {});
    title.textContent = label;
    g.appendChild(title);
    svg.appendChild(g);
  }
  return unmapped;
}
