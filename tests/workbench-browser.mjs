import { installBrowserFixtures } from "./fixtures/browser-pages.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { tsImport } from "tsx/esm/api";

const { createGateway } = await tsImport("../apps/gateway/src/index.ts", import.meta.url);
const { loadConfig } = await tsImport("../apps/gateway/src/config.ts", import.meta.url);
const token = "hypeman-conversation-workbench-fixture";
const decisions = [];
const gateway = createGateway(loadConfig({ PORT: "0", DEMO_MODE: "1" }), {
  token,
  agent: async (input) => {
    decisions.push(input);
    if (/missing subtraction.*visually/i.test(input.message)) return {
      action: { type: "sketch", title: "Find the missing subtraction", shapes: [{ type: "label", text: "9 - \\square = 7", x: 55, y: 0 }],
        lines: ["Find the gap: count back from 9 to 7.", "Think backwards: 7 + 2 = 9.", "Check by subtracting that number from 9."] },
      say: "Count the steps between 7 and 9.", done: true, provider: "demo",
    };
    if (/fractions.*visually|visual.*fractions/i.test(input.message)) return {
      action: { type: "sketch", title: "Fractions use equal-sized parts", lines: ["\\frac{1}{2}+\\frac{1}{4}=\\frac{2}{4}+\\frac{1}{4}", "\\frac{2}{4}+\\frac{1}{4}=\\frac{3}{4}"], shapes: [
        { type: "circle", x: 140, y: 100, radius: 50 }, { type: "arrow", x: 220, y: 100, toX: 360, toY: 100 }, { type: "label", x: 380, y: 100, text: "Equal-sized pieces" },
      ] }, say: "The whiteboard shows why the parts need equal sizes.", done: true, provider: "demo",
    };
    if (/another worked step/i.test(input.message)) return { action: { type: "tool", tool: "board", operation: "add", args: { objects: [{ kind: "equation", text: "3x + 6 = 12", x: 60, y: 450 }] } }, done: true, provider: "demo" };
    return { action: { type: "say", text: "A fraction describes equal-sized parts of a whole." }, done: true, provider: "demo" };
  },
});
const profile = await mkdtemp(join(tmpdir(), "hypeman-workbench-"));
await mkdir("tests/screenshots", { recursive: true });
let context, home;
let checks = 0;
const check = (name) => { checks++; console.log(`✓ ${name}`); };
async function waitFor(predicate, description, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${description}`);
}
async function rpc(message, page = home) {
  return page.evaluate(async (message) => {
    const reply = await chrome.runtime.sendMessage({ ...message, requestId: crypto.randomUUID() });
    if (!reply?.ok) throw new Error(reply?.error || "No extension response");
    return reply.data;
  }, message);
}
async function send(text, page = home) {
  const field = page.getByRole("textbox", { name: "What do you need?", exact: true });
  await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
  await field.fill(text); await field.press("Enter");
  await waitFor(async () => (await field.inputValue()) === "", `composer clears: ${text}`, 30_000);
  await page.getByRole("button", { name: "Send message", exact: true }).waitFor({ timeout: 30_000 });
  const error = page.locator(".conversation-pane .notice.error:visible");
  assert.equal(await error.count(), 0, await error.allTextContents());
}
async function conversationId() {
  const tabId = await home.evaluate(async () => (await chrome.tabs.getCurrent()).id);
  return (await rpc({ type: "conversation.resolve", tabId })).id;
}
async function boardDocument(id) { return rpc({ type: "artifact.get", conversationId: id, kind: "board" }); }
async function resizeFromEdge(page, window, edge, dx, dy) {
  await window.locator(".pixel-workspace-bar").focus();
  const handle = await window.locator(`[data-resize-edge="${edge}"]`).boundingBox();
  const before = await window.boundingBox();
  assert.ok(handle && before, `${edge} resize handle is reachable`);
  const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
  const hit = await page.evaluate(({ x, y }) => {
    let element = document.elementFromPoint(x, y);
    while (element?.shadowRoot?.elementFromPoint(x, y)) element = element.shadowRoot.elementFromPoint(x, y);
    return { tag: element?.tagName, class: element?.getAttribute("class"), edge: element?.getAttribute("data-resize-edge") };
  }, { x, y });
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 5 }); await page.mouse.up();
  return { before, after: await window.boundingBox(), hit };
}
function simplePdf() {
  const lines = ["A fraction represents equal-sized parts.", "Adding fractions requires a common denominator."];
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>"];
  for (let i = 0; i < 2; i++) {
    const content = `BT /F1 18 Tf 48 710 Td (${lines[i]}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${i === 0 ? 4 : 6} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let result = "%PDF-1.4\n", offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}
try {
  const base = `http://127.0.0.1:${await gateway.listen()}`;
  const extension = resolve("apps/extension/dist");
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, viewport: { width: 1540, height: 1100 }, acceptDownloads: true,
    ...(process.env.HYPEMAN_TEST_CHROMIUM ? { executablePath: process.env.HYPEMAN_TEST_CHROMIUM } : {}),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--enable-unsafe-extension-debugging"],
  });
  await installBrowserFixtures(context);
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  home = await context.newPage(); await home.goto(`chrome-extension://${extensionId}/newtab.html`);
  await home.getByRole("button", { name: "Open HypeMan", exact: true }).waitFor();
  assert.equal(await home.locator(".conversation-workbench").count(), 0);
  assert.equal(await home.getByRole("button", { name: "Open HypeMan", exact: true }).count(), 1);
  await home.screenshot({ path: "tests/screenshots/hypeman-quiet-rooftop.png", fullPage: true });
  await home.getByRole("button", { name: "Open HypeMan", exact: true }).click();
  const field = home.getByRole("textbox", { name: "What do you need?", exact: true });
  await field.waitFor(); await waitFor(async () => !(await field.isDisabled()), "conversation loaded");
  for (const page of context.pages()) if (page !== home) await page.close();
  await rpc({ type: "settings.patch", patch: { serverUrl: base, serverToken: token, onboarded: true, proactiveEnabled: false, reducedMotion: "on" } });
  await home.evaluate(() => document.fonts.ready);
  assert.equal(await home.locator(".conversation-composer textarea:visible").count(), 1);
  assert.equal(await home.locator(".conversation-workbench.has-tool").count(), 0);
  for (const name of ["Whiteboard", "Saved notes", "Projects", "More tools", "Ask HypeMan mode", "Quick answer mode", "Search the web mode", "Open saved notes"])
    assert.equal(await home.getByRole("button", { name, exact: true }).count(), 0, `Launcher remains: ${name}`);
  await home.screenshot({ path: "tests/screenshots/hypeman-conversation-home.png", fullPage: true });
  check("The quiet rooftop opens one conversation from its avatar with no launcher or mode toolbar");

  const anchoredChat = await home.locator(".conversation-pane").boundingBox();
  assert.ok(anchoredChat.height < 180, "Empty chat retains its previous compact height");
  await send("Explain adding fractions visually");
  await home.locator(".shared-board .katex").first().waitFor();
  const id = await conversationId();
  const initial = await waitFor(async () => { const value = await boardDocument(id); return value?.objects?.length ? value : null; }, "assistant scene saved");
  assert.ok(initial.objects.some((object) => object.kind === "equation"));
  assert.ok(initial.objects.some((object) => object.kind === "arrow"));
  const pane = await home.locator(".conversation-pane").boundingBox();
  const boardWindow = home.locator(".workspace-board");
  const tool = await boardWindow.boundingBox();
  assert.ok(pane && tool && anchoredChat);
  assert.equal(pane.x, anchoredChat.x, "Opening a tool must not shift chat");
  assert.equal(pane.width, anchoredChat.width, "Opening a tool must not resize chat");
  assert.ok(pane.height <= 410, "Chat keeps its original bounded message height");
  assert.equal(pane.y + pane.height, anchoredChat.y + anchoredChat.height, "Chat stays anchored above the avatar");
  assert.equal(await boardWindow.evaluate((element) => getComputedStyle(element).position), "fixed");
  const title = boardWindow.locator(".pixel-workspace-bar"), titleBounds = await title.boundingBox();
  await home.mouse.move(titleBounds.x + 150, titleBounds.y + 15); await home.mouse.down();
  await home.mouse.move(titleBounds.x + 205, titleBounds.y + 45, { steps: 8 }); await home.mouse.up();
  const moved = await boardWindow.boundingBox();
  assert.ok(Math.abs(moved.x - tool.x - 55) < 2 && Math.abs(moved.y - tool.y - 30) < 2, "Title-bar dragging moves the window");
  await title.focus(); await title.press("ArrowLeft");
  assert.equal(Math.round((await boardWindow.boundingBox()).x), Math.round(moved.x - 10), "Focused title bars support keyboard movement");
  const grip = boardWindow.locator(".pixel-window-resize"), gripBounds = await grip.boundingBox();
  const beforeResize = await boardWindow.boundingBox();
  await home.mouse.move(gripBounds.x + gripBounds.width / 2, gripBounds.y + gripBounds.height / 2); await home.mouse.down();
  await home.mouse.move(gripBounds.x + gripBounds.width / 2 - 35, gripBounds.y + gripBounds.height / 2 - 25, { steps: 6 }); await home.mouse.up();
  const resized = await boardWindow.boundingBox();
  assert.ok(resized.width < beforeResize.width - 30 && resized.height < beforeResize.height - 20, "Corner dragging resizes the window");
  assert.equal((await home.locator(".conversation-pane").boundingBox()).x, anchoredChat.x);
  await home.locator(".chat-message.assistant").first().click();
  assert.equal(await home.locator(".chat-message.is-selected").count(), 1);
  assert.equal(await home.locator(".conversation-context").count(), 0, "Clicking a message only marks it in place");
  check("Tools float, drag, resize, and support keyboard movement without shifting or resizing chat");
  assert.ok(await home.locator(".shared-board button").count() > 0, "Board tools stay available directly");
  const surface = home.locator(".board-viewport"), bounds = await surface.boundingBox();
  await home.getByRole("button", { name: "Draw", exact: true }).click();
  await home.mouse.move(bounds.x + Math.min(450, bounds.width * .7), bounds.y + 370); await home.mouse.down();
  await home.mouse.move(bounds.x + Math.min(520, bounds.width * .8), bounds.y + 420, { steps: 12 }); await home.mouse.up();
  const inked = await waitFor(async () => { const value = await boardDocument(id); return value?.objects.some((object) => object.kind === "stroke" && object.source === "user") ? value : null; }, "user ink saved in assistant board");
  await send("undo"); await waitFor(async () => (await boardDocument(id)).objects.length === initial.objects.length, "chat undo removes user stroke");
  await send("redo"); await waitFor(async () => (await boardDocument(id)).objects.length === inked.objects.length, "chat redo restores user stroke");
  check("Assistant diagrams, equations, and direct user ink share durable transactional undo and redo");
  await home.getByRole("button", { name: "Select and move", exact: true }).click();

  const firstEquation = initial.objects.find((object) => object.kind === "equation");
  const equationObject = home.locator(`[data-board-id="${firstEquation.id}"]`);
  await equationObject.dblclick();
  const editor = home.getByRole("textbox", { name: "Edit selected board text or equation" });
  await editor.fill("\\frac{2}{4}+\\frac{1}{4}=\\frac{3}{4}"); await editor.press("Control+Enter");
  await waitFor(async () => (await boardDocument(id)).objects.find((object) => object.id === firstEquation.id).text.includes("\\frac{3}{4}"), "equation edited directly");
  await send("Add another worked step");
  await waitFor(async () => (await boardDocument(id)).objects.some((object) => object.text === "3x + 6 = 12"), "assistant tool action adds a scene object");
  const downloadEvent = home.waitForEvent("download"); await send("export this board as PNG");
  const download = await downloadEvent; await download.saveAs("tests/screenshots/hypeman-board-export.png");
  const exported = await readFile("tests/screenshots/hypeman-board-export.png");
  assert.equal(exported.subarray(1, 4).toString(), "PNG"); assert.ok(exported.length > 5000);
  await home.screenshot({ path: "tests/screenshots/hypeman-conversation-board.png", fullPage: true });
  const saved = await boardDocument(id);
  await send("close board"); assert.equal(await home.locator(".shared-board:visible").count(), 0);
  await send("open whiteboard"); await home.locator(".shared-board:visible").waitFor();
  assert.deepEqual((await boardDocument(id)).objects, saved.objects);
  await home.reload(); await home.getByRole("button", { name: "Open HypeMan", exact: true }).click();
  await waitFor(async () => !(await field.isDisabled()), "conversation rehydrates after reload");
  assert.equal(await conversationId(), id); await send("open whiteboard");
  await waitFor(async () => (await home.locator(".shared-board .board-text").count()) === saved.objects.filter((object) => ["text", "equation"].includes(object.kind)).length, "scene rehydrates");
  assert.deepEqual((await boardDocument(id)).objects, saved.objects);
  check("Direct equation edits, assistant additions, composite export, dismissal, and page reload preserve the same board");

  await send("remember: Fraction parts need equal sizes");
  assert.equal(await home.locator(".workspace-board:visible").count(), 1);
  assert.equal(await home.locator(".workspace-notes:visible").count(), 1);
  const note = await waitFor(async () => (await rpc({ type: "workspace.get" })).notes.find((note) => note.text === "Fraction parts need equal sizes"), "conversation note created");
  const noteEditor = home.locator(".direct-note-editor").filter({ hasText: "" }).first();
  await noteEditor.waitFor(); await noteEditor.fill("Equal-sized fraction parts can be combined."); await field.focus();
  await waitFor(async () => (await rpc({ type: "workspace.get" })).notes.find((value) => value.id === note.id)?.text === "Equal-sized fraction parts can be combined.", "direct note autosave");
  assert.ok(await home.locator(".inline-toolbox-notes button").count() > 0, "Notes keep compact direct controls");
  await send("find my notes about nonexistent-phrase");
  await home.locator(".workspace-notes").getByText("No matching sources", { exact: true }).waitFor();
  await send("open projects");
  assert.equal(await home.locator(".workspace-notes:visible").count(), 1);
  await send("find my notes about fraction");
  await home.locator(".workspace-notes .direct-note-editor").waitFor();
  const notesLayer = await home.locator(".workspace-notes").evaluate((element) => Number(element.style.zIndex));
  await home.locator(".workspace-board .pixel-workspace-bar").click({ position: { x: 30, y: 15 } });
  assert.ok(await boardWindow.evaluate((element) => Number(element.style.zIndex)) > notesLayer, "Clicking a tool brings it forward");
  await send("close board");
  assert.equal(await home.locator(".workspace-board:visible").count(), 0);
  assert.equal(await home.locator(".workspace-notes:visible").count(), 1, "Closing one tool leaves others open");
  check("Conversation saves notes and direct content editing autosaves without Edit or Save buttons");

  const pdf = simplePdf();
  await home.locator(".conversation-workbench").evaluate((element, bytes) => {
    const file = new File([new Uint8Array(bytes)], "fraction-study.pdf", { type: "application/pdf" });
    const transfer = new DataTransfer(); transfer.items.add(file);
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, [...pdf]);
  const documentFrame = home.frameLocator('iframe[title="PDF document"]');
  await documentFrame.locator('canvas[aria-label="PDF page 1"]').waitFor();
  await waitFor(async () => (await documentFrame.locator(".textLayer span").count()) > 0, "PDF text layer rendered");
  await documentFrame.locator(".textLayer").evaluate((element) => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await waitFor(async () => (await home.locator(".conversation-attachment-chip").innerText()).includes("p. 1"), "PDF selection relayed with page context");
  assert.equal(await home.locator(".conversation-context").count(), 0, "Selections never echo the selected passage below chat");
  await send("What does this passage mean?");
  await documentFrame.getByRole("region", { name: "PDF answer", exact: true }).waitFor();
  assert.ok((await home.locator(".conversation-messages").innerText()).includes("fraction-study.pdf, p. 1"));
  assert.equal(await documentFrame.locator(".pdf-citations a").count(), 1);
  await home.screenshot({ path: "tests/screenshots/hypeman-conversation-pdf.png", fullPage: true });
  await send("save this");
  const excerpt = (await rpc({ type: "workspace.get" })).notes.find((value) => value.origin?.kind === "document");
  assert.ok(excerpt?.text.includes("A fraction represents equal-sized parts."));
  assert.equal(excerpt.origin.page, 1); assert.equal(excerpt.origin.conversationId, id);
  assert.equal(excerpt.url, "");
  await home.locator('.conversation-messages a').filter({ hasText: "fraction-study.pdf, p. 1" }).first().click();
  await send("go to page 2"); await documentFrame.locator('canvas[aria-label="PDF page 2"]').waitFor();
  const chatCitation = home.locator(".chat-message.assistant a").filter({ hasText: "fraction-study.pdf, p. 1" }).first();
  await chatCitation.click();
  await documentFrame.locator('canvas[aria-label="PDF page 1"]').waitFor();
  await send("go to page 2"); await documentFrame.locator('canvas[aria-label="PDF page 2"]').waitFor();
  await documentFrame.locator(".pdf-citations a").first().click(); await documentFrame.locator('canvas[aria-label="PDF page 1"]').waitFor();
  check("Dropping a real PDF opens a local reader; selection grounds chat and citations navigate to actual pages");

  await home.reload(); await home.getByRole("button", { name: "Open HypeMan", exact: true }).click();
  await waitFor(async () => !(await field.isDisabled()), "PDF conversation reload");
  await home.locator('.conversation-messages a').filter({ hasText: "fraction-study.pdf, p. 1" }).first().click();
  await home.frameLocator('iframe[title="PDF document"]').locator('canvas[aria-label="PDF page 1"]').waitFor();
  assert.equal((await rpc({ type: "document.list", conversationId: id })).length, 1);
  await send("close document"); await send("open settings");
  await home.locator(".inline-toolbox-settings").waitFor();
  assert.equal(await home.locator(".inline-toolbox-settings").getByRole("button", { name: "Export", exact: true }).count(), 1);
  await send("reduce motion"); assert.equal((await rpc({ type: "settings.get" })).reducedMotion, "on");
  await send("close tool");
  assert.equal(await home.locator(".conversation-composer textarea:visible").count(), 1);
  check("Documents persist with the conversation and preferences remain available through chat and direct fields");

  for (const [command, section] of [["open whiteboard", "board"], ["open notes", "notes"], ["open documents", "documents"], ["open projects", "tasks"], ["open practice", "learning"], ["open activity", "activity"], ["open video", "video"], ["open connection", "connection"], ["open phone", "phone"], ["open settings", "settings"]]) {
    await send(command);
    const window = home.locator(`.workspace-${section}:visible`);
    await window.waitFor();
    assert.equal(await window.locator(".pixel-workspace-bar").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(117, 232, 244)", `${section} uses the approved cyan title bar`);
    assert.equal(await window.evaluate((element) => getComputedStyle(element).borderRadius), "0px");
  }
  let resizeChecks = 0;
  for (const section of ["chat", "board", "notes", "documents", "tasks", "learning", "activity", "video", "connection", "phone", "settings"]) {
    const window = home.locator(`[data-window-tool="${section}"]:visible`);
    const title = window.locator(".pixel-workspace-bar");
    await title.focus();
    const old = await window.boundingBox(), bar = await title.boundingBox();
    const targetX = (1540 - old.width) / 2, targetY = 100;
    await home.mouse.move(bar.x + 140, bar.y + 18); await home.mouse.down();
    await home.mouse.move(bar.x + 140 + targetX - old.x, bar.y + 18 + targetY - old.y, { steps: 6 }); await home.mouse.up();
    for (const [edge, dx, dy] of [["se", 20, 16], ["e", 12, 0], ["s", 0, 12], ["w", -12, 0], ["n", 0, -12], ["nw", -8, -8], ["ne", 8, -8], ["sw", -8, 8]]) {
      const { before, after, hit } = await resizeFromEdge(home, window, edge, dx, dy);
      assert.ok(after.width > before.width + 5 || after.height > before.height + 5, `${section} resizes from its ${edge} edge/corner: ${JSON.stringify({ before, after, hit })}`);
      resizeChecks++;
    }
    const beforeMax = await window.boundingBox();
    await window.locator(".pixel-window-maximize").click();
    const maximized = await window.boundingBox();
    assert.equal(Math.round(maximized.width), 1516); assert.equal(Math.round(maximized.height), 1076);
    await window.locator(".pixel-window-maximize").click();
    assert.deepEqual(await window.boundingBox(), beforeMax, `${section} restores its previous size`);
    await window.locator(".pixel-window-minimize").click();
    assert.equal(await window.locator("[data-resize-edge]").count(), 0);
    assert.ok((await window.boundingBox()).height < 80, `${section} minimizes to its title bar`);
    await window.locator(".pixel-window-minimize").click();
    assert.deepEqual(await window.boundingBox(), beforeMax, `${section} restores after minimizing`);
  }
  check(`All 11 windows pass ${resizeChecks} edge/corner resize checks plus maximize, minimize, and restore`);
  await home.screenshot({ path: "tests/screenshots/hypeman-themed-floating-tools.png", fullPage: true });
  await home.setViewportSize({ width: 430, height: 760 });
  await waitFor(async () => {
    const bounds = await home.locator(".workspace-phone").boundingBox();
    return bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 430 && bounds.y + bounds.height <= 760;
  }, "floating windows remain reachable after narrowing the viewport");
  await send("close phone");
  assert.equal(await home.locator(".workspace-phone:visible").count(), 0);
  assert.equal(await home.locator(".workspace-settings:visible").count(), 1);
  await home.screenshot({ path: "tests/screenshots/hypeman-floating-tools-mobile.png", fullPage: true });
  await home.setViewportSize({ width: 1540, height: 1100 });
  check("Every tool shares the theme and independent windows stay in bounds on a smaller viewport");

  const article = await context.newPage();
  assert.equal((await article.goto(`${base}/__test/learning/`)).status(), 200);
  await article.bringToFront();
  await article.getByRole("button", { name: /^Open .*\. Drag to move\.$/ }).click();
  await send("Explain missing subtraction visually", article);
  await article.locator(".shared-board .katex").first().waitFor();
  await waitFor(() => article.evaluate(() => [...document.fonts].some(font => font.family === "KaTeX_Main" && font.weight === "400" && font.style === "normal" && font.status === "loaded")), "math fonts registered in the webpage document");
  assert.equal(await article.locator(".shared-board .katex-mathml").count(), 0, "Math uses one visual rendering");
  assert.equal(await article.locator(".shared-board .board-text").filter({ hasText: "Think backwards" }).locator(".katex").count(), 0, "Sentences containing equations remain prose");
  const labels = await article.locator(".shared-board .board-text").evaluateAll(elements => elements.map(element => {
    const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height, text: element.textContent };
  }));
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    const a = labels[i], b = labels[j];
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `Board text must not overlap: ${a.text} / ${b.text}`);
  }
  check("The screenshot's subtraction board renders with math fonts, readable prose, and separated labels inside the webpage overlay");
  assert.ok(await article.locator(".shared-board button").count() > 0);
  assert.equal(await article.locator(".conversation-composer textarea:visible").count(), 1);
  const articleBoard = article.locator(".workspace-board");
  const pageResize = await resizeFromEdge(article, articleBoard, "se", -24, -20);
  assert.ok(pageResize.after.width < pageResize.before.width - 20 && pageResize.after.height < pageResize.before.height - 16, "The live-page shadow-root window resizes too");
  await send("open settings", article);
  const settingsFrame = article.frameLocator('iframe.workspace-settings-frame');
  await settingsFrame.getByRole("button", { name: "Account", exact: true }).click();
  const account = article.locator(".workspace-connection:visible");
  await account.waitFor();
  await article.frameLocator('iframe.workspace-connection-frame').locator("summary").focus();
  const frameResize = await resizeFromEdge(article, account, "se", -24, -20);
  assert.ok(frameResize.after.width < frameResize.before.width - 20 && frameResize.after.height < frameResize.before.height - 16, "A window resizes after interacting with its embedded account frame");
  await article.screenshot({ path: "tests/screenshots/hypeman-page-conversation-board.png", fullPage: true });
  await article.close();
  check("The same conversation and whiteboard shell works beside a live webpage");

  assert.ok(decisions.some((input) => input.surface === "conversation" && input.message === "Explain adding fractions visually"));
  console.log(`\n${checks} conversational workbench browser scenarios passed.`);
} catch (error) {
  console.error("Fixture decisions", JSON.stringify(decisions.map((input) => ({ message: input.message, surface: input.surface, tool: input.toolContext?.activeTool }))));
  if (context) for (const [index, page] of context.pages().entries()) await page.screenshot({ path: `tests/screenshots/workbench-failure-${index}.png`, fullPage: true }).catch(() => {});
  throw error;
} finally { await context?.close(); await gateway.close(); await rm(profile, { recursive: true, force: true }); }
