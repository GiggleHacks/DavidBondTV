import { ADMIN_PATHS } from './admin-paths.js';

// Reveals an admin-only "Upload Video" button in the site header for admins.
// (The Dashboard / admin links now live in the profile dropdown — see
// auth-widget.js.) Uses the unified session cookie — no bearer tokens.
(async () => {
  let me = null;
  try { me = (await (await fetch('/api/auth/me')).json()).user; } catch { return; }
  if (!me || !Array.isArray(me.roles) || !me.roles.includes('admin')) return;
  const header = document.querySelector('.site-header');
  if (!header || header.querySelector('.hdr-upload')) return;

  // Upload button — sits at the right of the header, just left of the avatar.
  const up = document.createElement('a');
  up.className = 'hdr-upload';
  up.href = ADMIN_PATHS.upload;
  up.title = 'Upload a video (admin)';
  up.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l-6 6h4v6h4v-6h4l-6-6zM5 18v2h14v-2H5z"/></svg><span>Upload</span>';

  // Right-side order is Upload → Bell → Avatar. Upload goes first, so anchor it
  // before the bell if notifications.js has already inserted it, else before the
  // avatar widget. (Both scripts are async; whichever lands first, order holds.)
  const bell = header.querySelector('.hdr-bell');
  const widget = header.querySelector('.auth-widget');
  if (bell) header.insertBefore(up, bell);
  else if (widget) header.insertBefore(up, widget);
  else header.appendChild(up);
})();
