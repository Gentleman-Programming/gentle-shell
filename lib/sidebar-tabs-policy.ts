import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

export type SidebarTabsPolicy = "on" | "off";
const SCHEMA = "gentle-pi.sidebar-tabs/v1";
type Options = { gentlePiConfigHome?: string };
export function resolveSidebarTabs(options: Options = {}): { policy: SidebarTabsPolicy; main: SidebarTabsPolicy; git: SidebarTabsPolicy; malformed: boolean; globalFile: string } {
 const globalFile = join(options.gentlePiConfigHome ?? gentlePiConfigHome(), "sidebar-tabs.json");
 try {
  const value: unknown = JSON.parse(readFileSync(globalFile, "utf8"));
  if (typeof value === "object" && value !== null && !Array.isArray(value) && "schema" in value && value.schema === SCHEMA && "policy" in value && (value.policy === "on" || value.policy === "off") && (Object.keys(value).length === 2 || Object.keys(value).length === 4 && "main" in value && "git" in value && (value.main === "on" || value.main === "off") && (value.git === "on" || value.git === "off"))) return { policy: value.policy, main: "main" in value && value.main === "off" ? "off" : "on", git: "git" in value && value.git === "off" ? "off" : "on", malformed: false, globalFile };
  return { policy: "off", main: "on", git: "on", malformed: true, globalFile };
 } catch (error) {
  const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  return { policy: "off", main: "on", git: "on", malformed: !missing, globalFile };
 }
}
export function writeSidebarTabs(policy: SidebarTabsPolicy, options: Options = {}, destinations?: { main: SidebarTabsPolicy; git: SidebarTabsPolicy }): string {
 const current = resolveSidebarTabs(options);
 if (current.malformed) throw new Error(`Cannot update malformed or unreadable Tabs policy: ${current.globalFile}`);
 const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
 const temporary = `${current.globalFile}.${randomUUID()}.tmp`;
 mkdirSync(home, { recursive: true });
 try {
  const selected = destinations ?? { main: current.main, git: current.git };
  writeFileSync(temporary, `${JSON.stringify({ schema: SCHEMA, policy, ...selected })}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, current.globalFile);
 } finally { try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ } }
 return current.globalFile;
}
