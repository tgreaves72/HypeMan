# Judging walkthrough

**HypeMan keeps the task beside its source.** A small Y2K companion combines browser assistance, source-linked notes, a shared whiteboard, and durable projects in movable Chrome windows. The goal is to keep useful work and its context together as you read, learn, and act across pages.

## What you need

| Path | Requirements | What you can evaluate |
| --- | --- | --- |
| Local tools | Node.js 24, npm, desktop Google Chrome, and the local gateway | Source selection and notes, direct whiteboard editing/export, saved conversations, and local PDF viewing. No AI account is required. |
| Live AI | The local setup plus an eligible ChatGPT account, plan permission, an available model, and internet access | Page questions, browser reasoning, assistant whiteboard work, learning feedback, and document analysis. |
| Optional phone | A configured Photon Spectrum project, registered recipient, and paired owner phone | Text requests, saved-work delivery, reminders, and check-ins while the gateway and Chrome are running. |

Phone setup is optional for this walkthrough. Detailed account, privacy, and connection instructions are in [SETUP.md](SETUP.md).

## Start locally

From the repository root:

```sh
npm ci
cp .env.example .env
npm run build
npm start
```

Keep the gateway running. In your regular Chrome profile, open `chrome://extensions`, enable **Developer mode**, and **Load unpacked** → `apps/extension/dist`. HypeMan's onboarding page connects to `http://127.0.0.1:8787` automatically. Rebuilds require reloading the extension and refreshing webpage tabs.

## Try the local workflow

This short walkthrough uses an ordinary public page and actual user input. It works without ChatGPT sign-in.

1. Open MDN's [What is JavaScript?](https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Scripting/What_is_JavaScript) and activate HypeMan's avatar. Move or resize the conversation window so the article remains visible.
2. Under **A high-level definition**, highlight the paragraph describing JavaScript and send **save this**. Inspect the saved note and its source link. Append a short takeaway directly in the note, then click outside it to save.
3. Send **open whiteboard**. Choose **Add text** and enter three lines: `HTML → structure`, `CSS → style`, and `JavaScript → behavior`. Finish with Ctrl/Cmd+Enter. Choose **Draw**, add a check mark, and try **Undo**, **Redo**, and **Export board**.
4. Close and reopen the whiteboard to check that its content remains. Send **open library** and use **Find a note** to search for `JavaScript`. Set a course/topic label and choose **Make review card**. Write a question and check its answer. Send **review cards**, recall the answer, reveal it, and choose a rating. Reload the webpage to check the saved note, source, and next review date. Library search and review work without the gateway or AI sign-in.
5. Send **show saved work** and select a conversation to resume. Send **export workspace** to download the stored content as JSON. PDF originals use their own **export this PDF** command.

For a local document check, drop a PDF you own onto the conversation. Inspect its preview and select text. AI questions about the document belong to the live path below.

## Add live AI

Ask **sign in**, choose **Continue with ChatGPT**, approve **Use your ChatGPT plan**, and select an available model. Use regular Chrome for actual authentication. HypeMan uses the account's existing plan allowance; no OpenAI API key is needed.

On the MDN page, ask:

> Using this page, explain how HTML, CSS, and JavaScript work together in three short lines.

Compare the response with the visible article. Then try a goal with several steps:

> Read this page, save three key points with the source, then help me prepare a study plan. Wait for me between milestones.

Send **show projects** to inspect the plan and saved evidence. Continue a step deliberately; check its visible result before confirming completion. **Escape** stops an active request. Projects restore with explicit continuation after restart. Live responses vary by account, model, and page; an unavailable service should report an error.

For browser execution, use a real task you intend to perform. Review the target and any detected consequential-action confirmation before approving it. Passwords, payment details, and verification codes remain user-operated.

## What the evidence covers

The [README screenshots](../README.md#actual-extension-screenshots) show genuine local tools and one live ChatGPT response on MDN. They do not demonstrate every integration or a completed multi-step project.

```sh
npm run check
npm run check:docs
npm run e2e:install
npm run e2e
npm run e2e:ui
npm run e2e:auth
```

`check` runs typechecking, unit/integration tests, and the build. Browser suites load the real MV3 extension in isolated Chromium with controlled provider responses and minimal test-only pages. Mocked authentication verifies the integration flow; it does not establish live account eligibility or consume plan usage. See [VERIFICATION.md](VERIFICATION.md) for additional project, execution, PDF, and messaging checks.

This release is a local, single-user unpacked extension. It supports top-frame HTTP/HTTPS pages; protected Chrome pages and inaccessible frames are outside its reach. Product video help requires captions or a supplied transcript. Actual model quality, transcript retrieval, and Photon delivery require separate live checks. See [implemented features and limits](FEATURES.md).
