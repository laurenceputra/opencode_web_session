---
name: opencode-api-contracts
description: Discover and codify OpenCode API contracts for session listing/detail retrieval and destination import integration, including auth and failure mapping.
---

# OpenCode API Contracts

Use this skill to research, lock down, and document source/destination API interfaces.

## Scope
- Source list endpoint and single-session endpoint
- Destination import endpoint or integration hook
- auth method (cookie/session vs bearer token)
- response status and error contract mapping

## Workflow
1. Enumerate candidate endpoints and expected methods.
2. Validate real response shapes with small probes/mocks.
3. Define normalized contract boundaries consumed by the app.
4. Map HTTP failure classes to user-facing error categories.
5. Record assumptions and unresolved unknowns explicitly.

## Implementation rules
- Keep endpoint paths configurable where uncertainty exists.
- Do not assume HTML responses are valid payloads.
- Preserve raw payloads for debugging, but redact sensitive headers.

## Done criteria
- List/detail/import interfaces are explicit and testable.
- Error handling has deterministic mapping for 401/403/network/schema/import-reject cases.
