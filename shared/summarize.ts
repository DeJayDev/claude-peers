export const SUMMARY_MODEL = Bun.env.OPENAI_MODEL ?? "gpt-5.4-nano";

export async function generateSummary(context: {
  cwd: string;
  git_root: string | null;
  git_branch?: string | null;
  recent_files?: string[];
}): Promise<string | null> {
  const apiKey = Bun.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }
  const baseUrl = (Bun.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");

  const parts = [`Working directory: ${context.cwd}`];
  if (context.git_root) {
    parts.push(`Git repo root: ${context.git_root}`);
  }
  if (context.git_branch) {
    parts.push(`Branch: ${context.git_branch}`);
  }
  if (context.recent_files && context.recent_files.length > 0) {
    parts.push(`Recently modified files: ${context.recent_files.join(", ")}`);
  }

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You generate brief summaries of what a developer is working on based on their project context. Respond with exactly 1-2 sentences, no more. Be specific about the project name and likely task. Plain text only — no markdown, no bold, no asterisks. The recently-modified file list may include deleted files; don't assume every file still exists.",
          },
          {
            role: "user",
            content: `Based on this context, what is this developer likely working on?\n\n${parts.join("\n")}`,
          },
        ],
        max_tokens: 100,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Get the current git branch name for a directory.
 */
export async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const result = await Bun.$`git -C ${cwd} rev-parse --abbrev-ref HEAD`.quiet().nothrow();
    if (result.exitCode === 0) {
      return result.text().trim();
    }
  } catch {}
  return null;
}

/**
 * Get recently modified tracked files in the git repo.
 */
export async function getRecentFiles(
  cwd: string,
  limit = 10
): Promise<string[]> {
  try {
    const diffResult = await Bun.$`git -C ${cwd} diff --name-only HEAD`.quiet().nothrow();
    const files = diffResult.text().trim().split("\n").filter((f) => f.length > 0);

    if (files.length >= limit) {
      return files.slice(0, limit);
    }

    const logResult = await Bun.$`git -C ${cwd} log --oneline --name-only -5 --format=`.quiet().nothrow();
    const logFiles = logResult.text().trim().split("\n").filter((f) => f.length > 0);

    const allFiles = [...new Set([...files, ...logFiles])];
    return allFiles.slice(0, limit);
  } catch {
    return [];
  }
}
