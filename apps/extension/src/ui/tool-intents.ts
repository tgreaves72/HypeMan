import type { CompanionTool, SelectedContent, ToolAction } from "@core";
const aliases: Record<string, CompanionTool> = { whiteboard: "board", board: "board", notes: "notes", "saved notes": "notes", projects: "projects", tasks: "projects", missions: "projects", activity: "activity", "action history": "activity", settings: "settings", preferences: "settings", permissions: "settings", video: "video", "video companion": "video", documents: "documents", pdfs: "documents", pdf: "documents", learning: "learning", practice: "learning", progress: "learning", "learning progress": "learning", phone: "phone", "phone companion": "phone", "phone inbox": "phone", connection: "connection", account: "connection", "account settings": "connection" };
/** Keep compound requests intact for the planner; a shortcut must not consume later work. */
export function hasCompoundIntent(text: string): boolean {
  const unquoted = text.replace(/"[^"\n]*"|'[^'\n]*'/g, "");
  return /(?:\b(?:and then|then|also|after that)\b|\band\s+(?:(?:please|can you)\s+)?(?:save|remember|keep|send|text|draw|sketch|explain|summarize|compare|open|search|find|export|download|remind|create|make|add|show|plan|check|review|calculate)\b|;\s*\w)/i.test(unquoted);
}
export function toolIntent(raw: string, active: string | null, selected: SelectedContent | null): ToolAction | null {
  const text = raw.trim().replace(/[.!?]+$/, ""), lower = text.toLowerCase();
  if (hasCompoundIntent(text)) return null;
  const action = (tool: CompanionTool, operation = "open", args: Record<string, unknown> = {}): ToolAction => ({ type: "tool", tool, operation, args });
  const open = lower.match(/^(?:(?:open|show|show me|list|let me see|go to|view)(?: my| the)? )?(.+)$/)?.[1];
  if (open && ["library", "study library"].includes(open)) return action("notes");
  if (open && ["review", "review cards", "review queue", "flashcards"].includes(open) || /^(?:review|study)(?: my| the)? (?:cards|flashcards)$/.test(lower)) return action("notes", "review");
  if (open && aliases[open]) return action(aliases[open], open === "phone inbox" ? "inbox" : "open");
  if (/^(?:find|search)(?: my)? notes (?:about|for|on) /i.test(text)) return action("notes", "find", { kind: "note", query: text.replace(/^(?:find|search)(?: my)? notes (?:about|for|on) /i, "") });
  if (/^(?:save|remember|keep|pin) (?:this|that|it|this selection|that explanation)$/i.test(text)) return action("notes", "save", { ...selected });
  if (!/^(?:save)(?: this| my| the)? (?:board|whiteboard|drawing)(?: as png)?$/i.test(text) && /^(?:save|remember|keep)(?: this)?:? /i.test(text)) return action("notes", "save", { text: text.replace(/^(?:save|remember|keep)(?: this)?:? /i, "") });
  if (/^(?:delete|remove) (?:this |that |the selected )?note$/i.test(text)) return action("notes", "delete", { id: selected?.id });
  if (/^(?:undo|redo)$/i.test(text)) return action(active === "notes" ? "notes" : "board", lower);
  if (/^(?:clear|erase)(?: the| my| this)? (?:board|whiteboard)$/i.test(text)) return action("board", "clear");
  if (/^(?:erase|delete|remove) (?:this|that|the selection|selected objects)$/i.test(text) && selected?.kind === "board") return action("board", "erase", { id: selected.id });
  const color = text.match(/^(?:use|draw (?:in|with)|make (?:it|this|that|the arrow)) ([\w#]+)(?: ink)?$/i);
  if (color && (active === "board" || selected?.kind === "board")) return action("board", "color", { value: color[1], ...(/^make /i.test(text) && selected?.kind === "board" ? { id: selected.id } : {}) });
  if (/^(?:let me )?draw over this$/i.test(text)) return action("board", "mode", { value: "ink" });
  if (/^(?:check|review)(?: my| this)? (?:work|board|drawing)$/i.test(text) && active === "board") return action("board", "check", { goal: text });
  if (/^(?:export|download|save)(?: this| my| the)? (?:board|whiteboard|drawing)(?: as png)?$/i.test(text)) return action("board", "export");
  if (/^(?:pause|resume|continue|cancel)(?: this| my| the| that)? (?:project|task)(?: here)?$/i.test(text)) return action("projects", /pause/i.test(lower) ? "pause" : /cancel/i.test(lower) ? "cancel" : "resume", { id: selected?.kind === "project" ? selected.id : undefined });
  if (/^(?:show|list)(?: my| the)? (unfinished|paused|running|completed|cancelled) (?:projects|tasks)$/i.test(text)) return action("projects", "filter", { status: lower.includes("unfinished") ? "unfinished" : text.split(" ").find((w) => /^(paused|running|completed|cancelled)$/.test(w)) });
  if (/^(?:pause|hide)(?: hypeman)? on this site$/i.test(text)) return action("settings", "pause-site", { hostname: location.hostname });
  const resumeSite = text.match(/^(?:resume|show)(?: hypeman)? on (?:this site|([\w.-]+))$/i); if (resumeSite) return action("settings", "resume-site", { hostname: resumeSite[1] || location.hostname });
  if (/^(?:reduce motion|less motion|stop animations)$/i.test(text)) return action("settings", "set", { patch: { reducedMotion: "on" } });
  if (/^(?:enable|disable|turn (?:on|off)|stop|start) (?:automatic hints|automatic assistance|learning mode|screenshots|other tab context|real input)$/i.test(text)) {
    const key = /learning/.test(lower) ? "learningEnabled" : /screenshots/.test(lower) ? "screenshotEnabled" : /other tab/.test(lower) ? "tabContextEnabled" : /real input/.test(lower) ? "trustedInput" : "proactiveEnabled";
    return action("settings", key === "trustedInput" || key === "screenshotEnabled" ? "permissions" : "set", key === "trustedInput" || key === "screenshotEnabled" ? { permission: key === "trustedInput" ? "input" : "capture", enabled: /^(enable|turn on|start)/.test(lower) } : { patch: { [key]: /^(enable|turn on|start)/.test(lower) } });
  }
  if (/^(?:sign in|connect|continue with chatgpt|add account)$/i.test(text)) return action("connection", "login", { newProfile: lower === "add account" });
  if (/^(?:sign out|log out)$/i.test(text)) return action("connection", "logout");
  if (/^(?:cancel sign-in|cancel login)$/i.test(text)) return action("connection", "cancel");
  if (/^(?:manage|show)(?: my)? usage$/i.test(text)) return action("connection", "usage");
  const model = text.match(/^(?:use|switch to|select)(?: the)? model (.+)$/i); if (model) return action("connection", "model", { model: model[1] });
  const account = text.match(/^(?:use|switch to|select)(?: the)? account (.+)$/i); if (account) return action("connection", "account", { account: account[1] });
  const reconnect = text.match(/^reconnect(?: to (https?:\/\/\S+))?$/i); if (reconnect) return action("connection", "reconnect", { url: reconnect[1] });
  if (/^(?:text|send) (?:this|that|it)(?: to me| to my phone)?$/i.test(text)) return action("phone", "send", { text: selected?.text });
  const pair = text.match(/^(?:pair|connect)(?: my)? phone(?: (\+?[\d ()-]+))?$/i); if (pair) return action("phone", "pair", { phone: pair[1] });
  if (/^unpair(?: my)? phone$/i.test(text)) return action("phone", "unpair");
  if (/^send (?:a )?test text$/i.test(text)) return action("phone", "test");
  if (/^(?:show|list)(?: my)? reminders$/i.test(text)) return action("phone", "reminders");
  if (/^(?:show|refresh)(?: my)? phone status$/i.test(text)) return action("phone", "status");
  if (/^(?:continue|dismiss) (?:this|that|the selected) (?:idea|capture|goal)(?: in chrome)?$/i.test(text)) return action("phone", lower.startsWith("continue") ? "continue" : "dismiss", { id: selected?.id });
  const snooze = text.match(/^snooze(?: this| that)?(?: reminder)?(?: (\d+) (minutes?|hours?))?$/i); if (snooze) return action("phone", "snooze", { id: selected?.id, minutes: Number(snooze[1] || 30) * (snooze[2]?.startsWith("hour") ? 60 : 1) });
  if (/^cancel(?: this| that)? reminder$/i.test(text)) return action("phone", "cancel", { id: selected?.id });
  if (/^(?:give me |another |next |a |small )*hint(?: please)?$/i.test(text)) return action("learning", "hint");
  if (/^(?:make|create)(?: me)? (?:a )?(?:learning|practice|study) plan/i.test(text)) return action("learning", "plan", { goal: text });
  if (/^(?:check|review) my explanation/i.test(text)) return action("learning", "teach", { explanation: text.replace(/^(?:check|review) my explanation[: ]*/i, "") || selected?.text });
  if (/^continue(?: the| this)?(?: pdf| document)? summary$/i.test(text)) return action("documents", "summarize", { resume: true });
  const page = text.match(/^(?:go to|show|open) page (\d+)$/i); if (page && active === "documents") return action("documents", "page", { page: Number(page[1]) });
  if (/^(?:summarize|explain|analyse|analyze)(?: this| the)? (?:pdf|document)$/i.test(text)) return action("documents", /^summarize/i.test(text) ? "summarize" : "analyze", { question: text });
  if (/^(?:export|download)(?: this| my| the)? (?:pdf|document)$/i.test(text)) return action("documents", "export");
  const visualPage = text.match(/^(?:inspect|read|explain)(?: scanned)? page (\d+)(?: visually)?$/i); if (visualPage && active === "documents") return action("documents", "inspect", { page: Number(visualPage[1]), visual: true, question: text });
  const checkin = text.match(/^(?:set|change)(?: my)? (morning|evening) check-in(?: to)? (\d{1,2}):(\d{2})(?: (am|pm))?$/i); if (checkin) { let hour = Number(checkin[2]); if (checkin[4]?.toLowerCase() === "pm" && hour < 12) hour += 12; if (checkin[4]?.toLowerCase() === "am" && hour === 12) hour = 0; return action("phone", "settings", { patch: { [checkin[1].toLowerCase() === "morning" ? "morningTime" : "eveningTime"]: `${String(hour).padStart(2,"0")}:${checkin[3]}` } }); }
  const inkWidth = text.match(/^(?:set|use|change)(?: the| my)? (?:pen |ink |stroke )?(?:width|size)(?: to)? (\d+)$/i); if (inkWidth && active === "board") return action("board", "width", { value: Number(inkWidth[1]) });
  if (/^(?:select objects|let me select|selection mode)$/i.test(text) && active === "board") return action("board", "mode", { value: "select" });
  const videoUrl = text.match(/^(?:open|watch|summarize|play)(?: this| the)? video (https?:\/\/\S+)$/i); if (videoUrl) return action("video", /^summarize/i.test(text) ? "summarize" : "open", { url: videoUrl[1], ...(/^summarize/i.test(text) ? { question: "Summarize the video." } : {}), ...(/^play/i.test(text) ? { play: true } : {}) });
  const seek = text.match(/^(?:go to|seek to|jump to) (\d+)(?::(\d{2}))?(?: seconds?)?$/i); if (seek && active === "video") return action("video", "seek", { value: Number(seek[1]) * (seek[2] ? 60 : 1) + Number(seek[2] || 0) });
  const speed = text.match(/^(?:play at|set speed to|use) ([\d.]+)x$/i); if (speed && active === "video") return action("video", "speed", { value: Number(speed[1]) });
  if (/^(?:mark|confirm)(?: this| the current)? (?:project )?step(?: as)? (?:done|complete)$/i.test(text)) return action("projects", "done", { id: selected?.kind === "project" ? selected.id : undefined });
  if (/^(?:summarize|explain)(?: this| the)? video$/i.test(text)) return action("video", "summarize", { question: text });
  if (/^(?:play|pause)(?: the| this)? video$/i.test(text)) return action("video", lower.startsWith("play") ? "play" : "pause");
  return null;
}
