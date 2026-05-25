// themes.typ — color palettes for the bundled pdf templates.
//
// Pick a theme by name via --input theme=<name>:
//   build-pdf report --theme graphite output/report.pdf
//
// Or override with a brand-overlay file:
//   build-pdf report --colors my-brand.json output/report.pdf
//
// my-brand.json shape: { "primary": "#1F2937", "accent": "#2563EB", "muted": "#6B7280", "rule": "#E5E7EB" }

#let palettes = (
  // graphite — neutral, business-default (warm dark grey accent)
  graphite: (
    primary: rgb("#111827"),
    accent:  rgb("#374151"),
    muted:   rgb("#6B7280"),
    rule:    rgb("#E5E7EB"),
  ),
  // indigo — bolder than the original sky-blue, still corporate
  indigo: (
    primary: rgb("#1E1B4B"),
    accent:  rgb("#4338CA"),
    muted:   rgb("#6B7280"),
    rule:    rgb("#E0E7FF"),
  ),
  // forest — natural / sustainability tone
  forest: (
    primary: rgb("#14532D"),
    accent:  rgb("#15803D"),
    muted:   rgb("#6B7280"),
    rule:    rgb("#D1FAE5"),
  ),
  // amber — warm, premium feel
  amber: (
    primary: rgb("#451A03"),
    accent:  rgb("#D97706"),
    muted:   rgb("#78716C"),
    rule:    rgb("#FEF3C7"),
  ),
  // crimson — confident, attention-grabbing
  crimson: (
    primary: rgb("#1F2937"),
    accent:  rgb("#BE123C"),
    muted:   rgb("#6B7280"),
    rule:    rgb("#FECDD3"),
  ),
  // mono — pure black/grey, minimalist
  mono: (
    primary: rgb("#000000"),
    accent:  rgb("#27272A"),
    muted:   rgb("#71717A"),
    rule:    rgb("#E4E4E7"),
  ),
)

// Resolve the active theme from --input theme=<name>, with graphite default.
// Optionally override individual colors via --input colors=<json-path>.
#let resolve-theme() = {
  let name = sys.inputs.at("theme", default: "graphite")
  let base = palettes.at(name, default: palettes.graphite)

  let colors_input = sys.inputs.at("colors", default: "")
  if colors_input != "" {
    let overrides = json(colors_input)
    let merged = (:)
    for (k, v) in base.pairs() {
      merged.insert(k, if k in overrides { rgb(overrides.at(k)) } else { v })
    }
    return merged
  }
  return base
}
