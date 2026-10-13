import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { parseAction, type Action, type SelectedContent, type HistoryEntry, type SourceNote } from "@core";
import { normalizeToolResult } from "../runtime/reliability";
import type { CompanionRuntime } from "../runtime/types";
import { request, subscribe } from "../bridge";
import { WorkbenchContext, toolResultMessage, type ToolHandler, type ToolResult } from "./WorkbenchContext";
import { toolIntent } from "./tool-intents";
import { ToolOverlay } from "./ToolOverlay";
import { isOverlaySection, type OverlaySection } from "./overlay-sections";
import { uploadDocument } from "./document-client";
import { Icon } from "./Icon";
import { Notice } from "./common";
import { useSettings, exportWorkspace } from "./hooks";
import { restoreWorkspaceBackup } from "./workspace-backup";
import { ScreenRegion } from "./ScreenRegion";
import { parseCaptions } from "./Video";
import { MessageContent } from "./MessageContent";
import { clampWindow } from "./window-layout";
import { useWindowGeometry, WindowControls, WindowResizeHandles } from "./useWindowGeometry";
import { useConversationUI } from "./useConversationUI";
import { WindowGeometryProvider, type WindowGeometryPersistence } from "./WindowGeometryPersistence";
import type { AvatarActivity } from "./useAvatarAnimation";
import { useChatScroll } from "./useChatScroll";
import { useConversationActivity } from "./useConversationActivity";
import { phoneMessageText, phoneReview } from "./phone-review";

interface RecoveryContext { conversationId: string; text: string; selected: SelectedContent | null; tool: OverlaySection | null; image: string | null; runtimeAttempt: boolean }
interface Message { id: string; role: "user" | "assistant" | "status"; text: string; at: number }
const sections: Record<string, string> = { projects: "tasks", pdf: "documents" };
const resolveSection = (tool: string | null): OverlaySection | null => {
  const value = tool && (sections[tool] || tool); return isOverlaySection(value) ? value : null;
};
export function ConversationWorkbench({ runtime, initialTool, onClose, onActivity, onAvatarActivity, chatOpen = true, onRestoreChatOpen }: {
  runtime?: CompanionRuntime; initialTool?: string; onClose?: () => void; onActivity?: (busy: boolean) => void;
  chatOpen?: boolean; onRestoreChatOpen?: (open: boolean, conversationId: string) => boolean;
  onAvatarActivity?: (activity: AvatarActivity) => void;
}) {
  const { settings } = useSettings();
  const [conversationId, setConversationId] = useState("");
  const [hydrating, setHydrating] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [windows, setWindows] = useState<{ active: OverlaySection | null; open: OverlaySection[] }>(() => {
    const active = resolveSection(initialTool || location.hash.slice(1));
    return { active, open: active ? [active] : [] };
  });
  const windowsRef = useRef(windows); windowsRef.current = windows;
  const ui = useConversationUI(conversationId, { open: chatOpen, tools: windows.open, active: windows.active, geometry: {} }, (saved) => {
    const restored = { open: saved.tools, active: saved.active };
    windowsRef.current = restored; setWindows(restored);
    return { ...saved, open: onRestoreChatOpen?.(saved.open, conversationId) ?? saved.open };
  });
  const lastChatOpen = useRef(chatOpen);
  useEffect(() => {
    if (lastChatOpen.current !== chatOpen) { lastChatOpen.current = chatOpen; ui.patch({ open: chatOpen }); }
  }, [chatOpen, ui.patch]);
  const updateWindows = useCallback((change: (current: typeof windows) => typeof windows) => {
    const next = change(windowsRef.current);
    windowsRef.current = next; setWindows(next);
    ui.patch({ tools: next.open, active: next.active });
  }, [ui.patch]);
  const tool = windows.active;
  const closeTool = useCallback((section: OverlaySection) => {
    updateWindows((current) => {
      const open = current.open.filter((value) => value !== section);
      return { open, active: current.active === section ? open.at(-1) || null : current.active };
    });
  }, [updateWindows]);
  const setTool = useCallback((section: OverlaySection | null) => {
    updateWindows((current) => {
      const open = current.open.filter((value) => value !== (section || current.active));
      if (section) open.push(section);
      return { open, active: section || open.at(-1) || null };
    });
  }, [updateWindows]);
  const focusTool = useCallback((section: OverlaySection) => {
    if (windowsRef.current.active !== section) updateWindows((current) => ({ ...current, active: section }));
  }, [updateWindows]);
  const onGeometryChange: WindowGeometryPersistence["onGeometryChange"] = useCallback((id, snapshot) => ui.patch({ geometry: { [id]: snapshot } }), [ui.patch]);
  const persistence: WindowGeometryPersistence = { conversationId, ready: ui.ready, geometry: ui.geometry, onGeometryChange };
  const [selected, setSelected] = useState<SelectedContent | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [failedRequest, setFailedRequest] = useState("");
  const recoveryContext = useRef<RecoveryContext | null>(null);
  const conversationCheckpoint = useRef<{ conversationId: string; text: string; history: HistoryEntry[]; observed: Set<string> } | null>(null);
  const [toolStatus, setToolStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [celebration, setCelebration] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [saved, setSaved] = useState<Array<{ id: string; title: string; messages: Message[] }>>([]);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [confirmationLabel, setConfirmationLabel] = useState("Continue");
  const approval = useRef<HTMLDivElement>(null);
  const hadApproval = useRef(false);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 760);
  useEffect(() => { const resize = () => setNarrow((window.visualViewport?.width || window.innerWidth) < 760); window.addEventListener("resize", resize); window.visualViewport?.addEventListener("resize", resize); return () => { window.removeEventListener("resize", resize); window.visualViewport?.removeEventListener("resize", resize); }; }, []);
  const confirmationAnswer = useRef<((answer: boolean) => void) | null>(null);
  const [captureRegion, setCaptureRegion] = useState(false);
  const regionAnswer = useRef<((image: string | null) => void) | null>(null);
  const [snapshot, setSnapshot] = useState(() => runtime?.getSnapshot());
  const awaitingConfirmation = !!(confirmation || snapshot?.confirmation);
  const [sketch, setSketch] = useState<Extract<Action, { type: "sketch" }> | null>(null);
  const field = useRef<HTMLTextAreaElement>(null), files = useRef<HTMLInputElement>(null);
  const preferredHeight = narrow && windows.open.length && !confirmation && !snapshot?.confirmation ? 180 : Math.min(400, messages.length ? 360 : confirmation || snapshot?.confirmation ? 240 : image ? 220 : error ? 180 : 120);
  const chatWindow = useWindowGeometry({
    id: "chat", minSize: { width: 300, height: 120 }, preferredHeight, persistence,
    initialRect: (viewport) => clampWindow({ x: viewport.x + viewport.width - 368, y: viewport.y + viewport.height - 105 - preferredHeight, width: 340, height: preferredHeight }, viewport, { width: 300, height: 120 }),
  });
  const chatScroll = useChatScroll({ conversationId, ready: !hydrating && chatWindow.hydrated, open: chatOpen && !chatWindow.minimized, lastMessage: messages.at(-1) });
  const handlers = useRef(new Map<string, ToolHandler>());
  const pending = useRef<AbortController | null>(null);
  const state = useRef({ conversationId, messages, tool, selected }); state.current = { conversationId, messages, tool, selected };
  const seen = useRef(new Set<string>());
  const alive = useRef(true);
  const loadingSequence = useRef(0);
  const activity = useConversationActivity(conversationId, (savedMessages) => {
    if (!alive.current || state.current.conversationId !== conversationId) return;
    for (const message of savedMessages) seen.current.add(message.id);
    setMessages((current) => {
      const combined = new Map(current.map((message) => [message.id, message]));
      for (const message of savedMessages) combined.set(message.id, message);
      return [...combined.values()].sort((left, right) => left.at - right.at);
    });
  });
  const localWorking = busy || snapshot?.phase === "thinking" || snapshot?.phase === "acting";
  const working = localWorking || !!activity;
  const progressLabel = activity
    ? `${activity.site ? `${activity.site} · ` : ""}${activity.phase === "confirming" ? "Waiting for confirmation" : activity.status || "Working"}`
    : snapshot?.phase === "thinking" || snapshot?.phase === "acting" ? snapshot.status || "Working…" : toolStatus || "Working…";
  const register = useCallback((name: string, handler: ToolHandler) => {
    handlers.current.set(name, handler);
    return () => { if (handlers.current.get(name) === handler) handlers.current.delete(name); };
  }, []);
  const openTool = useCallback((name: string | null) => { setTool(resolveSection(name)); }, [setTool]);
  const append = useCallback(async (role: Message["role"], text: string, id: string = crypto.randomUUID()) => {
    if (!text || !state.current.conversationId) return;
    const message = { id, role, text, at: Date.now() };
    const owner = state.current.conversationId;
    await request({ type: "conversation.append", conversationId: owner, message });
    if (alive.current && state.current.conversationId === owner) setMessages((current) => current.some((m) => m.id === id) ? current : [...current, message]);
  }, []);
  useEffect(() => {
    alive.current = true;
    const version = ++loadingSequence.current;
    void (async () => {
      const query = new URLSearchParams(location.search);
      const tab = location.protocol === "chrome-extension:" ? await chrome.tabs.getCurrent?.().catch(() => undefined) : undefined;
      const resolved = await request<{ id: string; messages: Message[] }>({ type: "conversation.resolve", ...(query.get("conversationId") ? { conversationId: query.get("conversationId") } : {}), ...(tab?.id !== undefined ? { tabId: tab.id } : {}) });
      if (!alive.current || version !== loadingSequence.current) return;
      state.current.conversationId = resolved.id; state.current.messages = resolved.messages || [];
      seen.current = new Set((resolved.messages || []).map((message) => message.id));
      setConversationId(resolved.id); setMessages(resolved.messages || []); setHydrating(false);
      runtime?.setConversationId?.(resolved.id);
    })().catch((e) => { if (alive.current && version === loadingSequence.current) { setHydrating(false); setError(String(e instanceof Error ? e.message : e)); } });
    return () => { alive.current = false; pending.current?.abort(); };
  }, [runtime]);
  useEffect(() => runtime?.subscribe(() => setSnapshot(runtime.getSnapshot())), [runtime]);
  useEffect(() => {
    const id = snapshot?.conversationId;
    if (!runtime || !id || id === state.current.conversationId) return;
    const version = ++loadingSequence.current;
    // The background already moved the running session. Cancel only UI work from its previous chat.
    pending.current?.abort(); pending.current = null;
    confirmationAnswer.current?.(false); confirmationAnswer.current = null; setConfirmation(null);
    regionAnswer.current?.(null); regionAnswer.current = null; setCaptureRegion(false);
    window.dispatchEvent(new Event("hypeman.cancel-tools"));
    state.current = { conversationId: id, messages: [], tool: null, selected: null };
    seen.current.clear(); setConversationId(id); setMessages([]); setHydrating(true);
    setWindows({ active: null, open: [] }); setSelected(null); setSketch(null); setSaved([]); setImage(null); setDraft(""); setBusy(false); setError("");
    void request<{ id: string; messages: Message[] }>({ type: "conversation.open", conversationId: id }).then((conversation) => {
      if (!alive.current || version !== loadingSequence.current || runtime.getSnapshot().conversationId !== id) return;
      const savedMessages = conversation.messages || [];
      state.current.messages = savedMessages; seen.current = new Set(savedMessages.map((message) => message.id));
      setMessages((current) => [...new Map([...savedMessages, ...current].map((message) => [message.id, message])).values()].sort((left, right) => left.at - right.at)); setHydrating(false);
    }).catch((cause) => { if (alive.current && version === loadingSequence.current) { setHydrating(false); setError(cause instanceof Error ? cause.message : String(cause)); } });
  }, [runtime, snapshot?.conversationId]);
  useEffect(() => {
    if (!conversationId || !snapshot || hydrating || (snapshot.conversationId && snapshot.conversationId !== conversationId)) return;
    for (const message of snapshot.messages) {
      if (seen.current.has(message.id)) continue;
      if (message.role === "user" && state.current.messages.some((m) => m.role === "user" && m.text === message.text && Math.abs(m.at - message.at) < 5000)) { seen.current.add(message.id); continue; }
      seen.current.add(message.id); void append(message.role, message.text, message.id).catch((e) => setError(e.message));
    }
    if (snapshot.sketch && snapshot.sketch !== sketch) { setSketch(snapshot.sketch); setTool("board"); }
  }, [snapshot, conversationId, hydrating, append]);
  const executeTool = useCallback(async (name: string, operation: string, args: Record<string, unknown> = {}) => {
    const signal = pending.current?.signal; signal?.throwIfAborted();
    setTool(resolveSection(name));
    setToolStatus(`${operation === "summarize" || operation === "analyze" || operation === "ask" ? "Reading" : operation === "find" ? "Finding" : "Using"} ${name === "board" ? "whiteboard" : name}…`);
    if ((operation === "open" || operation === "show") && !Object.keys(args).length && !["board", "video", "documents"].includes(name)) return;
    if (name === "phone" && ["send", "test", "pair", "unpair", "remind", "settings", "continue"].includes(operation)) {
      const selected = args.selected && typeof args.selected === "object" ? args.selected as SelectedContent : state.current.selected;
      if (["send", "test"].includes(operation) && !phoneMessageText(operation, args, selected).trim()) throw new Error("Select content or tell me what to send.");
      const inbox = await request<{ status?: { ownerPhone?: string; settings?: { timezone?: string } } }>({ type: "messaging.inbox", refresh: false }, signal).catch(() => null);
      signal?.throwIfAborted();
      const answer = await new Promise<boolean>((resolve) => { confirmationAnswer.current = resolve; setConfirmationLabel(({ send: "Send text", test: "Send test", pair: "Pair phone", unpair: "Unpair", remind: "Schedule", settings: "Save preferences", continue: "Continue idea" } as Record<string, string>)[operation] || "Continue"); setConfirmation(phoneReview(operation, args, selected, inbox?.status?.ownerPhone, inbox?.status?.settings?.timezone)); });
      confirmationAnswer.current = null; setConfirmation(null); signal?.throwIfAborted();
      if (!answer) return { ok: false, message: "Cancelled.", changed: false, continue: false };
    }
    // React mounts the tool before its registered operation can execute.
    for (let attempt = 0; attempt < 100 && !handlers.current.has(name); attempt++) { signal?.throwIfAborted(); await new Promise((resolve) => setTimeout(resolve, 30)); }
    signal?.throwIfAborted();
    const handler = handlers.current.get(name);
    if (!handler) throw new Error("The tool is still opening. Try your request again.");

    const result = await handler(operation, { ...args, conversationId: state.current.conversationId, ...(!args.selected && state.current.selected ? { selected: state.current.selected } : {}) });
    signal?.throwIfAborted(); return result;
  }, [setTool]);
  useEffect(() => {
    runtime?.setToolHandler?.((action) => executeTool(action.tool, action.operation, action.args));
    return () => runtime?.setToolHandler?.(null);
  }, [runtime, executeTool]);
  const stop = useCallback((announce = false) => {
    pending.current?.abort(); pending.current = null; runtime?.stop(true, announce);
    confirmationAnswer.current?.(false); confirmationAnswer.current = null; setConfirmation(null);
    regionAnswer.current?.(null); regionAnswer.current = null; setCaptureRegion(false);
    window.dispatchEvent(new Event("hypeman.cancel-tools")); setBusy(false);
  }, [runtime]);
  const cancelPending = useCallback(async () => {
    const id = state.current.conversationId;
    const announceLocal = !!runtime && ["thinking", "acting", "confirming"].includes(runtime.getSnapshot().phase);
    const stoppedTools = !!pending.current && !announceLocal;
    stop(announceLocal);
    const cancelled = id ? await request<{ stopped?: boolean }>({ type: "conversation.cancel-pending", conversationId: id, ...(announceLocal ? { markerAlreadyWritten: true } : {}) }) : null;
    if (stoppedTools && !cancelled?.stopped && state.current.conversationId === id) await append("status", "Stopped. Completed work is saved.");
  }, [stop, runtime, activity, append]);
  useEffect(() => {
    const close = () => stop();
    window.addEventListener("hypeman.close-conversation", close);
    return () => window.removeEventListener("hypeman.close-conversation", close);
  }, [stop]);
  useEffect(() => runtime?.setSelectedContent?.(selected), [runtime, selected]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (confirmation) { confirmationAnswer.current?.(false); setConfirmation(null); field.current?.focus(); }
      else if (snapshot?.confirmation) runtime?.confirm(false);
      else if (working) void cancelPending().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
      else if (state.current.tool) { window.dispatchEvent(new Event("hypeman.cancel-tools")); setTool(null); field.current?.focus(); }
      else onClose?.();
    };
    const selection = () => {
      const selection = document.getSelection(); const text = selection?.toString().trim();
      const element = selection?.anchorNode?.parentElement;
      if (!text || !element || element.closest("input,textarea,[contenteditable],#hypeman-companion-v2,.conversation-workbench")) return;
      setSelected({ kind: "page", id: `selection-${Date.now()}`, text: text.slice(0, 4000), url: location.href, title: document.title });
    };
    window.addEventListener("keydown", escape); document.addEventListener("selectionchange", selection);
    const oldLink = () => { if (location.protocol === "chrome-extension:") { const section = resolveSection(location.hash.slice(1)); if (section) setTool(section); } };
    window.addEventListener("hashchange", oldLink);
    const unsubscribe = subscribe((event) => {
      if (event.type === "tab.activated") chatScroll.latest(true);
      if (event.type === "command" && event.name === "open-tools" && typeof event.section === "string") setTool(resolveSection(event.section));
    });
    return () => { window.removeEventListener("keydown", escape); document.removeEventListener("selectionchange", selection); window.removeEventListener("hashchange", oldLink); unsubscribe(); };
  }, [working, snapshot?.confirmation, confirmation, cancelPending, onClose, runtime, chatScroll.latest]);
  useEffect(() => { onActivity?.(working && !awaitingConfirmation && activity?.phase !== "confirming"); }, [working, awaitingConfirmation, activity?.phase, onActivity]);
  const avatarPhase: AvatarActivity["phase"] = error || snapshot?.phase === "error" ? "confused"
    : confirmation || snapshot?.confirmation || snapshot?.phase === "confirming" || activity?.phase === "confirming" ? "point"
    : working ? "thinking" : "idle";
  const avatarCompletion = snapshot?.completionId || celebration ? `${snapshot?.completionId || ""}:${celebration}` : undefined;
  useEffect(() => {
    onAvatarActivity?.({ phase: avatarPhase, conversationId, task: snapshot?.task, hintId: snapshot?.learning.autoHint?.id, celebration: avatarCompletion });
  }, [onAvatarActivity, avatarPhase, conversationId, snapshot?.task, snapshot?.learning.autoHint?.id, avatarCompletion]);
  const applyReply = async (action: Action, say?: string, requestSelection = state.current.selected, submittedText = draft): Promise<ToolResult> => {
    if (action.type === "tool") {
      const sensitive = (action.tool === "connection" && ["login", "logout", "account", "model"].includes(action.operation)) || (action.tool === "settings" && action.operation === "permissions");
      if (sensitive) {
        const answer = await new Promise<boolean>((resolve) => { confirmationAnswer.current = resolve; setConfirmationLabel(action.tool === "settings" ? "Allow access" : action.operation === "logout" ? "Sign out" : action.operation === "model" ? "Switch model" : action.operation === "account" ? "Switch account" : "Sign in"); setConfirmation(action.tool === "settings" ? `Allow ${action.args?.permission === "input" ? "browser input" : "screen capture"} access?` : action.operation === "logout" ? "Sign out of the connected account?" : action.operation === "account" ? `Switch to account ${String(action.args?.account || "selected")}?` : action.operation === "model" ? `Use model ${String(action.args?.model || "selected")}?` : "Open ChatGPT sign-in?"); });
        confirmationAnswer.current = null; setConfirmation(null);
        if (!answer) return;
        pending.current?.signal.throwIfAborted();
      }
      const targetedBoard = action.tool === "board" && ["update", "erase", "color"].includes(action.operation) && requestSelection?.kind === "board";
      const args = { ...(action.args || {}), ...(requestSelection ? { selected: requestSelection } : {}), ...(targetedBoard ? { id: action.args?.id || requestSelection.id, revision: requestSelection.revision } : {}) };
      const result = await executeTool(action.tool, action.operation, args); if (toolResultMessage(result)) await append("assistant", toolResultMessage(result)); return result;
    }
    else if (action.type === "sketch") { const result = await executeTool("board", "add", { sketch: action }); await append("assistant", say || `Shown ${action.title} on the whiteboard.`); return result; }
    else if (action.type === "say") { await append("assistant", action.text); return { message: action.text, continue: false }; }
    else if (action.type === "ask") { await append("assistant", action.question); return { message: action.question, continue: false }; }
    else if (action.type === "finish") {
      const signal = pending.current?.signal;
      await append("assistant", action.summary); signal?.throwIfAborted();
      if (alive.current) setCelebration(crypto.randomUUID());
    }
    else if (action.type === "note") { const saved = await saveNote(action.text, action.excerpt); return { message: "Note saved.", changed: true, data: { id: saved.id, text: saved.text, updatedAt: saved.updatedAt, url: saved.url }, continue: true }; }
    else {
      await request({ type: "assistant.run", goal: submittedText, ...(action.type === "navigate" ? { url: action.url } : {}), conversationId: state.current.conversationId });
      await append("assistant", say || "Continuing this request in the browser.");
    }
  };
  const saveNote = async (text?: string, excerpt?: string) => {
    const content = state.current.selected;
    const value = text || content?.text || state.current.messages.filter((m) => m.role === "assistant").at(-1)?.text;
    if (!value) throw new Error("Select something or tell me what to remember.");
    const web = content?.url && /^https?:/.test(content.url);
    const saved = await request<SourceNote>({ type: "note.save", note: { text: value.slice(0, 4000), excerpt: excerpt || content?.text || "", url: web ? content.url : "", title: content?.title || "Conversation note", ...(!web ? { origin: { kind: content?.artifactId || content?.kind === "document" ? "document" : "conversation", conversationId: state.current.conversationId, ...(content?.artifactId ? { documentId: content.artifactId, page: content.page || 1 } : {}) } } : {}) } });
    setTool("notes"); await append("assistant", "Saved to your notes."); return saved;
  };
  const runConversation = async (text: string, signal: AbortSignal, resume = false, attachment = image) => {
    const previous = resume && conversationCheckpoint.current?.conversationId === state.current.conversationId && conversationCheckpoint.current.text === text ? conversationCheckpoint.current : null;
    const history: HistoryEntry[] = previous?.history || [], observed = previous?.observed || new Set<string>();
    conversationCheckpoint.current = { conversationId: state.current.conversationId, text, history, observed };
    for (let step = 0; step < 8; step++) {
      signal.throwIfAborted();
      const requestSelection = state.current.selected;
      const reply = await request<{ action: Action; say?: string; done?: boolean }>({ type: "assistant.turn", conversationId: state.current.conversationId, message: text, goal: text.slice(0, 2000), history,
        toolContext: { activeTool: state.current.tool, selected: requestSelection }, ...(attachment ? { image: attachment } : {}) }, signal);
      signal.throwIfAborted();
      const action = parseAction(reply.action); if (!action) throw new Error("That action was invalid. Your saved work is safe.");
      const fingerprint = JSON.stringify(action);
      if (observed.has(fingerprint) && !["say", "ask", "finish"].includes(action.type)) throw new Error("I paused because the same action was requested twice. Edit the request to continue.");
      const result = await applyReply(action, reply.say, requestSelection, text);
      signal.throwIfAborted(); observed.add(fingerprint);
      const structured = result && typeof result === "object" ? result : undefined;
      const normalized = normalizeToolResult(result, action.type === "tool" ? action : { type: "tool", tool: action.type === "note" ? "notes" : "board", operation: action.type === "note" ? "save" : "draw" });
      history.push({ action, result: normalized.result, at: Date.now() });
      // Keep older receipts and IDs while leaving the latest full source available to the next step.
      if (history.reduce((size, entry) => size + entry.result.message.length, 0) > 32_000)
        for (const entry of history.slice(0, -2)) entry.result.message = entry.result.message.slice(0, 1000) + "\n[Older observation excerpt; retrieve source by ID if needed.]";
      if (["say", "ask", "finish"].includes(action.type) || structured?.ok === false || structured?.continue === false || reply.done === true || (!structured?.continue && reply.done !== false)) { conversationCheckpoint.current = null; return; }
      setToolStatus("Continuing…");
    }
    throw new Error("I paused after eight actions. Your completed work is saved; ask me to continue.");
  };
  const send = async (raw: string, recovery?: RecoveryContext) => {
    const text = raw.trim(); if (!text || !state.current.conversationId) return;
    const owner = state.current.conversationId;
    if (/^(?:stop|cancel|never mind)[.!]?$/i.test(text)) { await cancelPending(); return; }
    if (confirmation) { if (/^(?:yes|continue|go ahead|no|cancel)[.!]?$/i.test(text)) { confirmationAnswer.current?.(/^(?:yes|continue|go ahead)/i.test(text)); setConfirmation(null); } else throw new Error("Confirm or cancel the pending action first."); return; }
    if (snapshot?.confirmation) { if (/^(?:yes|continue|go ahead|no|cancel)[.!]?$/i.test(text)) runtime?.confirm(/^(?:yes|continue|go ahead)/i.test(text)); else throw new Error("Confirm or cancel the pending browser action first."); return; }
    if (activity) await cancelPending();
    if (state.current.conversationId !== owner) return;
    if (pending.current) stop();
    if (recovery && recovery.conversationId !== state.current.conversationId) throw new Error("Open the original conversation to retry this request.");
    const attachment = recovery ? recovery.image : image;
    if (recovery) { state.current.selected = recovery.selected; state.current.tool = recovery.tool; setSelected(recovery.selected); setTool(recovery.tool); setImage(attachment); runtime?.setSelectedContent?.(recovery.selected); runtime?.attachImage?.(attachment); }
    else conversationCheckpoint.current = null;
    recoveryContext.current = recovery || { conversationId: state.current.conversationId, text, selected: state.current.selected, tool: state.current.tool, image: attachment, runtimeAttempt: false };
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError(""); setFailedRequest(""); setToolStatus("Thinking…");
    try {
      window.dispatchEvent(new Event("hypeman.flush-window-geometry"));
      await ui.flush(); controller.signal.throwIfAborted();
      if (!recovery) await append("user", text);
      if (recovery?.runtimeAttempt && runtime?.retry) { await runtime.retry(); if (runtime.getSnapshot().phase === "error") throw new Error(runtime.getSnapshot().messages.at(-1)?.text || "Request failed."); return; }
      if (recovery && !runtime && conversationCheckpoint.current) { await runConversation(text, controller.signal, true, attachment); return; }
      const dismiss = text.match(/^(?:close|dismiss|hide)(?: this| the)?(?: (tool|board|whiteboard|documents?|pdf|notes|library|study library|review|flashcards|video|projects|settings|preferences|practice|phone|connection))?$/i);
      if (dismiss) {
        const names: Record<string, OverlaySection> = { board: "board", whiteboard: "board", document: "documents", documents: "documents", pdf: "documents", notes: "notes", video: "video", projects: "tasks", settings: "settings", preferences: "settings", practice: "learning", phone: "phone", connection: "connection" };
        const section = names[dismiss[1]?.toLowerCase()] || state.current.tool;
        if (section) closeTool(section);
        return;
      }
      if (/^(?:new (?:chat|conversation)|start over)$/i.test(text)) { await switchConversation(crypto.randomUUID()); return; }
      if (/^(?:show|open|find|list)(?: my| the)? (?:saved work|conversations|chats)(?: about .+)?$/i.test(text)) { const all = await request<Array<{ id: string; title: string; messages: Message[] }>>({ type: "conversation.list" }); const query = text.split(/ about /i)[1]; const hits = query ? await request<Array<{ id: string; conversationId?: string }>>({ type: "recall.search", query, kinds: ["conversation"], limit: 30 }) : null; setSaved(all.filter((c) => !hits || hits.some((hit) => (hit.conversationId || hit.id) === c.id)).sort((a,b) => (b.messages.at(-1)?.at || 0) - (a.messages.at(-1)?.at || 0))); await append("assistant", "Select a conversation to continue its saved work."); return; }
      if (/^(?:help|what can you do)[?!]?$/i.test(text)) { await append("assistant", "Ask me a question, drop a PDF, or select something on the page. I can draw explanations, save notes, manage projects, help with videos and practice, and manage settings or your phone. Say ‘open library’ to search saved notes and conversations, or ‘review cards’ for spaced practice. The library and reviews work offline."); return; }
      if (/^(?:capture|screenshot|attach)(?: a| the)? (?:screen region|region of (?:the|my) screen|part of (?:the|my) screen)$/i.test(text)) {
        if (!runtime) throw new Error("Open the conversation on the webpage you want to capture, then ask to capture a screen region.");
        if (!settings.screenshotEnabled) { await executeTool("settings", "permissions", { permission: "capture" }); await append("assistant", "Allow screenshot access, then ask to capture the screen region again."); return; }
        const captured = await new Promise<string | null>((resolve) => { regionAnswer.current = resolve; setCaptureRegion(true); });
        setCaptureRegion(false); regionAnswer.current = null; controller.signal.throwIfAborted();
        if (captured) { setImage(captured); runtime.attachImage?.(captured); await append("status", "Screen region attached to your next message."); }
        return;
      }
      if (/^(?:export|download)(?: my| the)? workspace$/i.test(text)) {
        await exportWorkspace(undefined, controller.signal); await append("assistant", "Workspace backup downloaded."); return;
      }
      if (/^(?:restore|import)(?: my| the)? (?:workspace|backup)$/i.test(text)) { const restored = await restoreWorkspaceBackup(undefined, controller.signal); if (restored) await append("assistant", "Workspace restored."); return; }
      const assisted = await request<{ reply?: { action: Action; say?: string } | null; contextTool?: "documents" | "video" | null }>({ type: "conversation.assist", conversationId: state.current.conversationId, message: text, toolContext: { activeTool: state.current.tool, selected: state.current.selected } }, controller.signal);
      controller.signal.throwIfAborted();
      if (assisted?.reply) { await applyReply(assisted.reply.action, assisted.reply.say, null, text); return; }
      const local = toolIntent(text, state.current.tool, state.current.selected);
      if (local) {
        if (local.tool === "notes" && local.operation === "save") { await saveNote(typeof local.args?.text === "string" ? local.args.text : undefined); return; }
        if (local.tool === "learning" && ["hint", "teach"].includes(local.operation) && runtime) {
          setTool("learning"); if (!settings.learningEnabled) runtime.setSettings(await request({ type: "settings.patch", patch: { learningEnabled: true } }));
          if (local.operation === "teach" && snapshot?.learning.teaching) runtime.teach(true); else { if (recoveryContext.current) recoveryContext.current.runtimeAttempt = true; await runtime.send(text); } return;
        }
        const result = await executeTool(local.tool, local.operation, local.args); controller.signal.throwIfAborted(); if (toolResultMessage(result)) await append("assistant", toolResultMessage(result)); return;
      }
      if (state.current.tool === "documents" && assisted?.contextTool === "documents") {
        const documentSelection = state.current.selected;
        const result = await executeTool("documents", "analyze", { question: text, ...(documentSelection?.page && documentSelection.quote && /\b(this|selection|passage|quote|highlighted)\b/i.test(text) ? { page: documentSelection.page, quote: documentSelection.quote } : {}) });
        controller.signal.throwIfAborted(); if (toolResultMessage(result)) await append("assistant", toolResultMessage(result));
        if (/\b(draw|diagram|whiteboard|show (?:the |your )?work)\b/i.test(text)) {
          const selectedDocument = { ...documentSelection, kind: "pdf", id: documentSelection?.id || "document", text: (toolResultMessage(result) || documentSelection?.text || "").slice(0, 4000) };
          const reply = await request<{ action: Action; say?: string }>({ type: "assistant.turn", conversationId: state.current.conversationId, message: `${text}\nUse the whiteboard to explain the supplied PDF analysis.`, toolContext: { activeTool: "documents", selected: selectedDocument } }, controller.signal);
          controller.signal.throwIfAborted(); const action = parseAction(reply.action); if (!action) throw new Error("The whiteboard explanation was invalid. Your PDF is still saved."); await applyReply(action, reply.say, selectedDocument, text);
        }
        return;
      }
      if (state.current.tool === "video" && assisted?.contextTool === "video") { const result = await executeTool("video", "ask", { question: text }); controller.signal.throwIfAborted(); if (toolResultMessage(result)) await append("assistant", toolResultMessage(result)); return; }
      if (runtime) { if (recoveryContext.current) recoveryContext.current.runtimeAttempt = true; await runtime.send(text); if (runtime.getSnapshot().phase === "error") throw new Error(runtime.getSnapshot().messages.at(-1)?.text || "Request failed. Try again."); setImage(null); }
      else {
        await runConversation(text, controller.signal, false, attachment); setImage(null);
      }
    } finally { if (pending.current === controller) { pending.current = null; setBusy(false); } }
  };
  const switchConversation = async (id: string) => {
    stop();
    const version = ++loadingSequence.current; setHydrating(true);
    try {
    const tab = location.protocol === "chrome-extension:" ? await chrome.tabs.getCurrent?.().catch(() => undefined) : undefined;
    const result = await request<{ id: string; messages: Message[] }>({ type: "conversation.select", conversationId: id, ...(tab?.id !== undefined ? { tabId: tab.id } : {}) });
    if (!alive.current || version !== loadingSequence.current) return;
    state.current.conversationId = result.id; state.current.messages = result.messages;
    seen.current = new Set(result.messages.map((message) => message.id));
    setConversationId(result.id); setMessages(result.messages); setHydrating(false); setSelected(null); setSaved([]); setWindows({ active: null, open: [] }); setSketch(null); runtime?.setConversationId?.(result.id);
    for (const message of runtime?.getSnapshot().messages || []) seen.current.add(message.id);
    } finally { if (alive.current && version === loadingSequence.current) setHydrating(false); }
  };
  const submit = async (event?: FormEvent) => {
    event?.preventDefault(); const text = draft;
    if (!text.trim() || !state.current.conversationId || hydrating) return;
    setDraft("");
    try { await send(text); }
    catch (e) { if ((e as Error).name !== "AbortError") { setError((e as Error).message); setFailedRequest(text); } }
  };
  const acceptFiles = async (files: FileList | File[]) => {
    const controller = new AbortController(); pending.current?.abort(); pending.current = controller; setBusy(true); setError("");
    try {
      for (const file of Array.from(files)) {
        if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
          const document = await uploadDocument(file, state.current.conversationId, controller.signal);
          controller.signal.throwIfAborted(); setSelected({ kind: "document", id: document.id, artifactId: document.id, title: document.name }); setTool("documents");
          window.dispatchEvent(new CustomEvent("hypeman.document.attached", { detail: document }));
        } else if (/^image\//.test(file.type)) {
          if (file.size > 25 * 1024 * 1024) throw new Error("Choose an image up to 25 MiB.");
          const bitmap = await createImageBitmap(file); const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height)); const canvas = document.createElement("canvas"); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale); canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
          controller.signal.throwIfAborted();
          const data = canvas.toDataURL("image/jpeg", 0.8); setImage(data); runtime?.attachImage?.(data);
        } else { setTool("video"); await executeTool("video", "captions", { file }); }
      }
    } catch (e) { if ((e as Error).name !== "AbortError") setError((e as Error).message); }
    finally { if (pending.current === controller) { pending.current = null; setBusy(false); } }
  };
  useEffect(() => {
    const visible = !!(confirmation || snapshot?.confirmation);
    if (visible) { if (chatWindow.minimized) chatWindow.toggleMinimized(); approval.current?.querySelector<HTMLButtonElement>("button:last-child")?.focus(); }
    else if (hadApproval.current) field.current?.focus();
    hadApproval.current = visible;
  }, [confirmation, snapshot?.confirmation]);
  useLayoutEffect(() => {
    if (!awaitingConfirmation || !chatWindow.hydrated || chatWindow.minimized) return;
    const body = approval.current?.parentElement;
    const review = approval.current?.querySelector<HTMLElement>(".confirmation-review");
    if (body?.clientHeight && body.scrollHeight <= body.clientHeight && (review?.clientHeight || 0) >= 48) return;
    return chatWindow.ensureMinHeight(320);
  }, [awaitingConfirmation, chatWindow.hydrated, chatWindow.minimized, chatWindow.ensureMinHeight]);
  const approvalKeys = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const controls = event.currentTarget.querySelectorAll<HTMLElement>('button, [tabindex="0"]');
    if (controls.length < 2) return;
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && event.target === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && event.target === last) { event.preventDefault(); first.focus(); }
  };
  return <WorkbenchContext.Provider value={{ conversationId: conversationId || "default", selected, selectContent: setSelected, openTool, register, executeTool, send }}><WindowGeometryProvider {...persistence}>
    <div className={`conversation-workbench ${tool ? "has-tool" : ""}`} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
      onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); event.stopPropagation(); void acceptFiles(event.dataTransfer.files); } }}>
      <section ref={chatWindow.hostRef} className="conversation-pane pixel-workspace workspace-chat" aria-label="HypeMan conversation"
        data-window-tool="chat"
        hidden={!chatWindow.hydrated}
        style={chatWindow.style} {...chatWindow.shellProps}>
        <header className="conversation-title pixel-workspace-bar" tabIndex={0} aria-label="Move HypeMan window" aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown" {...chatWindow.titleProps}>
          <span><Icon name="chat" /><strong>HypeMan</strong></span><span className="pixel-window-grip" aria-hidden="true" />
          <WindowControls geometry={chatWindow} title="HypeMan" onClose={() => { stop(); onClose?.(); }} />
        </header>
        <div className={`conversation-body${awaitingConfirmation ? " is-confirming" : ""}`} hidden={chatWindow.minimized}>
        <div ref={chatScroll.ref} onScroll={chatScroll.onScroll} className="conversation-messages" role="log" aria-live="polite">
          {messages.filter((message) => !(error && message.role === "status" && message.text === error)).map((message) => <article key={message.id} className={`chat-message ${message.role}${selected?.kind === "message" && selected.id === message.id ? " is-selected" : ""}`} aria-label={message.role === "user" ? "You" : "HypeMan"} tabIndex={0}
            onClick={(event) => { if (!(event.target as Element).closest("a,button")) setSelected({ kind: "message", id: message.id, text: message.text, title: "Conversation message" }); }}
            onKeyDown={(event) => { if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) { event.preventDefault(); setSelected({ kind: "message", id: message.id, text: message.text, title: "Conversation message" }); } }}>
            <MessageContent text={message.text} compact={message.role === "assistant"} onDocumentPage={(documentId, page) => { void executeTool("documents", "page", { documentId, page }).catch((cause) => setError(cause.message)); }} />
            {message === messages.at(-1) && message.role === "assistant" && /^PDF summary paused\./.test(message.text) && <button type="button" className="button" disabled={working} onClick={() => void send("Continue PDF summary").catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))}>Continue summary</button>}
            {message === messages.at(-1) && message.role === "assistant" && /^\d{1,2}:\d{2} AM or PM\?$/.test(message.text) && <div className="tool-actions" style={{ marginTop: 8 }} aria-label="Choose reminder time">{["AM", "PM"].map((period) => <button key={period} type="button" className="button" disabled={working} onClick={(event) => { event.stopPropagation(); void send(`${message.text.split(" ")[0]} ${period}`).catch((cause) => setError(cause.message)); }}>{message.text.split(" ")[0]} {period}</button>)}</div>}
          </article>)}
          {saved.length > 0 && <div className="saved-conversations" aria-label="Saved conversations">{saved.map((c) => <article key={c.id} tabIndex={0} onClick={() => void switchConversation(c.id)} onKeyDown={(e) => { if (e.key === "Enter") void switchConversation(c.id); }}>{c.title}</article>)}</div>}
          {working && !awaitingConfirmation && <div className="conversation-working" role="status"><span /><span /><span /><small title={progressLabel}>{progressLabel}</small>{activity?.site && <button type="button" className="button" aria-label={activity.phase === "confirming" ? "Review in working tab" : "Show working tab"} onClick={() => void request({ type: "conversation.activity.open", conversationId, runId: activity.runId }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))}>{activity.phase === "confirming" ? "Review" : "View"}</button>}</div>}
        </div>
        {snapshot?.confirmation && <div ref={approval} className="confirmation" role="alertdialog" aria-modal="true" aria-label="Confirm browser action" aria-describedby="browser-action-review" onKeyDown={approvalKeys}><div className="confirmation-status" role="status">Waiting for your confirmation</div><p id="browser-action-review" className="confirmation-review" tabIndex={0}>{snapshot.confirmation.message}</p><div className="confirmation-actions"><button type="button" className="button primary" onClick={() => runtime?.confirm(true)}>{snapshot.confirmation.label || "Continue"}</button><button type="button" className="button" onClick={() => runtime?.confirm(false)}>Cancel</button></div></div>}
        {confirmation && <div ref={approval} className="confirmation" role="alertdialog" aria-modal="true" aria-label="Confirm action" aria-describedby="local-action-review" onKeyDown={approvalKeys}><div className="confirmation-status" role="status">Waiting for your confirmation</div><p id="local-action-review" className="confirmation-review" tabIndex={0}>{confirmation}</p><div className="confirmation-actions"><button type="button" className="button primary" onClick={() => { confirmationAnswer.current?.(true); setConfirmation(null); field.current?.focus(); }}>{confirmationLabel}</button><button type="button" className="button" onClick={() => { confirmationAnswer.current?.(false); setConfirmation(null); field.current?.focus(); }}>Cancel</button></div></div>}
        {error && <Notice tone="error">{error}{failedRequest && <span className="conversation-recovery"><button type="button" className="button" disabled={working} onClick={() => void send(failedRequest, recoveryContext.current || undefined).catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); setFailedRequest(failedRequest); })}>Retry</button><button type="button" className="button" disabled={working} onClick={() => { setDraft(failedRequest); if (recoveryContext.current) { const original = recoveryContext.current; setSelected(original.selected); state.current.selected = original.selected; setTool(original.tool); setImage(original.image); runtime?.setSelectedContent?.(original.selected); runtime?.attachImage?.(original.image); } setError(""); setFailedRequest(""); field.current?.focus(); }}>Edit</button></span>}</Notice>}
        {selected && selected.kind !== "message" && <div className="conversation-attachment-chip" aria-label="Selected context"><Icon name={["pdf", "document", "documents"].includes(selected.kind) ? "documents" : selected.kind === "video" ? "video" : selected.kind === "board" ? "sketch" : "notes"} /><span title={selected.text || selected.quote}>{selected.title || (selected.kind === "page" ? "Page selection" : selected.kind === "message" ? "Selected message" : selected.kind)}{selected.page ? ` · p. ${selected.page}` : ""}</span><button type="button" className="icon-button" aria-label="Clear selected context" title="Clear selected context" onClick={() => setSelected(null)}><Icon name="close" /></button></div>}
        {image && <div className="conversation-attachment-wrapper"><img className="conversation-attachment" src={image} alt="Attached image" /><button type="button" className="icon-button" aria-label="Remove image attachment" title="Remove image attachment" onClick={() => { setImage(null); runtime?.attachImage?.(null); }}><Icon name="close" /></button></div>}
        <form className="conversation-composer" onSubmit={submit} onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); void acceptFiles(event.clipboardData.files); } }}>
          <button type="button" className="conversation-attach" aria-label="Attach a file" title="Attach a file" onClick={() => files.current?.click()}><Icon name="paperclip" /></button>
          <textarea id="task-goal" ref={field} aria-label="What do you need?" placeholder="Ask anything…" rows={1} value={draft} maxLength={4000} disabled={!conversationId || hydrating} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
          {working ? <button type="button" aria-label="Stop" onClick={() => void cancelPending().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))}><Icon name="stop" /></button> : <button type="submit" aria-label="Send message" disabled={!draft.trim() || !conversationId || hydrating}><Icon name="arrow" /></button>}
        </form>
        <input ref={files} className="sr-only" type="file" aria-label="Choose a file" accept="application/pdf,image/*,video/*,.vtt,.srt" multiple onChange={(event) => { if (event.target.files?.length) void acceptFiles(event.target.files); event.target.value = ""; }} />
        </div>
        <WindowResizeHandles geometry={chatWindow} title="HypeMan" />
      </section>
      <ToolOverlay key={conversationId} section={tool} openSections={windows.open} onFocus={focusTool} conversationId={conversationId || "default"} sketch={sketch} pageVideo={snapshot?.video || undefined}
        onNativeVideoCommand={async (operation, args) => {
          if (!runtime) return;
          const text = operation === "seek" ? `seek to ${args.seconds ?? args.value ?? 0} seconds` : operation === "speed" ? `set speed to ${args.rate ?? args.value ?? 1}x` : operation === "summarize" ? "Summarize this video" : operation === "ask" ? String(args.question || args.text || "Explain this part of the video") : `${operation} video`;
          if (recoveryContext.current && pending.current) recoveryContext.current.runtimeAttempt = true;
          await runtime.send(text);
          if (runtime.getSnapshot().phase === "error") throw new Error(runtime.getSnapshot().messages.at(-1)?.text || "Video request failed.");
          return operation === "summarize" || operation === "ask" ? runtime.getSnapshot().video?.summary : undefined;
        }}
        onVideoSeek={runtime ? (seconds) => { void runtime.send(`seek to ${seconds} seconds`); } : undefined}
        onVideoCaptionsChange={(text) => { const timed = parseCaptions(text); runtime?.attachVideoCaptions?.(text.trim() ? timed.length ? timed : text.split(/\n+/).filter(Boolean).flatMap((line) => line.match(/[\s\S]{1,1800}/g) || []).map((text) => ({ start: 0, end: 0, text })) : null); }}
        onClose={(section) => { window.dispatchEvent(new Event("hypeman.cancel-tools")); closeTool(section); field.current?.focus(); }} onError={setError} />
      {captureRegion && <ScreenRegion onImage={(data) => regionAnswer.current?.(data)} onError={(cause) => { if (cause.name !== "AbortError") setError(cause.message); regionAnswer.current?.(null); }} />}
    </div>
  </WindowGeometryProvider></WorkbenchContext.Provider>;
}
