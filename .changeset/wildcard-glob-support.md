---
"@markjaquith/agency": minor
---

Add wildcard glob pattern support for backpacked files

- Template directories (e.g., `plans/README.md`) are now tracked as glob patterns (`plans/**`) when the directory doesn't exist in the repo
- Glob patterns in `injectedFiles` are expanded at emit time to filter all matching files
- Users can manually add glob patterns to `agency.json` (e.g., `docs/**`, `tmp/**`)
