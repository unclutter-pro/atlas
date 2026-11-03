import type { Database } from "bun:sqlite";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getTriggerDeliveryOwner, getTriggerReceipt, pruneCompletedTriggerReceipts } from "../../lib/trigger-receipts.ts";
import { isPidAlive } from "../../lib/trigger-socket.ts";
import { TalkClient, TalkError } from "../../integrations/talk/client.ts";
import { roomAllowed, type TalkConfig } from "../../integrations/talk/config.ts";
import { TalkListener, type TalkListenerStatus } from "../../integrations/talk/listener.ts";
import { pruneSendBatches, recoverOutbox } from "../../integrations/talk/outbox.ts";
import { TalkLedger } from "./ledger.ts";
import { routeDeterministicPending, routePending } from "./router.ts";
import { createTalkClassifier } from "./classifier.ts";
import { isTaskActive } from "./lifecycle.ts";
import { talkContinuationSkipReason } from "./continuation-guard.ts";
import { queueHandoffs } from "./handoff.ts";
import { coalesceGroupDeliveries } from "./batch.ts";
import type { Delivery } from "./types.ts";

type SpawnRunner = (delivery: Delivery) => { exited: Promise<number>; kill?: (signal?: NodeJS.Signals) => void };
type StartingRunner = { until: number; exited: boolean; code?: number; kill?: (signal?: NodeJS.Signals) => void; terminating?: boolean };

/** Acceptance and completion are different: a PID or successful spawn is neither. */
export class TalkDispatcher {
  private starting = new Map<string, StartingRunner>();
  private retryAt = new Map<string, number>();
  private readonly spawn: SpawnRunner;
  constructor(readonly ledger: TalkLedger, readonly db: Database, readonly instance: string,
    options: { spawn?: SpawnRunner; now?: () => number; script?: string; isAlive?: (pid: number) => boolean } = {}) {
    this.now = options.now ?? Date.now;
    this.isAlive = options.isAlive ?? isPidAlive;
    this.spawn = options.spawn ?? ((d) => {
      const child = Bun.spawn(["bash", options.script ?? resolve(import.meta.dir, "../trigger.sh"), d.triggerName, d.payload, d.sessionKey, "--event-id", d.eventId], {
        // Supervisor stops the listener's process group on configuration changes.
        // Workers own their lifetime and must survive that transport restart.
        detached: true, stdin: "ignore", stdout: "inherit", stderr: "inherit", env: process.env,
      });
      child.unref();
      return child;
    });
  }
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;

  private defer(d: Delivery, reason: string): void {
    this.retryAt.set(d.id, this.now() + Math.min(300_000, 10_000 * 2 ** Math.min(5, Math.max(0, d.attempts - 1))));
    this.ledger.releaseDelivery(d.id, reason, d.leaseToken ?? undefined);
    this.starting.delete(d.id);
  }

  private reconcile(d: Delivery): void {
    const receipt = getTriggerReceipt(this.db, d.triggerName, d.sessionKey, d.eventId);
    if (receipt?.state === "completed") {
      this.ledger.completeDelivery(d.id, receipt.completionReason ?? ""); this.starting.delete(d.id); this.retryAt.delete(d.id); return;
    }
    const starting = this.starting.get(d.id);
    if (receipt) {
      if (d.status === "leased") this.ledger.acceptDelivery(d.id, d.leaseToken!);
      const owner = getTriggerDeliveryOwner(this.db, d.triggerName, d.sessionKey);
      if (owner && this.isAlive(owner)) { this.starting.delete(d.id); this.retryAt.delete(d.id); return; }
    }
    if (starting && !starting.exited) {
      if (d.leaseToken) this.ledger.renewDeliveryLease(d.id, d.leaseToken);
      // Never start a competing process just because startup exceeded a timer.
      // Terminate the old attempt and wait for its exit before retrying.
      if (starting.until <= this.now() && starting.kill) {
        try { starting.kill(starting.terminating ? "SIGKILL" : "SIGTERM"); } catch {}
        starting.terminating = true;
        starting.until = this.now() + 5000;
      }
      return;
    }
    if (starting?.exited) {
      this.defer(d, `Runner exited before ${receipt ? "completing" : "durably accepting"} delivery (${starting.code})`);
      return;
    }
    if (!this.db.query("SELECT 1 FROM triggers WHERE name=? AND enabled=1 AND session_mode='persistent'").get(d.triggerName)) {
      this.ledger.releaseDelivery(d.id, "Trigger is disabled or not persistent", d.leaseToken ?? undefined);
      return;
    }
    const skip = talkContinuationSkipReason(this.db, d);
    if (skip && !receipt) {
      this.ledger.completeDelivery(d.id, `skipped: ${skip}`);
      this.retryAt.delete(d.id);
      return;
    }
    // Already accepted continuations are checked again by the runner before
    // their turn; it records a terminal receipt if ownership/task state changed.
    if ((this.retryAt.get(d.id) ?? 0) > this.now()) {
      this.ledger.releaseDelivery(d.id, "Delivery retry is deferred", d.leaseToken ?? undefined);
      return;
    }
    try {
      const state: StartingRunner = { until: this.now() + 30_000, exited: false };
      this.starting.set(d.id, state);
      const process = this.spawn(d);
      state.kill = process.kill?.bind(process);
      process.exited.then(code => { state.exited = true; state.code = code; }, () => { state.exited = true; state.code = -1; });
    } catch {
      this.defer(d, "Could not launch trigger runner");
    }
  }

  tick(): void {
    for (const d of this.ledger.deliveries().filter(d => d.instance === this.instance && ["leased", "accepted"].includes(d.status))) this.reconcile(d);
    const eligibleTriggers = (this.db.query("SELECT name FROM triggers WHERE enabled=1 AND session_mode='persistent'").all() as { name: string }[]).map(t => t.name);
    // Claim only the available slots. Per-session serialization is enforced in SQLite.
    for (let n = 0; n < 4; n++) {
      const excludeSessions = this.ledger.deliveries().filter(d => d.instance === this.instance
        && (this.retryAt.get(d.id) ?? 0) > this.now());
      const next = this.ledger.claimDelivery({ maxConcurrent: 4, instance: this.instance, eligibleTriggers, excludeSessions });
      if (!next) break;
      this.reconcile(next);
    }
  }
}

function acquireListenerLock(home: string): () => void {
  const dir = join(home, ".index/talk");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "listener.pid");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return () => { try { if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path); } catch {} };
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(readFileSync(path, "utf8"));
      if (pid && isPidAlive(pid)) throw new Error("Talk listener is already running");
      unlinkSync(path);
    }
  }
  throw new Error("Could not acquire Talk listener lock");
}

export async function runTalkService(config: TalkConfig, ledger: TalkLedger, db: Database, signal?: AbortSignal): Promise<void> {
  const home = process.env.HOME ?? "/home/agent";
  const unlock = acquireListenerLock(home);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const client = new TalkClient(config, { signal: controller.signal });
  const dispatcher = new TalkDispatcher(ledger, db, config.instance);
  let status: TalkListenerStatus;
  const statusPath = join(home, ".index/talk/status.json");
  const writeStatus = () => {
    writeFileSync(`${statusPath}.tmp`, JSON.stringify({ ...status, updatedAt: Date.now(), instance: config.instance }), { mode: 0o600 });
    renameSync(`${statusPath}.tmp`, statusPath);
  };
  const listener = new TalkListener(config, client, {
    getCursor: room => ledger.getCursor(config.instance, room),
    persist: (room, messages, cursor, options) => { ledger.ingest(config.instance, room, messages, cursor, options); },
    onRooms: (rooms, startedAt) => ledger.reconcileRooms(config.instance, rooms, startedAt),
    onRevokedRoom: room => ledger.revokeRoom(config.instance, room),
    onStatus: next => { status = next; writeStatus(); },
  });
  status = listener.status();
  const classify = createTalkClassifier();
  const deps = {
    classify,
    isTaskActive: (trigger: string, key: string, task: number) => isTaskActive(db, trigger, key, task),
    isTriggerEnabled: (trigger: string) => !!db.query("SELECT 1 FROM triggers WHERE name=? AND enabled=1").get(trigger),
  };
  let lastOutbox = 0, lastPrune = 0;
  let classifying: Promise<void> | null = null, recovering: Promise<void> | null = null;
  let backgroundError: unknown;
  const failed = (error: unknown) => { backgroundError = error; abort(); };
  const mayExecute = () => !controller.signal.aborted && !existsSync(join(home, ".atlas-paused"));
  const pump = async () => {
    while (!controller.signal.aborted) {
      if (status.state === "running" && status.lastDiscoveryAt !== null && mayExecute()) {
        // CLI-created DMs become receive destinations before their first reply.
        for (const room of ledger.getRooms(config.instance)) {
          if (roomAllowed(config, room.token) && !room.isFederated) listener.registerRoom(room);
        }
        routeDeterministicPending(ledger, config, deps);
        queueHandoffs(ledger, config.instance, config.rooms);
        coalesceGroupDeliveries(ledger, config.instance);
        dispatcher.tick();
        if (!classifying) {
          classifying = routePending(ledger, config, deps).then(() => {}).catch(failed).finally(() => { classifying = null; });
        }
        if (!recovering && Date.now() - lastOutbox >= 10_000) {
          lastOutbox = Date.now();
          recovering = recoverOutbox(ledger, client, config, { maySend: mayExecute }).catch(failed).finally(() => { recovering = null; });
        }
        if (Date.now() - lastPrune >= 3_600_000) {
          pruneSendBatches(ledger); ledger.prune(); pruneCompletedTriggerReceipts(db);
          lastPrune = Date.now();
        }
      }
      writeStatus();
      await new Promise<void>(done => {
        const finish = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); done(); };
        const timer = setTimeout(finish, 1000);
        controller.signal.addEventListener("abort", finish, { once: true });
      });
    }
  };
  try {
    // Ingestion continues during worker execution and cold-path classification.
    const ingest = listener.run(controller.signal).finally(abort);
    const routing = pump().finally(abort);
    const settled = await Promise.allSettled([ingest, routing]);
    await Promise.allSettled([classifying, recovering]);
    for (const result of settled) if (result.status === "rejected") throw result.reason;
    if (backgroundError) throw backgroundError;
  } catch (error) {
    if (error instanceof TalkError && error.code === "auth") status.state = "auth_failed";
    throw error;
  } finally {
    abort(); listener.stop();
    signal?.removeEventListener("abort", abort);
    if (!["auth_failed", "unsupported"].includes(status.state)) status.state = "stopped";
    writeStatus(); unlock();
  }
}
