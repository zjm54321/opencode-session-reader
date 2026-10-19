# opencode-session-reader

Native OpenCode V2 plugin for cross-session discovery, inspection, and context resumption, inspired by Codex thread architecture.

## Overview

In long-running or modular AI-assisted workflows, continuing from or referencing prior sessions is critical. However, blindly loading complete conversation histories floods the model's context window with megabytes of obsolete tool outputs, compilation logs, and raw diffs.

`opencode-session-reader` solves this by introducing a **context-protective, progressive disclosure** pattern modeled after OpenAI Codex's thread-reading architecture:
- **`session_list`**: Search and list historical sessions across workspaces or within the current directory using compact metadata and cursor pagination.
- **`session_read`**: Dehydrates raw tool payloads into lightweight badges `[Tool: <name> (<status>)]`, preserving prompt-led turns and assistant conclusions while keeping the context window lean.
- **`session_diff`**: Reads file changes and before/after patches produced in a session without loading conversational noise.

## Tools Exposed to Agents

### 1. `session_list`
Discover sessions with title search, directory scoping, and opaque pagination cursors.

```typescript
session_list({
  search?: string,     // Substring search in session title
  all?: boolean,       // Search across all directories (defaults to current directory)
  directory?: string, // Explicit directory filter
  limit?: number,     // Max sessions to return (1-100, default 20)
  order?: "asc" | "desc", // Order by update time (default "desc")
  cursor?: string     // Opaque cursor for next page
})
```

### 2. `session_read`
Read compact session turns without raw tool payloads.

```typescript
session_read({
  sessionID: string,  // Target session ID (e.g. ses_xxxx)
  mode?: "summary" | "recent" | "slice" | "diff", // Read mode (default "summary")
  limit?: number,     // Max messages/turns to retrieve
  cursor?: string,    // Opaque cursor for pagination
  order?: "asc" | "desc",
  type?: string       // Optional filter by message type
})
```

- **`summary`** (default): Reads active context after the last compaction (up to `limit`, default 12) with full dehydration.
- **`recent`**: Reads the newest messages in chronological order.
- **`slice`**: Pages messages in requested order using cursors.
- **`diff`**: Shortcut to inspect session file modifications.

### 3. `session_diff`
Inspect file modifications produced during a session.

```typescript
session_diff({
  sessionID: string,
  file?: string       // Optional single file filter
})
```

## Installation & Configuration

### Via npm (Recommended)
Add to your OpenCode configuration (`opencode.json`):

```json
{
  "plugins": [
    "opencode-session-reader@0.1.0"
  ]
}
```

### Via Local Path (Development)
You can link the built output directly:

```json
{
  "plugins": [
    "file:///home/ming/opencode-session-reader/dist"
  ]
}
```

## Development

This repository includes a Nix Flake for reproducible development:

```bash
# Enter development shell
nix develop

# Install dependencies
bun install

# Run tests
bun test

# Typecheck and build
bun run typecheck
bun run build
```

## License

GPL-3.0-or-later
