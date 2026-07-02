// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  clearSketchPersistedState,
  markSketchReset,
  normalizeSketchPayload,
  shouldSkipSketchRestore,
} from "../src/services/sketch-state.js";

describe("normalizeSketchPayload", () => {
  it("returns snapshot-first payload from a hybrid backend response", () => {
    const result = normalizeSketchPayload({
      imageData: "data:image/webp;base64,abc",
      vector: [{ type: "stroke", points: [{ x: 1, y: 2 }] }],
    });

    expect(result.snapshot).toBe("data:image/webp;base64,abc");
    expect(result.vector).toEqual([{ type: "stroke", points: [{ x: 1, y: 2 }] }]);
    expect(result.shouldRenderSnapshotFirst).toBe(true);
  });

  it("falls back to local vector-only payloads", () => {
    const result = normalizeSketchPayload([{ type: "stroke", points: [{ x: 3, y: 4 }] }]);

    expect(result.snapshot).toBeNull();
    expect(result.vector).toEqual([{ type: "stroke", points: [{ x: 3, y: 4 }] }]);
    expect(result.shouldRenderSnapshotFirst).toBe(false);
  });

  it("consumes a reset marker so a fresh page does not restore old strokes", () => {
    const storage = window.localStorage;
    storage.clear();

    markSketchReset(storage);

    expect(shouldSkipSketchRestore(storage)).toBe(true);
    expect(shouldSkipSketchRestore(storage)).toBe(false);
  });

  it("removes the persisted sketch state during a hard reset", () => {
    const storage = window.localStorage;
    storage.clear();
    storage.setItem("sketchy-canvas", "data:image/webp;base64,abc");
    storage.setItem("sketchy-strokes", JSON.stringify([{ type: "stroke" }]));

    clearSketchPersistedState(storage);

    expect(storage.getItem("sketchy-canvas")).toBeNull();
    expect(storage.getItem("sketchy-strokes")).toBeNull();
  });
});
