import { describe, expect, it } from "vitest";
import { dueStudyCards, emptyStudy, librarySearch, parseStudy, rateStudyCard, reviewInterval, STUDY_DAY, type StudyCard } from "./study";
import type { SourceNote } from "./workspace";
import type { RecallConversation } from "./recall";

const at = 1_700_000_000_000;
const card = (id = "card"): StudyCard => ({ id, prompt: "What keeps this operation safe?", answer: "Check its revision before saving.", subject: "Systems", source: { kind: "note", id: "note", title: "Concurrency", url: "https://example.com/source", capturedAt: at }, createdAt: at, updatedAt: at, dueAt: at, intervalDays: 0, repetitions: 0, lapses: 0, revision: 0, paused: false });
const note = (id: string, text: string): SourceNote => ({ id, title: id, text, excerpt: text, url: "https://example.com", createdAt: at, updatedAt: at });

describe("source-linked spaced review", () => {
  it.each([["again", 0, 600_000], ["hard", 1, STUDY_DAY], ["good", 1, STUDY_DAY], ["easy", 4, 4 * STUDY_DAY]] as const)("schedules a first %s rating", (grade, days, delay) => {
    const initial = { ...emptyStudy(), cards: [card()] };
    const next = rateStudyCard(initial, { id: "card", reviewId: "review", revision: 0, grade }, at);
    expect(next.cards[0]).toMatchObject({ intervalDays: days, dueAt: at + delay, revision: 1, repetitions: grade === "again" ? 0 : 1, lapses: grade === "again" ? 1 : 0 });
    expect(initial.cards[0].revision).toBe(0);
    expect(next.reviews[0]).toEqual({ id: "review", cardId: "card", grade, at, dueAt: at + delay });
  });
  it("graduates successful recall, resets lapses, and caps intervals", () => {
    expect(reviewInterval({ intervalDays: 1, repetitions: 1 }, "good").days).toBe(3);
    expect(reviewInterval({ intervalDays: 3, repetitions: 2 }, "good").days).toBe(6);
    expect(reviewInterval({ intervalDays: 365, repetitions: 10 }, "easy").days).toBe(365);
    expect(reviewInterval({ intervalDays: 60, repetitions: 10 }, "again")).toEqual({ days: 0, delay: 600_000 });
  });
  it("makes retries idempotent and rejects conflicting/stale/early ratings", () => {
    const initial = { ...emptyStudy(), cards: [card()] }, input = { id: "card", reviewId: "review", revision: 0, grade: "good" as const };
    const saved = rateStudyCard(initial, input, at);
    expect(rateStudyCard(saved, input, at + 500)).toBe(saved);
    expect(() => rateStudyCard(saved, { ...input, grade: "easy" }, at)).toThrow("different rating");
    expect(() => rateStudyCard(saved, { ...input, reviewId: "other" }, at)).toThrow("no longer due");
    expect(() => rateStudyCard(saved, { ...input, reviewId: "other", revision: 1 }, at)).toThrow("no longer due");
  });
  it("orders due cards and excludes future, paused and other-topic cards", () => {
    const state = { ...emptyStudy(), cards: [card("b"), { ...card("a"), dueAt: at - 1 }, { ...card("future"), dueAt: at + 1 }, { ...card("paused"), paused: true }, { ...card("unfiled"), subject: "" }] };
    expect(dueStudyCards(state, at, "Systems").map(item => item.id)).toEqual(["a", "b"]);
    expect(dueStudyCards(state, at, "__unfiled").map(item => item.id)).toEqual(["unfiled"]);
  });
  it("rejects malformed durable data without inventing an empty replacement", () => {
    expect(parseStudy(undefined)).toEqual(emptyStudy());
    for (const patch of [{ source: { ...card().source, url: "javascript:alert(1)" } }, { revision: -1 }, { subject: "two\nlines" }, { dueAt: NaN }, { prompt: "" }]) {
      expect(() => parseStudy({ ...emptyStudy(), cards: [{ ...card(), ...patch }] })).toThrow();
    }
    expect(() => parseStudy({ ...emptyStudy(), cards: [card(), card()] })).toThrow("preserved");
    expect(() => parseStudy({ ...emptyStudy(), cards: Array.from({ length: 1001 }, (_, index) => card(String(index))) })).toThrow("preserved");
    const parsed = parseStudy({ ...emptyStudy(), cards: [{ ...card(), injected: "ignored" }] });
    expect(parsed.cards[0]).not.toHaveProperty("injected");
  });
});

describe("local study library search", () => {
  const conversations: RecallConversation[] = [{ id: "chat", title: "Systems chat", updatedAt: at + 1, messages: [{ id: "original", role: "assistant", text: "Optimistic concurrency rejects an outdated revision.", at }, { id: "status", role: "status", text: "revision status", at }, { id: "latest", role: "user", text: "Thanks for the explanation.", at: at + 1 }] }];
  it("returns the actual matching conversation message with its provenance", () => {
    const [result] = librarySearch([], conversations, emptyStudy(), "outdated");
    expect(result.text).toBe(conversations[0].messages[0].text);
    expect(result.source).toMatchObject({ conversationId: "chat", messageId: "original", capturedAt: at });
    expect(librarySearch([], conversations, emptyStudy())[0].source.messageId).toBe("latest");
  });
  it("searches labels and preserves PDF citations", () => {
    const state = { ...emptyStudy(), assignments: [{ kind: "note" as const, id: "n", subject: "COMP 211" }] };
    const source = { ...note("n", "Revision checks"), origin: { kind: "document" as const, conversationId: "chat", documentId: "pdf", page: 3 } };
    expect(librarySearch([source], conversations, state, "COMP 211")[0].source).toMatchObject({ documentId: "pdf", page: 3 });
    expect(librarySearch([source], conversations, state, "", "__unfiled").map(entry => entry.id)).toEqual(["chat"]);
    expect(librarySearch([source], conversations, state, "", "", "note")).toHaveLength(1);
  });
  it("applies course and source filters before limiting ranked results", () => {
    const notes = Array.from({ length: 120 }, (_, index) => note(`n${index}`, "Concurrency revision"));
    const state = { ...emptyStudy(), assignments: [{ kind: "note" as const, id: "n119", subject: "Systems" }] };
    expect(librarySearch(notes, [], state, "revision", "Systems").map(entry => entry.id)).toEqual(["n119"]);
    expect(librarySearch(notes, conversations, state, "outdated", "", "conversation")[0].id).toBe("chat");
  });
});
