---
"@markjaquith/agency": minor
---

Add `--continue` flag to `agency task` command for continuing tasks after PR merge

After a PR is merged, you can now run `agency task --continue <new-branch-name>` to create a new branch that preserves your agency files (TASK.md, AGENCY.md, opencode.json, agency.json, and all backpacked files). The new branch is created from main with your documentation intact, and the `emitBranch` in agency.json is automatically updated for the new branch.

This enables a workflow where you can make a PR, let it get merged, then seamlessly continue working on the same task with all your progress notes preserved.
