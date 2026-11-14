import { truncateToWidth } from "@earendil-works/pi-tui";
import type { GitRunner } from "./shell-changes.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";
import { renderPanelHeader, renderPanelRow } from "./shell-panel.ts";

export type SidebarGitGraph = { state: "ready"; branch: string; lines: string[] } | { state: "unborn"; branch: string } | { state: "error" } | { state: "pending" };
export type GraphTheme = { fg(role: string, text: string): string; bold?(text: string): string };
const clean = (text: string) => sanitizeTerminalText(text).replace(/[\r\n\t]/g, " ");

/** Read a bounded snapshot outside the render path. The caller bounds the runner's buffer. */
export async function readSidebarGitGraph(git: GitRunner): Promise<SidebarGitGraph> {
 try {
  const symbolic = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (symbolic.truncated || (symbolic.code !== 0 && symbolic.code !== 1)) return { state: "error" };
  const branch = symbolic.code === 0 ? clean(symbolic.stdout).trim() : "detached";
  const head = await git(["rev-parse", "--verify", "-q", "HEAD"]);
  if (head.truncated) return { state: "error" };
  if (head.code !== 0) return symbolic.code === 0 && head.code === 1 ? { state: "unborn", branch } : { state: "error" };
  const log = await git(["-c", "color.ui=false", "log", "--graph", "--no-color", "--max-count=50", "--format=%x1e%h%x1f%D%x1f%s%x1e", "HEAD"]);
  if (log.code !== 0 || log.truncated) return { state: "error" };
  return { state: "ready", branch, lines: log.stdout.replace(/\n$/, "").split("\n") };
 } catch { return { state: "error" }; }
}

const TYPE_ROLES: Record<string, string> = { feat: "success", fix: "warning", chore: "muted", merge: "syntaxFunction", refactor: "syntaxFunction", perf: "success", test: "syntaxFunction", build: "warning", ci: "warning" };
const FRAME_ROLES = ["accent", "muted", "text", "success", "warning", "syntaxFunction"];
function renderSubject(subject: string, theme: GraphTheme): string {
 const safe = clean(subject);
 const match = /^(merge)(?=\s)|^([a-z]+)(?:\([^\r\n)]*\))?!?:/i.exec(safe);
 const role = match && TYPE_ROLES[(match[1] ?? match[2]).toLowerCase()];
 return role ? theme.fg(role, match![0]) + theme.fg("text", safe.slice(match![0].length)) : theme.fg("text", safe);
}
function renderLine(line: string, theme: GraphTheme): string {
 const match = /^([ |*\\/_.-]*)\x1e([0-9a-f]+)\x1f([^\x1f\x1e]*)\x1f([^\x1e]*)\x1e$/.exec(line);
 if (!match) return theme.fg("muted", clean(line));
 const [, graph, hash, refs, subject] = match;
 const paintedGraph = graph.split(/(\*)/).map(part => theme.fg(part === "*" ? "accent" : "muted", part)).join("");
 return paintedGraph + theme.fg("muted", hash) + (refs ? ` ${theme.fg("accent", `(${clean(refs)})`)}` : "") + ` ${renderSubject(subject, theme)}`;
}
/** Only format rows that can be displayed, and clip every output line. */
export function renderSidebarGitGraph(graph: SidebarGitGraph, theme: GraphTheme, width: number, viewport: number, offset = 0, collapsed = false, hovered = false): string[] {
 if (width <= 0 || viewport <= 0) return [];
 const detail = graph.state === "error" ? "history unavailable" : graph.state === "pending" ? "Loading history…" : graph.branch;
 const rows = [renderPanelHeader(theme, width, { title: "Git", count: detail, open: !collapsed, hovered })];
 if (collapsed) return rows;
 if (graph.state === "unborn" && viewport > 1) rows.push(renderPanelRow(width, theme.fg("muted", "No commits yet")));
 // The rail's tinted surface paints the background per occupied cell, so every
 // row must fill the full render width — the MAIN/PROFILE rule: body rows carry
 // the panel indent the transparent card path strips off itself.
 if (graph.state === "ready") for (const line of graph.lines.slice(offset, offset + Math.max(0, viewport - 1))) rows.push(renderPanelRow(width, renderLine(line, theme)));
 return rows;
}
/** Coalesces overlapping refreshes and discards results after deactivation. */
export class SidebarGitHistory {
 graph: SidebarGitGraph = { state: "error" };
 revision = 0;
 private active = false;
 private generation = 0;
 private inFlight?: Promise<void>;
 private queued = false;
 private statusFingerprint: string | undefined;
 private readonly git: GitRunner;
 private readonly status: () => Promise<string | undefined>;
 private readonly publish: () => void;
 constructor(git: GitRunner, status: () => Promise<string | undefined>, publish: () => void) { this.git = git; this.status = status; this.publish = publish; }
 setActive(active: boolean): void {
  if (this.active === active) return;
  this.active = active; this.generation++;
  if (active) queueMicrotask(() => { void this.refresh(); });
 }
 refresh(): Promise<void> {
  if (!this.active) return Promise.resolve();
  if (this.inFlight) { this.queued = true; return this.inFlight; }
  this.inFlight = this.capture().finally(() => { this.inFlight = undefined; });
  return this.inFlight;
 }
 private async capture(): Promise<void> {
  do {
   this.queued = false;
   const generation = this.generation;
   const [graph, status] = await Promise.all([readSidebarGitGraph(this.git), this.status().catch(() => undefined)]);
   if (!this.active || generation !== this.generation) continue;
   if (JSON.stringify(graph) !== JSON.stringify(this.graph) || status !== this.statusFingerprint) {
    this.graph = graph; this.statusFingerprint = status; this.revision++;
   }
   // Every completed capture publishes, even when nothing moved: the reader
   // that holds a frame needs the settled signal, and its consumer dedupes by
   // what is actually painted instead of by revision. A repaint can fail once
   // the terminal has stopped: capture() must never reject for it, because
   // setActive() refreshes fire and forget and a rejection would be unhandled.
   try { this.publish(); } catch { /* repaint failures cannot change the graph. */ }
  } while (this.active && this.queued);
 }
}
export class SidebarGitFrameCache {
 private frame?: { revision: number; width: number; viewport: number; offset: number; collapsed: boolean; hovered: boolean; theme: GraphTheme; signature: string; lines: string[] };
 render(graph: SidebarGitGraph, revision: number, theme: GraphTheme, width: number, viewport: number, offset = 0, collapsed = false, hovered = false): string[] {
  const frame = this.frame;
  const signature = FRAME_ROLES.map(role => theme.fg(role, "·")).join("") + (theme.bold?.("·") ?? "");
  if (frame && frame.revision === revision && frame.width === width && frame.viewport === viewport && frame.offset === offset && frame.collapsed === collapsed && frame.hovered === hovered && frame.theme === theme && frame.signature === signature) return frame.lines;
  const lines = renderSidebarGitGraph(graph, theme, width, viewport, offset, collapsed, hovered);
  this.frame = { revision, width, viewport, offset, collapsed, hovered, theme, signature, lines };
  return lines;
 }
}
