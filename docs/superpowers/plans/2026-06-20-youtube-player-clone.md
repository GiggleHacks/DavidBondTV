# YouTube Player Clone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a faithful single-video YouTube player clone for `bikinis.mp4` with adaptive HLS streaming, a full YouTube-style control bar, scrub thumbnail previews, and YouTube keyboard shortcuts.

**Architecture:** An offline ffmpeg build step transcodes the source into a 5-rung HLS quality ladder plus storyboard sprite sheets. A zero-dependency Node static server (with Range support) serves the `public/` player app and the generated `media/` stream. The browser player is vanilla JS ES modules over a `<video>` element, using vendored `hls.js` for adaptive-bitrate playback.

**Tech Stack:** Node.js (built-in `http`, `child_process`), ffmpeg/ffprobe (build-time only), hls.js (vendored), vanilla JS ES modules, Vitest (unit tests), Playwright (optional smoke test).

---

## File Structure

**Pure-logic modules (DOM-free, unit-tested with Vitest):**
- `public/js/format.js` — time formatting
- `public/js/playback.js` — playback-rate ladder + stepping
- `public/js/quality.js` — quality menu option model
- `public/js/storyboard.js` — `spriteLocation()` math (pure) + `loadStoryboard()` loader
- `public/js/keyboard.js` — `resolveAction()` + `dispatchAction()` (pure) + `attachKeyboard()`
- `lib/http-util.js` — `contentType()` + `parseRange()` (Node-side, pure)

**Integration modules (manual/Playwright verification):**
- `public/js/icons.js` — inline SVG strings
- `public/js/hls-controller.js` — hls.js setup, level switching, error recovery
- `public/js/controls.js` — play/pause, volume, mute, time, fullscreen, settings button
- `public/js/progress-bar.js` — played/buffered render, scrubbing, storyboard hover
- `public/js/settings-menu.js` — gear menu (Quality + Playback speed submenus)
- `public/js/player.js` — orchestrator wiring everything together
- `public/index.html` — markup skeleton
- `public/styles.css` — YouTube-faithful dark theme

**Build + serve:**
- `build/transcode.mjs` — ffmpeg → HLS ladder + master playlist
- `build/storyboard.mjs` — ffmpeg → sprite sheets + `storyboard.json` + `poster.jpg`
- `server.mjs` — static server

**Config/tests:**
- `package.json`, `.gitignore`, `vitest.config.js`
- `tests/*.test.js`

---

## Task 1: Project setup

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `vitest.config.js`
- Create: `public/vendor/hls.min.js` (downloaded)

- [ ] **Step 1: Initialize git and directory skeleton**

Run from the project root (`D:\vibe\youtube clone`):
```bash
git init
mkdir -p build lib public/js public/vendor tests media
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "youtube-player-clone",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build:video": "node build/transcode.mjs",
    "build:storyboard": "node build/storyboard.mjs",
    "build": "npm run build:video && npm run build:storyboard",
    "start": "node server.mjs",
    "test": "vitest run"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Create `.gitignore`**

```gitignore
node_modules/
media/
.superpowers/
*.log
```

> Note: `bikinis.mp4` (the source) is NOT ignored — keep it. `media/` (generated output) IS ignored.

- [ ] **Step 4: Create `vitest.config.js`**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
```

- [ ] **Step 5: Install dependencies and vendor hls.js**

```bash
npm install
curl -L https://cdn.jsdelivr.net/npm/hls.js@1.5.15/dist/hls.min.js -o public/vendor/hls.min.js
```

Expected: `node_modules/` created; `public/vendor/hls.min.js` exists and is non-empty.

- [ ] **Step 6: Verify ffmpeg/ffprobe are available**

Run:
```bash
ffmpeg -version && ffprobe -version
```
Expected: version banners print for both. If not, install ffmpeg before continuing.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore vitest.config.js public/vendor/hls.min.js
git commit -m "chore: project setup, vitest, vendored hls.js"
```

---

## Task 2: `format.js` — time formatting

**Files:**
- Create: `public/js/format.js`
- Test: `tests/format.test.js`

- [ ] **Step 1: Write the failing test**

`tests/format.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { formatTime } from '../public/js/format.js';

describe('formatTime', () => {
  it('formats zero', () => expect(formatTime(0)).toBe('0:00'));
  it('pads seconds', () => expect(formatTime(5)).toBe('0:05'));
  it('formats minutes', () => expect(formatTime(65)).toBe('1:05'));
  it('formats the sample duration', () => expect(formatTime(428)).toBe('7:08'));
  it('formats hours', () => expect(formatTime(3661)).toBe('1:01:01'));
  it('floors fractional seconds', () => expect(formatTime(5.9)).toBe('0:05'));
  it('treats NaN as zero', () => expect(formatTime(NaN)).toBe('0:00'));
  it('treats negatives as zero', () => expect(formatTime(-10)).toBe('0:00'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/format.test.js`
Expected: FAIL — cannot resolve `../public/js/format.js`.

- [ ] **Step 3: Write minimal implementation**

`public/js/format.js`:
```js
export function formatTime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
  totalSeconds = Math.floor(totalSeconds);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/format.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add public/js/format.js tests/format.test.js
git commit -m "feat: formatTime helper"
```

---

## Task 3: `playback.js` — playback-rate ladder

**Files:**
- Create: `public/js/playback.js`
- Test: `tests/playback.test.js`

- [ ] **Step 1: Write the failing test**

`tests/playback.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { PLAYBACK_RATES, nextRate, rateLabel } from '../public/js/playback.js';

describe('playback rates', () => {
  it('exposes the YouTube rate ladder', () => {
    expect(PLAYBACK_RATES).toEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
  });
  it('steps up from normal', () => expect(nextRate(1, 1)).toBe(1.25));
  it('steps down from normal', () => expect(nextRate(1, -1)).toBe(0.75));
  it('clamps at the top', () => expect(nextRate(2, 1)).toBe(2));
  it('clamps at the bottom', () => expect(nextRate(0.25, -1)).toBe(0.25));
  it('treats an unknown rate as normal', () => expect(nextRate(1.1, 1)).toBe(1.25));
  it('labels normal speed', () => expect(rateLabel(1)).toBe('Normal'));
  it('labels other speeds', () => expect(rateLabel(1.5)).toBe('1.5'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/playback.test.js`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write minimal implementation**

`public/js/playback.js`:
```js
export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export function nextRate(current, dir) {
  let i = PLAYBACK_RATES.indexOf(current);
  if (i === -1) i = PLAYBACK_RATES.indexOf(1);
  const next = Math.min(PLAYBACK_RATES.length - 1, Math.max(0, i + dir));
  return PLAYBACK_RATES[next];
}

export function rateLabel(rate) {
  return rate === 1 ? 'Normal' : String(rate);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/playback.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add public/js/playback.js tests/playback.test.js
git commit -m "feat: playback-rate ladder helpers"
```

---

## Task 4: `quality.js` — quality menu option model

**Files:**
- Create: `public/js/quality.js`
- Test: `tests/quality.test.js`

- [ ] **Step 1: Write the failing test**

`tests/quality.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { buildQualityOptions } from '../public/js/quality.js';

const levels = [
  { height: 360, bitrate: 900000 },
  { height: 720, bitrate: 3000000 },
  { height: 1080, bitrate: 5350000 },
];

describe('buildQualityOptions', () => {
  it('lists fixed levels high-to-low then Auto last', () => {
    const opts = buildQualityOptions(levels, -1, 720);
    expect(opts.map((o) => o.label)).toEqual(['1080p', '720p', '360p', 'Auto']);
  });
  it('flags HD for >= 720', () => {
    const opts = buildQualityOptions(levels, -1, 720);
    expect(opts.find((o) => o.label === '1080p').hd).toBe(true);
    expect(opts.find((o) => o.label === '720p').hd).toBe(true);
    expect(opts.find((o) => o.label === '360p').hd).toBe(false);
  });
  it('marks Auto active and shows current resolution', () => {
    const opts = buildQualityOptions(levels, -1, 720);
    const auto = opts.find((o) => o.label === 'Auto');
    expect(auto.active).toBe(true);
    expect(auto.index).toBe(-1);
    expect(auto.sublabel).toBe('720p');
  });
  it('marks a pinned level active and Auto inactive', () => {
    const opts = buildQualityOptions(levels, 2, 720); // index 2 == 1080p
    expect(opts.find((o) => o.label === '1080p').active).toBe(true);
    expect(opts.find((o) => o.label === 'Auto').active).toBe(false);
  });
  it('preserves original indices for pinning', () => {
    const opts = buildQualityOptions(levels, -1, 720);
    expect(opts.find((o) => o.label === '360p').index).toBe(0);
    expect(opts.find((o) => o.label === '1080p').index).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/quality.test.js`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write minimal implementation**

`public/js/quality.js`:
```js
export function buildQualityOptions(levels, currentLevel, currentAutoHeight) {
  const options = levels
    .map((l, index) => ({ index, height: l.height }))
    .sort((a, b) => b.height - a.height)
    .map(({ index, height }) => ({
      index,
      label: `${height}p`,
      hd: height >= 720,
      active: currentLevel === index,
    }));

  options.push({
    index: -1,
    label: 'Auto',
    hd: false,
    active: currentLevel === -1,
    sublabel: currentAutoHeight ? `${currentAutoHeight}p` : '',
  });

  return options;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/quality.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add public/js/quality.js tests/quality.test.js
git commit -m "feat: quality menu option model"
```

---

## Task 5: `storyboard.js` — sprite-location math + loader

**Files:**
- Create: `public/js/storyboard.js`
- Test: `tests/storyboard.test.js`

- [ ] **Step 1: Write the failing test**

`tests/storyboard.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { spriteLocation } from '../public/js/storyboard.js';

const meta = {
  interval: 2,
  tileWidth: 160,
  tileHeight: 90,
  columns: 5,
  rows: 5,
  tilesPerSheet: 25,
  count: 30,
  sheets: ['sprite-1.jpg', 'sprite-2.jpg'],
};

describe('spriteLocation', () => {
  it('maps t=0 to the first tile of the first sheet', () => {
    expect(spriteLocation(0, meta)).toEqual({
      sheet: 'sprite-1.jpg', x: 0, y: 0, width: 160, height: 90,
    });
  });
  it('maps within the interval to the same tile', () => {
    expect(spriteLocation(1.9, meta).x).toBe(0);
  });
  it('advances one tile per interval (column step)', () => {
    expect(spriteLocation(2, meta)).toMatchObject({ x: 160, y: 0 });
  });
  it('wraps to the next row after the last column', () => {
    // index 5 -> row 1, col 0  => x 0, y 90
    expect(spriteLocation(10, meta)).toMatchObject({ x: 0, y: 90 });
  });
  it('rolls over to the next sheet', () => {
    // index 25 -> sheet 2, tile 0
    expect(spriteLocation(50, meta)).toMatchObject({ sheet: 'sprite-2.jpg', x: 0, y: 0 });
  });
  it('clamps past the end to the last thumbnail', () => {
    // count 30 -> last index 29 -> sheet 2, within 4 -> col 4 row 0
    expect(spriteLocation(9999, meta)).toMatchObject({ sheet: 'sprite-2.jpg', x: 640, y: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storyboard.test.js`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write minimal implementation**

`public/js/storyboard.js`:
```js
export function spriteLocation(time, meta) {
  let index = Math.floor((time < 0 ? 0 : time) / meta.interval);
  if (index > meta.count - 1) index = meta.count - 1;
  if (index < 0) index = 0;

  const sheetIndex = Math.floor(index / meta.tilesPerSheet);
  const within = index % meta.tilesPerSheet;
  const col = within % meta.columns;
  const row = Math.floor(within / meta.columns);

  return {
    sheet: meta.sheets[sheetIndex],
    x: col * meta.tileWidth,
    y: row * meta.tileHeight,
    width: meta.tileWidth,
    height: meta.tileHeight,
  };
}

export async function loadStoryboard(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const meta = await res.json();
    return {
      meta,
      locate: (t) => spriteLocation(t, meta),
      sheetUrl: (sheet) => `/media/storyboard/${sheet}`,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/storyboard.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add public/js/storyboard.js tests/storyboard.test.js
git commit -m "feat: storyboard sprite-location math and loader"
```

---

## Task 6: `keyboard.js` — shortcut resolution + dispatch

**Files:**
- Create: `public/js/keyboard.js`
- Test: `tests/keyboard.test.js`

- [ ] **Step 1: Write the failing test**

`tests/keyboard.test.js`:
```js
import { describe, it, expect, vi } from 'vitest';
import { resolveAction, dispatchAction } from '../public/js/keyboard.js';

const k = (key, shiftKey = false) => ({ key, shiftKey });

describe('resolveAction', () => {
  it('space and k toggle play', () => {
    expect(resolveAction(k(' '))).toEqual({ type: 'togglePlay' });
    expect(resolveAction(k('k'))).toEqual({ type: 'togglePlay' });
  });
  it('m toggles mute', () => expect(resolveAction(k('m'))).toEqual({ type: 'toggleMute' }));
  it('j/l seek by 10s', () => {
    expect(resolveAction(k('j'))).toEqual({ type: 'seekBy', delta: -10 });
    expect(resolveAction(k('l'))).toEqual({ type: 'seekBy', delta: 10 });
  });
  it('arrows seek by 5s', () => {
    expect(resolveAction(k('ArrowLeft'))).toEqual({ type: 'seekBy', delta: -5 });
    expect(resolveAction(k('ArrowRight'))).toEqual({ type: 'seekBy', delta: 5 });
  });
  it('up/down change volume by 0.05', () => {
    expect(resolveAction(k('ArrowUp'))).toEqual({ type: 'volumeBy', delta: 0.05 });
    expect(resolveAction(k('ArrowDown'))).toEqual({ type: 'volumeBy', delta: -0.05 });
  });
  it('digits seek to percentages', () => {
    expect(resolveAction(k('0'))).toEqual({ type: 'seekToPercent', percent: 0 });
    expect(resolveAction(k('5'))).toEqual({ type: 'seekToPercent', percent: 0.5 });
    expect(resolveAction(k('9'))).toEqual({ type: 'seekToPercent', percent: 0.9 });
  });
  it('Home/End jump to start/end', () => {
    expect(resolveAction(k('Home'))).toEqual({ type: 'seekToPercent', percent: 0 });
    expect(resolveAction(k('End'))).toEqual({ type: 'seekToEnd' });
  });
  it('period/comma frame-step', () => {
    expect(resolveAction(k('.'))).toEqual({ type: 'frameStep', dir: 1 });
    expect(resolveAction(k(','))).toEqual({ type: 'frameStep', dir: -1 });
  });
  it('shifted >/< step speed', () => {
    expect(resolveAction(k('>', true))).toEqual({ type: 'speedStep', dir: 1 });
    expect(resolveAction(k('<', true))).toEqual({ type: 'speedStep', dir: -1 });
  });
  it('f toggles fullscreen', () => expect(resolveAction(k('f'))).toEqual({ type: 'toggleFullscreen' }));
  it('returns null for out-of-scope keys', () => {
    expect(resolveAction(k('c'))).toBeNull();
    expect(resolveAction(k('i'))).toBeNull();
    expect(resolveAction(k('t'))).toBeNull();
    expect(resolveAction(k('/'))).toBeNull();
  });
});

describe('dispatchAction', () => {
  it('calls the matching action callback with args', () => {
    const actions = {
      togglePlay: vi.fn(), seekBy: vi.fn(), volumeBy: vi.fn(),
      seekToPercent: vi.fn(), seekToEnd: vi.fn(), frameStep: vi.fn(),
      speedStep: vi.fn(), toggleMute: vi.fn(), toggleFullscreen: vi.fn(),
    };
    dispatchAction({ type: 'seekBy', delta: 10 }, actions);
    expect(actions.seekBy).toHaveBeenCalledWith(10);
    dispatchAction({ type: 'seekToPercent', percent: 0.5 }, actions);
    expect(actions.seekToPercent).toHaveBeenCalledWith(0.5);
    dispatchAction({ type: 'togglePlay' }, actions);
    expect(actions.togglePlay).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/keyboard.test.js`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write minimal implementation**

`public/js/keyboard.js`:
```js
export function resolveAction(event) {
  const { key } = event;

  if (key === ' ' || key === 'k') return { type: 'togglePlay' };
  if (key === 'm') return { type: 'toggleMute' };
  if (key === 'j') return { type: 'seekBy', delta: -10 };
  if (key === 'l') return { type: 'seekBy', delta: 10 };
  if (key === 'ArrowLeft') return { type: 'seekBy', delta: -5 };
  if (key === 'ArrowRight') return { type: 'seekBy', delta: 5 };
  if (key === 'ArrowUp') return { type: 'volumeBy', delta: 0.05 };
  if (key === 'ArrowDown') return { type: 'volumeBy', delta: -0.05 };
  if (key >= '0' && key <= '9') return { type: 'seekToPercent', percent: Number(key) / 10 };
  if (key === 'Home') return { type: 'seekToPercent', percent: 0 };
  if (key === 'End') return { type: 'seekToEnd' };
  if (key === '.') return { type: 'frameStep', dir: 1 };
  if (key === ',') return { type: 'frameStep', dir: -1 };
  if (key === '>') return { type: 'speedStep', dir: 1 };
  if (key === '<') return { type: 'speedStep', dir: -1 };
  if (key === 'f') return { type: 'toggleFullscreen' };

  return null;
}

export function dispatchAction(action, actions) {
  switch (action.type) {
    case 'togglePlay': return actions.togglePlay();
    case 'toggleMute': return actions.toggleMute();
    case 'seekBy': return actions.seekBy(action.delta);
    case 'volumeBy': return actions.volumeBy(action.delta);
    case 'seekToPercent': return actions.seekToPercent(action.percent);
    case 'seekToEnd': return actions.seekToEnd();
    case 'frameStep': return actions.frameStep(action.dir);
    case 'speedStep': return actions.speedStep(action.dir);
    case 'toggleFullscreen': return actions.toggleFullscreen();
    default: return undefined;
  }
}

export function attachKeyboard(target, actions) {
  const handler = (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const action = resolveAction(event);
    if (!action) return;
    event.preventDefault();
    dispatchAction(action, actions);
  };
  target.addEventListener('keydown', handler);
  return () => target.removeEventListener('keydown', handler);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/keyboard.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/js/keyboard.js tests/keyboard.test.js
git commit -m "feat: keyboard shortcut resolution and dispatch"
```

---

## Task 7: `lib/http-util.js` — content types + range parsing

**Files:**
- Create: `lib/http-util.js`
- Test: `tests/http-util.test.js`

- [ ] **Step 1: Write the failing test**

`tests/http-util.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { contentType, parseRange } from '../lib/http-util.js';

describe('contentType', () => {
  it('maps streaming types', () => {
    expect(contentType('/x/master.m3u8')).toBe('application/vnd.apple.mpegurl');
    expect(contentType('/x/seg_001.ts')).toBe('video/mp2t');
  });
  it('maps web + image types', () => {
    expect(contentType('/index.html')).toBe('text/html; charset=utf-8');
    expect(contentType('/js/player.js')).toBe('text/javascript; charset=utf-8');
    expect(contentType('/storyboard/sprite-1.jpg')).toBe('image/jpeg');
    expect(contentType('/storyboard.json')).toBe('application/json; charset=utf-8');
  });
  it('falls back to octet-stream', () => {
    expect(contentType('/file.unknown')).toBe('application/octet-stream');
  });
});

describe('parseRange', () => {
  it('returns null without a header', () => expect(parseRange(undefined, 1000)).toBeNull());
  it('parses a closed range', () => expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 }));
  it('parses an open-ended range', () => expect(parseRange('bytes=100-', 1000)).toEqual({ start: 100, end: 999 }));
  it('parses a suffix range', () => expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 }));
  it('clamps end to file size', () => expect(parseRange('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 }));
  it('flags an unsatisfiable range', () => expect(parseRange('bytes=2000-', 1000)).toEqual({ invalid: true }));
  it('returns null on malformed input', () => expect(parseRange('rows=0-9', 1000)).toBeNull());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/http-util.test.js`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Write minimal implementation**

`lib/http-util.js`:
```js
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
};

export function contentType(filePath) {
  return TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

export function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;

  const [, startStr, endStr] = match;
  if (startStr === '' && endStr === '') return null;

  let start;
  let end;
  if (startStr === '') {
    const suffix = parseInt(endStr, 10);
    if (suffix === 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === '' ? size - 1 : parseInt(endStr, 10);
  }

  if (start > end || start >= size) return { invalid: true };
  return { start, end: Math.min(end, size - 1) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/http-util.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/http-util.js tests/http-util.test.js
git commit -m "feat: http content-type and range-parsing helpers"
```

---

## Task 8: `server.mjs` — static streaming server

**Files:**
- Create: `server.mjs`

- [ ] **Step 1: Write the server**

`server.mjs`:
```js
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentType, parseRange } from './lib/http-util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MEDIA_DIR = path.join(__dirname, 'media');

function resolveFile(urlPath) {
  let pathname = decodeURIComponent(urlPath.split('?')[0]);
  if (pathname === '/') pathname = '/index.html';

  const isMedia = pathname.startsWith('/media/');
  const root = isMedia ? MEDIA_DIR : PUBLIC_DIR;
  const rel = isMedia ? pathname.slice('/media'.length) : pathname;
  const filePath = path.normalize(path.join(root, rel));

  // Traversal guard: resolved path must stay within its root.
  if (filePath !== root && !filePath.startsWith(root + path.sep)) return null;
  return filePath;
}

const server = http.createServer(async (req, res) => {
  try {
    const filePath = resolveFile(req.url);
    if (!filePath) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      res.writeHead(404);
      return res.end('Not found');
    }
    if (stat.isDirectory()) {
      res.writeHead(404);
      return res.end('Not found');
    }

    const headers = {
      'Content-Type': contentType(filePath),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };

    const range = parseRange(req.headers.range, stat.size);
    if (range && range.invalid) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }

    if (range) {
      const { start, end } = range;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      headers['Content-Length'] = stat.size;
      res.writeHead(200, headers);
      fs.createReadStream(filePath).pipe(res);
    }
  } catch {
    res.writeHead(500);
    res.end('Server error');
  }
});

server.listen(PORT, () => {
  console.log(`▶  YouTube clone player running at http://localhost:${PORT}`);
});
```

- [ ] **Step 2: Smoke-test the server manually**

Create a temporary file so there is something to serve, then start the server:
```bash
echo "<h1>ok</h1>" > public/index.html
node server.mjs
```
In a second terminal:
```bash
curl -i http://localhost:8080/
curl -i -H "Range: bytes=0-3" http://localhost:8080/
```
Expected: first returns `200` with `Content-Type: text/html; charset=utf-8`; second returns `206 Partial Content` with a `Content-Range` header. Stop the server with Ctrl+C. (`index.html` is replaced for real in Task 11.)

- [ ] **Step 3: Commit**

```bash
git add server.mjs
git commit -m "feat: zero-dependency static streaming server with range support"
```

---

## Task 9: `build/transcode.mjs` — HLS quality ladder

**Files:**
- Create: `build/transcode.mjs`

- [ ] **Step 1: Write the transcode script**

`build/transcode.mjs`:
```js
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'bikinis.mp4');
const HLS_DIR = path.join(ROOT, 'media', 'hls');

const RENDITIONS = [
  { name: '360p',  width: 640,  height: 360,  maxrate: '856k',   bufsize: '1200k',  abitrate: '96k',  bandwidth: 900000 },
  { name: '480p',  width: 854,  height: 480,  maxrate: '1498k',  bufsize: '2100k',  abitrate: '128k', bandwidth: 1600000 },
  { name: '720p',  width: 1280, height: 720,  maxrate: '2996k',  bufsize: '4200k',  abitrate: '128k', bandwidth: 3000000 },
  { name: '1080p', width: 1920, height: 1080, maxrate: '5350k',  bufsize: '7500k',  abitrate: '192k', bandwidth: 5350000 },
  { name: '1440p', width: 2560, height: 1440, maxrate: '10700k', bufsize: '15000k', abitrate: '192k', bandwidth: 10700000 },
];

function requireFfmpeg() {
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf-8' });
  if (probe.status !== 0) {
    console.error('ERROR: ffmpeg not found on PATH. Install ffmpeg and retry.');
    process.exit(1);
  }
}

function transcode(r) {
  const outDir = path.join(HLS_DIR, r.name);
  fs.mkdirSync(outDir, { recursive: true });
  const vf = `scale=w=${r.width}:h=${r.height}:force_original_aspect_ratio=decrease,` +
             `pad=${r.width}:${r.height}:(ow-iw)/2:(oh-ih)/2`;

  const args = [
    '-y', '-i', SOURCE,
    '-vf', vf,
    '-c:v', 'libx264', '-profile:v', 'main', '-preset', 'veryfast',
    '-crf', '20', '-maxrate', r.maxrate, '-bufsize', r.bufsize,
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', r.abitrate, '-ac', '2',
    '-hls_time', '4', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(outDir, 'seg_%03d.ts'),
    path.join(outDir, 'playlist.m3u8'),
  ];

  console.log(`\nTranscoding ${r.name} (${r.width}x${r.height})...`);
  const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`ERROR: ffmpeg failed for ${r.name}`);
    process.exit(1);
  }
}

function writeMasterPlaylist() {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const r of RENDITIONS) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},RESOLUTION=${r.width}x${r.height}`);
    lines.push(`${r.name}/playlist.m3u8`);
  }
  const masterPath = path.join(HLS_DIR, 'master.m3u8');
  fs.writeFileSync(masterPath, lines.join('\n') + '\n');
  console.log(`\nWrote ${masterPath}`);
}

requireFfmpeg();
if (!fs.existsSync(SOURCE)) {
  console.error(`ERROR: source not found: ${SOURCE}`);
  process.exit(1);
}
fs.mkdirSync(HLS_DIR, { recursive: true });
for (const r of RENDITIONS) transcode(r);
writeMasterPlaylist();
console.log('\nHLS ladder complete.');
```

- [ ] **Step 2: Run the transcode (one-time, slow)**

Run:
```bash
node build/transcode.mjs
```
Expected: ffmpeg progress for each of the 5 renditions; ends with "HLS ladder complete." Verify output:
```bash
ls media/hls
ls media/hls/720p | head
cat media/hls/master.m3u8
```
Expected: directories `360p 480p 720p 1080p 1440p` and `master.m3u8`; each rendition dir has `playlist.m3u8` and `seg_000.ts`, `seg_001.ts`, …; `master.m3u8` lists all five with BANDWIDTH + RESOLUTION.

- [ ] **Step 3: Commit**

```bash
git add build/transcode.mjs
git commit -m "feat: ffmpeg HLS transcode ladder (5 renditions + master playlist)"
```

> `media/` is gitignored — only the script is committed.

---

## Task 10: `build/storyboard.mjs` — sprite sheets, index, poster

**Files:**
- Create: `build/storyboard.mjs`

- [ ] **Step 1: Write the storyboard script**

`build/storyboard.mjs`:
```js
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'bikinis.mp4');
const MEDIA_DIR = path.join(ROOT, 'media');
const SB_DIR = path.join(MEDIA_DIR, 'storyboard');

const INTERVAL = 2;       // seconds between thumbnails
const TILE_W = 160;
const TILE_H = 90;
const COLUMNS = 5;
const ROWS = 5;
const TILES_PER_SHEET = COLUMNS * ROWS;

function requireTools() {
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const probe = spawnSync(tool, ['-version'], { encoding: 'utf-8' });
    if (probe.status !== 0) {
      console.error(`ERROR: ${tool} not found on PATH. Install ffmpeg and retry.`);
      process.exit(1);
    }
  }
}

function getDuration() {
  const out = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', SOURCE,
  ], { encoding: 'utf-8' });
  if (out.status !== 0) {
    console.error('ERROR: ffprobe failed to read duration.');
    process.exit(1);
  }
  return parseFloat(out.stdout.trim());
}

function buildSprites() {
  const vf = `fps=1/${INTERVAL},scale=${TILE_W}:${TILE_H},tile=${COLUMNS}x${ROWS}`;
  const args = ['-y', '-i', SOURCE, '-vf', vf, '-q:v', '4', path.join(SB_DIR, 'sprite-%d.jpg')];
  console.log('Generating storyboard sprite sheets...');
  const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('ERROR: ffmpeg failed generating sprites.');
    process.exit(1);
  }
}

function buildPoster() {
  const args = ['-y', '-ss', '5', '-i', SOURCE, '-frames:v', '1', '-q:v', '3',
    path.join(MEDIA_DIR, 'poster.jpg')];
  console.log('Generating poster...');
  const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('ERROR: ffmpeg failed generating poster.');
    process.exit(1);
  }
}

function writeIndex(duration) {
  const count = Math.floor(duration / INTERVAL);
  const numSheets = Math.ceil(count / TILES_PER_SHEET);
  const sheets = Array.from({ length: numSheets }, (_, i) => `sprite-${i + 1}.jpg`);
  const meta = {
    interval: INTERVAL,
    tileWidth: TILE_W,
    tileHeight: TILE_H,
    columns: COLUMNS,
    rows: ROWS,
    tilesPerSheet: TILES_PER_SHEET,
    count,
    sheets,
  };
  fs.writeFileSync(path.join(SB_DIR, 'storyboard.json'), JSON.stringify(meta, null, 2));
  console.log(`Wrote storyboard.json (count=${count}, sheets=${numSheets}).`);
}

requireTools();
if (!fs.existsSync(SOURCE)) {
  console.error(`ERROR: source not found: ${SOURCE}`);
  process.exit(1);
}
fs.mkdirSync(SB_DIR, { recursive: true });
const duration = getDuration();
buildSprites();
buildPoster();
writeIndex(duration);
console.log('\nStoryboard complete.');
```

- [ ] **Step 2: Run the storyboard build (one-time)**

Run:
```bash
node build/storyboard.mjs
```
Expected: ends with "Storyboard complete." Verify:
```bash
ls media/storyboard
cat media/storyboard/storyboard.json
ls media/poster.jpg
```
Expected: `sprite-1.jpg … sprite-N.jpg`, `storyboard.json` with `count`/`sheets`, and `media/poster.jpg` exists. Confirm `sheets.length` equals the number of `sprite-*.jpg` files.

- [ ] **Step 3: Commit**

```bash
git add build/storyboard.mjs
git commit -m "feat: ffmpeg storyboard sprites, index, and poster"
```

---

## Task 11: `index.html` + `icons.js` — markup skeleton and icons

**Files:**
- Create: `public/index.html` (replaces the temporary smoke-test file)
- Create: `public/js/icons.js`

- [ ] **Step 1: Write `public/js/icons.js`**

```js
export const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  volHigh: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4zm-2.5-9v2.06A7 7 0 0119 12a7 7 0 01-5 6.94V21a9 9 0 000-18z"/></svg>',
  volMute: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.59 3l2.7-2.7-1.42-1.41L15.17 10.6 12.46 7.9 11.05 9.3l2.7 2.7-2.7 2.7 1.41 1.41 2.71-2.7 2.7 2.7 1.42-1.41-2.7-2.7z"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><path d="M19.4 13a7.8 7.8 0 000-2l2.1-1.6-2-3.5-2.5 1a8 8 0 00-1.7-1l-.4-2.6h-4l-.4 2.6a8 8 0 00-1.7 1l-2.5-1-2 3.5L3.6 11a7.8 7.8 0 000 2l-2.1 1.6 2 3.5 2.5-1a8 8 0 001.7 1l.4 2.6h4l.4-2.6a8 8 0 001.7-1l2.5 1 2-3.5-2.1-1.6zM12 15.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7z"/></svg>',
  enterFullscreen: '<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
  exitFullscreen: '<svg viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>',
};
```

- [ ] **Step 2: Write `public/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>YouTube Player Clone</title>
  <link rel="stylesheet" href="/styles.css" />
  <script src="/vendor/hls.min.js"></script>
</head>
<body>
  <main class="stage">
    <div class="player" id="player" tabindex="0">
      <video id="video" playsinline poster="/media/poster.jpg"></video>

      <div class="spinner" id="spinner" hidden></div>

      <div class="error-overlay" id="error" hidden>
        <p id="error-msg">Something went wrong.</p>
        <button class="retry-btn" id="retry-btn">Retry</button>
      </div>

      <button class="big-play" id="big-play" aria-label="Play"></button>

      <div class="gradient"></div>

      <div class="controls" id="controls">
        <div class="progress" id="progress">
          <div class="progress-thumb" id="thumb" hidden>
            <div class="thumb-img" id="thumb-img"></div>
            <span class="thumb-time" id="thumb-time">0:00</span>
          </div>
          <div class="progress-track">
            <div class="progress-buffered" id="buffered"></div>
            <div class="progress-played" id="played"></div>
            <div class="progress-scrubber" id="scrubber"></div>
          </div>
        </div>

        <div class="control-row">
          <button class="ctrl-btn" id="play-btn" aria-label="Play (k)"></button>
          <div class="volume" id="volume">
            <button class="ctrl-btn" id="mute-btn" aria-label="Mute (m)"></button>
            <div class="volume-slider" id="vol-slider">
              <div class="vol-fill" id="vol-fill"></div>
              <div class="vol-knob" id="vol-knob"></div>
            </div>
          </div>
          <span class="time" id="time">0:00 / 0:00</span>
          <span class="spacer"></span>
          <button class="ctrl-btn" id="settings-btn" aria-label="Settings"></button>
          <button class="ctrl-btn" id="fullscreen-btn" aria-label="Fullscreen (f)"></button>
        </div>

        <div class="settings-menu" id="settings-menu" hidden></div>
      </div>
    </div>
  </main>

  <script type="module" src="/js/player.js"></script>
</body>
</html>
```

- [ ] **Step 3: Commit**

```bash
git add public/index.html public/js/icons.js
git commit -m "feat: player HTML skeleton and SVG icons"
```

---

## Task 12: `styles.css` — YouTube-faithful dark theme

**Files:**
- Create: `public/styles.css`

- [ ] **Step 1: Write the stylesheet**

`public/styles.css`:
```css
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  background: #0f0f0f;
  font-family: "Roboto", "Segoe UI", system-ui, sans-serif;
  display: flex;
  min-height: 100vh;
  align-items: center;
  justify-content: center;
}

.stage { width: 100%; padding: 24px; }

.player {
  position: relative;
  width: min(1100px, 100%);
  margin: 0 auto;
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: 12px;
  overflow: hidden;
  outline: none;
}
.player:fullscreen { border-radius: 0; width: 100%; height: 100%; }

#video { width: 100%; height: 100%; display: block; background: #000; }

/* Spinner */
.spinner {
  position: absolute; inset: 0; margin: auto;
  width: 56px; height: 56px; border-radius: 50%;
  border: 5px solid rgba(255,255,255,.25); border-top-color: #fff;
  animation: spin 1s linear infinite;
}
.spinner[hidden] { display: none; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Error overlay */
.error-overlay {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 16px;
  background: rgba(0,0,0,.85); color: #fff; z-index: 5;
}
.error-overlay[hidden] { display: none; }
.retry-btn {
  background: #fff; color: #0f0f0f; border: none; border-radius: 18px;
  padding: 8px 18px; font-size: 14px; font-weight: 600; cursor: pointer;
}

/* Big center play */
.big-play {
  position: absolute; inset: 0; margin: auto;
  width: 68px; height: 48px; border: none; border-radius: 12px;
  background: rgba(20,20,20,.7); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.big-play svg { width: 34px; height: 34px; fill: #fff; }
.big-play[hidden] { display: none; }

/* Gradient scrim */
.gradient {
  position: absolute; left: 0; right: 0; bottom: 0; height: 120px;
  background: linear-gradient(to top, rgba(0,0,0,.7), rgba(0,0,0,0));
  pointer-events: none; opacity: 0; transition: opacity .2s;
}

/* Controls */
.controls {
  position: absolute; left: 0; right: 0; bottom: 0;
  padding: 0 12px 6px; opacity: 0; transition: opacity .2s; z-index: 4;
}
.player:hover .controls,
.player.paused .controls,
.player:focus-within .controls { opacity: 1; }
.player:hover .gradient,
.player.paused .gradient,
.player:focus-within .gradient { opacity: 1; }

/* Progress bar */
.progress { position: relative; height: 20px; display: flex; align-items: center; cursor: pointer; }
.progress-track { position: relative; width: 100%; height: 4px; background: rgba(255,255,255,.3); border-radius: 2px; transition: height .1s; }
.progress:hover .progress-track { height: 6px; }
.progress-buffered { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: rgba(255,255,255,.45); border-radius: 2px; }
.progress-played { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: #f00; border-radius: 2px; }
.progress-scrubber {
  position: absolute; left: 0; top: 50%; width: 13px; height: 13px;
  background: #f00; border-radius: 50%; transform: translate(-50%, -50%) scale(0);
  transition: transform .1s;
}
.progress:hover .progress-scrubber { transform: translate(-50%, -50%) scale(1); }

/* Hover thumbnail */
.progress-thumb {
  position: absolute; bottom: 24px; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 4px; pointer-events: none;
}
.progress-thumb[hidden] { display: none; }
.thumb-img { width: 160px; height: 90px; border: 2px solid #fff; border-radius: 4px; background-repeat: no-repeat; box-shadow: 0 4px 14px rgba(0,0,0,.6); }
.thumb-time { color: #fff; font-size: 12px; background: rgba(0,0,0,.7); padding: 1px 5px; border-radius: 3px; }

/* Control row */
.control-row { display: flex; align-items: center; gap: 4px; height: 44px; }
.ctrl-btn {
  background: none; border: none; height: 40px; min-width: 40px;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; padding: 0 6px;
}
.ctrl-btn svg { width: 26px; height: 26px; fill: #fff; }

.volume { display: flex; align-items: center; }
.volume-slider {
  position: relative; width: 0; height: 4px; background: rgba(255,255,255,.4);
  border-radius: 2px; margin: 0 4px; transition: width .15s; overflow: visible; cursor: pointer;
}
.volume:hover .volume-slider, .volume-slider.active { width: 56px; }
.vol-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; background: #fff; border-radius: 2px; }
.vol-knob { position: absolute; top: 50%; left: 100%; width: 12px; height: 12px; background: #fff; border-radius: 50%; transform: translate(-50%, -50%); }

.time { color: #fff; font-size: 13px; margin-left: 6px; white-space: nowrap; }
.spacer { flex: 1; }

/* Settings menu */
.settings-menu {
  position: absolute; right: 12px; bottom: 56px; min-width: 220px;
  background: rgba(28,28,28,.95); border-radius: 12px; padding: 8px 0;
  color: #eee; font-size: 14px; z-index: 6; box-shadow: 0 6px 24px rgba(0,0,0,.6);
}
.settings-menu[hidden] { display: none; }
.menu-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 16px; cursor: pointer; }
.menu-row:hover { background: rgba(255,255,255,.1); }
.menu-row .right { color: #aaa; display: flex; align-items: center; gap: 6px; }
.menu-row.back { font-weight: 600; border-bottom: 1px solid rgba(255,255,255,.12); }
.menu-row .check { width: 16px; color: #3ea6ff; }
.badge { font-size: 10px; font-weight: 700; color: #000; background: #fff; border-radius: 3px; padding: 0 3px; }
```

- [ ] **Step 2: Commit**

```bash
git add public/styles.css
git commit -m "feat: YouTube-faithful dark theme stylesheet"
```

---

## Task 13: `hls-controller.js` — adaptive streaming controller

**Files:**
- Create: `public/js/hls-controller.js`

- [ ] **Step 1: Write the controller**

`public/js/hls-controller.js`:
```js
// Wraps hls.js (global `Hls` from /vendor/hls.min.js). Falls back to native
// HLS (Safari) where hls.js is unsupported.
export function createHlsController(video, src, { onLevels, onAutoLevel, onError }) {
  const Hls = window.Hls;

  if (Hls && Hls.isSupported()) {
    const hls = new Hls({ enableWorker: true });
    hls.loadSource(src);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      const levels = hls.levels.map((l) => ({ height: l.height, bitrate: l.bitrate }));
      onLevels(levels);
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
      const level = hls.levels[data.level];
      if (level) onAutoLevel(level.height, hls.autoLevelEnabled);
    });

    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          hls.startLoad();
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          hls.recoverMediaError();
          break;
        default:
          onError('This video could not be played.');
          hls.destroy();
      }
    });

    return {
      setLevel(index) { hls.currentLevel = index; },
      destroy() { hls.destroy(); },
      get isNative() { return false; },
    };
  }

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Native HLS: the browser manages ABR; levels are not enumerable.
    video.src = src;
    video.addEventListener('loadedmetadata', () => onLevels([]));
    video.addEventListener('error', () => onError('This video could not be played.'));
    return {
      setLevel() {},
      destroy() { video.removeAttribute('src'); video.load(); },
      get isNative() { return true; },
    };
  }

  onError('HLS is not supported in this browser.');
  return { setLevel() {}, destroy() {}, get isNative() { return true; } };
}
```

- [ ] **Step 2: Commit**

```bash
git add public/js/hls-controller.js
git commit -m "feat: hls.js adaptive controller with error recovery and native fallback"
```

---

## Task 14: `controls.js` — buttons, volume, time, fullscreen

**Files:**
- Create: `public/js/controls.js`

- [ ] **Step 1: Write the controls module**

`public/js/controls.js`:
```js
import { formatTime } from './format.js';
import { ICONS } from './icons.js';

export function createControls({ video, container, els, onToggleSettings }) {
  function renderPlay() {
    const playing = !video.paused;
    els.playBtn.innerHTML = playing ? ICONS.pause : ICONS.play;
    els.bigPlay.innerHTML = ICONS.play;
    els.bigPlay.hidden = playing;
    container.classList.toggle('paused', video.paused);
  }

  function renderVolume() {
    const muted = video.muted || video.volume === 0;
    els.muteBtn.innerHTML = muted ? ICONS.volMute : ICONS.volHigh;
    const ratio = muted ? 0 : video.volume;
    els.volFill.style.width = `${ratio * 100}%`;
    els.volKnob.style.left = `${ratio * 100}%`;
  }

  function renderTime() {
    els.timeLabel.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
  }

  function renderFullscreen() {
    const fs = document.fullscreenElement === container;
    els.fullscreenBtn.innerHTML = fs ? ICONS.exitFullscreen : ICONS.enterFullscreen;
  }

  function togglePlay() {
    if (video.paused) video.play(); else video.pause();
  }

  function setVolumeFromEvent(e) {
    const rect = els.volSlider.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    video.volume = ratio;
    video.muted = ratio === 0;
  }

  // Button wiring
  els.playBtn.addEventListener('click', togglePlay);
  els.bigPlay.addEventListener('click', togglePlay);
  els.muteBtn.addEventListener('click', () => { video.muted = !video.muted; });
  els.settingsBtn.addEventListener('click', (e) => { e.stopPropagation(); onToggleSettings(); });
  els.fullscreenBtn.addEventListener('click', () => {
    if (document.fullscreenElement === container) document.exitFullscreen();
    else container.requestFullscreen();
  });

  // Volume drag
  let draggingVol = false;
  els.volSlider.addEventListener('pointerdown', (e) => {
    draggingVol = true;
    els.volSlider.setPointerCapture(e.pointerId);
    setVolumeFromEvent(e);
  });
  els.volSlider.addEventListener('pointermove', (e) => { if (draggingVol) setVolumeFromEvent(e); });
  els.volSlider.addEventListener('pointerup', (e) => {
    draggingVol = false;
    els.volSlider.releasePointerCapture(e.pointerId);
  });

  // Video state -> UI
  video.addEventListener('play', renderPlay);
  video.addEventListener('pause', renderPlay);
  video.addEventListener('volumechange', renderVolume);
  video.addEventListener('timeupdate', renderTime);
  video.addEventListener('loadedmetadata', renderTime);
  document.addEventListener('fullscreenchange', renderFullscreen);

  // Initial paint
  renderPlay();
  renderVolume();
  renderTime();
  renderFullscreen();

  return { renderPlay, renderVolume, renderTime };
}
```

- [ ] **Step 2: Commit**

```bash
git add public/js/controls.js
git commit -m "feat: control bar (play/pause, volume, mute, time, fullscreen)"
```

---

## Task 15: `progress-bar.js` — scrubbing + storyboard hover

**Files:**
- Create: `public/js/progress-bar.js`

- [ ] **Step 1: Write the progress-bar module**

`public/js/progress-bar.js`:
```js
import { formatTime } from './format.js';

export function createProgressBar({ video, els, storyboard }) {
  function ratioFromEvent(e) {
    const rect = els.progress.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  function renderProgress() {
    if (!video.duration) return;
    const pct = (video.currentTime / video.duration) * 100;
    els.played.style.width = `${pct}%`;
    els.scrubber.style.left = `${pct}%`;
  }

  function renderBuffered() {
    if (!video.duration || video.buffered.length === 0) return;
    const end = video.buffered.end(video.buffered.length - 1);
    els.buffered.style.width = `${(end / video.duration) * 100}%`;
  }

  function showThumb(e) {
    if (!video.duration) return;
    const ratio = ratioFromEvent(e);
    const time = ratio * video.duration;
    const rect = els.progress.getBoundingClientRect();

    els.thumb.hidden = false;
    els.thumb.style.left = `${Math.min(rect.width - 80, Math.max(80, ratio * rect.width))}px`;
    els.thumbTime.textContent = formatTime(time);

    if (storyboard) {
      const loc = storyboard.locate(time);
      els.thumbImg.style.backgroundImage = `url(${storyboard.sheetUrl(loc.sheet)})`;
      els.thumbImg.style.backgroundPosition = `-${loc.x}px -${loc.y}px`;
    }
  }

  function seekToEvent(e) {
    if (!video.duration) return;
    video.currentTime = ratioFromEvent(e) * video.duration;
    renderProgress();
  }

  let scrubbing = false;
  els.progress.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    els.progress.setPointerCapture(e.pointerId);
    seekToEvent(e);
  });
  els.progress.addEventListener('pointermove', (e) => {
    if (scrubbing) seekToEvent(e);
    else showThumb(e);
  });
  els.progress.addEventListener('pointerup', (e) => {
    scrubbing = false;
    els.progress.releasePointerCapture(e.pointerId);
  });
  els.progress.addEventListener('pointerleave', () => { els.thumb.hidden = true; });

  video.addEventListener('timeupdate', renderProgress);
  video.addEventListener('progress', renderBuffered);
  video.addEventListener('loadedmetadata', () => { renderProgress(); renderBuffered(); });

  return { renderProgress, renderBuffered };
}
```

- [ ] **Step 2: Commit**

```bash
git add public/js/progress-bar.js
git commit -m "feat: progress bar scrubbing, buffered render, storyboard hover"
```

---

## Task 16: `settings-menu.js` — quality + speed menu

**Files:**
- Create: `public/js/settings-menu.js`

- [ ] **Step 1: Write the settings-menu module**

`public/js/settings-menu.js`:
```js
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
```

- [ ] **Step 2: Add the small badge-sub style**

Append to `public/styles.css`:
```css
.badge-sub { color: #aaa; }
```

- [ ] **Step 3: Commit**

```bash
git add public/js/settings-menu.js public/styles.css
git commit -m "feat: settings menu with quality and playback-speed submenus"
```

---

## Task 17: `player.js` — orchestrator

**Files:**
- Create: `public/js/player.js`

- [ ] **Step 1: Write the orchestrator**

`public/js/player.js`:
```js
import { createHlsController } from './hls-controller.js';
import { createControls } from './controls.js';
import { createProgressBar } from './progress-bar.js';
import { createSettingsMenu } from './settings-menu.js';
import { loadStoryboard } from './storyboard.js';
import { attachKeyboard } from './keyboard.js';
import { nextRate } from './playback.js';

const $ = (id) => document.getElementById(id);
const MASTER = '/media/hls/master.m3u8';
const FPS = 30000 / 1001; // source frame rate (~29.97)

async function init() {
  const video = $('video');
  const container = $('player');

  const els = {
    playBtn: $('play-btn'), bigPlay: $('big-play'), muteBtn: $('mute-btn'),
    volSlider: $('vol-slider'), volFill: $('vol-fill'), volKnob: $('vol-knob'),
    timeLabel: $('time'), settingsBtn: $('settings-btn'), fullscreenBtn: $('fullscreen-btn'),
    progress: $('progress'), played: $('played'), buffered: $('buffered'), scrubber: $('scrubber'),
    thumb: $('thumb'), thumbImg: $('thumb-img'), thumbTime: $('thumb-time'),
  };
  const spinner = $('spinner');
  const errorOverlay = $('error');
  const errorMsg = $('error-msg');
  const retryBtn = $('retry-btn');
  const settingsMenuEl = $('settings-menu');

  // Buffering spinner
  video.addEventListener('waiting', () => { spinner.hidden = false; });
  video.addEventListener('playing', () => { spinner.hidden = true; });
  video.addEventListener('canplay', () => { spinner.hidden = true; });

  // Error overlay
  function showError(message) {
    errorMsg.textContent = message;
    errorOverlay.hidden = false;
    spinner.hidden = true;
  }
  retryBtn.addEventListener('click', () => { errorOverlay.hidden = true; location.reload(); });

  const storyboard = await loadStoryboard('/media/storyboard/storyboard.json');

  const settings = createSettingsMenu({ menuEl: settingsMenuEl, video, hlsController: { setLevel: (i) => hls.setLevel(i) } });

  const hls = createHlsController(video, MASTER, {
    onLevels: (levels) => settings.setLevels(levels),
    onAutoLevel: (height, autoEnabled) => settings.setAutoLevel(height, autoEnabled),
    onError: (msg) => showError(msg),
  });

  createControls({
    video, container, els,
    onToggleSettings: () => settings.toggle(),
  });
  createProgressBar({ video, els, storyboard });

  // Close settings menu when clicking elsewhere in the player
  container.addEventListener('click', (e) => {
    if (settings.isOpen() && !settingsMenuEl.contains(e.target) && e.target !== els.settingsBtn) {
      settings.close();
    }
  });

  // Keyboard actions
  attachKeyboard(container, {
    togglePlay: () => { if (video.paused) video.play(); else video.pause(); },
    toggleMute: () => { video.muted = !video.muted; },
    seekBy: (d) => { video.currentTime = Math.min(video.duration || 0, Math.max(0, video.currentTime + d)); },
    volumeBy: (d) => { video.muted = false; video.volume = Math.min(1, Math.max(0, video.volume + d)); },
    seekToPercent: (p) => { if (video.duration) video.currentTime = p * video.duration; },
    seekToEnd: () => { if (video.duration) video.currentTime = video.duration; },
    frameStep: (dir) => { if (!video.paused) video.pause(); video.currentTime += dir / FPS; },
    speedStep: (dir) => { video.playbackRate = nextRate(video.playbackRate, dir); },
    toggleFullscreen: () => {
      if (document.fullscreenElement === container) document.exitFullscreen();
      else container.requestFullscreen();
    },
  });

  // Start focused so keyboard works immediately
  container.focus();
}

init();
```

- [ ] **Step 2: Commit**

```bash
git add public/js/player.js
git commit -m "feat: player orchestrator wiring all modules + keyboard actions"
```

---

## Task 18: Full unit-test run + manual integration verification

**Files:**
- (No new files — verification task)

- [ ] **Step 1: Run the full unit suite**

Run:
```bash
npm test
```
Expected: all test files pass (format, playback, quality, storyboard, keyboard, http-util).

- [ ] **Step 2: Ensure media is built**

If `media/hls/master.m3u8` or `media/storyboard/storyboard.json` is missing, run:
```bash
npm run build
```
Expected: HLS ladder + storyboard present (from Tasks 9–10).

- [ ] **Step 3: Start the server and open the player**

Run:
```bash
npm start
```
Open `http://localhost:8080` in Chrome.

- [ ] **Step 4: Manual QA checklist** (verify each; all must pass)

Playback & controls:
- [ ] Poster shows; clicking the big play button (or `k`/Space) starts playback
- [ ] Play/pause button and big-play icon reflect state
- [ ] Volume slider drags and changes loudness; `↑`/`↓` change volume by 5%
- [ ] Mute button and `m` toggle mute; icon updates
- [ ] Time display reads `current / total` and updates

Seeking:
- [ ] Clicking the progress bar seeks; dragging scrubs
- [ ] `j`/`l` seek ±10s; `←`/`→` seek ±5s
- [ ] `0`–`9` jump to 0–90%; `Home`/`End` jump to start/end
- [ ] While paused, `.`/`,` step one frame forward/back

Storyboard:
- [ ] Hovering the progress bar shows a thumbnail preview that tracks the cursor and matches the time

Quality & speed:
- [ ] Settings gear opens the menu; Quality submenu lists 1440p/1080p/720p/480p/360p + Auto
- [ ] Selecting a fixed quality pins it; Auto shows the current resolution
- [ ] In Chrome DevTools → Network, throttle to "Slow 3G"; playback auto-downshifts to a lower rung (verify the Auto resolution drops)
- [ ] Playback speed submenu changes speed; `>`/`<` step speed

Fullscreen & chrome:
- [ ] `f` and the fullscreen button toggle fullscreen; icon updates
- [ ] Controls fade out on idle and reappear on hover/focus/pause

Errors:
- [ ] Stop the server while playing un-buffered video → buffering spinner appears; on fatal error the Retry overlay shows and reloads

- [ ] **Step 5: Commit any fixes found during QA**

```bash
git add -A
git commit -m "fix: address issues found during manual QA"
```

> If QA passes with no changes, skip this commit.

---

## Task 19 (Optional): Playwright smoke test

**Files:**
- Create: `tests/smoke.spec.js`
- Modify: `package.json` (add Playwright devDependency + script)

- [ ] **Step 1: Install Playwright**

```bash
npm install -D @playwright/test
npx playwright install chromium
```

- [ ] **Step 2: Add a script to `package.json`**

Add to the `"scripts"` block:
```json
"test:e2e": "playwright test"
```

- [ ] **Step 3: Write the smoke test**

`tests/smoke.spec.js`:
```js
import { test, expect } from '@playwright/test';

// Requires `npm start` running on :8080 and media already built.
test('loads, plays, and exposes the quality menu', async ({ page }) => {
  await page.goto('http://localhost:8080');

  const video = page.locator('#video');
  await expect(video).toBeVisible();

  await page.locator('#big-play').click();
  await page.waitForTimeout(1000);
  const isPlaying = await video.evaluate((v) => !v.paused);
  expect(isPlaying).toBe(true);

  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-menu')).toBeVisible();
  await expect(page.getByText('Quality')).toBeVisible();
});
```

- [ ] **Step 4: Run it**

In one terminal: `npm start`. In another:
```bash
npm run test:e2e
```
Expected: the smoke test passes.

- [ ] **Step 5: Commit**

```bash
git add tests/smoke.spec.js package.json package-lock.json
git commit -m "test: Playwright smoke test for load/play/quality menu"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** transcode ladder (Task 9), storyboard (Task 10), server with range + MIME (Tasks 7–8), all player modules (Tasks 11–17), adaptive streaming + quality menu (Tasks 13, 16), every in-scope keyboard shortcut (Task 6), error handling/spinner/retry (Task 17), unit + manual + optional smoke testing (Tasks 18–19). Out-of-scope shortcuts (`c`, `i`, `t`, `Shift+N/P`, `/`, chapters) are intentionally unmapped — `resolveAction` returns `null` for them.
- **Type consistency:** module factory names and their consumers match — `createHlsController` → `{ setLevel, destroy, isNative }`; `createSettingsMenu` → `{ open, close, toggle, isOpen, setLevels, setAutoLevel }`; `createControls`/`createProgressBar` attach listeners and return render helpers; `loadStoryboard` → `{ meta, locate, sheetUrl }` consumed by `progress-bar.js`. The `hlsController` object passed into `createSettingsMenu` exposes `setLevel`, matching its use.
- **No placeholders:** every step contains runnable code or a concrete command with expected output.
```
