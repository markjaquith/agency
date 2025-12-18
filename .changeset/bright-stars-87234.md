---
"@markjaquith/agency": patch
---

Fix task command to prefer remote branches over local branches when creating task branches

Resolves issue where `agency task` would use local `main` branch instead of `origin/main`, causing task branches to be created from outdated code when the local branch fell behind the remote.
