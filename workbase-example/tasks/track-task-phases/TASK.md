---
ticketUrl: https://example.com/tickets/track-task-phases
epic: workspace-orchestration
phases:
  - id: phase-model
  - id: phase-sequencing
    dependsOn:
      - phase-model
---

# Track task phases

Represent intended pull requests before their remote PRs exist.

## Phases

- `phase-model`: add the initial phase model.
- `phase-sequencing`: add dependencies between phases.
