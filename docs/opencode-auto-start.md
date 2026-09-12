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

## Opt-in wrapper for direct launches

The package also installs `agency-opencode`. It delegates unchanged to native
OpenCode unless both the environment trigger and a `--prompt` argument are present:

```sh
AGENCY_OPENCODE_AUTO_SUBMIT=1 agency-opencode --prompt "2+2"
```

For a development checkout, use:

```sh
AGENCY_OPENCODE_AUTO_SUBMIT=1 bun /absolute/agency/opencode-auto.ts --prompt "2+2"
```

To keep the literal `opencode --prompt` command in a shell, define an explicit
wrapper. Resolve the native executable before defining the function:

```sh
export AGENCY_OPENCODE_EXECUTABLE="$(command -v opencode)"
opencode() { agency-opencode "$@"; }
AGENCY_OPENCODE_AUTO_SUBMIT=1 opencode --prompt "2+2"
```

This is a delivered wrapper mechanism, not a modification of the installed
OpenCode binary. A PATH shim named `opencode` must likewise set
`AGENCY_OPENCODE_EXECUTABLE` to the absolute native executable to avoid recursion.

The auto-submit path supports a directory argument, `--session`/`-s`,
`--continue`/`-c`, `--server`, `--auto`, `--log-level`, and `--print-logs`.
Use separate option values (for example `--prompt "2+2"`). The wrapper also accepts
`--agent` and `--model`/`-m` (`provider/model#variant`), applying them to the selected
session before submission. Without those overrides, a resumed session retains its
agent/model; a new session uses server-configured defaults. It does not infer the
TUI's recently selected model from private client storage.

`--standalone` is rejected for auto-submission because separate private API and
TUI processes cannot share the session. Use a shared service or `--server URL`.
Unsupported auto-submit arguments fail before creating or submitting a session.
Without the trigger, normal native argument handling applies.

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

For a visible Herdr check, open an unfocused tab, run the wrapper command above,
and inspect both the screen and `/api/session/{id}/message`. Require one user
message `2+2` and a completed assistant text `4`, with an empty composer. Do not
press Enter in the composer or send another prompt to complete the test.
