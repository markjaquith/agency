// Backward compatibility layer
// This file re-exports TemplateService.Default as TemplateServiceLive
// Once all imports are updated to use TemplateService.Default directly, this file can be removed

import { TemplateService } from "./TemplateService"

export const TemplateServiceLive = TemplateService.Default
