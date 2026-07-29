---
title: Simplify CRAFTS Security Triggering
type: architecture
tags: [crafts, security, schemas]
created: 2026-07-27
updated: 2026-07-27
sources:
  - docs/raw/specs/crafts-phase-artifact-contract.md
---

# Simplify CRAFTS Security Triggering

Replaced subjective `low|medium|high` C-phase risk scoring with a schema-defined, closed-vocabulary `security_triggers` list. An empty list preserves the normal flow; any trigger deterministically requires the independent plan-security checkpoint before Render.

The change deliberately reuses C's existing trust-boundary and test-strategy fields instead of adding asset inventories, abuse-case documents, or a separate policy service. Canonical and Pool Worker schemas, dispatcher validation, local/runtime agents, and CRAFTS skills now share the same trigger contract.
