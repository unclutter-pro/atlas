---
name: design
description: Choose or review visual hierarchy, typography, color and layout for interfaces, documents, presentations and graphics. Use existing brand and project conventions when extending a design.
---

# Design

Start with the user's deliverable and existing design context. Read relevant project instructions, tokens, components and brand assets before choosing a new direction. User requirements and established patterns take precedence over the suggestions in this skill.

For a small change, reuse the surrounding design and implement it. For a new design, infer audience, medium and purpose from the task, choose a coherent direction, and proceed. Ask only when missing information would materially change the result. Do not require a separate design approval unless the user requested one.

## Choose the relevant reference

- Websites and campaigns: [web-creative.md](references/web-creative.md).
- Applications and dashboards: [applications.md](references/applications.md).
- Reports and PDFs: [documents.md](references/documents.md).
- Slide decks: [presentations.md](references/presentations.md).
- Posters, covers and infographics: [visual-artifacts.md](references/visual-artifacts.md).
- Interactive or responsive output: [accessibility.md](references/accessibility.md).

Use `frontend-design` for web implementation. Use `pdf`, `docx`, `pptx` or `xlsx` for their file formats and bundled generators. Their templates are a useful starting point; adapt them when the task calls for it.

## Apply the direction

- Give the main action or information a clear visual priority. Use spacing, grouping, contrast and type size together.
- Reuse a small set of colors, type styles and spacing values. Extend existing tokens instead of renaming them for novelty.
- Choose fonts for readability, language coverage and brand fit. Use the existing font when it meets those needs. Local fonts are in `canvas-fonts/`; discover installed document fonts with `fc-list`.
- Match density to the medium. A dashboard, a printed report and a projected slide have different reading distances and space constraints.
- For controls, cover loading, empty, error, focus and disabled states as applicable. Animation should clarify a transition and respect reduced motion preferences.

## Verify the result

Render the output and inspect it at its intended size. Check hierarchy, overflow, alignment, content consistency and relevant accessibility requirements. Inspect mobile layouts for responsive interfaces. Fix observed problems before delivery.

Explain design decisions only when they help the user assess the result. Avoid a per-component rationale or a mandatory proposal format. If the project keeps a design-system document, update it when reusable patterns change; do not add a separate save-confirmation step.
