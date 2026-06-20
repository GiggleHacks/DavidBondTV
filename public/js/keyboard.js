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
