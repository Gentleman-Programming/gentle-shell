import { isAbsolute } from "node:path";
import type { GitRunner } from "./shell-changes.ts";

export type SidebarGitRoots = { state: "ready"; main: string; wt: string } | { state: "error"; message: string };

/** Discover metadata only; never open or scan the other worktrees. */
export async function discoverSidebarGitRoots(git: GitRunner): Promise<SidebarGitRoots> {
 const error: SidebarGitRoots = { state: "error", message: "Could not detect Git worktree roots." };
 try {
  const top = await git(["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || top.truncated || !top.stdout.endsWith("\n")) return error;
  const wt = top.stdout.slice(0, top.stdout.endsWith("\r\n") ? -2 : -1);
  if (!isAbsolute(wt)) return error;
  const result = await git(["worktree", "list", "--porcelain", "-z"]);
  if (result.code !== 0 || result.truncated || !result.stdout.endsWith("\0\0")) return error;
  const records = result.stdout.slice(0, -2).split("\0\0").map(record => record.split("\0"));
  const first = records[0];
  const main = first?.[0]?.startsWith("worktree ") ? first[0].slice(9) : "";
  if (!isAbsolute(main) || first.includes("bare") || first.some(field => field.startsWith("prunable"))) return error;
  if (!records.some(fields => fields[0] === `worktree ${wt}` && !fields.includes("bare") && !fields.some(field => field.startsWith("prunable")))) return error;
  return { state: "ready", main, wt };
 } catch { return error; }
}
