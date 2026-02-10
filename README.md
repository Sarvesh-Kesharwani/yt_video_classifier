# YouTube Local LLM Classifier (Chrome Extension)

A Manifest V3 Chrome extension that:

- Runs on **YouTube only**.
- Reads currently loaded videos from the page.
- Lets users define categories.
- Calls a **local LLM endpoint** (for example Ollama) to classify each video.
- Lets users choose which signals to include for classification:
  - title,
  - description,
  - transcript.

## Install (Developer mode)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder (`yt_video_classifier`).

## Usage

1. Open any `https://www.youtube.com/*` page with videos loaded.
2. Open the extension popup.
3. Configure:
   - Local LLM endpoint (default: `http://localhost:11434/api/generate`)
   - Model (default: `llama3`)
   - Categories (comma-separated)
   - Whether to include title/description/transcript.
4. Click **Classify loaded videos**.
5. Badges are appended to loaded video cards and results are listed in the popup.

## Notes

- Transcript fetching depends on caption availability for each video.
- If no transcript/captions are available, transcript text is left empty.
- This extension classifies currently loaded DOM results only (it does not auto-scroll for more videos).
