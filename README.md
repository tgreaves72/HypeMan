# HypeMan

[![Verification](https://github.com/KieranCSchmitt/HypeMan/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/KieranCSchmitt/HypeMan/actions/workflows/verify.yml)

**Big goals. Tiny pixel companion.**

A Y2K browser companion that turns a request into useful work beside the page you're already on. Compare options, build a plan, save what matters, and review the final action—all with a little character in your corner.

Built by **Kieran Schmitt** · Chrome Manifest V3 · TypeScript · React · Local Node.js gateway

[Judging walkthrough](docs/JUDGING.md) · [Get started](#get-started) · [Detailed setup](docs/SETUP.md) · [Feature checklist](docs/FEATURES.md)

[Privacy policy](docs/PRIVACY.md) · [Chrome Web Store release preparation](docs/CHROME_WEB_STORE.md)

![HypeMan's interactive pixel rooftop in a new Chrome tab](docs/media/store/01-rooftop-1280x800.png)

## A companion for the whole task

HypeMan lives on ordinary webpages. Activate the avatar, describe what you need, and keep your work in view. Chat and tools open in movable, resizable pixel windows; a new tab gives you a quiet, interactive rooftop.

| Do the work | Keep the context |
| --- | --- |
| **Browser tasks.** Compare pages, navigate, prepare ordinary forms, and review detected consequential actions before execution. | **Projects.** Multi-step goals become saved milestones, with source evidence, explicit continuation after restart, and handoff between tabs. |
| **Shared whiteboard.** Draw together, edit equations, move objects, undo changes, and export a combined PNG. | **Study library.** Search saved notes and conversations locally, organize sources by course, and build source-linked review cards. |
| **PDF and video help.** Read local PDFs with page citations; turn captions into chapters and timestamped notes. | **Optional learning.** Ask for graduated hints, explain an answer back, and inspect practice history. |
| **Phone companion.** Send Chrome requests from your paired phone through Photon Spectrum. | **Follow-through.** Capture ideas, text saved work, and receive reminders and scheduled check-ins. |

Projects advance when HypeMan can verify the visible outcome or you explicitly confirm the step. Passwords, payment fields, and verification codes stay in your hands.

## Keep useful work and practice recalling it

Say **open library** in HypeMan chat. Search saved notes and conversations, filter by source type or course, and edit notes directly. Search uses local text matching and curated concept aliases; it shows actual saved content and makes no AI request. Use **Make review card** on a source, write a focused question, check its answer, and save it. Cards retain the original webpage link or conversation/PDF citation.

Say **review cards** or choose **Review** in the library. Start a session of 5, 10, or 20 due cards, recall each answer before revealing it, then choose **Again**, **Hard**, **Good**, or **Easy**. Each button previews its next interval. Again returns the card in 10 minutes; first successful ratings schedule 1, 1, or 4 days respectively. Later successful reviews grow the interval, capped at 365 days. This simple graduated schedule records self-rated practice, independently of assessed learning evidence.

The library and review queue work without the gateway, sign-in, or an internet connection. Review dates, course labels, source metadata, and recent ratings persist across reloads and travel with workspace backups. Pause, edit, resume, or delete individual cards. One background writer serializes changes, rejects stale edits across windows, and deduplicates review retries. Restore merges saved identities without overwriting existing schedules. The library supports up to 1,000 cards and retains the latest 2,000 ratings, subject to available browser storage.

## New-tab rooftop controls

The rooftop fits the window and display density, including fullscreen and wide monitors. Its scenery repeats horizontally, clouds move across the viewport, and the animated fountain replaces the road water.

- **Skins:** the compact upper-right button opens previews of HypeMan, Glitch, Rally, Orbit, Breeze, and Spark. Selecting a skin saves it across the rooftop and companion; Escape closes the menu.
- **TV:** activate the switches beside the TV glass to turn the HypeMan demo on or off. The video starts muted, loops continuously, and stays fitted inside the glass as the window resizes. Playback remains in the new tab, with no clickable YouTube links or external navigation. Streaming requires an internet connection; turning the TV off unloads the player.
- **Boombox:** click the boombox or its Play/Pause music button to play the bundled FLAC. Music resumes from the paused position and loops; it does not autoplay.

After rebuilding, reload HypeMan in `chrome://extensions` and refresh the new tab. The TV uses a narrowly scoped request-header rule to identify this extension to YouTube for the demo embed.

## Actual extension screenshots

These captures show a real MDN page, a live ChatGPT reply, source-linked notes, direct whiteboard editing, and saved conversations. Follow the [judging walkthrough](docs/JUDGING.md) to try the local tools and optional live AI yourself. [Screenshot details](docs/SHOWCASE.md) identify what each capture demonstrates.

![HypeMan working beside a real documentation page](docs/media/showcase-real-page.png)

| Keep the useful parts | Think on a shared canvas |
| --- | --- |
| ![Source-linked notes saved from a real webpage](docs/media/showcase-saved-notes.png) | ![User-authored study notes and shared ink on HypeMan's whiteboard](docs/media/showcase-whiteboard.png) |

![Saved work in the HypeMan workbench](docs/media/showcase-project-notes.png)

## Get started

Use **Node.js 24**, npm, and a current desktop **Google Chrome**.

```sh
npm ci
cp .env.example .env
npm run build
npm start
```

1. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked** → `apps/extension/dist`.
2. Open the extension's onboarding page. It connects automatically to the local gateway at `http://127.0.0.1:8787`.
3. Open a webpage and activate HypeMan. Try **open whiteboard**, **show projects**, or **save this** after selecting a passage.
4. For live AI, ask **sign in**, choose **Continue with ChatGPT**, and approve plan usage with an eligible account. Select an available model, then give HypeMan a goal.

Live AI uses your eligible ChatGPT plan through the local gateway. No OpenAI API key or pairing key is needed. Use your regular Chrome profile for actual sign-in; automated checks use isolated browser profiles.

Local whiteboard editing, PDF viewing, notes, library search, spaced reviews, and saved work are available without live AI.

After rebuilding, reload the extension and refresh webpage tabs. `npm run dev` watches the gateway and extension build. See [detailed setup](docs/SETUP.md) for connection recovery, phone pairing, environment settings, controls, and troubleshooting.

For a Chrome Web Store installation, set `HYPEMAN_STORE_EXTENSION_ID` in the gateway's `.env` to the exact item ID assigned by Google, then restart the gateway. The unpacked development extension remains recognized by its pinned identity. `npm run package:store` builds the store upload ZIP; it does not publish the extension. AI and phone features still require the local gateway in this edition.

## How it works

The browser loop is **observe → decide → check policy → execute → verify**. Typed contracts connect the extension to a loopback gateway, which holds live service credentials. Projects, conversations, notes, and artifacts persist locally; verified evidence drives progress.

| Area | Responsibility |
| --- | --- |
| `apps/extension/src/runtime` | Page observation, target validation, action policy, execution, and verification |
| `apps/extension/src/background` | Persistence, tab ownership, permissions, and gateway transport |
| `apps/extension/src/ui` | Avatar, rooftop, conversation, and specialist tools |
| `apps/gateway/src` | Local HTTP server, ChatGPT connection, media services, and Photon transport |
| `packages/core/src` | Shared contracts, validators, projects, settings, and learner evidence |

**Designed for local, single-user use.** The gateway binds to loopback and authenticates extension requests. Screenshot context, other-tab context, and real browser input default off. Pause HypeMan by site; original PDFs and their passwords stay local. Top-frame webpages are supported; protected Chrome pages and inaccessible frames are outside its reach. Video help requires captions or a supplied transcript. Full details are in [privacy and browser limits](docs/SETUP.md#local-security-and-browser-limits).

## Development checks

```sh
npm run check          # Typecheck, unit/integration tests, production build
npm run check:docs     # Documentation links and public asset checks
npm run e2e:install    # Install the isolated Playwright browser
npm run e2e            # Main extension/browser suite
npm run e2e:ui         # Rooftop and specialist UI
npm run e2e:study      # Offline search, review persistence, and responsive library
npm run e2e:pdf        # Local PDF reading, storage, and export
npm run e2e:projects   # Saved milestones and continuation
npm run e2e:execution  # Browser execution and confirmation
npm run e2e:auth       # Mocked ChatGPT sign-in and credential isolation
npm run e2e:messaging  # Pairing, phone inbox, and browser requests
npm run e2e:hints      # Automatic assistance and privacy controls
```

Browser checks load the real MV3 extension with an isolated profile and deterministic gateway. Mocked authentication does not sign in to a real account or consume plan usage. Live model quality, ChatGPT eligibility, and actual Photon delivery need account-dependent checks; see [verification](docs/VERIFICATION.md#live-checks).

[Judging walkthrough](docs/JUDGING.md) · [Setup and reference](docs/SETUP.md) · [Implemented features and limits](docs/FEATURES.md) · [Verification guide](docs/VERIFICATION.md) · [Screenshot details](docs/SHOWCASE.md) · [Artwork sources and font credits](scripts/art/README.md)
