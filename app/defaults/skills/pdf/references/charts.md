# Charts in PDFs

**Default tool: Cetz + cetz-plot.** Native to Typst, vector all the way, inherits the document's fonts and theme colours. One toolchain — no Python step, no PNG export, no font drift between chart and body text.

## Setup

Every template can use Cetz directly. Import at the top of your `.typ`:

```typst
#import "@preview/cetz:0.4.2"
#import "@preview/cetz-plot:0.1.3": plot, chart
```

Both packages are mirrored in the container's Typst package cache — no network needed at compile time.

## Theme integration

Reach into the active theme so every chart matches the surrounding document:

```typst
#import "themes.typ": resolve-theme
#let theme = resolve-theme()
```

Use `theme.accent` for primary series, `theme.muted` for axes, `theme.rule` for gridlines. Multi-series palettes go in `themes.typ` next to the colour tokens — keep them in one place.

## Patterns

### Horizontal bar — categories with a large value-spread

```typst
#figure(
  cetz.canvas({
    chart.barchart(
      mode: "basic",
      size: (10, 4),
      label-key: 0,
      value-key: 1,
      bar-style: i => (fill: theme.accent),
      x-tick-step: 50,
      (
        ("Tech",          225.9),
        ("Beratung",       48.7),
        ("Werbeagenturen", 27.6),
        ("WP + StB",       21.3),
      ),
    )
  }),
  caption: [Marktgrößen DACH 2024 (Mrd. €). Quelle: Bitkom.],
)
```

### Vertical bar — comparison across few categories

```typst
#cetz.canvas({
  chart.columnchart(
    mode: "basic",
    size: (9, 4),
    label-key: 0,
    value-key: 1,
    bar-style: i => (fill: theme.accent),
    y-tick-step: 5,
    (
      ("Q1", 12.4),
      ("Q2", 15.1),
      ("Q3", 17.8),
      ("Q4", 19.2),
    ),
  )
})
```

### Stacked bar — composition over categories

```typst
#let stack-colors = (theme.accent, theme.muted, theme.rule)

#cetz.canvas({
  chart.barchart(
    mode: "stacked",
    size: (10, 4.5),
    label-key: 0,
    value-key: (1, 2, 3),
    bar-style: i => (fill: stack-colors.at(calc.rem(i, stack-colors.len()))),
    (
      ("Q1", 60, 25, 15),
      ("Q2", 65, 22, 13),
      ("Q3", 70, 20, 10),
      ("Q4", 75, 15, 10),
    ),
  )
})
```

### Line chart — time series

```typst
#cetz.canvas({
  plot.plot(
    size: (10, 4),
    x-tick-step: 1,
    y-tick-step: 5,
    {
      plot.add(
        ((1, 10), (2, 15), (3, 22), (4, 18), (5, 27)),
        style: (stroke: 1.5pt + theme.accent),
        mark: "o",
      )
    },
  )
})
```

### Diverging bar — growth with positive and negative values

```typst
#let growth = (
  ("ITK",       4.7),
  ("Consulting", 4.3),
  ("WP",         7.6),
  ("PR",         2.5),
  ("Werbe",     -0.9),
)

#cetz.canvas({
  chart.columnchart(
    mode: "basic",
    size: (9, 4),
    label-key: 0,
    value-key: 1,
    bar-style: i => (fill: if growth.at(i).at(1) >= 0 { theme.accent } else { rgb("#A23E48") }),
    y-tick-step: 2,
    growth,
  )
})
```

## Anti-patterns

- **3D charts** — never. Distort comparisons.
- **Pie charts** — avoid. Use horizontal bar for >3 categories; humans read bars more accurately than angles.
- **Stacked bar with >5 layers** — switch to small multiples or 100 %-normalised stacked.
- **Default Cetz palette without theme integration** — looks generic. Always pipe `theme.accent` into `bar-style`.
- **Charts without titles** — the caption (in `figure(...)`) should state the question the chart answers.

## See also
- `templates/report.typ` § Wettbewerbslandschaft — uses Cetz directly
- Cetz docs: <https://cetz-package.github.io/docs/>
- cetz-plot docs: <https://github.com/cetz-package/cetz-plot>
