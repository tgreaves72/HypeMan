import { describe, expect, it, vi } from "vitest";
import { BACKUP_CHUNK_BYTES, WorkspaceHost, backupManifest, emptyLearningGraph, emptyWorkspace, emptyStudy, parseWorkspaceBackup, type BackupTransfer, type WorkspaceBackup, type LearningGraph, type StudyState } from "@core";
import { BackupService } from "./backup";
import { StudyService } from "./study";
import type { DocumentRepository, StoredDocument } from "./documents";
const bytes = new TextEncoder().encode("%PDF-1.7\noriginal bytes retained\n%%EOF");
function fixture(populated = true, withStudy = false) {
  let studyState: StudyState = emptyStudy();
  let workspace = emptyWorkspace(), learning: LearningGraph = emptyLearningGraph();
  let workbench: WorkspaceBackup["workbench"] = { version: 1, conversations: [], artifacts: [] };
  const documents: StoredDocument[] = [];
  if (populated) {
    workspace.notes.push({ id: "note", title: "Saved analysis", text: "Original evidence", excerpt: "Original evidence", url: "", origin: { kind: "document", conversationId: "chat", documentId: "pdf", page: 1 }, createdAt: 1, updatedAt: 2 });
    workspace.tasks.push({ id: "task", goal: "Practice", status: "running", steps: [{ id: "step", title: "Explain", status: "todo" }], nextStep: "Explain", tabId: 123, lastPage: null, createdAt: 1, updatedAt: 2, conversationId: "chat" }); workspace.activeTaskId = "task";
    learning.plans.push({ id: "plan", goal: "Evidence", createdAt: 1, steps: [{ title: "Practice", concept: "Evidence", exercise: "Give an example.", done: false }] });
    workbench = { version: 1, conversations: [{ id: "chat", title: "PDF practice", updatedAt: 2, messages: [{ id: "message", role: "user", text: "Explain this source", at: 1 }] }], artifacts: [{ key: "chat:notes:default", conversationId: "chat", kind: "notes", value: { text: "Draft in tool window" } }] };
    documents.push({ id: "pdf", conversationId: "chat", name: "source.pdf", size: bytes.length, createdAt: 1, status: "ready", pageCount: 1, blob: new Blob([bytes], { type: "application/pdf" }) });
  }
  const host = new WorkspaceHost({ load: async () => workspace, save: async value => { workspace = value; } });
  const writes = vi.fn();
  if (withStudy && populated) studyState = { version: 1, cards: [{ id: "card", prompt: "Explain the evidence.", answer: "Original evidence", subject: "Research", source: { kind: "note", id: "note", title: "Saved analysis", url: "", conversationId: "chat", documentId: "pdf", page: 1, capturedAt: 2 }, createdAt: 2, updatedAt: 3, revision: 1, dueAt: 86400003, intervalDays: 1, repetitions: 1, lapses: 0, paused: false }], assignments: [{ kind: "note", id: "note", subject: "Research" }], reviews: [{ id: "review", cardId: "card", at: 3, dueAt: 86400003, grade: "good" }] };
  const study = new StudyService({ load: async () => studyState, save: async value => { writes(); studyState = value; }, notes: async () => (await host.snapshot()).notes, conversations: async () => workbench.conversations, now: () => 100 });
  const service = new BackupService({ workspace: () => host.snapshot(), restoreWorkspace: async value => { writes(); return host.restore(value); }, learning: async () => learning, restoreLearning: async value => { writes(); const added = value.plans.filter(plan => !learning.plans.some(item => item.id === plan.id)); learning.plans.push(...added); return added.length; },
    workbench: async message => {
      if (message.type === "workbench.export") return structuredClone(workbench);
      writes(); const incoming = message.value as WorkspaceBackup["workbench"], conversations = incoming.conversations.filter(item => !workbench.conversations.some(saved => saved.id === item.id)), artifacts = incoming.artifacts.filter(item => !workbench.artifacts.some(saved => saved.key === item.key));
      workbench.conversations.push(...conversations); workbench.artifacts.push(...artifacts); return { conversations: conversations.length, artifacts: artifacts.length };
    }, documents: { all: async () => documents, merge: async (incoming: StoredDocument[]) => { writes(); const added = incoming.filter(item => !documents.some(saved => saved.id === item.id)); documents.push(...added); return added.length; } } as unknown as DocumentRepository, ...(withStudy ? { study: () => study.snapshot(), restoreStudy: (value: StudyState) => study.merge(value), preflightStudy: (value: StudyState) => study.preflightMerge(value) } : {}), now: () => 100 });
  return { service, host, documents, writes, study, get workbench() { return workbench; }, get learning() { return learning; } };
}
async function archive(service: BackupService): Promise<{ backup: WorkspaceBackup; text: string }> {
  const transfer = await service.handle({ type: "backup.export" }, "owner") as BackupTransfer, chunks: string[] = [];
  for (let offset = 0; offset < transfer.size; offset += BACKUP_CHUNK_BYTES) chunks.push(atob((await service.handle({ type: "backup.read", transferId: transfer.transferId, offset, length: BACKUP_CHUNK_BYTES }, "owner") as { data: string }).data));
  await service.handle({ type: "backup.cancel", transferId: transfer.transferId }, "owner");
  const text = new TextDecoder().decode(Uint8Array.from(chunks.join(""), char => char.charCodeAt(0)));
  return { backup: JSON.parse(text), text };
}
async function upload(service: BackupService, text: string) {
  const data = new TextEncoder().encode(text), transfer = await service.handle({ type: "backup.restore.begin", size: data.length }, "owner") as { transferId: string };
  for (let index = 0; index * BACKUP_CHUNK_BYTES < data.length; index++) {
    const chunk = data.slice(index * BACKUP_CHUNK_BYTES, (index + 1) * BACKUP_CHUNK_BYTES);
    await service.handle({ type: "backup.restore.chunk", transferId: transfer.transferId, index, data: btoa(String.fromCharCode(...chunk)) }, "owner");
  }
  return transfer.transferId;
}
describe("complete local workspace backup", () => {
  it("roundtrips review schedules, ratings, topics and citations without duplicate cards", async () => {
    const source = fixture(true, true), target = fixture(false, true), { backup, text } = await archive(source.service);
    expect(backupManifest(backup).counts.cards).toBe(1);
    const transferId = await upload(target.service, text);
    expect(await target.service.handle({ type: "backup.restore.complete", transferId }, "owner")).toMatchObject({ restored: { cards: 1 }, skipped: 0 });
    expect(await target.study.snapshot()).toEqual(await source.study.snapshot());
    const retry = await upload(target.service, text);
    expect(await target.service.handle({ type: "backup.restore.complete", transferId: retry }, "owner")).toMatchObject({ restored: { cards: 0 }, skipped: 7 });
  });
  it("rejects an invalid study archive before changing any store", async () => {
    const source = fixture(true, true), target = fixture(false, true), { backup } = await archive(source.service);
    backup.study!.cards[0].source.url = "javascript:alert(1)";
    const transferId = await upload(target.service, JSON.stringify(backup));
    await expect(target.service.handle({ type: "backup.restore.complete", transferId }, "owner")).rejects.toThrow("Existing work was preserved");
    expect(target.writes).not.toHaveBeenCalled();
  });
  it("roundtrips conversations, artifacts, plans and original PDF bytes; deduplicates repeated restore", async () => {
    const source = fixture(), target = fixture(false), { backup, text } = await archive(source.service);
    expect(backupManifest(backup).counts).toEqual({ notes: 1, tasks: 1, conversations: 1, artifacts: 1, plans: 1, documents: 1 });
    let transferId = await upload(target.service, text);
    expect(await target.service.handle({ type: "backup.restore.complete", transferId }, "owner")).toMatchObject({ restored: { notes: 1, tasks: 1, conversations: 1, artifacts: 1, plans: 1, documents: 1 }, skipped: 0 });
    expect(new Uint8Array(await target.documents[0].blob.arrayBuffer())).toEqual(bytes);
    expect(target.workbench.conversations[0].messages[0].text).toBe("Explain this source");
    expect((await target.host.snapshot()).tasks[0]).toMatchObject({ status: "paused", tabId: null });
    expect(target.learning.plans[0].steps[0].exercise).toBe("Give an example.");
    transferId = await upload(target.service, text);
    expect(await target.service.handle({ type: "backup.restore.complete", transferId }, "owner")).toMatchObject({ restored: { notes: 0, tasks: 0, conversations: 0, artifacts: 0, plans: 0, documents: 0 }, skipped: 6 });
  });
  it("retains provenance when a saved note's original PDF was deliberately deleted", async () => {
    const f = fixture(); f.documents.splice(0);
    const { backup } = await archive(f.service);
    expect(parseWorkspaceBackup(backup).workspace.notes[0].origin?.documentId).toBe("pdf");
    expect(backupManifest(backup).missingOriginalPdfs).toEqual(["pdf"]);
  });
  it("validates the complete archive and PDF checksums before any writes", async () => {
    const { backup } = await archive(fixture().service), target = fixture(false);
    backup.documents[0].sha256 = "0".repeat(64);
    const transferId = await upload(target.service, JSON.stringify(backup));
    await expect(target.service.handle({ type: "backup.restore.complete", transferId }, "owner")).rejects.toThrow("checksum");
    expect(target.writes).not.toHaveBeenCalled(); expect(target.documents).toEqual([]);
    expect(() => parseWorkspaceBackup({ ...backup, workbench: { ...backup.workbench, artifacts: [{ ...backup.workbench.artifacts[0], key: "different:notes:default" }] } })).toThrow("valid HypeMan");
    expect(() => parseWorkspaceBackup({ ...backup, workspace: { ...backup.workspace, notes: [{ ...backup.workspace.notes[0], text: "x".repeat(4001) }] } })).toThrow("valid HypeMan");
    expect(() => parseWorkspaceBackup({ ...backup, learning: { ...backup.learning, plans: [...backup.learning.plans, ...backup.learning.plans] } })).toThrow("valid HypeMan");
  });
  it("rejects cross-owner access, changed retries and incomplete transfers", async () => {
    const f = fixture(false), transfer = await f.service.handle({ type: "backup.restore.begin", size: 8 }, "owner") as { transferId: string };
    await expect(f.service.handle({ type: "backup.restore.chunk", ...transfer, index: 0, data: btoa("abcd") }, "other")).rejects.toThrow("another screen");
    const chunk = { type: "backup.restore.chunk", ...transfer, index: 0, data: btoa("abcd") };
    expect(await f.service.handle(chunk, "owner")).toEqual({ received: 4 }); expect(await f.service.handle(chunk, "owner")).toEqual({ received: 4 });
    await expect(f.service.handle({ ...chunk, data: btoa("efgh") }, "owner")).rejects.toThrow("changed");
    await expect(f.service.handle({ type: "backup.restore.complete", ...transfer }, "owner")).rejects.toThrow("incomplete"); expect(f.writes).not.toHaveBeenCalled();
  });
  it("preserves existing IDs instead of replacing their content", async () => {
    const { backup } = await archive(fixture().service), target = fixture();
    backup.workspace.notes[0].text = "Imported old revision"; backup.workbench.conversations[0].messages[0].text = "Old conversation";
    const transferId = await upload(target.service, JSON.stringify(backup)); await target.service.handle({ type: "backup.restore.complete", transferId }, "owner");
    expect((await target.host.snapshot()).notes[0].text).toBe("Original evidence"); expect(target.workbench.conversations[0].messages[0].text).toBe("Explain this source");
  });
});
