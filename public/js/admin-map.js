import * as THREE from '../vendor/three/three.module.js';
import { OrbitControls } from '../vendor/three/addons/controls/OrbitControls.js';
import { flagIcon } from './world-data.js';
import { WORLD_LAND } from './world-map-paths.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Hub the live traffic arcs flow toward — roughly the US (where the origin lives).
const HUB = [38, -97];
const COLORS = { watch: 0x22d3ee, subscriber: 0xeab308, blocked: 0xfb7185 };

function latLonToVector(lat, lon, radius = 2.02) {
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (lon + 180) * Math.PI / 180;
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

// Bake a detailed equirectangular Earth onto a canvas: ocean gradient + a 15°
// graticule + the real Natural Earth coastlines (WORLD_LAND, the same vector data
// the flat map uses). The path lives in a 0..360 × 0..180 space (x = lon+180,
// y = 90−lat) — exactly the sphere's UV mapping — so a uniform scale onto the
// canvas lines the continents up perfectly with the lat/lon markers.
function earthTexture() {
  const W = 2048, H = 1024;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');

  // Ocean — slightly darker toward the poles for depth.
  const sea = g.createLinearGradient(0, 0, 0, H);
  sea.addColorStop(0, '#06121f'); sea.addColorStop(.5, '#0c2336'); sea.addColorStop(1, '#06121f');
  g.fillStyle = sea; g.fillRect(0, 0, W, H);

  // Graticule (every 15°), with a brighter equator + prime meridian.
  g.strokeStyle = 'rgba(120,170,210,.10)'; g.lineWidth = 1;
  for (let lon = 0; lon <= 360; lon += 15) { const x = lon / 360 * W; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let lat = 0; lat <= 180; lat += 15) { const y = lat / 180 * H; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  g.strokeStyle = 'rgba(120,170,210,.20)'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();   // equator
  g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.stroke();   // prime meridian

  // Real coastlines over the top (land drawn last so it sits above the graticule).
  g.save();
  g.scale(W / 360, H / 180);
  const land = new Path2D(WORLD_LAND);
  g.fillStyle = 'rgba(48,165,102,.58)';
  g.fill(land);
  g.lineJoin = 'round';
  g.lineWidth = 0.5;
  g.strokeStyle = 'rgba(126,232,176,.75)';
  g.stroke(land);
  g.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function fallback(container, markers, onSelect) {
  container.innerHTML = `<div class="globe-fallback">${markers.length ? markers.slice(0, 80).map((m, i) => `
    <button type="button" data-i="${i}">
      <b>${m.cc ? flagIcon(m.cc) : ''} ${esc(m.city || m.region || m.country || 'Unknown')}</b>
      <span>${esc(m.username || 'Guest')} · ${esc(m.videoTitle || m.reason || m.ip || '')}</span>
    </button>`).join('') : '<p class="muted">No precise traffic locations yet.</p>'}</div>`;
  container.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', () => onSelect && onSelect(markers[Number(b.dataset.i)])));
}

export function renderGlobe(container, markers = [], { onSelect, onHover } = {}) {
  if (!container) return { dispose() {}, update() {} };
  container.innerHTML = '';
  if (!window.WebGLRenderingContext) { fallback(container, markers, onSelect); return { dispose() {}, update(next) { fallback(container, next || [], onSelect); } }; }

  container.style.position = 'relative';
  const canvas = document.createElement('canvas');
  canvas.className = 'traffic-globe-canvas';
  container.appendChild(canvas);

  // Info popup anchored to the selected marker (projected to screen each frame).
  const popup = document.createElement('div');
  popup.className = 'globe-popup';
  popup.hidden = true;
  container.appendChild(popup);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    fallback(container, markers, onSelect);
    return { dispose() {}, update(next) { fallback(container, next || [], onSelect); } };
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0, 5.8);

  const globe = new THREE.Mesh(
    new THREE.SphereGeometry(2, 96, 64),
    new THREE.MeshStandardMaterial({ map: earthTexture(), roughness: .75, metalness: .05 }),
  );
  scene.add(globe);
  scene.add(new THREE.AmbientLight(0x8fb7ff, 1.8));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(4, 2, 6);
  scene.add(sun);

  // Atmosphere: an inner rim + a soft additive outer glow shell.
  scene.add(new THREE.Mesh(
    new THREE.SphereGeometry(2.08, 96, 32),
    new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: .10, side: THREE.BackSide }),
  ));
  scene.add(new THREE.Mesh(
    new THREE.SphereGeometry(2.28, 64, 32),
    new THREE.MeshBasicMaterial({ color: 0x2563eb, transparent: true, opacity: .07, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false }),
  ));

  // Marker dots + their stems live in one group; arcs in another. Both are
  // rebuilt by update() so live refreshes don't recreate the WebGL context.
  const markerGroup = new THREE.Group();
  const arcGroup = new THREE.Group();
  scene.add(markerGroup, arcGroup);
  const markerGeo = new THREE.SphereGeometry(.035, 16, 12);
  const mats = {
    watch: new THREE.MeshBasicMaterial({ color: COLORS.watch }),
    subscriber: new THREE.MeshBasicMaterial({ color: COLORS.subscriber }),
    blocked: new THREE.MeshBasicMaterial({ color: COLORS.blocked }),
  };
  let pickables = [];
  let pulse = [];   // { mesh, base, phase }
  let arcs = [];    // { curve, comet, speed, offset }

  function clearGroup(group) {
    for (let i = group.children.length - 1; i >= 0; i -= 1) {
      const o = group.children[i];
      group.remove(o);
      if (o.geometry && o.geometry !== markerGeo) o.geometry.dispose();
    }
  }

  function build(list) {
    clearGroup(markerGroup);
    clearGroup(arcGroup);
    pickables = []; pulse = []; arcs = [];
    const coords = (list || []).filter((m) => typeof m.lat === 'number' && typeof m.lon === 'number');
    coords.forEach((marker, i) => {
      const mat = marker.type === 'blocked' ? mats.blocked : marker.subscriber ? mats.subscriber : mats.watch;
      const dot = new THREE.Mesh(markerGeo, mat);
      dot.position.copy(latLonToVector(marker.lat, marker.lon));
      dot.userData.marker = marker;
      markerGroup.add(dot);
      pickables.push(dot);
      pulse.push({ mesh: dot, base: 1, phase: i * 0.6 });

      const stem = new THREE.BufferGeometry().setFromPoints([
        latLonToVector(marker.lat, marker.lon, 2.01),
        latLonToVector(marker.lat, marker.lon, 2.18),
      ]);
      arcGroup.add(new THREE.Line(stem, new THREE.LineBasicMaterial({ color: mat.color, transparent: true, opacity: .42 })));

      // Animated great-circle arc toward the hub for the most recent markers.
      if (i < 28) {
        const a = latLonToVector(marker.lat, marker.lon, 2.0);
        const b = latLonToVector(HUB[0], HUB[1], 2.0);
        const mid = a.clone().add(b).multiplyScalar(0.5).setLength(2.0 + a.distanceTo(b) * 0.42);
        const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
        const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(40));
        arcGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: mat.color, transparent: true, opacity: .22 })));
        const comet = new THREE.Mesh(new THREE.SphereGeometry(.028, 10, 8), new THREE.MeshBasicMaterial({ color: mat.color }));
        arcGroup.add(comet);
        arcs.push({ curve, comet, speed: 0.18 + (i % 5) * 0.03, offset: (i * 0.13) % 1 });
      }
    });
  }
  build(markers);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 2.6;
  controls.maxDistance = 8;
  controls.rotateSpeed = .45;
  controls.zoomSpeed = .8;
  controls.autoRotate = true;
  controls.autoRotateSpeed = .35;
  // Pause auto-rotate briefly while the user is interacting, then resume.
  let resumeAt = 0;
  controls.addEventListener('start', () => { controls.autoRotate = false; });
  controls.addEventListener('end', () => { resumeAt = performance.now ? performance.now() + 2500 : 0; });

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(10, 10);
  let hovered = null;
  let selected = null; // { marker, mesh } — drives the anchored popup

  function popupHtml(m) {
    const loc = [m.city, m.region, m.country || m.cc].filter(Boolean).join(', ') || 'Unknown location';
    const extra = esc(m.videoTitle || m.reason || m.ip || '');
    return `<button class="globe-popup-x" type="button" aria-label="Close">×</button>`
      + `<div class="gp-loc">${m.cc ? flagIcon(m.cc) : ''}<b>${esc(loc)}</b></div>`
      + `<div class="gp-who">${esc(m.username || 'Guest')}</div>`
      + (extra ? `<div class="gp-extra">${extra}</div>` : '');
  }
  function openPopup(marker, mesh) {
    selected = { marker, mesh };
    popup.innerHTML = popupHtml(marker);
    popup.hidden = false;
    popup.style.display = '';
    popup.querySelector('.globe-popup-x').addEventListener('click', (e) => { e.stopPropagation(); closePopup(); });
    controls.autoRotate = false; resumeAt = 0; // hold still so the info is readable
  }
  function closePopup() { selected = null; popup.hidden = true; }

  function setPointer(ev) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  }

  canvas.addEventListener('pointermove', (ev) => { setPointer(ev); });
  canvas.addEventListener('pointerleave', () => { pointer.set(10, 10); onHover && onHover(''); });
  canvas.addEventListener('click', (ev) => {
    setPointer(ev);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(pickables, false)[0];
    if (hit) { openPopup(hit.object.userData.marker, hit.object); onSelect && onSelect(hit.object.userData.marker); }
    else closePopup();
  });

  function resize() {
    const rect = container.getBoundingClientRect();
    const w = Math.max(320, Math.floor(rect.width));
    const h = Math.max(360, Math.floor(rect.height || 520));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  let t0 = 0;
  function tick(now) {
    t0 = (now || 0) / 1000;
    resize();
    if (!controls.autoRotate && resumeAt && (now || 0) >= resumeAt) { controls.autoRotate = true; resumeAt = 0; }
    controls.update();

    // Pulse markers; the newest few (low index → near the front of pulse[]) beat harder.
    for (let i = 0; i < pulse.length; i += 1) {
      const p = pulse[i];
      const amp = i < 12 ? 0.55 : 0.28;
      p.mesh.scale.setScalar(1 + amp * (0.5 + 0.5 * Math.sin(t0 * 3 + p.phase)));
    }
    // Advance arc comets along their curves.
    for (const a of arcs) {
      const u = ((t0 * a.speed + a.offset) % 1);
      a.comet.position.copy(a.curve.getPoint(u));
    }

    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(pickables, false)[0];
    const next = hit ? hit.object : null;
    if (next !== hovered) {
      hovered = next;
      onHover && onHover(next ? next.userData.marker : null);
    }

    // Anchor the info popup to the selected marker; hide it when the marker rotates
    // to the far side of the globe (so it never floats over empty space).
    if (selected && selected.mesh && !popup.hidden) {
      const pos = selected.mesh.position.clone();
      const ndc = pos.clone().project(camera);
      const cw = renderer.domElement.clientWidth || 1;
      const ch = renderer.domElement.clientHeight || 1;
      const facing = pos.clone().normalize().dot(camera.position.clone().normalize()) > 0.02;
      if (facing && ndc.z < 1) {
        popup.style.display = '';
        popup.style.left = `${(ndc.x * 0.5 + 0.5) * cw}px`;
        popup.style.top = `${(-ndc.y * 0.5 + 0.5) * ch}px`;
      } else {
        popup.style.display = 'none';
      }
    }

    renderer.render(scene, camera);
  }

  renderer.setAnimationLoop(tick);

  return {
    dispose() {
      renderer.setAnimationLoop(null);
      renderer.dispose();
      controls.dispose();
      popup.remove();
    },
    // Live refresh: swap markers in place — camera, rotation, and controls persist.
    // The previously-selected mesh is gone after a rebuild, so close the popup.
    update(next) { closePopup(); build(next || []); },
  };
}
