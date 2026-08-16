# Emerald Utilities — UI Standardisation

**Version:** 0.1.5
**Status:** Active
**Last Updated:** 22 July 2026

> **Maintenance reminder:** When bumping the app version, update the `**Version:**` and `**Last Updated:**` fields above to match [`src/globals.js`](src/globals.js:5) and today's date. This prevents documentation drift.

---

## Design System

### Colors

All colors are defined as CSS custom properties in [`src/css/globals.css`](src/css/globals.css).

| Token | Value | Usage |
|-------|-------|-------|
| `--color-bg` | `#0a0a0a` | Primary background |
| `--color-surface` | `#111` | Panels, cards, modals |
| `--color-surface-hover` | `#1a1a1a` | Hover states, input backgrounds |
| `--color-border` | `#333` | Borders, dividers |
| `--color-accent` | `#ff2222` | Primary accent, focus rings |
| `--color-accent-hover` | `#ff2222` | Accent hover state |
| `--color-text` | `#ffffff` | Primary text |
| `--color-terminal-bg` | `#0f0f0f` | Terminal/console backgrounds |
| `--color-terminal-text` | `#ff2222` | Terminal text |
| `--color-code-bg` | `#222` | Code block backgrounds |
| `--color-code-text` | `#ff2222` | Code text |
| `--color-modal-bg` | `rgba(0, 0, 0, 0.8)` | Modal overlay |
| `--color-shadow` | `rgba(255, 34, 34, 0.3)` | Accent shadows |
| `--color-priority-green` | `#44ff66` | Low priority task alerts |
| `--color-priority-orange` | `#ffaa22` | Medium priority task alerts |
| `--color-priority-red` | `#ff2222` | High priority task alerts |

**Rules:**
- Never hardcode hex colors in components. Use the CSS custom properties above.
- Never invent new color tokens without updating this document.
- All new components must use existing tokens.

---

### Typography

| Element | Size | Weight | Notes |
|---------|------|--------|-------|
| Application font | `clamp(1.3rem, 1.9vw, 2rem)` | normal | `pixelSans` (fallback: Arial, sans-serif) |
| Panel header | `clamp(1rem, 1.3vw, 1.3rem)` | bold | Uppercase, letter-spacing |
| Body text | `clamp(0.9rem, 1.1vw, 1.1rem)` | normal | |
| Small text | `clamp(0.75rem, 0.9vw, 0.9rem)` | normal | Labels, metadata |
| Code / terminal | `clamp(0.75rem, 1vw, 1rem)` | normal | `pixelSans`, monospace fallback |

**Rules:**
- Use `clamp()` for all font sizes to ensure responsiveness.
- Never use fixed `px` values for font sizes.
- Monospace text must use `pixelSans` with `monospace` fallback.

---

### Spacing

All spacing uses `clamp()` for responsive scaling.

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `clamp(0.2rem, 0.4vw, 0.4rem)` | Tight gaps |
| `--space-sm` | `clamp(0.4rem, 0.6vw, 0.6rem)` | Small gaps |
| `--space-md` | `clamp(0.6rem, 1vw, 1rem)` | Standard gaps |
| `--space-lg` | `clamp(0.75rem, 1.2vw, 1.25rem)` | Panel padding, grid gaps |
| `--space-xl` | `clamp(1rem, 2vw, 2rem)` | Large padding |

**Rules:**
- Use `gap`, `padding`, and `margin` with `clamp()` values.
- Never use fixed `px` or `rem` values for spacing.
- Consistent gap scale: `xs → sm → md → lg → xl`.

---

### Components

#### Cards

Cards are used for account displays, dashboard widgets, and settings panels.

```css
.chAccountCard {
    background: var(--color-bg);
    border: 2px solid var(--color-border);
    border-radius: 8px;
    padding: clamp(0.8rem, 1.2vw, 1.2rem);
}
```

**Rules:**
- All cards use `--color-bg` background and `--color-border` border.
- Hover state: border becomes `--color-accent`, slight translateY lift.
- Card padding follows `--space-lg`.

#### Buttons

| Class | Purpose |
|-------|---------|
| `.chButton` | Default button |
| `.chButtonPrimary` | Primary action (accent background) |
| `.chButtonSecondary` | Secondary action (surface hover) |
| `.chButtonDanger` | Destructive action (red border/hover) |
| `.chButtonSmall` | Compact variant |
| `.chButton:disabled` | Disabled state (opacity 0.5) |

```css
.chButton {
    padding: clamp(0.6rem, 1vw, 0.9rem) clamp(0.8rem, 1.4vw, 1.4rem);
    background: var(--color-surface-hover);
    color: var(--color-text);
    border: 1px solid var(--color-accent);
    border-radius: 4px;
    font-family: 'pixelSans', sans-serif;
    font-size: clamp(0.9rem, 1.1vw, 1.1rem);
    cursor: pointer;
    transition: all 0.15s ease;
}
```

**Rules:**
- All buttons use `pixelSans` font.
- Primary buttons have `--color-accent` background and `#000` text.
- Hover inverts colors (accent bg → text, text bg → accent).
- Never use inline button styles.

#### Inputs

| Class | Purpose |
|-------|---------|
| `.chInput` | Text inputs |
| `.chTextarea` | Multi-line text |
| `.chSelect` | Dropdown selects |

```css
.chInput, .chTextarea, .chSelect {
    width: 100%;
    padding: clamp(0.5rem, 0.8vw, 0.7rem) clamp(0.6rem, 1vw, 0.9rem);
    background: var(--color-bg);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-family: 'pixelSans', sans-serif;
    font-size: clamp(0.9rem, 1.1vw, 1.1rem);
}
```

**Rules:**
- Focus state: border becomes `--color-accent`.
- Never use default browser input styles.

#### Panels

Panels are the main layout containers.

```css
.chPanel {
    background: var(--color-surface);
    border: 2px solid var(--color-border);
    border-radius: 8px;
    padding: clamp(0.8rem, 1.2vw, 1.2rem);
}
```

**Rules:**
- Panel headers use `--color-accent` color, uppercase, bold.
- All panels use `--color-surface` background.

#### Forms

Forms use consistent label/input spacing.

```css
.chFormGroup {
    margin-bottom: clamp(0.6rem, 1vw, 1rem);
}

.chLabel {
    display: block;
    font-size: clamp(0.85rem, 1vw, 1rem);
    color: var(--color-text);
    margin-bottom: 0.3rem;
}
```

#### Dialogs / Modals

```css
.modal {
    display: none;
    position: fixed;
    z-index: 1000;
    background-color: var(--color-modal-bg);
    backdrop-filter: blur(3px);
}

.modal-content {
    background-color: var(--color-surface);
    border: 2px solid var(--color-accent);
    border-radius: 8px;
    box-shadow: 0 0 20px var(--color-shadow);
}
```

#### Notifications / Status Badges

| Class | Color | Usage |
|-------|-------|-------|
| `.chStatusSuccess` | `#4f4` on `#1a4a1a` | Success states |
| `.chStatusConnected` | `#4f4` on `#1a4a1a` | Connected accounts |
| `.chStatusError` | `#f44` on `#4a1a1a` | Error states |
| `.chStatusPending` | `#ff4` on `#4a4a1a` | Pending states |

#### Loading States

Loading states use the accent color for spinners and progress indicators.

```css
.chPublishProgressItem--testing,
.chPublishProgressItem--uploading,
.chPublishProgressItem--publishing {
    border-left-color: var(--color-accent);
}
```

#### Error States

Error text uses `#f88` on `#2a1a1a` background with `#f44` left border.

```css
.chCharWarning--error {
    color: #f88;
    background: #2a1a1a;
    border-left-color: #f44;
}
```

---

### Layout Grid

The main application uses a two-column grid:

```css
.app {
    display: grid;
    grid-template-columns: minmax(240px, 30%) 1fr;
    gap: clamp(0.75rem, 1.2vw, 1.25rem);
    padding: clamp(0.75rem, 1.2vw, 1.25rem);
}
```

**Rules:**
- Left panel: navigation, accounts, settings.
- Right panel: main content area.
- On mobile (< 900px): single column layout.

---

### Responsive Breakpoints

| Breakpoint | Layout |
|------------|--------|
| `> 900px` | Two-column grid |
| `<= 900px` | Single column, stacked |
| `<= 600px` | Compact spacing |

---

### Creator Hub Specific Styles

Creator Hub components use the `ch` prefix and follow the same token system.

Key components:
- `.chDashboardGrid` — Account card grid
- `.chAccountCard` — Individual account card
- `.chTargetList` / `.chTargetItem` — Multi-platform target list
- `.chFormGroup` / `.chLabel` / `.chInput` — Form elements
- `.chButton` / `.chButtonPrimary` / `.chButtonDanger` — Buttons
- `.chStatusConnected` / `.chStatusError` — Status badges
- `.chPublishProgress` — Publishing progress panel
- `.chHistoryEntry` — Publishing history entry
- `.chLogEntry` — Log viewer entry

All Creator Hub styles are in [`src/css/creator-hub.css`](src/css/creator-hub.css).

---

### Tasks Components

Tasks UI styles live in `src/css/tasks.css`.

Key components:
- `.tasksTopBar` — Tasks, Pending, Archive view switcher
- `.tasksSinglePanel` — Single-view task subpage panel
- `.taskToastRegion` / `.taskToast` — Due task notification popup stack
- `.taskPriority-green` / `.taskPriority-orange` / `.taskPriority-red` — Priority alert accents

**Rules:**
- Reminder polling may update renderer notification state, but task persistence must stay in the tasks service layer.
- Archived tasks are hidden from the main task list and displayed in the Archive view.
- Priority colors must use the priority color tokens.

---

### Archive Scheduler Components

Archive scheduler backend code lives in `src/core/archiveScheduler.js` and must stay UI agnostic. The scheduler stores task state, timer deadlines, notification preferences, and last execution metadata; renderer components may only communicate with it through IPC.

Archive scheduler UI styles live in `src/css/database.css`.

Key components:
- `.archiveScheduleForm` — Archive schedule configuration form
- `.scheduleGrid` — Responsive schedule field layout
- `.scheduleOptions` — Notification and recovery toggles
- `.scheduleList` / `.scheduleItem` — Saved schedule list
- `.archiveToastRegion` / `.archiveToast` — Workspace notification toast stack
- `.dbInput` — Database/archive form input variant

**Rules:**
- Timer execution belongs in the main process scheduler, never in React components.
- Toasts are renderer-only visual state and must not own scheduler timing logic.
- Scheduling persistence must be written through the scheduler abstraction.
- Resize-sensitive grids must use `minmax(0, 1fr)` or auto-fit constraints to prevent clipping while docking.

---

## Development Rules

1. **No new random CSS files.** All styles belong in `src/css/` or the existing styling system.
2. **No inline styles** in JSX unless absolutely necessary (prefer CSS classes).
3. **No hardcoded colors.** Use CSS custom properties.
4. **No fixed pixel spacing.** Use `clamp()`.
5. **No new font families.** Use `pixelSans` with appropriate fallbacks.
6. **All new components must be documented here** before implementation.
7. **ABSOLUTELY NO EMOJIS ALLOWED** in any UI text, labels, placeholders, or icons. Use text or CSS-based icons only.

---

## TODO Archiving System

When a TODO document is completed, archive it following this system:

**Archive path:** `docs/archive/todo/TODO-<DD-MM-YYYY>-<HH-MM>.md`

**Format:**
- Date: DD-MM-YYYY (day-month-year)
- Time: HH-MM (24-hour Amsterdam time, UTC+2)
- Example: `TODO-22-07-2026-11-34.md`

**Rules:**
1. Archive the original TODO.md after all tasks are completed
2. The archive filename must include the exact date and Amsterdam time of archiving
3. Keep the archive in `docs/archive/todo/` directory
4. Document the archiving system in this STANDARDISATION.md file
5. Never delete archived TODOs — they serve as historical records

**Current archive:** `docs/archive/todo/TODO-22-07-2026-11-34.md`
