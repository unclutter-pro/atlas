New email arrived in your inbox from {{sender}}:

<payload>
{{payload}}
</payload>

Respond using `email reply "<thread_id>" "<body>"` (threading is automatic via SMTP headers). Plain assistant text is **not** delivered — the sender only sees a turn that ends with an `email reply` / `email send` call. Do not delegate the email response itself to a sub-agent.
