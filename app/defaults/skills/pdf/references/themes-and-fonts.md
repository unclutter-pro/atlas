# Themes and Fonts

How the bundled templates handle colour and typography, and how to override either.

## The six built-in themes

All four bundled templates import `templates/themes.typ` and call `resolve-theme()`. Pick one per call:

```bash
build-pdf report --theme indigo output.pdf
```

| Name | Accent | Background | Headline font | Use-case |
|---|---|---|---|---|
| `graphite` (default) | warm dark grey | white | IBM Plex Serif | Neutral, business-default. |
| `indigo` | strong indigo | white | IBM Plex Serif | Corporate, slightly bolder. |
| `forest` | forest green | white | IBM Plex Serif | Sustainability, natural-tone. |
| `amber` | amber/orange | cream `#FFFBEB` | Crimson Pro | Warm, premium feel. |
| `crimson` | deep red | white | IBM Plex Serif | Confident, attention-grabbing. |
| `mono` | dark zinc | white | JetBrains Mono | Pure minimalist, all monospace. |

Each palette defines nine tokens — six colours and three fonts:

| Token | Purpose |
|---|---|
| `primary` | Body text colour |
| `accent` | Headlines, key totals, emphasis |
| `muted` | Captions, secondary text, labels |
| `rule` | Borders, dividers, table strokes |
| `background` | Page fill (default: white) |
| `surface` | Tinted block fill — memo header bar, notes callout, etc. |
| `font-body` | Body / sans family for paragraphs, labels, tables |
| `font-heading` | Display / serif family for cover titles + H1 |
| `font-mono` | Monospace family (numerics, code blocks, IBAN, ...) |

## Overriding individual tokens

For brand-locked output without a fork:

```bash
build-pdf report --colors my-brand.json output.pdf
```

`my-brand.json` — set any subset, the rest stays from the active theme:

```json
{
  "primary":       "#1F2937",
  "accent":        "#7C3AED",
  "muted":         "#6B7280",
  "rule":          "#E5E7EB",
  "background":    "#FAFAF9",
  "surface":       "#F5F3FF",
  "font-body":     "Inter",
  "font-heading":  "Inter",
  "font-mono":     "JetBrains Mono"
}
```

The flag is named `--colors` for historical reasons but accepts all nine tokens including fonts. Colours are `#RRGGBB` hex; fonts are family names exactly as `fc-list` reports them.

## Writing your own theme

Add a new palette entry to `templates/themes.typ` — all nine tokens are required so the templates can resolve them deterministically:

```typst
#let palettes = (
  graphite: (...),
  indigo: (...),
  // ... existing entries ...
  ocean: (
    primary:      rgb("#0C2A4A"),
    accent:       rgb("#0369A1"),
    muted:        rgb("#64748B"),
    rule:         rgb("#BAE6FD"),
    background:   rgb("#FFFFFF"),
    surface:      rgb("#F0F9FF"),
    font-body:    "Inter",
    font-heading: "IBM Plex Serif",
    font-mono:    "JetBrains Mono",
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
- `templates/custom-templates.md` § Themes — how to import in your own template
