---
ticketUrl: https://example.com/tickets/adopt-effect-pattern
description: Simplify an Agency service by adopting an Effect pattern.
phases:
  - id: introduce-service-contract
  - id: migrate-service
    dependsOn:
      - introduce-service-contract
  - id: remove-legacy-path
    dependsOn:
      - migrate-service
---

# Adopt an Effect pattern

Use the Effect repository as a reference while simplifying one Agency service.

## Phases

- `introduce-service-contract`: introduce the replacement service contract.
- `migrate-service`: move the implementation to the new contract.
- `remove-legacy-path`: remove the superseded code path.
