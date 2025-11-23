// Backward compatibility layer
// This file re-exports GitService.Default as GitServiceLive
// Once all imports are updated to use GitService.Default directly, this file can be removed

import { GitService } from "./GitService"

export const GitServiceLive = GitService.Default
