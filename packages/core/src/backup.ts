import { parseWorkspace, type CompanionSnapshot } from "./workspace";
import { parseLearningGraph, type LearningGraph } from "./learning";
import { MAX_DOCUMENT_BYTES, type DocumentMetadata } from "./documents";
import { parseBoardDocument } from "./board";
import { parseStudy, type StudyState } from "./study";

export const BACKUP_CHUNK_BYTES = 256 * 1024;
export const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
export interface BackupConversation { id: string; title: string; taskId?: string; messages: { id: string; role: "user" | "assistant" | "status"; text: string; at: number }[]; updatedAt: number }
export interface BackupArtifact { key: string; conversationId: string; kind: string; value: Record<string, unknown> }
export interface WorkspaceBackup {
  format: "hypeman-backup"; version: 1; exportedAt: number;
  workspace: CompanionSnapshot; workbench: { version: 1; conversations: BackupConversation[]; artifacts: BackupArtifact[] };
  learning: LearningGraph; documents: { metadata: DocumentMetadata; sha256: string; data: string }[];
  study?: StudyState;
}
export interface BackupManifest { format: "hypeman-backup"; version: 1; exportedAt: number; counts: { notes: number; tasks: number; conversations: number; artifacts: number; documents: number; plans: number; cards?: number }; includesOriginalPdfs: true; includesCredentials: false; missingOriginalPdfs: string[] }
export interface BackupTransfer { transferId: string; size: number; chunkBytes: number; manifest: BackupManifest }
export interface BackupRestoreResult { restored: BackupManifest["counts"]; skipped: number }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[\w.:-]{1,160}$/.test(value);
const stamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
function safeJson(value: unknown, depth = 0): boolean {
  if (depth > 40) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 100000 && value.every(item => safeJson(item, depth + 1));
  return object(value) && Object.keys(value).every(key => !["__proto__", "prototype", "constructor"].includes(key) && safeJson(value[key], depth + 1));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function backupManifest(backup: WorkspaceBackup): BackupManifest {
  const originals = new Set(backup.documents.map(document => document.metadata.id));
  return { format: backup.format, version: 1, exportedAt: backup.exportedAt, counts: { notes: backup.workspace.notes.length, tasks: backup.workspace.tasks.length, conversations: backup.workbench.conversations.length, artifacts: backup.workbench.artifacts.length, documents: backup.documents.length, plans: backup.learning.plans.length, ...(backup.study ? { cards: backup.study.cards.length } : {}) }, includesOriginalPdfs: true, includesCredentials: false,
    missingOriginalPdfs: [...new Set([...backup.workspace.notes.flatMap(note => note.origin?.documentId && !originals.has(note.origin.documentId) ? [note.origin.documentId] : []), ...(backup.study?.cards.flatMap(card => card.source.documentId && !originals.has(card.source.documentId) ? [card.source.documentId] : []) || [])])] };
}
/** Reject malformed/partial archives before any store changes. Credentials and provider state are never imported. */
export function parseWorkspaceBackup(value: unknown): WorkspaceBackup {
  const fail = (): never => { throw new Error("This is not a complete, valid HypeMan backup. Existing work was preserved."); };
  if (!object(value) || value.format !== "hypeman-backup" || value.version !== 1 || !stamp(value.exportedAt) || !safeJson(value) ||
    !object(value.workspace) || value.workspace.version !== 1 || !Array.isArray(value.workspace.notes) || !Array.isArray(value.workspace.tasks) || !Array.isArray(value.workspace.events) ||
    !object(value.workbench) || value.workbench.version !== 1 || !Array.isArray(value.workbench.conversations) || value.workbench.conversations.length > 5000 || !Array.isArray(value.workbench.artifacts) || value.workbench.artifacts.length > 10000 ||
    !object(value.learning) || value.learning.version !== 1 || !Array.isArray(value.learning.nodes) || !Array.isArray(value.learning.plans) || !Array.isArray(value.learning.seenEvents) || !Array.isArray(value.documents) || value.documents.length > 500) return fail();
  const workspace = parseWorkspace(value.workspace), learning = parseLearningGraph(value.learning);
  if (workspace.notes.length !== value.workspace.notes.length || workspace.tasks.length !== value.workspace.tasks.length || workspace.events.length !== value.workspace.events.length || learning.nodes.length !== value.learning.nodes.length || learning.plans.length !== value.learning.plans.length) return fail();
  // Tolerant local-storage parsers may repair old data; imports must not silently lose text or evidence.
  if (canonical(workspace) !== canonical(value.workspace) || canonical(learning) !== canonical(value.learning)) return fail();
  if (new Set(learning.plans.map(plan => plan.id)).size !== learning.plans.length || value.learning.plans.some((plan, index) => !object(plan) || !id(plan.id) || !Array.isArray(plan.steps) || plan.steps.length !== learning.plans[index].steps.length || !plan.steps.length || learning.plans[index].steps.some(step => !step.title.trim() || !step.concept.trim()))) return fail();
  for (const plan of learning.plans) { const attempts = plan.steps.flatMap(step => step.attempts || []); if (new Set(attempts.map(attempt => attempt.id)).size !== attempts.length) return fail(); }
  const conversations: BackupConversation[] = [];
  for (const raw of value.workbench.conversations) {
    if (!object(raw) || !id(raw.id) || !text(raw.title, 100) || !stamp(raw.updatedAt) || (raw.taskId !== undefined && !id(raw.taskId)) || !Array.isArray(raw.messages) || raw.messages.length > 10000 ||
      !raw.messages.every(message => object(message) && id(message.id) && ["user", "assistant", "status"].includes(String(message.role)) && text(message.text, 16000) && stamp(message.at))) return fail();
    if (conversations.some(item => item.id === raw.id) || new Set(raw.messages.map(message => message.id)).size !== raw.messages.length) return fail();
    conversations.push(raw as unknown as BackupConversation);
  }
  const conversationIds = new Set(conversations.map(item => item.id)), artifacts: BackupArtifact[] = [];
  for (const raw of value.workbench.artifacts) {
    if (!object(raw) || !id(raw.conversationId) || !conversationIds.has(raw.conversationId) || !text(raw.kind, 40) || !/^[a-z-]{1,40}$/.test(raw.kind) || !text(raw.key, 400) ||
      !raw.key.startsWith(`${raw.conversationId}:${raw.kind}:`) || !id(raw.key.slice(`${raw.conversationId}:${raw.kind}:`.length)) || !object(raw.value) || JSON.stringify(raw.value).length > 6000000 || artifacts.some(item => item.key === raw.key) ||
      (raw.kind === "board" && !parseBoardDocument(raw.value))) return fail();
    artifacts.push(raw as unknown as BackupArtifact);
  }
  const documents: WorkspaceBackup["documents"] = [];
  for (const raw of value.documents) {
    if (!object(raw) || !object(raw.metadata)) return fail();
    const meta = raw.metadata;
    if (!id(meta.id) || !id(meta.conversationId) || !conversationIds.has(meta.conversationId) || !text(meta.name, 240) || !meta.name.trim() || !Number.isInteger(meta.size) || Number(meta.size) < 1 || Number(meta.size) > MAX_DOCUMENT_BYTES ||
      !stamp(meta.createdAt) || !["stored", "ready", "locked", "error"].includes(String(meta.status)) || (meta.pageCount !== undefined && (!Number.isInteger(meta.pageCount) || Number(meta.pageCount) < 1 || Number(meta.pageCount) > 100000)) ||
      !text(raw.sha256, 64) || !/^[a-f0-9]{64}$/.test(raw.sha256) || !text(raw.data, Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.data) || documents.some(item => item.metadata.id === meta.id)) return fail();
    const length = raw.data.length / 4 * 3 - (raw.data.endsWith("==") ? 2 : raw.data.endsWith("=") ? 1 : 0);
    if (length !== meta.size) return fail();
    documents.push({ metadata: meta as unknown as DocumentMetadata, sha256: raw.sha256, data: raw.data });
  }
  if (workspace.notes.some(note => note.origin && !conversationIds.has(note.origin.conversationId))) return fail();
  let study: StudyState | undefined;
  try { if (value.study !== undefined) study = parseStudy(value.study); } catch { return fail(); }
  return { format: "hypeman-backup", version: 1, exportedAt: value.exportedAt, workspace, workbench: { version: 1, conversations, artifacts }, learning, documents, ...(study ? { study } : {}) };
}
