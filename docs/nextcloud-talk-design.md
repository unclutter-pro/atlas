# Nextcloud Talk conversation router draft

Atlas should appear in Talk as a colleague with its own Nextcloud account. People can mention it, invite it to a room, answer it in a thread, or receive a direct message from it. A central router keeps those conversations separate. Shared project knowledge comes from memory and explicit task references.

This is the replacement design for [PR 273](https://github.com/unclutter-pro/atlas/pull/273), not an implemented connector. The chosen identity is a dedicated, non-admin Nextcloud user. The bot-only transport from PR 273 does not meet the requirement to start ordinary direct conversations with users.

The design follows the existing [GitHub router](../app/triggers/github/router.ts): receive centrally, filter cheaply, consult persistent mappings, classify only ambiguous new work, and dispatch to the responsible conversation. The entrance has no permanent model conversation containing all room traffic. GitHub remains unchanged in the first implementation.

## Expected interaction

| Situation | Behaviour |
| --- | --- |
| Max writes to Claudius directly | Claudius responds in that direct conversation. Normal follow-ups need no mention or command. |
| A team member mentions Claudius in a room | The router wakes the relevant conversation with a bounded excerpt of that room. |
| Someone replies to Claudius in a thread | The reply reaches the conversation responsible for that thread, including while its worker is busy. |
| Claudius needs Max's decision during work | Claudius opens or reuses their direct conversation, asks a concrete question, and records which task awaits the answer. |
| Max answers that question | An explicit reply identifies the pending request. An unquoted answer uses recent context only when there is one unambiguous request. Otherwise Claudius asks which request Max means. |
| A discussion branches into independent work | A new conversation receives a short handoff and relevant memory references. It has its own session and lifecycle. |
| The team discusses unrelated matters | Messages remain available as history without starting a full worker for each message. |

The user never has to choose an Atlas session, type a routing key, or understand subagents. The account should be clearly named as the team's agent; using a regular account does not mean pretending to be a human.

## Talk API limits and the identity decision

The distinction is between a signed webhook bot and a user authenticated to the regular Talk APIs. Adding `agent_user` to the old connector only helps recognize mentions and direct conversations; it does not authenticate requests as that user.

| Capability | Webhook bot with its shared secret | Dedicated user with an app password |
| --- | --- | --- |
| Post proactively in an existing room | Yes, if that bot is enabled there; no preceding message is required | Yes, subject to membership and posting permissions |
| Start a direct conversation with a user | No bot endpoint to create it, and the bot is not a user participant | Create or reuse a one-to-one room with that user |
| Be invited and mentioned like a colleague | Bot installation/setup is separate; plain text mentions need connector matching | Normal account, participant list and user-ID mentions |
| Read server history and recover gaps | No history endpoint authenticated by the bot secret | Chat history and context APIs, limited by access and server retention |
| Create threads and know their IDs | Supported in the inspected Talk 25 code, but send returns null data | Send returns the created message; use its ID and thread metadata |
| Upload and retrieve attachments | Not through the bot API | Files/WebDAV and Talk sharing APIs, subject to file permissions |
| Edit/delete messages and mark read | No corresponding bot endpoints | Available through user APIs, subject to capabilities, ownership and server rules |
| Typing and presence | No bot equivalent of a normal participant | Requires the relevant client/signaling implementation; typing also depends on the high-performance backend |
| Federated rooms | Bot setup is refused in the inspected implementation | Governed by user access and federation support; not a first-release promise |

The bot endpoint set and null send response are verified against [BotController in Talk 25.0.6](https://github.com/nextcloud/spreed/blob/v25.0.6/lib/Controller/BotController.php). The user-side entry points are [conversation creation](https://nextcloud-talk.readthedocs.io/en/stable/conversation/#creating-a-new-conversation), [chat APIs](https://nextcloud-talk.readthedocs.io/en/stable/chat/), and [ChatController in Talk 25.0.6](https://github.com/nextcloud/spreed/blob/v25.0.6/lib/Controller/ChatController.php). The implementation must discover server capabilities rather than infer support from a version number alone. See also the [typing backend requirement](https://nextcloud-talk.readthedocs.io/en/stable/quick-install/).

Use the user API for all outgoing messages in this design. Mixing bot-authored and user-authored answers would expose two identities and complicate reply correlation.

## Central entrance

The processing path is `Talk listener → durable inbox → router → conversation worker → durable outbox → Talk user API`.

A small supervised Bun service owns authentication, reconnects and event collection. It runs independently of model sessions. Each connection is namespaced by a stable configured instance/account ID, so room or message IDs from different servers cannot collide.

The normal user API does not provide the bot's automatic per-room webhook subscription. Receiving messages therefore needs a client transport:

- Prefer authenticated high-performance-backend signaling when available. Room invitations and updates refresh the conversation list; chat notifications trigger a cursor-based history fetch. Full relayed messages can be ingested directly, but do not prove that no earlier events were missed.
- Use the documented chat long-poll API where push coverage is unavailable. Reconcile the account's room list periodically and after reconnects. New direct conversations must be discovered without an administrator installing a bot in each one.
- Persist one receive cursor per room. Reconnects fetch the missing range before advancing that cursor. Keep the set of actively observed rooms within a configured connection limit; expose delays when falling back to scheduled fetches.

Signaling can be scoped to joined rooms. One WebSocket must not be assumed to deliver every chat in every room the account can access. The transport integration tests must cover simultaneous rooms, a newly created direct conversation and reconnects. Typing support is optional and must not block message delivery.

Long-polling is transport work with no model call. It still costs server resources, and room discovery has a latency bound without push. This is an explicit tradeoff against Atlas's preference for event-driven inputs, not a claim of zero polling. A Nextcloud-side event relay could replace this later, but is not required for the first implementation.

Sources: [chat receive API](https://nextcloud-talk.readthedocs.io/en/stable/chat/#receive-chat-messages-of-a-conversation), [room discovery](https://nextcloud-talk.readthedocs.io/en/stable/conversation/#get-users-conversations), [signaling configuration](https://nextcloud-talk.readthedocs.io/en/stable/internal-signaling/), and [external signaling protocol](https://nextcloud-spreed-signaling.readthedocs.io/en/latest/standalone-signaling-api-v1/).

## Addresses and conversation ownership

Keep three identities separate:

| Identity | Contents | Purpose |
| --- | --- | --- |
| Talk address | instance/account, room token, optional native thread ID | Where a message is visible |
| Atlas conversation | stable conversation ID, current worker session, lifecycle state | Who processes messages and owns the conversation |
| Related work | task IDs and memory references | What independent conversations have in common |

Store bindings from native threads and message/reply anchors to Atlas conversation IDs. A conversation ID survives model compaction and runner restarts. The worker uses `talk-worker` with that ID as the persistent session key; the concrete reply address travels with each event and send request.

Native threads normally have one conversation owner. A main room can contain several topics, so `room/main` must not permanently mean one project. Replies to known messages choose their conversation deterministically. A new unthreaded request can start a separate conversation while its answer still appears naturally in the same room.

Routing order:

1. Validate instance, account, room access and sender policy. Store own messages for correlation, but never wake on the agent's own echo.
2. Apply existing native-thread bindings and explicit reply/pending-request anchors. Conflicting bindings produce a recorded ambiguity, not a guessed task update.
3. Decide whether the agent is addressed: a direct conversation, a real user-ID mention, a reply to its message, or a relevant follow-up in an active conversation.
4. For a new or ambiguous unthreaded request, consider only recent conversation summaries in the same permitted room. A bounded classifier may select an existing conversation or start a new one. It cannot override a known binding or join private and public conversations by semantic similarity.
5. Deliver the event to the owning worker. If specialist work is needed, that worker delegates and remains the communication owner.

Ordinary group traffic stays in the history store. An active conversation may inspect a short batch of plausible follow-ups; unrelated discussion must not cause a full task session to run for every message. An explicit mention always gets attention. Uncertainty about a consequential instruction is resolved in normal chat.

Routing decisions record the selected conversation, target address and reason. Concurrent first events use an atomic binding operation. A per-conversation queue serializes deliveries and prevents two workers from claiming the same conversation.

## Branching without losing the work

Starting a native Talk thread is a communication action. It does not silently transfer ownership or change the sender's default destination.

- Continuing the same task in a new thread binds that thread to the existing conversation. Subsequent corrections reach the worker already doing the work.
- Independent work creates a new conversation. Before its first event is dispatched, save a handoff containing the request, current decisions, constraints, task IDs, expected result, source address and relevant memory references.

The new conversation receives the opening message, including an agent-authored opening message, and the handoff. It does not have to infer its assignment from a title or discover the opening message through a history lookup.

Task ownership is explicit. If responsibility moves, the old worker receives a handoff event and cannot continue executing the same owned task unnoticed. Related conversations may share knowledge without sharing a live model transcript.

When a reply arrives before the outbound request's response has been recorded, hold the unresolved event briefly and reconcile it against the outbox and server message IDs. Never fall back to matching thread titles.

## Proactive direct messages

An agent may initiate communication because a task needs a decision, a promised update is due, or a configured responsibility produces something useful. Existing Atlas tasks and reminders provide those wakeups; no model loops poll for reasons to speak.

The proposed `talk dm --user <nextcloud-user-id> "<message>"` tool performs the following work internally:

1. Resolve the stable user ID from a configured contact or an unambiguous directory result. Do not send to a display-name guess.
2. Create or reuse the direct room through `POST /ocs/v2.php/apps/spreed/api/v4/room` with `roomType=1` and `invite=<user-id>`, subject to server policy.
3. Register the room with the receive transport before sending. Record an outbound intent with origin conversation, task, recipient and a client reference. If an answer is needed, persist the pending request before sending so a fast reply cannot arrive before the request exists.
4. Send through the user chat API and bind the returned message ID to the pending request. Reconcile replies received while the send outcome was still being recorded.
5. Route the answer through the same central entrance. The direct conversation owns the private exchange; a structured answer event goes to the originating task's owner. A private transcript is not automatically copied back to a group.

For example, a deployment task asks Max privately whether to use staging or production. Max replies to that message. The router resolves the request, supplies the decision to the deployment worker and lets it continue. If two pending questions exist and Max merely writes "yes", the agent asks which question he means.

Delivery never depends on the originating process staying alive. Reminder and worker IDs are durable references. Quiet hours, notification limits and batching apply to proactive updates; urgent explicit requests can use the configured exception. A successful API send is not proof that the user's device displayed a notification or that the user read it.

## Waiting for replies through reminders

Extend the existing [reminder mechanism](../app/triggers/manage-reminders.ts), which already supports `--when-reply-to=<email-thread-id>`, optional sender matching and a timeout. It captures the originating trigger and session key so a matching email can resume the waiting session. Its current reply detection is email-specific and checked by the periodic reminder pass; Talk support needs an additional event type, not an unchanged invocation of that flag.

The responsibilities are distinct. The Talk router resolves which pending question an incoming message answers. The reminder subsystem durably schedules the continuation of the originating task. Memory supplies background knowledge but never substitutes for either association.

Add a `conversation_reply` reminder type keyed by a stable request ID. The pending request records the source conversation, originating trigger/session key, task ID, instance/account, room/thread, expected user's stable ID, sent message anchor, optional deadline and continuation instructions. Do not match merely on the DM room: several tasks can ask the same person questions there.

An agent-facing `talk ask` operation should create the request, outbound intent and reply wait as one recoverable workflow. The request ledger is authoritative; reminder registration is idempotent by request ID and can be rebuilt after a crash. This avoids requiring the model to remember a separate reminder command after sending. A failed send does not leave an apparently successful question waiting indefinitely.

Once an answer is correlated, record its message ID and enqueue the reminder continuation immediately through the durable delivery path. Claiming a request and recording that continuation must be atomic, or use a transactional outbox. A periodic recovery pass repairs interrupted delivery and handles timeouts; normal Talk answers need not wait for the next cron tick. The reminder and ordinary DM routing must not independently execute the originating task twice.

The runner injects into the owning session if it is active, otherwise resumes it. Extend `hasPendingContinuation` to recognize a valid pending conversation reply for that same trigger/session key, allowing the agent to stop running while its task waits. If ownership has moved, resolve the recorded handoff rather than silently waking an unrelated fresh session.

A timeout means "no matching answer yet", never approval. It wakes the task to decide whether to ask again or continue differently. Keep the question's reply anchor after timeout so a late answer can still reach the correct task as a separate event. Cancellation or task completion suppresses automatic execution; late replies can still be acknowledged in the conversation.

Ordinary chat messages use the normal conversation bindings and need no reminder. Reply waits are for work that must resume when a particular answer arrives.

## Memory and context limits

Use the existing [file-based Atlas memory](memory.md), including source references and current/superseded decisions. No separate global conversation transcript or second semantic-memory service is needed.

The routing ledger is authoritative for ownership, pending questions and delivery state. Memory stores knowledge such as project decisions, preferences and outcomes. It must not be the only record of which worker awaits a reply.

Each worker receives the current event or short batch, a compact conversation summary, unresolved requests and only relevant retrieved memory. A child conversation starts with its handoff. Historical messages are fetched through a bounded tool when needed.

Initial tunable budgets:

| Input | Proposed limit |
| --- | --- |
| Classifier candidates | At most 10 recent conversation summaries, 2,000 tokens total |
| Additional context per worker delivery | 6,000 tokens across summary, recent messages and retrieved memory |
| Current message/batch inline | 8,000 tokens; retain the complete message and expose a retrieval reference when larger |
| Group follow-up batch window | 1 second, with a maximum dispatch delay of 2 seconds |
| Global worker concurrency | 4, with direct messages and explicit mentions ahead of passive follow-ups |
| Automatic group follow-up | While related work or a question remains open; otherwise expire after 30 minutes of inactivity |
| Cached raw chat retention | 30 days by default; unresolved requests and required anchors remain until resolved |

These are proposed operating defaults, not measured capacity. Count against the selected model's context allowance, including its existing transcript and output reserve. Compact or start a successor with a summary before that allowance is exhausted. Never label arbitrary character clipping as token budgeting.

Closing an active topic stops automatic worker wakeups but preserves the binding. A later mention or reply can reopen it with a summary. The user does not need `/new` to keep the system healthy.

Private conversation content must not automatically become group context. Memory references and handoffs carry origin/audience information, and retrieval/output policies respect it. Atlas currently shares a filesystem and broad tool access across sessions, so this is a collaboration policy, not a sandbox or a claim of tenant isolation. Strong isolation would require a separate access-control design.

## Durable delivery

The receive transaction saves normalized messages and pending events before advancing the room cursor. Every event has a stable identity derived from instance, room, message, event kind and revision when available. Edits must not disappear merely because the original message ID was seen before.

Use `pending → leased → accepted → completed` event states with expiring leases and an audit trail. A runner needs a durable event-ID receipt before the queue records `accepted`. An existing process or lock file is not that receipt. Retrying the same event must not inject it twice; a crashed lease holder must not strand it forever.

The [GitHub dispatch helper](../app/triggers/github/runtime.ts) is useful precedent for waiting on dispatch, but its lock-based acceptance is insufficient for this guarantee. Add a narrow event-ID receipt to the shared runner interface and keep existing callers compatible.

Outgoing intents are persisted before network I/O. Store returned message IDs and references, and suppress the corresponding incoming self-events. A timeout after a send has an unknown outcome: reconcile against history before deciding whether to retry. A `referenceId` supports correlation; it is not assumed to provide server-enforced exactly-once sending. If reconciliation cannot decide, expose an uncertain delivery rather than blindly posting again.

Bind all chunks of a long message to one resolved destination. Validate message text, thread title and attachments consistently. Respect rate limits and stop automatic retries on authentication failures until credentials are repaired.

History recovery can only recover messages the server still retains and permits the account to read. Deletes, expiry and permission loss cannot be repaired by a local queue. Record these gaps and avoid replaying stale work as a new instruction.

## First implementation scope

The replacement implementation uses Bun/TypeScript, matching the GitHub router and existing runner. Keep Talk transport details out of the generic runner.

| Component | Responsibility |
| --- | --- |
| `app/integrations/talk/client.ts` | User authentication, capability discovery, room/chat/file API calls |
| `app/integrations/talk/listener.ts` | Supervised connection, discovery, cursors, reconnect and catch-up |
| `app/triggers/talk/events.ts` | Normalize messages, replies, threads and available revisions |
| `app/triggers/talk/ledger.ts` | Events, leases, conversations, address/anchor bindings, pending requests and outbox |
| `app/triggers/talk/router.ts` | Pure routing decisions with injected dependencies |
| `app/triggers/talk/runtime.ts` | Runner delivery, receipts, Atlas inbox and observability |
| `app/integrations/talk/cli.ts` and `app/bin/talk` | Agent-facing send, reply, direct message, thread, history and status commands |
| Talk prompts and setup guide | Natural chat behaviour, handoff contract and account setup |

First-release requirements are direct messages in both directions, group mentions/replies, native threads, reliable restarts, explicit conversation ownership, bounded context and proactive questions with reply correlation. Setup uses a dedicated account and app password, never the human user's credentials. The setup flow reports which optional capabilities are available.

File operations, typing indicators, calls, federation and directory-wide discovery are separate follow-ups. The first release must report those gaps honestly. Ordinary mentions, proactive DMs and native threads must work without those additions.

The original PR's message rendering, formatting, fixtures and relevant tests can inform the replacement. Its bot-signature transport, title-based thread correlation and fire-and-forget delivery are superseded. Do not silently migrate a bot identity to a user identity: migrate configuration deliberately, keep old message authors intact, and require explicit mapping or a handoff for any resumed work.

## Acceptance criteria

1. Two simultaneous rooms and two threads in one room deliver to the intended conversations without mixing their recent context.
2. A direct chat initiated by either Max or the agent is discovered and usable without room-by-room bot setup. Test discovery with and without the high-performance backend.
3. Known threads and explicit replies route without a classifier call. Repeated delivery of one event produces one durable runner receipt.
4. A new native thread continuing a task reaches the same worker. Independent work gets a new worker with the opening message and persisted handoff.
5. A proactive question and its reply reminder survive a runner restart. A fast reply cannot outrun request registration. Its quoted answer resumes the originating task once; an ambiguous unquoted answer does not approve arbitrary work. Pending reply waits satisfy the Stop hook for that task's session. Test timeout/answer races, late replies, cancellation and two questions to the same user from different tasks.
6. Crashes before/after inbox commit, cursor update, runner receipt and model turn completion neither strand events nor silently acknowledge unprocessed work.
7. A successful remote send followed by a client timeout is reconciled before resend. Own echoes do not produce loops, and parallel sends with the same title remain distinct.
8. A busy room cannot exhaust the worker limit. Passive traffic does not continuously wake full workers, and inline inputs obey the token budget.
9. Compaction and closed-topic reopening preserve task IDs, constraints and unresolved questions. Shared memory does not automatically copy private DM transcripts into groups.
10. New threads, cross-thread quoted replies and all parts of split messages use the resolved target. Thread titles pass the same secret checks as message bodies.
11. Membership removal, revoked credentials, unavailable history and unsupported capabilities produce observable states with actionable errors.
12. Live tests exercise the actual runner, not only a trigger stub, on the deployed Nextcloud/Talk version. Cover short replies arriving while work is running and while an outbound send is still being recorded.

The implementation PR is ready only when these tests cover the full receive, route, work, send and reply path. This design draft does not claim that those behaviours are already implemented.
