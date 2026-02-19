---
name: session-data-pipeline
description: Normalize, validate, deduplicate, sort, and track session records from OpenCode APIs for robust UI rendering and import operations.
---

# Session Data Pipeline

Use this skill for transforming API payloads into stable internal models.

## Scope
- list payload normalization to `SessionListItem`
- required field checks (`id`)
- fallback title generation
- dedupe by ID and malformed-row skip accounting
- sort policy (`updatedAt` descending when available)

## Workflow
1. Parse payload into unknown-safe structures.
2. Convert each item into normalized shape with strict guards.
3. Deduplicate by `id`; keep latest record using sort keys.
4. Track dropped/malformed counts for user status output.
5. Expose pure functions for deterministic unit tests.

## Implementation rules
- Never throw on single malformed row; continue processing.
- Keep normalization pure and side-effect free.
- Render server values as text only, never raw HTML.

## Done criteria
- Normalization output is stable for valid+mixed payloads.
- Edge-case counts are observable by UI logging layer.
