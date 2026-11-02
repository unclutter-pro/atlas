## GitHub Integration Setup

**Step 1: Configure `~/config.yml`**

```yaml
github:
  login: "my-bot"     # the GitHub account Atlas acts as
  repos: []           # empty = all; or ["acme/webapp", "acme/*"]
```

`gh` must be authenticated as that account (`gh auth status`).

**Step 2: Check provisioning**

On container startup, `init.sh` creates the ingress trigger `github` (webhook, channel `github`, `filter.sh` runs the router) and the persistent worker `github-worker` (channel `github`, prompt `{{payload}}`) once `github.login` is set. Check `trigger list` first. If the configuration was added to a running container, create both by hand with these settings and write `~/triggers/github/filter.sh` containing `exec bun /atlas/app/triggers/github/route.ts`.

**Step 3: Add the webhook on GitHub**

Repository or organization Settings > Webhooks, content type `application/json`, events: Issues, Issue comments, Pull requests, Pull request reviews, Pull request review comments, Workflow runs.

- Direct route: `https://<host>/api/webhook/github` with a webhook secret, and the same secret on the trigger (`trigger update --name=github --secret=...`).
- Relay: the `github` trigger's relay URL from `trigger list`, without a secret.

Routing decisions are logged to `/atlas/logs/github-router.log`; the topic ledger is `~/.index/github/router.db`. Details: docs/Integrations.md, section GitHub.
