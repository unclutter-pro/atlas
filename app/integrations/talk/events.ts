/** Normalized regular-user Talk API objects. No bot webhook shapes here. */
export interface TalkRoom {
  token: string;
  type: number;
  name: string;
  displayName: string;
  readOnly: boolean;
  lastMessageId: number;
  lastReadMessage: number;
  isFederated: boolean;
}

export interface TalkMessage {
  id: number;
  room: string;
  actorType: string;
  actorId: string;
  actorDisplayName: string;
  message: string;
  messageParameters: Record<string, any>;
  text: string;
  timestamp: number;
  threadId: number | null;
  /** Talk also calls ordinary reply ancestry "threadId"; it is not a named thread. */
  replyRootId?: number | null;
  parentId: number | null;
  parent: TalkMessage | null;
  referenceId: string;
  systemMessage: string;
  deleted: boolean;
  editedAt: number | null;
}

export const ROOM_TOKEN = /^[a-zA-Z0-9]{1,64}$/;

function integer(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

/** Rich object text stays data; callers decide which user-ID mentions address us. */
export function renderTalkMessage(message: string, parameters: Record<string, any>): string {
  return message.replace(/\{([\w-]+)\}/g, (placeholder, key) => {
    const p = record(parameters[key]);
    const name = String(p.name ?? p.id ?? "");
    if (p.type === "user") {
      const id = String(p["mention-id"] ?? p.id ?? "");
      return !id || id === name ? `@${name}` : `@${name} (${id})`;
    }
    if (p.type === "call") return "@all";
    if (p.type === "file") return `[file: ${name}]`;
    if (["guest", "group", "team", "email", "federated_user"].includes(p.type)) return `@${name}`;
    return name || placeholder;
  });
}

export function normalizeRoom(raw: unknown): TalkRoom {
  const r = record(raw);
  const token = String(r.token ?? "");
  if (!ROOM_TOKEN.test(token)) throw new Error("Talk returned an invalid conversation token");
  return {
    token,
    type: integer(r.type),
    name: String(r.name ?? ""),
    displayName: String(r.displayName ?? r.name ?? ""),
    readOnly: r.readOnly === true || Number(r.readOnly) > 0,
    lastMessageId: integer(record(r.lastMessage).id),
    lastReadMessage: integer(r.lastReadMessage),
    isFederated: Boolean(r.remoteServer || r.remoteToken || r.isFederated),
  };
}

export function normalizeMessage(raw: unknown, room: string, includeParent = true): TalkMessage {
  const r = record(raw);
  const id = integer(r.id);
  if (!id || !ROOM_TOKEN.test(room)) throw new Error("Talk returned an invalid message identity");
  if (r.token && String(r.token) !== room) throw new Error("Talk returned a message from a different conversation");
  const parentRaw = record(r.parent);
  const parentId = integer(parentRaw.id) || integer(r.parentId) || null;
  const parameters = record(r.messageParameters);
  const message = String(r.message ?? "");
  const replyRootId = integer(r.threadId) || null;
  return {
    id,
    room,
    actorType: String(r.actorType ?? ""),
    actorId: String(r.actorId ?? ""),
    actorDisplayName: String(r.actorDisplayName ?? ""),
    message,
    messageParameters: parameters,
    text: renderTalkMessage(message, parameters),
    timestamp: integer(r.timestamp),
    // Since Talk 22, even a plain top-level message has threadId === id. Only
    // isThread proves thread membership. Titles never establish identity.
    threadId: r.isThread === true ? replyRootId : null,
    replyRootId,
    parentId,
    parent: includeParent && parentId ? normalizeMessage({ ...parentRaw, id: parentId }, room, false) : null,
    referenceId: String(r.referenceId ?? ""),
    systemMessage: String(r.systemMessage ?? ""),
    deleted: Boolean(r.deleted) || r.messageType === "comment_deleted",
    editedAt: integer(r.lastEditTimestamp) || null,
  };
}

export function mentionsUser(message: TalkMessage, userId: string, aliases: string[] = []): boolean {
  for (const [key, p] of Object.entries(message.messageParameters)) {
    if (p?.type === "user" && String(p["mention-id"] ?? p.id) === userId && message.message.includes(`{${key}}`)) return true;
  }
  // Display names are not authoritative for rich mentions. Aliases are explicit config.
  return [userId, ...aliases].filter(Boolean).some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}_@])@(?:"${escaped}"|${escaped}(?![\\p{L}\\p{N}_.@/-]))`, "iu").test(message.message);
  });
}
