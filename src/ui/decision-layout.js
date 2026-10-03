// A decision gets its own screen band. The tactical pitch must be fitted
// inside pitchArea, so every pass target remains visible above the choices.
export function computeDecisionLayout(w, h, optionCount, { flip = false, hudHeight = 44 } = {}) {
  const sheetWidth = Math.min(w, 960);
  const columns = Math.max(1, Math.min(optionCount || 1, Math.floor((sheetWidth - 20 + 7) / 135)));
  const rowHeight = 68;
  const rows = Math.max(1, Math.ceil(optionCount / columns));
  const usableHeight = Math.max(0, h - hudHeight);
  // Short screens scroll the choices, keeping at least half the space for
  // the pitch. Taller screens can show all six choices without scrolling.
  const panelHeight = Math.min(64 + rows * rowHeight + (rows - 1) * 7, Math.floor(usableHeight * 0.48));
  const panel = { x: 0, y: flip ? 0 : h - panelHeight, w, h: panelHeight };
  const hud = { x: 0, y: flip ? panelHeight : 0, w, h: hudHeight };
  const pitchArea = { x: 0, y: hud.y + hudHeight, w, h: usableHeight - panelHeight };
  return { panel, hud, pitchArea, columns, rowHeight };
}
