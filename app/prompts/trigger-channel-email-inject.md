New email arrived in your inbox (trigger "{{trigger_name}}", from {{sender}}):

{{payload}}

Respond using `email reply "<thread_id>" "<body>"` (threading is automatic via SMTP headers). Plain assistant text is **not** delivered — the sender only sees a turn that ends with an `email reply` / `email send` call. For work that needs more than one reply turn, open tracked tasks and goals via the `task` CLI; do not delegate the email response itself to a sub-agent.
