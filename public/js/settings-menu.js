import { buildQualityOptions, qualityLabel } from './quality.js';
import { PLAYBACK_RATES, nextRate, rateLabel } from './playback.js';
import { THEMES, getTheme, applyTheme } from './theme.js';

export function createSettingsMenu({ menuEl, video, hlsController }) {
  let levels = [];
  let currentLevel = -1;     // -1 = auto
  let autoHeight = null;     // resolution auto currently plays
  let panel = 'main';        // 'main' | 'quality' | 'speed' | 'theme'

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
    if (currentLevel === -1) return `Auto${autoHeight ? ` (${qualityLabel(autoHeight)})` : ''}`;
    const l = levels[currentLevel];
    return l ? qualityLabel(l.height) : 'Auto';
  }

  function currentThemeName() {
    const t = THEMES.find((x) => x.id === getTheme());
    return t ? t.name : 'Default';
  }

  function renderMain() {
    menuEl.replaceChildren(
      row('Playback speed', `${rateLabel(video.playbackRate)} ›`, () => { panel = 'speed'; render(); }),
      row('Quality', `${currentQualityLabel()} ›`, () => { panel = 'quality'; render(); }),
      row('Theme', `${currentThemeName()} ›`, () => { panel = 'theme'; render(); }),
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

  function renderTheme() {
    const active = getTheme();
    const rows = [row('‹ Theme', '', () => { panel = 'main'; render(); }, 'back')];
    for (const t of THEMES) {
      const check = t.id === active ? '✓ ' : '';
      const label = `${check}<span class="swatch" style="background:${t.swatch}"></span> ${t.name}`;
      rows.push(row(label, '', () => {
        applyTheme(t.id);
        render();
      }));
    }
    menuEl.replaceChildren(...rows);
  }

  function render() {
    if (panel === 'quality') renderQuality();
    else if (panel === 'speed') renderSpeed();
    else if (panel === 'theme') renderTheme();
    else renderMain();
  }

  return { open, close, toggle, isOpen, setLevels, setAutoLevel };
}
