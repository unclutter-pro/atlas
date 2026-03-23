# Accessibility & Responsive Design

Accessibility is not a feature — it's a quality bar. If a design excludes users, it's a broken design. These rules apply across all surfaces (web, applications, documents).

---

## Color & Contrast

### WCAG Contrast Ratios

| Element | Minimum Ratio | Level |
|---------|--------------|-------|
| Body text (< 18px) | 4.5:1 | AA |
| Large text (>= 18px bold or >= 24px) | 3:1 | AA |
| UI components & graphical objects | 3:1 | AA |
| Enhanced body text | 7:1 | AAA |
| Enhanced large text | 4.5:1 | AAA |

**How to check:** Use the formula or a contrast checker. Common failures:
- Light grey text on white (`#999` on `#fff` = 2.85:1 — fails)
- Placeholder text (`#aaa` on `#fff` = 2.32:1 — fails)
- Colored text on colored backgrounds without checking

### Color-Blind Safety

~8% of men and ~0.5% of women have color vision deficiency.

- **Never use color alone** to convey information. Pair with icons, patterns, labels, or position.
- **Red/green is the most common failure.** Use red + blue/orange, or add icons (checkmark/X).
- **Charts and data viz:** Use patterns, different line styles (solid/dashed/dotted), or direct labels instead of color-only legends.
- **Safe color palette approach:** Design in greyscale first. If the design works without color, color-blind users won't miss information.
- **Common safe combinations:**
  - Blue + Orange (distinguishable by all types)
  - Blue + Red (safe for deuteranopia/protanopia)
  - Dark blue + Yellow (high contrast for all)

### Dark Mode Considerations

- Don't just invert colors — reduce contrast slightly. Pure white (`#fff`) on pure black (`#000`) causes halation (text appears to bleed). Use `#e0e0e0` on `#121212` or similar.
- Maintain semantic color meaning across modes (errors stay red-ish, success stays green-ish).
- Shadows don't work on dark backgrounds — use lighter borders or subtle elevation differences.
- Test contrast ratios in both modes independently.

---

## Touch & Interaction Targets

### Minimum Target Sizes

| Standard | Minimum Size | Notes |
|----------|-------------|-------|
| WCAG 2.2 (AA) | 24x24px | With 24px spacing between targets |
| Apple HIG | 44x44pt | Recommended for iOS |
| Material Design | 48x48dp | Recommended for Android |
| **Practical minimum** | **44x44px** | Use this as the baseline |

- The **visual element** can be smaller (e.g., a 16px icon), but the **tap target** must be at least 44x44px.
- Adjacent targets need sufficient spacing (minimum 8px gap) to prevent mis-taps.
- Inline text links in paragraphs get an exception — but navigation links, buttons, and form controls must meet the minimum.

### Interactive Element Spacing

```css
/* Minimum spacing between interactive elements */
.button + .button { margin-left: 8px; }

/* Touch-friendly list items */
.list-item { min-height: 44px; padding: 12px 16px; }

/* Form inputs */
input, select, textarea { min-height: 44px; padding: 8px 12px; }
```

---

## Focus & Keyboard Navigation

### Focus Indicators

- **Never remove focus outlines** (`outline: none`) without providing an alternative.
- Default browser focus is acceptable. Custom focus styles should be **more** visible, not less.
- Focus indicators need 3:1 contrast against adjacent colors.

```css
/* Good: visible custom focus */
:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}

/* Remove focus ring for mouse users, keep for keyboard */
:focus:not(:focus-visible) {
  outline: none;
}
```

### Tab Order

- Follow visual reading order (top-to-bottom, left-to-right in LTR languages).
- Never use `tabindex` values > 0 — they create unpredictable tab order.
- `tabindex="0"` makes non-interactive elements focusable (use sparingly).
- `tabindex="-1"` makes elements programmatically focusable but not in tab order.

### Keyboard Patterns

| Component | Expected Keys |
|-----------|--------------|
| Button | Enter, Space |
| Link | Enter |
| Checkbox | Space |
| Radio group | Arrow keys |
| Dropdown/Select | Arrow keys, Enter, Escape |
| Modal/Dialog | Escape to close, Tab trapped inside |
| Tab panel | Arrow keys between tabs, Tab into content |
| Menu | Arrow keys, Enter, Escape |

---

## Typography & Readability

### Minimum Font Sizes

| Context | Minimum | Recommended |
|---------|---------|-------------|
| Body text (desktop) | 14px | 16px |
| Body text (mobile) | 14px | 16px |
| Captions/labels | 11px | 12px |
| Interactive labels | 14px | 16px |
| Legal/fine print | 11px | 12px |

### Line Length & Spacing

- **Optimal line length:** 45-75 characters (including spaces). Wider causes reading fatigue.
- **Line height:** 1.4-1.6 for body text. Tighter for headings (1.1-1.3).
- **Paragraph spacing:** at least 1.5x the line spacing between paragraphs.
- **Letter spacing:** Don't reduce below default. Slight increase (0.01-0.02em) improves readability for all-caps text.

### Content Structure

- Use proper heading hierarchy (h1 → h2 → h3). Never skip levels for styling.
- Break long content with subheadings every 3-5 paragraphs.
- Use lists for 3+ related items instead of comma-separated sentences.
- Front-load important information — users scan, they don't read linearly.

---

## Responsive Design

### Breakpoint System

```css
/* Mobile-first breakpoints */
/* xs: 0-479px    — phones portrait */
/* sm: 480-767px  — phones landscape, small tablets */
/* md: 768-1023px — tablets */
/* lg: 1024-1279px — small desktops, tablets landscape */
/* xl: 1280-1535px — desktops */
/* 2xl: 1536px+   — large desktops */

@media (min-width: 480px) { /* sm */ }
@media (min-width: 768px) { /* md */ }
@media (min-width: 1024px) { /* lg */ }
@media (min-width: 1280px) { /* xl */ }
```

### Mobile-First Principles

- **Design for smallest screen first**, then add complexity for larger screens.
- **Stack on mobile, arrange on desktop.** Horizontal layouts become vertical.
- **Prioritize content.** On mobile, secondary navigation, sidebars, and decorative elements can collapse or hide.
- **Thumb zone:** Primary actions in the bottom half of the screen on mobile. Top-left and top-right corners are hardest to reach.

### Responsive Spacing

```css
/* Fluid spacing with clamp */
padding: clamp(16px, 4vw, 64px);
gap: clamp(12px, 2vw, 32px);
margin-inline: clamp(16px, 5vw, 120px);
```

### Touch vs. Mouse Considerations

| Aspect | Touch (Mobile) | Mouse (Desktop) |
|--------|---------------|-----------------|
| Target size | 44px minimum | 24px acceptable |
| Hover states | Not available | Essential feedback |
| Drag & drop | Possible but harder | Precise |
| Right-click | Not available | Context menus |
| Scrolling | Momentum-based | Precise |
| Text selection | Deliberate gesture | Natural |

- **Never rely on hover for essential information.** Tooltips triggered by hover must also work with tap/focus on touch devices.
- **Provide alternatives** for right-click menus (long-press or visible menu button).
- **Swipe gestures** should always have a visible button alternative.

---

## Forms & Input

### Labels & Instructions

- Every input needs a visible label. Placeholder text is not a label — it disappears on focus.
- Group related fields with `<fieldset>` and `<legend>`.
- Error messages should be specific: "Email must include @" not "Invalid input."
- Place error messages directly below the field, not in a toast or modal.

### Input Design

```css
/* Accessible input styling */
input {
  min-height: 44px;
  padding: 8px 12px;
  font-size: 16px; /* Prevents iOS zoom on focus */
  border: 1px solid #6b7280;
  border-radius: 6px;
}

input:focus {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
  border-color: #2563eb;
}

/* Error state */
input[aria-invalid="true"] {
  border-color: #dc2626;
  border-width: 2px;
}
```

### Form Validation

- Show validation on blur or submit — not while typing.
- Mark required fields with text "(required)" not just an asterisk.
- Don't clear form fields on error — let users fix their input.
- Use `autocomplete` attributes for common fields (name, email, address).

---

## Motion & Animation

- **Respect `prefers-reduced-motion`.** Reduce or eliminate animations for users who request it.
  ```css
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
  ```
- No flashing content (3 flashes per second or below).
- Autoplay videos must be muted and have pause controls.
- Loading animations should have aria-live announcements for screen readers.

---

## Images & Media

- Every meaningful image needs `alt` text. Decorative images get `alt=""`.
- Complex images (charts, diagrams) need longer descriptions — use `aria-describedby` pointing to a text description.
- Videos need captions. Audio content needs transcripts.
- Don't use images of text — use actual text with CSS styling.

---

## Common Failures to Avoid

1. **Grey text on grey background** — looks subtle and modern, fails contrast
2. **Icon-only buttons** without labels or `aria-label`
3. **Custom dropdowns** that don't support keyboard navigation
4. **Removing focus outlines** "because they're ugly"
5. **Color-only status indicators** (red dot = error, green dot = success, with no label)
6. **Fixed-size containers** that break with larger text (200% zoom)
7. **Infinite scroll** with no alternative navigation
8. **Autoplay audio/video** with no way to stop
9. **Tiny close buttons** on modals (especially on mobile)
10. **Drag-only interactions** with no button alternative

---

## Pre-Delivery Accessibility Checklist

Run this against every output before showing it to the user:

**Contrast (must-pass):**
- [ ] Primary text color against its background ≥ 4.5:1
- [ ] Heading text against its background ≥ 3:1 (if ≥ 18px bold or ≥ 24px)
- [ ] Interactive element borders/fills against background ≥ 3:1
- [ ] In dark mode: text is NOT pure white, background is NOT pure black

**Structure (must-pass):**
- [ ] Heading hierarchy is sequential (h1 → h2 → h3, no skipping)
- [ ] Interactive elements have visible focus states
- [ ] No information conveyed by color alone

**Interactive (when applicable):**
- [ ] All buttons/links have text content or `aria-label`
- [ ] Touch targets ≥ 44×44px on mobile surfaces
- [ ] At least one hover transition defined in CSS
- [ ] `prefers-reduced-motion` media query included if animations exist

Quick contrast reference for common pairings:
- `#666` on `#fff` = 5.74:1 (passes AA)
- `#767676` on `#fff` = 4.54:1 (minimum AA pass)
- `#888` on `#fff` = 3.54:1 (fails for body text)
- `#e0e0e0` on `#121212` = 12.6:1 (good dark mode)
- `#9ca3af` on `#111827` = 5.28:1 (passes AA)
