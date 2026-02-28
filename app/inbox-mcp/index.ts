import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdirSync, closeSync, openSync, writeFileSync, readFileSync } from "fs";
import { getDb } from "./db";

// --- Session context from environment ---
const ATLAS_TRIGGER = process.env.ATLAS_TRIGGER || "";
const ATLAS_TRIGGER_SESSION_KEY =
  process.env.ATLAS_TRIGGER_SESSION_KEY || "_default";
const IS_TRIGGER = !!ATLAS_TRIGGER;

const IS_REVIEWER = !!process.env.ATLAS_REVIEWER_TASK_ID;

function isReviewEnabled(): boolean {
  try {
    const raw = readFileSync(process.env.HOME + "/config.yml", "utf-8");
    const reviewSection = raw.split(/^review:/m)[1];
    if (!reviewSection) return false;
    const lines = reviewSection.split("\n");
    for (const line of lines) {
      if (/^\S/.test(line)) break; // left into next section
      const m = line.match(/^\s+enabled:\s*(true|false)/);
      if (m) return m[1] === "true";
    }
    return false;
  } catch {
    return false;
  }
}


/** Touch a file (create or update mtime) */
function touchFile(path: string): void {
  closeSync(openSync(path, "w"));
}

/** JSON MCP response helper */
function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}
function err(message: string) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error: message }) },
    ],
  };
}

/** Wake a trigger session if it's awaiting this task */
function wakeTriggerIfAwaiting(taskId: number, responseSummary: string): void {
  const db = getDb();

  // Single JOIN query to get all wake data at once
  const awaiter = db
    .prepare(
      `SELECT ta.trigger_name, ta.session_key,
            COALESCE(ts.session_id, '') AS session_id,
            COALESCE(t.channel, 'internal') AS channel
     FROM task_awaits ta
     LEFT JOIN trigger_sessions ts ON ts.trigger_name = ta.trigger_name AND ts.session_key = ta.session_key
     LEFT JOIN triggers t ON t.name = ta.trigger_name
     WHERE ta.task_id = ?`,
    )
    .get(taskId) as
    | {
        trigger_name: string;
        session_key: string;
        session_id: string;
        channel: string;
      }
    | undefined;

  if (!awaiter) return;

  // Write wake file for watcher — JSON with everything needed to re-awaken the trigger
  // Use per-task filename to prevent overwrite when two tasks complete for the same trigger
  const wakeData = JSON.stringify({
    task_id: taskId,
    trigger_name: awaiter.trigger_name,
    session_key: awaiter.session_key,
    session_id: awaiter.session_id,
    channel: awaiter.channel,
    response_summary: responseSummary,
  });

  const indexDir = process.env.HOME + "/.index";
  mkdirSync(indexDir, { recursive: true });
  try {
    writeFileSync(
      `${indexDir}/.wake-${awaiter.trigger_name}-${taskId}`,
      wakeData,
    );
  } catch (e) {
    // Leave task_awaits intact — watcher startup scan will recover this
    console.error(`[wake] Failed to write wake file for task ${taskId}: ${e}`);
    return;
  }

  // Only delete AFTER wake file is confirmed on disk
  db.prepare("DELETE FROM task_awaits WHERE task_id = ?").run(taskId);
}

function writeReviewWakeFile(taskId: number): void {
  const db = getDb();

  const awaiter = db.prepare(
    `SELECT ta.trigger_name, ta.session_key,
            COALESCE(ts.session_id, '') AS session_id,
            COALESCE(t.channel, 'internal') AS channel,
            tk.content AS task_content,
            tk.response_summary AS response_summary
     FROM task_awaits ta
     LEFT JOIN trigger_sessions ts ON ts.trigger_name = ta.trigger_name AND ts.session_key = ta.session_key
     LEFT JOIN triggers t ON t.name = ta.trigger_name
     LEFT JOIN tasks tk ON tk.id = ta.task_id
     WHERE ta.task_id = ?`
  ).get(taskId) as {
    trigger_name: string; session_key: string; session_id: string;
    channel: string; task_content: string; response_summary: string;
  } | undefined;

  if (!awaiter) return;

  const reviewData = JSON.stringify({
    task_id: taskId,
    trigger_name: awaiter.trigger_name,
    session_key: awaiter.session_key,
    session_id: awaiter.session_id,
    channel: awaiter.channel,
    task_content: awaiter.task_content,
    response_summary: awaiter.response_summary,
  });

  const indexDir = process.env.HOME + "/.index";
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(`${indexDir}/.review-${taskId}`, reviewData);
}


const server = new McpServer({
  name: "inbox-mcp",
  version: "2.0.0",
});

// =============================================================================
// TRIGGER TOOLS — only registered when ATLAS_TRIGGER is set
// =============================================================================
if (IS_TRIGGER) {
  // --- task_create: Create a task for the worker session ---
  server.tool(
    "task_create",
    "Create a task for the worker session. Automatically wakes the worker and registers for re-awakening when done.",
    {
      content: z
        .string()
        .describe(
          "Task brief with full context (self-contained — worker has no access to this conversation)",
        ),
    },
    async ({ content }) => {
      const db = getDb();

      const task = db
        .prepare(
          "INSERT INTO tasks (trigger_name, content) VALUES (?, ?) RETURNING *",
        )
        .get(ATLAS_TRIGGER, content) as any;
      const taskId = task.id;

      // Auto-register for re-awakening
      db.prepare(
        "INSERT OR REPLACE INTO task_awaits (task_id, trigger_name, session_key) VALUES (?, ?, ?)",
      ).run(taskId, ATLAS_TRIGGER, ATLAS_TRIGGER_SESSION_KEY);

      // Touch wake file to wake the worker session
      const indexDir2 = process.env.HOME + "/.index";
      mkdirSync(indexDir2, { recursive: true });
      touchFile(indexDir2 + "/.wake");

      return ok(task);
    },
  );

  // --- task_get: Check task status ---
  server.tool(
    "task_get",
    "Get a specific task by ID — check its status and response_summary",
    {
      task_id: z.number().describe("ID of the task to retrieve"),
    },
    async ({ task_id }) => {
      const db = getDb();
      const task = db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(task_id);
      if (!task) return err(`Task ${task_id} not found`);
      return ok(task);
    },
  );

  // --- task_update: Update a pending task ---
  server.tool(
    "task_update",
    "Update the content of a pending task. Only works if the worker hasn't picked it up yet (status='pending').",
    {
      task_id: z.number().describe("ID of the task to update"),
      content: z.string().describe("New task brief content"),
    },
    async ({ task_id, content }) => {
      const db = getDb();
      const task = db
        .prepare("SELECT status FROM tasks WHERE id = ?")
        .get(task_id) as { status: string } | undefined;
      if (!task) return err(`Task ${task_id} not found`);
      if (task.status !== "pending")
        return err(
          `Task ${task_id} is '${task.status}' — can only update pending tasks`,
        );
      db.prepare("UPDATE tasks SET content = ? WHERE id = ?").run(
        content,
        task_id,
      );
      return ok(db.prepare("SELECT * FROM tasks WHERE id = ?").get(task_id));
    },
  );

  // --- task_cancel: Cancel a pending task ---
  server.tool(
    "task_cancel",
    "Cancel a pending task. Only works if the worker hasn't picked it up yet (status='pending').",
    {
      task_id: z.number().describe("ID of the task to cancel"),
      reason: z.string().optional().describe("Reason for cancellation"),
    },
    async ({ task_id, reason }) => {
      const db = getDb();
      const task = db
        .prepare("SELECT status FROM tasks WHERE id = ?")
        .get(task_id) as { status: string } | undefined;
      if (!task) return err(`Task ${task_id} not found`);
      if (task.status !== "pending")
        return err(
          `Task ${task_id} is '${task.status}' — can only cancel pending tasks`,
        );
      db.prepare(
        "UPDATE tasks SET status = 'cancelled', response_summary = ?, processed_at = datetime('now') WHERE id = ?",
      ).run(reason ? `Cancelled: ${reason}` : "Cancelled", task_id);
      db.prepare("DELETE FROM task_awaits WHERE task_id = ?").run(task_id);
      return ok(db.prepare("SELECT * FROM tasks WHERE id = ?").get(task_id));
    },
  );

}

// =============================================================================
// WORKER TOOLS — only registered when ATLAS_TRIGGER is NOT set
// =============================================================================
if (!IS_TRIGGER) {
  // --- get_next_task: Atomically get and claim next pending task ---
  server.tool(
    "get_next_task",
    "Get the next pending task and mark it as processing. Warns if you already have an active task.",
    {},
    async () => {
      const db = getDb();

      // Check for stuck active task first
      const active = db
        .prepare(
          "SELECT * FROM tasks WHERE status = 'processing' ORDER BY created_at ASC LIMIT 1",
        )
        .get();
      if (active) {
        return ok({
          warning:
            "You already have an active task. Complete it before starting the next.",
          active_task: active,
        });
      }

      // Atomically claim next pending in a single statement
      const next = db
        .prepare(
          `UPDATE tasks SET status = 'processing', processed_at = datetime('now')
         WHERE id = (SELECT id FROM tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1)
         RETURNING *`,
        )
        .get() as any;
      if (!next) {
        return ok({ next_task: null, message: "No pending tasks." });
      }

      return ok({ next_task: next });
    },
  );

  // --- task_complete: Mark task done and wake trigger (or queue for review) ---
  server.tool(
    "task_complete",
    "Mark a task as done with a response summary. The summary is relayed directly to the original sender — write it as the actual reply.",
    {
      task_id: z.number().describe("ID of the task to complete"),
      response_summary: z
        .string()
        .describe(
          "Result to relay to the sender. Write as a real reply, not 'Done.'",
        ),
    },
    async ({ task_id, response_summary }) => {
      const db = getDb();
      const result = db
        .prepare(
          "UPDATE tasks SET status = 'done', response_summary = ?, processed_at = datetime('now') WHERE id = ? AND status = 'processing'",
        )
        .run(response_summary, task_id);

      if (result.changes === 0) {
        const task = db
          .prepare("SELECT status FROM tasks WHERE id = ?")
          .get(task_id) as { status: string } | undefined;
        if (!task) return err(`Task ${task_id} not found`);
        return err(
          `Task ${task_id} is '${task.status}' — can only complete tasks in 'processing' status`,
        );
      }

      // If review is enabled, write a review wake file instead of waking trigger directly
      if (isReviewEnabled()) {
        // Set review_status to pending and trigger reviewer instead of waking trigger directly
        db.prepare("UPDATE tasks SET review_status = 'pending' WHERE id = ?").run(task_id);
        writeReviewWakeFile(task_id);
      } else {
        // Wake the trigger session that created this task
        wakeTriggerIfAwaiting(task_id, response_summary);
      }

      return ok(db.prepare("SELECT * FROM tasks WHERE id = ?").get(task_id));
    },
  );

  // --- task_list: View task queue ---
  server.tool(
    "task_list",
    "List tasks in the queue",
    {
      status: z
        .string()
        .optional()
        .default("pending")
        .describe("Filter: pending, processing, done, cancelled"),
      limit: z.number().optional().default(20).describe("Max results"),
    },
    async ({ status, limit }) => {
      const db = getDb();
      return ok(
        db
          .prepare(
            "SELECT * FROM tasks WHERE status = ? ORDER BY created_at ASC LIMIT ?",
          )
          .all(status, limit),
      );
    },
  );

  // --- task_get: Inspect specific task ---
  server.tool(
    "task_get",
    "Get a specific task by ID — check its status and response_summary",
    {
      task_id: z.number().describe("ID of the task to retrieve"),
    },
    async ({ task_id }) => {
      const db = getDb();
      const task = db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(task_id);
      if (!task) return err(`Task ${task_id} not found`);
      return ok(task);
    },
  );

  // --- inbox_stats: Queue statistics ---
  server.tool("inbox_stats", "Get inbox and task queue statistics", {}, async () => {
    const db = getDb();
    const msgByStatus = db
      .prepare("SELECT status, COUNT(*) as count FROM messages GROUP BY status")
      .all() as { status: string; count: number }[];
    const taskByStatus = db
      .prepare("SELECT status, COUNT(*) as count FROM tasks GROUP BY status")
      .all() as { status: string; count: number }[];
    const msgTotal = (
      db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number }
    ).count;
    const taskTotal = (
      db.prepare("SELECT COUNT(*) as count FROM tasks").get() as { count: number }
    ).count;
    return ok({
      inbox: {
        total: msgTotal,
        by_status: Object.fromEntries(msgByStatus.map((r) => [r.status, r.count])),
      },
      tasks: {
        total: taskTotal,
        by_status: Object.fromEntries(taskByStatus.map((r) => [r.status, r.count])),
      },
    });
  });
}

// =============================================================================
// REVIEWER TOOLS — only registered when ATLAS_REVIEWER_TASK_ID is set
// =============================================================================
if (IS_REVIEWER && REVIEWER_TASK_ID !== null) {
  // task_review_approve: Approve the work and wake the trigger
  server.tool(
    "task_review_approve",
    "Approve the task result. This wakes the trigger that created the task and delivers the worker's response.",
    {},
    async () => {
      const db = getDb();
      const task = db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(REVIEWER_TASK_ID) as any;
      if (!task) return err(`Task ${REVIEWER_TASK_ID} not found`);

      db.prepare(
        "UPDATE tasks SET review_status = 'approved' WHERE id = ?"
      ).run(REVIEWER_TASK_ID);

      wakeTriggerIfAwaiting(REVIEWER_TASK_ID, task.response_summary);
      return ok({ approved: true, task_id: REVIEWER_TASK_ID });
    }
  );

  // task_review_reject: Reject and send back to worker with feedback
  server.tool(
    "task_review_reject",
    "Reject the task result and send it back to the worker with feedback. The worker will retry.",
    {
      feedback: z
        .string()
        .describe("Specific feedback for the worker on what needs to be fixed or improved"),
    },
    async ({ feedback }) => {
      const db = getDb();
      const task = db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(REVIEWER_TASK_ID) as any;
      if (!task) return err(`Task ${REVIEWER_TASK_ID} not found`);

      // Append feedback to task content and reset to pending
      const updatedContent = `${task.content}\n\n---\n**Reviewer Feedback (attempt ${(task.review_attempts ?? 0) + 1}):**\n${feedback}`;
      db.prepare(
        `UPDATE tasks SET status = 'pending', review_status = 'rejected',
         review_feedback = ?, content = ?, processed_at = NULL, response_summary = NULL
         WHERE id = ?`
      ).run(feedback, updatedContent, REVIEWER_TASK_ID);

      // Wake the worker to retry
      const indexDir = process.env.HOME + "/.index";
      mkdirSync(indexDir, { recursive: true });
      writeFileSync(`${indexDir}/.wake`, "");

      return ok({ rejected: true, task_id: REVIEWER_TASK_ID, feedback });
    }
  );

  // task_get: Read the task to review
  server.tool(
    "task_review_get",
    "Get the task details to review — original content and worker's response summary.",
    {},
    async () => {
      const db = getDb();
      const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(REVIEWER_TASK_ID);
      if (!task) return err(`Task ${REVIEWER_TASK_ID} not found`);
      return ok(task);
    }
  );
}

// --- Start server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
