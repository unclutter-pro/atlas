# Nextcloud Talk

Atlas uses a dedicated, non-admin Nextcloud user. People can invite that account to ordinary rooms, mention it, reply in native threads and exchange direct messages. Atlas can also start a DM with a known Nextcloud user ID.

The supervised listener stores incoming messages before advancing each room's cursor. A central router selects a persistent conversation worker. It does not maintain a model conversation containing every room's traffic.

## Setup

Create a Nextcloud user for the agent and generate an app password in that account's security settings. Store it in `~/secrets/talk-app-password` with mode `0600`, using the dashboard's Secrets editor or your deployment's secret mount. Configure `~/config.yml`:

```yaml
talk:
  url: https://cloud.example.org
  username: atlas
  password_file: /home/agent/secrets/talk-app-password
  rooms: []
  whitelist: [max, alice]
  mention_aliases: []
  worker_trigger: talk-worker
  max_connections: 4
```

An empty `rooms` list permits all conversations the account belongs to. Otherwise every room, including proactive DMs, must have its token in the list. An empty `whitelist` accepts all local registered users in those rooms; entries restrict it to exact user IDs. Guests, bots, bridged actors and federated conversations do not start workers in this implementation. Existing unread messages are imported on first startup; already-read history is cached only as bounded background.

`TALK_URL`, `TALK_USERNAME`, `TALK_PASSWORD_FILE` and `TALK_APP_PASSWORD` override the corresponding file settings. Inline passwords in YAML are rejected. URL and account together determine the storage namespace, so two accounts with the same room token cannot collide. TLS verification uses the runtime's trust store; HTTP requires explicit `allow_insecure_http: true` for trusted test networks.

Container startup runs `talk setup` to create the persistent worker trigger and `~/supervisor.d/talk.conf`. For an existing running container:

```sh
talk setup
talk check
supervisorctl reread
supervisorctl update
talk status
```

Configuration changes take effect after restarting `talk-listener`. A credential rejection exits with code 78 and stops automatic restart; replace the password and run `supervisorctl restart talk-listener`. `talk status` and the dashboard expose listener health. Credentials are read by the transport, not included in model prompts.

## Conversation routing

| Incoming message | Destination |
| --- | --- |
| Normal DM | That private conversation's persistent worker |
| Reply to an anchored message | Worker that owns that message |
| Message in a known native thread | Worker bound to that thread, subject to group attention rules |
| Expected user's explicit reply to a task question | Original task's trigger and session, even if it started on another channel |
| Unquoted answer to exactly one recent question | Original task only when the latest agent message is that question |
| Ambiguous answer | Private conversation asks which question; no task is approved by inference |
| New group mention | Existing explicit mapping, or a small classifier choosing among same-room summaries |
| Unaddressed group traffic | History, except a short follow-up in one recently active conversation |

The stable conversation ID is the Atlas session key. The incoming event separately carries its concrete Talk room/thread address. A new native thread can remain part of the same task; an explicitly independent handoff gets a new conversation and worker. Native message IDs provide anchors; thread titles are never used to infer ownership.

The classifier sees at most ten same-room summaries within a 2,000-byte envelope. Added worker context is bounded to 6,000 bytes, and the current message to 8,000 bytes including its encoded metadata. These conservative byte limits upper-bound common byte tokenizer counts. Full text remains available through `talk message`; a worker can deliberately retrieve bounded history. Conversation history inside the model's persistent session remains subject to the existing harness's compaction rules.

Group attention expires after 30 minutes without activity, unless an anchored open question retains it. A mainline follow-up additionally requires the same participant and one unambiguous active conversation. Workers run with four delivery slots and one active delivery per conversation. DMs and explicit mentions have priority. Inputs accepted while a worker is busy wait durably for the next turn boundary.

Unsent passive group follow-ups in the same conversation/thread are combined in batches of at most eight messages from a two-second window. The shared inline message budget stays at 8,000 bytes. Already accepted inputs are immutable. Classification and outbox recovery run separately from the one-second dispatch loop, so a slow server request or classifier does not hold up known DM/reply routing.

Shared background uses existing `memory/` files and explicit handoffs. A task answer sent back from a private DM includes the relevant question and answer, not the surrounding private transcript. Shared filesystem memory is not tenant isolation; agents must deliberately respect the audience when writing or retrieving memory.

## Sending and asking questions

Run `talk --help` for the complete command reference. Typical operations:

```sh
talk dm --user max --message 'The report is ready.'
talk send --room ROOM --thread 42 --message 'The tests passed.'
talk send --room ROOM --reply-to 57 --message 'I agree with that change.'
talk dm --user max --task 123 --message 'Which date should I use?'
talk request --id REQUEST_ID
```

`--task` verifies that the task is open and belongs to the current trigger/session. Room questions also require `--expect UID`. The question record is saved before the network send; only a confirmed send supplies a blocking wait reason. If the answer arrives before send confirmation, the router briefly holds it for reconciliation. An uncertain send cannot block ordinary DM communication indefinitely: after 30 seconds, a private worker asks for clarification while the question remains unresolved.

The Stop gate permits pausing when all remaining tasks await confirmed questions or depend on those waiting tasks. Unrelated ready work still blocks exit. The answer routes directly back to the owner, without a reply reminder. Task status and owner are checked again immediately before the runner starts a continuation; a late answer cannot start a task that was closed or cancelled in the meantime.

For an actual deadline, schedule a normal time reminder. Its prompt must first run `talk request --id REQUEST_ID --pending` and follow up only if that exits 0. A timeout does not imply consent. `talk request --id REQUEST_ID --cancel` cancels a question from its owning session.

`--send-id ID` identifies a logical send, including its complete multipart plan. Reusing it with identical content/address reuses the saved result; changed content is rejected. Agent-side retries should use stable event/action IDs. Outgoing text and thread titles are checked against stored credential values before admission. This check is a guard against literal leakage, not a general data-loss prevention system.

```sh
# Continue the current conversation in a new native thread:
talk send --room ROOM --new-thread 'Release checks' --message 'Results go here.'

# Start independent work with an explicit handoff:
talk send --room ROOM --new-thread 'Investigate latency' \
  --new-conversation --handoff-file /tmp/latency-handoff.txt \
  --message 'I will investigate this separately.'
```

The handoff describes the new request, constraints, memory references and first action. After the opening message is confirmed, its worker receives a durable handoff event. Existing tasks remain with their source session. Transferring an already executing task between owners is not implemented; this command creates independent work and its own task records.

## Delivery and recovery

State lives in `~/.index/talk/talk.db`; the generic runner's receipts live in `~/.index/atlas.db`. Room message revisions are deduplicated, queued deliveries have leases, and the runner persists an immutable receipt before reporting acceptance. Restart recovery replays accepted but incomplete inputs. Completion is recorded only after a successful turn.

This provides recoverable delivery, not exactly-once model side effects. A crash after an external action and before the receipt completes can replay the input. Stable `--send-id` values make Talk sends idempotent at the local outbox, while other external operations still require their own idempotency.

The outbox stores each send plan before I/O. Multipart continuations preserve the resolved thread/quote destination. A transport timeout or lost response leaves an uncertain outcome; `talk reconcile` and the listener search for the agent's matching `referenceId` in history. They never blindly resend an uncertain message. If the matching history is unavailable, the record remains visibly uncertain for operator review. `referenceId` is a correlation field, not a server guarantee of exactly-once delivery.

Raw messages, completed delivery receipts and completed send-plan text expire after 30 days; compact routing identities, immutable deduplication digests and unresolved-question anchors remain. Reusing an expired send ID reports its expired outcome and never resends it. Model transcripts use the existing harness retention policy separately. Room removal revokes access and cancels its pending questions. The listener catches up from the last durable cursor on reconnect, independently of model execution.

## API support and current limits

The transport checks capabilities at startup. It requires `conversation-v4` and `chat-v2`; native threads, quotes, reactions and silent sending are individually capability-gated. API references: [user conversations](https://nextcloud-talk.readthedocs.io/en/latest/conversation/), [chat and threads](https://nextcloud-talk.readthedocs.io/en/latest/chat/), [capabilities](https://nextcloud-talk.readthedocs.io/en/latest/capabilities/), [bot API](https://nextcloud-talk.readthedocs.io/en/latest/bots/).

The first implementation uses bounded, fair long polling, with periodic full room discovery for new DMs and removals. No model is used for polling. Defaults are four concurrent receive requests, a 25-second long poll and 30-second discovery. Status reports the estimated maximum polling delay as the room count grows. HPB/WebSocket signaling is not implemented; a server advertising HPB still uses this transport.

File upload/download, voice messages, typing indicators, calls, federated rooms, directory-wide contact discovery and transferring live tasks are follow-ups. User IDs for proactive DMs must already be known. These are connector scope limits; the regular user API has more capabilities than the webhook-bot API used by the original PR 273.

Automated tests cover fake OCS responses, durable routing, task waits, uncertainty, context bounds and actual runner subprocess crash/replay. Live validation on 2026-11-03 used Nextcloud 35.0.2 and Talk 25.0.6: DMs, native threads, mentions, reactions, cursor catchup, edits/deletions and the complete question/answer return path passed. That final path used the real dispatcher, runner and CLI with a simulated model query. Integration changes should additionally be checked against the deployed version before production rollout.
