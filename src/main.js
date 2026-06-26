// localStorage.clear(); window.location.reload(); 로컬 테스트 시 초기

import "./style.css";
import { api, API_BASE_URL } from "./services/api.js";
import { supabase } from "./services/supabase.js";
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
          <button type="button" class="mode-btn active" data-mode="pencil" title="pencil" style="background: #555;"></button>
          <button type="button" class="mode-btn" data-mode="crayon" title="crayon" style="background: #d35400;"></button>
          <button type="button" class="mode-btn" data-mode="brush" title="brush" style="background: #2ecc71;"></button>
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
const dpr = window.devicePixelRatio || 1;

let currentMode = "pencil";
let canvasWidth = 0;
let canvasHeight = 0;
let drawing = false;
let lastPoint = null;
let paletteDrag = null;
let buttonDrag = null;
let buttonDragMoved = false;
let strokes = [];
let currentStroke = null;
let channel = null;
let saveTimeout = null;
let replaying = false;
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

function resizeCanvas() {
  canvasWidth = window.innerWidth;
  canvasHeight = window.innerHeight;
  canvas.width = canvasWidth * dpr;
  canvas.height = canvasHeight * dpr;
  canvas.style.width = `${canvasWidth}px`;
  canvas.style.height = `${canvasHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  
  // 페이퍼 텍스처(배경)가 보이도록 캔버스를 지우는 방식으로 변경 (필요시 #fff로 채우셔도 무방합니다)
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
}

function preserveCanvasResize() {
  const snapshot = canvas.toDataURL();
  resizeCanvas();
  const image = new Image();
  image.src = snapshot;
  image.onload = () => ctx.drawImage(image, 0, 0, canvasWidth, canvasHeight);
}

resizeCanvas();
window.addEventListener("resize", preserveCanvasResize);

colorInput.addEventListener("input", (event) => {
  ctx.strokeStyle = event.target.value;
  logStatus(`색상 변경: ${event.target.value}`);
});

sizeRange.addEventListener("input", (event) => {
  let value = Number(event.target.value);

  const settings = MODE_SETTINGS[currentMode];
  if (settings) {
    value = Math.min(Math.max(value, settings.min), settings.max);
    event.target.value = value;
  }

  ctx.lineWidth = value;
  logStatus(`[${currentMode}] 브러시 두께 변경: ${value}`);
});

function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  const clientX = event.touches ? event.touches[0].clientX : event.clientX;
  const clientY = event.touches ? event.touches[0].clientY : event.clientY;
  return {
    x: Math.min(Math.max(clientX - rect.left, 0), canvasWidth),
    y: Math.min(Math.max(clientY - rect.top, 0), canvasHeight),
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
  });
});

function drawLine({ start, end, color, width, mode = currentMode }) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  ctx.save();
  const targetColor = color || ctx.strokeStyle;
  const targetWidth = width || ctx.lineWidth;

  if (mode === "pencil") {
    ctx.globalAlpha = 0.15;
    const step = Math.max(1.5, targetWidth * 0.4);
    for (let i = 0; i <= distance; i += step) {
      const t = distance === 0 ? 0 : i / distance;
      rc.circle(start.x + dx * t, start.y + dy * t, targetWidth, {
        stroke: "none",
        fill: targetColor,
        fillStyle: "solid",
        roughness: 2.0,
      });
    }
  } else if (mode === "crayon") {
    ctx.globalAlpha = 0.4;
    const step = Math.max(1, targetWidth * 0.15);
    for (let i = 0; i <= distance; i += step) {
      const t = distance === 0 ? 0 : i / distance;
      rc.circle(start.x + dx * t, start.y + dy * t, targetWidth, {
        stroke: "none",
        fill: targetColor,
        fillStyle: "solid",
        roughness: 2.0,
      });
    }
  } else if (mode === "brush") {
    ctx.globalAlpha = 1;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = targetColor;
    ctx.lineWidth = targetWidth;

    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }
  ctx.restore();
}

function handleRemoteDraw(payload) {
  if (!payload || typeof payload !== "object") return;
  if (payload.i === CLIENT_ID) return;

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
    });
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
  drawLine(segment);

  if (currentStroke) {
    currentStroke.points.push(point);
  }
  if (channel) {
    const rawColor = ctx.strokeStyle.replace("#", "");
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
      channel.send({
        type: "broadcast",
        event: "draw",
        payload: {
          points: currentStroke.points,
          c: currentStroke.c,
          w: currentStroke.w,
          m: currentStroke.m,
          i: CLIENT_ID,
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
      continue;
    }

    if (event.type === "snapshot") {
      if (typeof event.imageData === "string") {
        const img = new Image();
        img.src = event.imageData;
        await new Promise((resolve) => {
          img.onload = () => {
            ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);
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
        drawLine({ start: event.points[i], end: event.points[i + 1], color, width, mode });
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
  logStatus("재생 완료");
  enableDrawingMode();
}

async function loadInitialSketch() {
  let data = null;
  let remoteLoaded = false;

  try {
    data = await api.getSketch();
    remoteLoaded = true;
  } catch (error) {
    console.warn("R2 로드 실패, 로컬 캐시를 시도합니다.", error);
  }

  const vector = Array.isArray(data?.vector) ? data.vector : null;
  const localImage = localStorage.getItem("sketchy-canvas");
  const localStrokes = localStorage.getItem("sketchy-strokes");

  if (remoteLoaded) {
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
              drawLine({ start: event.points[i], end: event.points[i + 1], color, width, mode });
            }
          }
        } else if (event.type === "clear") {
          ctx.clearRect(0, 0, canvasWidth, canvasHeight);
        } else if (event.type === "snapshot" && typeof event.imageData === "string") {
          const img = new Image();
          img.src = event.imageData;
          img.onload = () => ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);
        }
      }
      console.log("R2에서 벡터 그림 로드 완료");
      return;
    }

    if (localStrokes) {
      console.log("R2에 그림 없음 — 로컬 캐시 유지");
      return;
    }

    strokes = [];
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    console.log("R2에 저장된 그림이 없습니다. 캔버스를 초기화했습니다.");
    return;
  }

  if (localImage) {
    const image = new Image();
    image.src = localImage;
    image.onload = () => {
      ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      ctx.drawImage(image, 0, 0, canvasWidth, canvasHeight);
      console.log("로컬 저장소에서 이미지 복원 완료");
    };
  }

  if (localStrokes) {
    try {
      const parsed = JSON.parse(localStrokes);
      if (Array.isArray(parsed) && parsed.length) {
        strokes = parsed;
        console.log("로컬 저장소에서 벡터 복원 완료");
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
    const imageData = canvas.toDataURL("image/webp", 0.8);
    localStorage.setItem("sketchy-canvas", imageData);
    compactStrokes();
    localStorage.setItem("sketchy-strokes", JSON.stringify(strokes));
    const sanitized = strokes.map((ev) => {
      if (ev?.type === "snapshot") return { type: "snapshot" };
      return ev;
    });
    await api.saveSketch(null, sanitized);
    console.log("R2 벡터 저장 완료");
  } catch (error) {
    console.error("R2 벡터 저장 실패:", error);
  }
}

function sendBeaconSave() {
  if (!navigator.sendBeacon) return;
  const payload = JSON.stringify({ vector: strokes });
  const blob = new Blob([payload], { type: "application/json;charset=UTF-8" });
  navigator.sendBeacon(`${API_BASE_URL}/api/sketch`, blob);
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

    channel.on("broadcast", { event: "reset" }, () => {
      logStatus("리셋 이벤트 수신, 로컬 캐시를 지우고 새로고침합니다.");
      try {
        localStorage.removeItem("sketchy-canvas");
        localStorage.removeItem("sketchy-strokes");
      } catch {
        // ignore
      }
      window.location.reload();
    });

    const { error } = await channel.subscribe();
    if (error) {
      console.error("Supabase 리얼타임 연결 실패", error);
      return;
    }

    console.log("Supabase 리얼타임 연결됨");
  } catch (error) {
    console.error("Supabase 초기화 오류", error);
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

// 2. 앱 초기화 및 구동 함수
async function initApp() {
  const loadingOverlay = document.querySelector("#loading-overlay");
  let spinnerInstance = null;

  try {
    spinnerInstance = drawSketchySpinner();
    await loadInitialSketch();
    await initRealtime();
    
    // 이벤트 리스너를 initApp 내부/완료 시점에 바인딩하여 캔버스 조작 시점과 충돌 방지
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

    // 초기 모드 활성화 클릭 트리거
    document.querySelector(`[data-mode="${currentMode}"]`)?.click();
  } catch (err) {
    console.error("초기화 중 오류 발생:", err);
  } finally {
    if (spinnerInstance) {
      spinnerInstance.stop();
    }
    if (loadingOverlay) {
      loadingOverlay.classList.add("hidden");
    }
  }
}

// 최종 앱 구동 실행
initApp();

window.resetSketchR2 = async (secret) => {
  try {
    const response = await api.resetSketch(secret);
    console.log("resetSketchR2 response:", response);
    if (response?.ok) {
      localStorage.removeItem("sketchy-canvas");
      localStorage.removeItem("sketchy-strokes");
      logStatus("로컬 캐시가 지워졌습니다. 리셋 이벤트 브로드캐스트를 보냅니다.");
      if (channel) {
        channel.send({ type: "broadcast", event: "reset", payload: { t: Date.now() } });
      }
      window.location.reload();
    }
    return response;
  } catch (error) {
    console.error("resetSketchR2 failed:", error);
    throw error;
  }
};