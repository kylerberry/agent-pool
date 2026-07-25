# 2026-07-25 — architecture — approve domain map and Repository Builder DAG

Recorded Kyler Berry's ADR-034 approval with a SHA-256-bound domain-map record, clarified that APIs/webhooks are domain-owned ports with policy-free transport adapters, and approved a mechanically validated 16-node Repository Builder implementation DAG. Split decomposition routing into an orchestrator-side harness boundary, removed it from the DAG-unaware Pool Worker policy, and corrected criteria provenance to include both decomposition and direct-task intake.
