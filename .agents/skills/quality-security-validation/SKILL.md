---
name: quality-security-validation
description: Enforce reliability, safety, and verification standards for session import features through error taxonomy, secure handling, and focused automated/manual checks.
---

# Quality, Security, and Validation

Use this skill to harden behavior and verify correctness.

## Scope
- user-facing error taxonomy and messages
- sensitive data handling and logging hygiene
- HTML/string sanitization requirements
- unit-level checks for normalization/import branching
- manual validation checklist for Tampermonkey runtime

## Workflow
1. Define canonical error categories and mapping helpers.
2. Enforce redaction/no-token logging across paths.
3. Verify all displayed remote values are text-rendered.
4. Add deterministic tests for pure logic and branch behavior.
5. Run manual checks for config, listing, single import, bulk import, and reopen flow.

## Implementation rules
- Avoid flaky tests and wall-clock assertions.
- Continue bulk processing after per-item failures.
- Treat security regressions as release blockers.

## Done criteria
- Critical paths have automated coverage where feasible.
- Manual checklist passes with expected success/failure reporting.
