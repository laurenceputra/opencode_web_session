---
name: overlay-ui-state
description: Implement an accessible in-page overlay for session browsing/import, including controls, filtering, per-row actions, and deterministic UI state transitions.
---

# Overlay UI State

Use this skill when building the session overlay and its interactive state model.

## Scope
- fixed overlay shell with close/open behavior
- controls: refresh, import all, settings
- session list/table with search filter
- row state badges (`idle`, `importing`, `imported`, `failed`, `skipped`)
- progress/log panel updates

## Workflow
1. Build overlay mount/unmount and keyboard-close handling.
2. Render controls and hook actions to controller events.
3. Render list rows and map status to visuals + disabled states.
4. Add client-side filter over id/title.
5. Preserve state while overlay is hidden and re-opened.

## Implementation rules
- Do not duplicate action handlers across rows.
- Disable conflicting actions while import is in progress.
- Keep DOM updates minimal and deterministic.

## Done criteria
- Overlay can open/close without reload.
- Row states and batch summary update correctly during operations.
