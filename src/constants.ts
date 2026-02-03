/**
 * Shared constants for the agency CLI tool.
 */

/**
 * Marker used in commit messages to indicate commits that should be
 * dropped entirely during the emit process. When this marker is found
 * in a commit message, emit will remove that commit from history.
 */
export const AGENCY_REMOVE_COMMIT = "AGENCY_REMOVE_COMMIT"
