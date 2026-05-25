# Typst Cheatsheet

Quick reference for things that bite first-time agents. For deeper authoring guidance, see [../templates/custom-templates.md](../templates/custom-templates.md).

## Escape rules

| Char | Inside `"..."` strings | Inside `[...]` content blocks |
|---|---|---|
| `"` | Use `\"` or escape with `\` | Fine as-is |
| `<`, `>` | **Terminate the string!** Use `\<` or rephrase | Fine as-is |
| `#` | Literal | Switches into code mode — escape with `\#` for literal |
| `_`, `*` | Literal | `_italic_` and `*bold*` — escape with `\_` and `\*` for literal |
| `[`, `]` | Literal | Open/close content block — escape with `\[` and `\]` |
| Curly quotes `"..."` (U+201C/201D) | **Look identical to `"` to the lexer — terminate strings** | Fine |

**Quick rule of thumb**: If you're writing `"text with <symbols>"`, switch to a content block `[text with <symbols>]` or rephrase ("kleiner als 100" instead of "<100").

## Numbers in German

- Decimal comma: write `42,5` not `42.5`. Use `format-money(n, lang: "de")` from `i18n.typ` for automatic formatting with thousands separator.
- Percent sign with breathing space: `19 %` (Unicode narrow no-break) — most templates handle this automatically via `text(lang: "de")`.

## Common code patterns

### Conditional content
```typst
#if data.kleinunternehmer [
  Gemäß §19 UStG wird keine Umsatzsteuer berechnet.
]
```

### Date formatting (from i18n.typ)
```typst
#import "i18n.typ": format-date
#format-date("2026-05-25", lang: "de")  // → "25.05.2026"
```

### Hyphenation off for a long technical word
```typst
#text(hyphenate: false)[Neuroenhancement]
```

### Force line break inside text
```typst
First line \
Second line
```

### Force page break
```typst
#pagebreak()             // hard break
#pagebreak(weak: true)   // only if there's content above on the current page
```

### Block that mustn't split across pages
```typst
#block(breakable: false)[
  ...long content...
]
```

## Theme tokens (via resolve-theme)

```typst
#import "themes.typ": resolve-theme
#let theme = resolve-theme()
#let primary    = theme.primary
#let accent     = theme.accent
#let muted      = theme.muted
#let rule       = theme.rule
#let background = theme.background
#let surface    = theme.surface
#let font-body    = theme.font-body
#let font-heading = theme.font-heading
#let font-mono    = theme.font-mono
```

Hierarchy is carried by typography first, colour second. Use accent SPARINGLY — 3–5 places per page, never on every heading. See [themes-and-fonts.md](themes-and-fonts.md) for the design rationale.

## Pagecounter context

`counter(page).final()` only works inside a `context` block:

```typst
context align(center)[
  Seite #counter(page).display() / #counter(page).final().last()
]
```

## When typst compile shows "page count differs" or empty TOC

Typst needs two passes to populate `outline()` and `counter().final()`. The `build-pdf` wrapper handles this; a single `typst compile` call will too. If your IDE plugin shows an empty TOC, that's a plugin artifact, not a real bug.

## When fonts render serif but you asked for sans

The named font (e.g., `IBM Plex Serif`, `JetBrains Mono`) isn't installed in your current container. The container Atlas runs in production has them. To check locally:

```bash
fc-list | grep -i "plex serif"
```

If empty, Typst falls back to its built-in serif. Output works, but won't match the production look.

## Image inclusion

```typst
#image("photo.png", width: 90%)
```

Path is relative to the `.typ` file. The `build-pdf` script sets `--root /` so absolute paths work from any cwd.

## When in doubt

The Typst reference is excellent and searchable: <https://typst.app/docs/reference>
