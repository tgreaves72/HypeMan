import { useCallback, useEffect, useRef, useState } from "react";
import { dueStudyCards, emptyStudy, reviewInterval, STUDY_KEY, type LibraryEntry, type ReviewGrade, type StudyCard, type StudySource, type StudyState, type WorkspaceSnapshot } from "@core";
import { request, subscribe, type BridgeMessage } from "../bridge";
import { NoteCard, Notice } from "./common";
import { message, relativeTime } from "./hooks";
import { useWorkbench } from "./WorkbenchContext";

const date = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
function sourceLink(source: StudySource): string {
  if (source.url) return source.url;
  if (!source.conversationId) return "";
  const params = new URLSearchParams({ conversationId: source.conversationId });
  if (source.documentId) params.set("documentId", source.documentId);
  if (source.page) params.set("page", String(source.page));
  return `${chrome.runtime.getURL("newtab.html")}?${params}${source.documentId ? "#documents" : "#chat"}`;
}
const intervalLabel = (card: StudyCard, grade: ReviewGrade) => {
  const interval = reviewInterval(card, grade);
  return interval.days ? `${interval.days} day${interval.days === 1 ? "" : "s"}` : "10 min";
};
interface Draft { id: string; source: StudySource; prompt: string; answer: string; subject: string; revision?: number }

export function StudyLibrary({ workspace, refresh, search, setSearch, initialView, initialKind, requestRevision, onCreateNote, onDelete, undo }: {
  workspace: WorkspaceSnapshot; refresh: () => Promise<void>; search: string; setSearch: (value: string) => void;
  initialView: "library" | "review"; initialKind: "all" | "note" | "conversation"; requestRevision: number; onCreateNote: () => void;
  onDelete: (note: WorkspaceSnapshot["notes"][number]) => Promise<void>; undo?: () => void;
}) {
  const workbench = useWorkbench();
  const [study, setStudy] = useState<StudyState>(emptyStudy), [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [view, setView] = useState(initialView), [kind, setKind] = useState<"all" | "note" | "conversation">("all"), [subject, setSubject] = useState("");
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null), [busy, setBusy] = useState(false), [session, setSession] = useState<string[] | null>(null), [deleting, setDeleting] = useState<string | null>(null), [sourceRevision, setSourceRevision] = useState(0);
  const [revealed, setRevealed] = useState(false), [answer, setAnswer] = useState(""), [limit, setLimit] = useState(5), [completed, setCompleted] = useState(0), [now, setNow] = useState(Date.now);
  const busyRef = useRef(false), reviewToken = useRef(crypto.randomUUID()), questionRef = useRef<HTMLHeadingElement>(null), ratingRef = useRef<HTMLButtonElement>(null);
  const subjects = [...new Set([...study.assignments.map(item => item.subject), ...study.cards.map(card => card.subject)].filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const due = dueStudyCards(study, now, subject), cards = study.cards.filter(card => !subject || (subject === "__unfiled" ? !card.subject : card.subject === subject)).sort((a, b) => a.dueAt - b.dueAt);
  const card = session?.length ? study.cards.find(item => item.id === session[0] && !item.paused) : undefined;
  const loadStudy = useCallback(async () => { try { setStudy(await request<StudyState>({ type: "study.get" })); } catch (cause) { setError(message(cause)); } }, []);
  useEffect(() => { setView(initialView); setKind(initialKind); }, [initialView, initialKind, requestRevision]);
  useEffect(() => {
    void loadStudy();
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local") return;
      if (changes[STUDY_KEY]) void loadStudy();
    };
    const unsubscribe = subscribe(event => { if (event.type === "conversation.changed") setSourceRevision(value => value + 1); });
    chrome.storage.onChanged.addListener(changed);
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => { chrome.storage.onChanged.removeListener(changed); clearInterval(timer); unsubscribe(); };
  }, [loadStudy]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      void request<LibraryEntry[]>({ type: "library.search", query: search.trim(), subject, kind }).then(result => { if (!cancelled) { setEntries(result); setError(""); } }).catch(cause => { if (!cancelled) setError(message(cause)); }).finally(() => { if (!cancelled) setLoading(false); });
    }, search ? 180 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [search, kind, subject, workspace.notes, study.assignments, sourceRevision]);
  useEffect(() => { if (card) { setRevealed(false); setAnswer(""); reviewToken.current = crypto.randomUUID(); questionRef.current?.focus(); } }, [card?.id]);
  useEffect(() => { if (revealed) ratingRef.current?.focus(); }, [revealed]);
  // Ratings from another window must never silently advance this window's stale session.
  const sessionRevision = useRef<number | null>(null);
  useEffect(() => { if (card?.id) sessionRevision.current = card.revision; }, [card?.id]);
  const mutate = async (input: BridgeMessage, after?: () => void) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try { setStudy(await request<StudyState>(input)); setNow(Date.now()); after?.(); }
    catch (cause) { setError(message(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const begin = () => { setSession(due.slice(0, limit).map(item => item.id)); setCompleted(0); setNotice(""); sessionRevision.current = due[0]?.revision ?? null; };
  const rate = (grade: ReviewGrade) => {
    if (!card || !revealed) return;
    void mutate({ type: "study.rate", id: card.id, revision: sessionRevision.current, reviewId: reviewToken.current, grade }, () => { setSession(previous => previous?.slice(1) || []); setCompleted(value => value + 1); setNotice(`${grade[0].toUpperCase()}${grade.slice(1)} saved. Next review in ${intervalLabel(card, grade)}.`); });
  };
  const createDraft = (entry: LibraryEntry) => { setDraft({ id: crypto.randomUUID(), source: entry.source, prompt: "What should you remember from this source?", answer: entry.text, subject: entry.subject }); setNotice(""); };
  const saveDraft = () => { if (draft) void mutate({ type: draft.revision === undefined ? "study.create" : "study.edit", ...draft }, () => { setDraft(null); setNotice("Review card saved. It is ready in Review."); }); };
  const exit = () => { setSession(null); setRevealed(false); setAnswer(""); setNotice(""); };
  const source = (value: StudySource) => { const link = sourceLink(value); return <div className="study-source">{link ? <a href={link} target="_blank" rel="noreferrer">{value.documentId ? `PDF${value.page ? ` · p. ${value.page}` : ""}` : value.kind === "conversation" ? "Conversation" : "Source"} ↗</a> : <span>Saved source</span>}<span title={value.title}>{value.title}</span></div>; };
  return <div className="study-library">
    <div className="study-heading"><div><p className="study-eyebrow">YOUR STUDY SPACE</p><h2>Keep it. Learn it.</h2></div><span className="study-due-badge">{dueStudyCards(study, now).length} due</span></div>
    <div className="study-tabs" role="tablist" aria-label="Study library views" onKeyDown={event => {
      if (busy || draft || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? "library" : event.key === "End" ? "review" : view === "library" ? "review" : "library";
      setView(next); if (next === "library") exit();
      (event.currentTarget.querySelector(`#study-${next}-tab`) as HTMLButtonElement)?.focus();
    }}><button type="button" role="tab" id="study-library-tab" aria-controls="study-library-panel" aria-selected={view === "library"} tabIndex={view === "library" ? 0 : -1} disabled={busy || !!draft} onClick={() => { setView("library"); exit(); }}>Library</button><button type="button" role="tab" id="study-review-tab" aria-controls="study-review-panel" aria-selected={view === "review"} tabIndex={view === "review" ? 0 : -1} disabled={busy || !!draft} onClick={() => setView("review")}>Review <span>{dueStudyCards(study, now).length}</span></button></div>
    <Notice tone="error">{error}</Notice><Notice>{notice}</Notice>
    {!session && !draft && <label className="study-filter-label">Course or topic<select aria-label="Filter course or topic" value={subject} onChange={event => setSubject(event.target.value)}><option value="">All topics</option><option value="__unfiled">Unfiled</option>{subjects.map(item => <option key={item}>{item}</option>)}</select></label>}
    {!draft && view === "library" && <div id="study-library-panel" role="tabpanel" aria-labelledby="study-library-tab">
      <div className="study-search"><input type="search" className="tool-search" aria-label="Find a note" maxLength={500} placeholder="Search notes and conversations…" value={search} onChange={event => setSearch(event.target.value)} /><button className="button" type="button" onClick={onCreateNote}>New note</button>{undo && <button className="button" type="button" onClick={undo}>Undo delete</button>}</div>
      <div className="study-type-filters" aria-label="Source types">{([['all','All sources'],['note','Notes'],['conversation','Conversations']] as const).map(([value,label]) => <button type="button" key={value} aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>)}</div>
      <p className="study-caption" role="status">{loading ? "Searching your saved work…" : `${entries.length} saved source${entries.length === 1 ? "" : "s"}${entries.length === 100 ? " · Refine your search to see more" : ""}`} · Search stays on this device.</p>
      {!loading && !entries.length && <div className="study-empty"><h3>{search || subject ? "No matching sources" : "Start with something worth remembering"}</h3><p>{search || subject ? "Try a different phrase or topic." : "Save a passage in chat or create a note, then turn it into a review card."}</p></div>}
      <div className="study-entries">{entries.map(entry => {
        const note = workspace.notes.find(item => entry.kind === "note" && item.id === entry.id);
        return <article className="study-entry" key={`${entry.kind}:${entry.id}`}>
          <div className="study-entry-heading"><h3>{entry.title}</h3><span>{entry.kind === "note" ? entry.source.documentId ? "PDF note" : "Note" : "Chat"}</span></div>
          {note ? <NoteCard note={note} compact refresh={refresh} onDelete={onDelete} /> : <><p className="study-excerpt">{entry.text.slice(0, 500)}{entry.text.length > 500 ? "…" : ""}</p>{source(entry.source)}<button type="button" className="study-text-button" onClick={() => workbench.selectContent({ kind: "conversation", id: entry.id, text: entry.text, title: entry.title, conversationId: entry.id })}>Use as context</button></>}
          <div className="study-entry-actions"><SubjectInput key={`${entry.kind}:${entry.id}:${entry.subject}`} entry={entry} subjects={subjects} disabled={busy} save={value => void mutate({ type: "study.assign", source: entry.source, subject: value }, () => setNotice("Course or topic saved."))} /><button type="button" className="button" disabled={busy} onClick={() => createDraft(entry)}>Make review card</button></div>
        </article>;
      })}</div>
    </div>}
    {!draft && view === "review" && <div id="study-review-panel" role="tabpanel" aria-labelledby="study-review-tab">
      {!session && <><div className="study-review-start"><h3>{due.length ? `${due.length} card${due.length === 1 ? "" : "s"} ready for recall` : "You're caught up"}</h3><p>Try recalling the answer before revealing it. Your rating sets the next review.</p><div className="study-session-options"><label>Session size<select aria-label="Review session size" value={limit} onChange={event => setLimit(Number(event.target.value))}>{[5,10,20].map(size => <option value={size} key={size}>{size} cards</option>)}</select></label><button type="button" className="button primary" disabled={!due.length || busy} onClick={begin}>Start review</button></div></div><p className="study-caption">Self-rated practice, not an assessed mastery score. Works without AI.</p>
      {!cards.length && <div className="study-empty"><h3>No review cards yet</h3><p>Open Library and choose Make review card on a saved source.</p><button className="button" type="button" onClick={() => { setView("library"); setSubject(""); }}>Open library</button></div>}
      <div className="study-card-list">{cards.map(item => <article key={item.id} className="study-card-summary"><div><h4>{item.prompt}</h4><p>{item.subject || "Unfiled"} · {item.paused ? "Paused" : item.dueAt <= now ? "Due now" : `Due ${date(item.dueAt)}`}</p></div><div className="tool-actions"><button className="button" type="button" disabled={busy} onClick={() => setDraft({ ...item })}>Edit</button><button className="button" type="button" disabled={busy} onClick={() => void mutate({ type: "study.pause", id: item.id, revision: item.revision, paused: !item.paused })}>{item.paused ? "Resume" : "Pause"}</button><button className="study-text-button" type="button" disabled={busy} onClick={() => setDeleting(item.id)}>Delete</button></div>{deleting === item.id && <div className="study-delete-confirm" role="group" aria-label="Delete review card"><p>Delete this card? Its source stays in your library.</p><button type="button" className="button" disabled={busy} onClick={() => void mutate({ type: "study.remove", id: item.id, revision: item.revision }, () => { setDeleting(null); setNotice("Review card deleted."); })}>Delete card</button><button type="button" className="button" onClick={() => setDeleting(null)}>Keep card</button></div>}</article>)}</div>
      <details className="study-history"><summary>Recent reviews ({study.reviews.length})</summary>{[...study.reviews].reverse().slice(0, 20).map(review => <p key={review.id}>{study.cards.find(item => item.id === review.cardId)?.prompt || "Review card"} · {review.grade} · {relativeTime(review.at)}</p>)}</details></>}
      {session && card && <div className="study-review-card" aria-busy={busy}><div className="study-session-progress"><span role="status">{completed} reviewed · {session.length} remaining</span><button type="button" className="study-text-button" disabled={busy} onClick={exit}>End session</button></div><span className="study-eyebrow">{card.subject || "RECALL PRACTICE"}</span><h3 tabIndex={-1} ref={questionRef}>{card.prompt}</h3><label className="study-recall-input">Your recall (optional)<textarea aria-label="Your recall" rows={3} maxLength={4000} placeholder="Explain it in your own words…" value={answer} onChange={event => setAnswer(event.target.value)} disabled={revealed || busy} /></label>
      {!revealed ? <button type="button" className="button primary" onClick={() => setRevealed(true)}>Reveal answer</button> : <><div className="study-answer"><h4>Saved answer</h4><p>{card.answer}</p>{source(card.source)}<small>Saved {date(card.source.capturedAt)}. Check the source if it has changed.</small></div><p className="study-caption">How well did you recall it without help?</p><div className="study-ratings">{([['again','Again'],['hard','Hard'],['good','Good'],['easy','Easy']] as const).map(([grade,label], index) => <button ref={index === 0 ? ratingRef : undefined} key={grade} className={`study-rating study-rating-${grade}`} type="button" disabled={busy || card.revision !== sessionRevision.current} onClick={() => rate(grade)}><strong>{label}</strong><span>{intervalLabel(card, grade)}</span></button>)}</div></>}
      {card.revision !== sessionRevision.current && <Notice tone="error">This card changed in another window. End the session and restart to use the current version.</Notice>}</div>}
      {session && !card && <div className="study-session-finished" role="status"><span className="study-eyebrow">{session.length ? "QUEUE CHANGED" : "SESSION COMPLETE"}</span><h3>{completed} card{completed === 1 ? "" : "s"} reviewed</h3><p>{session.length ? "This card was paused or deleted in another window. Restart with the current queue." : "Your ratings and next review dates are saved on this device."}</p><button className="button primary" type="button" onClick={exit}>Back to review queue</button></div>}
    </div>}
    {draft && <form className="study-card-editor" aria-label="Review card editor" onSubmit={event => { event.preventDefault(); saveDraft(); }}><h3>{draft.revision === undefined ? "Create a review card" : "Edit review card"}</h3><p>Write a question you can answer from memory. Check the saved answer before adding it.</p><label>Question<textarea aria-label="Review question" autoFocus rows={2} maxLength={500} required value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} /></label><label>Answer<textarea aria-label="Review answer" rows={4} maxLength={6000} required value={draft.answer} onChange={event => setDraft({ ...draft, answer: event.target.value })} /></label><label>Course or topic<input aria-label="Review course or topic" maxLength={80} value={draft.subject} onChange={event => setDraft({ ...draft, subject: event.target.value })} /></label>{source(draft.source)}<div className="tool-actions"><button className="button primary" type="submit" disabled={busy || !draft.prompt.trim() || !draft.answer.trim()}>Save review card</button><button className="button" type="button" disabled={busy} onClick={() => setDraft(null)}>Cancel</button></div></form>}
  </div>;
}
function SubjectInput({ entry, subjects, disabled, save }: { entry: LibraryEntry; subjects: string[]; disabled: boolean; save: (value: string) => void }) {
  const [value, setValue] = useState(entry.subject), listId = `study-topics-${entry.kind}-${entry.id}`;
  return <form className="study-subject-input" onSubmit={event => { event.preventDefault(); if (!disabled && value.trim() !== entry.subject) save(value.trim()); }}><label>Course or topic<input aria-label={`Course or topic: ${entry.title}`} list={listId} maxLength={80} placeholder="e.g. COMP 211" value={value} disabled={disabled} onChange={event => setValue(event.target.value)} /></label><button type="submit" className="study-text-button" disabled={disabled || value.trim() === entry.subject}>Save topic</button><datalist id={listId}>{subjects.map(item => <option value={item} key={item} />)}</datalist></form>;
}
