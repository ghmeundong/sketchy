// localStorage.clear(); window.location.reload(); 로컬 테스트 시 초기

import "./style.css";
import { api, API_BASE_URL } from "./services/api.js";
import { supabase } from "./services/supabase.js";
import {
  applyCanvasSize,
  drawImagePreservingSize,
  resolveSnapshotTargetSize,
  resolveViewportSize,
  shouldApplyRemoteSnapshot,
} from "./services/canvas-utils.js";
import { normalizeSketchPayload } from "./services/sketch-state.js";
import rough from "roughjs";

const root = document.querySelector("main");
if (!root) throw new Error("Main element not found.");

root.innerHTML = `
  <div class="canvas-shell">
    <canvas id="sketch-canvas"></canvas>
    <div id="paper-texture" class="paper-texture"></div>
    <div class="palette" id="palette">
      <div class="palette-row">
        <label></label>
        <div class="mode-selector">
          <button type="button" class="mode-btn active" data-mode="pencil" title="pencil">✏️</button>
          <button type="button" class="mode-btn" data-mode="crayon" title="crayon">🖍️</button>
          <button type="button" class="mode-btn" data-mode="brush" title="brush">🖌️</button>
        </div>
      </div>
      <div class="palette-row">
        <input id="color-input" type="color" value="#111111" />
        <input id="size-range" type="range" min="1" max="8" value="4" />
      </div>
    </div>
    <button id="replay-button" class="floating-play-button" type="button" aria-label="재생">
      <span class="play-icon">▶</span>
    </button>
    <div id="loading-overlay" class="loading-overlay">
      <p>Loading doodles from R2...</p>
      <canvas id="loading-spinner-canvas" width="60" height="60"></canvas>
    </div>
  </div>
`;

const canvas = document.querySelector("#sketch-canvas");
const colorInput = document.querySelector("#color-input");
const sizeRange = document.querySelector("#size-range");
const replayButton = document.querySelector("#replay-button");
const palette = document.querySelector("#palette");

if (!canvas || !colorInput || !sizeRange || !replayButton || !palette) {
  throw new Error("UI 요소를 찾을 수 없습니다.");
}

const ctx = canvas.getContext("2d");
const rc = rough.canvas(canvas);
let dpr = window.devicePixelRatio || 1;
let offscreenCanvas = null;
let offscreenCtx = null;
let offscreenRc = null;

let currentMode = "pencil";
let canvasWidth = 0;
let canvasHeight = 0;
let snapshotTargetSize = null;
let logicalCanvasSize = null;
let drawing = false;
let remoteResizeInProgress = false;
let hasLocalBoardContent = false;

function readSnapshotTargetSize() {
  try {
    const stored = localStorage.getItem("sketchy-snapshot-target-size");
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      width: Number(parsed.width) || 0,
      height: Number(parsed.height) || 0,
    };
  } catch {
    return null;
  }
}

function persistSnapshotTargetSize(size) {
  try {
    if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
    localStorage.setItem("sketchy-snapshot-target-size", JSON.stringify(size));
  } catch {
    // ignore
  }
}
let lastPoint = null;
let paletteDrag = null;
let buttonDrag = null;
let buttonDragMoved = false;
let strokes = [];
let currentStroke = null;
let channel = null;
let saveTimeout = null;
let replaying = false;
let remoteSyncVersion = 0;
const CLIENT_ID = Math.floor(Math.random() * 0xffffffff);

const MAX_STROKES = 100;
const MERGE_FROM = 50;

const MODE_SETTINGS = {
  pencil: { min: 1, max: 8, default: 2 },
  crayon: { min: 4, max: 24, default: 10 },
  brush: { min: 2, max: 100, default: 25 },
};

function logStatus(message) {
  console.log(message);
}

function clearSketchLocalState() {
  try {
    localStorage.removeItem("sketchy-canvas");
    localStorage.removeItem("sketchy-strokes");
    localStorage.removeItem("sketchy-snapshot-target-size");
  } catch {
    // ignore
  }
}

function getRect(element) {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function rectsIntersect(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function resolveCollision(movingEl, otherEl, desiredX, desiredY) {
  const movingRect = {
    left: desiredX,
    top: desiredY,
    width: movingEl.offsetWidth,
    height: movingEl.offsetHeight,
  };
  movingRect.right = movingRect.left + movingRect.width;
  movingRect.bottom = movingRect.top + movingRect.height;

  const otherRect = getRect(otherEl);
  if (!rectsIntersect(movingRect, otherRect)) {
    return { x: desiredX, y: desiredY };
  }

  const overlapX = movingRect.right - otherRect.left;
  const overlapX2 = otherRect.right - movingRect.left;
  const overlapY = movingRect.bottom - otherRect.top;
  const overlapY2 = otherRect.bottom - movingRect.top;

  let adjustX = 0;
  let adjustY = 0;
  let pushX = 0;
  let pushY = 0;
  let minOverlap = Infinity;

  if (overlapX > 0 && overlapX < minOverlap) {
    minOverlap = overlapX;
    adjustX = -overlapX;
    pushX = overlapX;
    pushY = 0;
  }
  if (overlapX2 > 0 && overlapX2 < minOverlap) {
    minOverlap = overlapX2;
    adjustX = overlapX2;
    pushX = -overlapX2;
    pushY = 0;
  }
  if (overlapY > 0 && overlapY < minOverlap) {
    minOverlap = overlapY;
    adjustX = 0;
    adjustY = -overlapY;
    pushX = 0;
    pushY = overlapY;
  }
  if (overlapY2 > 0 && overlapY2 < minOverlap) {
    adjustX = 0;
    adjustY = overlapY2;
    pushX = 0;
    pushY = -overlapY2;
  }

  const windowWidth = window.innerWidth;
  const windowHeight = window.innerHeight;
  const adjustedX = clamp(desiredX + adjustX, 0, windowWidth - movingRect.width);
  const adjustedY = clamp(desiredY + adjustY, 0, windowHeight - movingRect.height);

  const otherDesiredX = clamp(otherRect.left + pushX, 0, windowWidth - otherRect.width);
  const otherDesiredY = clamp(otherRect.top + pushY, 0, windowHeight - otherRect.height);

  const triedOther = otherRect.left !== otherDesiredX || otherRect.top !== otherDesiredY;
  if (triedOther) {
    otherEl.style.left = `${otherDesiredX}px`;
    otherEl.style.top = `${otherDesiredY}px`;
  }

  return { x: adjustedX, y: adjustedY };
}

function ensureOffscreenCanvas() {
  const targetSize = snapshotTargetSize ||
    logicalCanvasSize || { width: canvasWidth, height: canvasHeight };
  const backingWidth = Math.max(1, Math.round(targetSize.width * dpr));
  const backingHeight = Math.max(1, Math.round(targetSize.height * dpr));

  if (
    !offscreenCanvas ||
    offscreenCanvas.width !== backingWidth ||
    offscreenCanvas.height !== backingHeight
  ) {
    offscreenCanvas = document.createElement("canvas");
    offscreenCtx = offscreenCanvas.getContext("2d");
    offscreenRc = rough.canvas(offscreenCanvas);
  }

  if (offscreenCanvas && offscreenCtx) {
    applyCanvasSize(offscreenCanvas, targetSize.width, targetSize.height, dpr);
    offscreenCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  return offscreenCanvas;
}

function renderOffscreenCanvasToViewport() {
  if (!offscreenCanvas || !ctx) return;
  const logicalWidth = logicalCanvasSize?.width || offscreenCanvas.width / dpr;
  const logicalHeight = logicalCanvasSize?.height || offscreenCanvas.height / dpr;
  const offsetX = (canvasWidth - logicalWidth) / 2;
  const offsetY = (canvasHeight - logicalHeight) / 2;

  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.drawImage(offscreenCanvas, offsetX, offsetY, logicalWidth, logicalHeight);
}

function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  const viewport = resolveViewportSize(canvas, window.innerWidth, window.innerHeight);
  canvasWidth = viewport.width;
  canvasHeight = viewport.height;
  const nextTargetSize = resolveSnapshotTargetSize(canvasWidth, canvasHeight, snapshotTargetSize);
  snapshotTargetSize = nextTargetSize;
  logicalCanvasSize = snapshotTargetSize;
  persistSnapshotTargetSize(snapshotTargetSize);
  remoteResizeInProgress = true;

  const metrics = applyCanvasSize(canvas, canvasWidth, canvasHeight, dpr);
  ctx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  ensureOffscreenCanvas();
  if (offscreenCtx) {
    offscreenCtx.clearRect(0, 0, logicalCanvasSize.width, logicalCanvasSize.height);
  }
  renderOffscreenCanvasToViewport();
}

function syncMainCanvasFromOffscreen() {
  renderOffscreenCanvasToViewport();
}

function drawCachedImage(imageData, options = {}) {
  if (!imageData) return false;

  const img = new Image();
  img.onload = () => {
    const targetWidth = Number.isFinite(options.cssWidth) ? options.cssWidth : img.naturalWidth;
    const targetHeight = Number.isFinite(options.cssHeight) ? options.cssHeight : img.naturalHeight;
    const renderWidth = Math.max(1, Math.min(targetWidth, logicalCanvasSize?.width || targetWidth));
    const renderHeight = Math.max(
      1,
      Math.min(targetHeight, logicalCanvasSize?.height || targetHeight)
    );
    if (!offscreenCtx || !logicalCanvasSize) return;

    offscreenCtx.clearRect(0, 0, logicalCanvasSize.width, logicalCanvasSize.height);
    const x = logicalCanvasSize.width / 2 - renderWidth / 2;
    const y = logicalCanvasSize.height / 2 - renderHeight / 2;
    offscreenCtx.drawImage(img, x, y, renderWidth, renderHeight);
    renderOffscreenCanvasToViewport();
  };
  img.onerror = () => {
    console.warn("cached canvas image could not be restored");
  };
  img.src = imageData;
  return true;
}

function setSnapshotCache(imageData) {
  if (typeof imageData !== "string" || !imageData.length) return;
  try {
    localStorage.setItem("sketchy-canvas", imageData);
  } catch {
    // ignore
  }
}

function preserveCanvasResize() {
  // 1. 캔버스 해상도 및 매트릭스 리셋
  resizeCanvas();

  const cachedImage = localStorage.getItem("sketchy-canvas");
  if (cachedImage) {
    const targetSize = snapshotTargetSize || { width: canvasWidth, height: canvasHeight };
    if (
      drawCachedImage(cachedImage, {
        cssWidth: targetSize.width,
        cssHeight: targetSize.height,
      })
    ) {
      return;
    }
  }

  // 2. 저장되어 있던 모든 선 데이터(strokes) 복원 드로잉
  if (Array.isArray(strokes)) {
    for (const event of strokes) {
      if (event.type === "stroke") {
        const color = Array.isArray(event.c)
          ? `rgb(${event.c[0]}, ${event.c[1]}, ${event.c[2]})`
          : event.color || ctx.strokeStyle;
        const width = Number(event.w ?? event.width) || 1;
        const mode = event.m || "pencil";

        if (Array.isArray(event.points) && event.points.length > 0) {
          for (let i = 0; i < event.points.length - 1; i++) {
            drawLine({
              start: event.points[i],
              end: event.points[i + 1],
              color,
              width,
              mode,
              context: offscreenCtx || ctx,
              roughCanvas: offscreenRc || rc,
            });
          }
        }
      } else if (event.type === "clear") {
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);
        offscreenCtx?.clearRect(0, 0, canvasWidth, canvasHeight);
      } else if (event.type === "snapshot" && typeof event.imageData === "string") {
        const img = new Image();
        img.src = event.imageData;
        img.onload = () => {
          ctx.clearRect(0, 0, canvasWidth, canvasHeight);
          drawImagePreservingSize(ctx, img, {
            dpr,
            cssWidth: img.naturalWidth,
            cssHeight: img.naturalHeight,
          });
          if (offscreenCtx) {
            offscreenCtx.clearRect(0, 0, canvasWidth, canvasHeight);
            drawImagePreservingSize(offscreenCtx, img, {
              dpr,
              cssWidth: img.naturalWidth,
              cssHeight: img.naturalHeight,
            });
          }
        };
      }
    }
  }

  syncMainCanvasFromOffscreen();
}

snapshotTargetSize = readSnapshotTargetSize();
logicalCanvasSize = snapshotTargetSize || { width: window.innerWidth, height: window.innerHeight };

// 초기 실행 시 캔버스 바인딩
resizeCanvas();

// --- 리사이즈 디바운스 및 스피너 오버레이 처리 ---
let resizeTimeout = null;
let resizeSpinner = null;

function handleResizeWithDebounce() {
  const loadingOverlay = document.querySelector("#loading-overlay");
  const loadingText = loadingOverlay?.querySelector("p");

  // 크기 조절이 '시작'되는 시점에 최초 1회만 화면을 비우고 스피너 작동
  if (!resizeTimeout) {
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    if (loadingOverlay) {
      if (loadingText) loadingText.textContent = "Resizing canvas...";
      loadingOverlay.classList.remove("hidden");
      if (typeof drawSketchySpinner === "function" && !resizeSpinner) {
        resizeSpinner = drawSketchySpinner();
      }
    }
  }

  const viewport = resolveViewportSize(canvas, window.innerWidth, window.innerHeight);
  canvasWidth = viewport.width;
  canvasHeight = viewport.height;

  // 디바운스 타이머 갱신
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    logStatus("resizing complete");

    // 조절 완료 후 복원 드로잉 계산 수행
    preserveCanvasResize();
    remoteResizeInProgress = false;

    // 오버레이 제거 및 스피너 정지
    if (loadingOverlay) {
      loadingOverlay.classList.add("hidden");
    }
    if (resizeSpinner) {
      resizeSpinner.stop();
      resizeSpinner = null;
    }
    resizeTimeout = null;
  }, 250);
}

window.addEventListener("resize", handleResizeWithDebounce);

colorInput.addEventListener("input", (event) => {
  ctx.strokeStyle = event.target.value;
  logStatus(`color changed: ${event.target.value}`);
});

sizeRange.addEventListener("input", (event) => {
  let value = Number(event.target.value);

  const settings = MODE_SETTINGS[currentMode];
  if (settings) {
    value = Math.min(Math.max(value, settings.min), settings.max);
    event.target.value = value;
  }

  ctx.lineWidth = value;
  logStatus(`[${currentMode}] brush radius changed: ${value}`);

  updateCanvasCursor();
});

function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  const clientX = event.touches ? event.touches[0].clientX : event.clientX;
  const clientY = event.touches ? event.touches[0].clientY : event.clientY;
  const point = {
    x: Math.min(Math.max(clientX - rect.left, 0), canvasWidth),
    y: Math.min(Math.max(clientY - rect.top, 0), canvasHeight),
  };

  if (logicalCanvasSize && logicalCanvasSize.width && logicalCanvasSize.height) {
    const logicalWidth = logicalCanvasSize.width;
    const logicalHeight = logicalCanvasSize.height;
    const offsetX = (canvasWidth - logicalWidth) / 2;
    const offsetY = (canvasHeight - logicalHeight) / 2;
    return {
      x: point.x - offsetX - logicalWidth / 2,
      y: point.y - offsetY - logicalHeight / 2,
    };
  }

  return {
    x: point.x - canvasWidth / 2,
    y: point.y - canvasHeight / 2,
  };
}

document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
    e.target.classList.add("active");

    currentMode = e.target.dataset.mode;
    logStatus(`모드 변경: ${currentMode}`);
    const settings = MODE_SETTINGS[currentMode];
    if (settings) {
      sizeRange.min = settings.min;
      sizeRange.max = settings.max;
      sizeRange.value = settings.default;

      ctx.lineWidth = settings.default;
      logStatus(`브러시 두께 자동 조절: ${settings.default}`);
    }
    updateCanvasCursor();
  });
});

function updateCanvasCursor() {
  const modeEmojis = { pencil: "✏️", crayon: "🖍️", brush: "🖌️" };
  const emoji = modeEmojis[currentMode] || "✏️";
  const cursorSize = 24;

  const svgString = `<svg xmlns="http://www.w3.org/2000/svg" width="${cursorSize}" height="${cursorSize}" style="font-size:${cursorSize - 4}px"><text x="0" y="${cursorSize - 6}">${emoji}</text></svg>`;
  const cursorUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgString)))}`;

  canvas.style.cursor = `url(${cursorUrl}) 2 ${cursorSize - 3}, auto`;
}

function drawLine({
  start,
  end,
  color,
  width,
  mode = currentMode,
  context = ctx,
  roughCanvas = rc,
}) {
  const targetWidth = Number.isFinite(width) ? Math.max(1, width) : context.lineWidth;
  const logicalWidth = logicalCanvasSize?.width || canvasWidth;
  const logicalHeight = logicalCanvasSize?.height || canvasHeight;
  const isViewportContext = context === ctx;
  const viewportOffsetX = isViewportContext ? (canvasWidth - logicalWidth) / 2 : 0;
  const viewportOffsetY = isViewportContext ? (canvasHeight - logicalHeight) / 2 : 0;
  const logicalCenterX = logicalWidth / 2;
  const logicalCenterY = logicalHeight / 2;
  const resolvedStart = isViewportContext
    ? {
        x: viewportOffsetX + start.x + logicalCenterX,
        y: viewportOffsetY + start.y + logicalCenterY,
      }
    : {
        x: start.x + logicalCenterX,
        y: start.y + logicalCenterY,
      };
  const resolvedEnd = isViewportContext
    ? {
        x: viewportOffsetX + end.x + logicalCenterX,
        y: viewportOffsetY + end.y + logicalCenterY,
      }
    : {
        x: end.x + logicalCenterX,
        y: end.y + logicalCenterY,
      };
  const dx = resolvedEnd.x - resolvedStart.x;
  const dy = resolvedEnd.y - resolvedStart.y;
  const distance = Math.hypot(dx, dy);
  context.save();
  const targetColor = color || context.strokeStyle;
  const scaledWidth = Math.max(1, targetWidth);

  if (mode === "pencil") {
    context.globalAlpha = 0.15;
    const step = Math.max(1.5, scaledWidth * 0.4);
    for (let i = 0; i <= distance; i += step) {
      const t = distance === 0 ? 0 : i / distance;
      roughCanvas.circle(resolvedStart.x + dx * t, resolvedStart.y + dy * t, scaledWidth, {
        stroke: "none",
        fill: targetColor,
        fillStyle: "solid",
        roughness: 2.0,
      });
    }
  } else if (mode === "crayon") {
    context.globalAlpha = 0.4;
    const step = Math.max(1, scaledWidth * 0.15);
    for (let i = 0; i <= distance; i += step) {
      const t = distance === 0 ? 0 : i / distance;
      roughCanvas.circle(resolvedStart.x + dx * t, resolvedStart.y + dy * t, scaledWidth, {
        stroke: "none",
        fill: targetColor,
        fillStyle: "solid",
        roughness: 2.0,
      });
    }
  } else if (mode === "brush") {
    context.globalAlpha = 1;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = targetColor;
    context.lineWidth = scaledWidth;

    context.beginPath();
    context.moveTo(resolvedStart.x, resolvedStart.y);
    context.lineTo(resolvedEnd.x, resolvedEnd.y);
    context.stroke();
  }
  context.restore();
}

function handleRemoteDraw(payload) {
  if (!payload || typeof payload !== "object") return;
  if (payload.i === CLIENT_ID) return;

  if (typeof payload.v === "number") {
    if (payload.v < remoteSyncVersion) return;
    remoteSyncVersion = payload.v;
  }

  const color = `rgb(${payload.c[0]}, ${payload.c[1]}, ${payload.c[2]})`;
  const width = Number(payload.w) || 1;
  const mode = payload.m || "pencil";

  if (payload.start && payload.end) {
    drawLine({
      start: payload.start,
      end: payload.end,
      color,
      width,
      mode,
      context: ctx,
      roughCanvas: rc,
    });
    if (offscreenCtx && offscreenRc) {
      drawLine({
        start: payload.start,
        end: payload.end,
        color,
        width,
        mode,
        context: offscreenCtx,
        roughCanvas: offscreenRc,
      });
    }
  }
}

function compactStrokes() {
  if (!Array.isArray(strokes)) return;
  if (strokes.length <= MAX_STROKES) return;

  const off = document.createElement("canvas");
  off.width = canvasWidth;
  off.height = canvasHeight;
  const octx = off.getContext("2d");
  if (!octx) return;

  octx.clearRect(0, 0, off.width, off.height);

  const toMerge = strokes.slice(MERGE_FROM);
  for (const ev of toMerge) {
    if (ev.type === "stroke") {
      const color = Array.isArray(ev.c)
        ? `rgb(${ev.c[0]}, ${ev.c[1]}, ${ev.c[2]})`
        : ev.color || "#000";
      const width = Number(ev.w ?? ev.width) || 1;
      const mode = ev.m || "pencil";
      const orc = rough.canvas(off);

      if (Array.isArray(ev.points) && ev.points.length > 0) {
        for (let i = 0; i < ev.points.length - 1; i++) {
          const dx = ev.points[i + 1].x - ev.points[i].x;
          const dy = ev.points[i + 1].y - ev.points[i].y;
          const distance = Math.hypot(dx, dy);

          if (mode === "pencil" || mode === "crayon") {
            octx.globalAlpha = mode === "pencil" ? 0.2 : 0.6;
            const roughnessVal = mode === "pencil" ? 0.4 : 2.0;
            const step = Math.max(1, width * (mode === "pencil" ? 0.1 : 0.15));
            for (let j = 0; j <= distance; j += step) {
              const t = distance === 0 ? 0 : j / distance;
              orc.circle(ev.points[i].x + dx * t, ev.points[i].y + dy * t, width, {
                stroke: "none",
                fill: color,
                fillStyle: "solid",
                roughness: roughnessVal,
              });
            }
          } else {
            octx.globalAlpha = 1.0;
            orc.line(ev.points[i].x, ev.points[i].y, ev.points[i + 1].x, ev.points[i + 1].y, {
              stroke: color,
              strokeWidth: width,
              roughness: 1.0,
            });
          }
        }
      }
    } else if (ev.type === "clear") {
      octx.clearRect(0, 0, off.width, off.height);
    }
  }

  const imageData = off.toDataURL("image/webp", 0.8);
  strokes = strokes.slice(0, MERGE_FROM).concat([{ type: "snapshot", imageData }]);
  try {
    localStorage.setItem("sketchy-strokes", JSON.stringify(strokes));
  } catch {
    // ignore
  }
}

function disableDrawingMode() {
  replaying = true;
  drawing = false;
  lastPoint = null;
  canvas.style.pointerEvents = "none";
  colorInput.disabled = true;
  sizeRange.disabled = true;
  replayButton.disabled = true;
}

function enableDrawingMode() {
  replaying = false;
  canvas.style.pointerEvents = "auto";
  colorInput.disabled = false;
  sizeRange.disabled = false;
  replayButton.disabled = false;
}

function handlePointerDown(event) {
  if (replaying) return;
  event.preventDefault();
  drawing = true;
  lastPoint = getCanvasPoint(event);

  const rawColor = ctx.strokeStyle.replace("#", "");
  currentStroke = {
    type: "stroke",
    points: [lastPoint],
    c: [
      parseInt(rawColor.slice(0, 2), 16),
      parseInt(rawColor.slice(2, 4), 16),
      parseInt(rawColor.slice(4, 6), 16),
    ],
    w: Math.round(ctx.lineWidth),
    m: currentMode,
  };
}

function handlePointerMove(event) {
  if (replaying || !drawing || !lastPoint) return;
  event.preventDefault();
  const point = getCanvasPoint(event);
  const segment = {
    start: lastPoint,
    end: point,
    color: colorInput.value,
    width: Number(sizeRange.value),
    mode: currentMode,
  };
  drawLine({ ...segment, context: ctx, roughCanvas: rc });
  if (offscreenCtx && offscreenRc) {
    drawLine({ ...segment, context: offscreenCtx, roughCanvas: offscreenRc });
  }

  if (currentStroke) {
    currentStroke.points.push(point);
  }
  if (channel) {
    const rawColor = ctx.strokeStyle.replace("#", "");
    remoteSyncVersion += 1;
    channel.send({
      type: "broadcast",
      event: "draw_step",
      payload: {
        start: lastPoint,
        end: point,
        c: [
          parseInt(rawColor.slice(0, 2), 16),
          parseInt(rawColor.slice(2, 4), 16),
          parseInt(rawColor.slice(4, 6), 16),
        ],
        w: Math.round(ctx.lineWidth),
        m: currentMode,
        i: CLIENT_ID,
        v: remoteSyncVersion,
      },
    });
  }

  lastPoint = point;

  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveSketch, 150);
}

async function handlePointerUp(event) {
  if (replaying || !drawing) return;
  event.preventDefault();
  drawing = false;
  lastPoint = null;
  clearTimeout(saveTimeout);

  if (currentStroke && currentStroke.points.length > 0) {
    strokes.push(currentStroke);

    if (channel) {
      remoteSyncVersion += 1;
      channel.send({
        type: "broadcast",
        event: "draw",
        payload: {
          points: currentStroke.points,
          c: currentStroke.c,
          w: currentStroke.w,
          m: currentStroke.m,
          i: CLIENT_ID,
          v: remoteSyncVersion,
        },
      });
    }
  }

  currentStroke = null;
  await saveSketch();
}

function handlePalettePointerDown(event) {
  const tagName = event.target.nodeName;
  if (tagName === "INPUT" || tagName === "BUTTON" || event.target.closest("button")) return;
  palette.setPointerCapture(event.pointerId);
  const rect = palette.getBoundingClientRect();
  paletteDrag = {
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
  };
}

function handleButtonPointerDown(event) {
  event.preventDefault();
  replayButton.setPointerCapture(event.pointerId);
  const rect = replayButton.getBoundingClientRect();
  buttonDrag = {
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
    pointerId: event.pointerId,
  };
  buttonDragMoved = false;
}

function handlePalettePointerMove(event) {
  if (paletteDrag) {
    const x = event.clientX - paletteDrag.offsetX;
    const y = event.clientY - paletteDrag.offsetY;
    const targetX = clamp(x, 0, window.innerWidth - palette.offsetWidth);
    const targetY = clamp(y, 0, window.innerHeight - palette.offsetHeight);
    const resolved = resolveCollision(palette, replayButton, targetX, targetY);
    palette.style.left = `${resolved.x}px`;
    palette.style.top = `${resolved.y}px`;
  }
  if (buttonDrag && event.pointerId === buttonDrag.pointerId) {
    const dx = event.clientX - buttonDrag.startX;
    const dy = event.clientY - buttonDrag.startY;
    if (!buttonDrag.moved && Math.hypot(dx, dy) > 6) {
      buttonDrag.moved = true;
      buttonDragMoved = true;
    }
    const x = event.clientX - buttonDrag.offsetX;
    const y = event.clientY - buttonDrag.offsetY;
    const targetX = clamp(x, 0, window.innerWidth - replayButton.offsetWidth);
    const targetY = clamp(y, 0, window.innerHeight - replayButton.offsetHeight);
    const resolved = resolveCollision(replayButton, palette, targetX, targetY);
    replayButton.style.left = `${resolved.x}px`;
    replayButton.style.top = `${resolved.y}px`;
  }
}

function handlePalettePointerUp() {
  paletteDrag = null;
  buttonDrag = null;
}

async function replayDrawing() {
  if (replaying) return;
  if (!strokes.length) {
    logStatus("재생할 기록이 없습니다.");
    return;
  }

  disableDrawingMode();
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  logStatus("재생 시작...");

  const replayStartTime = performance.now();
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  let segmentsThisFrame = 0;
  let segmentsPerFrame = 1;

  const computeSegmentsPerFrame = () => {
    const elapsedTime = performance.now() - replayStartTime;
    const progress = Math.min(1, elapsedTime / 4000);
    const exponentialProgress = Math.pow(progress, 3);
    return 1 + Math.floor(exponentialProgress * 14);
  };

  for (const event of strokes) {
    if (!replaying) break;

    if (event.type === "clear") {
      ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      offscreenCtx?.clearRect(0, 0, canvasWidth, canvasHeight);
      continue;
    }

    if (event.type === "snapshot") {
      if (typeof event.imageData === "string") {
        const img = new Image();
        img.src = event.imageData;
        await new Promise((resolve) => {
          img.onload = () => {
            ctx.clearRect(0, 0, canvasWidth, canvasHeight);
            drawImagePreservingSize(ctx, img, {
              dpr,
              cssWidth: img.naturalWidth,
              cssHeight: img.naturalHeight,
            });
            resolve();
          };
          img.onerror = () => resolve();
        });
      }
      continue;
    }

    if (event.type !== "stroke") continue;

    const color = Array.isArray(event.c)
      ? `rgb(${event.c[0]}, ${event.c[1]}, ${event.c[2]})`
      : event.color || ctx.strokeStyle;
    const width = Number(event.w ?? event.width) || 1;
    const mode = event.m || "pencil";

    if (Array.isArray(event.points) && event.points.length > 0) {
      for (let i = 0; i < event.points.length - 1; i++) {
        drawLine({
          start: event.points[i],
          end: event.points[i + 1],
          color,
          width,
          mode,
          context: ctx,
          roughCanvas: rc,
        });
        if (offscreenCtx && offscreenRc) {
          drawLine({
            start: event.points[i],
            end: event.points[i + 1],
            color,
            width,
            mode,
            context: offscreenCtx,
            roughCanvas: offscreenRc,
          });
        }
        segmentsThisFrame += 1;
        if (segmentsThisFrame >= segmentsPerFrame) {
          segmentsThisFrame = 0;
          segmentsPerFrame = computeSegmentsPerFrame();
          await nextFrame();
        }
      }
    }
  }

  replaying = false;
  logStatus("replay complete");
  enableDrawingMode();
}

async function loadInitialSketch() {
  let data = null;
  let remoteLoaded = false;

  const cachedImage = localStorage.getItem("sketchy-canvas");
  if (cachedImage) {
    const targetSize = snapshotTargetSize || { width: canvasWidth, height: canvasHeight };
    drawCachedImage(cachedImage, { cssWidth: targetSize.width, cssHeight: targetSize.height });
  }

  try {
    data = await api.getSketch();
    remoteLoaded = true;
  } catch (error) {
    console.warn("R2 load fail, trying local cache", error);
  }

  const normalized = normalizeSketchPayload(data);
  const vector = normalized.vector;
  const localImage = localStorage.getItem("sketchy-canvas");
  const localStrokes = localStorage.getItem("sketchy-strokes");

  if (remoteLoaded) {
    if (normalized.shouldRenderSnapshotFirst && normalized.snapshot) {
      const targetSize = snapshotTargetSize || { width: canvasWidth, height: canvasHeight };
      drawCachedImage(normalized.snapshot, {
        cssWidth: targetSize.width,
        cssHeight: targetSize.height,
      });
      console.log("rendered snapshot from R2 first");
    }

    if (Array.isArray(vector) && vector.length) {
      strokes = vector.slice();
      localStorage.setItem("sketchy-strokes", JSON.stringify(strokes));
      ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      for (const event of strokes) {
        if (event.type === "stroke") {
          const color = Array.isArray(event.c)
            ? `rgb(${event.c[0]}, ${event.c[1]}, ${event.c[2]})`
            : event.color || ctx.strokeStyle;
          const width = Number(event.w ?? event.width) || 1;
          const mode = event.m || "pencil";

          if (Array.isArray(event.points) && event.points.length > 0) {
            for (let i = 0; i < event.points.length - 1; i++) {
              drawLine({
                start: event.points[i],
                end: event.points[i + 1],
                color,
                width,
                mode,
                context: offscreenCtx || ctx,
                roughCanvas: offscreenRc || rc,
              });
            }
          }
        } else if (event.type === "clear") {
          ctx.clearRect(0, 0, canvasWidth, canvasHeight);
          offscreenCtx?.clearRect(0, 0, canvasWidth, canvasHeight);
        } else if (event.type === "snapshot" && typeof event.imageData === "string") {
          const img = new Image();
          img.src = event.imageData;
          img.onload = () => {
            ctx.clearRect(0, 0, canvasWidth, canvasHeight);
            drawImagePreservingSize(ctx, img, {
              dpr,
              cssWidth: img.naturalWidth,
              cssHeight: img.naturalHeight,
            });
            if (offscreenCtx) {
              offscreenCtx.clearRect(0, 0, canvasWidth, canvasHeight);
              drawImagePreservingSize(offscreenCtx, img, {
                dpr,
                cssWidth: img.naturalWidth,
                cssHeight: img.naturalHeight,
              });
            }
          };
        }
      }
      syncMainCanvasFromOffscreen();
      console.log("load vector from R2");
      return;
    }

    if (localStrokes) {
      console.log("no vector in R2, using local cache");
      return;
    }

    strokes = [];
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    console.log("no vector at R2, resetting...");
    return;
  }

  if (localImage) {
    const targetSize = snapshotTargetSize || { width: canvasWidth, height: canvasHeight };
    drawCachedImage(localImage, { cssWidth: targetSize.width, cssHeight: targetSize.height });
    console.log("restored image at local");
  }

  if (localStrokes) {
    try {
      const parsed = JSON.parse(localStrokes);
      if (Array.isArray(parsed) && parsed.length) {
        strokes = parsed;
        console.log("restored strokes at local");
        if (!localImage) {
          ctx.clearRect(0, 0, canvasWidth, canvasHeight);
          for (const event of strokes) {
            if (event.type === "stroke") {
              const color = Array.isArray(event.c)
                ? `rgb(${event.c[0]}, ${event.c[1]}, ${event.c[2]})`
                : event.color || ctx.strokeStyle;
              const width = Number(event.w ?? event.width) || 1;
              const mode = event.m || "pencil";

              if (Array.isArray(event.points) && event.points.length > 0) {
                for (let i = 0; i < event.points.length - 1; i++) {
                  drawLine({
                    start: event.points[i],
                    end: event.points[i + 1],
                    color,
                    width,
                    mode,
                  });
                }
              }
            } else if (event.type === "clear") {
              ctx.clearRect(0, 0, canvasWidth, canvasHeight);
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }
}

async function saveSketch() {
  try {
    const targetWidth = snapshotTargetSize?.width || canvasWidth;
    const targetHeight = snapshotTargetSize?.height || canvasHeight;
    const snapshotCanvas = document.createElement("canvas");
    snapshotCanvas.width = Math.max(1, Math.round(targetWidth * dpr));
    snapshotCanvas.height = Math.max(1, Math.round(targetHeight * dpr));
    const snapshotCtx = snapshotCanvas.getContext("2d");

    if (snapshotCtx) {
      snapshotCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      snapshotCtx.clearRect(0, 0, targetWidth, targetHeight);
      const source = offscreenCanvas || canvas;
      if (source) {
        snapshotCtx.drawImage(source, 0, 0, targetWidth, targetHeight);
      }
    }

    const imageData = snapshotCanvas.toDataURL("image/webp", 0.8);
    persistSnapshotTargetSize(snapshotTargetSize);
    hasLocalBoardContent = true;
    setSnapshotCache(imageData);
    compactStrokes();
    localStorage.setItem("sketchy-strokes", JSON.stringify(strokes));
    const sanitized = strokes.map((ev) => {
      if (ev?.type === "snapshot") return { type: "snapshot" };
      return ev;
    });
    await api.saveSketch(imageData, sanitized);
    if (channel) {
      syncHostState();
    }
    console.log("R2 storing complete");
  } catch (error) {
    console.error("R2 vector storing:", error);
  }
}

function sendBeaconSave() {
  if (!navigator.sendBeacon) return;
  const payload = JSON.stringify({ vector: strokes });
  const blob = new Blob([payload], { type: "application/json;charset=UTF-8" });
  navigator.sendBeacon(`${API_BASE_URL}/api/sketch`, blob);
}

function syncHostState() {
  if (!channel) return;
  channel.send({
    type: "broadcast",
    event: "host_sync",
    payload: {
      i: CLIENT_ID,
      v: remoteSyncVersion,
      snapshot: offscreenCanvas?.toDataURL("image/webp", 0.8) || null,
    },
  });
}

async function initRealtime() {
  try {
    channel = supabase.channel("sketchy-board");

    channel.on("broadcast", { event: "draw" }, ({ payload }) => {
      if (!payload) return;
      if (payload.i === CLIENT_ID) return;

      handleRemoteDraw(payload);

      if (Array.isArray(payload.points)) {
        strokes.push({
          type: "stroke",
          points: payload.points,
          c: payload.c,
          w: payload.w,
          m: payload.m || "pencil",
        });
      }
    });

    channel.on("broadcast", { event: "draw_step" }, ({ payload }) => {
      handleRemoteDraw(payload);
    });

    channel.on("broadcast", { event: "host_sync" }, ({ payload }) => {
      if (!payload || payload.i === CLIENT_ID) return;
      if (typeof payload.v === "number" && payload.v >= remoteSyncVersion) {
        remoteSyncVersion = payload.v;
      }
      if (shouldApplyRemoteSnapshot(payload, remoteResizeInProgress || hasLocalBoardContent)) {
        const targetSize = snapshotTargetSize || { width: canvasWidth, height: canvasHeight };
        drawCachedImage(payload.snapshot, {
          cssWidth: targetSize.width,
          cssHeight: targetSize.height,
        });
      }
    });

    channel.on("broadcast", { event: "reset" }, () => {
      logStatus("리셋 이벤트 수신, 로컬 캐시를 지우고 새로고침합니다.");
      clearSketchLocalState();
      window.location.reload();
    });

    const { error } = await channel.subscribe();
    if (error) {
      console.error("Supabase realtime connection failed", error);
      return;
    }

    syncHostState();
    console.log("Supabase realtime connected");
  } catch (error) {
    console.error("Supabase reset error", error);
  }
}

function drawSketchySpinner() {
  const spinCanvas = document.querySelector("#loading-spinner-canvas");
  if (!spinCanvas) return null;
  const sctx = spinCanvas.getContext("2d");
  const src = rough.canvas(spinCanvas);

  let angle = 0;
  let animationId = null;

  function animate() {
    sctx.clearRect(0, 0, spinCanvas.width, spinCanvas.height);

    sctx.save();
    sctx.translate(spinCanvas.width / 2, spinCanvas.height / 2);
    sctx.rotate((angle * Math.PI) / 180);

    src.circle(0, 0, 20, {
      stroke: "#555",
      strokeWidth: 3,
      fillStyle: "solid",
      fill: "transparent",
      roughness: 2.0,
      bowing: 1.5,
    });

    sctx.restore();

    angle = (angle + 8) % 360;
    animationId = requestAnimationFrame(animate);
  }

  animate();

  return {
    stop: () => cancelAnimationFrame(animationId),
  };
}

async function initApp() {
  const loadingOverlay = document.querySelector("#loading-overlay");
  let spinnerInstance = null;

  try {
    spinnerInstance = drawSketchySpinner();
    await loadInitialSketch();
    await initRealtime();

    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointerleave", handlePointerUp);
    canvas.addEventListener("touchstart", handlePointerDown, { passive: false });
    canvas.addEventListener("touchmove", handlePointerMove, { passive: false });
    canvas.addEventListener("touchend", handlePointerUp);

    palette.addEventListener("pointerdown", handlePalettePointerDown);
    replayButton.addEventListener("pointerdown", handleButtonPointerDown);
    window.addEventListener("pointermove", handlePalettePointerMove);
    window.addEventListener("pointerup", handlePalettePointerUp);

    replayButton.addEventListener("click", (event) => {
      if (buttonDragMoved) {
        buttonDragMoved = false;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      replayDrawing();
    });

    window.addEventListener("beforeunload", sendBeaconSave);

    document.querySelector(`[data-mode="${currentMode}"]`)?.click();
  } catch (err) {
    console.error("error while resetting:", err);
  } finally {
    if (spinnerInstance) {
      spinnerInstance.stop();
    }
    if (loadingOverlay) {
      loadingOverlay.classList.add("hidden");
    }
  }
}

initApp();

window.resetSketchR2 = async (secret) => {
  clearSketchLocalState();

  try {
    const response = await api.resetSketch(secret);
    console.log("resetSketchR2 response:", response);
    logStatus("local cache removed. send reset event broadcast.");
    if (channel) {
      channel.send({ type: "broadcast", event: "reset", payload: { t: Date.now() } });
    }
    window.location.reload();
    return response;
  } catch (error) {
    console.error("resetSketchR2 failed:", error);
    if (channel) {
      channel.send({ type: "broadcast", event: "reset", payload: { t: Date.now() } });
    }
    window.location.reload();
    throw error;
  }
};
