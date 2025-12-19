I'm trying to get semantic-release working with OICD Trusted Publishing.

NPM is set up correctly. `release.yml` is configured as per the documentation.

This was previously working for publishing via "changesets", but now I want to use semantic-release.

Semantic-release seems to think that I need an NPM token, but with OIDC Trusted Publishing, I thought that wasn't necessary. So something about my release process or configuration (on the GitHub side) must be off.

Please look at semantic-release's documentation for OICD Trusted Publishing and help me figure out what I'm missing.

## Findings

The `@semantic-release/npm` plugin DOES support OIDC Trusted Publishing from GitHub Actions. When configured correctly, it will:

1. Detect that it's running in GitHub Actions
2. Try to get an OIDC token via `getIDToken("npm:registry.npmjs.org")`
3. Exchange that token with npm for a short-lived publish token
4. If successful, skip the `NPM_TOKEN` requirement entirely

Your workflow already has `id-token: write` permission set correctly.

## Root Cause

**FOUND IT!** The workflow had a top-level `permissions:` block that was setting `contents: read`. Even though the job-level permissions included `id-token: write`, GitHub Actions was NOT granting the id-token permission (confirmed by checking the actual permissions in the workflow run logs).

The top-level permissions block was blocking the id-token permission from being granted to the job.

## Solution

On npmjs.com, the Trusted Publisher must be configured with:

- **Package**: `@markjaquith/agency` (exact match)
- **Repository**: `markjaquith/agency`
- **Workflow**: `release.yml` ← This MUST match your actual workflow filename
- **Environment**: (leave blank unless you're using GitHub environments)

## Next Steps

1. Verify npm Trusted Publisher configuration matches exactly
2. Ensure the workflow filename in npm config is `release.yml`
3. If using a different workflow file, update npm config accordingly
4. Push a commit to trigger the release workflow and verify OIDC auth works
