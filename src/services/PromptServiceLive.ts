// Backward compatibility layer
// This file re-exports PromptService.Default as PromptServiceLive
// Once all imports are updated to use PromptService.Default directly, this file can be removed

import { PromptService } from "./PromptService"

export const PromptServiceLive = PromptService.Default
