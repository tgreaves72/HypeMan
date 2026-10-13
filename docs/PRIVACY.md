# HypeMan privacy policy

Last updated: October 12, 2026.

This policy describes the HypeMan browser extension and its optional, locally running Node gateway. The publisher does not operate a hosted HypeMan AI service in this release. AI and phone features require a gateway on your own computer and the external accounts you choose to connect.

## Information HypeMan handles

The study library stores course/topic labels, review questions and answers, source metadata, next-review dates, and self-ratings locally in extension storage. Its search and review sessions do not send content to an AI service or require a gateway. Optional typed recall during a review stays in the current window and is discarded when you leave the session. Workspace backups include saved cards, schedules, labels, and the latest 2,000 ratings. Deleting a card leaves its source and retained review history intact; removing the extension/profile clears this local data.

When you use the companion, HypeMan can read the current webpage's URL, title, visible text, selected text, and ordinary interactive elements to answer your request and perform browser tasks. It records requested actions and their outcomes. Browser-wide history is not imported. Context from other tabs, screenshots, and real browser input are separate settings that start disabled. Automatic contextual help starts disabled for new installations; you can enable it in Settings. Existing installations retain their saved choice. Pause HypeMan on individual sites to stop observation and page actions there.

HypeMan stores your settings, conversations, notes, saved excerpts and source URLs, projects, whiteboard objects, and optional learning history in extension-owned local browser storage. Uploaded PDFs and extracted page text are stored in extension-owned IndexedDB. PDF passwords remain in the local reader and are not included in AI requests. Content you deliberately submit for AI help, including selected PDF passages or images, can be sent to the connected AI service.

If you connect ChatGPT, the local gateway stores account identity information, account registrations, access tokens, and refresh tokens on your computer. The extension receives account labels and connection status, not those OAuth credentials. Requests sent for inference include the content and context needed for the feature you invoked. This sign-in flow does not grant access to your existing ChatGPT conversations.

If you explicitly pair a phone, the gateway stores its number, pairing state, messages, reminders, saved-workspace snapshots, and delivery records locally. It sends requested messages through the configured Photon service. Phone configuration is optional and requires your own service configuration. It is not enabled by installing the extension.

## External services

- **OpenAI:** account sign-in and AI inference when you connect and authorize your ChatGPT account. These requests use your account's applicable usage limits and OpenAI's terms and privacy practices.
- **Photon Spectrum and its messaging providers:** phone pairing and message delivery only when configured and paired by you.
- **Supadata:** optional video-transcript retrieval when the gateway operator configures a Supadata key. The requested video URL is sent to that service.
- **Google, YouTube, and source websites:** the search box submits your query to Google. Requested navigation and searches open the relevant website. Turning on the rooftop TV loads an embedded YouTube demo; YouTube receives normal player requests, including your IP address and a HypeMan application identifier. It does not receive your HypeMan notes, conversations, or account tokens through the TV. The TV player is unloaded when you turn it off.
- **Wikipedia:** the gateway's source-lookup feature can send a search query to Wikipedia.

These services handle requests under their own policies. The publisher does not receive a copy of your local workspace or operate an analytics or advertising endpoint in this release. Bundled fonts, character skins, fountain artwork, and music load from the extension package.

## Use and sharing

Information is used to provide the browser companion features you request: answering, working with selected context, saving your work, operating supported pages, and delivering explicitly configured phone features. HypeMan does not sell personal information, use it for targeted advertising, or transfer it to data brokers. Personal and sensitive data is not used to determine creditworthiness or for lending purposes. Data is not transferred for unrelated purposes.

HypeMan's use and transfer of information received from Google APIs adheres to the Chrome Web Store User Data Policy, including its Limited Use requirements.

## Your controls and retention

Use Settings to disable automatic help, learning, screenshots, other-tab context, or real browser input. Pause the companion on particular websites. Notes, projects, documents, and learning history can be managed through their tools. Export your workspace before removing the extension if you want to keep a copy.

Signing out clears the gateway's local OAuth tokens and attempts to revoke the remote session. You can also revoke HypeMan's access from your connected account. Unpair your phone to stop the phone integration. External services may retain data according to their own policies.

Local extension data remains until you delete it through HypeMan or remove the extension/profile. Removing the extension does not delete the separate gateway's files. To remove those, stop the gateway and delete its HypeMan configuration directory and its local `.hypeman-token` transport file; the setup guide describes their locations. Backups and exported files are under your control.

The gateway binds to the local computer and authenticates API requests. Only the pinned development extension or the exact store extension ID configured by the gateway operator can discover its connection secret. Do not expose this local gateway to the internet or share account credential files.

## Contact and updates

Report questions through the [HypeMan repository issue tracker](https://github.com/KieranCSchmitt/HypeMan/issues). Do not post private documents, account credentials, phone numbers, or other sensitive content in a public issue. Material changes to data practices will be reflected in this policy and disclosed in the extension when required.
