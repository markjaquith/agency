# OpenCode auto-start

`agency work . --auto` submits the generated prompt and opens the interactive
OpenCode TUI. Plain `agency work .` remains promptless.

## OpenCode V2

V2's native `opencode --prompt TEXT` populates the composer; it does not submit.
The managed Agency plugin's worker-identity hooks run after submission and are
not an auto-submit trigger.

For the built-in `opencode` and `opencode2` presets, Agency:

1. Checks the selected executable's version.
2. Creates a session at the canonical launch directory, or resolves the newest
   root session in that exact directory for a continued launch.
3. Sets session environment through `PUT /api/session/{id}/environment` before
   admitting input. This is necessary when the service is already running.
4. Admits one generated prompt with a unique message ID and `resume: true`.
5. Replaces the launcher with `opencode --session ID`, without a composer prompt.

All API calls use `opencode api`, retaining that executable's service discovery
and authentication. No TUI keystrokes or plugin reload callbacks submit input.
Admission errors stop startup; they do not fall back to a populated composer or
blindly retry a possibly admitted request. Errors identify the API operation
without printing the environment payload. A stopped launch can leave a session
and a working Agency task for recovery.

The native exec helper explicitly passes Bun's current environment to `execve`.
Calling libc `execvp` directly loses Bun-side environment mutations. This matters
because the V2 TUI refreshes session environment from its own inherited snapshot
when it attaches or reconnects.

V1 retains its native `--prompt` path. Custom runner definitions remain responsible
for their own submission behavior. This implementation was exercised against
installed OpenCode V2.0.1; V1 compatibility has focused command regression coverage.

## Verification

Focused regressions:

```sh
bun test src/utils/exec.test.ts src/workbase/opencode-launch.test.ts src/commands/work.test.ts
```

Real opt-in startup smoke (requires installed, authenticated V2 OpenCode and Git):

```sh
bun run test:opencode-auto
```

This creates an isolated fixture repository/workbase and launches the real
`agency work . --auto --agent opencode` under OpenCode's PTY API. It sends zero
keyboard bytes and requires:

- Exactly one submitted user message.
- A completed assistant message with a text part exactly
  `AGENCY_AUTO_SMOKE_EXECUTED`, not that string inside tool input/output.
- Actual completed shell output containing nonempty Agency identity and an empty
  `HERDR_ENV`, with no inherited supervisor pane identity.
- A clean fixture checkout after execution.

It closes only its own PTY and Git daemon. The fixture, `messages.json`, and
`evidence.json` remain at the printed temporary path for inspection.
`AGENCY_SMOKE_TMPDIR` overrides the fixture parent.
Set `AGENCY_SMOKE_EXECUTABLE=/absolute/path/to/agency` to exercise an installed
CLI instead of the development checkout; evidence records the resolved executable.
