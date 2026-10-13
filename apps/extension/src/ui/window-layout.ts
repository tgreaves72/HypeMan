export interface WindowRect { x: number; y: number; width: number; height: number }
export interface WindowViewport { x: number; y: number; width: number; height: number }
export interface WindowSize { width: number; height: number }
export type ResizeEdge = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
export const resizeEdges: readonly ResizeEdge[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const defaultMinimum: WindowSize = { width: 320, height: 220 };
export function windowMinimum(tool: string): WindowSize {
  if (tool === "chat") return { width: 300, height: 120 };
  if (tool === "board" || tool === "video") return { width: 360, height: 300 };
  if (tool === "documents") return { width: 360, height: 320 };
  if (tool === "phone") return { width: 320, height: 360 };
  return { width: 320, height: 280 };
}
let windowLayer = 50;
export const nextWindowLayer = () => ++windowLayer;
export function windowViewport(): WindowViewport {
  const viewport = window.visualViewport;
  return { x: viewport?.offsetLeft || 0, y: viewport?.offsetTop || 0,
    width: viewport?.width || window.innerWidth, height: viewport?.height || window.innerHeight };
}
const margin = (viewport: WindowViewport) => Math.min(12, viewport.width / 4, viewport.height / 4);
const bound = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
export function clampWindow(rect: WindowRect, viewport: WindowViewport, minimum: WindowSize = defaultMinimum): WindowRect {
  const inset = margin(viewport), maxWidth = Math.max(1, viewport.width - inset * 2), maxHeight = Math.max(1, viewport.height - inset * 2);
  const width = bound(rect.width, Math.min(minimum.width, maxWidth), maxWidth), height = bound(rect.height, Math.min(minimum.height, maxHeight), maxHeight);
  return { width, height, x: bound(rect.x, viewport.x + inset, viewport.x + viewport.width - inset - width),
    y: bound(rect.y, viewport.y + inset, viewport.y + viewport.height - inset - height) };
}
export function initialWindow(tool: string, viewport: WindowViewport, chat?: { left: number; top?: number; width?: number; height?: number }, cascade = 0): WindowRect {
  const preferredWidth = tool === "board" ? 860 : tool === "documents" ? 780 : tool === "video" ? 760 : tool === "notes" ? 560 : 500;
  const preferredHeight = ["documents", "notes"].includes(tool) ? 700 : ["board", "phone"].includes(tool) ? 640 : tool === "video" ? 610 : 560;
  const minimum = windowMinimum(tool), inset = margin(viewport), gap = 18, step = cascade % 5 * 22;
  const leftSpace = chat ? chat.left - viewport.x - inset - gap : 0;
  // On laptops, resize the new tool into the space beside chat before covering it.
  if (chat && leftSpace >= minimum.width) {
    const width = Math.min(preferredWidth, leftSpace), height = Math.min(preferredHeight, viewport.height - inset * 2);
    return clampWindow({ width, height, x: Math.max(viewport.x + inset, chat.left - width - gap - step), y: viewport.y + (viewport.height - height) / 2 + step }, viewport, minimum);
  }
  const rightSpace = chat?.width ? viewport.x + viewport.width - inset - (chat.left + chat.width) - gap : 0;
  if (chat && rightSpace >= minimum.width) {
    const width = Math.min(preferredWidth, rightSpace), height = Math.min(preferredHeight, viewport.height - inset * 2);
    return clampWindow({ width, height, x: chat.left + (chat.width || 0) + gap, y: viewport.y + (viewport.height - height) / 2 }, viewport, minimum);
  }
  if (chat?.top !== undefined) {
    // Narrow screens stack floating tools above the compact chat, keeping its composer reachable.
    const above = chat.top - viewport.y - inset - 12;
    if (above >= minimum.height) return clampWindow({ width: preferredWidth, height: Math.min(preferredHeight, above), x: viewport.x + inset, y: viewport.y + inset }, viewport, minimum);
  }
  const size = clampWindow({ x: viewport.x, y: viewport.y, width: preferredWidth, height: preferredHeight }, viewport, minimum);
  return clampWindow({ ...size, x: viewport.x + (viewport.width - size.width) / 2 + step, y: viewport.y + (viewport.height - size.height) / 2 + step }, viewport, minimum);
}
export function resizeWindowEdge(rect: WindowRect, edge: ResizeEdge, dx: number, dy: number, viewport: WindowViewport, minimum: WindowSize = defaultMinimum): WindowRect {
  const current = clampWindow(rect, viewport, minimum), inset = margin(viewport);
  const minWidth = Math.min(minimum.width, Math.max(1, viewport.width - inset * 2));
  const minHeight = Math.min(minimum.height, Math.max(1, viewport.height - inset * 2));
  let left = current.x, top = current.y, right = left + current.width, bottom = top + current.height;
  if (edge.includes("w")) left = bound(left + dx, viewport.x + inset, right - minWidth);
  if (edge.includes("e")) right = bound(right + dx, left + minWidth, viewport.x + viewport.width - inset);
  if (edge.includes("n")) top = bound(top + dy, viewport.y + inset, bottom - minHeight);
  if (edge.includes("s")) bottom = bound(bottom + dy, top + minHeight, viewport.y + viewport.height - inset);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
export function resizeWindow(rect: WindowRect, width: number, height: number, viewport: WindowViewport, minimum: WindowSize = defaultMinimum): WindowRect {
  const current = clampWindow(rect, viewport, minimum);
  return resizeWindowEdge(current, "se", width - current.width, height - current.height, viewport, minimum);
}
export function maximizedWindow(viewport: WindowViewport): WindowRect {
  const inset = margin(viewport);
  return { x: viewport.x + inset, y: viewport.y + inset, width: Math.max(1, viewport.width - inset * 2), height: Math.max(1, viewport.height - inset * 2) };
}
