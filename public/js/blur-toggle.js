// Viewer privacy reblur toggle (the header "eye" button). Paid/admin viewers see
// thumbnails unblurred by default; this lets ANY viewer re-blur every thumbnail,
// hover preview and in-grid still on demand — for discretion in public or shared
// spaces — without affecting what they can actually open. The preference is
// stored in localStorage and applied to <html> as early as possible so blurred
// imagery never flashes unblurred on load. See the `html.privacy-blur` rules in
// styles.css and the `.hdr-eye*` button styling.
(() => {
  const KEY = 'dbtv_privacy_blur';

  // Read the saved preference. Wrapped because localStorage can throw in
  // private-mode / sandboxed contexts.
  const isOn = () => {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
  };
  const save = (on) => {
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* ignore */ }
  };

  // Apply immediately (synchronously, before first paint) to avoid a flash of
  // un-blurred thumbnails when privacy mode is on.
  const apply = (on) => document.documentElement.classList.toggle('privacy-blur', on);
  apply(isOn());

  // Open eye = "thumbnails visible"; eye-with-slash = "blurred for privacy".
  const EYE = `
    <svg class="eye-on" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5c-5 0-9.27 3.11-11 7 1.73 3.89 6 7 11 7s9.27-3.11 11-7c-1.73-3.89-6-7-11-7zm0 11.5A4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 0 1 0 9zm0-7A2.5 2.5 0 1 0 12 14.5 2.5 2.5 0 0 0 12 9.5z"/></svg>
    <svg class="eye-off" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.44-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2.71 3.16a.996.996 0 0 0 0 1.41l1.97 1.97A11.83 11.83 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5 1.52 0 2.97-.3 4.31-.82l2.72 2.72a.996.996 0 1 0 1.41-1.41L4.13 3.16a.996.996 0 0 0-1.42 0zM12 17c-2.76 0-5-2.24-5-5 0-.77.18-1.5.49-2.14l1.57 1.57c-.03.18-.06.37-.06.57a3 3 0 0 0 3 3c.2 0 .38-.03.57-.07l1.57 1.57c-.65.32-1.37.5-2.14.5z"/></svg>`;

  function mount() {
    const header = document.querySelector('.site-header');
    if (!header || header.querySelector('.hdr-eye')) return;

    const root = document.createElement('div');
    root.className = 'hdr-eye';
    root.innerHTML = `
      <button class="hdr-eye-btn" type="button" aria-pressed="false"
        aria-label="Blur thumbnails for privacy" title="Blur thumbnails for privacy">${EYE}</button>
      <div class="hdr-eye-toast" role="status" hidden></div>`;

    // Sit just left of the bell (Eye → Bell → Avatar); fall back to before the
    // auth widget, then append. Both this and notifications.js run async, so
    // anchor on whatever has landed.
    const bell = header.querySelector('.hdr-bell');
    const widget = header.querySelector('.auth-widget');
    if (bell) header.insertBefore(root, bell);
    else if (widget) header.insertBefore(root, widget);
    else header.appendChild(root);

    const btn = root.querySelector('.hdr-eye-btn');
    const toast = root.querySelector('.hdr-eye-toast');
    let toastTimer = null;

    const sync = (on) => {
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.title = on ? 'Thumbnails blurred — click to show' : 'Blur thumbnails for privacy';
      btn.setAttribute('aria-label', btn.title);
    };
    sync(isOn());

    btn.addEventListener('click', () => {
      const on = !document.documentElement.classList.contains('privacy-blur');
      apply(on); save(on); sync(on);
      toast.hidden = false; toast.textContent = on ? 'Thumbnails blurred' : 'Thumbnails visible';
      // Force reflow so re-adding .show re-triggers the transition.
      void toast.offsetWidth;
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.classList.remove('show'); }, 1400);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
