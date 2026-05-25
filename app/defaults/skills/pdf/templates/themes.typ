// themes.typ — design tokens (colors + fonts + surfaces) for the bundled templates.
//
// Pick a theme by name via --theme:
//   build-pdf report --theme graphite output/report.pdf
//
// Or override individual tokens with a brand-overlay JSON:
//   build-pdf report --colors my-brand.json output/report.pdf
//
// my-brand.json may set any subset of the tokens below. Missing tokens fall
// back to the active theme. Colors are #RRGGBB hex; fonts are family names.
// Example:
//   {
//     "primary":       "#1F2937",
//     "accent":        "#2563EB",
//     "muted":         "#6B7280",
//     "rule":          "#E5E7EB",
//     "background":    "#FFFFFF",
//     "surface":       "#F3F4F6",
//     "font-body":     "Inter",
//     "font-heading":  "IBM Plex Serif",
//     "font-mono":     "JetBrains Mono"
//   }
//
// Tokens explained:
//   primary    — body text colour
//   accent     — headlines, key totals, emphasis
//   muted      — captions, secondary text, labels
//   rule       — borders, dividers, table strokes
//   background — page background (kept white for printing in default themes)
//   surface    — tinted block backgrounds (memo header bar, notes callout, ...)
//   font-body  — body/sans family used for paragraphs, labels, tables
//   font-heading — display/serif family for cover titles + H1
//   font-mono  — monospace family (numerics, code blocks, IBAN, ...)

#let palettes = (
  // graphite — neutral, business-default (warm dark grey accent)
  graphite: (
    primary:      rgb("#111827"),
    accent:       rgb("#374151"),
    muted:        rgb("#6B7280"),
    rule:         rgb("#E5E7EB"),
    background:   rgb("#FFFFFF"),
    surface:      rgb("#F9FAFB"),
    font-body:    "Inter",
    font-heading: "IBM Plex Serif",
    font-mono:    "JetBrains Mono",
  ),
  // indigo — bolder than the original sky-blue, still corporate
  indigo: (
    primary:      rgb("#1E1B4B"),
    accent:       rgb("#4338CA"),
    muted:        rgb("#6B7280"),
    rule:         rgb("#E0E7FF"),
    background:   rgb("#FFFFFF"),
    surface:      rgb("#EEF2FF"),
    font-body:    "Inter",
    font-heading: "IBM Plex Serif",
    font-mono:    "JetBrains Mono",
  ),
  // forest — natural / sustainability tone
  forest: (
    primary:      rgb("#14532D"),
    accent:       rgb("#15803D"),
    muted:        rgb("#6B7280"),
    rule:         rgb("#D1FAE5"),
    background:   rgb("#FFFFFF"),
    surface:      rgb("#ECFDF5"),
    font-body:    "Inter",
    font-heading: "IBM Plex Serif",
    font-mono:    "JetBrains Mono",
  ),
  // amber — warm, premium feel (warmer serif for headlines)
  amber: (
    primary:      rgb("#451A03"),
    accent:       rgb("#D97706"),
    muted:        rgb("#78716C"),
    rule:         rgb("#FEF3C7"),
    background:   rgb("#FFFBEB"),
    surface:      rgb("#FEF3C7"),
    font-body:    "Inter",
    font-heading: "Crimson Pro",
    font-mono:    "JetBrains Mono",
  ),
  // crimson — confident, attention-grabbing
  crimson: (
    primary:      rgb("#1F2937"),
    accent:       rgb("#BE123C"),
    muted:        rgb("#6B7280"),
    rule:         rgb("#FECDD3"),
    background:   rgb("#FFFFFF"),
    surface:      rgb("#FFF1F2"),
    font-body:    "Inter",
    font-heading: "IBM Plex Serif",
    font-mono:    "JetBrains Mono",
  ),
  // mono — pure black/grey, minimalist (all monospace)
  mono: (
    primary:      rgb("#000000"),
    accent:       rgb("#27272A"),
    muted:        rgb("#71717A"),
    rule:         rgb("#E4E4E7"),
    background:   rgb("#FFFFFF"),
    surface:      rgb("#FAFAFA"),
    font-body:    "JetBrains Mono",
    font-heading: "JetBrains Mono",
    font-mono:    "JetBrains Mono",
  ),
)

// Resolve the active theme from --input theme=<name>, with graphite default.
// Optionally override individual tokens via --input colors=<json-path>.
// Color tokens (primary/accent/muted/rule/background/surface) parsed via rgb().
// Font tokens (font-body/font-heading/font-mono) used as strings.
#let _color-keys = ("primary", "accent", "muted", "rule", "background", "surface")
#let _font-keys  = ("font-body", "font-heading", "font-mono")

#let resolve-theme() = {
  let name = sys.inputs.at("theme", default: "graphite")
  let base = palettes.at(name, default: palettes.graphite)

  let overlay-path = sys.inputs.at("colors", default: "")
  if overlay-path == "" { return base }

  let overrides = json(overlay-path)
  let merged = (:)
  for (k, v) in base.pairs() {
    if k in overrides {
      if k in _color-keys {
        merged.insert(k, rgb(overrides.at(k)))
      } else if k in _font-keys {
        merged.insert(k, overrides.at(k))
      } else {
        merged.insert(k, v)
      }
    } else {
      merged.insert(k, v)
    }
  }
  merged
}
