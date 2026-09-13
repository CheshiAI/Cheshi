import type { GitBranch, GitCommit, GitFileChange } from "./git-types.mts";

const GIT_STATUS_RENAME_CODES = new Set(["R", "C"]);

export function parseStatus(output: string): GitFileChange[] {
  const records = output.split("\0");
  const changes = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 3) continue;
    const indexStatus = record[0] ?? " ";
    const workingTreeStatus = record[1] ?? " ";
    const filePath = record.slice(3);
    const renamed =
      GIT_STATUS_RENAME_CODES.has(indexStatus) ||
      GIT_STATUS_RENAME_CODES.has(workingTreeStatus);
    const oldPath = renamed ? records[index + 1] || null : null;
    if (renamed) index += 1;
    const untracked = indexStatus === "?" && workingTreeStatus === "?";
    changes.push({
      path: filePath,
      oldPath,
      indexStatus,
      workingTreeStatus,
      staged: !untracked && indexStatus !== " " && indexStatus !== "!",
      unstaged:
        untracked || (workingTreeStatus !== " " && workingTreeStatus !== "!"),
      untracked,
    });
  }
  return changes;
}

export function parseBranches(output: string): GitBranch[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line: string) => {
      const [
        fullName = "",
        name = "",
        hash = "",
        upstream = "",
        upstreamRemote = "",
        tracking = "",
        head = "",
      ] = line.split("\0");
      let ahead = 0;
      let behind = 0;
      for (const match of tracking.matchAll(/\b(ahead|behind) (\d+)\b/gu)) {
        const count = Number.parseInt(match[2] ?? "0", 10) || 0;
        if (match[1] === "ahead") ahead = count;
        else if (match[1] === "behind") behind = count;
      }
      return {
        name,
        fullName,
        hash,
        upstream: upstream || null,
        upstreamRemote: upstreamRemote || null,
        ahead,
        behind,
        current: head === "*",
        remote: fullName.startsWith("refs/remotes/"),
      };
    })
    .filter((branch) => (
      Boolean(branch.name) && !/^refs\/remotes\/[^/]+\/HEAD$/u.test(branch.fullName)
    ));
}

export function parseCommits(output: string): GitCommit[] {
  return output
    .split("\x1e")
    .map((record: string) => record.replace(/^\n+|\n+$/g, ""))
    .filter(Boolean)
    .map((record: string) => {
      const [
        hash = "",
        shortHash = "",
        authorName = "",
        authorEmail = "",
        authoredAt = "",
        decorations = "",
        subject = "",
      ] = record.split("\x1f");
      return {
        hash,
        shortHash,
        authorName,
        authorEmail,
        authoredAt,
        decorations,
        subject,
      };
    });
}
