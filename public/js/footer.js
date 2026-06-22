// Site-wide footer with legal/policy links. Injected on every public page so the
// links live in one place (Stripe + consumer law expect these reachable from
// anywhere on the site). Admin/god pages intentionally don't include it.
(function mountFooter() {
  if (document.querySelector('.site-footer')) return; // idempotent
  const year = new Date().getFullYear();
  const footer = document.createElement('footer');
  footer.className = 'site-footer';
  footer.innerHTML = `
    <nav class="site-footer-links" aria-label="Legal">
      <a href="/terms">Terms</a>
      <a href="/privacy">Privacy</a>
      <a href="/refunds">Refunds &amp; Cancellation</a>
      <a href="mailto:support@davidbondtv.com">Contact</a>
    </nav>
    <p class="site-footer-copy">© ${year} David Bond TV. All rights reserved.</p>`;
  document.body.appendChild(footer);
}());
