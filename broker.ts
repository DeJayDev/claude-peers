#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  SendMessageResponse,
  PollMessagesRequest,
  PollMessagesResponse,
  AckMessagesRequest,
  Peer,
  Message,
  Delivery,
  DeliveryHint,
  PeerId,
} from "./shared/types.ts";
import { homedir } from "node:os";

const PORT = parseInt(Bun.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const DB_PATH = Bun.env.CLAUDE_PEERS_DB ?? `${homedir()}/.claude-peers.db`;

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA synchronous = NORMAL");
db.run("PRAGMA busy_timeout = 3000");
db.run("PRAGMA temp_store = MEMORY");
db.run("PRAGMA mmap_size = 134217728");
db.run("PRAGMA foreign_keys = ON");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    summary_updated_at TEXT,
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    last_active_at TEXT,
    last_poll_at TEXT
  )
`);

// Additive migrations for pre-existing dbs — ignore "duplicate column" errors.
function addColumnIfMissing(table: string, column: string, definition: string) {
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (e) {
    if (!(e instanceof Error) || !/duplicate column/i.test(e.message)) throw e;
  }
}
addColumnIfMissing("peers", "summary_updated_at", "TEXT");
addColumnIfMissing("peers", "last_active_at", "TEXT");
addColumnIfMissing("peers", "last_poll_at", "TEXT");

// Migrate pre-CASCADE messages table by dropping it; undelivered messages are ephemeral.
const existingMessagesSchema = db.query(
  "SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'",
).get() as { sql: string } | null;
if (existingMessagesSchema && !existingMessagesSchema.sql.includes("ON DELETE CASCADE")) {
  db.run("DROP TABLE messages");
}

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    acked_at TEXT,
    in_reply_to INTEGER,
    FOREIGN KEY (from_id) REFERENCES peers(id) ON DELETE CASCADE,
    FOREIGN KEY (to_id) REFERENCES peers(id) ON DELETE CASCADE
  )
`);
addColumnIfMissing("messages", "acked_at", "TEXT");
addColumnIfMissing("messages", "in_reply_to", "INTEGER");

db.run("CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(to_id, delivered)");
db.run("CREATE INDEX IF NOT EXISTS idx_peers_pid ON peers(pid)");
db.run("CREATE INDEX IF NOT EXISTS idx_peers_cwd ON peers(cwd)");
db.run("CREATE INDEX IF NOT EXISTS idx_peers_git_root ON peers(git_root)");

// Sentinel peer so CLI-sent messages satisfy the from_id FK.
const bootNow = new Date().toISOString();
db.run(
  `INSERT OR IGNORE INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen)
   VALUES ('cli', 0, '/', NULL, NULL, 'CLI sender', ?, ?)`,
  [bootNow, bootNow],
);

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    if (e?.code === "EPERM") return true;
    if (process.platform === "win32") {
      try {
        const output = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/NH"]).stdout.toString();
        return output.includes(String(pid));
      } catch {
        return true;
      }
    }
    return false;
  }
}

const STALE_TIMEOUT_MS = 60_000;

function cleanStalePeers() {
  const now = Date.now();
  const peers = db.query("SELECT id, pid, last_seen FROM peers").all() as { id: string; pid: number; last_seen: string }[];
  const staleIds: string[] = [];
  for (const peer of peers) {
    const lastSeen = new Date(peer.last_seen).getTime();
    const isHeartbeatStale = now - lastSeen > STALE_TIMEOUT_MS;
    if (!isProcessAlive(peer.pid) && isHeartbeatStale) {
      staleIds.push(peer.id);
    }
  }
  if (staleIds.length === 0) return;
  const placeholders = staleIds.map(() => "?").join(",");
  db.run(`DELETE FROM messages WHERE delivered = 0 AND to_id IN (${placeholders})`, staleIds);
  db.run(`DELETE FROM peers WHERE id IN (${placeholders})`, staleIds);
}

cleanStalePeers();

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, summary_updated_at, registered_at, last_seen, last_active_at, last_poll_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateLastActive = db.prepare(`
  UPDATE peers SET last_active_at = ?, last_seen = ? WHERE id = ?
`);

const updateLastPoll = db.prepare(`
  UPDATE peers SET last_poll_at = ?, last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ?, summary_updated_at = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT * FROM peers
`);

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered, in_reply_to)
  VALUES (?, ?, ?, ?, 0, ?)
`);

const selectUndelivered = db.prepare(`
  SELECT id, from_id, to_id AS "to", text, sent_at, delivered, acked_at, in_reply_to
  FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const selectPeerById = db.prepare(`
  SELECT id, last_active_at, last_poll_at, last_seen FROM peers WHERE id = ?
`);

const markDeliveredScoped = db.prepare(`
  UPDATE messages SET delivered = 1, acked_at = ? WHERE id = ? AND to_id = ?
`);

const selectPeerByPid = db.prepare(`
  SELECT id FROM peers WHERE pid = ?
`);

const countPeers = db.prepare(`
  SELECT COUNT(*) as n FROM peers
`);

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[bytes[i]! % chars.length];
  }
  return id;
}

// --- Activity / delivery hint helpers ---

// Any peer-originated, model-initiated call (send, set_summary, ack, list with exclude_id)
// bumps last_active_at. Poll and heartbeat don't — those are automated.
function bumpActive(peerId: string) {
  const now = new Date().toISOString();
  updateLastActive.run(now, now, peerId);
}

// Classify a peer's likely responsiveness based on recent broker-side activity.
// These are inferences, not guarantees — MCP gives no true delivery receipt.
function hintFor(row: { last_active_at: string | null; last_poll_at: string | null }): DeliveryHint {
  const now = Date.now();
  const pollAt = row.last_poll_at ? new Date(row.last_poll_at).getTime() : 0;
  const activeAt = row.last_active_at ? new Date(row.last_active_at).getTime() : 0;

  // If the peer isn't polling, channel push won't land — they need peer_check.
  // Poll loop runs every 1s, so anything older than ~5s means it's not running.
  if (now - pollAt > 5_000) return "no_channel";

  if (now - activeAt < 15_000) return "responsive";
  if (now - activeAt < 120_000) return "active";
  return "idle";
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();

  // Remove any existing registration for this PID (re-registration)
  const existing = selectPeerByPid.get(body.pid) as { id: string } | null;
  if (existing) {
    deletePeer.run(existing.id);
  }

  const summaryUpdatedAt = body.summary ? now : null;
  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, body.summary, summaryUpdatedAt, now, now);
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  const now = new Date().toISOString();
  updateSummary.run(body.summary, now, body.id);
  bumpActive(body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        // No git root, fall back to directory
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer. Presence of exclude_id also signals this is a
  // model-initiated listing (not a background/sender-side lookup), so count as activity.
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
    bumpActive(body.exclude_id);
  }

  // Hide the 'cli' sentinel row — it's only there to satisfy the from_id FK
  // for CLI-sent messages, not a real peer anyone can message.
  peers = peers.filter((p) => p.id !== "cli");

  const now = Date.now();
  return peers.filter((p) => {
    const lastSeen = new Date(p.last_seen).getTime();
    const isHeartbeatStale = now - lastSeen > STALE_TIMEOUT_MS;

    if (!isProcessAlive(p.pid) && isHeartbeatStale) {
      deletePeer.run(p.id);
      return false;
    }
    return true;
  });
}

function deliverOne(fromId: PeerId, toId: PeerId, text: string, inReplyTo: number | null): Delivery {
  const target = selectPeerById.get(toId) as
    | { id: string; last_active_at: string | null; last_poll_at: string | null; last_seen: string }
    | null;
  if (!target) {
    return { peer_id: toId, ok: false, error: `Peer ${toId} not found` };
  }
  const res = insertMessage.run(fromId, toId, text, new Date().toISOString(), inReplyTo);
  return {
    peer_id: toId,
    ok: true,
    message_id: Number(res.lastInsertRowid),
    hint: hintFor(target),
  };
}

function handleSendMessage(body: SendMessageRequest): SendMessageResponse {
  const targets = Array.isArray(body.to) ? body.to : [body.to];
  if (targets.length === 0) {
    return { ok: false, error: "No recipients specified", deliveries: [] };
  }
  const inReplyTo = body.in_reply_to ?? null;
  const deliveries = targets.map((to) => deliverOne(body.from_id, to, body.text, inReplyTo));

  // Sender originating a send is activity (skip for the 'cli' sentinel).
  if (body.from_id && body.from_id !== "cli") {
    const senderExists = selectPeerById.get(body.from_id);
    if (senderExists) bumpActive(body.from_id);
  }

  const anyOk = deliveries.some((d) => d.ok);
  return { ok: anyOk, deliveries };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];
  // Poll itself doesn't count as model activity — it's a background timer —
  // but does update last_poll_at (channel liveness signal).
  const now = new Date().toISOString();
  updateLastPoll.run(now, now, body.id);
  return { messages };
}

const ackMessagesTxn = db.transaction((ids: number[], peerId: string, at: string) => {
  let count = 0;
  for (const id of ids) {
    count += markDeliveredScoped.run(at, id, peerId).changes;
  }
  return count;
});

function handleAckMessages(body: AckMessagesRequest): { ok: boolean; acked: number } {
  if (body.ids.length === 0) return { ok: true, acked: 0 };
  const at = new Date().toISOString();
  const acked = ackMessagesTxn(body.ids, body.peer_id, at);
  // Ack only fires from inside a tool handler, so it's a solid model-activity signal.
  bumpActive(body.peer_id);
  return { ok: true, acked };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

// --- HTTP Server ---

async function jsonHandler(req: Request, handler: (body: any) => any): Promise<Response> {
  try {
    const body = await req.json();
    return Response.json(handler(body));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  routes: {
    "/health": {
      GET: () => Response.json({ status: "ok", peers: (countPeers.get() as { n: number }).n }),
    },
    "/register": {
      POST: (req) => jsonHandler(req, (body) => handleRegister(body)),
    },
    "/heartbeat": {
      POST: (req) => jsonHandler(req, (body) => { handleHeartbeat(body); return { ok: true }; }),
    },
    "/set-summary": {
      POST: (req) => jsonHandler(req, (body) => { handleSetSummary(body); return { ok: true }; }),
    },
    "/list-peers": {
      POST: (req) => jsonHandler(req, (body) => handleListPeers(body)),
    },
    "/send-message": {
      POST: (req) => jsonHandler(req, (body) => handleSendMessage(body)),
    },
    "/poll-messages": {
      POST: (req) => jsonHandler(req, (body) => handlePollMessages(body)),
    },
    "/ack-messages": {
      POST: (req) => jsonHandler(req, (body) => handleAckMessages(body)),
    },
    "/unregister": {
      POST: (req) => jsonHandler(req, (body) => { handleUnregister(body); return { ok: true }; }),
    },
  },
  fetch() {
    return new Response("claude-peers broker", { status: 200 });
  },
});

console.error(`[claude-peers broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
