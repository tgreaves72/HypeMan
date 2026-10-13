import { describe, expect, it, vi } from "vitest";
import { emptyStudy, type SourceNote, type StudyState } from "@core";
import { StudyService } from "./study";

function fixture() {
  let state: StudyState | undefined, now = 1_700_000_000_000;
  const notes: SourceNote[] = [{ id: "note", title: "Verified source", text: "Use revision checks.", excerpt: "", url: "https://example.com/source", createdAt: 1, updatedAt: 2 }];
  const save = vi.fn(async (next: StudyState) => { state = structuredClone(next); });
  const service = new StudyService({ load: async () => structuredClone(state), save, notes: async () => notes, conversations: async () => [], now: () => now });
  const create = (id = "card") => service.handle({ type: "study.create", id, source: { kind: "note", id: "note", title: "Forged title", url: "https://fake.com", capturedAt: 2 }, prompt: "What prevents lost updates?", answer: "Revision checks.", subject: "Systems" });
  return { service, save, notes, create, advance: (ms: number) => { now += ms; }, get state() { return state; } };
}
describe("single-writer study persistence", () => {
  it("serializes creates, deduplicates retries and verifies source metadata", async () => {
    const f = fixture(); await Promise.all([f.create(), f.create(), f.create("other")]);
    expect(f.state?.cards).toHaveLength(2);
    expect(f.state?.cards[0].source).toMatchObject({ title: "Verified source", url: "https://example.com/source", capturedAt: 2 });
    expect(f.save).toHaveBeenCalledTimes(2);
    f.notes.splice(0); await f.create();
    expect(f.state?.cards).toHaveLength(2);
  });
  it("rejects fake or changed sources before saving", async () => {
    const f = fixture(); f.notes[0].updatedAt = 3;
    await expect(f.create()).rejects.toThrow("source changed");
    f.notes.splice(0); await expect(f.create()).rejects.toThrow("no longer saved");
    expect(f.save).not.toHaveBeenCalled();
  });
  it("accepts one competing rating and rejects a stale second window", async () => {
    const f = fixture(); await f.create();
    const rating = { type: "study.rate", id: "card", revision: 0, grade: "good", reviewId: "first" };
    const results = await Promise.allSettled([f.service.handle(rating), f.service.handle({ ...rating, grade: "easy", reviewId: "second" })]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    await f.service.handle(rating); expect(f.state?.reviews).toHaveLength(1);
    expect(f.state?.cards[0].revision).toBe(1);
  });
  it("edits answers without resetting a saved schedule, and pauses/resumes/deletes explicitly", async () => {
    const f = fixture(); await f.create();
    await f.service.handle({ type: "study.rate", id: "card", revision: 0, grade: "good", reviewId: "r" });
    const scheduled = f.state!.cards[0].dueAt;
    await f.service.handle({ type: "study.edit", id: "card", revision: 1, prompt: "Explain the check.", answer: "Compare the current revision.", subject: "Databases" });
    expect(f.state?.cards[0]).toMatchObject({ revision: 2, dueAt: scheduled, intervalDays: 1 });
    await f.service.handle({ type: "study.pause", id: "card", revision: 2, paused: true });
    await expect(f.service.handle({ type: "study.edit", id: "card", revision: 2, prompt: "Stale", answer: "Stale", subject: "" })).rejects.toThrow("another window");
    await f.service.handle({ type: "study.pause", id: "card", revision: 3, paused: false });
    await f.service.handle({ type: "study.remove", id: "card", revision: 4 });
    expect(f.state?.cards).toEqual([]); expect(f.notes).toHaveLength(1);
  });
  it("preserves data on storage failure and allows the queue to recover", async () => {
    const f = fixture(); await f.create();
    f.save.mockRejectedValueOnce(new Error("Storage full"));
    await expect(f.service.handle({ type: "study.rate", id: "card", revision: 0, grade: "good", reviewId: "r" })).rejects.toThrow("Storage full");
    expect(f.state?.cards[0].revision).toBe(0);
    await f.service.handle({ type: "study.rate", id: "card", revision: 0, grade: "good", reviewId: "r" });
    expect(f.state?.cards[0].revision).toBe(1);
  });
  it("merges backups without overwriting existing review schedules or labels", async () => {
    const f = fixture(); await f.create();
    const old = await f.service.snapshot();
    await f.service.handle({ type: "study.assign", source: { kind: "note", id: "note" }, subject: "New topic" });
    await f.service.handle({ type: "study.rate", id: "card", revision: 0, grade: "easy", reviewId: "r" });
    old.assignments.push({ kind: "note", id: "note", subject: "Old topic" });
    expect(await f.service.merge(old)).toBe(0);
    expect(f.state?.cards[0].intervalDays).toBe(4);
    expect(f.state?.assignments[0].subject).toBe("New topic");
    expect(await f.service.merge(emptyStudy())).toBe(0);
  });
});
