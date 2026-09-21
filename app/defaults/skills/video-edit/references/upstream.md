# Upstream maintenance

Bundled Python helpers and render tests are from `browser-use/video-use` at commit [9575612f066aa517354790a645fd90f9f95a743b](https://github.com/browser-use/video-use/tree/9575612f066aa517354790a645fd90f9f95a743b), reviewed 2026-09-21. Preserve `LICENSE.txt` when updating.

This revision includes source-FPS preservation, rotation-aware portrait detection, HDR-to-SDR conversion, explicit audio-track selection and silent-track detection before transcription uploads.

Atlas changes:

- Helpers live in `scripts/` and tests resolve that directory.
- Credentials come from environment or an explicit secret-file path, not implicit `.env` files.
- Transcript caches include a source SHA256 and transcription options; stale sources are transcribed again. Writes are atomic.
- The skill keeps editing decisions with the user task and does not import upstream's mandatory approval or delegation workflow.

When updating, compare these adaptations, run the render/transcription tests and render a synthetic multi-segment clip. No external transcription request is needed for those checks.
