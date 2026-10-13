import { describe, expect, it } from "vitest";
import { clampWindow, initialWindow, maximizedWindow, nextWindowLayer, resizeWindow, resizeWindowEdge, windowMinimum, type ResizeEdge } from "./window-layout";
const viewport = { x: 0, y: 0, width: 1440, height: 900 };
describe("floating tool window geometry", () => {
  it("keeps dragged windows entirely inside the viewport with their title bars reachable", () => {
    expect(clampWindow({ x: -400, y: -300, width: 500, height: 560 }, viewport)).toEqual({ x: 12, y: 12, width: 500, height: 560 });
    expect(clampWindow({ x: 2000, y: 2000, width: 500, height: 560 }, viewport)).toEqual({ x: 928, y: 328, width: 500, height: 560 });
  });
  it("fits very small and shifted visual viewports without forcing desktop minimum dimensions", () => {
    const tiny = { x: 30, y: 50, width: 240, height: 180 };
    expect(clampWindow({ x: -300, y: 1000, width: 860, height: 640 }, tiny)).toEqual({ x: 42, y: 62, width: 216, height: 156 });
    const small = initialWindow("board", tiny); expect(small.x + small.width).toBeLessThanOrEqual(258); expect(small.y + small.height).toBeLessThanOrEqual(218);
  });
  it("opens left of chat when there is space and otherwise centers a bounded window", () => {
    const beside = initialWindow("notes", viewport, { left: 1070 });
    expect(beside).toEqual({ x: 492, y: 100, width: 560, height: 700 });
    const centered = initialWindow("board", viewport, { left: 340 });
    expect(centered).toEqual({ x: 290, y: 130, width: 860, height: 640 });
    const another = initialWindow("notes", viewport, { left: 1070 }, 1); expect(another.x).toBe(beside.x - 22); expect(another.y).toBe(beside.y + 22);
  });
  it("clamps resize edges without shifting the window and maintains usable minimum size", () => {
    const current = { x: 500, y: 200, width: 500, height: 500 };
    expect(resizeWindow(current, 2000, 2000, viewport)).toEqual({ x: 500, y: 200, width: 928, height: 688 });
    expect(resizeWindow(current, 2, 3, viewport)).toEqual({ x: 500, y: 200, width: 320, height: 220 });
  });
  it.each<[ResizeEdge, { x: number; y: number; width: number; height: number }]>([
    ["n", { x: 500, y: 170, width: 500, height: 530 }],
    ["ne", { x: 500, y: 170, width: 540, height: 530 }],
    ["e", { x: 500, y: 200, width: 540, height: 500 }],
    ["se", { x: 500, y: 200, width: 540, height: 470 }],
    ["s", { x: 500, y: 200, width: 500, height: 470 }],
    ["sw", { x: 540, y: 200, width: 460, height: 470 }],
    ["w", { x: 540, y: 200, width: 460, height: 500 }],
    ["nw", { x: 540, y: 170, width: 460, height: 530 }],
  ])("resizes from the %s edge while keeping opposite edges fixed", (edge, expected) => {
    expect(resizeWindowEdge({ x: 500, y: 200, width: 500, height: 500 }, edge, 40, -30, viewport)).toEqual(expected);
  });
  it("stops north/west resizing at viewport bounds and at the tool minimum without shifting opposite edges", () => {
    const current = { x: 500, y: 200, width: 500, height: 500 };
    expect(resizeWindowEdge(current, "nw", -2000, -2000, viewport, windowMinimum("documents"))).toEqual({ x: 12, y: 12, width: 988, height: 688 });
    expect(resizeWindowEdge(current, "nw", 2000, 2000, viewport, windowMinimum("documents"))).toEqual({ x: 640, y: 380, width: 360, height: 320 });
  });
  it("uses content-specific minimum dimensions and lets empty chat remain compact", () => {
    const small = { x: 200, y: 200, width: 1, height: 1 };
    expect(clampWindow(small, viewport, windowMinimum("chat"))).toEqual({ x: 200, y: 200, width: 300, height: 120 });
    expect(clampWindow(small, viewport, windowMinimum("documents"))).toEqual({ x: 200, y: 200, width: 360, height: 320 });
    expect(clampWindow(small, viewport, windowMinimum("phone"))).toEqual({ x: 200, y: 200, width: 320, height: 360 });
    expect(clampWindow(small, viewport, windowMinimum("notes"))).toEqual({ x: 200, y: 200, width: 320, height: 280 });
  });
  it("reduces every tool minimum to fit small, shifted visual viewports", () => {
    const tiny = { x: 30, y: 50, width: 240, height: 180 };
    for (const tool of ["chat", "board", "video", "documents", "phone", "notes", "settings"]) {
      const minimum = windowMinimum(tool), fit = initialWindow(tool, tiny);
      const width = Math.min(minimum.width, 216), height = Math.min(minimum.height, 156);
      expect(resizeWindowEdge(fit, "nw", 2000, 2000, tiny, minimum)).toEqual({ x: fit.x + fit.width - width, y: fit.y + fit.height - height, width, height });
      expect(resizeWindowEdge(fit, "se", -2000, -2000, tiny, minimum)).toEqual({ ...fit, width, height });
    }
  });
  it("maximizes inside the current visual viewport", () => {
    expect(maximizedWindow(viewport)).toEqual({ x: 12, y: 12, width: 1416, height: 876 });
    expect(maximizedWindow({ x: 30, y: 50, width: 240, height: 180 })).toEqual({ x: 42, y: 62, width: 216, height: 156 });
  });
  it("uses one increasing focus layer sequence shared with chat", () => { const tool = nextWindowLayer(), chat = nextWindowLayer(); expect(chat).toBeGreaterThan(tool); expect(nextWindowLayer()).toBeGreaterThan(chat); });
});
