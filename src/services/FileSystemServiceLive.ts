// Backward compatibility layer
// This file re-exports FileSystemService.Default as FileSystemServiceLive
// Once all imports are updated to use FileSystemService.Default directly, this file can be removed

import { FileSystemService } from "./FileSystemService"

export const FileSystemServiceLive = FileSystemService.Default
