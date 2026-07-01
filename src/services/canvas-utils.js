export function resolveCanvasSize(cssWidth, cssHeight, dpr = window.devicePixelRatio || 1) {
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return {
    cssWidth,
    cssHeight,
    dpr: safeDpr,
    backingWidth: Math.max(1, Math.round(cssWidth * safeDpr)),
    backingHeight: Math.max(1, Math.round(cssHeight * safeDpr)),
  };
}

export function applyCanvasSize(canvas, cssWidth, cssHeight, dpr = window.devicePixelRatio || 1) {
  const metrics = resolveCanvasSize(cssWidth, cssHeight, dpr);
  canvas.width = metrics.backingWidth;
  canvas.height = metrics.backingHeight;
  canvas.style.width = `${metrics.cssWidth}px`;
  canvas.style.height = `${metrics.cssHeight}px`;
  return metrics;
}
