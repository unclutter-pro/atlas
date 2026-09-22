---
name: video
description: Create or edit Remotion videos, animations and compositions, render them, or build Remotion players. For cutting existing footage with FFmpeg, use video-edit.
---

# Remotion video

Use the project's installed Remotion version and preserve user edits. Install dependencies locally with the project's package manager. Load only the reference for the current task:

- [Create a project or composition](references/remotion-create/REFERENCE.md).
- [React markup, media, animation and sound effects](references/remotion-markup/REFERENCE.md).
- [Captions and transcription](references/remotion-captions/REFERENCE.md).
- [Rendering and transparency](references/remotion-render/REFERENCE.md).
- [Media metadata and transformations](references/remotion-multimedia/REFERENCE.md).
- [Maps](references/remotion-maps/REFERENCE.md).
- [Interactive Studio editing](references/remotion-interactivity/REFERENCE.md).
- [Launch Studio](references/remotion-studio/REFERENCE.md).
- [Player and server rendering](references/remotion-saas/REFERENCE.md).
- [API documentation](references/remotion-docs/REFERENCE.md).
- [Version upgrades](references/remotion-upgrade/REFERENCE.md), only when an upgrade is requested or required by the task.

These references track upstream 4.0.526. For an older project, verify new APIs against its installed version before using them. Do not upgrade an unrelated project or replace the user's chosen engine merely to follow a reference. Existing design conventions and the user's authorization take precedence over upstream examples and workflow preferences.

For sound effects, read [sfx.md](references/remotion-markup/sfx.md). For editable source clips in Remotion Studio, read [video-editing.md](references/remotion-markup/video-editing.md). For a plain FFmpeg cut, use `video-edit` instead.

## Upstream

Reference snapshot: [remotion-dev/skills at bbb139d5ba3709b1ffeb27184e9579c681230a08](https://github.com/remotion-dev/skills/tree/bbb139d5ba3709b1ffeb27184e9579c681230a08/skills/remotion-best-practices), reviewed 2026-09-21. The upstream monolithic rules were replaced by task-specific references. Atlas adapts parent links to this directory layout and shares the maps reference instead of copying it into markup a second time. Keep the Atlas entrypoint when refreshing the snapshot and check local links after updating.
