import {
  WorkspaceHost,
  WORKSPACE_KEY,
  isPaused,
  safePageUrl,
  parseAgentRequest,
  contextTool,
  parseAction,
  parseTaskAssessmentRequest,
  isRecord,
  type BrowserTask,
  type AgentReply,
  type SessionHandoff,
  type TaskProgress,
  type TaskMilestoneProgress,
  type NoteInput,
  type ChatGPTStatus,
  validMessagingTimezone,
  type MessagingPairingResult,
  parseReminderRecurrence,
  type LearningPlanAssessment,
  type ConversationActivity,
} from "@core";
import { GatewayClient } from "./client";
import { MESSAGING_ALARM, PhoneSync } from "./messaging";
import { workbenchMessage, type Conversation } from "./workbench";
import { handleDocumentMessage, documentRepository } from "./documents";
import { BackupService } from "./backup";
import { recallSearch } from "./recall";
import { StudyService } from "./study";
import { LearningPracticeService } from "./learning-practice";
import { handleFrameGrantMessage } from "./frame-grants";
import { ConversationAssistance } from "./conversation-assistance";
import { CONVERSATION_ACTIVITY_KEY, ConversationActivityCoordinator, type ActivityOwner } from "./conversation-activity";
import {
  settings,
  patchSettings,
  saveConnection,
  graph,
  learn,
  savePlan,
  clearLearning,
  currentPractice,
  savePracticeAttempt,
  mergeLearning,
} from "./storage";

const workspace = new WorkspaceHost({
  async load() {
    return (await chrome.storage.local.get(WORKSPACE_KEY))[WORKSPACE_KEY];
  },
  async save(value) {
    await chrome.storage.local.set({ [WORKSPACE_KEY]: value });
  },
});
const gateway = new GatewayClient(settings, globalThis.fetch.bind(globalThis), saveConnection);
const study = new StudyService({ load: async () => (await chrome.storage.local.get("hypeman.study"))["hypeman.study"], save: async value => { await chrome.storage.local.set({ "hypeman.study": value }); }, notes: async () => (await workspace.snapshot()).notes, conversations: () => workbenchMessage({ type: "conversation.list" }) as Promise<Conversation[]> });
const backup = new BackupService({ workspace: () => workspace.snapshot(), restoreWorkspace: value => workspace.restore(value), workbench: workbenchMessage, learning: graph, restoreLearning: mergeLearning, documents: documentRepository, study: () => study.snapshot(), restoreStudy: value => study.merge(value), preflightStudy: value => study.preflightMerge(value) });
const practice = new LearningPracticeService({ graph, enabled: async () => (await settings()).learningEnabled, save: savePracticeAttempt });
const phone = new PhoneSync(
  chrome.storage.local,
  () => workspace.snapshot(),
  (path, body) => gateway.post(path, body, crypto.randomUUID(), null, 15000),
  () => notify("messaging.changed"),
  async (request) => {
    await workbenchMessage({ type: "workbench.ui.patch", conversationId: request.conversationId, patch: { open: true } });
    return dispatchAssistant(request.goal, request.url, request.conversationId, true);
  },
);
const conversationAssistance = new ConversationAssistance({
  conversation: (conversationId) => workbenchMessage({ type: "conversation.open", conversationId }) as Promise<Conversation>,
  draft: (conversationId) => workbenchMessage({ type: "artifact.get", conversationId, kind: "reminder-draft" }),
  saveDraft: async (conversationId, draft) => { await workbenchMessage({ type: "artifact.put", conversationId, kind: "reminder-draft", value: draft }); },
  phoneStatus: async () => phone.rememberStatus(await gateway.post("/api/messaging/status", {}, crypto.randomUUID(), null, 15000)),
  schedule: async (text, dueAt, idempotencyKey, recurrence) => phone.rememberStatus(await gateway.post("/api/messaging/remind", { text, dueAt, idempotencyKey, ...(recurrence ? { recurrence } : {}) }, crypto.randomUUID(), null, 15000)),
});
const conversationActivity = new ConversationActivityCoordinator({
  load: async () => (await chrome.storage.session.get(CONVERSATION_ACTIVITY_KEY))[CONVERSATION_ACTIVITY_KEY],
  save: async (value) => { await chrome.storage.session.set({ [CONVERSATION_ACTIVITY_KEY]: value }); },
  changed: (conversationId, activity) => notify("conversation.activity", { conversationId, activity }),
  stopped: async (conversationId, activity, markerAlreadyWritten) => {
    const values = await chrome.storage.session.get(null);
    const affected = new Set([activity.tabId]);
    const handoffs: number[] = [];
    for (const [key, value] of Object.entries(values)) {
      if (!/^hypeman\.tab\.\d+$/.test(key) || !isRecord(value) || !isRecord(value.handoff) ||
          value.handoff.conversationId !== conversationId || value.handoff.runId !== activity.runId) continue;
      const owner = Number(key.slice("hypeman.tab.".length));
      affected.add(owner);
      handoffs.push(owner);
    }
    await Promise.all([...affected].map((owner) => notify("assistant.stopped", { conversationId, runId: activity.runId, markerAlreadyWritten }, owner)));
    gateway.cancelOwner(activity.tabId);
    for (const owner of handoffs) await setSession(owner, { handoff: null, nativeNavigation: null });
  },
});
const ready = (async () => {
  const raw = await chrome.storage.session.get("hypeman.session");
  if (!raw["hypeman.session"]) {
    await workspace.recover();
    await chrome.storage.session.set({ "hypeman.session": true });
  }
})();
const tabSessionKey = (id: number) => `hypeman.tab.${id}`;
const loginReturnKey = "hypeman.chatgpt.return";
const sessionWrites = new Map<number, Promise<unknown>>();
const NATIVE_NAVIGATION_TTL = 10_000;
interface NativeNavigation { url: string; at: number; target: "new-tab" }
const nativeCandidates = new Map<number, { openerTabId: number; createdAt: number }>();
const nativeAdoptions = new Map<number, Promise<void>>();
const pendingAssessments = new Map<string, {
  taskId: string; stepId: string; tabId: number; url: string; text: string;
  evidence: string; at: number;
}>();
function forgetAssessments(tabId: number) {
  for (const [id, assessment] of pendingAssessments)
    if (assessment.tabId === tabId) pendingAssessments.delete(id);
}
const jsonSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "HypeMan couldn't complete that request.";

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  return (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] ?? null;
}
async function notify(
  type: string,
  payload: Record<string, unknown> = {},
  tabId?: number | null,
): Promise<void> {
  const event = { ...payload, type: `hypeman.${type}` };
  if (tabId !== undefined && tabId !== null) {
    await chrome.tabs.sendMessage(tabId, event).catch(() => {});
    return;
  }
  await chrome.runtime.sendMessage(event).catch(() => {});
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.all(
    tabs.map((t) =>
      t.id === undefined ? undefined : chrome.tabs.sendMessage(t.id, event).catch(() => {}),
    ),
  );
}
const companionSections = new Set(["tasks", "notes", "activity", "settings", "learning", "board", "video", "documents", "connection"]);
async function openCompanion(section: unknown = null) {
  const selected = typeof section === "string" && companionSections.has(section) ? section : null;
  const tab = await activeTab();
  if (tab?.id !== undefined && safePageUrl(tab.url) && !isPaused(await settings(), tab.url ?? "")) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "hypeman.command", name: "open-tools", section: selected });
      return;
    } catch { /* Open the same inline tools on the rooftop if this page has no content script. */ }
  }
  const home = chrome.runtime.getURL("newtab.html");
  const destination = `${home}#${selected || "chat"}`;
  if (tab?.id !== undefined && (tab.url?.startsWith(home) || tab.url === "chrome://newtab/"))
    await chrome.tabs.update(tab.id, { url: destination });
  else await chrome.tabs.create({ url: destination });
}
async function session(id: number): Promise<Record<string, unknown>> {
  const raw = (await chrome.storage.session.get(tabSessionKey(id)))[tabSessionKey(id)];
  return isRecord(raw) ? raw : {};
}
function activityOwner(tab: chrome.tabs.Tab, documentId?: string, destination?: string): ActivityOwner {
  let site = "";
  try { site = new URL(destination || tab.url || "").hostname; } catch { /* about:blank is prepared before navigation. */ }
  return { tabId: tab.id!, ...(documentId ? { documentId } : {}), site,
    title: (tab.title || "").replace(/[\u0000-\u001f]/g, " ").slice(0, 200) };
}
async function transferActivity(handoff: unknown, sourceId: number | null, target: chrome.tabs.Tab, documentId?: string, destination?: string): Promise<void> {
  if (!isRecord(handoff) || typeof handoff.runId !== "string") return;
  if (typeof handoff.conversationId !== "string" || sourceId === null ||
      !await conversationActivity.transfer(handoff.conversationId, handoff.runId, { tabId: sourceId, documentId }, activityOwner(target, undefined, destination)))
    throw new DOMException("This request was stopped or moved to another page.", "AbortError");
}
async function assertContinuation(handoff: unknown, ownerId: number): Promise<void> {
  if (isRecord(handoff) && !handoff.checkpoint && typeof handoff.runId === "string" &&
      (typeof handoff.conversationId !== "string" || !await conversationActivity.canResume(handoff.conversationId, handoff.runId, ownerId)))
    throw new DOMException("This request was stopped or moved to another page.", "AbortError");
}
async function assertOutgoing(handoff: unknown, ownerId: number | null, documentId?: string): Promise<void> {
  if (!isRecord(handoff) || typeof handoff.runId !== "string") return;
  if (typeof handoff.conversationId !== "string" || ownerId === null) throw new DOMException("Stopped request", "AbortError");
  await conversationActivity.assertOwner(handoff.conversationId, handoff.runId, { tabId: ownerId, documentId }, true);
}
async function setSession(id: number, patch: Record<string, unknown>): Promise<void> {
  const operation = (sessionWrites.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (isRecord(patch.handoff) && !patch.handoff.checkpoint && typeof patch.handoff.runId === "string" &&
          (typeof patch.handoff.conversationId !== "string" || !conversationActivity.allowsHandoff(patch.handoff.conversationId, patch.handoff.runId, id)))
        throw new DOMException("Stopped request", "AbortError");
      await chrome.storage.session.set({
        [tabSessionKey(id)]: { ...(await session(id)), ...patch, updatedAt: Date.now() },
      });
      if (isRecord(patch.handoff) && !patch.handoff.checkpoint && typeof patch.handoff.runId === "string" && typeof patch.handoff.conversationId === "string" &&
          !conversationActivity.allowsHandoff(patch.handoff.conversationId, patch.handoff.runId, id)) {
        await chrome.storage.session.set({ [tabSessionKey(id)]: { ...(await session(id)), handoff: null, nativeNavigation: null, updatedAt: Date.now() } });
        throw new DOMException("Stopped request", "AbortError");
      }
    });
  sessionWrites.set(id, operation);
  try {
    await operation;
  } finally {
    if (sessionWrites.get(id) === operation) sessionWrites.delete(id);
  }
}
function continuationHandoff(value: unknown): SessionHandoff | null {
  if (!isRecord(value) || typeof value.goal !== "string" || !value.goal.trim() || value.goal.length > 2000 ||
      !Number.isInteger(value.step) || Number(value.step) < 0 || !Array.isArray(value.history) || value.history.length > 40 ||
      (value.message !== undefined && (typeof value.message !== "string" || value.message.length > 3000)) ||
      (value.conversationId !== undefined && (typeof value.conversationId !== "string" || !/^[\w.-]{1,160}$/.test(value.conversationId))) ||
      (value.runId !== undefined && (typeof value.runId !== "string" || !/^[\w.-]{1,160}$/.test(value.runId))) ||
      value.history.some((entry) => !isRecord(entry) || !parseAction(entry.action) || !isRecord(entry.result) ||
        typeof entry.result.ok !== "boolean" || typeof entry.result.changed !== "boolean" ||
        typeof entry.result.message !== "string" || typeof entry.at !== "number" || !Number.isFinite(entry.at))) return null;
  return value as unknown as SessionHandoff;
}
function nativeNavigationIntent(value: unknown): NativeNavigation | null {
  if (!isRecord(value) || value.target !== "new-tab" || typeof value.at !== "number" || !Number.isFinite(value.at)) return null;
  const url = safePageUrl(value.url);
  return url ? { url, at: value.at, target: "new-tab" } : null;
}
/** Follow only the new tab created by an explicitly prepared native link, never an unrelated tab. */
async function adoptNativeNavigation(targetId: number): Promise<void> {
  const candidate = nativeCandidates.get(targetId);
  if (!candidate) return;
  const previous = nativeAdoptions.get(candidate.openerTabId) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    await ready;
    if (nativeCandidates.get(targetId) !== candidate || Date.now() - candidate.createdAt > NATIVE_NAVIGATION_TTL) {
      nativeCandidates.delete(targetId); return;
    }
    const source = await session(candidate.openerTabId);
    const intent = nativeNavigationIntent(source.nativeNavigation), handoff = continuationHandoff(source.handoff);
    if (!intent || !handoff || candidate.createdAt < intent.at || Date.now() - intent.at > NATIVE_NAVIGATION_TTL ||
        intent.at > Date.now() + 1000) return;
    const target = await chrome.tabs.get(targetId).catch(() => null);
    if (!target || target.openerTabId !== candidate.openerTabId || safePageUrl(target.url || target.pendingUrl) !== intent.url) return;
    const config = await settings();
    const opener = await chrome.tabs.get(candidate.openerTabId).catch(() => null);
    if (!opener || !safePageUrl(opener.url) || isPaused(config, opener.url!) || isPaused(config, intent.url)) return;
    const state = await workspace.snapshot();
    const task = state.tasks.find((item) => item.id === state.activeTaskId && item.status === "running" && item.tabId === candidate.openerTabId);
    if (handoff.taskId && handoff.taskId !== task?.id) return;
    const current = await session(candidate.openerTabId), currentIntent = nativeNavigationIntent(current.nativeNavigation);
    if (!currentIntent || currentIntent.at !== intent.at || currentIntent.url !== intent.url ||
        JSON.stringify(current.handoff) !== JSON.stringify(source.handoff)) return;
    await transferActivity(handoff, candidate.openerTabId, target, undefined, intent.url);
    if (task) await workspace.resume(task.id, targetId);
    await setSession(targetId, {
      handoff, conversation: source.conversation ?? [],
      conversationId: handoff.conversationId || source.conversationId, nativeNavigation: null,
    });
    // Consume before dispatch so repeated onCreated/onUpdated events cannot start two continuations.
    await setSession(candidate.openerTabId, { handoff: null, nativeNavigation: null });
    nativeCandidates.delete(targetId);
    if (task) await notify("task.stopped", { taskId: task.id }, candidate.openerTabId);
    try {
      await chrome.tabs.sendMessage(targetId, task ? {
        type: "hypeman.task.run", taskId: task.id, goal: task.goal, handoff,
      } : { type: "hypeman.assistant.run", goal: handoff.goal, handoff });
    } catch {
      // The destination may not have reached document_idle; its normal content script also
      // hydrates this persisted handoff. Injection covers an already loaded page without a receiver.
      await chrome.scripting.executeScript({ target: { tabId: targetId }, files: ["content.js"] }).catch(() => {});
    }
  });
  nativeAdoptions.set(candidate.openerTabId, operation);
  try { await operation; }
  finally { if (nativeAdoptions.get(candidate.openerTabId) === operation) nativeAdoptions.delete(candidate.openerTabId); }
}
async function stopTask(task: BrowserTask | undefined): Promise<void> {
  if (!task) return;
  if (task.tabId !== null) {
    forgetAssessments(task.tabId);
    gateway.cancelOwner(task.tabId);
    await notify("task.stopped", { taskId: task.id }, task.tabId);
  }
}
async function dispatchTask(
  task: BrowserTask,
  source: chrome.tabs.Tab | null,
  url?: string,
): Promise<BrowserTask> {
  const targetUrl = safePageUrl(url) || task.lastPage?.url;
  if (
    source?.id !== undefined &&
    safePageUrl(source.url) &&
    (!targetUrl || targetUrl === source.url)
  ) {
    if (isPaused(await settings(), source.url!))
      throw new Error("Resume HypeMan on this site first.");
    const owned = await workspace.resume(task.id, source.id);
    try {
      await chrome.tabs.sendMessage(source.id, {
        type: "hypeman.task.run",
        taskId: task.id,
        goal: task.goal,
      });
    } catch {
      await setSession(source.id, {
        handoff: { taskId: task.id, goal: task.goal, history: [], step: 0, at: Date.now(), conversationId: task.conversationId },
        ...(task.conversationId ? { conversationId: task.conversationId } : {}),
      });
      await chrome.scripting.executeScript({ target: { tabId: source.id }, files: ["content.js"] });
    }
    return owned;
  }
  const config = await settings();
  const destination =
    targetUrl ||
    `https://www.google.com/search?q=${encodeURIComponent(task.goal)}`;
  if (isPaused(config, destination)) throw new Error("HypeMan is paused on the destination site.");
  // Create blank first: the resume payload exists before a content script can hydrate.
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  if (tab.id === undefined) throw new Error("Couldn't open a browser tab.");
  const owned = await workspace.resume(task.id, tab.id);
  await setSession(tab.id, {
    handoff: { taskId: task.id, goal: task.goal, history: [], step: 0, at: Date.now(), conversationId: task.conversationId },
    ...(task.conversationId ? { conversationId: task.conversationId } : {}),
  });
  await chrome.tabs.update(tab.id, { url: destination });
  return owned;
}
/** The rooftop composer starts a conversation; only a proposed multi-step plan becomes a project. */
async function dispatchAssistant(goal: string, suppliedUrl?: string, conversationId?: string, freshTab = false): Promise<{ tabId: number }> {
  const check = conversationAssistance.checkpoint(conversationId);
  const config = await settings();
  const linkedUrl = goal.match(/https?:\/\/[^\s<>"']+/i)?.[0]?.replace(/[),.!?;]+$/, "");
  const destination = safePageUrl(suppliedUrl || linkedUrl);
  if (suppliedUrl && !destination) throw new Error("Choose an ordinary website URL.");
  if (destination && isPaused(config, destination))
    throw new Error("HypeMan is paused on the destination site.");
  const state = await workspace.snapshot();
  const owner = state.tasks.find((task) => task.id === state.activeTaskId && task.status === "running");
  const active = await activeTab();
  let source = active && safePageUrl(active.url) && !isPaused(config, active.url!) ? active : null;
  if (!source && owner?.tabId !== null && owner?.tabId !== undefined) {
    const owned = await chrome.tabs.get(owner.tabId).catch(() => null);
    if (owned && safePageUrl(owned.url) && !isPaused(config, owned.url!)) source = owned;
  }
  if (!source && !destination) {
    const websites = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"], currentWindow: true });
    source = websites.filter((tab) => tab.id !== undefined && !isPaused(config, tab.url ?? ""))
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0] ?? null;
  }
  const runId = conversationId ? crypto.randomUUID() : undefined;
  const handoff: SessionHandoff = { goal, history: [], step: 0, at: Date.now(), ...(conversationId ? { conversationId, runId } : {}) };
  check();
  if (!freshTab && source?.id !== undefined && (!destination || safePageUrl(source.url) === destination)) {
    if (conversationId && runId) await conversationActivity.start(conversationId, runId, activityOwner(source));
    check();
    await setSession(source.id, { handoff, ...(conversationId ? { conversationId } : {}) });
    check();
    await assertContinuation(handoff, source.id);
    await chrome.tabs.update(source.id, { active: true });
    await chrome.windows.update(source.windowId, { focused: true });
    check();
    await assertContinuation(handoff, source.id);
    try {
      await chrome.tabs.sendMessage(source.id, { type: "hypeman.assistant.run", goal, handoff });
    } catch {
      check();
      await assertContinuation(handoff, source.id);
      await chrome.scripting.executeScript({ target: { tabId: source.id }, files: ["content.js"] });
    }
    return { tabId: source.id };
  }
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  if (tab.id === undefined) throw new Error("Couldn't open a browser tab.");
  try { check(); } catch (error) { await chrome.tabs.remove(tab.id).catch(() => {}); throw error; }
  if (conversationId && runId) await conversationActivity.start(conversationId, runId, activityOwner(tab, undefined, destination || "https://www.google.com"));
  check();
  await setSession(tab.id, { handoff, ...(conversationId ? { conversationId } : {}) });
  check();
  await assertContinuation(handoff, tab.id);
  await chrome.tabs.update(tab.id, {
    url: destination || `https://www.google.com/search?q=${encodeURIComponent(goal)}`,
  });
  return { tabId: tab.id };
}
const API_PATHS = new Set([
  "/api/learn/plan",
  "/api/learn/judge",
  "/api/learn/teachback",
  "/api/video",
  "/api/document",
  "/api/ink",
  "/api/lookup",
]);
const PAGE_WORK = new Set([
  "agent.decide",
  "api",
  "input",
  "screenshot",
  "nav.navigate",
  "nav.back",
  "nav.switch",
  "learn.event",
  "tabs.list",
  "task.assess",
  "task.step.verify",
  "task.step.confirm",
  "task.follow",
  "assistant.run",
  "task.start",
]);
function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  try {
    const url = new URL(sender.url ?? "");
    return url.protocol === "chrome-extension:" && url.hostname === chrome.runtime.id;
  } catch {
    return false;
  }
}
/** Keep credentials and unexpected gateway fields outside the UI message boundary. */
function safeChatGPTStatus(value: unknown): ChatGPTStatus {
  if (
    !isRecord(value) ||
    typeof value.connected !== "boolean" ||
    typeof value.sharing !== "boolean" ||
    typeof value.pending !== "boolean" ||
    !(value.activeProfileId === null || typeof value.activeProfileId === "string") ||
    !Array.isArray(value.profiles) ||
    value.profiles.length > 100
  )
    throw new Error("Invalid ChatGPT connection status.");
  const profiles = value.profiles.map((profile) => {
    if (
      !isRecord(profile) ||
      typeof profile.id !== "string" ||
      typeof profile.label !== "string" ||
      typeof profile.connected !== "boolean" ||
      typeof profile.sharing !== "boolean"
    )
      throw new Error("Invalid ChatGPT account status.");
    return {
      id: profile.id,
      label: profile.label,
      ...(typeof profile.email === "string" ? { email: profile.email } : {}),
      connected: profile.connected,
      sharing: profile.sharing,
    };
  });
  const models = Array.isArray(value.models)
    ? value.models.map((model) => {
        if (
          !isRecord(model) ||
          typeof model.slug !== "string" ||
          typeof model.displayName !== "string"
        )
          throw new Error("Invalid ChatGPT model status.");
        return { slug: model.slug, displayName: model.displayName };
      })
    : undefined;
  return {
    connected: value.connected,
    sharing: value.sharing,
    pending: value.pending,
    activeProfileId: value.activeProfileId,
    profiles,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(typeof value.warning === "string" ? { warning: value.warning } : {}),
    ...(models ? { models } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
  };
}
function chatGPTChoice(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 200 ||
    /[\u0000-\u001f]/.test(value)
  )
    throw new Error(`Choose a valid ChatGPT ${label}.`);
  return value;
}
async function handle(
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  const conversationId = message.type === "agent.decide" && isRecord(message.input) ? message.input.conversationId : message.conversationId;
  const checkConversation = conversationAssistance.checkpoint(typeof conversationId === "string" ? conversationId : undefined);
  await ready;
  const type = message.type,
    id = typeof message.requestId === "string" ? message.requestId : crypto.randomUUID();
  const tabId = sender.tab?.id ?? null;
  const config = await settings();
  if (typeof type !== "string") throw new Error("Invalid request");
  if (type.startsWith("study.") || type === "library.search") {
    if (sender.id !== chrome.runtime.id) throw new Error("Unknown study caller.");
    return type === "library.search" ? study.search(message) : study.handle(message);
  }
  if (type.startsWith("backup.")) {
    if (sender.id !== chrome.runtime.id) throw new Error("Unknown backup caller.");
    return backup.handle(message, `${sender.id}:${sender.tab?.id ?? "extension"}:${sender.frameId ?? 0}:${sender.documentId ?? sender.url ?? ""}`);
  }
  const frameResult = handleFrameGrantMessage(message, sender);
  if (frameResult) return frameResult;
  if ((type.startsWith("chatgpt.") || type === "connection.ensure") && !isExtensionPage(sender))
    throw new Error("Manage ChatGPT sign-in from HypeMan’s Connection page or Settings.");
  if (type.startsWith("messaging.") && type !== "messaging.send" && !isExtensionPage(sender))
    throw new Error("Manage your phone companion from HypeMan’s Settings.");
  const documentResult = handleDocumentMessage(message, sender);
  if (documentResult) return documentResult;
  if (PAGE_WORK.has(type) && !(type === "api" && message.path === "/api/document") && isPaused(config, sender.tab?.url ?? sender.url ?? ""))
    throw new Error("HypeMan is paused on this site.");
  switch (type) {
    case "conversation.resolve":
    case "conversation.select": {
      const ownerId = tabId ?? (isExtensionPage(sender) && Number.isInteger(message.tabId) ? Number(message.tabId) : null);
      const current = ownerId === null ? {} : await session(ownerId);
      const conversationId = message.conversationId ?? current.conversationId ?? crypto.randomUUID();
      const conversation = await workbenchMessage({ type: "conversation.open", conversationId });
      if (ownerId !== null) await setSession(ownerId, { conversationId });
      return conversation;
    }
    case "conversation.activity.get": {
      const activity = await conversationActivity.get(message.conversationId);
      if (activity && !await chrome.tabs.get(activity.tabId).catch(() => null)) {
        await conversationActivity.removeOwner(activity.tabId);
        return null;
      }
      return activity;
    }
    case "conversation.activity.start":
    case "conversation.activity.update":
    case "conversation.activity.end": {
      if (tabId === null) throw new Error("Open a browser tab to run this request.");
      if (message.continuation !== undefined && typeof message.continuation !== "boolean") throw new Error("Choose a valid continuation.");
      if (type === "conversation.activity.end")
        return conversationActivity.end(message.conversationId, message.runId, { tabId, documentId: sender.documentId });
      const tab = await chrome.tabs.get(tabId);
      if (!safePageUrl(tab.url) || isPaused(config, tab.url!)) throw new Error("HypeMan is unavailable on this page.");
      const owner = activityOwner(tab, sender.documentId);
      return type === "conversation.activity.start"
        ? conversationActivity.start(message.conversationId, message.runId, owner, message.continuation === true)
        : conversationActivity.update(message.conversationId, message.runId, owner, message.phase, message.status);
    }
    case "conversation.activity.open": {
      const activity = await conversationActivity.get(message.conversationId);
      if (!activity || activity.runId !== message.runId) throw new Error("This browser request has finished.");
      const tab = await chrome.tabs.get(activity.tabId).catch(() => null);
      if (!tab || !safePageUrl(tab.url) || isPaused(config, tab.url!)) throw new Error("That browser page is unavailable.");
      const current = await conversationActivity.get(message.conversationId);
      if (current?.runId !== activity.runId || current.tabId !== activity.tabId) throw new Error("This browser request has finished.");
      await chrome.tabs.update(activity.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { ok: true };
    }
    case "conversation.append": {
      const result = await workbenchMessage(message);
      await notify("conversation.changed", { conversationId: message.conversationId });
      return result;
    }
    case "conversation.open":
    case "conversation.list":
    case "artifact.get":
    case "artifact.put":
    case "workbench.export":
    case "workbench.ui.get":
    case "workbench.ui.patch":
      return workbenchMessage(message);
    case "workspace.get":
      return workspace.snapshot();
    case "recall.search": {
      if (typeof message.query !== "string" || message.kinds !== undefined && (!Array.isArray(message.kinds) || message.kinds.some(kind => kind !== "note" && kind !== "conversation"))) throw new Error("Choose a valid saved-work search.");
      const [saved, conversations] = await Promise.all([workspace.snapshot(), workbenchMessage({ type: "conversation.list" }) as Promise<Conversation[]>]);
      return recallSearch(message.query, saved.notes, conversations, { kinds: message.kinds as ("note" | "conversation")[] | undefined, limit: message.limit as number | undefined }, input => gateway.post("/api/recall/rank", input, id, tabId, 15000));
    }
    case "recall.get": {
      if (!["note", "conversation"].includes(String(message.kind)) || typeof message.id !== "string" || !/^[\w.:-]{1,160}$/.test(message.id)) throw new Error("Choose a saved source.");
      if (message.kind === "note") return (await workspace.snapshot()).notes.find(note => note.id === message.id) || null;
      return ((await workbenchMessage({ type: "conversation.list" })) as Conversation[]).find(conversation => conversation.id === message.id) || null;
    }
    case "settings.get":
      return config;
    case "settings.patch": {
      const updated = await patchSettings(message.patch);
      await notify("settings.changed", { settings: updated });
      if (updated.hiddenOnHosts.some((host) => !config.hiddenOnHosts.includes(host))) {
        for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }))
          if (tab.id !== undefined && isPaused(updated, tab.url ?? "")) gateway.cancelOwner(tab.id);
        const state = await workspace.snapshot(),
          current = state.tasks.find((t) => t.id === state.activeTaskId);
        if (current?.tabId !== null && current?.tabId !== undefined) {
          const tab = await chrome.tabs.get(current.tabId).catch(() => null);
          if (tab && isPaused(updated, tab.url ?? "")) {
            await stopTask(current);
            await workspace.pause(current.id);
          }
        }
      }
      return updated;
    }
    case "health":
      return gateway.post("/health", undefined, id, tabId, 4000);
    case "messaging.status":
      return phone.rememberStatus(await gateway.post("/api/messaging/status", {}, id, tabId, 15000));
    case "messaging.inbox":
      if (message.refresh !== undefined && typeof message.refresh !== "boolean")
        throw new Error("Choose whether to refresh the phone inbox.");
      return phone.inbox(message.refresh !== false);
    case "messaging.pair": {
      if (typeof message.phone !== "string" || !/^[+\d ()-]{7,40}$/.test(message.phone))
        throw new Error("Enter your phone number, including its country code.");
      const result = await gateway.post<unknown>("/api/messaging/pair", { phone: message.phone }, id, tabId, 15000);
      if (!isRecord(result) || typeof result.code !== "string" || !/^[A-Z0-9 -]{4,30}$/.test(result.code) ||
          typeof result.expiresAt !== "number" || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() ||
          (result.deliveryStatus !== undefined && result.deliveryStatus !== "sent" && result.deliveryStatus !== "unknown"))
        throw new Error("The local server returned an invalid phone pairing code.");
      await phone.sync(true).catch(() => {});
      return { code: result.code, expiresAt: result.expiresAt, deliveryStatus: result.deliveryStatus === "sent" ? "sent" : "unknown" } satisfies MessagingPairingResult;
    }
    case "messaging.unpair":
      await phone.rememberStatus(await gateway.post("/api/messaging/unpair", {}, id, tabId, 15000));
      await phone.sync(true).catch(() => {});
      return { ok: true };
    case "messaging.settings": {
      if (!isRecord(message.patch)) throw new Error("Choose valid phone companion settings.");
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(message.patch)) {
        if (["coachingEnabled", "projectUpdates", "proactiveEnabled"].includes(key) && typeof value === "boolean")
          patch[key] = value;
        else if (["morningTime", "eveningTime"].includes(key) && typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value))
          patch[key] = value;
        else if (key === "timezone" && validMessagingTimezone(value)) patch[key] = value;
        else throw new Error("Choose valid phone companion settings.");
      }
      return phone.rememberStatus(await gateway.post("/api/messaging/settings", { patch }, id, tabId, 15000));
    }
    case "messaging.send": {
      if (typeof message.text !== "string" || !message.text.trim() || message.text.length > 6000)
        throw new Error("Choose text to send in 6,000 characters or fewer.");
      if (!isExtensionPage(sender) && isPaused(config, sender.tab?.url ?? sender.url ?? ""))
        throw new Error("HypeMan is paused on this site.");
      // The gateway always uses the paired owner; callers cannot choose another recipient.
      return phone.rememberStatus(await gateway.post("/api/messaging/send", { text: message.text.trim() }, id, tabId, 30000));
    }
    case "messaging.remind": {
      if (typeof message.text !== "string" || !message.text.trim() || message.text.length > 2000 ||
          typeof message.dueAt !== "number" || !Number.isFinite(message.dueAt) || message.dueAt <= Date.now() || message.dueAt > Date.now() + 366 * 86400000)
        throw new Error("Give a reminder and a future time within one year.");
      const recurrence = message.recurrence === undefined ? undefined : parseReminderRecurrence(message.recurrence);
      if (message.recurrence !== undefined && !recurrence) throw new Error("Choose a valid repeating reminder schedule.");
      return phone.rememberStatus(await gateway.post("/api/messaging/remind", { text: message.text.trim(), dueAt: message.dueAt, ...(recurrence ? { recurrence } : {}) }, id, tabId, 15000));
    }
    case "messaging.reminders": {
      const minutes = message.minutes ?? 30;
      if (typeof message.id !== "string" || !message.id.trim() || message.id.length > 300 ||
          !["cancel", "snooze", "pause", "resume", "skip"].includes(String(message.operation)) ||
          (message.operation === "snooze" && (!Number.isInteger(minutes) || Number(minutes) < 1 || Number(minutes) > 10080)))
        throw new Error("Choose a reminder and a valid snooze time.");
      return phone.rememberStatus(await gateway.post("/api/messaging/reminders", {
        operation: message.operation, id: message.id,
        ...(message.operation === "snooze" ? { minutes } : {}),
      }, id, tabId, 15000));
    }
    case "messaging.continue":
      return phone.continue(message.id, (capture) => {
        if (capture.text.length > 2000)
          throw new Error("This capture is longer than a browser request. Copy a shorter version into HypeMan's composer; the full capture stays in your inbox.");
        return dispatchAssistant(capture.text, capture.url);
      });
    case "messaging.dismiss":
      await phone.dismiss(message.id);
      return { ok: true };
    case "pair.check":
      await gateway.post("/api/cancel", { requestId: "hypeman-pair-check" }, id, tabId, 4000);
      return { paired: true };
    case "connection.ensure":
      await gateway.post("/api/cancel", { requestId: "hypeman-connection-check" }, id, tabId, 4000);
      return gateway.post("/health", undefined, id, tabId, 4000);
    case "chatgpt.status": {
      const status = safeChatGPTStatus(await gateway.post("/api/chatgpt/status", {}, id, tabId, 45000));
      if (status.connected && status.sharing && !config.onboarded) await patchSettings({ onboarded: true });
      return status;
    }
    case "chatgpt.login": {
      if (message.newProfile !== undefined && typeof message.newProfile !== "boolean")
        throw new Error("Choose whether to add a ChatGPT account.");
      const profileId =
        message.profileId === undefined ? undefined : chatGPTChoice(message.profileId, "account");
      if (profileId && message.newProfile === true)
        throw new Error("Choose a saved account or add a new one.");
      const result = await gateway.post<unknown>(
        "/api/chatgpt/login",
        {
          ...(profileId ? { profileId } : {}),
          ...(message.newProfile === true ? { newProfile: true } : {}),
        },
        id,
        tabId,
        10000,
      );
      try {
        if (!isRecord(result) || typeof result.url !== "string")
          throw new Error("The local server returned an invalid ChatGPT sign-in address.");
        const url = new URL(result.url);
        if (
          url.origin !== "https://auth.openai.com" ||
          url.pathname !== "/api/accounts/authorize" ||
          url.username ||
          url.password ||
          url.hash
        )
          throw new Error("The local server returned an invalid ChatGPT sign-in address.");
        const loginTab = await chrome.tabs.create({ url: url.href, active: true });
        if (tabId !== null && loginTab.id !== undefined) {
          await chrome.storage.session.set({
            [loginReturnKey]: {
              sourceTabId: tabId,
              loginTabId: loginTab.id,
              callback: url.searchParams.get("redirect_uri"),
              at: Date.now(),
            },
          });
        }
      } catch (error) {
        await gateway
          .post("/api/chatgpt/cancel", {}, crypto.randomUUID(), tabId, 4000)
          .catch(() => {});
        throw error;
      }
      return { pending: true };
    }
    case "chatgpt.cancel":
    case "chatgpt.logout":
      await chrome.storage.session.remove(loginReturnKey);
      await gateway.post(
        `/api/chatgpt/${type.slice(8)}`,
        {},
        id,
        tabId,
        type === "chatgpt.logout" ? 35000 : 10000,
      );
      return { ok: true };
    case "chatgpt.select":
      await gateway.post(
        "/api/chatgpt/select",
        { profileId: chatGPTChoice(message.profileId, "account") },
        id,
        tabId,
        10000,
      );
      return { ok: true };
    case "chatgpt.model":
      await gateway.post(
        "/api/chatgpt/model",
        { model: chatGPTChoice(message.model, "model") },
        id,
        tabId,
        35000,
      );
      return { ok: true };
    case "request.cancel": {
      const pending = pendingAssessments.get(id);
      const cancelled = !!pending && pending.tabId === tabId;
      if (cancelled) pendingAssessments.delete(id);
      return { cancelled: gateway.cancel(id, tabId) || cancelled };
    }
    case "assistant.run": {
      if (typeof message.goal !== "string" || !message.goal.trim() || message.goal.length > 2000)
        throw new Error("Describe what you need in 2,000 characters or fewer.");
      if (message.url !== undefined && typeof message.url !== "string")
        throw new Error("Choose an ordinary website URL.");
      return dispatchAssistant(message.goal.trim(), message.url as string | undefined,
        typeof message.conversationId === "string" && /^[\w.-]{1,160}$/.test(message.conversationId) ? message.conversationId : undefined);
    }
    case "conversation.cancel-pending": {
      if (message.markerAlreadyWritten !== undefined && typeof message.markerAlreadyWritten !== "boolean") throw new Error("Choose a valid stop request.");
      const draftCancellation = conversationAssistance.cancel(message.conversationId).catch(() => {});
      // Invalidate the activity before notifying runtimes or waiting for saved chat writes.
      const stopped = await conversationActivity.cancel(message.conversationId, async (activity) => {
        if (message.markerAlreadyWritten === true) return true;
        try {
          await workbenchMessage({ type: "conversation.append", conversationId: message.conversationId,
            message: { id: crypto.randomUUID(), role: "status", text: "Stopped. Completed work is saved." } });
          await notify("conversation.changed", { conversationId: message.conversationId });
          return true;
        } catch { return false; }
      });
      if (stopped) {
        const state = await workspace.snapshot();
        const task = state.tasks.find((item) => item.id === state.activeTaskId && item.status === "running" && item.tabId === stopped.tabId &&
          (!item.conversationId || item.conversationId === message.conversationId));
        if (task) await workspace.pause(task.id);
      }
      await draftCancellation;
      return { ok: true, stopped: !!stopped, ...(stopped ? { runId: stopped.runId } : {}) };
    }
    case "conversation.assist":
    case "assistant.turn": {
      if (typeof message.message !== "string" || !message.message.trim() || message.message.length > 4000 ||
          typeof message.conversationId !== "string" || !/^[\w.-]{1,160}$/.test(message.conversationId))
        throw new Error("Ask a question in 4,000 characters or fewer.");
      const conversation = await workbenchMessage({ type: "conversation.open", conversationId: message.conversationId }) as Conversation;
      const input = parseAgentRequest({
        requestId: id, surface: "conversation", conversationId: conversation.id,
        goal: message.goal === undefined ? message.message.slice(0, 2000) : message.goal, message: message.message, history: message.history ?? [], task: null, mode: "browse",
        ...(message.toolContext ? { toolContext: message.toolContext } : {}),
        ...(message.image ? { screenshot: message.image } : {}),
        page: { url: "", title: conversation.title, headings: [], elements: [], errors: [], successes: [], selection: "",
          frames: { count: 0, inaccessible: 0 }, capturedAt: Date.now(), revision: conversation.updatedAt,
          text: "" },
      });
      if (!input) throw new Error("Conversation context is too large. Select a shorter excerpt.");
      const prepared = await conversationAssistance.prepare(input, checkConversation);
      if (message.type === "conversation.assist") return { reply: prepared.reply || null, contextTool: contextTool(prepared.input) || null };
      let result: AgentReply;
      try { result = prepared.reply ?? await gateway.post<AgentReply>("/api/agent", prepared.input, id, tabId, 120000); }
      catch (error) { checkConversation(); throw error; }
      if (!prepared.reply) checkConversation();
      return result;
    }
    case "task.start": {
      if (typeof message.goal !== "string" || !message.goal.trim() || message.goal.length > 2000)
        throw new Error("Describe a task in 2,000 characters or fewer.");
      if (
        !Array.isArray(message.steps) || message.steps.length < 2 || message.steps.length > 20 ||
        !message.steps.every((step) => typeof step === "string" && step.trim() && step.length <= 200) ||
        new Set(message.steps.map((step) => (step as string).trim().toLowerCase())).size !== message.steps.length
      )
        throw new Error("A project needs 2–20 distinct, specific steps.");
      const current = await workspace.snapshot();
      await stopTask(current.tasks.find((t) => t.id === current.activeTaskId));
      const source = sender.tab ?? (await activeTab());
      const task = await workspace.start(
        message.goal,
        source?.id ?? null,
        source?.url ? { url: source.url, title: source.title ?? "" } : undefined,
        message.steps as string[],
        typeof message.conversationId === "string" ? message.conversationId : undefined,
      );
      if (message.dispatch === false) return task;
      try {
        return await dispatchTask(
          task,
          source,
          typeof message.url === "string" ? message.url : undefined,
        );
      } catch (error) {
        await workspace.pause(task.id);
        throw error;
      }
    }
    case "task.follow": {
      if (typeof message.id !== "string") throw new Error("Choose a project.");
      const source = sender.tab ?? (await activeTab());
      if (source?.id === undefined || !safePageUrl(source.url))
        throw new Error("Open a website to continue this project here.");
      if (isPaused(config, source.url!)) throw new Error("HypeMan is paused on this site.");
      const state = await workspace.snapshot();
      const selected = state.tasks.find((task) => task.id === message.id);
      if (!selected || !["running", "paused"].includes(selected.status))
        throw new Error("Choose an unfinished project.");
      await stopTask(state.tasks.find((task) => task.id === state.activeTaskId));
      const task = await workspace.resume(selected.id, source.id);
      await setSession(source.id, { handoff: null });
      try {
        await chrome.tabs.sendMessage(source.id, { type: "hypeman.task.follow", taskId: task.id });
      } catch {
        await chrome.scripting.executeScript({ target: { tabId: source.id }, files: ["content.js"] });
      }
      return task;
    }
    case "task.resume": {
      if (typeof message.id !== "string") throw new Error("Choose a task.");
      const state = await workspace.snapshot();
      await stopTask(state.tasks.find((t) => t.id === state.activeTaskId));
      const task = await workspace.resume(message.id, tabId);
      if (message.dispatch === false) return task;
      try {
        return await dispatchTask(task, sender.tab ?? (await activeTab()));
      } catch (error) {
        await workspace.pause(task.id);
        throw error;
      }
    }
    case "task.pause":
    case "task.cancel": {
      const state = await workspace.snapshot();
      const task = state.tasks.find((t) => t.id === (message.id ?? state.activeTaskId));
      await stopTask(task);
      await workspace.pause(task?.id, type === "task.cancel");
      return { ok: true };
    }
    case "task.progress": {
      if (
        typeof message.eventId !== "string" ||
        !message.eventId ||
        message.eventId.length > 160 ||
        typeof message.action !== "string" ||
        message.action.length > 80 ||
        typeof message.summary !== "string" ||
        message.summary.length > 2000 ||
        typeof message.ok !== "boolean" ||
        typeof message.url !== "string" ||
        message.url.length > 4096 ||
        typeof message.title !== "string" ||
        message.title.length > 500 ||
        (message.done !== undefined && typeof message.done !== "boolean") ||
        (message.changed !== undefined && typeof message.changed !== "boolean")
      )
        throw new Error("Invalid action evidence.");
      const state = await workspace.snapshot();
      const task = state.tasks.find((t) => t.id === (message.taskId ?? state.activeTaskId));
      if (task && task.tabId !== null && task.tabId !== tabId)
        throw new Error("This tab does not own the task.");
      await workspace.progress(message as unknown as TaskProgress, tabId);
      return { ok: true };
    }
    case "task.intent": {
      if (
        typeof message.taskId !== "string" ||
        typeof message.nextStep !== "string" ||
        !message.nextStep.trim() ||
        message.nextStep.length > 300
      )
        throw new Error("Invalid next step.");
      if (isPaused(config, sender.tab?.url ?? ""))
        throw new Error("HypeMan is paused on this site.");
      await workspace.intent(message.taskId, tabId, message.nextStep);
      return { ok: true };
    }
    case "task.assess": {
      const state = await workspace.snapshot();
      const task = state.tasks.find((item) => item.id === message.taskId);
      if (!task || task.id !== state.activeTaskId || task.status !== "running" || task.tabId !== tabId || tabId === null)
        throw new Error("This tab does not own the running project.");
      const input = parseTaskAssessmentRequest({ requestId: id, task, page: message.page, ...(message.completion ? { completion: message.completion } : {}) });
      if (!input) throw new Error("Invalid project page context.");
      if (isPaused(config, input.page.url)) throw new Error("HypeMan is paused on this site.");
      const source = await chrome.tabs.get(tabId);
      if (safePageUrl(source.url) !== safePageUrl(input.page.url))
        throw new Error("The project page changed. Observe it again.");
      const step = task.steps.find((item) => item.status !== "done");
      if (!step) return { task, assessment: { stepId: "", completed: false, evidence: "" } };
      const assessment = await gateway.post<unknown>("/api/task/assess", input, id, tabId, 120000);
      if (
        !isRecord(assessment) || assessment.stepId !== step.id ||
        typeof assessment.completed !== "boolean" || typeof assessment.evidence !== "string" ||
        assessment.evidence.length > 1000 ||
        (assessment.next !== undefined && (typeof assessment.next !== "string" || assessment.next.length > 300))
      )
        throw new Error("Invalid project completion evidence.");
      const latest = await workspace.snapshot();
      const current = latest.tasks.find((item) => item.id === task.id);
      const currentPage = await chrome.tabs.get(tabId).catch(() => null);
      if (!current || latest.activeTaskId !== current.id || current.status !== "running" || current.tabId !== tabId)
        throw new Error("This project moved or was paused.");
      if (isPaused(await settings(), input.page.url)) throw new Error("HypeMan is paused on this site.");
      if (!currentPage || safePageUrl(currentPage.url) !== safePageUrl(input.page.url) || current.steps.find((item) => item.status !== "done")?.id !== step.id)
        throw new Error("The project changed. Observe it again.");
      if (!assessment.completed) return { task: current, assessment };
      const evidence = assessment.evidence.trim();
      if (evidence.length < 8 || evidence.length > 600 || !input.page.text.includes(evidence))
        throw new Error("Project completion needs an exact quote from the current page.");
      for (const [key, pending] of pendingAssessments)
        if (Date.now() - pending.at > 30_000) pendingAssessments.delete(key);
      while (pendingAssessments.size >= 32) pendingAssessments.delete(pendingAssessments.keys().next().value!);
      pendingAssessments.set(id, {
        taskId: task.id, stepId: step.id, tabId, url: input.page.url,
        text: input.page.text, evidence, at: Date.now(),
      });
      return { task: current, assessment, assessmentId: id };
    }
    case "task.step.verify": {
      if (typeof message.assessmentId !== "string" || typeof message.taskId !== "string" || typeof message.stepId !== "string")
        throw new Error("Choose a verified project step.");
      const pending = pendingAssessments.get(message.assessmentId);
      if (!pending || Date.now() - pending.at > 30_000 || pending.taskId !== message.taskId || pending.stepId !== message.stepId || pending.tabId !== tabId) {
        if (pending && pending.tabId === tabId) pendingAssessments.delete(message.assessmentId);
        throw new Error("The project check expired. Observe the page again.");
      }
      const state = await workspace.snapshot();
      const task = state.tasks.find((item) => item.id === pending.taskId);
      if (!task || state.activeTaskId !== task.id || task.status !== "running" || task.tabId !== tabId || task.steps.find((step) => step.status !== "done")?.id !== pending.stepId)
        throw new Error("This project moved or changed.");
      const input = parseTaskAssessmentRequest({ requestId: id, task, page: message.page });
      if (!input || input.page.url !== pending.url || input.page.text !== pending.text || !input.page.text.includes(pending.evidence)) {
        pendingAssessments.delete(message.assessmentId);
        throw new Error("The project page changed. Observe it again.");
      }
      const source = tabId === null ? null : await chrome.tabs.get(tabId).catch(() => null);
      if (!source || safePageUrl(source.url) !== safePageUrl(pending.url) || isPaused(await settings(), pending.url)) {
        pendingAssessments.delete(message.assessmentId);
        throw new Error("The project page is unavailable.");
      }
      pendingAssessments.delete(message.assessmentId);
      const updated = await workspace.completeStep({
        eventId: message.assessmentId, taskId: task.id, stepId: pending.stepId, source: "page",
        evidence: pending.evidence, url: input.page.url, title: input.page.title,
      }, tabId);
      return { task: updated };
    }
    case "task.step.confirm": {
      if (typeof message.taskId !== "string" || typeof message.stepId !== "string")
        throw new Error("Choose the current project step.");
      const state = await workspace.snapshot();
      const task = state.tasks.find((item) => item.id === message.taskId);
      if (!task || state.activeTaskId !== task.id || task.status !== "running" || (task.tabId !== tabId && !isExtensionPage(sender)))
        throw new Error("This tab does not own the running project.");
      const step = task.steps.find((item) => item.status !== "done");
      if (!step || step.id !== message.stepId) throw new Error("Confirm the current project step.");
      const progress: TaskMilestoneProgress = {
        eventId: id, taskId: task.id, stepId: step.id, source: "user",
        evidence: "The user marked this step complete.",
        url: safePageUrl(sender.tab?.url), title: sender.tab?.title ?? "",
      };
      return workspace.completeStep(progress, task.tabId);
    }
    case "note.save": {
      if (
        !isRecord(message.note) ||
        typeof message.note.text !== "string" ||
        typeof message.note.url !== "string" ||
        typeof message.note.title !== "string" ||
        typeof message.note.excerpt !== "string"
      )
        throw new Error("A note needs text and a source.");
      return workspace.saveNote(message.note as unknown as NoteInput);
    }
    case "note.remove":
      if (typeof message.id !== "string") throw new Error("Choose a note.");
      await workspace.removeNote(message.id);
      return { ok: true };
    case "agent.decide": {
      const input = parseAgentRequest(message.input);
      if (!input) throw new Error("Invalid page context.");
      if (message.readOnly !== undefined && typeof message.readOnly !== "boolean")
        throw new Error("Choose a valid read-only assistance mode.");
      if (message.runId !== undefined && (typeof message.runId !== "string" || !/^[\w.-]{1,160}$/.test(message.runId)))
        throw new Error("Choose a valid browser request.");
      const activity = !message.readOnly && input.conversationId ? await conversationActivity.get(input.conversationId) : null;
      const runId = !message.readOnly && (typeof message.runId === "string" ? message.runId : activity?.tabId === tabId ? activity.runId : undefined);
      const checkActivity = async () => {
        if (runId && input.conversationId) {
          if (tabId === null) throw new DOMException("Stopped request", "AbortError");
          await conversationActivity.assertOwner(input.conversationId, runId, { tabId, documentId: sender.documentId });
        }
      };
      await checkActivity();
      if (isPaused(config, input.page.url)) throw new Error("HypeMan is paused on this site.");
      if (message.readOnly) {
        // A contextual explanation is a side conversation, even in the project owner tab.
        // Never expose project context or actionable targets to its model request.
        input.task = null;
        input.history = [];
        input.page.elements = [];
        delete input.sources;
        delete input.screenshot;
        input.message = `${input.message.slice(0, 3600)} Provide only a brief say action grounded in this source context. Do not create or advance a project or operate browser controls.`;
      } else {
        const state = await workspace.snapshot();
        const owned =
          state.tasks.find((t) => t.id === state.activeTaskId && t.tabId === tabId && (!t.conversationId || !input.conversationId || t.conversationId === input.conversationId)) ?? null;
        if (input.task && !owned)
          throw new Error("This task has moved to another tab. Start a new task here to continue.");
        input.task = owned;
        delete input.sources;
        if (owned) {
          const notes = state.notes.filter((note) => note.taskId === owned.id && !!safePageUrl(note.url) && !isPaused(config, note.url)).slice(-12);
          if (notes.length) input.sources = notes.map((note) => ({
            ...note, text: note.text.slice(0, 1200), excerpt: note.excerpt.slice(0, 800),
          }));
        }
      }
      const prepared = message.readOnly ? { input } : await conversationAssistance.prepare(input, checkConversation);
      await checkActivity();
      let result: AgentReply;
      try { result = prepared.reply ?? await gateway.post<AgentReply>("/api/agent", prepared.input, id, tabId, 120000); }
      catch (error) { checkConversation(); await checkActivity(); throw error; }
      if (!prepared.reply) checkConversation();
      await checkActivity();
      if (message.readOnly) {
        const action = parseAction(result.action);
        if (!action || action.type !== "say" || !action.text.trim())
          throw new Error("HypeMan could not provide a read-only explanation. Please try again.");
        return { action, done: true, provider: result.provider };
      }
      return { ...result, contextScope: prepared.reply?.contextScope || prepared.input.contextScope };
    }
    case "assistant.ask": {
      const reply = await handle({ ...message, type: "assistant.turn", conversationId: message.conversationId || crypto.randomUUID() }, sender) as AgentReply;
      return { text: reply.say || (reply.action.type === "say" ? reply.action.text : reply.action.type === "ask" ? reply.action.question : "Tell me what you would like to do next."), action: reply.action, provider: reply.provider };
    }
    case "api": {
      if (typeof message.path !== "string" || !API_PATHS.has(message.path))
        throw new Error("Unknown capability.");
      return gateway.post(message.path, message.body ?? {}, id, tabId, 120000);
    }
    case "session.get": {
      if (tabId === null) return {};
      const current = await session(tabId),
        handoff = current.handoff as SessionHandoff | undefined;
      const state = await workspace.snapshot();
      const task = state.tasks.find((item) => item.id === state.activeTaskId && item.status === "running" && item.tabId === tabId) ?? null;
      if (handoff && (handoff.runId && !handoff.checkpoint && (!handoff.conversationId || !await conversationActivity.canResume(handoff.conversationId, handoff.runId, tabId)) ||
          !handoff.checkpoint && handoff.at && Date.now() - handoff.at > 10 * 60000)) {
        await setSession(tabId, { handoff: null });
        return { ...current, handoff: null, task };
      }
      return { ...current, task };
    }
    case "session.set": {
      if (tabId === null) return { ok: true };
      if (message.handoff !== null && message.handoff !== undefined) {
        if (
          !isRecord(message.handoff) ||
          typeof message.handoff.goal !== "string" ||
          !Array.isArray(message.handoff.history) ||
          message.handoff.history.length > 40
          || (message.handoff.checkpoint !== undefined && typeof message.handoff.checkpoint !== "boolean")
          || (message.handoff.message !== undefined && (typeof message.handoff.message !== "string" || message.handoff.message.length > 3000))
          || (message.handoff.runId !== undefined && (typeof message.handoff.runId !== "string" || !/^[\w.-]{1,160}$/.test(message.handoff.runId)))
        )
          throw new Error("Invalid continuation.");
      }
      let nativeNavigation: NativeNavigation | null | undefined;
      if (message.nativeNavigation != null) {
        const intent = nativeNavigationIntent(message.nativeNavigation);
        if (!intent || Date.now() - intent.at > NATIVE_NAVIGATION_TTL || intent.at > Date.now() + 1000 ||
            !continuationHandoff(message.handoff)) throw new Error("Invalid native navigation continuation.");
        nativeNavigation = intent;
      } else if (message.nativeNavigation === null || message.handoff === null) nativeNavigation = null;
      if (isRecord(message.handoff) && typeof message.handoff.runId === "string" && typeof message.handoff.conversationId === "string" && !message.handoff.checkpoint)
        await conversationActivity.prepare(message.handoff.conversationId, message.handoff.runId, { tabId, documentId: sender.documentId });
      if (message.handoff === null) {
        const current = await session(tabId);
        if (isRecord(current.handoff) && typeof current.handoff.runId === "string" && typeof current.handoff.conversationId === "string" &&
            conversationActivity.allowsHandoff(current.handoff.conversationId, current.handoff.runId, tabId))
          await conversationActivity.release(current.handoff.conversationId, current.handoff.runId, { tabId, documentId: sender.documentId });
      }
      await setSession(tabId, {
        ...(message.handoff !== undefined ? { handoff: message.handoff } : {}),
        ...(nativeNavigation !== undefined ? { nativeNavigation } : {}),
        ...(Array.isArray(message.conversation)
          ? { conversation: message.conversation.slice(-60) }
          : {}),
      });
      return { ok: true };
    }
    case "nav.navigate": {
      const url = safePageUrl(message.url);
      if (!url) throw new Error("Only ordinary website URLs are supported.");
      if (isPaused(config, url)) throw new Error("HypeMan is paused on the destination site.");
      await assertOutgoing(message.handoff, tabId, sender.documentId);
      const state = await workspace.snapshot();
      const task = state.tasks.find((t) => t.id === state.activeTaskId && t.tabId === tabId);
      if (message.newTab === true || tabId === null) {
        const target = await chrome.tabs.create({ url: "about:blank", active: true });
        if (target.id === undefined) throw new Error("Couldn't open tab.");
        try { await transferActivity(message.handoff, tabId, target, sender.documentId, url); }
        catch (error) { await chrome.tabs.remove(target.id).catch(() => {}); throw error; }
        if (task) await workspace.resume(task.id, target.id);
        await setSession(target.id, {
          handoff: message.handoff ?? null,
          conversation: tabId === null ? [] : ((await session(tabId)).conversation ?? []),
          conversationId: isRecord(message.handoff) && message.handoff.conversationId || (tabId === null ? undefined : (await session(tabId)).conversationId),
        });
        await assertContinuation(message.handoff, target.id);
        await chrome.tabs.update(target.id, { url });
        if (task && tabId !== null) await notify("task.stopped", { taskId: task.id }, tabId);
      } else {
        const target = await chrome.tabs.get(tabId);
        await transferActivity(message.handoff, tabId, target, sender.documentId, url);
        await setSession(tabId, { handoff: message.handoff ?? null, ...(isRecord(message.handoff) && typeof message.handoff.conversationId === "string" ? { conversationId: message.handoff.conversationId } : {}) });
        await assertContinuation(message.handoff, tabId);
        await chrome.tabs.update(tabId, { url });
      }
      return { ok: true };
    }
    case "nav.back":
      if (tabId === null) throw new Error("No browser tab.");
      {
        const current = await session(tabId);
        await assertOutgoing(current.handoff, tabId, sender.documentId);
        await transferActivity(current.handoff, tabId, await chrome.tabs.get(tabId), sender.documentId);
        await assertContinuation(current.handoff, tabId);
      }
      await chrome.tabs.goBack(tabId);
      return { ok: true };
    case "nav.switch": {
      if (!config.tabContextEnabled)
        throw new Error("Enable other tab context before switching tabs with HypeMan.");
      if (!Number.isInteger(message.tabId)) throw new Error("Choose a tab.");
      const target = await chrome.tabs.get(Number(message.tabId));
      if (!safePageUrl(target.url) || isPaused(config, target.url!))
        throw new Error("That tab is unavailable.");
      const state = await workspace.snapshot(),
        task = state.tasks.find((t) => t.id === state.activeTaskId && t.tabId === tabId);
      const continuation = continuationHandoff(message.handoff);
      if (!task && message.handoff != null && !continuation)
        throw new Error("Invalid continuation.");
      await assertOutgoing(message.handoff, tabId, sender.documentId);
      await transferActivity(message.handoff, tabId, target, sender.documentId);
      if (task) {
        await workspace.resume(task.id, target.id!);
        if (tabId !== null) await notify("task.stopped", { taskId: task.id }, tabId);
      }
      await setSession(target.id!, {
        handoff: message.handoff ?? null,
        conversation: tabId === null ? [] : ((await session(tabId)).conversation ?? []),
          conversationId: isRecord(message.handoff) && message.handoff.conversationId || (tabId === null ? undefined : (await session(tabId)).conversationId),
      });
      await assertContinuation(message.handoff, target.id!);
      await chrome.tabs.update(target.id!, { active: true });
      await chrome.windows.update(target.windowId, { focused: true });
      const run = task ? {
        type: "hypeman.task.run", taskId: task.id, goal: task.goal, handoff: message.handoff,
      } : continuation ? {
        type: "hypeman.assistant.run", goal: continuation.goal, handoff: continuation,
      } : null;
      // Ordinary browser requests have no persisted task ID. Dispatch their actual continuation
      // instead of a task.run event that the destination runtime correctly ignores.
      if (!run) return { ok: true };
      await assertContinuation(message.handoff, target.id!);
      try {
        await chrome.tabs.sendMessage(target.id!, run);
      } catch {
        await chrome.scripting.executeScript({
          target: { tabId: target.id! },
          files: ["content.js"],
        });
      }
      return { ok: true };
    }
    case "tabs.list":
      return config.tabContextEnabled
        ? (await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }))
            .filter((t) => !isPaused(config, t.url ?? ""))
            .slice(0, 12)
            .map((t) => ({
              id: t.id,
              title: t.title,
              url: (() => {
                const u = new URL(t.url!);
                return u.origin + u.pathname;
              })(),
            }))
        : [];
    case "input":
      return trustedInput(tabId, message.ops, config.trustedInput);
    case "screenshot": {
      if (!config.screenshotEnabled || tabId === null)
        throw new Error("Enable screenshot context in Settings first.");
      const tab = await activeTab();
      if (tab?.id !== tabId) throw new Error("Screenshot context only works in the active tab.");
      const privateFields = await chrome.scripting.executeScript({
        target: { tabId },
        func: () =>
          Array.from(document.querySelectorAll("input")).some((e) =>
            /password|credit|card|cvv|cvc|otp|one.?time|verification|security.?code/i.test(
              [e.type, e.name, e.autocomplete, e.id].join(" "),
            ),
          ),
      });
      if (privateFields.some((r) => r.result))
        throw new Error(
          "Screenshot context is unavailable while sensitive fields are on this page.",
        );
      return {
        image: await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 65 }),
      };
    }
    case "graph.get":
    case "learn.get":
      return graph();
    case "learn.event":
      return learn(message.event as never);
    case "learn.plan":
      return savePlan(message.plan);
    case "learn.current":
      if (message.planId !== undefined && (typeof message.planId !== "string" || !/^[\w.-]{1,100}$/.test(message.planId))) throw new Error("Choose a saved practice plan.");
      return currentPractice(message.planId as string | undefined);
    case "learn.step.attempt": {
      if (!/^[\w.-]{1,160}$/.test(id) || typeof message.planId !== "string" || !/^[\w.-]{1,100}$/.test(message.planId) || !Number.isInteger(message.stepIndex) || typeof message.explanation !== "string" || !message.explanation.trim() || message.explanation.length > 4000) throw new Error("Explain the current practice step in 4,000 characters or fewer.");
      return practice.attempt({ planId: message.planId, stepIndex: Number(message.stepIndex), explanation: message.explanation, requestId: id }, current => gateway.post<LearningPlanAssessment>("/api/learn/teachback", { concept: current.step.concept, goal: `${current.step.concept}\nExercise: ${current.step.exercise}`, explanation: message.explanation }, id, tabId, 120000), checkConversation);
    }
    case "learn.clear":
      await clearLearning();
      return { ok: true };
    case "tablet.open":
    case "board.open":
      await openCompanion("board");
      return { ok: true };
    case "demo.open":
      await openCompanion();
      return { ok: true };
    case "control.open":
      await openCompanion(message.section);
      return { ok: true };
    case "onboarding.open":
      await chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
      return { ok: true };
    default:
      throw new Error("Unknown extension request.");
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (!isRecord(message) || typeof message.type !== "string" || message.type.startsWith("hypeman."))
    return;
  if (sender.id !== chrome.runtime.id) {
    respond({ ok: false, error: "Unknown caller" });
    return;
  }
  if (jsonSize(message) > 8_000_000) {
    respond({ ok: false, error: "Request too large" });
    return;
  }
  handle(message, sender)
    .then((data) => respond({ ok: true, data }))
    .catch((error) => respond({ ok: false, error: errorText(error), ...(error instanceof Error && error.name === "AbortError" ? { cancelled: true } : {}) }));
  return true;
});
chrome.tabs.onActivated?.addListener(({ tabId }) => { void notify("tab.activated", {}, tabId); });
chrome.tabs.onCreated?.addListener((tab) => {
  const createdAt = Date.now();
  for (const [id, candidate] of nativeCandidates)
    if (createdAt - candidate.createdAt > NATIVE_NAVIGATION_TTL) nativeCandidates.delete(id);
  if (tab.id === undefined || !Number.isInteger(tab.openerTabId)) return;
  if (nativeCandidates.size >= 128) nativeCandidates.delete(nativeCandidates.keys().next().value!);
  nativeCandidates.set(tab.id, { openerTabId: tab.openerTabId!, createdAt });
  void adoptNativeNavigation(tab.id).catch(() => {});
});
chrome.tabs.onRemoved.addListener((id) => {
  nativeCandidates.delete(id);
  for (const [targetId, candidate] of nativeCandidates)
    if (candidate.openerTabId === id) nativeCandidates.delete(targetId);
  gateway.cancelOwner(id);
  forgetAssessments(id);
  void ready.then(async () => {
    await chrome.storage.session.remove(tabSessionKey(id));
    await conversationActivity.removeOwner(id);
    const state = await workspace.snapshot();
    const task = state.tasks.find((t) => t.id === state.activeTaskId && t.tabId === id);
    if (task) return workspace.pause(task.id);
  });
});
// Return to the originating HypeMan screen after the gateway has verified the OAuth result.
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.status === "loading" && (tab.url !== "about:blank" || conversationActivity.ownerDocument(id))) {
    const observedRunId = conversationActivity.ownerRun(id);
    const observedDocumentId = conversationActivity.ownerDocument(id);
    void ready.then(async () => {
      const value = await session(id), handoff = continuationHandoff(value.handoff);
      await conversationActivity.navigated(activityOwner(tab), handoff && !handoff.checkpoint ? handoff : null, observedRunId, observedDocumentId);
    }).catch(() => {});
  }
  if (nativeCandidates.has(id) && (change.url || change.status === "complete"))
    void adoptNativeNavigation(id).catch(() => {});
  if (change.status !== "complete" || !tab.url) return;
  void (async () => {
    await ready;
    const value = (await chrome.storage.session.get(loginReturnKey))[loginReturnKey];
    if (
      !isRecord(value) ||
      value.loginTabId !== id ||
      typeof value.callback !== "string" ||
      typeof value.sourceTabId !== "number" ||
      typeof value.at !== "number"
    )
      return;
    if (Date.now() - value.at > 10 * 60_000) {
      await chrome.storage.session.remove(loginReturnKey);
      return;
    }
    const current = new URL(tab.url!);
    const callback = new URL(value.callback);
    if (current.origin !== callback.origin || current.pathname !== callback.pathname) return;
    const result = safeChatGPTStatus(
      await gateway.post("/api/chatgpt/status", {}, crypto.randomUUID(), null, 45000),
    );
    if (result.pending) return;
    await chrome.storage.session.remove(loginReturnKey);
    const source = await chrome.tabs.get(value.sourceTabId).catch(() => null);
    if (!source?.url?.startsWith(chrome.runtime.getURL(""))) return;
    await chrome.tabs.update(value.sourceTabId, { active: true });
    await chrome.windows.update(source.windowId, { focused: true });
    if (result.connected && result.sharing && !result.error) await chrome.tabs.remove(id);
  })().catch(() => {
    /* Keep the callback tab available if returning fails. */
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[WORKSPACE_KEY]) {
    void notify("workspace.changed");
    if (chrome.alarms) void ready.then(() => phone.sync()).catch(() => {});
  }
});
// Alarms survive worker suspension; initialization also covers browser startup and updates.
if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === MESSAGING_ALARM) void ready.then(() => phone.sync()).catch(() => {});
  });
  chrome.runtime.onStartup.addListener(() => {
    void ready.then(async () => {
      await chrome.alarms.create(MESSAGING_ALARM, { periodInMinutes: 0.5 });
      await phone.sync();
    }).catch(() => {});
  });
  void ready.then(async () => {
    await chrome.alarms.create(MESSAGING_ALARM, { periodInMinutes: 0.5 });
    await phone.sync();
  }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(async (details) => {
  await ready;
  await patchSettings({});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "hypeman-explain",
      title: "Explain with HypeMan",
      contexts: ["selection"],
    });
  });
  if (details.reason === "install")
    await chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
});
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || !info.selectionText || isPaused(await settings(), tab.url ?? "")) return;
  if (info.menuItemId === "hypeman-note")
    await workspace.saveNote({
      text: info.selectionText,
      excerpt: info.selectionText,
      url: tab.url ?? "",
      title: tab.title ?? "",
    });
  else await notify("ask.selection", { text: info.selectionText }, tab.id);
});
chrome.commands.onCommand.addListener(async (command) => {
  const tab = await activeTab();
  if (command === "open-control")
    await openCompanion();
  else if (tab?.id !== undefined) await notify("command", { name: command }, tab.id);
});
chrome.action?.onClicked?.addListener(() => { void openCompanion(); });

async function trustedInput(
  tabId: number | null,
  raw: unknown,
  enabled: boolean,
): Promise<{ ok: boolean }> {
  if (
    tabId === null ||
    !enabled ||
    !(await chrome.permissions.contains({ permissions: ["debugger"] }))
  )
    throw new Error("Real input is not enabled.");
  if (!Array.isArray(raw) || raw.length > 40 || !raw.every(isRecord))
    throw new Error("Invalid input operations.");
  const privateFocus = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const e = document.activeElement;
      return (
        e instanceof HTMLInputElement &&
        /password|card|credit|cvv|cvc|otp|one.?time|verification|security.?code/i.test(
          [e.type, e.name, e.autocomplete, e.id].join(" "),
        )
      );
    },
  });
  if (privateFocus.some((v) => v.result)) throw new Error("Enter sensitive details yourself.");
  await chrome.debugger.attach({ tabId }, "1.3");
  const send = (method: string, params: Record<string, unknown>) =>
    chrome.debugger.sendCommand({ tabId }, method, params);
  const point = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 20000;
  try {
    for (const op of raw) {
      if (op.kind === "key") {
        if (typeof op.key !== "string" || op.key.length > 30) throw new Error("Invalid key");
        await send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: op.key,
          code: op.key,
          ...(op.key === "Enter" ? { windowsVirtualKeyCode: 13 } : {}),
        });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: op.key, code: op.key });
      } else if (op.kind === "text") {
        if (typeof op.text !== "string" || op.text.length > 8000) throw new Error("Invalid text");
        await send("Input.insertText", { text: op.text });
      } else {
        if (!point(op.x) || !point(op.y)) throw new Error("Invalid pointer coordinates");
        if (op.kind === "move")
          await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: op.x, y: op.y });
        else if (op.kind === "click") {
          if (
            !["left", "right"].includes(String(op.button)) ||
            !Number.isInteger(op.count) ||
            Number(op.count) < 1 ||
            Number(op.count) > 2
          )
            throw new Error("Invalid click");
          for (let n = 1; n <= Number(op.count); n++) {
            await send("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: op.x,
              y: op.y,
              button: op.button,
              clickCount: n,
            });
            await send("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: op.x,
              y: op.y,
              button: op.button,
              clickCount: n,
            });
          }
        } else if (op.kind === "wheel") {
          if (
            typeof op.deltaY !== "number" ||
            !Number.isFinite(op.deltaY) ||
            Math.abs(op.deltaY) > 10000
          )
            throw new Error("Invalid scroll");
          await send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: op.x,
            y: op.y,
            deltaY: op.deltaY,
            deltaX: 0,
          });
        } else if (op.kind === "drag") {
          if (!point(op.toX) || !point(op.toY)) throw new Error("Invalid drag");
          await send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: op.x,
            y: op.y,
            button: "left",
            buttons: 1,
            clickCount: 1,
          });
          for (let i = 1; i <= 12; i++)
            await send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: Number(op.x) + ((Number(op.toX) - Number(op.x)) * i) / 12,
              y: Number(op.y) + ((Number(op.toY) - Number(op.y)) * i) / 12,
              button: "left",
              buttons: 1,
            });
          await send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: op.toX,
            y: op.toY,
            button: "left",
            buttons: 0,
            clickCount: 1,
          });
        } else throw new Error("Unknown input operation");
      }
    }
    return { ok: true };
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}
