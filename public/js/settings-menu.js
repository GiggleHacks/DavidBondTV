import { buildQualityOptions } from './quality.js';
import { PLAYBACK_RATES, nextRate, rateLabel } from './playback.js';

export function createSettingsMenu({ menuEl, video, hlsController }) {
  let levels = [];
  let currentLevel = -1;     // -1 = auto
  let autoHeight = null;     // resolution auto currently plays
  let panel = 'main';        // 'main' | 'quality' | 'speed'

  function open() { menuEl.hidden = false; panel = 'main'; render(); }
  function close() { menuEl.hidden = true; }
  function toggle() { menuEl.hidden ? open() : close(); }
  function isOpen() { return !menuEl.hidden; }

  function setLevels(next) { levels = next; render(); }
  function setAutoLevel(height, autoEnabled) {
    autoHeight = height;
    if (autoEnabled) currentLevel = -1;
    render();
  }

  function row(label, rightHtml, onClick, extraClass = '') {
    const div = document.createElement('div');
    div.className = `menu-row ${extraClass}`.trim();
    div.innerHTML = `<span>${label}</span><span class="right">${rightHtml}</span>`;
    div.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return div;
  }

  function currentQualityLabel() {
    if (currentLevel === -1) return `Auto${autoHeight ? ` (${autoHeight}p)` : ''}`;
    const l = levels[currentLevel];
    return l ? `${l.height}p` : 'Auto';
  }

  function renderMain() {
    menuEl.replaceChildren(
      row('Playback speed', `${rateLabel(video.playbackRate)} ›`, () => { panel = 'speed'; render(); }),
      row('Quality', `${currentQualityLabel()} ›`, () => { panel = 'quality'; render(); }),
    );
  }

  function renderQuality() {
    const rows = [row('‹ Quality', '', () => { panel = 'main'; render(); }, 'back')];
    for (const opt of buildQualityOptions(levels, currentLevel, autoHeight)) {
      const right = opt.sublabel ? `<span class="badge-sub">${opt.sublabel}</span>` :
        (opt.hd ? '<span class="badge">HD</span>' : '');
      const check = opt.active ? '✓ ' : '';
      rows.push(row(`${check}${opt.label}`, right, () => {
        currentLevel = opt.index;
        hlsController.setLevel(opt.index);
        panel = 'main';
        render();
      }));
    }
    menuEl.replaceChildren(...rows);
  }

  function renderSpeed() {
    const rows = [row('‹ Playback speed', '', () => { panel = 'main'; render(); }, 'back')];
    for (const rate of PLAYBACK_RATES) {
      const check = video.playbackRate === rate ? '✓ ' : '';
      rows.push(row(`${check}${rateLabel(rate)}`, '', () => {
        video.playbackRate = rate;
        panel = 'main';
        render();
      }));
    }
    menuEl.replaceChildren(...rows);
  }

  function render() {
    if (panel === 'quality') renderQuality();
    else if (panel === 'speed') renderSpeed();
    else renderMain();
  }

  return { open, close, toggle, isOpen, setLevels, setAutoLevel };
}
