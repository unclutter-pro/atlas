---
name: frontend-design
description: Implement web pages and components with responsive layouts, interaction states and accessible markup. Use design for shared visual decisions and preserve existing project styles.
license: Complete terms in LICENSE.txt
---

# Frontend implementation

Use `design` for visual direction and its web/application reference when needed. Preserve the project's framework, component library, tokens and brand conventions. For a small UI change, follow the surrounding implementation.

Build the requested interface as working code:

- Use semantic HTML, accessible names, keyboard navigation and visible focus states.
- Use Grid or Flexbox for layout, shared classes/components for repeated patterns, and existing CSS variables for design tokens.
- Check narrow and wide viewports. Prevent overflow and keep controls usable on touch devices.
- Implement the states the task needs: loading, empty, error, success and disabled. Connect interactions to real behavior; avoid decorative controls that do nothing.
- Use motion only when it supports the interaction or requested visual style. Respect reduced-motion preferences.
- Prefer existing font assets. When remote fonts are needed, include fallbacks and `font-display: swap`.

Use the `browser` skill to inspect the running UI and exercise changed interactions. Verify the requested behavior and relevant responsive states before reporting completion.
