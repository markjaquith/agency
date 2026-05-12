I was in /Users/mark.jaquith/worktrees/zenpayroll/agency--mark.jaquith**can-1241**generate-employer-tasks-todos-for-roe-web-submission

And I tried doing `agency emit --verbose`. And it seems to hang forever at the filtering part. I need more insight into what is happening there and why it is hanging.

## Tasks

- [x] Trace `agency emit --verbose` filtering path
- [x] Check the referenced zenpayroll worktree `agency.json` for broad injected globs
- [x] Add verbose preflight diagnostics before `git-filter-repo`
- [x] Add periodic verbose heartbeat while `git-filter-repo` is still running
- [x] Fix fork-point verbose logging so `silent` suppresses it
- [x] Add focused tests for process progress callbacks and emit diagnostics
- [x] Run `bun format > /dev/null`
- [x] Run `bun test src/utils/process.test.ts`
- [x] Run `bun test src/commands/emit.test.ts`
