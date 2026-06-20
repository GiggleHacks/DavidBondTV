// Share button: native share sheet where available, clipboard-copy fallback.
export function showToast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  // force reflow so the transition runs even on rapid re-trigger
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2400);
}

export function initShare(button) {
  if (!button) return;
  button.addEventListener('click', async () => {
    const url = window.location.href;
    const shareData = { title: 'David Bond TV', text: 'Watch this on David Bond TV', url };

    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch {
        /* user cancelled or share failed — fall through to copy */
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      showToast('Link copied to clipboard');
    } catch {
      showToast(url);
    }
  });
}
