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
