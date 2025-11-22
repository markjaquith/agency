This is a monster task. I'd like to update this repo to use Effect TS throughout.

## Overview

The goal is to migrate the entire `agency` CLI codebase to use Effect TS for:

- **Type-safe error handling**: Replace try/catch with Effect's typed error channels
- **Schema validation**: Use @effect/schema for runtime validation of JSON data
- **Service layers**: Create composable services for git operations, file I/O, prompts, etc.
- **Dependency injection**: Use Effect's context system for testability
- **Better composition**: Use Effect's pipe and composition operators

## Current Architecture

The codebase follows these patterns:

- **Commands**: Individual command files in `src/commands/` that export async functions
- **Utils**: Utility modules for git, prompts, templates, colors
- **Types**: TypeScript interfaces for data structures with manual validation
- **Error handling**: Throw/catch with custom Error classes
- **CLI runner**: `cli.ts` parses args and runs commands with try/catch error handling

## Target Architecture with Effect

1. **Service Layers**:
   - `GitService`: All git operations (getCurrentBranch, createBranch, etc.)
   - `FileSystemService`: File I/O operations
   - `ConfigService`: Loading/saving configuration
   - `PromptService`: User prompts and interactions
   - `TemplateService`: Template management

2. **Schema Definitions**:
   - Replace manual validation with @effect/schema
   - Define schemas for AgencyMetadata, ManagedFile, AgencyConfig, etc.
   - Use Schema.decodeUnknown for parsing JSON

3. **Error Types**:
   - Define tagged error types for each service
   - Replace thrown errors with Effect.fail
   - Use Effect.catchTag for specific error handling

4. **Commands as Effect Programs**:
   - Each command returns an Effect that depends on services
   - Use Effect.gen for async/await-like syntax
   - Compose effects with pipe and combinators

5. **CLI Runner**:
   - Provide service implementations
   - Run Effect programs with Effect.runPromise
   - Handle errors at the top level

## Migration Strategy

Phase 1: Setup & Core Services

- Install dependencies
- Create service definitions
- Migrate git utilities to GitService

Phase 2: Data & Validation

- Define schemas with @effect/schema
- Migrate type validation
- Update config loading

Phase 3: Commands

- Migrate commands one by one
- Update tests as we go
- Ensure backwards compatibility

Phase 4: Testing & Cleanup

- Run full test suite
- Update documentation
- Clean up old patterns

## Progress Update

Successfully set up the foundation for Effect TS migration:

- ✅ Installed Effect and @effect/schema dependencies
- ✅ Analyzed codebase patterns and identified migration strategy
- ✅ Created GitService interface using latest Effect.Service pattern
- ✅ Implemented GitServiceLive with full error handling
- ✅ All 159 tests still passing

## Tasks

### Phase 1: Setup & Core Services

- [x] Install Effect dependencies (@effect/schema, effect)
- [x] Study codebase patterns and identify Effect migration opportunities
- [x] Create Effect service layers for git operations
- [ ] Migrate src/utils/git.ts to Effect with proper error handling

### Phase 2: Data & Validation

- [ ] Create Effect Schema definitions for types (AgencyMetadata, ManagedFile, etc)
- [ ] Migrate config.ts to use Effect for file I/O and error handling
- [ ] Convert types.ts to use Effect Schema for validation

### Phase 3: Utilities

- [ ] Migrate template utility functions to Effect
- [ ] Migrate prompt utilities to Effect

### Phase 4: Commands

- [ ] Migrate command files (task.ts, pr.ts, etc) to Effect
- [ ] Update CLI runner (cli.ts) to handle Effect programs

### Phase 5: Testing & Documentation

- [ ] Migrate all test files to work with Effect
- [ ] Update documentation to reflect Effect patterns
- [ ] Run all tests to ensure migration is successful
