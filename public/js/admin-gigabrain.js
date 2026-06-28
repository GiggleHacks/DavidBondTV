// Analytics 2.0 — embeds the GigaBrain dashboard (a separate sidecar service) in
// an iframe. Admin-gated like every other god page via the shared session cookie.
// The iframe src / external link are stamped server-side (__GIGABRAIN_URL__ →
// GIGABRAIN_PUBLIC_URL). If the sidecar isn't configured, that token survives and
// we swap the iframe for a short setup notice instead of showing a broken frame.
import { requireAdmin } from './god-auth.js';

await requireAdmin();

const stage = document.getElementById('gb-stage');
const frame = document.getElementById('gb-frame');
const openLink = document.getElementById('gb-open');

const src = frame ? frame.getAttribute('src') || '' : '';
const configured = src && src.indexOf('__GIGABRAIN_URL__') === -1;

if (!configured && stage) {
  if (openLink) openLink.style.display = 'none';
  stage.innerHTML = `
    <div class="gb-missing"><div class="gb-card">
      <h3>Analytics 2.0 isn't connected yet</h3>
      <p>This dashboard is served by the GigaBrain analytics sidecar. Set
      <code>GIGABRAIN_PUBLIC_URL</code> on the server (e.g.
      <code>https://analytics.davidbondtv.com</code>, or
      <code>http://localhost:3001</code> in development) and restart, then reload
      this page.</p>
      <p>Until then, traffic tracking and this embed stay disabled — nothing else
      on the site is affected.</p>
    </div></div>`;
}
