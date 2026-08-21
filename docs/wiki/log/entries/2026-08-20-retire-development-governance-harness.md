---
title: Retire development governance harness
type: activity
tags: [tooling, cleanup]
created: 2026-08-20
---

# Retired development-only governance tooling

Removed the retired plan ledger, phase telemetry, plan-validation utilities, stale tests, and
generated attempt evidence. The Worker Harness boundary test now verifies that development-only
agent resources are absent without changing Worker runtime behavior. Root agent instructions were
condensed, local CRAFTS language removed, package-layout exceptions clarified, and detailed
verification/documentation rules delegated to their canonical scoped files.
