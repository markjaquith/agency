/**
 * Shared constants for the agency CLI tool.
 */

/**
 * Marker used in commit messages to indicate commits that should be
 * dropped entirely during the emit process. When this marker is found
 * in a commit message, emit will remove that commit from history.
 */
export const AGENCY_REMOVE_COMMIT = "AGENCY_REMOVE_COMMIT"

/**
 * Directory name for agency worktrees inside the repo root.
 * This is locally excluded via .git/info/exclude.
 */
export const AGENCY_WORKTREES_DIR = ".agency-worktrees"

/**
 * Name of the optional init script in templates that runs after worktree creation.
 * This script is NOT copied into the worktree — it runs from the template directory.
 */
export const WORKTREE_INIT_SCRIPT = "worktree-init"
