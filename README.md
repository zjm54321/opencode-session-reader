# opencode-session-reader

> Native OpenCode V2 plugin for cross-session discovery, inspection, and context resumption, inspired by OpenAI Codex thread architecture.

[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/opencode-session-reader.svg)](https://www.npmjs.com/package/opencode-session-reader)
[![CI](https://github.com/zjm54321/opencode-session-reader/actions/workflows/ci.yml/badge.svg)](https://github.com/zjm54321/opencode-session-reader/actions/workflows/ci.yml)

---

## 📖 Table of Contents

- [Why This Was Designed](#-why-this-was-designed)
- [Architecture & Design Philosophy](#-architecture--design-philosophy)
- [Tools Exposed to Agents](#-tools-exposed-to-agents)
  - [`session_list`](#1-session_list)
  - [`session_read`](#2-session_read)
  - [`session_diff`](#3-session_diff)
- [Installation & Setup](#-installation--setup)
- [Development & Verification](#-development--verification)
- [License](#-license)

---

## 💡 Why This Was Designed

In complex coding workflows, work is rarely completed in a single uninterrupted session. Users frequently need to:
1. **Resume unfinished work**: Continue implementing a task from a prior session.
2. **Reference past decisions**: Verify architectural choices, bug analyses, or discussion records from earlier sessions.
3. **Branch explorations**: Start a fresh attempt while borrowing findings from an existing session.

### The "Context Flood" Problem

Traditional attempts at cross-session resumption usually take one of two flawed extremes:

- **Extreme A: The Naive Full Dump**  
  Feeding entire raw message logs into the new session. Because coding sessions accumulate massive tool outputs (compiler errors, raw test runs, file reads, mega diffs), a single session can easily exceed 100,000+ tokens. Dumping it verbatim immediately overflows the context window, multiplies inference costs, slows down responses, and triggers model confusion (*Lost in the Middle*).
- **Extreme B: The Naive Slice ("Last 5 Messages")**  
  Blindly truncating to the last few messages. This loses the original user requirements, the motivation behind earlier decisions, and what files were touched.

`opencode-session-reader` bridges this gap with a **progressive-disclosure, context-protective architecture** built natively on top of OpenCode V2.

---

## 🏛 Architecture & Design Philosophy

The architecture of `opencode-session-reader` draws directly from deep reverse-engineering of **OpenAI Codex's thread-management system**:

```
+---------------------------------------------------------------------------------+
|                       OpenCode Agent / LLM Workspace                            |
+---------------------------------------------------------------------------------+
                         |                                 |
         1. 轻量发现 (Lightweight Discovery)       2. 渐进切片 (Progressive Slices)
                         v                                 v
                 [ session_list ]                   [ session_read ]
                         |                                 |
                         |               +-----------------+-----------------+
                         |               |                                   |
                         |               v                                   v
                         |         mode="summary"                     mode="slice"
                         |      (Active Context Only)             (Cursor Pagination)
                         |               |                                   |
                         +---------------+-----------------+                 |
                                                           |                 |
                                                           v                 v
+---------------------------------------------------------------------------------+
|                       Local Dehydration Engine (Rule-Based)                     |
|  - Drops raw tool stdouts/stderrs; keeps `[Tool: name (status)]`               |
|  - Preserves exact user prompts & assistant reasoning/conclusions               |
|  - Truncates individual verbose text blocks (>1500 chars)                       |
|  - ZERO LLM overhead, zero hallucinations, zero extra token cost                |
+---------------------------------------------------------------------------------+
                                       |
                                       v
+---------------------------------------------------------------------------------+
|                     OpenCode V2 Backend (HTTP/REST API)                         |
|   /api/session (list) | /api/session/:id/message | /api/session/:id/diff        |
+---------------------------------------------------------------------------------+
```

### 1. Decoupled Metadata Indexing
Like Codex's `thread/list`, session discovery is decoupled from session content. Calling `session_list` queries OpenCode's relational session database and returns only lightweight metadata (session ID, title, directory, token usage, last update timestamp). No conversation bodies are preloaded.

### 2. "Full-History Hydration is Deprecated"
In Codex's official protocol definitions, full-history hydration is explicitly flagged as deprecated for long threads. `opencode-session-reader` adopts this rule: agents are provided tools to inspect **summaries**, **recent turns**, or **cursor-paginated slices**, preventing context bloat by design.

### 3. Zero-LLM Overhead Rule-Based Dehydration
Instead of paying for expensive, hallucination-prone secondary LLM calls to "summarize" old sessions, `opencode-session-reader` uses a **deterministic, rule-based local dehydrator**:
- **Tool Outputs**: Replaced with clean badges `[Tool: <name> (<status>)]` plus short error snippets if failed. Raw megabyte logs are discarded.
- **User Prompts**: Preserved verbatim to keep intent and constraints exact.
- **Assistant Conclusions**: Formatted cleanly and bounded with safe character thresholds.
- **Compaction Nodes**: If the original session was compacted by OpenCode's `/compact`, the plugin seamlessly inherits and displays the system compaction summary.

### 4. Two-Tier Cursor-Based Pagination
Supports OpenCode's native opaque pagination cursors (`cursor.next` / `cursor.previous`). Sorting and pagination parameters are cleanly isolated to ensure zero-conflict pagination across historical sessions.

---

## 🛠 Tools Exposed to Agents

When this plugin is loaded, OpenCode automatically injects the following three tools into the agent's catalog:

### 1. `session_list`

Discover and filter historical OpenCode sessions across projects or within the current workspace.

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `search` | `string` | `undefined` | Substring keyword to search within session titles. |
| `directory` | `string` | Current workspace | Explicit workspace directory to filter sessions. |
| `all` | `boolean` | `false` | When `true`, searches sessions across all projects on this machine. |
| `limit` | `number` | `20` | Max sessions to return per page (1–100). |
| `order` | `"asc" \| "desc"` | `"desc"` | Sort by update time (newest first by default). |
| `cursor` | `string` | `undefined` | Opaque pagination cursor for next/previous pages. |

**Example Agent Usage:**
```json
{
  "search": "database migration",
  "limit": 10
}
```

---

### 2. `session_read`

Read compact session turns with automatic dehydration and context protection.

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `sessionID` | `string` | **Required** | The target session ID (e.g. `ses_xxxx`). |
| `mode` | `"summary" \| "recent" \| "slice" \| "diff"` | `"summary"` | Reading mode (see below). |
| `limit` | `number` | Mode default | Maximum messages / turns to retrieve. |
| `cursor` | `string` | `undefined` | Pagination cursor returned from a previous read. |
| `order` | `"asc" \| "desc"` | Mode default | Chronological (`asc`) or reverse (`desc`) ordering. |
| `type` | `string` | `undefined` | Optional message type filter (e.g. `user`, `assistant`). |

**Modes Explained:**
- **`summary` (Default)**: Fetches the active working context of the session (after the latest compaction), dehydrates tool output, and returns prompt-led turns.
- **`recent`**: Retrieves the newest conversational turns in chronological order.
- **`slice`**: Pages through historical messages using pagination cursors without flooding memory.
- **`diff`**: Quick shorthand to inspect file changes created during the session.

---

### 3. `session_diff`

Inspect file diffs and patches produced in a session without reading chat text.

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `sessionID` | `string` | **Required** | Target session ID. |
| `file` | `string` | `undefined` | Optional single file path filter. |

---

## 📦 Installation & Setup

### Option 1: Via npm (Recommended)

Add `opencode-session-reader` to your global or project `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-session-reader@0.1.0"
  ]
}
```

### Option 2: Local Development Link

Clone the repository and build the distribution:

```bash
git clone https://github.com/zjm54321/opencode-session-reader.git
cd opencode-session-reader
bun install
bun run build
```

Then reference the built output directory in `opencode.json`:

```json
{
  "plugins": [
    "file:///path/to/opencode-session-reader/dist"
  ]
}
```

---

## 🧪 Development & Verification

This project is built using [Bun](https://bun.sh) and [Nix Flakes](https://nixos.org).

```bash
# 1. Enter the reproducible Nix environment
nix develop

# 2. Install dependencies
bun install

# 3. Run unit and integration tests (17 tests)
bun test

# 4. Strict TypeScript typechecking
bun run typecheck

# 5. Build distribution bundle
bun run build
```

### Automated Tests Overview

- `tests/dehydrate.test.ts`: Verifies rule-based dehydration, prompt preservation, tool badge collapsing, and long-text truncation.
- `tests/client.test.ts`: Verifies API parameter encoding, credential loading, timeout guards, and error formatting.
- `tests/integration.test.ts`: Live integration against a running OpenCode daemon verifying `session_list`, `session_read`, `session_diff`, and cursor continuation.

---

## 📄 License

This project is licensed under the **GNU General Public License v3.0 or later** ([GPL-3.0-or-later](LICENSE)).
