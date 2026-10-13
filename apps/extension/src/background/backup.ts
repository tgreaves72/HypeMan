import { BACKUP_CHUNK_BYTES, MAX_BACKUP_BYTES, backupManifest, parseWorkspaceBackup,
  type BackupRestoreResult, type CompanionSnapshot, type LearningGraph, type WorkspaceBackup, type StudyState } from "@core";
import type { DocumentRepository, StoredDocument } from "./documents";

interface Dependencies {
  workspace(): Promise<CompanionSnapshot>;
  restoreWorkspace(value: CompanionSnapshot): Promise<{ notes: number; tasks: number; skipped: number }>;
  workbench(message: Record<string, unknown>): Promise<unknown>;
  learning(): Promise<LearningGraph>;
  restoreLearning(value: LearningGraph): Promise<number>;
  documents: DocumentRepository;
  study?(): Promise<StudyState>;
  restoreStudy?(value: StudyState): Promise<number>;
  preflightStudy?(value: StudyState): Promise<void>;
  now?: () => number;
}
type Transfer = { owner: string; at: number } & ({ kind: "export"; blob: Blob } | { kind: "restore"; size: number; received: number; chunks: Uint8Array[] });
const base64 = (bytes: Uint8Array) => {
  let binary = ""; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
};
const decode = (value: unknown, maximum: number) => {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Invalid backup transfer chunk.");
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
};
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))].map(value => value.toString(16).padStart(2, "0")).join("");
const integer = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/** Local owner-bound transfers keep original PDF bytes out of page-origin storage and provider requests. */
export class BackupService {
  private transfers = new Map<string, Transfer>();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private dependencies: Dependencies) {}
  handle(message: Record<string, unknown>, owner: string): Promise<unknown> {
    const next = this.pending.catch(() => {}).then(() => this.run(message, owner)); this.pending = next; return next;
  }
  private async run(message: Record<string, unknown>, owner: string): Promise<unknown> {
    const api = this.dependencies, now = (api.now || Date.now)();
    for (const [id, transfer] of this.transfers) if (now - transfer.at > 20 * 60000) this.transfers.delete(id);
    const transfer = () => {
      const value = typeof message.transferId === "string" ? this.transfers.get(message.transferId) : undefined;
      if (!value || value.owner !== owner) throw new Error("This backup transfer expired or belongs to another screen. Try again.");
      value.at = now; return value;
    };
    if (message.type === "backup.export") {
      if (this.transfers.size >= 4) throw new Error("Finish or cancel the current backup transfer first.");
      const [workspace, workbench, learning, documents, study] = await Promise.all([api.workspace(), api.workbench({ type: "workbench.export" }), api.learning(), api.documents.all!(), api.study?.()]);
      const saved = workbench as WorkspaceBackup["workbench"];
      const conversations = [...saved.conversations], ids = new Set(conversations.map(item => item.id));
      const referenceIds = [...documents.map(item => item.conversationId), ...saved.artifacts.map(item => item.conversationId), ...workspace.notes.flatMap(note => note.origin ? [note.origin.conversationId] : []), ...workspace.tasks.flatMap(task => task.conversationId ? [task.conversationId] : []), ...(study?.cards.flatMap(card => card.source.conversationId ? [card.source.conversationId] : []) || [])];
      for (const id of referenceIds) if (!ids.has(id)) { conversations.push({ id, title: "Saved work", updatedAt: now, messages: [] }); ids.add(id); }
      const originals: WorkspaceBackup["documents"] = [];
      for (const document of documents) {
        const { blob, ...metadata } = document, bytes = new Uint8Array(await blob.arrayBuffer());
        originals.push({ metadata, sha256: await digest(bytes), data: base64(bytes) });
      }
      const backup: WorkspaceBackup = { format: "hypeman-backup", version: 1, exportedAt: now, workspace, workbench: { version: 1, conversations, artifacts: saved.artifacts }, learning, documents: originals, ...(study ? { study } : {}) };
      parseWorkspaceBackup(backup);
      const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
      if (blob.size > MAX_BACKUP_BYTES) throw new Error("This backup exceeds 128 MiB. Export large PDF originals separately before retrying.");
      const transferId = crypto.randomUUID(); this.transfers.set(transferId, { kind: "export", owner, at: now, blob });
      return { transferId, size: blob.size, chunkBytes: BACKUP_CHUNK_BYTES, manifest: backupManifest(backup) };
    }
    if (message.type === "backup.read") {
      const value = transfer();
      if (value.kind !== "export" || !integer(message.offset, 0, value.blob.size) || !integer(message.length, 1, BACKUP_CHUNK_BYTES)) throw new Error("Invalid backup read range.");
      return { data: base64(new Uint8Array(await value.blob.slice(message.offset, message.offset + message.length).arrayBuffer())), offset: message.offset, total: value.blob.size };
    }
    if (message.type === "backup.cancel") { transfer(); this.transfers.delete(String(message.transferId)); return { ok: true }; }
    if (message.type === "backup.restore.begin") {
      if (this.transfers.size >= 4 || !integer(message.size, 1, MAX_BACKUP_BYTES)) throw new Error("Choose a complete HypeMan backup up to 128 MiB.");
      const transferId = crypto.randomUUID(); this.transfers.set(transferId, { kind: "restore", owner, at: now, size: message.size, received: 0, chunks: [] });
      return { transferId, chunkBytes: BACKUP_CHUNK_BYTES };
    }
    if (message.type === "backup.restore.chunk") {
      const value = transfer();
      if (value.kind !== "restore" || !integer(message.index, 0, Math.ceil(MAX_BACKUP_BYTES / BACKUP_CHUNK_BYTES))) throw new Error("Invalid backup transfer.");
      const bytes = decode(message.data, BACKUP_CHUNK_BYTES);
      if (!bytes.length) throw new Error("Empty backup transfer chunk.");
      if (message.index < value.chunks.length) {
        if (base64(value.chunks[message.index]) !== message.data) throw new Error("A backup chunk changed during transfer.");
        return { received: value.received };
      }
      if (message.index !== value.chunks.length || value.received + bytes.length > value.size) throw new Error("The backup transfer is incomplete or out of order.");
      value.chunks.push(bytes); value.received += bytes.length; return { received: value.received };
    }
    if (message.type !== "backup.restore.complete") throw new Error("Unknown backup operation.");
    const value = transfer();
    if (value.kind !== "restore" || value.received !== value.size) throw new Error("The backup transfer is incomplete.");
    let backup: WorkspaceBackup;
    try { backup = parseWorkspaceBackup(JSON.parse(await new Blob(value.chunks as Uint8Array<ArrayBuffer>[]).text())); }
    catch { throw new Error("The backup is invalid or incomplete. Existing work was preserved."); }
    const documents: StoredDocument[] = [];
    for (const original of backup.documents) {
      const bytes = decode(original.data, original.metadata.size);
      if (await digest(bytes) !== original.sha256 || !new TextDecoder().decode(bytes.slice(0, 1024)).includes("%PDF-")) throw new Error("A PDF original failed its checksum. Existing work was preserved.");
      documents.push({ ...original.metadata, blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }) });
    }
    const [existing, learning] = await Promise.all([api.workspace(), api.learning()]);
    if (backup.study) {
      if (!api.restoreStudy || !api.preflightStudy) throw new Error("Update HypeMan before restoring this study library.");
      await api.preflightStudy(backup.study);
    }
    if (existing.notes.length + backup.workspace.notes.filter(note => !existing.notes.some(item => item.id === note.id)).length > 500 || existing.tasks.length + backup.workspace.tasks.filter(task => !existing.tasks.some(item => item.id === task.id)).length > 100 || existing.events.length + backup.workspace.events.filter(event => !existing.events.some(item => item.id === event.id)).length > 1000 || learning.plans.length + backup.learning.plans.filter(plan => !learning.plans.some(item => item.id === plan.id)).length > 40 || learning.nodes.length + backup.learning.nodes.filter(node => !learning.nodes.some(item => item.id === node.id)).length > 1000) throw new Error("Restore exceeds local saved-work limits. Existing work was preserved.");
    // Merge-only writes never overwrite existing IDs. If a store fails, retry safely resumes deduplicated imports.
    try {
      const workbench = await api.workbench({ type: "workbench.restore", value: backup.workbench }) as { conversations: number; artifacts: number };
      const documentCount = await api.documents.merge!(documents), workspace = await api.restoreWorkspace(backup.workspace), plans = await api.restoreLearning(backup.learning);
      const cards = backup.study ? await api.restoreStudy!(backup.study) : undefined;
      const restored = { notes: workspace.notes, tasks: workspace.tasks, conversations: workbench.conversations, artifacts: workbench.artifacts, documents: documentCount, plans, ...(cards === undefined ? {} : { cards }) };
      const result: BackupRestoreResult = { restored, skipped: Object.values(backupManifest(backup).counts).reduce((sum, count) => sum + count, 0) - Object.values(restored).reduce((sum, count) => sum + count, 0) };
      this.transfers.delete(String(message.transferId)); return result;
    } catch { throw new Error("Restore did not finish. Existing work is safe; retry this backup to resume without duplicates."); }
  }
}
