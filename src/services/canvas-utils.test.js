// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { applyCanvasSize, resolveCanvasSize } from "./canvas-utils.js";

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
});
