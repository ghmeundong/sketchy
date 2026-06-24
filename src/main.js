import "./style.css";
import { api, API_BASE_URL } from "./services/api.js";
import { supabase } from "./services/supabase.js";

const root = document.querySelector("main");
if (!root) throw new Error("Main element not found.");

root.innerHTML = `
  <section class="app-shell">
    <h1>Sketchy Board</h1>
    <p>MongoDB에서 초기 그림을 불러오고, Supabase 실시간 채널로 모든 사용자의 낙서를 공유합니다.</p>
    <div class="toolbar">
        <div class="palette">
          <label>색상:</label>
          <div class="colors">
            <button class="color" data-color="#000">검정</button>
            <button class="color" data-color="#ff0000">빨강</button>
            <button class="color" data-color="#ff7f00">주황</button>
            <button class="color" data-color="#ffff00">노랑</button>
            <button class="color" data-color="#00ff00">초록</button>
            <button class="color" data-color="#0000ff">파랑</button>
            <button class="color" data-color="#8b00ff">보라</button>
          </div>
          <label>두께:</label>
          <input id="size-range" type="range" min="1" max="32" value="4" />
          <button id="eraser-button" type="button">지우개</button>
        </div>
        <button id="save-button" type="button">저장</button>
        <button id="clear-button" type="button">지우기</button>
        <div class="status"><span id="status-label">상태:</span> <strong id="status-text">연결 중...</strong></div>
    </div>
    <div class="canvas-wrap">
      <canvas id="sketch-canvas" width="960" height="600"></canvas>
    </div>
  </section>
`;

const canvas = document.querySelector("#sketch-canvas");
const saveButton = document.querySelector("#save-button");
const clearButton = document.querySelector("#clear-button");
const statusText = document.querySelector("#status-text");
const colorButtons = document.querySelectorAll(".color");
const sizeRange = document.querySelector("#size-range");
const eraserButton = document.querySelector("#eraser-button");

if (!canvas || !saveButton || !clearButton || !statusText) {
  throw new Error("UI 요소를 찾을 수 없습니다.");
}
``;

const ctx = canvas.getContext("2d");
const dpr = window.devicePixelRatio || 1;
const width = canvas.width;
const height = canvas.height;

canvas.width = width * dpr;
canvas.height = height * dpr;
canvas.style.width = `${width}px`;
canvas.style.height = `${height}px`;
ctx.scale(dpr, dpr);
ctx.lineCap = "round";
ctx.strokeStyle = "#111";
ctx.lineWidth = 4;
ctx.fillStyle = "#fff";
ctx.fillRect(0, 0, width, height);

let drawing = false;
let lastPoint = null;
let channel = null;
let strokes = [];
let tool = "brush"; // 'brush' or 'eraser'
let saveTimeout = null; // 자동 저장 타이머

function setStatus(message) {
  statusText.textContent = message;
}

// palette handlers
colorButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    tool = "brush";
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = btn.dataset.color || "#000";
    eraserButton.classList.remove("active");
  });
});

sizeRange.addEventListener("input", (e) => {
  const val = Number(e.target.value || 4);
  ctx.lineWidth = val;
});

eraserButton.addEventListener("click", () => {
  if (tool === "eraser") {
    tool = "brush";
    ctx.globalCompositeOperation = "source-over";
    eraserButton.classList.remove("active");
  } else {
    tool = "eraser";
    ctx.globalCompositeOperation = "destination-out";
    eraserButton.classList.add("active");
  }
});

function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  const clientX = event.touches ? event.touches[0].clientX : event.clientX;
  const clientY = event.touches ? event.touches[0].clientY : event.clientY;
  return {
    x: Math.min(Math.max(clientX - rect.left, 0), width),
    y: Math.min(Math.max(clientY - rect.top, 0), height),
  };
}

function drawLine({ start, end, color = "#111", width = 4 }) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
}

function broadcastStroke(start, end) {
  if (!channel) return;
  const segment = { start, end, color: ctx.strokeStyle, width: ctx.lineWidth, tool };
  channel.send({ type: "broadcast", event: "draw", payload: segment });
  strokes.push({ type: "stroke", ...segment });
}

function handlePointerDown(event) {
  event.preventDefault();
  drawing = true;
  lastPoint = getCanvasPoint(event);
}

function handlePointerMove(event) {
  if (!drawing || !lastPoint) return;
  event.preventDefault();
  const point = getCanvasPoint(event);
  const segment = { start: lastPoint, end: point, color: ctx.strokeStyle, width: ctx.lineWidth };
  drawLine(segment);
  broadcastStroke(segment.start, segment.end);
  lastPoint = point;
}

function handlePointerUp(event) {
  if (!drawing) return;
  event.preventDefault();
  drawing = false;
  lastPoint = null;
  
  // 줄 완료 후 자동 저장 (300ms 지연하여 연속 저장 방지)
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    autoSaveSketch();
  }, 300);
}

async function loadInitialSketch() {
  try {
    setStatus("초기 이미지 로딩 중…");
    const data = await api.getSketch();
    const { imageData, vector } = data || {};
    if (imageData) {
      const image = new Image();
      image.src = imageData;
      image.onload = () => {
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);
        setStatus("초기 그림 로딩 완료.");
      };
      image.onerror = () => {
        setStatus("초기 그림 로딩 실패, 빈 캔버스를 사용합니다.");
      };
    } else if (vector && Array.isArray(vector) && vector.length) {
      // draw vector strokes
      ctx.clearRect(0, 0, width, height);
      for (const ev of vector) {
        if (ev.type === "stroke") {
          drawLine(ev);
        } else if (ev.type === "clear") {
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, width, height);
        }
      }
      strokes = vector.slice();
      setStatus("초기 벡터 그림 로딩 완료.");
    } else {
      setStatus("초기 그림이 없습니다. 새로 시작하세요.");
    }
  } catch (error) {
    console.error(error);
    setStatus("초기 그림 불러오기 실패.");
  }
}

async function initRealtime() {
  try {
    channel = supabase.channel("sketchy-board");
    channel.on("broadcast", { event: "draw" }, ({ payload }) => {
      if (!payload || !payload.start || !payload.end) return;
      // apply remote stroke
      const remote = payload;
      if (remote.tool === "eraser") {
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        drawLine(remote);
        ctx.restore();
      } else {
        drawLine(remote);
      }
      strokes.push({ type: "stroke", ...remote });
    });
    channel.on("broadcast", { event: "clear" }, () => {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
      strokes.push({ type: "clear" });
    });

    const { error } = await channel.subscribe();
    if (error) {
      console.error("실시간 채널 구독 실패", error);
      setStatus("Supabase 연결 실패.");
      return;
    }

    setStatus("Supabase 실시간 연결됨.");
  } catch (error) {
    console.error(error);
    setStatus("실시간 연결 초기화 중 오류 발생.");
  }
}

async function autoSaveSketch() {
  try {
    const imageData = canvas.toDataURL("image/png");
    await api.saveSketch(imageData, strokes);
    setStatus("✓ 자동 저장 완료.");
  } catch (error) {
    console.error("자동 저장 오류:", error);
    setStatus("⚠ 자동 저장 실패 (재시도 중...)");
  }
}

async function saveSketch() {
  try {
    setStatus("저장 중…");
    const imageData = canvas.toDataURL("image/png");
    await api.saveSketch(imageData, strokes);
    setStatus("✓ R2에 저장되었습니다.");
  } catch (error) {
    console.error("수동 저장 오류:", error);
    setStatus("✗ 저장 실패. 콘솔 확인.");
  }
}

function sendBeaconSave() {
  if (!navigator.sendBeacon) return;
  try {
    const imageData = canvas.toDataURL("image/png");
    const payload = new Blob([JSON.stringify({ imageData })], {
      type: "application/json;charset=UTF-8",
    });
    const url = `${API_BASE_URL}/api/sketch`;
    navigator.sendBeacon(url, payload);
  } catch (error) {
    console.warn("sendBeacon 저장 실패", error);
  }
}

canvas.addEventListener("pointerdown", handlePointerDown);
canvas.addEventListener("pointermove", handlePointerMove);
canvas.addEventListener("pointerup", handlePointerUp);
canvas.addEventListener("pointerleave", handlePointerUp);
canvas.addEventListener("touchstart", handlePointerDown, { passive: false });
canvas.addEventListener("touchmove", handlePointerMove, { passive: false });
canvas.addEventListener("touchend", handlePointerUp);

saveButton.addEventListener("click", saveSketch);
clearButton.addEventListener("click", () => {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  if (channel) {
    channel.send({ type: "broadcast", event: "clear", payload: {} });
  }
  strokes.push({ type: "clear" });
});

window.addEventListener("beforeunload", () => {
  sendBeaconSave();
});

window.addEventListener("keydown", async (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "s") {
    event.preventDefault();
    await saveSketch();
  }
});

loadInitialSketch();
initRealtime();
