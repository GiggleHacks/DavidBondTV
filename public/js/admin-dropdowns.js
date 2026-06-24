export function setExpanded(btn, expanded) {
  btn?.setAttribute('aria-expanded', String(Boolean(expanded)));
}

export function togglePanel(btn, panel, closeOthers) {
  if (!panel) return false;
  const willOpen = Boolean(panel.hidden);
  closeOthers?.(willOpen ? panel : null);
  panel.hidden = !willOpen;
  setExpanded(btn, willOpen);
  return willOpen;
}

export function closeAfterAction(action, closeAll) {
  return (...args) => {
    action?.(...args);
    closeAll?.();
  };
}
