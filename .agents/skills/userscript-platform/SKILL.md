---
name: userscript-platform
description: Build and maintain Tampermonkey userscript foundations including metadata, grants, menu commands, persisted config, and HTTP request wrappers.
---

# Userscript Platform

Use this skill when implementing or updating Tampermonkey runtime plumbing.

## Scope
- Metadata block (`@name`, `@namespace`, `@version`, `@match`, `@grant`, `@connect`)
- `GM_registerMenuCommand` actions
- persisted settings with `GM_getValue`/`GM_setValue`
- request wrappers (`GM_xmlhttpRequest` and/or fetch fallback)

## Workflow
1. Define/validate metadata fields against target host pages and API hosts.
2. Implement a small config module with defaults and URL validation.
3. Add menu entries for opening overlay and configuration.
4. Centralize HTTP request helper with auth-header handling.
5. Ensure values read/write are namespaced and backward-compatible.

## Implementation rules
- Keep all userscript globals behind small adapters.
- Never hardcode secrets or log token values.
- Fail closed on invalid endpoint configuration.

## Done criteria
- Script boots on matched pages.
- Config persists across reloads.
- Menu command actions are reachable and idempotent.
