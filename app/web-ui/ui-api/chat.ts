/**
 * Chat area endpoints under /ui/api/chat. Wire types: ui-api/chat/types.ts.
 *
 * Sessions CRUD, send (JSON or multipart voice), stop the current turn, and a
 * live SSE stream per chat backed by the chat hub (ui-api/chat/hub.ts).
 */

import type { BunRequest } from "bun";
import { chatStreamResponse } from "./chat/sse";
import * as service from "./chat/service";
import {
  MAX_VOICE_BYTES,
  type ChatSessionsResponse,
  type CreateChatSessionRequest,
  type CreateChatSessionResponse,
  type DeleteChatSessionResponse,
  type SendChatMessageRequest,
  type SendChatMessageResponse,
  type UpdateChatSessionRequest,
  type UpdateChatSessionResponse,
} from "./chat/types";
import { badRequest, handler, HttpError, isMultipart, json, notFound, query, readJson, type ApiRoutes } from "./shared/http";

export type * from "./chat/types";

const CLIENT_ID_MAX = 128;

function keyParam(req: BunRequest): string {
  const key = (req.params as Record<string, string | undefined>).key;
  if (!service.isValidSessionKey(key)) badRequest("Invalid session key");
  return key;
}

function clientIdOf(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || value.length > CLIENT_ID_MAX) badRequest("Invalid clientId");
  return value;
}

async function readVoiceForm(req: Request): Promise<{ file: File; message: string; clientId?: string }> {
  const length = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(length) && length > MAX_VOICE_BYTES) throw new HttpError(413, "Voice message is too large");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    badRequest("Invalid multipart body");
  }
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length !== 1) badRequest("Expected exactly one file");
  const file = files[0]!;
  if (file.size > MAX_VOICE_BYTES) throw new HttpError(413, "Voice message is too large");
  if (!service.isAudioFile(file)) badRequest("Only audio files can be sent");
  const message = form.get("message");
  return { file, message: typeof message === "string" ? message : "", clientId: clientIdOf(form.get("clientId")) };
}

export const routes: ApiRoutes = {
  "/ui/api/chat/sessions": {
    GET: handler((req) => {
      const q = query(req);
      const archivedParam = q.get("archived");
      const archived = archivedParam === "only" || archivedParam === "all" ? archivedParam : "exclude";
      return json({ sessions: service.listSessions({ archived, q: q.get("q") ?? undefined }) } satisfies ChatSessionsResponse);
    }),
    POST: handler(async (req) => {
      const body = await readJson<CreateChatSessionRequest>(req);
      return json({ session: service.createSession(body?.title) } satisfies CreateChatSessionResponse, { status: 201 });
    }),
  },

  "/ui/api/chat/sessions/:key": {
    GET: handler((req) => json(service.snapshot(keyParam(req)))),
    PATCH: handler(async (req) => {
      const key = keyParam(req);
      const body = await readJson<UpdateChatSessionRequest>(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) badRequest("Expected a JSON object");
      return json({ session: service.updateSession(key, body) } satisfies UpdateChatSessionResponse);
    }),
    DELETE: handler(async (req) => {
      const key = keyParam(req);
      await readJson(req);
      service.deleteSession(key, { refuseWhileRunning: true });
      return json({ ok: true } satisfies DeleteChatSessionResponse);
    }),
  },

  "/ui/api/chat/sessions/:key/messages": {
    POST: handler(
      async (req) => {
        const key = keyParam(req);
        let sent: service.SentMessage;
        let clientId: string | undefined;
        if (isMultipart(req)) {
          const form = await readVoiceForm(req);
          clientId = form.clientId;
          sent = await service.sendMessage(key, { content: form.message, files: [form.file], clientId, surface: "ui" });
        } else {
          const body = await readJson<SendChatMessageRequest>(req);
          if (typeof body?.content !== "string") badRequest("content must be a string");
          clientId = clientIdOf(body.clientId);
          sent = await service.sendMessage(key, { content: body.content, clientId, surface: "ui" });
        }
        return json(
          { item: service.sentMessageItem(sent, clientId), triggered: sent.triggered } satisfies SendChatMessageResponse,
          { status: 201 },
        );
      },
      { multipart: true },
    ),
  },

  "/ui/api/chat/sessions/:key/stop": {
    POST: handler(async (req) => {
      const key = keyParam(req);
      await readJson(req);
      if (!service.ensureSession(key)) notFound("Chat not found");
      return json(await service.stopTurn(key));
    }),
  },

  "/ui/api/chat/sessions/:key/stream": {
    GET: handler((req) => chatStreamResponse(keyParam(req), req)),
  },
};
