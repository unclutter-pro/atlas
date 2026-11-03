---
name: talk
description: Communicate through Nextcloud Talk: reply in a room or thread, proactively DM a user, ask a task-bound question, or start an independent conversation with a handoff. Also use for Talk setup and delivery diagnostics.
---

# Nextcloud Talk

Atlas uses a dedicated regular Nextcloud user and app password. Read `talk --help` for commands and flags. Check setup with `talk check`, listener health and unresolved delivery with `talk status`.

For a reply, use the incoming event's room and thread. `talk send --room TOKEN --reply-to ID --message TEXT` quotes an existing message; the quoted message determines the destination thread. Use an explicit stable `--send-id` for each logical response so retries reuse its persisted result. An uncertain result needs `talk reconcile`; sending a new message ID could duplicate a successful but unacknowledged send.

For proactive contact, run `talk dm --user UID --message TEXT`. Add `--task ID` when that exact task needs an answer. This saves the expected user and owning session before sending. An answer returns to the owner automatically; no reply reminder is needed. A plain DM without a question belongs to its private conversation worker.

Keep a task open while waiting. Work on other ready tasks; confirmed unanswered questions permit their task and dependent work to pause. Timed reminders can remind you to follow up, but must first check `talk request --id REQUEST_ID --pending`. Closed tasks and cancelled questions must not restart work from a late answer.

For a native thread continuing the same task, use `--new-thread TITLE`. Independent work also needs `--new-conversation --handoff-file FILE`; include the new request, constraints, memory references and what the child should do first. The child owns new task records. Existing task ownership is unchanged.

Keep private DM history within that audience. An answer event carries only the relevant question and answer back to the source task. Store shared knowledge deliberately in existing `memory/` files; raw chat is available through `talk message` and bounded `talk history` when needed.

For installation details, capability limits and recovery, read `/atlas/docs/nextcloud-talk.md` if present, or the repository's `docs/nextcloud-talk.md`.
