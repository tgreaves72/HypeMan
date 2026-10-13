import { useEffect, useRef, useState } from "react";
import { AVATAR_SKINS, currentLearningStep, emptyLearningGraph, learningEstimate, type AgentReply, type Health, type LearningGraph, type LearningPlan, type Settings, type SourceNote, type RecallHit } from "@core";
import { request } from "../bridge";
import { Empty, Notice, TaskCard, Toggle, ToolButton } from "./common";
import { exportWorkspace, host, message, relativeTime, setScreenshotAccess, useSettings, useWorkspace } from "./hooks";
import { useToolHandler, useWorkbench } from "./WorkbenchContext";
import { ChatGPTConnection } from "./ChatGPTConnection";
import { Messaging } from "./Messaging";
import type { IconName } from "./Icon";
import { calculateTable, downloadTable } from "./table-export";
import { restoreWorkspaceBackup } from "./workspace-backup";
import { StudyLibrary } from "./StudyLibrary";
export type CompanionSection = "tasks" | "notes" | "activity" | "settings" | "learning";
export const companionSections: { section: CompanionSection; icon: IconName; label: string }[] = [
  { section: "tasks", icon: "task", label: "Projects" }, { section: "notes", icon: "notes", label: "Notes" },
  { section: "activity", icon: "rewind", label: "Recent actions" }, { section: "settings", icon: "settings", label: "Preferences" },
  { section: "learning", icon: "learn", label: "Practice" },
];
export function CompanionTools({ section, onError, embedded = false }: { section: CompanionSection; onClose: () => void; onError?: (error: string) => void; onStartTask?: () => void; onSectionChange?: (section: CompanionSection) => void; embedded?: boolean }) {
  const { workspace, refresh, error, loading } = useWorkspace();
  const { settings, patch, error: settingsError } = useSettings();
  const workbench = useWorkbench();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [libraryView, setLibraryView] = useState<"library" | "review">("library");
  const [libraryKind, setLibraryKind] = useState<"all" | "note" | "conversation">("all"), [libraryRequest, setLibraryRequest] = useState(0);
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false), [newText, setNewText] = useState("");
  const [permission, setPermission] = useState<"capture" | "input" | null>(null);
  const removed = useRef<SourceNote | null>(null);
  const extensionPage = location.protocol === "chrome-extension:";
  const fail = (cause: unknown) => { const value = message(cause); setNotice(value); onError?.(value); };
  const edit = (changes: Partial<Settings>) => void patch(changes).then(() => setNotice("")).catch(fail);
  const resolveId = (args: Record<string, unknown>, kind: string) => typeof args.id === "string" ? args.id : workbench.selected?.kind === kind ? workbench.selected.id : "";
  useToolHandler(section === "tasks" ? "projects" : null, async (operation, args) => {
    if (operation === "open") return "Select a project and ask to continue, pause, cancel, or text it.";
    if (operation === "filter") { setFilter(String(args.status || args.filter || "all")); return "Projects filtered."; }
    const id = resolveId(args, "project") || workspace.activeTaskId;
    if (!id) throw new Error("Select a project first.");
    if (operation === "done") { const task = workspace.tasks.find((item) => item.id === id); const step = task?.steps.find((item) => item.status !== "done"); if (!task || !step) throw new Error("That project has no unfinished step."); await request({ type: "task.step.confirm", taskId: task.id, stepId: step.id }); await refresh(); return "Current step marked complete by you."; }
    if (!["pause", "resume", "cancel"].includes(operation)) throw new Error("That project action is unavailable.");
    await request({ type: operation === "resume" && !extensionPage ? "task.follow" : `task.${operation}`, id });
    await refresh(); return operation === "resume" ? "Continuing the project." : operation === "pause" ? "Project paused." : "Project cancelled.";
  });
  useToolHandler(section === "notes" ? "notes" : null, async (operation, args) => {
    if (["open", "find", "review"].includes(operation)) {
      setLibraryRequest(value => value + 1);
      setLibraryView(operation === "review" ? "review" : "library");
      setLibraryKind(operation === "find" && (args.kind === "note" || args.kind === "conversation") ? args.kind : "all");
    }
    if (operation === "review") return "Review your saved cards. Reveal each answer and rate your own recall to schedule the next review.";
    if (operation === "find" && typeof args.id === "string") {
      const kind = args.kind === "conversation" ? "conversation" : "note";
      const source = await request<SourceNote | { id: string; title: string; messages: { id: string; role: string; text: string }[] } | null>({ type: "recall.get", kind, id: args.id });
      if (!source) throw new Error("That saved source is unavailable.");
      if ("messages" in source && typeof args.messageId !== "string") return { message: `Saved conversation: ${source.title}`, changed: false, data: { kind, id: source.id, title: source.title, messages: source.messages.map((item) => ({ id: item.id, role: item.role, preview: item.text.slice(0, 200) })), instruction: "Use this source ID and a messageId to read the actual message." } };
      const text = "messages" in source ? source.messages.find((item) => item.id === args.messageId)?.text : source.text;
      if (text === undefined) throw new Error("That saved message is unavailable.");
      const offset = args.offset === undefined ? 0 : Number(args.offset);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new Error("Choose a valid source offset.");
      const excerpt = text.slice(offset, offset + 6000), nextOffset = offset + excerpt.length;
      return { message: `Read saved source: ${source.title}`, changed: false, data: { kind, id: source.id, title: source.title, ...("url" in source ? { url: source.url } : {}), ...(args.messageId ? { messageId: args.messageId } : {}), text: excerpt, offset, totalChars: text.length, truncated: nextOffset < text.length, ...(nextOffset < text.length ? { nextOffset } : {}) } };
    }
    if (operation === "open" || operation === "find") {
      const query = String(args.query || args.text || "").trim(); setSearch(query);
      if (!query) return "Your study library is ready. Browse sources or open Review for spaced practice.";
      const hits = await request<RecallHit[]>({ type: "recall.search", query, limit: 10, ...(args.kind === "note" || args.kind === "conversation" ? { kinds: [args.kind] } : {}) });
      return { message: hits.length ? `${hits.length} saved sources found.` : "No saved source matched that request.", changed: false, data: { query, hits } };
    }
    if (operation === "export") {
      const table = calculateTable(args); downloadTable(table);
      return { message: `${table.filename} downloaded.`, changed: true, data: { filename: table.filename, columns: table.columns, rows: table.rows, format: "csv" } };
    }
    if (operation === "undo") { if (!removed.current) throw new Error("There is no deleted note to restore."); const { id: _id, ...restored } = removed.current; await request({ type: "note.save", note: restored }); removed.current = null; await refresh(); return "Note restored."; }
    const id = resolveId(args, "note");
    const note = workspace.notes.find((item) => item.id === id);
    if (operation === "delete") { if (!note) throw new Error("Select the note to delete."); await request({ type: "note.remove", id: note.id }); removed.current = note; await refresh(); return "Note deleted. Say undo to restore it."; }
    if (operation === "save") {
      const text = String(args.text || workbench.selected?.text || "").trim();
      if (!text) throw new Error("Select text or say what to save.");
      const saved = await request<SourceNote>({ type: "note.save", note: { ...(note || {}), text, excerpt: String(args.excerpt || workbench.selected?.text || ""), url: String(args.url || workbench.selected?.url || ""), title: String(args.title || workbench.selected?.title || "Conversation note"), origin: { kind: workbench.selected?.artifactId ? "document" : "conversation", conversationId: workbench.conversationId, ...(workbench.selected?.artifactId ? { documentId: workbench.selected.artifactId, page: workbench.selected.page } : {}) } } });
      await refresh(); return { message: "Note saved.", changed: true, data: saved };
    }
    throw new Error("That note action is unavailable.");
  });
  useToolHandler(section === "activity" ? "activity" : null, async () => `${workspace.events.length} actions recorded. Select an action to inspect its source and evidence.`);
  useToolHandler(section === "settings" ? "settings" : null, async (operation, args) => {
    if (operation === "open") return "Edit a preference directly, or tell me what to change.";
    if (operation === "permissions") {
      if (args.screenshotEnabled === false || args.trustedInput === false) { await patch({ ...(args.screenshotEnabled === false ? { screenshotEnabled: false } : {}), ...(args.trustedInput === false ? { trustedInput: false } : {}) }); return "Access disabled."; }
      const kind = String(args.permission || args.kind || args.name || (args.trustedInput === true ? "input" : "capture"));
      if (["capture", "screenshots", "screenshotEnabled", "input", "trustedInput"].includes(kind)) { setPermission(["input", "trustedInput"].includes(kind) ? "input" : "capture"); return "Use Allow access below to open Chrome’s permission prompt."; }
    }
    if (operation === "pause-site" || operation === "resume-site") {
      const hostname = String(args.hostname || args.host || (location.protocol === "chrome-extension:" ? "" : location.hostname));
      if (!hostname) throw new Error("Name the site to change.");
      await patch({ hiddenOnHosts: operation === "pause-site" ? [...new Set([...settings.hiddenOnHosts, hostname])] : settings.hiddenOnHosts.filter((item) => item !== hostname) });
      return operation === "pause-site" ? `Paused on ${hostname}.` : `Resumed on ${hostname}.`;
    }
    if (operation === "set") {
      const raw = args.patch && typeof args.patch === "object" ? args.patch as Record<string, unknown> : args.key || args.name ? { [String(args.key || args.name)]: args.value } : Object.fromEntries(Object.entries(args).filter(([key]) => !["conversationId", "selected"].includes(key)));
      const next: Partial<Settings> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (["screenshotEnabled", "trustedInput"].includes(key) && value === true) { setPermission(key === "trustedInput" ? "input" : "capture"); continue; }
        if (!["avatarSkin", "reducedMotion", "videoCompanion", "proactiveEnabled", "learningEnabled", "tabContextEnabled", "screenshotEnabled", "trustedInput"].includes(key)) throw new Error("That preference is unavailable here.");
        if (key === "avatarSkin" && !AVATAR_SKINS.includes(value as Settings["avatarSkin"])) throw new Error("Choose HypeMan, Glitch, Rally, Orbit, Breeze, or Spark.");
        Object.assign(next, { [key]: value });
      }
      if (Object.keys(next).length) await patch(next);
      return permission ? "Review the access request below." : "Preferences saved.";
    }
    throw new Error("That settings action is unavailable.");
  });
  const tasks = [...workspace.tasks].sort((a, b) => b.updatedAt - a.updatedAt).filter((task) => filter === "all" || filter === "unfinished" && ["running", "paused"].includes(task.status) || task.status === filter);
  const outcomes = [...workspace.events].reverse();
  const grant = async () => {
    try {
      if (permission === "capture") await setScreenshotAccess(true, patch);
      else { if (!(await chrome.permissions.request({ permissions: ["debugger"] }))) throw new Error("Browser input permission was not granted."); await patch({ trustedInput: true }); }
      setPermission(null); setNotice("Access enabled.");
    } catch (cause) { fail(cause); }
  };
  const removeNote = async (note: SourceNote) => { await request({ type: "note.remove", id: note.id }); removed.current = note; await refresh(); setNotice("Deleted"); };
  const create = async () => {
    if (!newText.trim()) return;
    try {
      if (section === "tasks") await workbench.send(newText.trim());
      else await request({ type: "note.save", note: { text: newText.trim(), title: "Note", excerpt: "", url: "", origin: { kind: "conversation", conversationId: workbench.conversationId } } });
      setNewText(""); setCreating(false); await refresh();
    } catch (cause) { fail(cause); }
  };
  return <section className={`inline-toolbox inline-toolbox-${section} ${embedded ? "embedded" : ""}`} aria-label={companionSections.find((item) => item.section === section)?.label}><div className="inline-tool-body">
    <Notice tone="error">{error || settingsError}</Notice><Notice>{notice}</Notice>{loading && <p role="status">Loading…</p>}
    {section === "tasks" && <><div className="tool-toolbar"><div className="tool-tabs" role="tablist" aria-label="Project status">{[["all", "All"], ["unfinished", "Active"], ["completed", "Done"]].map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={filter === value} onClick={() => setFilter(value!)}>{label}</button>)}</div><ToolButton icon="plus" label="New project" onClick={() => setCreating(!creating)} /></div><div className="inline-tool-list tool-content">{tasks.length ? tasks.map((task) => <TaskCard key={task.id} task={task} refresh={refresh} />) : <Empty title="No projects" />}</div></>}
    {creating && ["tasks", "notes"].includes(section) && <form className="tool-form" onSubmit={(event) => { event.preventDefault(); void create(); }}><textarea aria-label={section === "tasks" ? "Project goal" : "New note"} placeholder={section === "tasks" ? "Project goal…" : "New note…"} value={newText} onChange={(event) => setNewText(event.target.value)} autoFocus rows={2} /><div className="tool-actions"><button className="button primary" type="submit" disabled={!newText.trim()}>{section === "tasks" ? "Start" : "Save"}</button><button className="button" type="button" onClick={() => setCreating(false)}>Cancel</button></div></form>}
    {section === "notes" && !creating && <StudyLibrary workspace={workspace} refresh={refresh} search={search} setSearch={setSearch} initialView={libraryView} initialKind={libraryKind} requestRevision={libraryRequest} onCreateNote={() => setCreating(true)} onDelete={removeNote} undo={removed.current ? () => void workbench.executeTool("notes", "undo").then(() => setNotice("")).catch(fail) : undefined} />}
    {section === "activity" && <div className="inline-action-list">{outcomes.length ? outcomes.map((event) => <article key={event.id} className="inline-action" tabIndex={0} onFocus={() => workbench.selectContent({ kind: "action", id: event.id, text: event.summary, url: event.url })}><p>{event.ok ? "✓" : "!"} {event.summary}</p><details><summary>{relativeTime(event.at)} · details</summary><p>{event.action.replaceAll("_", " ")}</p>{event.url && <a href={event.url} target="_blank" rel="noreferrer">{host(event.url)} ↗</a>}</details></article>) : <Empty title="No actions yet">Completed actions and their evidence appear here.</Empty>}</div>}
    {section === "settings" && <>
      <Toggle label="Screenshots" description="Chrome asks before granting capture access." checked={settings.screenshotEnabled} onChange={(value) => value ? setPermission("capture") : edit({ screenshotEnabled: false })} />
      <Toggle label="Other tabs" description="Share other tab titles and links." checked={settings.tabContextEnabled} onChange={(value) => edit({ tabContextEnabled: value })} />
      <Toggle label="Browser actions" description="Chrome asks before enabling browser input." checked={settings.trustedInput} onChange={(value) => value ? setPermission("input") : edit({ trustedInput: false })} />
      <Toggle label="Automatic help" description="Explain selections and offer contextual help." checked={settings.proactiveEnabled} onChange={(value) => edit({ proactiveEnabled: value })} />
      <Toggle label="Learning" description="Keep practice evidence on this device." checked={settings.learningEnabled} onChange={(value) => edit({ learningEnabled: value })} />
      <label className="field">Motion<select aria-label="Motion" value={settings.reducedMotion} onChange={(event) => edit({ reducedMotion: event.target.value as Settings["reducedMotion"] })}><option value="auto">System preference</option><option value="on">Reduced motion</option><option value="off">Full animation</option></select></label>
      <label className="field">HypeMan skin<select aria-label="HypeMan skin" value={settings.avatarSkin} onChange={(event) => edit({ avatarSkin: event.target.value as Settings["avatarSkin"] })}><option value="hypeman">HypeMan</option><option value="glitch">Glitch</option><option value="rally">Rally</option><option value="orbit">Orbit</option><option value="breeze">Breeze</option><option value="spark">Spark</option></select></label>
      <label className="field">Video<select aria-label="Video companion" value={settings.videoCompanion} onChange={(event) => edit({ videoCompanion: event.target.value as Settings["videoCompanion"] })}><option value="ask">On request</option><option value="on">Automatic</option><option value="off">Off</option></select></label>
      <div className="tool-toolbar"><button className="button" onClick={() => void exportWorkspace(workspace).then(() => setNotice("Backup downloaded")).catch(fail)}>Export</button><button className="button" onClick={() => void restoreWorkspaceBackup().then((result) => { if (result) { setNotice("Backup restored"); return refresh(); } }).catch(fail)}>Restore</button><button className="button" onClick={() => workbench.openTool("connection")}>Account</button><button className="button" onClick={() => workbench.openTool("phone")}>Phone</button></div>
      {permission && <div className="confirmation" role="group" aria-label="Browser permission"><p>Allow {permission === "capture" ? "screenshots" : "browser actions"}?</p><button data-essential="permission" className="button" onClick={() => void grant()}>Allow</button><button data-essential="permission" className="button" onClick={() => setPermission(null)}>Cancel</button></div>}
      {!!settings.hiddenOnHosts.length && <details><summary>Paused sites</summary>{settings.hiddenOnHosts.map((hostname) => <div className="tool-actions" key={hostname}><span>{hostname}</span><ToolButton icon="play" label={`Resume on ${hostname}`} onClick={() => edit({ hiddenOnHosts: settings.hiddenOnHosts.filter((value) => value !== hostname) })} /></div>)}</details>}
    </>}
    {section === "learning" && <LearningCollection />}
  </div></section>;
}
function LearningCollection() {
  const { settings, patch } = useSettings();
  const workbench = useWorkbench();
  const [graph, setGraph] = useState<LearningGraph | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"plan" | "review">("plan"), [goal, setGoal] = useState("");
  const [checking, setChecking] = useState(false), [explanation, setExplanation] = useState("");
  const [busy, setBusy] = useState(false);
  const [activePlanId, setActivePlanId] = useState<string>();
  const [feedback, setFeedback] = useState("");
  const abort = useRef<AbortController | null>(null);
  const attemptIds = useRef(new Map<string, string>());
  const current = graph ? currentLearningStep(graph, activePlanId) : null;
  const showCurrent = (next: NonNullable<ReturnType<typeof currentLearningStep>>) => {
    setActivePlanId(next.plan.id);
    setGraph((previous) => { const base = previous || emptyLearningGraph(); return { ...base, plans: base.plans.some((plan) => plan.id === next.plan.id) ? base.plans.map((plan) => plan.id === next.plan.id ? next.plan : plan) : [...base.plans, next.plan] }; });
  };
  const refresh = async (signal?: AbortSignal) => {
    const next = await request<LearningGraph>({ type: "graph.get" }, signal);
    signal?.throwIfAborted(); setGraph(next);
  };
  useEffect(() => {
    const controller = new AbortController();
    const cancel = () => abort.current?.abort();
    window.addEventListener("hypeman.cancel-tools", cancel);
    void refresh(controller.signal).catch((cause) => { if (!controller.signal.aborted) setError(message(cause)); });
    return () => { controller.abort(); cancel(); window.removeEventListener("hypeman.cancel-tools", cancel); };
  }, []);
  useToolHandler("learning", async (operation, args) => {
    const controller = new AbortController(); abort.current?.abort(); abort.current = controller;
    const signal = controller.signal;
    try {
    if (["open", "continue", "resume"].includes(operation)) {
      let next = await request<ReturnType<typeof currentLearningStep>>({ type: "learn.current", ...(typeof args.planId === "string" ? { planId: args.planId } : {}) }, signal);
      signal.throwIfAborted();
      if (!next && operation !== "open" && !args.planId && graph) {
        const due = graph.nodes.find((node) => learningEstimate(node).due);
        if (due) {
          const plan: LearningPlan = { id: crypto.randomUUID(), goal: `Revisit ${due.label}`, createdAt: Date.now(), steps: [{ title: `Recall ${due.label}`, concept: due.label, exercise: `Without looking at your notes, explain ${due.label} and give a new example.`, done: false }] };
          if (!settings.learningEnabled) await patch({ learningEnabled: true }); signal.throwIfAborted();
          await request({ type: "learn.plan", plan }, signal); signal.throwIfAborted(); await refresh(signal);
          next = currentLearningStep({ ...graph, plans: [plan] }, plan.id);
        }
      }
      if (next) { showCurrent(next); setTab("plan"); return { message: `Step ${next.stepIndex + 1}/${next.plan.steps.length}: ${next.step.exercise || next.step.title}`, changed: false, data: next }; }
      return "Tell me what you want to learn.";
    }
      if (operation === "clear") { await request({ type: "learn.clear" }, signal); signal.throwIfAborted(); attemptIds.current.clear(); setActivePlanId(undefined); setFeedback(""); await refresh(signal); return "Practice history cleared."; }
      if (!settings.learningEnabled) await patch({ learningEnabled: true });
      signal.throwIfAborted();
      const concept = String(args.concept || args.goal || workbench.selected?.title || "This topic");
      if (operation === "plan") {
        const result = await request<{ goal: string; steps: { title: string; concept: string; exercise?: string }[] }>({ type: "api", path: "/api/learn/plan", body: { goal: concept } }, signal);
        signal.throwIfAborted();
        const plan: LearningPlan = { id: crypto.randomUUID(), goal: result.goal, steps: result.steps.map((step) => ({ ...step, done: false })), createdAt: Date.now() };
        await request({ type: "learn.plan", plan }, signal); signal.throwIfAborted(); setActivePlanId(plan.id); setFeedback(""); setTab("plan"); await refresh(signal);
        const step = currentLearningStep({ version: 1, plans: [plan], nodes: [], seenEvents: [] })!;
        return { message: `Step 1/${plan.steps.length}: ${step.step.exercise}`, changed: true, data: step };
      }
      const active = await request<ReturnType<typeof currentLearningStep>>({ type: "learn.current", ...(typeof args.planId === "string" ? { planId: args.planId } : activePlanId ? { planId: activePlanId } : {}) }, signal);
      if (operation === "attempt" || (operation === "check" && active && !args.concept)) {
        const text = String(args.explanation || args.text || workbench.selected?.text || "").trim();
        if (!text) throw new Error("Try the current exercise in your own words.");
        const displayed = current && (!args.planId || args.planId === current.plan.id) ? current : null;
        const planId = typeof args.planId === "string" ? args.planId : displayed?.plan.id || active?.plan.id;
        const stepIndex = Number.isInteger(args.stepIndex) ? Number(args.stepIndex) : displayed?.stepIndex ?? active?.stepIndex;
        if (!planId || stepIndex === undefined) throw new Error("Create or continue a practice plan first.");
        const key = JSON.stringify([planId, stepIndex, text]), priorId = attemptIds.current.get(key);
        if (!priorId && (!active || active.plan.id !== planId || active.stepIndex !== stepIndex)) {
          if (active) showCurrent(active); else await refresh(signal);
          throw new Error("The exercise changed. Your answer is kept; review the current step before checking it.");
        }
        const requestId = priorId || crypto.randomUUID();
        attemptIds.current.set(key, requestId);
        if (attemptIds.current.size > 30) attemptIds.current.delete(attemptIds.current.keys().next().value!);
        const result = await request<{ graph: LearningGraph; status: "correct" | "needs-work" | "uncertain"; hint: string; evidence: string; advanced: boolean }>({ type: "learn.step.attempt", planId, stepIndex, explanation: text, requestId }, signal);
        signal.throwIfAborted(); setGraph(result.graph); setActivePlanId(planId);
        const next = currentLearningStep(result.graph, planId);
        const reply = `${result.advanced ? next ? "Step complete." : "Plan complete." : result.status === "uncertain" ? "Needs more evidence." : "Try once more."} ${result.hint}`;
        setFeedback(reply); return { message: reply, changed: true, data: { status: result.status, evidence: result.evidence, advanced: result.advanced, current: next } };
      }
      if (operation === "hint") { const reply = await request<{ text?: string }>({ type: "assistant.ask", message: `Give me one small hint about ${active?.step.concept || concept}, without solving it for me. Exercise: ${active?.step.exercise || workbench.selected?.text || ""}` }, signal); signal.throwIfAborted(); const hint = reply.text || "Select the problem or describe what you are working on."; setFeedback(hint); return hint; }
      if (operation === "teach" || operation === "check") {
        const explanation = String(args.explanation || args.text || workbench.selected?.text || "");
        if (!explanation.trim()) throw new Error("Explain the idea in your own words first.");
        const result = await request<{ status: "correct" | "needs-work" | "uncertain"; hint: string; evidence: string; provider: AgentReply["provider"] }>({ type: "api", path: "/api/learn/teachback", body: { concept, explanation } }, signal);
        signal.throwIfAborted();
        if (!["correct", "needs-work", "uncertain"].includes(result.status) || typeof result.hint !== "string" || typeof result.evidence !== "string") throw new Error("The explanation assessment returned invalid data.");
        const grounded = result.provider === "openai" && result.status !== "uncertain" && !!result.evidence && explanation.includes(result.evidence);
        if (grounded) await request({ type: "learn.event", event: { id: crypto.randomUUID(), concept, kind: "explanation", correct: result.status === "correct", evidence: result.evidence, at: Date.now() } }, signal);
        signal.throwIfAborted(); await refresh(signal); const reply = `${result.provider === "demo" ? "Demonstration feedback:" : !grounded ? "I need more detail." : result.status === "correct" ? "Your explanation is supported." : "One thing to revisit:"} ${result.hint}`; setFeedback(reply); return reply;
      }
      throw new Error("That learning action is unavailable.");
    } finally { if (abort.current === controller) abort.current = null; }
  });
  const run = async (operation: string, args: Record<string, unknown> = {}) => {
    setBusy(true); setError("");
    try { await workbench.executeTool("learning", operation, args); return true; }
    catch (cause) { setError(message(cause)); return false; } finally { setBusy(false); }
  };
  return <div className="inline-learning"><Notice tone="error">{error}</Notice>
    <div className="tool-tabs" role="tablist" aria-label="Practice views"><button type="button" role="tab" aria-selected={tab === "plan"} onClick={() => setTab("plan")}>Plan</button><button type="button" role="tab" aria-selected={tab === "review"} onClick={() => setTab("review")}>Review</button></div>
    {tab === "plan" ? <><form className="tool-form tool-toolbar" onSubmit={(event) => { event.preventDefault(); if (goal.trim()) void run("plan", { goal: goal.trim() }).then((saved) => { if (saved) setGoal(""); }); }}><input aria-label="Practice goal" placeholder="Learn about…" value={goal} onChange={(event) => setGoal(event.target.value)} /><button className="button primary" type="submit" disabled={busy || !goal.trim()}>Plan</button></form><div className="tool-content">
      {current && <article><small>Step {current.stepIndex + 1}/{current.plan.steps.length} · {current.plan.goal}</small><h3>{current.step.title}</h3><p>{current.step.exercise}</p><form className="tool-form" onSubmit={(event) => { event.preventDefault(); void run("attempt", { planId: current.plan.id, stepIndex: current.stepIndex, explanation: explanation.trim() }).then((saved) => { if (saved) setExplanation(""); }); }}><textarea aria-label="Practice answer" placeholder="Try it in your own words…" rows={3} value={explanation} maxLength={4000} onChange={(event) => setExplanation(event.target.value)} /><div className="tool-actions"><button className="button primary" type="submit" disabled={busy || !explanation.trim()}>Check</button><ToolButton icon="hint" label="Get a hint" disabled={busy} onClick={() => void run("hint", { planId: current.plan.id })} /></div></form><Notice>{feedback}</Notice>{!!current.step.attempts?.length && <details><summary>Previous attempts</summary>{current.step.attempts.map((attempt) => <p key={attempt.id}>{attempt.text} · {attempt.hint}</p>)}</details>}</article>}
      {graph?.plans.length ? <details open={!current}><summary>Plans · {graph.plans.length}</summary>{graph.plans.map((plan) => <article key={plan.id}><div className="tool-actions"><h3>{plan.goal}</h3>{plan.steps.some((step) => !step.done) && <ToolButton icon="play" label={`Continue ${plan.goal}`} disabled={busy} onClick={() => void run("continue", { planId: plan.id })} />}</div><ol>{plan.steps.map((step, index) => <li key={index}>{step.done ? "✓ " : "○ "}{step.title}</li>)}</ol></article>)}</details> : <Empty title="No plans yet" />}
    </div></> : <div className="tool-content">{graph?.nodes.length ? graph.nodes.map((node) => { const estimate = learningEstimate(node); const select = () => workbench.selectContent({ kind: "concept", id: node.id, title: node.label, text: node.evidence.join("\n") }); return <article key={node.id} tabIndex={0} onFocus={select} onClick={select} data-selected={workbench.selected?.id === node.id}><div className="tool-actions"><h3>{node.label}</h3>{estimate.due && <span className="status-pill">Due</span>}</div><small>{estimate.evidenceCount} practices</small><details><summary>Evidence</summary>{node.evidence.map((evidence, index) => <p key={index}>{evidence}</p>)}</details></article>; }) : <Empty title="No practice yet" />}</div>}
    {!current && <><Notice>{feedback}</Notice><div className="tool-toolbar"><ToolButton icon="hint" label="Get a hint" disabled={busy} onClick={() => void run("hint")} /><button className="button" type="button" onClick={() => setChecking(!checking)}>Check</button></div></>}
    {!!graph?.nodes.length && <ToolButton icon="trash" label="Clear practice history" disabled={busy} onClick={() => void run("clear")} />}
    {!current && checking && <form className="tool-form" onSubmit={(event) => { event.preventDefault(); void run("check", { explanation: explanation.trim() }).then((saved) => { if (saved) { setChecking(false); setExplanation(""); } }); }}><textarea aria-label="Your explanation" placeholder="Explain it in your words…" rows={3} value={explanation} onChange={(event) => setExplanation(event.target.value)} autoFocus /><button className="button primary" type="submit" disabled={busy || !explanation.trim()}>Check</button></form>}
  </div>;
}
