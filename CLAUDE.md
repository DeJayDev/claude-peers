---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# claude-peers

Peer discovery and messaging MCP channel for Claude Code instances.

## Architecture

- `broker.ts` — Singleton HTTP daemon on localhost:7899 + SQLite. Auto-launched by the MCP server. Tracks per-peer `has_channel` (self-reported) and `checked_in`; `list-peers` only returns checked-in peers.
- `server.ts` — MCP stdio server, one per Claude Code instance. Connects to broker, exposes tools, pushes channel notifications. Tools are gated: only `peer_checkin`/`peer_whoami` until check-in, then the rest (revealed via `tools/list_changed`). Self-detects channel capability from the parent claude's launch flags (`detectChannelOpen`, parent argv) and reports `has_channel` — there is no MCP-protocol signal for it.
- `skills/peer/SKILL.md` — The peer operating manual. Not a filesystem skill: it is read at server startup and served over the wire, as an MCP prompt (`/mcp__claude-peers__peer <role>`) and as a `skill://peer/SKILL.md` resource. Edit the file, restart the server, every peer gets the new rules.
- `shared/types.ts` — Shared TypeScript types for broker API.
- `shared/summarize.ts` — Auto-summary generation via an OpenAI-compatible endpoint (`OPENAI_MODEL`, default gpt-5.4-nano; `OPENAI_BASE_URL`).
- `shared/client.ts` — Client-name check; gates the Claude-CLI-specific relaunch hint.
- `cli.ts` — CLI utility for inspecting broker state.

## MCP protocol notes

SDK 1.29 (protocol 2025-11-25). What we rely on, and how much of it is actually MCP:

- **Standard**: `tools` + `tools.listChanged` (declared, required before `sendToolListChanged`), `instructions` in the initialize result, `isError: true` for tool-execution failures vs. a thrown error for unknown tools (JSON-RPC protocol error), tool `annotations`, stdout reserved for JSON-RPC with all logging on stderr.
- **Not standard**: `claude/channel`. Neither the capability nor `notifications/claude/channel` exists in MCP — it is a Claude Code development feature enabled by `--dangerously-load-development-channels`. We park it in the spec's `experimental` bag; the SDK only lets the notification through because `assertNotificationCapability` no-ops on unknown methods. 2025-11-25 introduced `extensions` as the successor to `experimental`, so move it if Claude Code ever accepts it there.
- **No delivery receipt exists.** A JSON-RPC notification gets no reply, so a successful push only means the bytes reached the transport. Every `DeliveryHint` is an inference from broker-side timestamps, never a guarantee.
- **Channel detection is out-of-band.** No MCP message tells a server the client opened a channel, so `detectChannelOpen` reads the parent's argv. A channel enabled via managed settings is invisible to us.
- **Tool gating assumes the client re-lists on `tools/list_changed`.** A client that caches the initial list never sees `peer_send`/`peer_check`, so it is stuck at check-in. The `CallToolRequest` handler still serves gated tools if called directly.
- `peer_send.to` uses `oneOf`. Legal JSON Schema 2020-12, but the likeliest thing to break on a client that only accepts a narrow schema subset.
- **Skills over the wire.** There is no skills primitive in MCP. Draft SEP-2640 serves them as `skill://` Resources, but no client auto-loads that yet (the Mintlify docs servers use `mintlify://skills/<name>` and rely on their `instructions` telling the model to go read it). So `skills/peer/SKILL.md` is served two ways: as a **prompt**, which Claude Code renders as `/mcp__claude-peers__peer <role>` and injects directly into the conversation — this is the path that actually works — and as a `skill://` **resource** for whatever picks it up later. Roles (`captain` / a peer id / nothing) are a convention carried in the checkin summary's first token, so `peer_list` is the roster and the broker needs no role column.
- **Client lifetime is stdin.** Claude Code closes the stdio pipe on exit without signalling, so the server exits on stdin `close`/`end` as well as SIGINT/SIGTERM. Without that it gets reparented to init and heartbeats to the broker forever (this leaked 21 processes before it was fixed).
- Broker HTTP is unauthenticated on 127.0.0.1: any local process can register, list peers, and read messages.

## Running

```bash
# Start Claude Code with the channel:
claude --dangerously-load-development-channels server:claude-peers

# Or just add to .mcp.json and use as regular MCP (no channel = no push; still must
# peer_checkin, gets peer_send/peer_check but not peer_list, receives via peer_check):
# { "claude-peers": { "command": "bun", "args": ["./server.ts"] } }

# CLI:
bun cli.ts status
bun cli.ts peers
bun cli.ts send <peer-id> <message>
bun cli.ts kill-broker
```

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
