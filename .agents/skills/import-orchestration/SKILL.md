---
name: import-orchestration
description: Coordinate single and bulk session import flows with conflict handling, progress tracking, retries policy, and resilient continuation behavior.
---

# Import Orchestration

Use this skill for session import execution logic.

## Scope
- single-item import from selected row
- bulk import over visible/filtered rows
- adapter interface (`importSession(sessionData, options)`)
- conflict mode handling (`skip-existing`, `replace-existing`)
- summary reporting and per-item result capture

## Workflow
1. Implement single import path with optional detail fetch.
2. Implement batch executor (default sequential).
3. For each item, record start/result/failure and continue batch.
4. Aggregate final counts (`imported`, `failed`, `skipped`).
5. Expose import state updates to UI layer.

## Implementation rules
- Batch failures must not abort entire run by default.
- Respect configured conflict mode for every item.
- Keep orchestration separate from DOM and transport layers.

## Done criteria
- Single import updates only selected row.
- Import-all produces complete summary despite mixed outcomes.
