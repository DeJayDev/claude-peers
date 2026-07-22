import { describe, expect, test } from "bun:test";
import { isClaudeCodeClient } from "./client.ts";

describe("isClaudeCodeClient", () => {
  test.each(["claude-code", "Claude Code", "CLAUDE_CODE"])("recognizes %s", (name) => {
    expect(isClaudeCodeClient({ name })).toBe(true);
  });

  test.each(["codex", "cursor", "vscode", "claude-desktop", "claude"])("rejects %s", (name) => {
    expect(isClaudeCodeClient({ name })).toBe(false);
  });

  test("rejects missing client information", () => {
    expect(isClaudeCodeClient(undefined)).toBe(false);
  });
});
