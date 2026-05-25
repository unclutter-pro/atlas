# Charts in PDFs

Two paths for embedding charts in a `.typ` document. Pick what fits the document.

## Path A — matplotlib PNGs (most flexible)

Pre-generate chart PNGs in a `charts/` subfolder next to your document, reference them with `image(...)` in the Typst source.

### Why this path
- Anything matplotlib can do (pandas integration, seaborn, scatter plots, heatmaps, twin axes, etc.).
- Compile speed is fast — Typst just reads the PNG.
- Charts are reusable in non-PDF contexts (slides, web).

### Recommended matplotlib setup
```python
import matplotlib as mpl
import matplotlib.pyplot as plt
import numpy as np

mpl.rcParams.update({
    "font.family": "DejaVu Sans",   # ships with the container
    "font.size": 10,
    "axes.titlesize": 12,
    "axes.titleweight": "bold",
    "axes.spines.top": False,
    "axes.spines.right": False,
    "figure.dpi": 150,
    "savefig.dpi": 150,
    "savefig.bbox": "tight",
})

import os
os.makedirs("charts", exist_ok=True)
```

### Patterns

**Horizontal bar** — categories with large value-spread:

```python
labels = ["Tech", "Beratung", "Werbeagenturen", "WP+StB"]
values = [225.9, 48.7, 27.6, 21.3]
fig, ax = plt.subplots(figsize=(9, 3.5))
y = np.arange(len(labels))
ax.barh(y, values, color=["#3F88C5", "#A23E48", "#E89A3C", "#7A8C7B"])
ax.set_yticks(y); ax.set_yticklabels(labels); ax.invert_yaxis()
ax.set_xlabel("Umsatz in Mrd. EUR (2024)")
ax.set_title("Marktgrößen DACH 2024")
for bar, v in zip(ax.patches, values):
    ax.text(v + 3, bar.get_y() + bar.get_height() / 2, f"{v:.1f}", va="center", fontsize=9)
ax.grid(axis="x", linestyle=":", alpha=0.4)
plt.savefig("charts/chart1.png")
plt.close()
```

**Donut** — share-of-100 with ≤8 categories. Avoid pie charts with more slices — switch to a horizontal bar.

```python
labels = ["Coding", "Maintenance", "Meetings", "Security", "Ops", "Other"]
values = [32, 21, 23, 13, 8, 3]
fig, ax = plt.subplots(figsize=(7.5, 5.5))
colors = ["#3F88C5", "#6FA8DC", "#A23E48", "#E89A3C", "#7A8C7B", "#4F4F4F"]
ax.pie(values, labels=labels, autopct="%1.0f%%", startangle=90,
       colors=colors, wedgeprops=dict(width=0.4, edgecolor="white"))
ax.set_title("Time allocation per developer")
plt.savefig("charts/chart_donut.png")
plt.close()
```

**Diverging bar** — growth / change with negative values:

```python
labels = ["ITK", "Consulting", "WP", "PR", "Werbe"]
values = [4.7, 4.3, 7.6, 2.5, -0.9]
colors = ["#3F88C5" if v > 0 else "#A23E48" for v in values]
fig, ax = plt.subplots(figsize=(9, 4.5))
x = np.arange(len(labels))
ax.bar(x, values, color=colors)
ax.axhline(y=0, color="black", linewidth=0.6)
ax.set_xticks(x); ax.set_xticklabels(labels, rotation=15, ha="right")
ax.set_ylabel("Umsatzwachstum 2024 (%)")
for i, v in enumerate(values):
    y = v + 0.15 if v >= 0 else v - 0.35
    ax.text(i, y, f"{v:+.1f} %", ha="center", fontsize=9)
plt.savefig("charts/chart_diverging.png")
plt.close()
```

**Stacked bar** — composition over categories:

```python
categories = ["Q1", "Q2", "Q3", "Q4"]
series = {
    "Tech": [60, 65, 70, 75],
    "Beratung": [25, 22, 20, 15],
    "Agentur": [15, 13, 10, 10],
}
fig, ax = plt.subplots(figsize=(9, 5))
x = np.arange(len(categories))
bottom = np.zeros(len(categories))
palette = ["#3F88C5", "#A23E48", "#E89A3C"]
for i, (name, vals) in enumerate(series.items()):
    ax.bar(x, vals, 0.7, bottom=bottom, label=name, color=palette[i])
    bottom += np.array(vals)
ax.set_xticks(x); ax.set_xticklabels(categories)
ax.set_ylabel("Anteil (%)")
ax.legend(loc="upper right", fontsize=9)
plt.savefig("charts/chart_stacked.png")
plt.close()
```

### Embedding in Typst
```typst
#figure(
  image("charts/chart1.png", width: 90%),
  caption: [Marktgrößen DACH 2024. Quelle: Bitkom.],
)
```

### Anti-patterns
- 3D charts — never. They distort comparisons.
- Pie charts with >8 slices — use horizontal bar.
- Stacked bar with >5 layers — switch to small multiples or 100%-normalized stacked.
- Default matplotlib palette — too saturated. Pick a brand or research palette.
- Charts without titles — the title should state the question the chart answers.

## Path B — Cetz (native Typst)

For brand-consistent vector charts compiled together with the document.

### Why this path
- Vector all the way through — sharp at any zoom level.
- Inherits the document's fonts and theme colours automatically.
- No Python step in your pipeline.

### Costs
- Cetz compiles slower than reading a PNG.
- Less expressive than matplotlib for complex statistics (no built-in regression, KDE, time-series resampling).

### Basic bar chart
```typst
#import "@preview/cetz:0.4.2"
#import "@preview/cetz-plot:0.1.4"

#figure(
  cetz.canvas({
    import cetz.draw: *
    cetz-plot.plot.plot(size: (10, 5), {
      cetz-plot.plot.add-bar((
        ("Tech", 225.9),
        ("Beratung", 48.7),
        ("Agenturen", 27.6),
      ))
    })
  }),
  caption: [Marktgrößen DACH 2024 (Mrd. €).],
)
```

### Line chart
```typst
#cetz.canvas({
  import cetz.draw: *
  cetz-plot.plot.plot(
    size: (10, 4),
    x-tick-step: 1,
    y-tick-step: 5,
    {
      cetz-plot.plot.add(
        ((1, 10), (2, 15), (3, 22), (4, 18), (5, 27)),
        style: (stroke: 1.5pt + rgb("#3F88C5")),
      )
    },
  )
})
```

## When to choose which

| Situation | Use |
|---|---|
| One-off report with custom data viz | matplotlib PNG |
| Pandas dataframes or seaborn vibes | matplotlib PNG |
| Brand-aligned report template, charts reused often | Cetz (inherits theme colours) |
| Highest visual fidelity needed (print, large posters) | Cetz (vector) |
| You have a chart from a Jupyter notebook | matplotlib PNG (export from the notebook) |

## See also
- `templates/AUTHORING.md` § Image with caption
- `templates/report.typ` § Wettbewerbslandschaft (uses Path A)
