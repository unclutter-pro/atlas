import type { TalkMessage, TalkRoom } from "../../integrations/talk/events.ts";

export type { TalkMessage, TalkRoom };

export interface TalkAddress {
  instance: string;
  room: string;
  threadId: number | null;
}

export interface Conversation extends TalkAddress {
  id: string;
  triggerName: string;
  sessionKey: string;
  title: string;
  summary: string;
  handoff: string;
  state: "active" | "closed";
  createdAt: number;
  updatedAt: number;
}

export interface IncomingEvent {
  id: string;
  instance: string;
  room: string;
  message: TalkMessage;
  createdAt: number;
  status: "pending" | "waiting" | "routed" | "ignored";
  reason: string;
}

export interface Delivery {
  id: string;
  eventId: string;
  instance: string;
  room: string;
  conversationId: string;
  triggerName: string;
  sessionKey: string;
  payload: string;
  priority: number;
  status: "pending" | "leased" | "accepted" | "completed";
  leaseToken: string | null;
  leaseUntil: number | null;
  attempts: number;
  createdAt: number;
  error: string;
}

export interface PendingQuestion extends TalkAddress {
  id: string;
  outboundId: string;
  conversationId: string;
  originTrigger: string;
  originSessionKey: string;
  taskId: number | null;
  expectedUser: string;
  blocking: boolean;
  state: "preparing" | "pending" | "resolved" | "cancelled";
  messageId: number | null;
  answerMessageId: number | null;
  createdAt: number;
  sentAt: number | null;
  resolvedAt: number | null;
  prompt: string;
}

export interface QuestionInput {
  originTrigger: string;
  originSessionKey: string;
  taskId?: number | null;
  expectedUser: string;
  blocking?: boolean;
}

export interface Outbound extends TalkAddress {
  id: string;
  referenceId: string;
  conversationId: string;
  body: string;
  title: string | null;
  replyTo: number | null;
  silent: boolean;
  state: "pending" | "sending" | "sent" | "uncertain" | "failed";
  messageId: number | null;
  requestId: string | null;
  createdAt: number;
  updatedAt: number;
  error: string;
}

export interface PrepareSendInput extends TalkAddress {
  conversationId: string;
  body: string;
  title?: string | null;
  replyTo?: number | null;
  silent?: boolean;
  request?: QuestionInput;
  id?: string;
}

export interface RouterConfig {
  instance: string;
  username: string;
  workerTrigger?: string;
  whitelist?: string[];
  rooms?: string[];
  mentionAliases?: string[];
  followupMs?: number;
  contextTokens?: number;
  messageTokens?: number;
}

export interface ConversationCandidate {
  id: string;
  title: string;
  summary: string;
  state: Conversation["state"];
  updatedAt: number;
}

export type Classification = { kind: "existing"; conversationId: string }
  | { kind: "new" } | { kind: "clarify"; reason?: string };

export interface RouteResult {
  eventId: string;
  path: string;
  conversationId?: string;
  deliveryId?: string;
}
