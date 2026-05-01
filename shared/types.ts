// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  summary_updated_at: string | null; // ISO timestamp, null if never set
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp — heartbeat
  last_active_at: string | null; // ISO timestamp — last model-initiated tool call
  last_poll_at: string | null; // ISO timestamp — last /poll-messages (channel liveness)
}

export interface Message {
  id: number;
  from_id: PeerId;
  to: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
  acked_at: string | null; // ISO timestamp when peer's session consumed it via a tool call
  in_reply_to: number | null; // id of message being replied to, if any
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

// Delivery hint for a single recipient — inferred from broker-side activity timestamps.
// These are proxies for peer responsiveness, not guarantees.
export type DeliveryHint =
  | "responsive" // peer made a tool call in the last ~15s — likely to see this fast
  | "active" // peer active within last ~2min — mid-task, may take a moment
  | "idle" // peer quiet for a while — may be waiting on user or compacting
  | "no_channel"; // peer doesn't appear to be polling — must call peer_check to see it

export interface Delivery {
  peer_id: PeerId;
  ok: boolean;
  error?: string;
  message_id?: number;
  hint?: DeliveryHint;
}

export interface SendMessageRequest {
  from_id: PeerId;
  // Either a single peer ID or a list of peer IDs (for broadcast).
  // Scope selectors are resolved in the MCP server before hitting the broker.
  to: PeerId | PeerId[];
  text: string;
  in_reply_to?: number;
}

export interface SendMessageResponse {
  ok: boolean;
  error?: string;
  deliveries: Delivery[];
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}

export interface AckMessagesRequest {
  peer_id: PeerId;
  ids: number[];
}
