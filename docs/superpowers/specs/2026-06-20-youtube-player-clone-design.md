# YouTube Player Clone — Design Spec

**Date:** 2026-06-20
**Status:** Approved design, ready for implementation planning

## Goal

A faithful, single-video YouTube **player** clone for the local video `bikinis.mp4`. It looks and behaves like YouTube's player: play/pause, volume, mute, quality selection, playback speed, fullscreen, a scrubbable progress bar with hover thumbnail previews, and YouTube's keyboard shortcuts. The video is delivered as an adaptive HLS stream so playback starts almost immediately and quality auto-adjusts to the viewer's connection speed.

## Scope

**In scope:** the player widget only — the video frame plus its control bar — centered on an otherwise minimal page.

**Out of scope:** the rest of the YouTube watch page (title, channel row, like/share, description, recommendations, comments, top nav, search). Public internet hosting (built local-first, but architected to deploy later).

### Source video

`bikinis.mp4` — H.264 / AAC, 2688×1512 (≈1512p, 16:9), ~7:08 (428s), ~10 Mbps, 29.97 fps. Left untouched; all renditions are generated from it.

## Architecture

Two distinct parts:

1. **Offline build** (run once, slow): `ffmpeg` transcodes the source into an HLS quality ladder plus storyboard thumbnail sprites. Output goes to a generated `media/` directory.
2. **Runtime**: a zero-dependency Node static server serves `public/` (the player app) and `media/` (the stream). The browser player uses vendored `hls.js` for adaptive playback.

### Directory layout

```
youtube clone/
  bikinis.mp4              ← source, untouched
  build/
    transcode.mjs          ← ffmpeg → HLS ladder
    storyboard.mjs         ← ffmpeg → sprite sheets + index
  media/                   ← GENERATED (gitignored)
    hls/
      master.m3u8
      360p/  (playlist.m3u8 + *.ts segments)
      480p/
      720p/
      1080p/
      1440p/
    storyboard/
      sprite-*.jpg
      storyboard.json
    poster.jpg
  public/
    index.html
    styles.css
    js/                    ← player modules (see "Player modules")
    vendor/hls.min.js
  server.mjs               ← static server (range + correct MIME)
  tests/
  package.json
  docs/superpowers/specs/  ← this spec
```

## Build step — transcoding ladder

`build/transcode.mjs` shells out to `ffmpeg` to produce 5 renditions (H.264 video + AAC audio), each segmented into ~4-second `.ts` chunks with a per-rendition playlist, plus a `master.m3u8` listing all qualities with their bandwidth/resolution attributes.

| Quality | Resolution | Target video bitrate |
|---------|------------|----------------------|
| 360p    | 640×360    | ~0.8 Mbps |
| 480p    | 854×480    | ~1.4 Mbps |
| 720p    | 1280×720   | ~2.8 Mbps |
| 1080p   | 1920×1080  | ~5 Mbps   |
| 1440p   | 2560×1440  | ~10 Mbps  |

All dimensions are even and preserve the 16:9 aspect ratio. 1440p is a slight downscale from the 1512p source.

`build/storyboard.mjs` extracts a frame every ~2 seconds, scales each to a 160×90 thumbnail, and tiles them onto sprite sheets (e.g. a grid per sheet). It writes `storyboard.json` mapping each timestamp to its sprite file plus x/y offset and tile dimensions. It also writes `poster.jpg` (the first frame) for the paused-state background.

The build scripts verify `ffmpeg` is available on PATH and fail loudly with a clear message if not.

## Runtime server

`server.mjs` uses Node's built-in `http` module with **no runtime dependencies**. Requirements:

- Serve static files from `public/` and `media/`.
- Correct `Content-Type` headers, notably `.m3u8` → `application/vnd.apple.mpegurl`, `.ts` → `video/mp2t`, `.jpg` → `image/jpeg`, `.json` → `application/json`.
- HTTP **Range** request support (for poster, sprites, and seeking).
- Start with a single command (`node server.mjs`); print the local URL (`http://localhost:PORT`).

## Player modules (vanilla JS, ES modules)

Each module has a single, clear responsibility and communicates through a small interface:

- `player.js` — orchestrator; constructs the other modules and wires events between them.
- `hls-controller.js` — initializes hls.js against `master.m3u8`; exposes the list of quality levels; handles auto/manual level switching; emits bandwidth/level-switch events. Uses hls.js native path on Safari fallback where applicable.
- `controls.js` — play/pause, volume slider, mute toggle, current/total time display, fullscreen toggle, settings (gear) button.
- `progress-bar.js` — renders played and buffered ranges; click-and-drag scrubbing; hover → storyboard thumbnail preview positioned above the cursor.
- `storyboard.js` — loads `storyboard.json`; maps a playback time to the correct sprite file and crop rectangle.
- `settings-menu.js` / `quality-menu.js` — the gear menu with Quality and Playback speed submenus.
- `keyboard.js` — maps key events to player actions (see "Keyboard shortcuts").
- `format.js` — time formatting helper (e.g. `3:42 / 7:08`).

## Adaptive streaming & quality menu

hls.js loads `master.m3u8` and runs its ABR controller (EWMA bandwidth estimate) to select the best rung. Because it fetches only the segments needed, playback starts quickly, and it **downshifts automatically when the connection slows** (and upshifts when it recovers).

- The quality menu shows `Auto (<current resolution>)` plus each fixed level.
- Selecting a fixed level pins `hls.currentLevel` to that index; selecting Auto sets it to `-1`.
- A `LEVEL_SWITCHED` listener keeps the displayed/badged resolution in sync with what's actually playing.
- Initial state is **paused with the poster shown** — the user clicks Play to start. This also sidesteps browser autoplay restrictions (no muted-autoplay workaround needed).

## Keyboard shortcuts

**In scope** (wired to actions):

| Key(s) | Action |
|--------|--------|
| `Space`, `k` | Play / pause |
| `m` | Mute / unmute |
| `j` | Rewind 10s |
| `l` | Forward 10s |
| `←` / `→` | Seek −5s / +5s |
| `↑` / `↓` | Volume +5% / −5% |
| `0`–`9` | Seek to 0%–90% of duration |
| `Home` / `End` | Jump to start / end |
| `.` / `,` | Next / previous frame (while paused) |
| `>` / `<` (Shift+. / Shift+,) | Increase / decrease playback speed |
| `f` | Toggle fullscreen |

Frame stepping advances/rewinds by one frame (1 / 29.97 ≈ 0.0334s) while paused.

**Out of scope** (intentionally not wired, because the feature was cut or doesn't apply to a single video): `c` captions, `i` miniplayer, `t` theater mode, `Shift+N` / `Shift+P` next/previous video, `/` search, chapter navigation (`Ctrl+←/→`).

## Error handling

- **hls.js errors:** network errors retry the failed segment; media errors call `hls.recoverMediaError()`; fatal errors show an overlay with a **Retry** button.
- **Buffering:** show a spinner on the `waiting` event; hide it on `playing`.
- **Build failures:** `transcode.mjs` / `storyboard.mjs` validate ffmpeg up front and exit with a clear message on failure.
- **Missing media:** server returns 404; the player shows a clear on-screen error rather than a silent black frame.

## Testing

- **Unit (TDD)** for pure logic modules: `format.js` (time formatting), `keyboard.js` (key → action mapping/dispatch), `storyboard.js` (time → sprite math), quality-level mapping. Runner: **Vitest** with jsdom.
- **Smoke (optional):** a Playwright test that loads the page, clicks Play, and toggles a couple of controls.
- **Manual QA checklist:** every keyboard shortcut; quality switch (auto + manual); auto-downshift verified by throttling the network in devtools; scrub thumbnail preview; volume/mute; fullscreen.

## Build & run (developer workflow)

1. `node build/transcode.mjs` — generate the HLS ladder (one-time, slow).
2. `node build/storyboard.mjs` — generate thumbnail sprites + index (one-time).
3. `node server.mjs` — start the static server and open the printed URL.

## Decisions captured

- **Scope:** player only. **Hosting:** local-first, deployable later.
- **Streaming:** HLS + hls.js (chosen over DASH and progressive multi-MP4) for true adaptive bitrate.
- **Quality ladder:** 360 / 480 / 720 / 1080 / 1440 + Auto.
- **Stack:** vanilla JS + hls.js, zero runtime dependencies (ffmpeg required only at build time).
- **Optional features:** scrub thumbnail previews **included**; captions/CC, miniplayer, theater/ambient mode **excluded**.
- **Look:** faithful YouTube dark theme, slim control bar (no CC/miniplayer/theater buttons).
