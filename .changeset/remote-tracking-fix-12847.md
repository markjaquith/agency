---
"@markjaquith/agency": patch
---

Fix remote tracking branch setup when creating task branches. When creating a new task branch, git was incorrectly setting up tracking to the local "main" branch instead of the remote. This fix ensures new source branches track the remote branch when available and prevents automatic tracking setup with the `--no-track` flag.
