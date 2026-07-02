const RESET_MARKER_KEY = "sketchy-reset-marker";
const SKETCH_STORAGE_KEYS = [
  "sketchy-canvas",
  "sketchy-strokes",
  "sketchy-snapshot-target-size",
  RESET_MARKER_KEY,
];

export function normalizeSketchPayload(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const vector = Array.isArray(payload.vector) ? payload.vector : null;
    const snapshot =
      typeof payload.snapshot === "string" && payload.snapshot.length ? payload.snapshot : null;
    const imageData =
      typeof payload.imageData === "string" && payload.imageData.length
        ? payload.imageData
        : snapshot;
    const normalizedVector = Array.isArray(vector) ? vector : null;

    return {
      vector: normalizedVector,
      snapshot: imageData,
      shouldRenderSnapshotFirst: Boolean(imageData),
    };
  }

  const vector = Array.isArray(payload) ? payload : null;
  return {
    vector,
    snapshot: null,
    shouldRenderSnapshotFirst: false,
  };
}

export function clearSketchPersistedState(storage = window.localStorage) {
  if (!storage) return;
  try {
    for (const key of SKETCH_STORAGE_KEYS) {
      storage.removeItem(key);
    }
  } catch {
    // ignore
  }
}

export function markSketchReset(
  storage = window.localStorage,
  sessionStorage = window.sessionStorage
) {
  if (!storage) return;
  try {
    const resetValue = String(Date.now());
    storage.setItem(RESET_MARKER_KEY, resetValue);
    if (sessionStorage) {
      sessionStorage.setItem(RESET_MARKER_KEY, resetValue);
    }
  } catch {
    // ignore
  }
}

export function shouldSkipSketchRestore(
  storage = window.localStorage,
  sessionStorage = window.sessionStorage
) {
  const marker = storage?.getItem(RESET_MARKER_KEY) || sessionStorage?.getItem(RESET_MARKER_KEY);
  if (!marker) return false;

  try {
    storage?.removeItem(RESET_MARKER_KEY);
  } catch {
    // ignore
  }
  try {
    sessionStorage?.removeItem(RESET_MARKER_KEY);
  } catch {
    // ignore
  }
  return true;
}
