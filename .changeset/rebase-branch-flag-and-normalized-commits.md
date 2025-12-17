---
"@markjaquith/agency": patch
---

Add `--branch` flag to `agency rebase` and normalize all commit messages

- Add `--branch` (or `-b`) flag to `agency rebase` command to update emit branch during rebase
- Normalize all CLI-generated commit messages to follow consistent format: `chore: agency {subcommand} ({baseBranch}) {sourceBranch} → {emitBranch}`
- Update `agency task` commits to show base branch and branch flow
- Update `agency task --continue` commits to show full chain: `({baseBranch}) {originalSource} → {newSource} → {newEmit}`
- Update `agency rebase --branch` commits to show full context
- All commands now use `--branch` flag consistently for specifying custom emit branch names
