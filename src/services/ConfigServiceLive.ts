// Backward compatibility layer
// This file re-exports ConfigService.Default as ConfigServiceLive
// Once all imports are updated to use ConfigService.Default directly, this file can be removed

import { ConfigService } from "./ConfigService"

export const ConfigServiceLive = ConfigService.Default
