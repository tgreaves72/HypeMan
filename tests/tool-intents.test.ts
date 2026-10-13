import { describe, expect, it } from "vitest";
import { toolIntent } from "../apps/extension/src/ui/tool-intents";
import { phoneMessageText, phoneReview } from "../apps/extension/src/ui/phone-review";
import { documentBatches, documentQuestionPages, pageList } from "../apps/extension/src/ui/document-analysis";

describe("shortcuts preserve complete requests", () => {
  it("opens the library and review queue locally while preserving compound requests", () => {
    expect(toolIntent("open study library", null, null)).toMatchObject({ tool: "notes", operation: "open" });
    expect(toolIntent("review my cards", null, null)).toMatchObject({ tool: "notes", operation: "review" });
    expect(toolIntent("show flashcards", null, null)).toMatchObject({ tool: "notes", operation: "review" });
    expect(toolIntent("find my notes about revisions", null, null)).toMatchObject({ tool: "notes", operation: "find", args: { query: "revisions", kind: "note" } });
    expect(toolIntent("review cards then explain my mistakes", null, null)).toBeNull();
  });
  it.each(["Save this and text it to me", "Remember this, then draw an explanation", "Make a study plan and save it", "Summarize this video https://youtu.be/aB3dE5gH7_j and create a note"])("leaves %s to the planner", (request) => expect(toolIntent(request, null, null)).toBeNull());
  it("keeps literal saved content and exact single tool actions simple", () => {
    expect(toolIntent("Save salt and pepper", null, null)).toMatchObject({ tool: "notes", operation: "save", args: { text: "salt and pepper" } });
    expect(toolIntent('Save "then draw the rest"', null, null)).toMatchObject({ operation: "save" });
    expect(toolIntent("Save this board", "board", null)).toMatchObject({ tool: "board", operation: "export" });
  });
  it("summarizes a linked video rather than merely opening its window", () => expect(toolIntent("Summarize video https://youtu.be/aB3dE5gH7_j", null, null)).toMatchObject({ tool: "video", operation: "summarize", args: { url: "https://youtu.be/aB3dE5gH7_j" } }));
});
describe("exact phone review", () => {
  it("includes the exact outgoing payload, source and masked recipient", () => {
    const selected = { kind: "note", id: "note-1", text: "Saved text", url: "https://example.com/source" };
    const payload = phoneMessageText("send", {}, selected);
    expect(phoneReview("send", {}, selected, "+15550000142")).toBe(`Send one text to •••• 0142?\n\n${payload}`);
    expect(payload).toContain("Source: https://example.com/source");
  });
});
describe("PDF page accounting", () => {
  const pages = Array.from({ length: 27 }, (_, index) => ({ documentId: "pdf", page: index + 1, text: index === 26 ? "The final result discusses photosynthesis." : "Opening ideas. ".repeat(2000), truncated: false, method: "embedded" as const }));
  it("finds a relevant ending instead of assuming the current page is the answer", () => expect(documentQuestionPages(pages, "What is the photosynthesis result?", 1)).toEqual([27]));
  it("stages every readable physical page without silently dropping context after the size limit", () => {
    const batches = documentBatches(pages);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((page) => page.page)).toEqual(pages.map((page) => page.page));
    expect(batches.every((batch) => batch.length <= 20 && batch.reduce((size, page) => size + page.text.length, 0) <= 80000)).toBe(true);
  });
  it("keeps coverage labels concise", () => expect(pageList([1, 2, 3, 6, 8, 9])).toBe("1–3, 6, 8–9"));
});
