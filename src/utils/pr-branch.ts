/**
 * Utilities for working with PR branch names and patterns
 */

/**
 * Generate a PR branch name from a pattern and source branch name.
 * If pattern contains %branch%, it replaces it with the branch name.
 * Otherwise, treats the pattern as a suffix.
 * 
 * @example
 * makePrBranchName("feature-foo", "%branch%--PR") // "feature-foo--PR"
 * makePrBranchName("feature-foo", "PR/%branch%") // "PR/feature-foo"
 * makePrBranchName("feature-foo", "--PR") // "feature-foo--PR"
 */
export function makePrBranchName(branchName: string, pattern: string): string {
  if (pattern.includes("%branch%")) {
    return pattern.replace("%branch%", branchName);
  }
  
  // If no %branch% placeholder, treat pattern as suffix
  return branchName + pattern;
}

/**
 * Extract the source branch name from a PR branch name using a pattern.
 * Returns null if the PR branch name doesn't match the pattern.
 * 
 * @example
 * extractSourceBranch("feature-foo--PR", "%branch%--PR") // "feature-foo"
 * extractSourceBranch("PR/feature-foo", "PR/%branch%") // "feature-foo"
 * extractSourceBranch("feature-foo--PR", "--PR") // "feature-foo"
 * extractSourceBranch("main", "%branch%--PR") // null
 */
export function extractSourceBranch(prBranchName: string, pattern: string): string | null {
  if (pattern.includes("%branch%")) {
    // Split pattern into prefix and suffix around %branch%
    const parts = pattern.split("%branch%");
    if (parts.length !== 2) return null;
    
    const prefix = parts[0]!;
    const suffix = parts[1]!;
    
    // Check if PR branch name matches the pattern
    if (!prBranchName.startsWith(prefix) || !prBranchName.endsWith(suffix)) {
      return null;
    }
    
    // Extract the branch name by removing prefix and suffix
    const sourceBranch = prBranchName.slice(
      prefix.length,
      prBranchName.length - suffix.length
    );
    
    // Ensure we extracted something (not empty string)
    return sourceBranch.length > 0 ? sourceBranch : null;
  } else {
    // Pattern is a suffix - check if branch ends with it
    if (!prBranchName.endsWith(pattern)) {
      return null;
    }
    
    const sourceBranch = prBranchName.slice(0, -pattern.length);
    return sourceBranch.length > 0 ? sourceBranch : null;
  }
}

/**
 * Check if a branch name appears to be a PR branch based on the pattern.
 * 
 * @example
 * isPrBranch("feature-foo--PR", "%branch%--PR") // true
 * isPrBranch("feature-foo", "%branch%--PR") // false
 */
export function isPrBranch(branchName: string, pattern: string): boolean {
  return extractSourceBranch(branchName, pattern) !== null;
}
