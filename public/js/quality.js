// Human-friendly label for a rendition height (e.g. 720 -> "720p").
export function qualityLabel(height) {
  return `${height}p`;
}

export function buildQualityOptions(levels, currentLevel, currentAutoHeight) {
  const options = levels
    .map((l, index) => ({ index, height: l.height }))
    .sort((a, b) => b.height - a.height)
    .map(({ index, height }) => ({
      index,
      label: qualityLabel(height),
      hd: height >= 720,
      active: currentLevel === index,
    }));

  options.push({
    index: -1,
    label: 'Auto',
    hd: false,
    active: currentLevel === -1,
    sublabel: currentAutoHeight ? qualityLabel(currentAutoHeight) : '',
  });

  return options;
}
