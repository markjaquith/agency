---
"@markjaquith/agency": patch
---

Fix `agency task --from` to create new source branch instead of modifying current branch

When using `agency task --from some-branch`, the command now correctly creates a new source branch named `agency/some-branch` instead of adding an agency commit to the current branch. This ensures that the `--from` flag always creates a proper source/emit branch pair, and prevents the scenario where a branch could be its own source and emit branch.
