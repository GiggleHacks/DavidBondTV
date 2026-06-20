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
