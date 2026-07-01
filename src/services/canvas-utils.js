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

export function drawImagePreservingSize(context, image, options = {}) {
  const dpr = Number.isFinite(options.dpr) && options.dpr > 0 ? options.dpr : 1;
  const cssWidth = Number.isFinite(options.cssWidth)
    ? options.cssWidth
    : image?.naturalWidth || image?.width || 0;
  const cssHeight = Number.isFinite(options.cssHeight)
    ? options.cssHeight
    : image?.naturalHeight || image?.height || 0;

  if (!context || !image) return { width: 0, height: 0 };

  const logicalWidth = Math.max(1, cssWidth / dpr);
  const logicalHeight = Math.max(1, cssHeight / dpr);

  const width = Math.max(1, logicalWidth);
  const height = Math.max(1, logicalHeight);
  const x = Number.isFinite(options.x) ? options.x : 0;
  const y = Number.isFinite(options.y) ? options.y : 0;

  context.drawImage(image, x, y, width, height);
  return { width, height, x, y };
}

export function resolveSnapshotTargetSize(currentWidth, currentHeight, previousSize = null) {
  const width = Number.isFinite(currentWidth) ? Math.max(1, Math.round(currentWidth)) : 1;
  const height = Number.isFinite(currentHeight) ? Math.max(1, Math.round(currentHeight)) : 1;
  const previousWidth =
    previousSize && Number.isFinite(previousSize.width)
      ? Math.max(1, Math.round(previousSize.width))
      : 0;
  const previousHeight =
    previousSize && Number.isFinite(previousSize.height)
      ? Math.max(1, Math.round(previousSize.height))
      : 0;

  return {
    width: Math.max(width, previousWidth),
    height: Math.max(height, previousHeight),
  };
}

export function scalePoint(point, fromSize, toSize) {
  if (!point || typeof point !== "object") return point;

  const fromWidth = Number.isFinite(fromSize?.width) ? Math.max(1, fromSize.width) : 1;
  const fromHeight = Number.isFinite(fromSize?.height) ? Math.max(1, fromSize.height) : 1;
  const toWidth = Number.isFinite(toSize?.width) ? Math.max(1, toSize.width) : 1;
  const toHeight = Number.isFinite(toSize?.height) ? Math.max(1, toSize.height) : 1;

  return {
    x: (Number(point.x) / fromWidth) * toWidth,
    y: (Number(point.y) / fromHeight) * toHeight,
  };
}

export function shouldApplyRemoteSnapshot(payload, hasLocalContent = false) {
  if (!payload || typeof payload !== "object") return false;
  if (typeof payload.snapshot !== "string" || !payload.snapshot.length) return false;
  return !hasLocalContent;
}
