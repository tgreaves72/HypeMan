export const TOOL_OPERATIONS = {
  board: ["open", "add", "update", "undo", "redo", "clear", "color", "width", "mode", "erase", "check", "export"],
  documents: ["open", "show", "analyze", "summarize", "page", "remove", "explain", "inspect", "read", "cancel", "export", "download"],
  notes: ["open", "find", "save", "delete", "undo", "export", "review"],
  projects: ["open", "filter", "pause", "resume", "cancel", "done"],
  activity: ["open"],
  settings: ["open", "set", "pause-site", "resume-site", "permissions"],
  video: ["open", "summarize", "ask", "captions", "remove-captions", "seek", "play", "pause", "speed", "save"],
  phone: ["open", "status", "pair", "unpair", "send", "test", "settings", "inbox", "continue", "dismiss", "reminders", "snooze", "cancel", "remind", "pause", "resume", "skip"],
  connection: ["open", "status", "login", "cancel", "logout", "account", "model", "reconnect", "usage"],
  learning: ["open", "plan", "hint", "teach", "check", "clear", "continue", "resume", "attempt"],
} as const;
export type CompanionTool = keyof typeof TOOL_OPERATIONS;
export interface ToolAction { type: "tool"; tool: CompanionTool; operation: string; args?: Record<string, unknown> }
export interface SelectedContent {
  kind: string; id: string; text?: string; url?: string; title?: string;
  artifactId?: string; page?: number; quote?: string; [key: string]: unknown;
}
export function parseToolAction(value: Record<string, unknown>): ToolAction | null {
  if (typeof value.tool !== "string" || !Object.hasOwn(TOOL_OPERATIONS, value.tool) || typeof value.operation !== "string") return null;
  const tool = value.tool as CompanionTool;
  if (!(TOOL_OPERATIONS[tool] as readonly string[]).includes(value.operation)) return null;
  if (value.args !== undefined && (!value.args || typeof value.args !== "object" || Array.isArray(value.args) || JSON.stringify(value.args).length > 60000)) return null;
  return { type: "tool", tool, operation: value.operation, ...(value.args ? { args: value.args as Record<string, unknown> } : {}) };
}
