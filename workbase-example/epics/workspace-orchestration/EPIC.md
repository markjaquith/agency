---
ticketUrl: https://example.com/tickets/workspace-orchestration
repos:
  - agency
  - effect
tasks:
  - id: define-workbase-config
  - id: discover-task-documents
    dependsOn:
      - define-workbase-config
  - id: track-task-phases
    dependsOn:
      - discover-task-documents
---

# Workspace orchestration

Coordinate the first pass at workbase-aware task orchestration.

## Tasks

- Define the workbase config.
- Discover task documents.
- Track task phases.
