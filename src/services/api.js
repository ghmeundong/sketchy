const DEFAULT_LOCAL = "http://localhost:8787";
const DEPLOY_BACKEND_URL = "https://sketchy-backend.ghmeundong.workers.dev";

let apiBaseUrl = import.meta.env.VITE_API_URL || DEFAULT_LOCAL;

if (typeof window !== "undefined") {
  const host = window.location.hostname || "";

  if (host.endsWith(".github.io")) {
    apiBaseUrl = DEPLOY_BACKEND_URL;
  } else if (
    apiBaseUrl === DEFAULT_LOCAL ||
    /localhost/.test(apiBaseUrl) ||
    host.endsWith(".github.dev")
  ) {
    if (host.endsWith(".github.dev")) {
      const baseHost = host.replace(/-\d+$/, "").replace(".github.dev", "").replace(".app", "");
      apiBaseUrl = `https://${baseHost}-8787.app.github.dev`;
    }
  }
}

const normalizedUrl = apiBaseUrl.replace(/\/$/, "");

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30초 타임아웃

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errorText = await res.text();
      console.error("API error:", url, res.status, res.statusText, errorText);
      throw new Error(`${res.status} ${res.statusText}: ${errorText}`);
    }
    return res.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      console.error("API timeout:", url);
      throw new Error(`요청 타임아웃: ${url}`, { cause: error });
    }
    throw error;
  }
}

export const api = {
  getSketch: async () => {
    const url = `${normalizedUrl}/api/sketch`;
    return fetchJson(url);
  },

  saveSketch: async (imageData, vector = null) => {
    const url = `${normalizedUrl}/api/sketch`;
    const body = { imageData };
    if (Array.isArray(vector)) {
      body.vector = vector;
    }
    return fetchJson(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  },

  resetSketch: async (secret) => {
    const url = `${normalizedUrl}/api/sketch/reset`;
    return fetchJson(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ secret }),
    });
  },

  health: async () => {
    const url = `${normalizedUrl}/api/health`;
    return fetchJson(url);
  },
};

export const API_BASE_URL = normalizedUrl;
