// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { normalizeSketchPayload } from "./sketch-state.js";

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
});
