# @markjaquith/agency

## 0.7.0

### Minor Changes

- 4256865: Improve branch creation message formatting to display base branch, source branch, and emit branch relationships using a consistent format with arrow notation.

### Patch Changes

- 9560990: Fix gh CLI timeout in push command to prevent CI hangs when creating pull requests with non-GitHub remotes
- 0f3cc0d: Fix CI workflow to run all steps on changeset release PRs but conditionally skip test steps, allowing required checks to pass on release automation branches.
- 1bb2cb2: Simplify CI workflow conditional logic by moving changeset-release check to job level instead of repeating on each step, and add branch filtering to semantic PR linting.

## 0.6.1

### Patch Changes

- 56bf1db: Fix CLAUDE.md filtering during emit operations to ensure modified managed files are properly reverted on emit branches

## 0.6.0

### Minor Changes

- 06cb7ff: Add `agency rebase` command for rebasing source branch onto base branch while preserving agency files. This allows users to continue working on the same branch after their PR has been merged, without needing to create a new branch.
- 62272f8: Remove short-form command switches to streamline CLI interface. The following short forms have been removed: `-e` (--emit), `-c` (--continue), and `-b` (--branch). Users must now use the full long-form switches for these options.
- 66d2ee7: Add `--emit` flag as the primary option for specifying emit branch names in `emit`, `push`, `rebase`, and `task` commands. The `--branch` flag is retained as a deprecated alias for backward compatibility.
- 0e599d9: Add `--emit` flag as the primary option for specifying emit branch names in `emit`, `push`, `rebase`, and `task` commands. The `--branch` flag is retained as a deprecated alias for backward compatibility.
- 0d30ad8: Add `--continue` flag to `agency task` command for continuing tasks after PR merge

  After a PR is merged, you can now run `agency task --continue <new-branch-name>` to create a new branch that preserves your agency files (TASK.md, AGENCY.md, opencode.json, agency.json, and all backpacked files). The new branch is created from main with your documentation intact, and the `emitBranch` in agency.json is automatically updated for the new branch.

  This enables a workflow where you can make a PR, let it get merged, then seamlessly continue working on the same task with all your progress notes preserved.

- 2b4bf7e: Add wildcard glob pattern support for backpacked files
  - Template directories (e.g., `plans/README.md`) are now tracked as glob patterns (`plans/**`) when the directory doesn't exist in the repo
  - Glob patterns in `injectedFiles` are expanded at emit time to filter all matching files
  - Users can manually add glob patterns to `agency.json` (e.g., `docs/**`, `tmp/**`)

### Patch Changes

- 275e2ee: Fix task command to prefer remote branches over local branches when creating task branches

  Resolves issue where `agency task` would use local `main` branch instead of `origin/main`, causing task branches to be created from outdated code when the local branch fell behind the remote.

- cdda94d: Fix `agency task --from` to require explicit branch name

  The `--from` flag now correctly requires an explicit branch name instead of modifying the current branch. When using `agency task --from some-branch` without providing a branch name, the command will prompt for one (or error in silent mode). The `--from` flag only specifies the base branch to branch from, ensuring proper source/emit branch pairs are always created.

  This prevents the scenario where a branch could be its own source and emit branch.

- 82b2a51: Add `--branch` flag to `agency rebase` and normalize all commit messages
  - Add `--branch` (or `-b`) flag to `agency rebase` command to update emit branch during rebase
  - Normalize all CLI-generated commit messages to follow consistent format: `chore: agency {subcommand} ({baseBranch}) {sourceBranch} → {emitBranch}`
  - Update `agency task` commits to show base branch and branch flow
  - Update `agency task --continue` commits to show full chain: `({baseBranch}) {originalSource} → {newSource} → {newEmit}`
  - Update `agency rebase --branch` commits to show full context
  - All commands now use `--branch` flag consistently for specifying custom emit branch names

- 46299aa: Fix remote tracking branch setup when creating task branches. When creating a new task branch, git was incorrectly setting up tracking to the local "main" branch instead of the remote. This fix ensures new source branches track the remote branch when available and prevents automatic tracking setup with the `--no-track` flag.
- b1b3770: Fix README documentation issues:
  - Corrected references from non-existent `agency pr` command to `agency emit`
  - Added documentation for `--pr` and `--force` flags on `agency push` command
  - Added documentation for `--squash` and `--push` flags on `agency merge` command

## 0.5.1

### Patch Changes

- 03c51d1: Test patch bump

## 0.5.0

### Minor Changes

- Minor version bump for new features and improvements
