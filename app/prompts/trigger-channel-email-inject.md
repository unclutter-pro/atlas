New email arrived in your inbox (trigger "{{trigger_name}}", from {{sender}}):

{{payload}}

Respond using `email reply "<thread_id>" "<body>"` (threading is automatic via SMTP headers). Plain assistant text is **not** delivered — the sender only sees a turn that ends with an `email reply` / `email send` call. For work that needs more than one reply turn, spawn a sub-agent via the `Agent` tool or open a tracked task via the `task` CLI.
