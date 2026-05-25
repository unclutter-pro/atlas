# Themes and Fonts

How the bundled templates handle colour and typography, and how to override either.

## The six built-in themes

All four bundled templates import `templates/themes.typ` and call `resolve-theme()`. Pick one per call:

```bash
build-pdf report --theme indigo output.pdf
```

| Name | Primary | Accent | Use-case |
|---|---|---|---|
| `graphite` (default) | dark grey | warm dark grey | Neutral, business-default. Most reports. |
| `indigo` | dark indigo | strong indigo | Corporate, slightly bolder than graphite. |
| `forest` | dark green | forest green | Sustainability, natural-tone material. |
| `amber` | dark brown | amber/orange | Warm, premium feel. |
| `crimson` | dark grey | deep red | Confident, attention-grabbing. |
| `mono` | black | dark zinc | Pure minimalist, no colour. |

Each palette has four tokens: `primary` (text), `accent` (headlines/emphasis), `muted` (captions, secondary text), `rule` (borders, dividers).

## Overriding individual colours

For brand-locked output without a fork:

```bash
build-pdf report --colors my-brand.json output.pdf
```

`my-brand.json`:
```json
{
  "primary": "#1F2937",
  "accent":  "#2563EB",
  "muted":   "#6B7280",
  "rule":    "#E5E7EB"
}
```

You only need to specify the keys you want to override — anything missing falls back to the active theme.

## Writing your own theme

Add a new palette entry to `templates/themes.typ`:

```typst
#let palettes = (
  graphite: (...),
  indigo: (...),
  // ... existing entries ...
  ocean: (
    primary: rgb("#0C2A4A"),
    accent:  rgb("#0369A1"),
    muted:   rgb("#64748B"),
    rule:    rgb("#BAE6FD"),
  ),
)
```

Pick the new theme via `--theme ocean`.

## Fonts in the container

The container ships these families, ready to use in any Typst document:

| Family | Use |
|---|---|
| `Inter` | Body sans, UI, captions. Modern, screen-friendly. |
| `IBM Plex Serif` | Body serif, headlines for reports/letters. Business-appropriate. |
| `JetBrains Mono` | Monospace for code, numerals, technical content. |
| `Crimson Pro` | Long-form serif (essays, op-eds). |
| `Liberation Sans/Serif/Mono` | Drop-in replacements for Arial/Times/Courier. |
| `DejaVu Sans/Serif/Mono` | Broad Unicode coverage incl. Cyrillic, Greek, math symbols. |
| `Noto Sans` + `Noto Sans CJK` | International scripts including Chinese, Japanese, Korean. |

In Typst:

```typst
#set text(font: "Inter", size: 11pt)
#show heading: set text(font: "IBM Plex Serif")
#show raw: set text(font: "JetBrains Mono")
```

No manual font registration needed — `fontconfig` finds them by family name.

## When to swap the font stack

The default report/invoice/letter/memo templates use **Inter** (body) + **IBM Plex Serif** (headlines) + **JetBrains Mono** (numerals in code blocks). This is a deliberately corporate-neutral pair.

If you need a different mood:

- **More serious / academic** — swap Inter for `Liberation Serif`, keep Plex Serif for headlines.
- **More playful / startup** — swap Plex Serif for `Crimson Pro` (warmer optical sizes).
- **Highly technical / data-heavy** — drop the serif entirely, use only Inter + JetBrains Mono.
- **International content (CJK, Cyrillic)** — switch to `Noto Sans` + `Noto Serif` to get full glyph coverage.

To swap at the template level, edit the `#set text(font: ...)` line at the top. For one-off overrides inside a section:

```typst
#text(font: "Crimson Pro", size: 13pt)[A more elegant pull-quote here.]
```

## Variable fonts

Static font cuts are installed (`Inter-Regular.ttf`, `Inter-Bold.ttf`, etc.) — NOT variable fonts. Typst's current renderer emits warnings for variable axes. Don't reference `"Inter Variable"` or `"Inter Tight VF"` — use `"Inter"` and let Typst pick the right static cut for the requested weight.

## See also
- `templates/themes.typ` — palette definitions
- `templates/AUTHORING.md` § Themes — how to import in your own template
