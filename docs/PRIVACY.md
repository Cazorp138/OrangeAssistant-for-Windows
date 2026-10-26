# Privacy

OrangeAssistant is designed to keep study material on the local computer.

## Local data

The app stores the following under `%APPDATA%\OrangeAssistant`:

- `library/` — copied PDFs and conversation data.
- `settings.json` — UI preferences and the user's API key.
- `memos.json` — memo content and categories.

The original PDF chosen by the user is not modified. Importing creates a private copy inside the application data directory.

## Network requests

The app has no telemetry, analytics, crash reporting or automatic update service.

A request is made only when the user sends a chat message and has configured an API endpoint and key. The request goes directly to the configured OpenAI-compatible service. Depending on the question, it may contain:

- the question;
- chapter text or selected PDF text;
- extracted text from a screenshot;
- a screenshot image, when the selected model accepts images.

The provider's own privacy policy applies to those requests. Do not send confidential documents to a provider you do not trust.

## API keys

The API key is stored locally in `settings.json` and is only read by the main process when making a request. It is never written into the repository, logs, or exported data.

## Deleting data

- Deleting a book removes its copied PDF and conversations.
- Deleting a memo or category changes only `memos.json`; deleting a category moves its memos to "未分类".
- Uninstalling the app keeps user data by default (`deleteAppDataOnUninstall: false`).
- To remove everything, delete `%APPDATA%\OrangeAssistant`.
