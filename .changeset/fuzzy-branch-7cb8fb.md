---
"@markjaquith/agency": patch
---

Fix `agency task --from` to require explicit branch name

The `--from` flag now correctly requires an explicit branch name instead of modifying the current branch. When using `agency task --from some-branch` without providing a branch name, the command will prompt for one (or error in silent mode). The `--from` flag only specifies the base branch to branch from, ensuring proper source/emit branch pairs are always created.

This prevents the scenario where a branch could be its own source and emit branch.
