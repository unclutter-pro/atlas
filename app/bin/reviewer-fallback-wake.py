#!/usr/bin/env python3
import sqlite3, json, sys, os
from pathlib import Path

if len(sys.argv) < 3:
    print("Usage: reviewer-fallback-wake.py <db_path> <task_id>", file=sys.stderr)
    sys.exit(1)

db_path = sys.argv[1]
task_id = int(sys.argv[2])

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

awaiter = conn.execute(
    """SELECT ta.trigger_name, ta.session_key,
              COALESCE(ts.session_id,'') AS session_id,
              COALESCE(t.channel,'internal') AS channel
       FROM task_awaits ta
       LEFT JOIN trigger_sessions ts ON ts.trigger_name=ta.trigger_name AND ts.session_key=ta.session_key
       LEFT JOIN triggers t ON t.name=ta.trigger_name
       WHERE ta.task_id=?""",
    (task_id,)
).fetchone()

if not awaiter:
    conn.close()
    sys.exit(0)

task = conn.execute("SELECT response_summary FROM tasks WHERE id=?", (task_id,)).fetchone()
summary = task['response_summary'] if task else ''

index_dir = Path(os.environ['HOME']) / '.index'
wake_file = index_dir / '.wake-{}-{}'.format(awaiter['trigger_name'], task_id)
wake_data = json.dumps({
    'task_id': task_id,
    'trigger_name': awaiter['trigger_name'],
    'session_key': awaiter['session_key'],
    'session_id': awaiter['session_id'],
    'channel': awaiter['channel'],
    'response_summary': summary,
})
wake_file.write_text(wake_data)

conn.execute("DELETE FROM task_awaits WHERE task_id=?", (task_id,))
conn.commit()
conn.close()

print('[fallback-wake] Wrote wake file for task {} -> {}'.format(task_id, awaiter['trigger_name']))
