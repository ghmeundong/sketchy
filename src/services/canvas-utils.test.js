// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  applyCanvasSize,
  drawImagePreservingSize,
  resolveCanvasSize,
  resolveSnapshotTargetSize,
} from "./canvas-utils.js";

describe("canvas sizing helpers", () => {
  it("resolves backing dimensions from css size and device pixel ratio", () => {
    const result = resolveCanvasSize(800, 600, 2);

    expect(result.cssWidth).toBe(800);
    expect(result.cssHeight).toBe(600);
    expect(result.backingWidth).toBe(1600);
    expect(result.backingHeight).toBe(1200);
    expect(result.dpr).toBe(2);
  });

  it("applies canvas size to an element and returns the resolved metrics", () => {
    const canvas = document.createElement("canvas");
    const result = applyCanvasSize(canvas, 320, 240, 1.5);

    expect(canvas.width).toBe(480);
    expect(canvas.height).toBe(360);
    expect(canvas.style.width).toBe("320px");
    expect(canvas.style.height).toBe("240px");
    expect(result.backingWidth).toBe(480);
    expect(result.backingHeight).toBe(360);
  });

  it("draws images at their intrinsic logical size instead of stretching them to the canvas", () => {
    const drawImage = vi.fn();
    const ctx = { drawImage };
    const image = { naturalWidth: 800, naturalHeight: 600, width: 800, height: 600 };

    const result = drawImagePreservingSize(ctx, image, { dpr: 2 });

    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 400, 300);
    expect(result).toEqual({ width: 400, height: 300, x: 0, y: 0 });
  });

  it("keeps the largest previously seen canvas size as the snapshot target", () => {
    const result = resolveSnapshotTargetSize(900, 600, { width: 1400, height: 900 });

    expect(result).toEqual({ width: 1400, height: 900 });
  });
});
