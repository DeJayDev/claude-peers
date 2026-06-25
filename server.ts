#!/usr/bin/env bun
/**
 * claude-peers MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to the shared broker daemon for peer discovery and messaging.
 * Declares claude/channel capability to push inbound messages immediately.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:claude-peers
 *
 * With .mcp.json:
 *   { "claude-peers": { "command": "bun", "args": ["./server.ts"] } }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  PeerId,
  Peer,
  RegisterResponse,
  PollMessagesResponse,
  Message,
  SendMessageResponse,
} from "./shared/types.ts";
import {
  generateSummary,
  getGitBranch,
  getRecentFiles,
  SUMMARY_MODEL,
} from "./shared/summarize.ts";
import { homedir } from "node:os";

// --- Configuration ---

const BROKER_PORT = parseInt(Bun.env.CLAUDE_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const BROKER_SCRIPT = Bun.fileURLToPath(new URL("./broker.ts", import.meta.url));
const BROKER_LOG = `${homedir()}/.claude-peers-broker.log`;

// --- Broker communication ---

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBroker(): Promise<void> {
  if (await isBrokerAlive()) {
    log("Broker already running");
    return;
  }

  log(`Starting broker daemon (log: ${BROKER_LOG})...`);
  const proc = Bun.spawn([process.execPath, BROKER_SCRIPT], {
    // Redirect stderr to a log file instead of inheriting — inheriting causes
    // SIGPIPE to kill the broker when Claude Code closes the MCP server's pipe.
    stdio: ["ignore", "ignore", Bun.file(BROKER_LOG)],
  });

  // Unref so this process can exit without waiting for the broker
  proc.unref();

  // Wait for it to come up
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(200);
    if (await isBrokerAlive()) {
      log("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker daemon after 6 seconds");
}

// --- Utility ---

function log(msg: string) {
  // MCP stdio servers must only use stderr for logging (stdout is the MCP protocol)
  console.error(`[claude-peers] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const result = await Bun.$`git -C ${cwd} rev-parse --show-toplevel`.quiet().nothrow();
    if (result.exitCode === 0) {
      return result.text().trim();
    }
  } catch {}
  return null;
}

// The channel is enabled by a CLI flag on the parent claude that names this server,
// e.g. `claude --dangerously-load-development-channels server:claude-peers`. The client
// never tells the server it opened a channel (confirmed against the claude binary), so
// we read the launch contract directly: our parent's argv. Catches CLI-flag channels
// only (the way channels are launched for this project); a channel enabled purely via
// managed settings is invisible here.
const CHANNEL_NAME = "claude-peers"; // must match the .mcp.json / channel-spec key
const RELAUNCH_HINT = `relaunch with: claude --dangerously-load-development-channels server:${CHANNEL_NAME}`;

function detectChannelOpen(): boolean {
  if (process.platform === "win32") return false; // no ps; add a tasklist/wmic branch if needed
  const ppid = process.ppid;
  if (!ppid) return false;
  try {
    const argv = Bun.spawnSync(["ps", "-ww", "-o", "command=", "-p", String(ppid)]).stdout.toString();
    const hasFlag = /--(channels|dangerously-load-development-channels)/.test(argv);
    const namesMe = new RegExp(`server:${CHANNEL_NAME}(\\s|,|$)`).test(argv);
    return hasFlag && namesMe;
  } catch {
    return false;
  }
}

function getTty(): string | null {
  if (process.platform === "win32") return null;
  try {
    const ppid = process.ppid;
    if (ppid) {
      const tty = Bun.spawnSync(["ps", "-o", "tty=", "-p", String(ppid)]).stdout.toString().trim();
      if (tty && tty !== "?" && tty !== "??") {
        return tty;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

// --- State ---

let myId: PeerId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;
let clientInitialized = false;
let inboundPollingStarted = false;
let pollActive = false;
let myHasChannel = detectChannelOpen(); // self-detected from parent argv at load
let checkedIn = false; // flipped once peer_checkin succeeds

async function ensureRegistered(): Promise<boolean> {
  if (myId) {
    try {
      const peers = await brokerFetch<Peer[]>("/list-peers", {
        scope: "machine",
        cwd: myCwd,
        git_root: myGitRoot,
      });
      if (peers.some((p) => p.id === myId)) return true;
    } catch {
      return false;
    }
  }
  try {
    log("Auto-registering with broker...");
    const reg = await brokerFetch<RegisterResponse>("/register", {
      pid: process.pid,
      cwd: myCwd,
      git_root: myGitRoot,
      tty: getTty(),
      summary: "",
      has_channel: myHasChannel,
    });
    myId = reg.id;
    log(`Auto-registered as peer ${myId}`);
    return true;
  } catch (e) {
    log(`Auto-registration failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

const localMessageBuffer: Message[] = [];
const localBufferIds = new Set<number>();

const surfacedMessageTexts = new Map<string, string>();

function formatMessageLine(m: Message): string {
  const thread = m.in_reply_to ? ` (reply to #${m.in_reply_to})` : "";
  return `From ${m.from_id} at ${m.sent_at}${thread}:\n${m.text}`;
}

function messageDedupKey(m: Message): string {
  return `${m.from_id}:${m.id}`;
}

function hasSurfacedMessage(m: Message): boolean {
  const key = messageDedupKey(m);
  const previousText = surfacedMessageTexts.get(key);
  if (previousText === undefined) return false;
  if (previousText !== m.text) {
    log(`WARNING: Message ${key} repeated with different body; surfacing as new message`);
    return false;
  }
  return true;
}

function markMessagesSurfaced(messages: Message[]) {
  for (const message of messages) {
    surfacedMessageTexts.set(messageDedupKey(message), message.text);
  }
}

function removeLocalBufferedMessages(messages: Message[]) {
  const ids = new Set(messages.map((message) => message.id));
  for (const id of ids) {
    localBufferIds.delete(id);
  }
  for (let i = localMessageBuffer.length - 1; i >= 0; i--) {
    if (ids.has(localMessageBuffer[i]!.id)) {
      localMessageBuffer.splice(i, 1);
    }
  }
}

async function drainPendingMessages(): Promise<string | null> {
  if (!myId) return null;
  const buffered = localMessageBuffer.splice(0, localMessageBuffer.length);
  localBufferIds.clear();
  const unseen = buffered.filter((m) => !hasSurfacedMessage(m));
  if (unseen.length === 0) return null;

  const ids = unseen.map((m) => m.id);
  try {
    await brokerFetch("/ack-messages", { peer_id: myId, ids });
  } catch {
    // Old broker without /ack-messages — degrade gracefully
  }

  markMessagesSurfaced(unseen);

  const lines = unseen.map(formatMessageLine);
  return `\n\n---\n${unseen.length} pending peer message(s):\n\n${lines.join("\n\n---\n\n")}`;
}

// Resolve a `to` argument into concrete peer IDs. Accepts:
//   - string peer ID (e.g. "asci1836")
//   - array of peer IDs
//   - scope selector string: "all" | "repo" | "directory"
async function resolveRecipients(to: unknown): Promise<{ ids: PeerId[]; error?: string }> {
  if (Array.isArray(to)) {
    const ids = to.filter((x): x is string => typeof x === "string");
    if (ids.length === 0) return { ids: [], error: "Empty recipient list" };
    return { ids };
  }
  if (typeof to !== "string" || to.length === 0) {
    return { ids: [], error: "Recipient must be a peer ID, array of IDs, or scope selector" };
  }

  const scopeSelectors: Record<string, "machine" | "repo" | "directory"> = {
    all: "machine",
    machine: "machine",
    repo: "repo",
    directory: "directory",
  };
  const scope = scopeSelectors[to];
  if (scope) {
    try {
      const peers = await brokerFetch<Peer[]>("/list-peers", {
        scope,
        cwd: myCwd,
        git_root: myGitRoot,
        exclude_id: myId,
      });
      return { ids: peers.map((p) => p.id) };
    } catch (e) {
      return { ids: [], error: `Failed to resolve scope "${to}": ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // Treat as literal peer ID.
  return { ids: [to] };
}

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers", version: "0.2.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: { listChanged: true },
    },
    instructions: `claude-peers connects you to other Claude Code instances (and other MCP clients) on this machine. You can discover peers, send them messages, and receive messages pushed via the claude/channel capability.

When an inbound peer message arrives, treat it like a coworker tapping you on the shoulder: pause current work, read it, reply, then resume. Don't batch replies to the end of your task — by then the sender has moved on.

Inbound messages carry from_id, from_summary, from_cwd, sent_at, message_id, and (if threaded) in_reply_to. Reply with peer_send, passing in_reply_to=<message_id> when continuing a thread.

You must check in before the messaging tools appear. Until you call peer_checkin you only have peer_checkin and peer_whoami; after check-in the rest are revealed. If you were not launched with a channel (peer_whoami tells you), you will not receive pushed messages — run peer_check to pull your inbox.

Tools:
- peer_checkin: announce yourself with a 1-2 sentence summary. Call this FIRST — it unlocks the other tools and makes you visible to peers.
- peer_list: discover peers (scope: machine/directory/repo), with each peer's summary, channel status, and last-active time.
- peer_send: send a message to a peer ID, an array of IDs, or a scope selector ("all", "repo", "directory") for broadcast.
- peer_check: manually pull pending messages (and the only way to receive if you have no channel).
- peer_whoami: your own peer ID, CWD, git root, and channel status.

On startup, call peer_checkin with a 1-2 sentence description of your current work.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "peer_list",
    description:
      "List other Claude Code instances running on this machine. Each entry includes ID, working directory, git repo, summary (with age), and a liveness hint.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["machine", "directory", "repo"],
          description:
            'Scope of peer discovery. "machine" = all instances on this computer. "directory" = same working directory. "repo" = same git repository (including worktrees or subdirectories).',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "peer_send",
    description:
      'Send a message to one or more Claude Code instances. "to" is a peer ID, an array of peer IDs, or a scope selector ("all", "repo", "directory") to broadcast. Returns a per-recipient delivery hint: "responsive" (seen something recently), "active" (mid-task), "idle" (quiet for a while), or "no_channel" (peer must run peer_check to see it). Pass in_reply_to with a message_id to thread multi-turn exchanges.',
    inputSchema: {
      type: "object" as const,
      properties: {
        to: {
          oneOf: [
            { type: "string" as const },
            { type: "array" as const, items: { type: "string" as const } },
          ],
          description:
            'Recipient(s): a peer ID from peer_list, an array of peer IDs, or a scope selector string ("all", "repo", "directory").',
        },
        message: {
          type: "string" as const,
          description: "The message to send",
        },
        in_reply_to: {
          type: "number" as const,
          description: "Optional: message_id of the message you're replying to, for threading.",
        },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "peer_checkin",
    description:
      "Announce yourself to the peer network. Call this FIRST: until you check in you are invisible to other peers and cannot list or message them. Pass a 1-2 sentence summary of your current work (shown to others via peer_list). Re-call anytime to update your summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string" as const,
          description: "A 1-2 sentence summary of your current work",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "peer_check",
    description:
      "Manually check for new messages from other Claude Code instances. Messages normally arrive via channel push, but this is a reliable fallback.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "peer_whoami",
    description:
      "Returns this Claude Code instance's own peer ID, working directory, and git root. Useful for telling other peers how to message you.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
];

// --- Tool handlers ---

// Which tools the connected client can see right now. Two gates stack:
//   1. announce gate — nothing but peer_checkin/peer_whoami until you check in.
//   2. channel gate — peer_list (discovery) is channel-only; a no-channel instance
//      can still send/check (reply to known senders), it just doesn't get pushed
//      replies. peer_whoami tells it how to enable a real channel.
function visibleToolNames(): Set<string> {
  const names = new Set(["peer_checkin", "peer_whoami"]);
  if (!checkedIn) return names;
  names.add("peer_send");
  names.add("peer_check");
  if (myHasChannel) names.add("peer_list");
  return names;
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  const visible = visibleToolNames();
  return { tools: TOOLS.filter((t) => visible.has(t.name)) };
});

function formatPeerEntry(p: Peer): string {
  const parts = [
    `ID: ${p.id}`,
    `PID: ${p.pid}`,
    `CWD: ${p.cwd}`,
  ];
  if (p.git_root) parts.push(`Repo: ${p.git_root}`);
  if (p.tty) parts.push(`TTY: ${p.tty}`);
  if (p.summary) {
    const age = p.summary_updated_at ? ` (set ${relTime(p.summary_updated_at)})` : "";
    parts.push(`Summary: ${p.summary}${age}`);
  } else {
    parts.push(`Summary: (none)`);
  }

  // Channel capability (self-reported) plus recent model activity. A poll-only peer has
  // no channel at all — it only sees messages when it runs peer_check.
  const channel = p.has_channel ? "open" : "poll-only (tell it to run peer_check)";
  parts.push(`Activity: last tool call ${relTime(p.last_active_at)}; channel: ${channel}`);

  return parts.join("\n  ");
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "peer_list": {
      const scope = (args as { scope: string }).scope as "machine" | "directory" | "repo";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: myId,
        });

        const pending = await drainPendingMessages();

        if (peers.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No other Claude Code instances found (scope: ${scope}).${pending ?? ""}`,
              },
            ],
          };
        }

        const lines = peers.map(formatPeerEntry);

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}${pending ?? ""}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "peer_send": {
      const { to, message, in_reply_to } = args as {
        to: unknown;
        message: string;
        in_reply_to?: number;
      };
      if (!myId) {
        const ok = await ensureRegistered();
        if (!ok || !myId) {
          return {
            content: [{ type: "text" as const, text: "Not registered with broker and auto-registration failed" }],
            isError: true,
          };
        }
      }

      const { ids, error: resolveError } = await resolveRecipients(to);
      if (resolveError) {
        return {
          content: [{ type: "text" as const, text: `Failed to resolve recipients: ${resolveError}` }],
          isError: true,
        };
      }
      if (ids.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No matching peers for the given selector." }],
        };
      }

      try {
        const result = await brokerFetch<SendMessageResponse>("/send-message", {
          from_id: myId,
          to: ids,
          text: message,
          in_reply_to,
        });
        const pending = await drainPendingMessages();

        const failed = result.deliveries.filter((d) => !d.ok);
        let text: string;
        if (ids.length === 1) {
          const d = result.deliveries[0]!;
          text = d.ok ? `Sent.` : `Failed: ${d.error ?? "unknown"}`;
        } else {
          const okCount = result.deliveries.length - failed.length;
          const failLines = failed.map((d) => `  ${d.peer_id}: ${d.error ?? "unknown"}`);
          text =
            failed.length === 0
              ? `Sent to ${okCount} peer(s).`
              : `Sent to ${okCount}/${ids.length} peer(s). Failed:\n${failLines.join("\n")}`;
        }

        // Poll-only recipients won't be auto-notified — nudge the sender to tell them.
        const pollOnly = result.deliveries.filter((d) => d.ok && d.target_has_channel === false).map((d) => d.peer_id);
        const pollNudge =
          pollOnly.length > 0
            ? `\nPoll-only peer(s) (no channel): ${pollOnly.join(", ")}. They won't be auto-notified — ask them in your message to run peer_check.`
            : "";

        return {
          content: [{ type: "text" as const, text: `${text}${pollNudge}${pending ?? ""}` }],
          isError: !result.ok,
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error sending message: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "peer_checkin": {
      const { summary } = args as { summary: string };
      if (!myId) {
        const ok = await ensureRegistered();
        if (!ok || !myId) {
          return {
            content: [{ type: "text" as const, text: "Not registered with broker and auto-registration failed" }],
            isError: true,
          };
        }
      }
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        const firstCheckin = !checkedIn;
        checkedIn = true;
        // Reveal the now-available peer tools (peer_list/peer_send/peer_check or the
        // no-channel subset) to the client.
        if (firstCheckin) mcp.sendToolListChanged();

        const nudge = myHasChannel
          ? ""
          : `\nNote: you have no channel — peers cannot push messages to you. Run peer_check to pull your inbox. For live delivery, ${RELAUNCH_HINT}`;
        const pending = await drainPendingMessages();
        return {
          content: [{ type: "text" as const, text: `Checked in. You are ${myId}.${nudge}${pending ?? ""}` }],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "peer_check": {
      if (!myId) {
        const ok = await ensureRegistered();
        if (!ok || !myId) {
          return {
            content: [{ type: "text" as const, text: "Not registered with broker and auto-registration failed" }],
            isError: true,
          };
        }
      }
      try {
        // Drain local buffer (messages polled by the poll loop)
        const buffered = localMessageBuffer.splice(0, localMessageBuffer.length);
        localBufferIds.clear();

        // Also check broker directly for anything poll loop hasn't grabbed
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

        // Merge and deduplicate before rendering into the tool result.
        const seen = new Set<string>();
        const allMessages: Message[] = [];
        for (const m of [...buffered, ...result.messages]) {
          const key = messageDedupKey(m);
          if (seen.has(key)) continue;
          if (hasSurfacedMessage(m)) continue;

          seen.add(key);
          allMessages.push(m);
        }

        if (allMessages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No new messages." }],
          };
        }

        // Explicitly ack all messages we're returning
        const ids = allMessages.map((m) => m.id);
        try {
          await brokerFetch("/ack-messages", { peer_id: myId, ids });
        } catch {
          // Old broker — degrade gracefully
        }

        markMessagesSurfaced(allMessages);

        const lines = allMessages.map(formatMessageLine);
        return {
          content: [
            {
              type: "text" as const,
              text: `${allMessages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "peer_whoami": {
      const channelLine = myHasChannel
        ? "Channel: open (you receive pushed messages live)"
        : `Channel: none (you will NOT be auto-notified; run peer_check to pull). To enable live delivery, ${RELAUNCH_HINT}`;
      return {
        content: [
          {
            type: "text" as const,
            text: `Peer ID: ${myId ?? "(not registered)"}\nCWD: ${myCwd}\nGit root: ${myGitRoot ?? "(none)"}\n${channelLine}`,
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Polling loop for inbound messages ---

async function pollAndPushMessages() {
  if (!myId) {
    await ensureRegistered();
    if (!myId) return;
  }

  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });

    const newMessages: Message[] = [];
    for (const msg of result.messages) {
      if (hasSurfacedMessage(msg)) continue;
      if (localBufferIds.has(msg.id)) continue;

      localMessageBuffer.push(msg);
      localBufferIds.add(msg.id);
      newMessages.push(msg);
    }

    if (newMessages.length === 0) return;

    let peerCache: Peer[] | null = null;
    try {
      peerCache = await brokerFetch<Peer[]>("/list-peers", {
        scope: "machine",
        cwd: myCwd,
        git_root: myGitRoot,
      });
    } catch {
      // Non-critical — channel push proceeds without sender context
    }

    const transcriptVisibleMessages: Message[] = [];
    for (const msg of newMessages) {
      try {
        const sender = peerCache?.find((p) => p.id === msg.from_id);
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: msg.text,
            meta: {
              from_id: msg.from_id,
              from_summary: sender?.summary ?? "",
              from_cwd: sender?.cwd ?? "",
              sent_at: msg.sent_at,
              message_id: String(msg.id),
              in_reply_to: msg.in_reply_to != null ? String(msg.in_reply_to) : "",
            },
          },
        });
        log(`Channel push succeeded for message ${msg.id} from ${msg.from_id}`);
        if (myHasChannel) {
          transcriptVisibleMessages.push(msg);
        }
      } catch (e) {
        log(`Channel push failed for ${msg.from_id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (transcriptVisibleMessages.length > 0 && myId) {
      markMessagesSurfaced(transcriptVisibleMessages);
      removeLocalBufferedMessages(transcriptVisibleMessages);
      const ids = transcriptVisibleMessages.map((m) => m.id);
      try {
        await brokerFetch("/ack-messages", { peer_id: myId, ids });
      } catch (e) {
        log(`Channel-push ack failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function startInboundMessagePolling() {
  if (inboundPollingStarted) {
    return;
  }
  if (!myId) {
    return;
  }

  const clientVersion = mcp.getClientVersion();
  const clientName = clientVersion?.name ?? "unknown";
  const clientVersionText = clientVersion?.version ? ` ${clientVersion.version}` : "";

  log(`Client connected: ${clientName}${clientVersionText}`);
  // Real signal: our parent's launch flag, not the client name. A channel push only
  // surfaces to the transcript if we were launched as a channel for this client.
  log(`Channel pushes ${myHasChannel ? "surface to transcript" : "require tool-surface fallback"}`);

  pollActive = true;
  inboundPollingStarted = true;

  async function schedulePoll() {
    if (!pollActive) return;
    await pollAndPushMessages();
    if (pollActive) setTimeout(schedulePoll, POLL_INTERVAL_MS);
  }

  setTimeout(schedulePoll, POLL_INTERVAL_MS);
  log("Background polling enabled.");
}

// --- Startup ---

async function main() {
  // 1. Connect MCP over stdio FIRST — Claude Code needs the handshake before anything else
  mcp.oninitialized = () => {
    clientInitialized = true;
    startInboundMessagePolling();
  };

  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // 2. Ensure broker is running (now safe to take time — MCP handshake is done)
  await ensureBroker();

  // 3. Gather context
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);
  log(`TTY: ${tty ?? "(unknown)"}`);

  // 4. Generate initial summary via SUMMARY_MODEL (non-blocking, best-effort)
  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      const branch = await getGitBranch(myCwd);
      const recentFiles = await getRecentFiles(myCwd);
      const summary = await generateSummary({
        cwd: myCwd,
        git_root: myGitRoot,
        git_branch: branch,
        recent_files: recentFiles,
      });
      if (summary) {
        initialSummary = summary;
        log(`Auto-summary: ${summary}`);
      }
    } catch (e) {
      log(`Auto-summary failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  // Wait briefly for summary, but don't block startup
  await Promise.race([summaryPromise, Bun.sleep(3000)]);

  // 5. Register with broker
  const reg = await brokerFetch<RegisterResponse>("/register", {
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
    has_channel: myHasChannel,
  });
  myId = reg.id;
  log(`Registered as peer ${myId} (channel ${myHasChannel ? "open" : "none"})`);

  // Auto-summary only prefills the summary text at registration; it deliberately does
  // NOT check the instance in — presence requires a real peer_checkin call. (A late
  // auto-summary used to call /set-summary, which now flips checked_in, so it's dropped.)

  // 6. Start polling after final registration so peers never see a transient id.
  if (clientInitialized) {
    startInboundMessagePolling();
  }

  // 7. Start heartbeat (with auto-re-register on stale eviction)
  const heartbeatTimer = setInterval(async () => {
    if (!myId) {
      await ensureRegistered();
      return;
    }
    try {
      await brokerFetch("/heartbeat", { id: myId });
    } catch {
      await ensureRegistered();
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 8. Prune surfaced-message dedup state and localMessageBuffer periodically
  const pruneTimer = setInterval(() => {
    if (surfacedMessageTexts.size > 1000) {
      const keys = [...surfacedMessageTexts.keys()];
      const toRemove = keys.slice(0, keys.length - 500);
      for (const key of toRemove) surfacedMessageTexts.delete(key);
    }
    if (localMessageBuffer.length > 200) {
      const removed = localMessageBuffer.splice(0, localMessageBuffer.length - 100);
      const removedIds = removed.map((m) => m.id);
      markMessagesSurfaced(removed);
      if (myId) {
        brokerFetch("/ack-messages", { peer_id: myId, ids: removedIds }).catch(() => {});
      }
      localBufferIds.clear();
      for (const m of localMessageBuffer) localBufferIds.add(m.id);
      log(`WARNING: Pruned ${removed.length} undelivered messages from local buffer (overflow)`);
    }
  }, 60_000);

  // 9. Clean up on exit
  const cleanup = async () => {
    pollActive = false;
    clearInterval(heartbeatTimer);
    clearInterval(pruneTimer);
    if (myId) {
      try {
        await brokerFetch("/unregister", { id: myId });
        log("Unregistered from broker");
      } catch {
        // Best effort
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
