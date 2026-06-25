import "./style.css";
import { api, API_BASE_URL } from "./services/api.js";
import { supabase } from "./services/supabase.js";

const root = document.querySelector("main");
if (!root) throw new Error("Main element not found.");

root.innerHTML = `
  <div class="canvas-shell">
    <canvas id="sketch-canvas"></canvas>
    <div class="palette" id="palette">
      <div class="palette-row">
        <label for="color-input"></label>
        <input id="color-input" type="color" value="#111111" />
      </div>
      <div class="palette-row">
        <label for="size-range"></label>
        <input id="size-range" type="range" min="1" max="32" value="4" />
      </div>
      <div class="palette-row">
        <button id="replay-button" type="button">재생 ▶</button>
      </div>
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
const dpr = window.devicePixelRatio || 1;
let canvasWidth = 0;
let canvasHeight = 0;
let drawing = false;
let lastPoint = null;
let paletteDrag = null;
let strokes = [];
let channel = null;
let saveTimeout = null;
let replaying = false;
let lastImageData = null;
const CLIENT_ID = Math.floor(Math.random() * 0xffffffff);

function logStatus(message) {
  console.log(message);
}

function broadcastStroke(start, end) {
  const rawColor = ctx.strokeStyle.replace("#", "");
  const payload = {
    i: CLIENT_ID,
    w: Math.round(ctx.lineWidth),
    c: [
      parseInt(rawColor.slice(0, 2), 16),
      parseInt(rawColor.slice(2, 4), 16),
      parseInt(rawColor.slice(4, 6), 16),
    ],
    p: [start.x, start.y, end.x, end.y],
  };
  strokes.push({ type: "stroke", start, end, c: payload.c, w: payload.w });
  if (!channel) return;
  channel.send({
    type: "broadcast",
    event: "draw",
    payload,
  });
}

function handleRemoteDraw(payload) {
  if (!payload || typeof payload !== "object") return;
  if (payload.i === CLIENT_ID) return;
  if (!Array.isArray(payload.c) || !Array.isArray(payload.p)) return;

  const segment = {
    start: { x: payload.p[0], y: payload.p[1] },
    end: { x: payload.p[2], y: payload.p[3] },
    color: `rgb(${payload.c[0]}, ${payload.c[1]}, ${payload.c[2]})`,
    width: Number(payload.w) || 1,
  };

  drawLine(segment);
  strokes.push({
    type: "stroke",
    start: segment.start,
    end: segment.end,
    c: payload.c,
    w: payload.w,
  });
}

function resizeCanvas() {
  canvasWidth = window.innerWidth;
  canvasHeight = window.innerHeight;
  canvas.width = canvasWidth * dpr;
  canvas.height = canvasHeight * dpr;
  canvas.style.width = `${canvasWidth}px`;
  canvas.style.height = `${canvasHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = colorInput.value;
  ctx.lineWidth = Number(sizeRange.value);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
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
  ctx.lineWidth = Number(event.target.value);
  logStatus(`브러시 두께: ${event.target.value}`);
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

function drawLine({ start, end, color = ctx.strokeStyle, width = ctx.lineWidth }) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
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
}

function handlePointerMove(event) {
  if (replaying || !drawing || !lastPoint) return;
  event.preventDefault();
  const point = getCanvasPoint(event);
  const segment = { start: lastPoint, end: point, color: ctx.strokeStyle, width: ctx.lineWidth };
  drawLine(segment);
  broadcastStroke(segment.start, segment.end);
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

function handlePalettePointerMove(event) {
  if (!paletteDrag) return;
  const x = event.clientX - paletteDrag.offsetX;
  const y = event.clientY - paletteDrag.offsetY;
  palette.style.left = `${Math.min(Math.max(0, x), window.innerWidth - palette.offsetWidth)}px`;
  palette.style.top = `${Math.min(Math.max(0, y), window.innerHeight - palette.offsetHeight)}px`;
}

function handlePalettePointerUp() {
  paletteDrag = null;
}

function restoreLatestWebP() {
  const imageData = localStorage.getItem("sketchy-canvas") || lastImageData;
  if (!imageData || typeof imageData !== "string" || !imageData.startsWith("data:image")) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const image = new Image();
    image.src = imageData;
    image.onload = () => {
      ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      ctx.drawImage(image, 0, 0, canvasWidth, canvasHeight);
      logStatus("WebP 이미지 복원 완료");
      resolve();
    };
    image.onerror = () => {
      logStatus("WebP 이미지 복원 실패");
      resolve();
    };
  });
}

async function replayDrawing() {
  console.log("replay clicked", { replaying, strokesLength: strokes.length });
  if (replaying) return;
  if (!strokes.length) {
    logStatus("재생할 기록이 없습니다.");
    return;
  }

  disableDrawingMode();
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  logStatus("재생 시작...");

  for (const event of strokes) {
    if (!replaying) break;

    if (event.type === "clear") {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);
      continue;
    }

    if (event.type !== "stroke") continue;

    const color = Array.isArray(event.c)
      ? `rgb(${event.c[0]}, ${event.c[1]}, ${event.c[2]})`
      : event.color || ctx.strokeStyle;
    const width = Number(event.w ?? event.width) || 1;

    drawLine({ start: event.start, end: event.end, color, width });
    await new Promise((resolve) => setTimeout(resolve, 12));
  }

  replaying = false;
  logStatus("재생 완료");
  await restoreLatestWebP();
  enableDrawingMode();
}

async function loadInitialSketch() {
  let data = null;
  try {
    data = await api.getSketch();
  } catch (error) {
    console.warn("R2 로드 실패, 로컬 캐시를 시도합니다.", error);
  }

  const imageData = typeof data?.imageData === "string" ? data.imageData : null;
  const vector = Array.isArray(data?.vector) ? data.vector : null;

  if (typeof imageData === "string" && imageData.startsWith("data:image")) {
    lastImageData = imageData;
  }

  if (Array.isArray(vector) && vector.length) {
    strokes = vector.slice();
  }

  if (typeof imageData === "string" && imageData.startsWith("data:image")) {
    const image = new Image();
    image.src = imageData;
    image.onload = () => {
      ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      ctx.drawImage(image, 0, 0, canvasWidth, canvasHeight);
      console.log("R2에서 WebP 이미지 로드 완료");
    };
    image.onerror = () => {
      console.warn("R2 WebP 이미지 로드 실패");
    };
    return;
  }

  if (Array.isArray(vector) && vector.length) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    for (const event of vector) {
      if (event.type === "stroke") {
        const color = Array.isArray(event.c)
          ? `rgb(${event.c[0]}, ${event.c[1]}, ${event.c[2]})`
          : event.color || ctx.strokeStyle;
        const width = Number(event.w ?? event.width) || 1;
        drawLine({ start: event.start, end: event.end, color, width });
      } else if (event.type === "clear") {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
      }
    }
    console.log("R2에서 벡터 그림 로드 완료");
    return;
  }

  const localImage = localStorage.getItem("sketchy-canvas");
  const localStrokes = localStorage.getItem("sketchy-strokes");
  if (localImage) {
    lastImageData = localImage;
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
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, canvasWidth, canvasHeight);
          for (const event of strokes) {
            if (event.type === "stroke") {
              const color = Array.isArray(event.c)
                ? `rgb(${event.c[0]}, ${event.c[1]}, ${event.c[2]})`
                : event.color || ctx.strokeStyle;
              const width = Number(event.w ?? event.width) || 1;
              drawLine({ start: event.start, end: event.end, color, width });
            } else if (event.type === "clear") {
              ctx.fillStyle = "#fff";
              ctx.fillRect(0, 0, canvasWidth, canvasHeight);
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  if (!localImage && !localStrokes) {
    console.log("저장된 그림이 없습니다.");
  }
}

async function saveSketch() {
  try {
    const imageData = canvas.toDataURL("image/webp", 0.8);
    localStorage.setItem("sketchy-canvas", imageData);
    localStorage.setItem("sketchy-strokes", JSON.stringify(strokes));
    await api.saveSketch(imageData, strokes);
    console.log("R2 WebP 저장 완료");
  } catch (error) {
    console.error("R2 WebP 저장 실패:", error);
  }
}

function sendBeaconSave() {
  if (!navigator.sendBeacon) return;
  const imageData = canvas.toDataURL("image/webp", 0.8);
  const payload = JSON.stringify({ imageData, vector: strokes });
  const blob = new Blob([payload], { type: "application/json;charset=UTF-8" });
  navigator.sendBeacon(`${API_BASE_URL}/api/sketch`, blob);
}

async function initRealtime() {
  try {
    channel = supabase.channel("sketchy-board");
    channel.on("broadcast", { event: "draw" }, ({ payload }) => {
      if (!payload) return;
      handleRemoteDraw(payload);
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

await loadInitialSketch();
initRealtime();

canvas.addEventListener("pointerdown", handlePointerDown);
canvas.addEventListener("pointermove", handlePointerMove);
canvas.addEventListener("pointerup", handlePointerUp);
canvas.addEventListener("pointerleave", handlePointerUp);
canvas.addEventListener("touchstart", handlePointerDown, { passive: false });
canvas.addEventListener("touchmove", handlePointerMove, { passive: false });
canvas.addEventListener("touchend", handlePointerUp);

palette.addEventListener("pointerdown", handlePalettePointerDown);
window.addEventListener("pointermove", handlePalettePointerMove);
window.addEventListener("pointerup", handlePalettePointerUp);
replayButton.addEventListener("click", replayDrawing);
window.addEventListener("beforeunload", sendBeaconSave);

window.resetSketchR2 = async (secret) => {
  try {
    const response = await api.resetSketch(secret);
    console.log("resetSketchR2 response:", response);
    if (response?.ok) {
      localStorage.removeItem("sketchy-canvas");
      localStorage.removeItem("sketchy-strokes");
      console.log("Local sketch cache cleared.");
    }
    return response;
  } catch (error) {
    console.error("resetSketchR2 failed:", error);
    throw error;
  }
};
