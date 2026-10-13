import { safePageUrl, type SourceNote } from "./workspace";
import { searchRecall, type RecallConversation } from "./recall";

export const STUDY_KEY = "hypeman.study";
export const STUDY_LIMIT = 1000;
export const STUDY_DAY = 86_400_000;
export const REVIEW_GRADES = ["again", "hard", "good", "easy"] as const;
export type ReviewGrade = typeof REVIEW_GRADES[number];
export interface StudySource {
  kind: "note" | "conversation"; id: string; title: string; url: string;
  conversationId?: string; messageId?: string; documentId?: string; page?: number;
  capturedAt: number;
}
export interface StudyCard {
  id: string; prompt: string; answer: string; subject: string; source: StudySource;
  createdAt: number; updatedAt: number; revision: number; dueAt: number;
  intervalDays: number; repetitions: number; lapses: number; paused: boolean;
}
export interface StudyReview { id: string; cardId: string; grade: ReviewGrade; at: number; dueAt: number }
export interface StudyAssignment { kind: StudySource["kind"]; id: string; subject: string }
export interface StudyState { version: 1; cards: StudyCard[]; assignments: StudyAssignment[]; reviews: StudyReview[] }
export interface LibraryEntry {
  kind: StudySource["kind"]; id: string; title: string; text: string; url: string;
  at: number; subject: string; source: StudySource;
}
export const emptyStudy = (): StudyState => ({ version: 1, cards: [], assignments: [], reviews: [] });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[\w.:-]{1,160}$/.test(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !/[\u0000-\u0008]/.test(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function studySubject(value: unknown): string {
  if (!text(value, 80) || /[\r\n\t]/.test(value) || value.trim() === "__unfiled") throw new Error("Use a course or topic name up to 80 characters.");
  return value.trim();
}
/** Invalid durable data fails visibly rather than silently wiping somebody's cards. */
export function parseStudy(value: unknown): StudyState {
  if (value === undefined) return emptyStudy();
  const fail = (): never => { throw new Error("The study library is invalid. Existing cards were preserved."); };
  if (!record(value) || value.version !== 1 || !Array.isArray(value.cards) || value.cards.length > STUDY_LIMIT || !Array.isArray(value.assignments) || value.assignments.length > STUDY_LIMIT || !Array.isArray(value.reviews) || value.reviews.length > 2000) return fail();
  const result = emptyStudy(), cardIds = new Set<string>(), assignments = new Set<string>(), reviewIds = new Set<string>();
  for (const raw of value.cards) {
    if (!record(raw) || !id(raw.id) || cardIds.has(raw.id) || !text(raw.prompt, 500) || !raw.prompt.trim() || !text(raw.answer, 6000) || !raw.answer.trim() || !text(raw.subject, 80) || !record(raw.source) || !["note", "conversation"].includes(String(raw.source.kind)) || !id(raw.source.id) || !text(raw.source.title, 300) || !text(raw.source.url, 4096) || raw.source.url !== "" && !safePageUrl(raw.source.url) || !integer(raw.source.capturedAt) || !integer(raw.createdAt) || !integer(raw.updatedAt) || !integer(raw.revision) || !integer(raw.dueAt) || !integer(raw.intervalDays) || raw.intervalDays > 365 || !integer(raw.repetitions) || !integer(raw.lapses) || typeof raw.paused !== "boolean") return fail();
    for (const key of ["conversationId", "messageId", "documentId"]) if (raw.source[key] !== undefined && !id(raw.source[key])) return fail();
    if (raw.source.page !== undefined && (!integer(raw.source.page) || raw.source.page < 1)) return fail();
    if (studySubject(raw.subject) !== raw.subject) return fail();
    const source: StudySource = { kind: raw.source.kind as StudySource["kind"], id: raw.source.id, title: raw.source.title, url: raw.source.url, capturedAt: raw.source.capturedAt };
    for (const key of ["conversationId", "messageId", "documentId"] as const) if (typeof raw.source[key] === "string") source[key] = raw.source[key];
    if (typeof raw.source.page === "number") source.page = raw.source.page;
    cardIds.add(raw.id); result.cards.push({ id: raw.id, prompt: raw.prompt, answer: raw.answer, subject: raw.subject, source, createdAt: raw.createdAt, updatedAt: raw.updatedAt, revision: raw.revision, dueAt: raw.dueAt, intervalDays: raw.intervalDays, repetitions: raw.repetitions, lapses: raw.lapses, paused: raw.paused });
  }
  for (const raw of value.assignments) {
    if (!record(raw) || !["note", "conversation"].includes(String(raw.kind)) || !id(raw.id) || !text(raw.subject, 80) || studySubject(raw.subject) !== raw.subject || assignments.has(`${raw.kind}:${raw.id}`)) return fail();
    assignments.add(`${raw.kind}:${raw.id}`); result.assignments.push({ kind: raw.kind as StudySource["kind"], id: raw.id, subject: raw.subject });
  }
  for (const raw of value.reviews) {
    if (!record(raw) || !id(raw.id) || reviewIds.has(raw.id) || !id(raw.cardId) || !REVIEW_GRADES.includes(raw.grade as ReviewGrade) || !integer(raw.at) || !integer(raw.dueAt)) return fail();
    reviewIds.add(raw.id); result.reviews.push({ id: raw.id, cardId: raw.cardId, grade: raw.grade as ReviewGrade, at: raw.at, dueAt: raw.dueAt });
  }
  return result;
}
/** An intentionally simple graduated schedule, not a calibrated mastery estimate. */
export function reviewInterval(card: Pick<StudyCard, "intervalDays" | "repetitions">, grade: ReviewGrade): { days: number; delay: number } {
  if (!REVIEW_GRADES.includes(grade)) throw new Error("Choose Again, Hard, Good, or Easy.");
  if (grade === "again") return { days: 0, delay: 10 * 60_000 };
  const days = Math.min(365, grade === "hard" ? Math.max(1, Math.ceil(card.intervalDays * 1.2)) : grade === "easy" ? Math.max(4, Math.ceil(card.intervalDays * 3)) : card.repetitions === 0 ? 1 : Math.max(3, Math.ceil(card.intervalDays * 2)));
  return { days, delay: days * STUDY_DAY };
}
export function rateStudyCard(state: StudyState, input: { id: string; reviewId: string; revision: number; grade: ReviewGrade }, now: number): StudyState {
  if (!id(input.id) || !id(input.reviewId) || !integer(input.revision) || !integer(now) || !REVIEW_GRADES.includes(input.grade)) throw new Error("Choose a valid review rating.");
  const prior = state.reviews.find(review => review.id === input.reviewId);
  if (prior) {
    if (prior.cardId !== input.id || prior.grade !== input.grade) throw new Error("This review was already saved with a different rating.");
    return state;
  }
  const card = state.cards.find(item => item.id === input.id);
  if (!card || card.paused || card.revision !== input.revision || card.dueAt > now) throw new Error("This card changed or is no longer due. Refresh the review queue.");
  const schedule = reviewInterval(card, input.grade), next = structuredClone(state), saved = next.cards.find(item => item.id === card.id)!;
  Object.assign(saved, { intervalDays: schedule.days, dueAt: now + schedule.delay, updatedAt: now, revision: card.revision + 1, repetitions: input.grade === "again" ? 0 : card.repetitions + 1, lapses: card.lapses + (input.grade === "again" ? 1 : 0) });
  next.reviews = [...next.reviews.slice(-1999), { id: input.reviewId, cardId: card.id, grade: input.grade, at: now, dueAt: saved.dueAt }];
  return next;
}
export function dueStudyCards(state: StudyState, now: number, subject = ""): StudyCard[] {
  return state.cards.filter(card => !card.paused && card.dueAt <= now && (!subject || (subject === "__unfiled" ? !card.subject : card.subject === subject))).sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
/** Search sources locally. Quotes remain actual saved text, never model-generated summaries. */
export function librarySearch(notes: SourceNote[], conversations: RecallConversation[], study: StudyState, query = "", subject = "", kind: "all" | "note" | "conversation" = "all"): LibraryEntry[] {
  if (query.length > 500 || !["all", "note", "conversation"].includes(kind)) throw new Error("Choose valid library filters.");
  const assigned = new Map(study.assignments.map(item => [`${item.kind}:${item.id}`, item.subject]));
  const included = (entryKind: "note" | "conversation", entryId: string) => (kind === "all" || kind === entryKind) && (!subject || (subject === "__unfiled" ? !assigned.get(`${entryKind}:${entryId}`) : assigned.get(`${entryKind}:${entryId}`) === subject));
  notes = notes.filter(note => included("note", note.id));
  conversations = conversations.filter(conversation => included("conversation", conversation.id)).map(conversation => ({ ...conversation, messages: conversation.messages.filter(message => ["user", "assistant"].includes(message.role) && message.text.trim()) }));
  const entries: LibraryEntry[] = notes.map(note => ({ kind: "note", id: note.id, title: note.title || "Saved note", text: note.text, url: note.url, at: note.updatedAt, subject: assigned.get(`note:${note.id}`) || "", source: { kind: "note", id: note.id, title: note.title || "Saved note", url: note.url, capturedAt: note.updatedAt, ...(note.origin ? { conversationId: note.origin.conversationId, ...(note.origin.documentId ? { documentId: note.origin.documentId } : {}), ...(note.origin.page ? { page: note.origin.page } : {}) } : {}) } }));
  const hits = query.trim() ? searchRecall(query, notes, conversations, { limit: 100 }) : [];
  for (const conversation of conversations) {
    const match = hits.find(hit => hit.kind === "conversation" && hit.id === conversation.id);
    const message = match ? conversation.messages.find(item => item.id === match.messageId) : [...conversation.messages].reverse().find(item => item.role === "user" || item.role === "assistant");
    if (!message) continue;
    entries.push({ kind: "conversation", id: conversation.id, title: conversation.title || "Conversation", text: message.text.slice(0, 6000), url: "", at: conversation.updatedAt, subject: assigned.get(`conversation:${conversation.id}`) || "", source: { kind: "conversation", id: conversation.id, title: conversation.title || "Conversation", url: "", conversationId: conversation.id, messageId: message.id, capturedAt: message.at } });
  }
  const scores = new Map(hits.map((hit, index) => [`${hit.kind}:${hit.id}`, hits.length - index]));
  return entries.filter(entry => (kind === "all" || entry.kind === kind) && (!subject || (subject === "__unfiled" ? !entry.subject : entry.subject === subject)) && (!query.trim() || scores.has(`${entry.kind}:${entry.id}`) || entry.subject.toLowerCase().includes(query.trim().toLowerCase())))
    .sort((a, b) => query.trim() ? (scores.get(`${b.kind}:${b.id}`) || 0) - (scores.get(`${a.kind}:${a.id}`) || 0) || b.at - a.at : b.at - a.at).slice(0, 100);
}
