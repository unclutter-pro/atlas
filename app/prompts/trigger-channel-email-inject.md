New email arrived in your inbox (trigger "{{trigger_name}}", from {{sender}}):

{{payload}}

Respond using `email reply "<thread_id>" "<body>"` (threading is automatic via SMTP headers). Plain assistant text is **not** delivered — the sender only sees a turn that ends with an `email reply` / `email send` call, or an escalation via `task_create(content="<brief>")`.
