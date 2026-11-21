import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

export type SidebarTabsPolicy = "on" | "off";
const SCHEMA = "gentle-pi.sidebar-tabs/v1";
type Options = { gentlePiConfigHome?: string };
type Destinations = { main: SidebarTabsPolicy; git: SidebarTabsPolicy; gitHistory?: SidebarTabsPolicy; diff?: SidebarTabsPolicy };
export function resolveSidebarTabs(options: Options = {}): { policy: SidebarTabsPolicy; main: SidebarTabsPolicy; git: SidebarTabsPolicy; gitHistory: SidebarTabsPolicy; diff: SidebarTabsPolicy; malformed: boolean; globalFile: string } {
 const globalFile = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), "sidebar-tabs.json");
 const fallback = { policy: "off", main: "on", git: "on", gitHistory: "on", diff: "on", globalFile } as const;
 try {
  const value: unknown = JSON.parse(readFileSync(globalFile, "utf8"));
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
   const record = value as Record<string, unknown>;
   const keys = Object.keys(record);
   const validChoice = (key: string) => record[key] === "on" || record[key] === "off";
   const legacy = keys.length === 2 || keys.length === 4 && validChoice("main") && validChoice("git");
   const current = keys.length === 6 && ["main", "git", "gitHistory", "diff"].every(validChoice);
   if (record.schema === SCHEMA && validChoice("policy") && (legacy || current)) return { policy: record.policy as SidebarTabsPolicy, main: record.main === "off" ? "off" : "on", git: record.git === "off" ? "off" : "on", gitHistory: record.gitHistory === "off" ? "off" : "on", diff: record.diff === "off" ? "off" : "on", malformed: false, globalFile };
  }
  return { ...fallback, malformed: true };
 } catch (error) {
  const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  return { ...fallback, malformed: !missing };
 }
}
export function writeSidebarTabs(policy: SidebarTabsPolicy, options: Options = {}, destinations?: Destinations): string {
 const current = resolveSidebarTabs(options);
 if (current.malformed) throw new Error(`Cannot update malformed or unreadable Tabs policy: ${current.globalFile}`);
 const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
 const temporary = `${current.globalFile}.${randomUUID()}.tmp`;
 mkdirSync(home, { recursive: true });
 try {
  const selected = { main: destinations?.main ?? current.main, git: destinations?.git ?? current.git, gitHistory: destinations?.gitHistory ?? current.gitHistory, diff: destinations?.diff ?? current.diff,  };
  writeFileSync(temporary, `${JSON.stringify({ schema: SCHEMA, policy, ...selected })}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, current.globalFile);
 } finally { try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ } }
 return current.globalFile;
}
