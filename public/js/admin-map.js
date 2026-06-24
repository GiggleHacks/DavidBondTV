import * as THREE from '../vendor/three/three.module.js';
import { OrbitControls } from '../vendor/three/addons/controls/OrbitControls.js';
import { flagIcon } from './world-data.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function latLonToVector(lat, lon, radius = 2.02) {
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (lon + 180) * Math.PI / 180;
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

function earthTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const g = c.getContext('2d');
  const sea = g.createLinearGradient(0, 0, c.width, c.height);
  sea.addColorStop(0, '#07111f'); sea.addColorStop(.48, '#0f2a3c'); sea.addColorStop(1, '#071827');
  g.fillStyle = sea; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 1;
  for (let x = 0; x <= c.width; x += c.width / 24) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, c.height); g.stroke(); }
  for (let y = 0; y <= c.height; y += c.height / 12) { g.beginPath(); g.moveTo(0, y); g.lineTo(c.width, y); g.stroke(); }
  g.fillStyle = 'rgba(74, 222, 128, .18)';
  const blobs = [
    [210, 170, 170, 95], [310, 250, 95, 150], [505, 160, 120, 80],
    [560, 245, 95, 120], [690, 185, 150, 88], [775, 300, 95, 70],
    [845, 355, 125, 55], [460, 345, 45, 32],
  ];
  for (const [x, y, w, h] of blobs) {
    g.beginPath(); g.ellipse(x, y, w, h, -.18, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
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
  if (!container) return;
  container.innerHTML = '';
  if (!window.WebGLRenderingContext) { fallback(container, markers, onSelect); return; }

  const canvas = document.createElement('canvas');
  canvas.className = 'traffic-globe-canvas';
  container.appendChild(canvas);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    fallback(container, markers, onSelect);
    return;
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

  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(2.08, 96, 32),
    new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: .08, side: THREE.BackSide }),
  );
  scene.add(halo);

  const group = new THREE.Group();
  scene.add(group);
  const markerGeo = new THREE.SphereGeometry(.035, 18, 12);
  const markerMats = {
    watch: new THREE.MeshBasicMaterial({ color: 0x22d3ee }),
    subscriber: new THREE.MeshBasicMaterial({ color: 0xeab308 }),
    blocked: new THREE.MeshBasicMaterial({ color: 0xfb7185 }),
  };
  const pickables = [];
  for (const marker of markers) {
    if (typeof marker.lat !== 'number' || typeof marker.lon !== 'number') continue;
    const mat = marker.type === 'blocked' ? markerMats.blocked : marker.subscriber ? markerMats.subscriber : markerMats.watch;
    const dot = new THREE.Mesh(markerGeo, mat);
    dot.position.copy(latLonToVector(marker.lat, marker.lon));
    dot.userData.marker = marker;
    group.add(dot);
    pickables.push(dot);

    const stem = new THREE.BufferGeometry().setFromPoints([latLonToVector(marker.lat, marker.lon, 2.01), latLonToVector(marker.lat, marker.lon, 2.18)]);
    group.add(new THREE.Line(stem, new THREE.LineBasicMaterial({ color: mat.color, transparent: true, opacity: .42 })));
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 2.6;
  controls.maxDistance = 8;
  controls.rotateSpeed = .45;
  controls.zoomSpeed = .8;

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(10, 10);
  let hovered = null;

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
    if (hit) onSelect && onSelect(hit.object.userData.marker);
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

  function tick() {
    resize();
    controls.update();
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(pickables, false)[0];
    const next = hit ? hit.object : null;
    if (next !== hovered) {
      hovered = next;
      onHover && onHover(next ? next.userData.marker : null);
    }
    renderer.render(scene, camera);
  }

  renderer.setAnimationLoop(tick);
  return () => {
    renderer.setAnimationLoop(null);
    renderer.dispose();
    controls.dispose();
  };
}
