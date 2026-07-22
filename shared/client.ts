type ClientInfo = {
  name: string;
};

/** Whether an MCP client is Claude Code, where the Claude CLI relaunch hint applies. */
export function isClaudeCodeClient(client: ClientInfo | null | undefined): boolean {
  if (!client) return false;
  return client.name.toLowerCase().replace(/[^a-z0-9]/g, "") === "claudecode";
}
