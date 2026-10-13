# Feature checklist

Checked items describe implemented behavior. Live provider success requires valid credentials, available models, and the separate checks in [verification](VERIFICATION.md).

## Companion and tasks

- [x] Typed and validated actions follow observe → decide → policy → execute → verify.
- [x] Semantic top-frame extraction, stable IDs, sensitive field redaction, highlights, and stale-target rejection.
- [x] Click, type, select, scroll, navigate, Back, tab handoff, native video controls, and optional trusted browser input.
- [x] Confirmation before detected consequential actions and default form submissions. Ordinary registration links open the form; its final submission is confirmed.
- [x] Passwords, payment fields, and verification codes remain user-operated.
- [x] Cancellation through runtime, worker, gateway, and providers. Late cancelled replies cannot act.
- [x] Ordinary questions and one-off actions stay in chat. Only plans with at least two distinct milestones create persisted projects.
- [x] Practical projects begin browser work immediately after planning and continue after verified milestones. Explicit planning-only or wait requests remain collaborative. Research opens source pages in separate tabs and carries this project's saved facts across tabs and milestones.
- [x] Read-only progress checks advance one milestone using an exact current-page quote. Fresh-page verification rejects stale checks; uncertainty leaves the plan unchanged. Users can explicitly confirm the current step, and Continue project here transfers observation between websites.
- [x] Persisted goal, steps, last page, next instruction, and action evidence. One task owns execution; starting another pauses the previous task.
- [x] Browser restart restores paused tasks and requires explicit continuation. Back/Forward cache restoration does not replay completed actions.
- [x] Notes retain text, source URL/title, excerpt, and capture time. Edit directly with autosave; save, find, delete, undo, and export through conversation. PDF excerpts retain document/page provenance; conversation notes need no webpage URL.
- [x] Live settings and per-site pause. Paused sites stop observation, page analysis, and actions.
- [x] Optional automatic learning hints: quietly preload the first rung for a stable visible question, then reveal it after wrong-answer feedback (including plain “Try Again”). Answer edits reuse preparation; changed questions invalidate it. Bounded session cache, single in-flight request, request budget, graduated manual follow-ups, cooldown, and cancellation. Preparation is never learning evidence.
- [x] Stable page selections receive brief contextual explanations with Automatic hints enabled, even outside Learning mode or during an idle project. Explanations never inherit project context or change its progress. Clear a selection to clear its preview; reselect to reuse the cached explanation. Editable/private fields and inaccessible frames are excluded. All automatic assistance is read-only.
- [x] Opt-in other-tab titles and URLs, excluding paused hosts and query strings. Explicit screenshot attachment is used once for the next model request and is never persisted.
- [x] Keyboard controls, visible focus, and live reduced-motion settings.
- [x] One shared conversation composer and requested tools alongside it, with compact controls for direct editing. Browser confirmations and contextual native consent remain explicit.
- [x] ChatGPT sign-in is the only live AI connection. Sign-out disables AI; failures never fall back to API keys or a local model.
- [x] Typed conversation with persistent messages and contextual tools.

Progress is conservative: a click or an agent’s final reply cannot complete a project. Each milestone needs visible source evidence or an explicit user confirmation, recorded separately. Only completing the final milestone completes the project. Complex custom widgets may need user guidance or optional real input.

## Rooftop and avatar conversation

- [x] Live layered rooftop with four time-of-day phases, pointer parallax, clouds, blimp, lights, water, pigeons, walking HypeMan, and silent dance interactions. Keyboard-accessible HypeMan hotspot, arrow-key character movement, and live reduced motion.
- [x] New tabs start as a quiet rooftop, with no persistent composer or tool menu. Activate the little avatar on an ordinary webpage to open conversation and requested tools beside that page. Enter sends; Shift+Enter adds a line; Escape stops or dismisses.
- [x] Pixel styling across the companion, popup, onboarding, drawing, video, PDF reader, and utility windows. All 11 windows drag, resize from every edge and corner, minimize, maximize, and restore; interiors scroll at small sizes.
- [x] Projects, notes, action history, workspace export, preferences, phone, accounts, and learning open through chat. Old tool links open the shared conversation host.
- [x] Health reports live, local, and unavailable services. The gateway root displays connection guidance.

## Specialist workspaces

| Feature  | Implemented experience                                                                              | Without a live AI connection                                         |
| -------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Video    | Native controls, page captions, VTT/SRT upload, pasted transcript, timestamped notes/chapters       | Local playback, supplied captions, and timestamped excerpts           |
| Whiteboard | Shared persisted strokes, shapes, text, editable KaTeX equations, assistant transactions, keyboard undo/redo, direct manipulation, composite PNG export and review | Local editing and export; assistant additions and review require ChatGPT |
| PDFs | PDF.js preview, incremental text, 25 MiB chunked upload into extension IndexedDB, local passwords, highlighted passages, page citations, explicit scanned-page analysis and original-file export | Local viewing, selection, and original-file export; analysis requires ChatGPT |
| Learning | Optional plans, hints, page-feedback evidence, teach-back review, concept graph                     | Saved practice history; new plans and feedback require ChatGPT        |
| Study library | Local search across notes and actual conversation messages; course labels, PDF/web/chat source links, editable review cards, due queues, answer reveal, four ratings, pause/resume/delete, and backup restore | All library and spaced-review functions work without a gateway or internet connection |

Task notes and learner diagnostics are separate. Teach-back records an explanation; assessed evidence is accepted only when grounded in that explanation. Mocked assessment in automated tests does not establish mastery. The graph presents practice history, not a grade.

Spaced reviews record explicit self-ratings with a simple graduated schedule, separate from the learner graph. Cards preserve source metadata and an editable saved answer; they do not update automatically when the source changes. Cross-window revision checks reject stale edits and ratings, and retry identities prevent duplicate reviews. Workspace backups include cards, course labels, schedules, and recent review history; existing identities win during restore.

## Scope and limits

- Local single-user Chrome MV3 release with ChatGPT account selection and optional phone synchronization; no shared workspace or store publication.
- Top-frame HTTP/HTTPS support. Inaccessible frames and Chrome-protected pages cannot be operated.
- Caption-based video understanding. HypeMan does not infer unheard narration from frames; live missing captions are reported as unavailable.
- Missing credentials and invalid provider output produce explicit failures. Automated tests supply minimal test-only pages and mock provider responses; these are not served by the application.
- Live AI requires eligible ChatGPT plan permission. Images require a supported account model; unavailable features fail explicitly.
- Settings, projects, notes, and learning evidence use validated HypeMan storage records. Unrelated extension data is left untouched. Recall credit requires a successful return after a full day away from a concept.
- Site pause is hostname-wide for webpage work. PDF viewing and document-only help remain independent of it.
- Optional screenshot/other-tab context and debugger input are capability switches, not an idle remote monitoring service.

## Verification

Unit/integration coverage includes persisted-record validation, serialized task storage, deduplication, action policy, stale targets, malformed decisions, cancellation, paused-site silence, lifecycle restoration, trusted transport, video intents, and grounded teach-back. The deterministic browser suite covers registration, notes/export, live settings, specialist fixtures, and restart continuation.

Scanned-page reading accuracy, transcript-service availability, and live model completion need credential-dependent checks. A fixture response does not validate them.

## Persistence and controls

Conversations and artifacts are durable extension-owned records. Conversation IDs follow browser navigation and project handoff. The whiteboard uses revisions and stable IDs to reject stale edits. PDF files transfer through bounded chunks, and only an authorized extension reader can access their bytes. Frame capability tokens stay outside DOM URLs and expire. Closing a tool preserves its work; cancellation cannot reopen dismissed content. Hidden local videos pause.

Compact toolbars provide drawing, file, note, project, account, and media actions. Chat keeps Send/Stop and attachments without repeating selected message text. Editable preferences save automatically. Local commands for stop, notes, saved work, preferences, export, connection recovery, and tool opening work independently of inference.
