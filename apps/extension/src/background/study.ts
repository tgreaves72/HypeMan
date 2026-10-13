import { librarySearch, parseStudy, rateStudyCard, studySubject, STUDY_LIMIT, type ReviewGrade, type StudySource, type StudyState, type SourceNote, type RecallConversation } from "@core";

interface StudyDependencies {
  load(): Promise<unknown>; save(state: StudyState): Promise<void>;
  notes(): Promise<SourceNote[]>; conversations(): Promise<RecallConversation[]>;
  now?: () => number;
}
/** One durable writer serializes edits and ratings from every open tab. */
export class StudyService {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private api: StudyDependencies) {}
  snapshot(): Promise<StudyState> { return this.enqueue(async () => parseStudy(await this.api.load())); }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next;
  }
  async search(message: Record<string, unknown>) {
    if (message.query !== undefined && typeof message.query !== "string" || message.subject !== undefined && typeof message.subject !== "string" || message.kind !== undefined && !["all", "note", "conversation"].includes(String(message.kind))) throw new Error("Choose valid library filters.");
    const [notes, conversations, study] = await Promise.all([this.api.notes(), this.api.conversations(), this.snapshot()]);
    return librarySearch(notes, conversations, study, message.query as string || "", message.subject as string || "", message.kind as "all" | "note" | "conversation" || "all");
  }
  async preflightMerge(value: StudyState): Promise<void> {
    const current = await this.snapshot();
    if (current.cards.length + value.cards.filter(card => !current.cards.some(item => item.id === card.id)).length > STUDY_LIMIT || current.assignments.length + value.assignments.filter(entry => !current.assignments.some(item => item.id === entry.id && item.kind === entry.kind)).length > STUDY_LIMIT) throw new Error("Restore exceeds the study library limit. Existing cards were preserved.");
  }
  merge(value: StudyState): Promise<number> {
    return this.enqueue(async () => {
      const incoming = parseStudy(value), current = parseStudy(await this.api.load()), added = incoming.cards.filter(card => !current.cards.some(item => item.id === card.id));
      const assignments = incoming.assignments.filter(entry => !current.assignments.some(item => item.id === entry.id && item.kind === entry.kind));
      if (current.cards.length + added.length > STUDY_LIMIT || current.assignments.length + assignments.length > STUDY_LIMIT) throw new Error("Restore exceeds the study library limit.");
      const next = parseStudy({ ...current, cards: [...current.cards, ...added], assignments: [...current.assignments, ...assignments], reviews: [...current.reviews, ...incoming.reviews.filter(review => !current.reviews.some(item => item.id === review.id))].slice(-2000) });
      await this.api.save(next); return added.length;
    });
  }
  handle(message: Record<string, unknown>): Promise<StudyState> {
    return this.enqueue(async () => {
      const state = parseStudy(await this.api.load()), now = (this.api.now || Date.now)();
      if (message.type === "study.get") return state;
      if (message.type === "study.rate") {
        const next = rateStudyCard(state, { id: message.id as string, reviewId: message.reviewId as string, revision: message.revision as number, grade: message.grade as ReviewGrade }, now);
        if (next !== state) await this.api.save(next); return next;
      }
      if (message.type === "study.assign") {
        const source = await this.source(message);
        const subject = studySubject(message.subject), previous = state.assignments.find(entry => entry.kind === source.kind && entry.id === source.id);
        if (!previous && subject && state.assignments.length >= STUDY_LIMIT) throw new Error("The library supports up to 1,000 course labels.");
        state.assignments = state.assignments.filter(entry => entry.kind !== source.kind || entry.id !== source.id);
        if (subject) state.assignments.push({ kind: source.kind, id: source.id, subject });
        await this.api.save(state); return state;
      }
      if (message.type === "study.create" || message.type === "study.edit") {
        if (typeof message.prompt !== "string" || !message.prompt.trim() || message.prompt.length > 500 || typeof message.answer !== "string" || !message.answer.trim() || message.answer.length > 6000) throw new Error("Add a question up to 500 characters and an answer up to 6,000 characters.");
        const subject = studySubject(message.subject);
        if (message.type === "study.edit") {
          const card = state.cards.find(item => item.id === message.id);
          if (!card || card.revision !== message.revision) throw new Error("This card changed in another window. Reopen it to edit.");
          Object.assign(card, { prompt: message.prompt.trim(), answer: message.answer.trim(), subject, revision: card.revision + 1, updatedAt: now });
        } else {
          // Duplicate clicks/retries create one card. Its identity comes from the UI's operation ID.
          if (typeof message.id !== "string" || !/^[\w.:-]{1,160}$/.test(message.id)) throw new Error("Choose a valid card identity.");
          const prior = state.cards.find(card => card.id === message.id);
          if (prior) {
            if (prior.prompt !== message.prompt.trim() || prior.answer !== message.answer.trim() || prior.subject !== subject) throw new Error("That card was already saved. Reopen it to edit.");
            return state;
          }
          if (state.cards.length >= STUDY_LIMIT) throw new Error("The study library supports up to 1,000 review cards.");
          const source = await this.source(message);
          if ((message.source as Record<string, unknown>).capturedAt !== source.capturedAt) throw new Error("That source changed. Reopen it in the library before creating a card.");
          state.cards.push({ id: message.id, prompt: message.prompt.trim(), answer: message.answer.trim(), subject, source, createdAt: now, updatedAt: now, revision: 0, dueAt: now, intervalDays: 0, repetitions: 0, lapses: 0, paused: false });
        }
        await this.api.save(parseStudy(state)); return state;
      }
      if (message.type === "study.pause") {
        const card = state.cards.find(item => item.id === message.id);
        if (!card || card.revision !== message.revision || typeof message.paused !== "boolean") throw new Error("This card changed. Refresh before pausing or resuming it.");
        card.paused = message.paused; card.revision++; card.updatedAt = now;
        await this.api.save(state); return state;
      }
      if (message.type === "study.remove") {
        const card = state.cards.find(item => item.id === message.id);
        if (!card || card.revision !== message.revision) throw new Error("This card changed. Refresh before deleting it.");
        state.cards = state.cards.filter(item => item.id !== card.id);
        await this.api.save(state); return state;
      }
      throw new Error("Unknown study operation.");
    });
  }
  private async source(message: Record<string, unknown>): Promise<StudySource> {
    const entry = message.source;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Choose an actual saved source.");
    const ref = entry as Record<string, unknown>;
    if (typeof ref.id !== "string") throw new Error("Choose an actual saved source.");
    if (ref.kind === "note") {
      const note = (await this.api.notes()).find(item => item.id === ref.id);
      if (note) return { kind: "note", id: note.id, title: note.title || "Saved note", url: note.url, capturedAt: note.updatedAt, ...(note.origin ? { conversationId: note.origin.conversationId, ...(note.origin.documentId ? { documentId: note.origin.documentId } : {}), ...(note.origin.page ? { page: note.origin.page } : {}) } : {}) };
    }
    if (ref.kind === "conversation") {
      const conversation = (await this.api.conversations()).find(item => item.id === ref.id);
      const saved = conversation?.messages.find(item => item.id === ref.messageId && ["user", "assistant"].includes(item.role));
      if (conversation && saved) return { kind: "conversation", id: conversation.id, title: conversation.title, url: "", conversationId: conversation.id, messageId: saved.id, capturedAt: saved.at };
    }
    throw new Error("That source is no longer saved. Choose another source.");
  }
}
