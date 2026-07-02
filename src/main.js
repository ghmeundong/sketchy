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
  // 💡 윈도우 창, 스냅샷 사이즈, 논리 사이즈 중 무조건 '가장 큰 값'을 도화지 크기로 잡습니다.
  const targetWidth = Math.max(
    canvasWidth,
    snapshotTargetSize?.width || 0,
    logicalCanvasSize?.width || 0,
    window.innerWidth
  );
  const targetHeight = Math.max(
    canvasHeight,
    snapshotTargetSize?.height || 0,
    logicalCanvasSize?.height || 0,
    window.innerHeight
  );

  const backingWidth = Math.max(1, Math.round(targetWidth * dpr));
  const backingHeight = Math.max(1, Math.round(targetHeight * dpr));

  // 💡 기존 캔버스가 없거나 크기가 바뀐 경우에만 정확히 새로 생성합니다.
  if (
    !offscreenCanvas ||
    offscreenCanvas.width !== backingWidth ||
    offscreenCanvas.height !== backingHeight
  ) {
    offscreenCanvas = document.createElement("canvas");
    offscreenCanvas.width = backingWidth;
    offscreenCanvas.height = backingHeight;
    offscreenCtx = offscreenCanvas.getContext("2d");
    offscreenRc = rough.canvas(offscreenCanvas);
  }

  if (offscreenCanvas && offscreenCtx) {
    // 💡 에러를 내던 targetSize.width 대신 확실히 검증된 targetWidth와 targetHeight를 주입합니다.
    applyCanvasSize(offscreenCanvas, targetWidth, targetHeight, dpr);
    offscreenCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 💡 화면이 커질 때 새로 연장된 공간이 검은색(빈 버퍼)이 되지 않도록 확실하게 흰색으로 덮어줍니다.
    offscreenCtx.fillStyle = "#ffffff";
    offscreenCtx.fillRect(0, 0, targetWidth, targetHeight);
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

  // 💡 물리창 크기가 더 커졌다면 논리 크기도 그것에 맞춰 확장 유도
  logicalCanvasSize = {
    width: Math.max(canvasWidth, snapshotTargetSize?.width || 0),
    height: Math.max(canvasHeight, snapshotTargetSize?.height || 0),
  };

  persistSnapshotTargetSize(snapshotTargetSize);
  remoteResizeInProgress = true;

  const metrics = applyCanvasSize(canvas, canvasWidth, canvasHeight, dpr);
  ctx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  ensureOffscreenCanvas();
  renderOffscreenCanvasToViewport();
}

function syncMainCanvasFromOffscreen() {
  renderOffscreenCanvasToViewport();
}

function drawCachedImage(imageData, options = {}) {
  if (!imageData) return false;

  const img = new Image();
  img.onload = () => {
    if (!offscreenCtx || !offscreenCanvas) return;

    // 1. 현재 오프스크린 캔버스의 전체 논리적 크기
    const currentOffscreenLogicalWidth = offscreenCanvas.width / dpr;
    const currentOffscreenLogicalHeight = offscreenCanvas.height / dpr;

    // 전체 공간을 깨끗하게 흰색 바탕으로 초기화
    offscreenCtx.fillStyle = "#ffffff";
    offscreenCtx.fillRect(0, 0, currentOffscreenLogicalWidth, currentOffscreenLogicalHeight);

    // 2. 💡 [핵심] 개발자도구 크기에 영향받지 않도록, 저장된 원래 타겟 사이즈 고정 사용
    // options.cssWidth가 있으면 그것을 쓰고, 없으면 원래 이미지 크기를 기준으로 잡음
    const renderWidth = Number.isFinite(options.cssWidth)
      ? options.cssWidth
      : snapshotTargetSize?.width || img.naturalWidth / dpr;
    const renderHeight = Number.isFinite(options.cssHeight)
      ? options.cssHeight
      : snapshotTargetSize?.height || img.naturalHeight / dpr;

    // 3. 늘어난 대형 도화지의 정확한 정중앙 좌표 계산 (비율 왜곡 방지)
    const x = (currentOffscreenLogicalWidth - renderWidth) / 2;
    const y = (currentOffscreenLogicalHeight - renderHeight) / 2;

    // 깨짐 방지를 위해 부드러운 이미지 렌더링 옵션 활성화
    offscreenCtx.imageSmoothingEnabled = true;
    offscreenCtx.imageSmoothingQuality = "high";

    offscreenCtx.drawImage(img, x, y, renderWidth, renderHeight);

    // 메인 캔버스로 전송
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
  // 1. 메인 캔버스 해상도 및 매트릭스 리셋
  const metrics = applyCanvasSize(canvas, canvasWidth, canvasHeight, dpr);
  ctx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // 2. 오프스크린(분신) 캔버스도 새 크기에 맞게 리셋
  ensureOffscreenCanvas();

  // 3. 💡 [핵심] 무거운 선 루프 대신, 저장된 최신 이미지 스냅샷 '딱 한 장'만 복원
  const cachedImage = localStorage.getItem("sketchy-canvas");
  if (cachedImage) {
    const targetSize = snapshotTargetSize || { width: canvasWidth, height: canvasHeight };

    // 이미지가 로드되면 자동으로 offscreenCtx에 그려지고, 메인 캔버스로 동기화됩니다.
    drawCachedImage(cachedImage, {
      cssWidth: targetSize.width,
      cssHeight: targetSize.height,
    });

    logStatus("스냅샷 이미지를 활용해 화면을 즉시 복원했습니다.");
    return; // 💡 복원 성공 시 아래의 무거운 백업 루프를 타지 않고 즉시 종료!
  }

  // 4. 만약 스냅샷이 없는 극단적인 상황(첫 진입 등)에만 예외적으로 선 데이터 복원
  if (Array.isArray(strokes) && strokes.length > 0) {
    for (const event of strokes) {
      if (event.type === "stroke" && Array.isArray(event.points)) {
        const color = Array.isArray(event.c)
          ? `rgb(${event.c[0]}, ${event.c[1]}, ${event.c[2]})`
          : event.color || "#111111";
        const width = Number(event.w ?? event.width) || 1;
        const mode = event.m || "pencil";

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
    }
    syncMainCanvasFromOffscreen();
  }
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

  if (!resizeTimeout) {
    if (loadingOverlay) {
      if (loadingText) loadingText.textContent = "Resizing canvas...";
      loadingOverlay.classList.remove("hidden");
      if (typeof drawSketchySpinner === "function" && !resizeSpinner) {
        resizeSpinner = drawSketchySpinner();
      }
    }
  }

  // 💡 리사이즈 도중에도 실시간으로 윈도우의 viewport 크기를 그대로 주입합니다.
  dpr = window.devicePixelRatio || 1;
  canvasWidth = window.innerWidth;
  canvasHeight = window.innerHeight;

  const nextTargetSize = resolveSnapshotTargetSize(canvasWidth, canvasHeight, snapshotTargetSize);
  snapshotTargetSize = nextTargetSize;

  logicalCanvasSize = {
    width: Math.max(canvasWidth, snapshotTargetSize?.width || 0),
    height: Math.max(canvasHeight, snapshotTargetSize?.height || 0),
  };

  persistSnapshotTargetSize(snapshotTargetSize);
  remoteResizeInProgress = true;

  // 디바운스 도중에도 잘리지 않도록 해상도 업데이트
  const metrics = applyCanvasSize(canvas, canvasWidth, canvasHeight, dpr);
  ctx.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  if (offscreenCanvas) {
    renderOffscreenCanvasToViewport();
  }

  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    logStatus("resizing complete");

    // 💡 디바운스가 끝나는 순간 늘어난 해상도를 픽스하고 그림을 복원합니다.
    preserveCanvasResize();
    remoteResizeInProgress = false;

    if (loadingOverlay) {
      loadingOverlay.classList.add("hidden");
    }
    if (resizeSpinner) {
      resizeSpinner.stop();
      resizeSpinner = null;
    }
    resizeTimeout = null;
  }, 150);
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
    // 💡 현재 확장된 캔버스 영역과 오프스크린 영역 중 최대 크기를 타겟 해상도로 잡습니다.
    const targetWidth = Math.max(canvasWidth, offscreenCanvas ? offscreenCanvas.width / dpr : 0);
    const targetHeight = Math.max(canvasHeight, offscreenCanvas ? offscreenCanvas.height / dpr : 0);

    const snapshotCanvas = document.createElement("canvas");
    snapshotCanvas.width = Math.max(1, Math.round(targetWidth * dpr));
    snapshotCanvas.height = Math.max(1, Math.round(targetHeight * dpr));
    const snapshotCtx = snapshotCanvas.getContext("2d");

    if (snapshotCtx) {
      snapshotCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      snapshotCtx.fillStyle = "#ffffff";
      snapshotCtx.fillRect(0, 0, targetWidth, targetHeight);

      const source = offscreenCanvas || canvas;
      if (source) {
        // 중앙 정렬을 맞추어 안전하게 복사본을 렌더링 후 캡처
        const srcLogicalWidth = source.width / dpr;
        const srcLogicalHeight = source.height / dpr;
        const dx = (targetWidth - srcLogicalWidth) / 2;
        const dy = (targetHeight - srcLogicalHeight) / 2;
        snapshotCtx.drawImage(source, dx, dy, srcLogicalWidth, srcLogicalHeight);
      }
    }

    const imageData = snapshotCanvas.toDataURL("image/webp", 0.8);

    // 현재 커진 크기를 새로운 기준 스냅샷 사이즈로 인정해 줌
    snapshotTargetSize = { width: targetWidth, height: targetHeight };
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
  // 💡 리셋되었거나 보드에 선 데이터가 아예 없으면 백엔드(R2)에 쓸데없이 빈 데이터를 덮어쓰지 않도록 차단합니다.
  if (!strokes || strokes.length === 0) return;
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
  // 1. 메모리 데이터 즉시 초기화 (비콘 오작동 방지)
  strokes = [];
  currentStroke = null;
  clearSketchLocalState();

  try {
    // 2. 원격 서버(R2) 데이터 삭제 API 완료될 때까지 확실하게 대기(await)
    const response = await api.resetSketch(secret);
    console.log("resetSketchR2 response:", response);
    logStatus("원격 서버 및 로컬 캐시가 성공적으로 지워졌습니다. 리셋 이벤트를 전송합니다.");

    // 3. 다른 클라이언트들에게 리셋 브로드캐스트 전송
    if (channel) {
      await channel.send({ type: "broadcast", event: "reset", payload: { t: Date.now() } });
    }

    // 4. 네트워크 패킷 전송을 위해 약간의 여유를 두고 새로고침
    setTimeout(() => {
      window.location.reload();
    }, 300);

    return response;
  } catch (error) {
    console.error("resetSketchR2 failed:", error);

    // 에러가 나더라도 강제 리셋 전송 후 새로고침 보장
    if (channel) {
      channel.send({ type: "broadcast", event: "reset", payload: { t: Date.now() } });
    }
    setTimeout(() => {
      window.location.reload();
    }, 500);
    throw error;
  }
};
