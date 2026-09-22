/**
 * The one definition of "a run and its outcome", shared by Activity, Overview,
 * Automations and the status strip so numbers that link to each other agree.
 *
 * - running: trigger_runs.completed_at IS NULL (trigger-runner always sets it
 *   when the run ends, and the kill switch closes runs it stops)
 * - failed / ok: from the matched session_metrics row (is_error)
 */

/** Metrics rows within this distance of a run's start belong to that run. */
export const MATCH_WINDOW_SEC = 120;

/**
 * trigger_runs joined with its session_metrics row: same session_id (or, for
 * runs that never captured one, an empty session_id and the same trigger)
 * with the closest started_at. Persistent sessions reuse session_id, so the
 * time match is what separates their runs.
 */
export const RUNS_BASE = `
  SELECT r.id, r.trigger_name, r.session_key, r.session_mode, r.session_id, r.payload, r.started_at, r.completed_at,
    t.type AS t_type, t.channel AS t_channel, t.description AS t_description, (t.name IS NOT NULL) AS t_exists,
    m.id AS m_id, m.session_type, m.started_at AS m_started_at, m.ended_at AS m_ended_at, m.duration_ms, m.input_tokens, m.output_tokens,
    m.cache_read_tokens, m.cache_creation_tokens, m.cost_usd, m.num_turns, m.is_error,
    CASE WHEN r.completed_at IS NULL THEN 'running' WHEN m.is_error = 1 THEN 'failed' ELSE 'ok' END AS outcome,
    CAST(strftime('%s', r.started_at) AS INTEGER) AS ts
  FROM (
    -- SQLite rejects outer columns in a subquery ORDER BY, so pick the
    -- closest row via MIN over (seconds apart, id) packed into one integer.
    SELECT tr.*, (
      SELECT MIN(CAST(abs(julianday(x.started_at) - julianday(tr.started_at)) * 86400 AS INTEGER) * 10000000000 + x.id) % 10000000000
      FROM session_metrics x
      WHERE ((tr.session_id IS NOT NULL AND tr.session_id != '' AND x.session_id = tr.session_id)
          OR ((tr.session_id IS NULL OR tr.session_id = '') AND x.session_id = '' AND x.trigger_name = tr.trigger_name))
        AND abs(julianday(x.started_at) - julianday(tr.started_at)) * 86400 <= ${MATCH_WINDOW_SEC}
    ) AS metric_id
    FROM trigger_runs tr
  ) r
  LEFT JOIN triggers t ON t.name = r.trigger_name
  LEFT JOIN session_metrics m ON m.id = r.metric_id`;
