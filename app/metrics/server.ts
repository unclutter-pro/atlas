/**
 * Prometheus metrics endpoint for Atlas containers.
 *
 * Exposes /metrics on port 9090 in Prometheus text exposition format.
 * No auth required — intended for in-cluster Prometheus scraping only.
 */

import { Database } from "bun:sqlite";
import { statfsSync, statSync, existsSync } from "fs";
import { join } from "path";

const PORT = Number(process.env.ATLAS_METRICS_PORT) || 9090;
const HOME = process.env.HOME || "/home/agent";
const DB_PATH = join(HOME, ".index", "atlas.db");
const CUSTOMER_ID = process.env.CUSTOMER_ID || "unknown";
const START_TIME = Date.now();

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

type MetricType = "gauge" | "counter" | "histogram";

interface MetricLine {
  name: string;
  help: string;
  type: MetricType;
  values: Array<{ labels?: Record<string, string>; value: number }>;
}

function formatMetrics(metrics: MetricLine[]): string {
  const lines: string[] = [];
  for (const m of metrics) {
    lines.push(`# HELP ${m.name} ${m.help}`);
    lines.push(`# TYPE ${m.name} ${m.type}`);
    for (const v of m.values) {
      if (v.labels && Object.keys(v.labels).length > 0) {
        const labelStr = Object.entries(v.labels)
          .map(([k, val]) => `${k}="${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
          .join(",");
        lines.push(`${m.name}{${labelStr}} ${v.value}`);
      } else {
        lines.push(`${m.name} ${v.value}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Metric collectors
// ---------------------------------------------------------------------------

function collectDiskMetrics(): MetricLine[] {
  try {
    const stats = statfsSync(HOME);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bfree * stats.bsize;
    const usedBytes = totalBytes - freeBytes;
    return [
      {
        name: "atlas_disk_usage_bytes",
        help: "Disk space used on the data volume in bytes",
        type: "gauge",
        values: [{ value: usedBytes }],
      },
      {
        name: "atlas_disk_total_bytes",
        help: "Total disk space on the data volume in bytes",
        type: "gauge",
        values: [{ value: totalBytes }],
      },
      {
        name: "atlas_disk_usage_ratio",
        help: "Disk usage ratio (0-1) on the data volume",
        type: "gauge",
        values: [{ value: totalBytes > 0 ? usedBytes / totalBytes : 0 }],
      },
    ];
  } catch {
    return [];
  }
}

function collectDbMetrics(): MetricLine[] {
  try {
    if (!existsSync(DB_PATH)) return [
      { name: "atlas_healthy", help: "Whether the Atlas instance is healthy (1=ok, 0=unhealthy)", type: "gauge", values: [{ value: 0 }] },
    ];

    const dbStat = statSync(DB_PATH);
    const metrics: MetricLine[] = [
      {
        name: "atlas_db_size_bytes",
        help: "Size of the Atlas SQLite database in bytes",
        type: "gauge",
        values: [{ value: dbStat.size }],
      },
      {
        name: "atlas_healthy",
        help: "Whether the Atlas instance is healthy (1=ok, 0=unhealthy)",
        type: "gauge",
        values: [{ value: 1 }],
      },
    ];

    // Open DB read-only to avoid locks
    const db = new Database(DB_PATH, { readonly: true });
    try {
      // Trigger run counts (last 24h)
      const triggerRows = db.prepare(`
        SELECT trigger_name,
               SUM(CASE WHEN is_error = 0 THEN 1 ELSE 0 END) as success,
               SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as errors,
               SUM(duration_ms) as total_duration_ms,
               SUM(cost_usd) as total_cost
        FROM session_metrics
        WHERE created_at > datetime('now', '-24 hours')
        GROUP BY trigger_name
      `).all() as Array<{ trigger_name: string; success: number; errors: number; total_duration_ms: number; total_cost: number }>;

      const runValues: MetricLine["values"] = [];
      const errorValues: MetricLine["values"] = [];
      const durationValues: MetricLine["values"] = [];
      const costValues: MetricLine["values"] = [];

      for (const row of triggerRows) {
        const trigger = row.trigger_name || "_direct";
        runValues.push({ labels: { trigger, status: "success" }, value: row.success });
        runValues.push({ labels: { trigger, status: "error" }, value: row.errors });
        durationValues.push({ labels: { trigger }, value: (row.total_duration_ms || 0) / 1000 });
        costValues.push({ labels: { trigger }, value: row.total_cost || 0 });
      }

      if (runValues.length > 0) {
        metrics.push({
          name: "atlas_trigger_runs_total",
          help: "Total trigger runs in the last 24 hours",
          type: "gauge",
          values: runValues,
        });
        metrics.push({
          name: "atlas_trigger_duration_seconds",
          help: "Total trigger duration in seconds in the last 24 hours",
          type: "gauge",
          values: durationValues,
        });
        metrics.push({
          name: "atlas_session_cost_usd",
          help: "Total session cost in USD in the last 24 hours",
          type: "gauge",
          values: costValues,
        });
      }

      // All-time totals for counters
      const totals = db.prepare(`
        SELECT COUNT(*) as total_runs,
               SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as total_errors,
               SUM(duration_ms) as total_duration_ms,
               SUM(cost_usd) as total_cost
        FROM session_metrics
      `).get() as { total_runs: number; total_errors: number; total_duration_ms: number; total_cost: number } | undefined;

      if (totals) {
        metrics.push({
          name: "atlas_sessions_total",
          help: "Total number of sessions since metrics tracking started",
          type: "counter",
          values: [{ value: totals.total_runs }],
        });
        metrics.push({
          name: "atlas_sessions_errors_total",
          help: "Total number of errored sessions",
          type: "counter",
          values: [{ value: totals.total_errors }],
        });
        metrics.push({
          name: "atlas_cost_usd_total",
          help: "Cumulative session cost in USD",
          type: "counter",
          values: [{ value: totals.total_cost || 0 }],
        });
      }

      // Webhook queue depth
      try {
        const queueRow = db.prepare(
          "SELECT COUNT(*) as pending FROM webhook_queue WHERE attempts <= 5"
        ).get() as { pending: number } | undefined;
        metrics.push({
          name: "atlas_webhook_queue_pending",
          help: "Number of webhook deliveries pending retry",
          type: "gauge",
          values: [{ value: queueRow?.pending ?? 0 }],
        });
      } catch {
        // Table may not exist yet
      }

    } finally {
      db.close();
    }

    return metrics;
  } catch {
    return [
      { name: "atlas_healthy", help: "Whether the Atlas instance is healthy (1=ok, 0=unhealthy)", type: "gauge", values: [{ value: 0 }] },
    ];
  }
}

function collectProcessMetrics(): MetricLine[] {
  const uptimeSeconds = (Date.now() - START_TIME) / 1000;
  const memUsage = process.memoryUsage();

  return [
    {
      name: "atlas_uptime_seconds",
      help: "Seconds since the metrics server started",
      type: "gauge",
      values: [{ value: Math.round(uptimeSeconds) }],
    },
    {
      name: "atlas_process_memory_rss_bytes",
      help: "Resident set size of the metrics server process",
      type: "gauge",
      values: [{ value: memUsage.rss }],
    },
  ];
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/metrics") {
      const allMetrics = [
        ...collectDiskMetrics(),
        ...collectDbMetrics(),
        ...collectProcessMetrics(),
      ];

      // Add customer_id as an info metric
      allMetrics.unshift({
        name: "atlas_info",
        help: "Atlas instance info labels",
        type: "gauge",
        values: [{ labels: { customer_id: CUSTOMER_ID }, value: 1 }],
      });

      return new Response(formatMetrics(allMetrics), {
        headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
      });
    }

    // Simple health check
    if (url.pathname === "/") {
      return new Response("atlas-metrics ok\n");
    }

    return new Response("Not Found\n", { status: 404 });
  },
});

console.log(`Atlas metrics server listening on :${server.port}`);
