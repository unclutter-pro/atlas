# Writing Memos

A memo is a **single-page** internal recap or status update. If you can't fit it on one page, you wrote a report.

## CLI inputs

```bash
build-pdf memo \
  --title "Sprint Recap KW 22" \
  --to    "Team" \
  --from  "Atlas" \
  --date  2026-05-25 \
  --lang  de \
  --theme forest \
  out/memo.pdf
```

All inputs are optional except for what you want on the header bar. Date accepts ISO `YYYY-MM-DD` and gets locale-formatted.

## When the memo isn't enough

The bundled template gives you:
- A coloured header bar with title + To / From / Date
- Three section headings already labelled (i18n): *Was passiert ist* · *Entscheidungen* · *Nächste Schritte*
- A small Owner / Task / Deadline table

That's it. No CLI flag adds body content — for that, you copy `templates/memo.typ` to your CWD and edit it just like the report workflow:

```bash
cp /home/agent/projects/atlas/app/defaults/skills/pdf/templates/memo.typ ./my-memo.typ
# edit the three sections + table + add bullets
build-pdf ./my-memo.typ my-memo.pdf
```

## Single-page discipline

The memo template auto-shrinks its title (20pt → 17pt → 14pt) so long titles still fit on one line. But the **body** can still overflow if you write too much. Rules:

- 3–5 bullets per section, MAX
- One short paragraph at the top of "Was passiert ist" if you need framing
- Table at the bottom: 3–8 rows; longer = it's a project plan, not a memo

If you overflow to a second page, choose one:
1. **Cut content** — Memo ≠ Report. Move the long part to a report.
2. **Switch templates** — use `report` for multi-page content.
3. **Trim the title** — `Sprint Recap KW 22` is a memo title; `Vollständige Fortschrittsanalyse und Weiterentwicklungs-Roadmap für Q2 2026` is not.

## Voice

- **Direct and operational.** Memos are about *what we did* and *what's next*, not *why this matters*.
- **Owner-task-deadline pattern** in the "Nächste Schritte" table. Without an owner, it doesn't happen.
- **Resolved decisions only.** If something is still being debated, note it under "Entscheidungen" with `[offen]` — but don't write paragraphs of pros/cons.
- **No fluff intros.** "In der KW 22 haben wir intensiv gearbeitet" adds nothing. Open with the first concrete fact.

## What goes in each section

**Was passiert ist**: 3–5 bullets, each with a fact + a number. "Backend-Sync: Latenz von 800ms auf 250ms reduziert" not "Backend-Sync wurde verbessert".

**Entscheidungen**: 1–3 lines per decision, each with the outcome + the one-sentence rationale. "Mobile-App-Start auf 15. Juni verschoben — React Native v0.74-Migration dauert länger." Skip if no decisions were made.

**Nächste Schritte**: The Owner / Task / Deadline table is the contract. Every row has all three columns filled. "TBD" is a smell.

## Common pitfalls

- **Long titles cause overflow** — even with auto-shrink, a 90-character title eats vertical space. Shorter is better.
- **Tables with empty Owner column** — defeats the point of the table. Either name a real person or remove the row.
- **Memo + JSON data** — memos are NOT data-driven; everything is in the `.typ` source. The `--data` flag does nothing here (invoice / letter only).
- **Body in past tense, table in future tense** — natural and correct: "was happened" vs. "what's next".

## Pre-flight before sending

- [ ] Fits on one page
- [ ] All three sections have content (or the section is removed)
- [ ] Every row in "Nächste Schritte" has an Owner and a Deadline
- [ ] Title under 60 chars (auto-shrink threshold)
- [ ] Date is correct
- [ ] PDF opens cleanly
