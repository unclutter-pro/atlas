// themes.typ — design tokens (colors + fonts + surfaces) for the bundled templates.
//
// Design philosophy: each theme is a *complete visual personality*, not just a
// colour swap. Body text stays near-black across all themes (readability +
// professional restraint). The accent appears only 3–5 times per page —
// title eyebrow, grand total, a single rule — never on every heading.
// Hierarchy is carried by typography (weight · size · tracking · whitespace),
// not by colour.
//
// Pick a theme:
//   build-pdf report --theme graphite output/report.pdf
//
// Or override individual tokens with a brand JSON:
//   build-pdf report --colors my-brand.json output/report.pdf
//
// my-brand.json may set any subset of the nine tokens below.

#let palettes = (
  // graphite — neutral / monochrome. The "no-colour" theme; relies on
  // typography alone. Pick this when the brand should disappear behind
  // the message.
  graphite: (
    primary:      rgb("#0F172A"),
    accent:       rgb("#334155"),
    muted:        rgb("#64748B"),
    rule:         rgb("#E2E8F0"),
    background:   rgb("#FFFFFF"),
    surface:      rgb("#F8FAFC"),
    font-body:    "Inter",
    font-heading: "IBM Plex Serif",
    font-mono:    "JetBrains Mono",
  ),
  // indigo — tech / corporate. SaaS-style restraint, single deep indigo
  // accent used very sparingly.
  indigo: (
    primary:      rgb("#0F172A"),
    accent:       rgb("#4338CA"),
    muted:        rgb("#64748B"),
    rule:         rgb("#E2E8F0"),
    background:   rgb("#FFFFFF"),
    surface:      rgb("#F5F3FF"),
    font-body:    "Inter",
    font-heading: "IBM Plex Serif",
    font-mono:    "JetBrains Mono",
  ),
  // forest — editorial / sustainable. The trinity is present at every level:
  //   sandy brown paper (background) + darker brown card (surface, layered
  //   paper feel) carry the brown; sage green rules carry the light green;
  //   deep canopy accent carries the dark green. Body type in warm dark brown
  //   so even paragraph text feels earthy, not corporate.
  forest: (
    primary:      rgb("#3E2C1C"),
    accent:       rgb("#166534"),
    muted:        rgb("#78635A"),
    rule:         rgb("#C2CFB6"),
    background:   rgb("#F5ECD8"),
    surface:      rgb("#EDE0C5"),
    font-body:    "Inter",
    font-heading: "IBM Plex Serif",
    font-mono:    "JetBrains Mono",
  ),
  // amber — editorial-warm / premium. Warm paper, burnt-amber accent,
  // serif headlines (Crimson Pro) for character.
  amber: (
    primary:      rgb("#292524"),
    accent:       rgb("#B45309"),
    muted:        rgb("#78716C"),
    rule:         rgb("#E7E5E4"),
    background:   rgb("#FDF8EE"),
    surface:      rgb("#FAF1DD"),
    font-body:    "Inter",
    font-heading: "Crimson Pro",
    font-mono:    "JetBrains Mono",
  ),
  // crimson — confident / magazine. Single deep-crimson accent (never
  // bright red), white paper, Plex Serif headlines.
  crimson: (
    primary:      rgb("#18181B"),
    accent:       rgb("#9F1239"),
    muted:        rgb("#71717A"),
    rule:         rgb("#E4E4E7"),
    background:   rgb("#FFFFFF"),
    surface:      rgb("#FAFAFA"),
    font-body:    "Inter",
    font-heading: "IBM Plex Serif",
    font-mono:    "JetBrains Mono",
  ),
  // mono — brutalist / archival. Pure black on white, JetBrains Mono
  // throughout, deliberately raw and unstyled.
  mono: (
    primary:      rgb("#000000"),
    accent:       rgb("#525252"),
    muted:        rgb("#737373"),
    rule:         rgb("#D4D4D4"),
    background:   rgb("#FFFFFF"),
    surface:      rgb("#F5F5F5"),
    font-body:    "JetBrains Mono",
    font-heading: "JetBrains Mono",
    font-mono:    "JetBrains Mono",
  ),
)

// Token classification for override parsing (colour tokens parsed via rgb(),
// font tokens passed as strings).
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
