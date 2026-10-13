import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright";

const profile = await mkdtemp(join(tmpdir(), "hypeman-study-"));
await mkdir("tests/screenshots", { recursive: true });
let context, home;
const inference = [], failures = [];
let checks = 0;
const check = name => { checks++; console.log(`✓ ${name}`); };
async function rpc(message, page = home) {
  return page.evaluate(async message => {
    const reply = await chrome.runtime.sendMessage({ ...message, requestId: crypto.randomUUID() });
    if (!reply?.ok) throw new Error(reply?.error || "No extension response");
    return reply.data;
  }, message);
}
async function until(predicate, description) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${description}`);
}
async function send(text) {
  const field = home.getByRole("textbox", { name: "What do you need?", exact: true });
  await field.fill(text); await field.press("Enter");
  await until(async () => await field.inputValue() === "", text);
  await home.getByRole("button", { name: "Send message", exact: true }).waitFor();
}
try {
  const extension = resolve("apps/extension/dist");
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, viewport: { width: 1440, height: 1000 },
    ...(process.env.HYPEMAN_TEST_CHROMIUM ? { executablePath: process.env.HYPEMAN_TEST_CHROMIUM } : {}),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--enable-unsafe-extension-debugging"],
  });
  context.on("request", request => { if (/\/api\/(?:recall\/rank|agent|chatgpt\/responses)/.test(request.url())) inference.push(request.url()); });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  home = await context.newPage(); home.on("pageerror", error => failures.push(error.message));
  await home.goto(`${base}/newtab.html`);
  await rpc({ type: "settings.patch", patch: { onboarded: true, proactiveEnabled: false, reducedMotion: "on" } });
  await context.setOffline(true);
  await rpc({ type: "conversation.open", conversationId: "study-source" });
  await rpc({ type: "conversation.append", conversationId: "study-source", message: { id: "evidence", role: "assistant", text: "Optimistic concurrency rejects writes made against an outdated revision." } });
  const note = await rpc({ type: "note.save", note: { title: "Database concurrency", text: "Compare the current revision before committing a write.", excerpt: "", url: "https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API" } });
  await home.getByRole("button", { name: "Open HypeMan", exact: true }).click();
  await send("open library");
  const library = home.locator(".workspace-notes");
  await library.getByRole("heading", { name: "Keep it. Learn it." }).waitFor();
  const search = library.getByRole("searchbox", { name: "Find a note" });
  await search.fill("outdated");
  await until(async () => await library.locator(".study-entry").count() === 1, "debounced search settles");
  await library.getByText("Optimistic concurrency rejects writes made against an outdated revision.", { exact: true }).waitFor();
  assert.equal(await library.locator(".study-entry").count(), 1);
  check("Offline search returns a saved conversation's actual message");
  await search.fill("Database concurrency");
  const entry = library.locator(".study-entry").filter({ has: home.getByRole("heading", { name: "Database concurrency", exact: true }) });
  await entry.getByRole("heading", { name: "Database concurrency", exact: true }).waitFor();
  await entry.getByLabel("Course or topic: Database concurrency", { exact: true }).fill("COMP 211");
  await entry.getByRole("button", { name: "Save topic" }).click();
  await until(async () => (await rpc({ type: "study.get" })).assignments.some(item => item.subject === "COMP 211"), "topic saved");
  await until(() => entry.getByRole("button", { name: "Save topic" }).isDisabled(), "topic reflected in source");
  await entry.getByRole("button", { name: "Make review card" }).click();
  await library.getByRole("textbox", { name: "Review question", exact: true }).fill("What prevents an outdated write?");
  await library.getByRole("button", { name: "Save review card", exact: true }).click();
  const saved = await until(async () => (await rpc({ type: "study.get" })).cards[0], "card saved");
  assert.equal(saved.source.id, note.id); assert.equal(saved.subject, "COMP 211");
  check("A source-linked card inherits its course label and stays local");
  await library.getByRole("tab", { name: /^Review/ }).click();
  await library.getByRole("button", { name: "Start review" }).click();
  await library.getByRole("heading", { name: "What prevents an outdated write?", exact: true }).waitFor();
  assert.equal(await library.locator(".study-answer").count(), 0);
  await library.getByRole("textbox", { name: "Your recall" }).fill("Compare the saved revision to the current revision.");
  await library.getByRole("button", { name: "Reveal answer" }).click();
  await library.locator(".study-answer").waitFor();
  const contrast = await library.locator(".study-answer p").evaluate(element => {
    const luminance = color => {
      const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => { const unit = value / 255; return unit <= .04045 ? unit / 12.92 : ((unit + .055) / 1.055) ** 2.4; });
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    const foreground = luminance(getComputedStyle(element).color), background = luminance(getComputedStyle(element.parentElement).backgroundColor);
    return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
  });
  assert.ok(contrast >= 4.5, `Saved answer contrast ${contrast.toFixed(1)} must meet 4.5:1`);
  await until(() => library.locator(".study-rating-again").evaluate(element => element === document.activeElement), "rating receives keyboard focus");
  await home.screenshot({ path: "tests/screenshots/hypeman-study-review.png", fullPage: true });
  await library.getByRole("button", { name: "Good 1 day" }).click();
  await library.getByText("SESSION COMPLETE", { exact: true }).waitFor();
  const rated = await rpc({ type: "study.get" });
  assert.equal(rated.reviews.length, 1); assert.equal(rated.cards[0].revision, 1);
  assert.equal(rated.cards[0].dueAt - rated.reviews[0].at, 86400000);
  check("Recall stays hidden until reveal; a rating persists a one-day review date");
  await home.reload();
  await home.getByRole("button", { name: "Open HypeMan", exact: true }).click();
  await send("review cards");
  await library.getByRole("button", { name: "Start review" }).waitFor();
  assert.equal(await library.getByRole("button", { name: "Start review" }).isDisabled(), true);
  assert.equal((await rpc({ type: "study.get" })).reviews.length, 1);
  await library.getByRole("button", { name: "Pause", exact: true }).click();
  await library.getByRole("button", { name: "Resume", exact: true }).waitFor();
  await library.getByRole("button", { name: "Resume", exact: true }).click();
  await library.getByRole("button", { name: "Pause", exact: true }).waitFor();
  check("Reload retains the schedule, review history, and pause/resume controls");
  await library.getByRole("tab", { name: "Library", exact: true }).click();
  await send("review cards");
  await library.getByRole("button", { name: "Start review" }).waitFor();
  await library.getByRole("tab", { name: /^Review/ }).focus();
  await library.getByRole("tab", { name: /^Review/ }).press("ArrowLeft");
  await library.getByRole("searchbox", { name: "Find a note" }).waitFor();
  await library.getByRole("searchbox", { name: "Find a note" }).fill("Database concurrency");
  await library.getByRole("heading", { name: "Database concurrency", exact: true }).waitFor();
  await home.setViewportSize({ width: 360, height: 800 });
  await until(() => library.evaluate(element => element.getBoundingClientRect().width <= 360), "narrow window clamps");
  assert.equal(await library.locator(".inline-tool-body").evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, "narrow content must not overflow horizontally");
  await home.screenshot({ path: "tests/screenshots/hypeman-study-narrow.png", fullPage: true });
  await home.setViewportSize({ width: 1920, height: 1080 });
  await library.getByRole("button", { name: "Maximize Notes" }).click();
  assert.equal(await library.locator(".inline-tool-body").evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
  await home.screenshot({ path: "tests/screenshots/hypeman-study-library.png", fullPage: true });
  check("Library fits a 360px viewport and a maximized 1920px workspace");
  await library.getByRole("tab", { name: /^Review/ }).click();
  await library.getByRole("button", { name: "Edit", exact: true }).click();
  await library.getByRole("textbox", { name: "Review question", exact: true }).fill("How does a revision check protect a write?");
  await library.getByRole("button", { name: "Save review card", exact: true }).click();
  await library.getByRole("heading", { name: "How does a revision check protect a write?", exact: true }).waitFor();
  assert.equal((await rpc({ type: "study.get" })).cards[0].dueAt, rated.cards[0].dueAt);
  await library.getByRole("button", { name: "Delete", exact: true }).click();
  await library.getByRole("button", { name: "Keep card", exact: true }).click();
  assert.equal((await rpc({ type: "study.get" })).cards.length, 1);
  await library.getByRole("button", { name: "Delete", exact: true }).click();
  await library.getByRole("button", { name: "Delete card", exact: true }).click();
  await until(async () => (await rpc({ type: "study.get" })).cards.length === 0, "card deletion saved");
  assert.ok((await rpc({ type: "workspace.get" })).notes.some(item => item.id === note.id));
  check("Repeated chat shortcuts and keyboard tabs work; editing and deleting preserve source work");
  assert.deepEqual(inference, []); assert.deepEqual(failures, []);
  console.log(`\n${checks} offline study browser checks passed.`);
} finally {
  await context?.close();
  assert.equal(dirname(profile), resolve(tmpdir()));
  assert.ok(profile.startsWith(join(resolve(tmpdir()), "hypeman-study-")));
  await rm(profile, { recursive: true, force: true });
}
