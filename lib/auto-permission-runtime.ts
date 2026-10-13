import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, InputEvent, ToolCallEvent, ToolCallEventResult, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { gentlePiConfigHome } from "./agent-home.ts";
import { AutoPermissionMemory } from "./auto-permission-memory.ts";
import { projectToolContext } from "./auto-permission-tool-context.ts";
import { subscribeHumanAnswers, type HumanAnswerReceipt } from "./auto-permission-answers.ts";
import { AUTO_PERMISSION_EVIDENCE_BYTES, AUTO_PERMISSION_EVIDENCE_LIMITS, resolveAutoPermissionEvidencePath } from "./auto-permission-evidence.ts";
import { AUTO_PERMISSION_DIAGNOSTIC_PATHS, type AutoPermissionDiagnostic } from "./auto-permission-classifier.ts";
import { appendSystemPromptOnce, type AppendableSystemPromptOptions } from "./append-system-prompt.ts";

export const AUTO_DIRECTIVE = `<gentle-auto-permissions>
Auto permission mode is active. Continue ordinary authorized work without routine permission questions. An independent classifier checks eligible tool actions before execution. A denial is a boundary, not an obstacle to evade: choose a materially safer alternative within the request; never hide the same effect behind another tool, script, or subagent. Ask the human only for unresolved consequential intent, explicit required consent, or when safe progress is blocked. Existing hard safety, explicit user restrictions, and native review/maintenance consent still apply. Never answer human consent tools yourself. Auto is not a sandbox, does not grant new task scope, and does not change Gentle Shell delegation.
</gentle-auto-permissions>`;
export function updateAutoPrompt(options: AppendableSystemPromptOptions | undefined, active: boolean): void {
 if (!options) return;
 options.appendSystemPrompt = (options.appendSystemPrompt ?? "").replace(`\n\n${AUTO_DIRECTIVE}`, "").replace(AUTO_DIRECTIVE, "");
 if (active) appendSystemPromptOnce(options, AUTO_DIRECTIVE);
}

type ModeController = {mode(ctx: ExtensionContext): Promise<string>; epoch(): number};
type Verdict = {status: string; decision?: string; reason?: string; code?: string; usage?: unknown; usageKnown?: boolean; actualModel?: unknown; requestedModel?: unknown; diagnostic?: unknown};
/** Project a closed metadata schema; injected classifiers cannot add payloads to diagnostics. */
function safeDiagnostic(value: unknown): AutoPermissionDiagnostic | undefined {
 try {
  if(!value || typeof value!=="object")return undefined;
  const {implementation,elapsedMs,deadlineMs,timerFired,returnPath,evidenceLimit}=value as AutoPermissionDiagnostic;
  if(implementation!=="auto-classifier-diagnostics-v1" || !Number.isSafeInteger(elapsedMs) || elapsedMs<0 ||
   !Number.isFinite(deadlineMs) || deadlineMs<1 || deadlineMs>20000 || typeof timerFired!=="boolean" ||
   !AUTO_PERMISSION_DIAGNOSTIC_PATHS.includes(returnPath) ||
   (evidenceLimit!==undefined && !AUTO_PERMISSION_EVIDENCE_LIMITS.includes(evidenceLimit)))return undefined;
  return {implementation,elapsedMs,deadlineMs,timerFired,returnPath,...(evidenceLimit ? {evidenceLimit} : {})};
 } catch { return undefined; }
}
export type AutoRuntimeClassifier = {run(request: any): Promise<Verdict>; cancel(): void};
type Classifier = AutoRuntimeClassifier;
type BranchItem = {id: string; type: string; message?: {role: string; content: unknown}};
type AuthoredInput = {text: string; order:number; before: Set<string>; entryId?: string; prompt?: string};
// These are independent authority/dialog/delegation surfaces, not Auto approvals.
const OWNED_CONTROL_TOOLS = new Set([
 "ask_user_choice", "ask_user_question", "gentle_review", "gentle_review_capture", "gentle_review_capture_group",
 "subagent_run", "subagent_continue", "subagent_reply", "subagent_cancel", "subagent_send_message",
 "subagent_status", "subagent_result", "subagent_list_tasks", "subagent_list_agents",
 "gentle_odd_phase", "todo",
]);
const DENIAL_LIMIT = 3, TOTAL_DENIAL_LIMIT = 20;
const MAX_AUTHORED_BYTES = 24_000;
// Answered prompts are context, not authority: keep each tail short and the total (prompt plus repeated reply) well inside the classifier budget.
const PROMPT_TAIL_BYTES = 1_200, PROMPT_TOTAL_BYTES = 4_000;
// Codex-style window for long sessions: never block every action on size. Oversized messages keep
// their start and end; the first (task) and latest messages are always kept, recent ones fill the rest.
// Sizes here are JSON-serialized bytes, as the classifier measures them; the reserve leaves room
// for the omission policy that is only sent once history is omitted.
const MESSAGE_WINDOW_BYTES = 6_000, OMISSION_RESERVE_BYTES = 1_024;
const serialized = (text: string): number => Buffer.byteLength(JSON.stringify(text))-2;
function codePointBytes(text: string, max: number, fromEnd: boolean): string {
 let bytes=0;const points=Array.from(text);const kept:string[]=[];
 for(const point of fromEnd ? points.reverse() : points) {
  const size=serialized(point);
  if(bytes+size>max)break;
  bytes+=size;kept.push(point);
 }
 return (fromEnd ? kept.reverse() : kept).join("");
}
function middleTruncate(text: string): string {
 if(serialized(text)<=MESSAGE_WINDOW_BYTES)return text;
 const size=Buffer.byteLength(text);
 const keep=Math.floor((MESSAGE_WINDOW_BYTES-64)/2);
 const head=codePointBytes(text,keep,false), tailText=codePointBytes(text,keep,true);
 return `${head} [${size-Buffer.byteLength(head)-Buffer.byteLength(tailText)} bytes omitted by host] ${tailText}`;
}
const PROVIDER_RETRY_DELAYS_MS = [500, 1_500];
const HISTORY_BYTES = 4_000, HISTORY_ENTRIES = 12;
const UNAVAILABLE_REASONS: Record<string,string> = {
 busy: "The Auto classifier is still settling a previous request. Wait for it to finish before retrying; this is not a safety denial.",
 timeout: "The Auto classifier timed out. A timeout is not evidence that the action is unsafe. Retry after the pending request settles, or use manual permissions.",
 cancelled: "The Auto classifier was cancelled. Retry only in the current live context.",
 revoked: "The Auto decision expired. Retry only in the current live context.",
 "missing-trusted-request": "Auto has no live human request for this branch. Ask the user for a specific instruction.",
 "input-too-large": "The Auto context exceeds its input budget. Narrow the current action, or use manual permissions; repeated retries cannot fix oversized input.",
 "redacted-context": "The Auto context contains potentially sensitive evidence. Use non-sensitive evidence or manual review; do not expose it to obtain approval.",
 "invalid-input": "The Auto action context is invalid. Correct the tool input before retrying.",
 "invalid-output": "The Auto classifier returned an invalid verdict. Retry later or use manual permissions.",
 "truncated-output": "The Auto classifier verdict was truncated. Retry later or use manual permissions.",
 "output-too-large": "The Auto classifier verdict exceeded its output budget. Retry later or use manual permissions.",
 "tool-call": "The Auto classifier requested an unsupported tool. No usable verdict was produced; use manual permissions.",
 "evidence-unavailable": "The Auto classifier could not obtain the required evidence. Provide a relevant local file or use manual review.",
 "evidence-limit": "The Auto classifier exhausted its evidence budget. Narrow the action or use manual review.",
};
function block(reason: string): ToolCallEventResult { return {block:true,reason}; }
function within(path: string, root: string): boolean {
 const rel = relative(root, path);
 return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
/** Resolve existing ancestors too, so a new file under a symlink is not local by spelling. */
function canonical(path: string): string {
 const absolute = resolve(path);
 let ancestor = absolute;
 while (!existsSync(ancestor)) { const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent; }
 return resolve(realpathSync(ancestor), relative(ancestor, absolute));
}
/** True only for an existing symlink-free in-project regular file larger than the reader accepts.
 * lstat walks each component from cwd and stops at any symlink, so no outside path is ever examined.
 * Anything else keeps its existing candidate path; the reader still re-checks everything. */
function oversizedLocalFile(cwd: string, path: string): boolean {
 try {
  const parts=path.split("/");
  let current=realpathSync(resolve(cwd));
  for(let i=0;i<parts.length;i++) {
   current=resolve(current,parts[i]);
   const stat=lstatSync(current,{throwIfNoEntry:false});
   if(!stat || stat.isSymbolicLink())return false;
   if(i===parts.length-1)return stat.isFile() && stat.size>AUTO_PERMISSION_EVIDENCE_BYTES;
   if(!stat.isDirectory())return false;
  }
  return false;
 } catch { return false; }
}

/** Select explicit file operands, never evaluate a shell or crawl prior read paths.
 * Unsupported shell syntax stays tool-free rather than inspecting a file in the wrong cwd. */
function evidencePaths(toolName: string, input: unknown, cwd: string): string[] {
 if(!["bash","bash_background","monitor"].includes(toolName))return [];
 const command=(input as {command?:unknown})?.command;
 if(typeof command!=="string")return [];
 if(command.includes("&&")) {
  // Evidence only: validate the whole narrow expression before selecting operands.
  // No shell evaluation, cwd changes, quoting, redirection or inherited approval.
  const segments=command.split("&&").map(part=>part.trim());
  if(segments.length>4 || segments.some(part=>!part || /[$`;&|<>(){}*?\\\r\n\"']/.test(part)))return [];
  const valid=segments.every(part=>part==="git diff --check" ||
   /^node(?:\s+(?:--experimental-strip-types|--test))*\s+[\w./-]+\.(?:[cm]?[jt]s)(?:\s+[\w./-]+\.(?:[cm]?[jt]s))*$/.test(part));
  if(!valid)return [];
  return [...new Set(segments.flatMap(part=>evidencePaths(toolName,{command:part},cwd)))].slice(0,12);
 }
 if(/[$`;&|<>(){}*?\\\r\n]/.test(command))return [];
 const tokens:string[]=[];
 let token="",quote="";
 for(const char of command) {
  if(quote) {if(char===quote)quote="";else token+=char;}
  else if(char==='"' || char==="'")quote=char;
  else if(/\s/.test(char)) {if(token){tokens.push(token);token="";}}
  else token+=char;
 }
 if(quote)return [];
 if(token)tokens.push(token);
 if(!tokens.length || tokens.some(t=>["-e","--eval","-c","--command","-p","--print"].includes(t)))return [];
 // Interpreter/package-manager cwd switches change which file a relative operand means.
 // Do not offer root decoys as evidence when we cannot bind the effective directory.
 if(tokens.some(t=>/^(?:--(?:cwd|dir|directory|prefix|workspace|workspaces)(?:=|$)|-C|-w)/.test(t)))return [];
 let candidates:string[]=[];
 if(["npm","pnpm","yarn","bun"].includes(tokens[0]) && ["run","run-script","test","test:unit","lint"].includes(tokens[1])) candidates=["package.json"];
 else if(/^(?:node|nodejs|python(?:3(?:\.\d+)?)?|bash|sh|zsh|ruby|perl|deno|bun|tsx|ts-node)$/.test(tokens[0]))
  candidates=tokens.slice(1).filter(t=>!t.startsWith("-") && /\.(?:[cm]?[jt]s|tsx|jsx|py|sh|bash|zsh|rb|pl)$/.test(t));
 else if(tokens[0].startsWith("./") && /\.(?:sh|bash|zsh|py|[cm]?[jt]s)$/.test(tokens[0]))candidates=[tokens[0]];
 const result:string[]=[];
 for(const candidate of candidates) {
  const path=isAbsolute(candidate) ? relative(resolve(cwd),candidate).split(sep).join("/") : candidate.replace(/^\.\//,"");
  try {
   resolveAutoPermissionEvidencePath(resolve(cwd),[path],path);
   // Never offer a file the reader must reject: the classifier then judges without it instead of
   // failing technically. Missing files keep their existing path; the reader still re-checks size.
   if(oversizedLocalFile(cwd,path))continue;
   if(!result.includes(path))result.push(path);
  } catch { /* Unsupported/credential paths are not inspection candidates. */ }
 }
 return result.slice(0,12);
}
function inputText(content: unknown): string | undefined {
 if (typeof content === "string") return content;
 if (!Array.isArray(content) || content.some(p => p?.type !== "text")) return undefined;
 return content.map(p=>p.text).join("");
}
/** The host appends image hints after a blank line, so attached images keep the typed text as a prefix. */
function matchesInput(content: unknown, text: string): boolean {
 if (!Array.isArray(content) || !content.some(p => p?.type === "image")) return inputText(content) === text;
 if (content.some(p => p?.type !== "text" && p?.type !== "image")) return false;
 const typed = content.filter(p => p.type === "text").map(p => p.text).join("");
 return typed === text || typed.startsWith(`${text}\n\n`);
}
function assistantText(content: unknown): string {
 if (typeof content === "string") return content;
 if (!Array.isArray(content)) return "";
 return content.filter(p => p?.type === "text" && typeof p.text === "string").map(p => p.text).join("\n");
}
/** Resolves false when aborted, so a revoked check never sleeps into another attempt. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
 if (signal.aborted) return Promise.resolve(false);
 return new Promise(done => {
  const timer = setTimeout(() => { signal.removeEventListener("abort", stop); done(true); }, ms);
  const stop = () => { clearTimeout(timer); done(false); };
  signal.addEventListener("abort", stop, { once: true });
 });
}
function tail(text: string, bytes: number): string {
 const points = Array.from(text.trim());
 let size = 0, start = points.length;
 while (start > 0 && size + Buffer.byteLength(points[start-1]) <= bytes) size += Buffer.byteLength(points[--start]);
 return points.slice(start).join("");
}
function numericUsage(usage: unknown): Record<string,number> {
 if (!usage || typeof usage !== "object") return {};
 const safe: Record<string,number> = {};
 for (const key of ["input","output","cacheRead","cacheWrite","totalTokens","costTotal"]) {
  const value = (usage as Record<string,unknown>)[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) safe[key]=value;
 }
 return safe;
}

/** Live host provenance is held outside model text and never restored from a transcript. */
export class AutoPermissionRuntime {
 private owner?: {manager: ExtensionContext["sessionManager"]; id: string; cwd: string};
 private generation = 0;
 private requests: AuthoredInput[] = [];
 private hostAnswers: {text:string;prompt:string;anchor:string;epoch:number;order:number}[] = [];
 private inputOrder=0;
 private unsubscribeAnswers?: () => void;
 private answerEpoch?: number;
 private priorActions: {toolName:string;input:unknown}[] = [];
 private consecutive = 0;
 private total = 0;
 private unavailable = 0;
 private calls = 0;
 private tokens = 0;
 private cost = 0;
 private active = new Set<AbortController>();
 private configHome: string;
 private pi: Pick<ExtensionAPI,"appendEntry"> & Partial<Pick<ExtensionAPI,"getAllTools">>;
 private memory: AutoPermissionMemory;
 private modes: ModeController;
 private classifier: Classifier;
 constructor(pi: Pick<ExtensionAPI,"appendEntry"> & Partial<Pick<ExtensionAPI,"getAllTools">>, modes: ModeController, classifier: Classifier,
  options: {configHome?: string; retryDelaysMs?: number[]} = {}) {
  this.pi=pi;this.modes=modes;this.classifier=classifier;
  this.memory=new AutoPermissionMemory(()=>pi.getAllTools?.() ?? []);
  this.configHome = resolve(options.configHome ?? gentlePiConfigHome());
  this.retryDelaysMs = options.retryDelaysMs ?? PROVIDER_RETRY_DELAYS_MS;
 }
 private retryDelaysMs: number[];
 private toolContext(name:string) {
  try { return projectToolContext(this.pi.getAllTools?.().find(tool=>tool.name===name),name); }
  catch { return undefined; }
 }
 toolResult(event: ToolResultEvent, ctx: ExtensionContext): void {
  this.own(ctx);
  this.memory.result(event,ctx,this.modes.epoch());
 }
 cancelPending(): void {
  this.memory.clear();
  this.unsubscribeAnswers?.();this.unsubscribeAnswers=undefined;
  this.hostAnswers=[];this.answerEpoch=undefined;
  this.generation++;
  for (const controller of this.active) controller.abort();
  this.classifier.cancel();
 }
 reset(): void {
  this.cancelPending();
  this.active.clear();this.owner=undefined;this.requests=[];this.priorActions=[];this.inputOrder=0;
  this.consecutive=0;this.total=0;this.unavailable=0;this.calls=0;this.tokens=0;this.cost=0;
 }
 private own(ctx: ExtensionContext): void {
  const id=ctx.sessionManager.getSessionId();
  if (this.owner?.manager === ctx.sessionManager && this.owner.id === id && this.owner.cwd === ctx.cwd) return;
  this.reset();this.owner={manager:ctx.sessionManager,id,cwd:ctx.cwd};
 }
 private observeAnswers(ctx: ExtensionContext): void {
  const epoch=this.modes.epoch();
  if(this.unsubscribeAnswers && this.answerEpoch===epoch)return;
  this.unsubscribeAnswers?.();this.answerEpoch=epoch;
  this.hostAnswers=this.hostAnswers.filter(answer=>answer.epoch===epoch);
  this.unsubscribeAnswers=subscribeHumanAnswers(ctx,receipt=>{
   if(epoch!==this.modes.epoch())return;
   this.captureAnswer(receipt,ctx,epoch);
  });
 }
 private captureAnswer(receipt: HumanAnswerReceipt, ctx: ExtensionContext, epoch: number): void {
  if(receipt.sessionManager!==this.owner?.manager || receipt.sessionId!==this.owner.id ||
   receipt.cwd!==this.owner.cwd || receipt.branchAnchor===null || ctx.signal?.aborted ||
   !this.branch(ctx).some(entry=>entry.id===receipt.branchAnchor))return;
  const answer=receipt.answer;
  const text=answer.kind==="multi" ? answer.selected.join("; ") :
   [answer.text,...answer.selected ?? []].join("; ");
  if(!text.trim())return;
  // Preserve the entire referent: cutting option descriptions can change what "yes" means.
  const prompt=receipt.prompt;
  // Size never blocks: the reply joins the bounded window and its prompt is kept only while it fits.
  if(typeof prompt!=="string")return;
  this.generation++;
  for(const controller of this.active)controller.abort();
  this.classifier.cancel();
  this.consecutive=0;this.total=0;this.unavailable=0;this.priorActions=[];
  this.hostAnswers.push({text,prompt,anchor:receipt.branchAnchor,epoch,order:++this.inputOrder});
 }
 private liveHostAnswers(ctx: ExtensionContext) {
  const ids=new Set(this.branch(ctx).map(entry=>entry.id));
  return this.hostAnswers.filter(answer=>answer.epoch===this.modes.epoch() && ids.has(answer.anchor));
 }
 private branch(ctx: ExtensionContext): BranchItem[] {
  try { return ctx.sessionManager.getBranch() as BranchItem[]; } catch { return []; }
 }
 input(event: Pick<InputEvent,"text"|"source">, ctx: ExtensionContext): void {
  this.own(ctx);
  // RPC clients and extension messages are not evidence of an interactive human decision.
  if (event.source !== "interactive") return;
  this.unsubscribeAnswers?.();this.unsubscribeAnswers=undefined;
  this.generation++;
  for (const controller of this.active) controller.abort();
  this.classifier.cancel();
  this.consecutive=0;this.total=0;this.unavailable=0;
  // Optional action history is not authority. A new request starts a fresh evidence window;
  // all live human restrictions below remain intact.
  this.priorActions=[];
  const branch=this.branch(ctx);
  // Captured now, before any later assistant text exists, so a reply never inherits a question asked after it.
  const last=branch.findLast(e=>e.type==="message" && (e.message?.role==="assistant" || e.message?.role==="user"));
  const prompt=last?.message?.role==="assistant" ? tail(assistantText(last.message.content),PROMPT_TAIL_BYTES) : "";
  this.requests.push({text:event.text,order:++this.inputOrder,before:new Set(branch.map(e=>e.id)),...(prompt ? {prompt} : {})});
 }
 private trusted(ctx: ExtensionContext): {messages: string[]; kept: Set<number>; omitted: number} {
  const branch=this.branch(ctx), ids=new Set(branch.map(e=>e.id));
  for(const request of this.requests) {
   if(request.entryId) continue;
   const match=branch.find(e=>!request.before.has(e.id) && e.type==="message" && e.message?.role==="user" && matchesInput(e.message.content,request.text));
   if(match) request.entryId=match.id;
  }
  // Switching branches cannot reuse an approval whose actual input entry is absent.
  const all=[...this.live(ids),...this.liveHostAnswers(ctx)].sort((a,b)=>a.order-b.order);
  const full=all.map(r=>r.text);
  if(Buffer.byteLength(full.join(""))<=MAX_AUTHORED_BYTES)return {messages:full,kept:new Set(all.map(r=>r.order)),omitted:0};
  // Over budget: keep the task (first) and the latest message, then the most recent contiguous ones.
  const texts=full.map(middleTruncate);
  const keep=new Set([0,all.length-1]);
  // +3 per entry covers the array's quotes and separator.
  const cost=(i:number)=>serialized(texts[i])+3;
  let budget=MAX_AUTHORED_BYTES-OMISSION_RESERVE_BYTES-2-[...keep].reduce((sum,i)=>sum+cost(i),0);
  for(let i=all.length-2;i>0;i--) {
   const size=cost(i);
   if(size>budget)break;
   budget-=size;keep.add(i);
  }
  const order=[...keep].sort((a,b)=>a-b);
  return {messages:order.map(i=>texts[i]),kept:new Set(order.map(i=>all[i].order)),omitted:all.length-keep.size};
 }
 private live(ids: Set<string>): AuthoredInput[] { return this.requests.filter(r=>r.entryId && ids.has(r.entryId)); }
 /** Newest first within a fixed budget that also counts the repeated reply; dropped pairs leave their replies trusted. */
 private answered(ctx: ExtensionContext, window: {messages: string[]; kept: Set<number>}): {prompt:string;reply:string}[] {
  // Only pairs whose reply is in the window; omitted replies must not return through their prompt.
  const live=this.live(new Set(this.branch(ctx).map(e=>e.id))).filter(r=>window.kept.has(r.order));
  const kept: {prompt:string;reply:string}[]=[];
  // Host answers keep their full question, newest first within their own budget, as before the window existed.
  let hostBudget=PROMPT_TOTAL_BYTES;
  for(const answer of this.liveHostAnswers(ctx).filter(r=>window.kept.has(r.order)).reverse()) {
   const size=Buffer.byteLength(answer.prompt)+Buffer.byteLength(answer.text);
   if(size>hostBudget)continue;
   hostBudget-=size;kept.unshift({prompt:answer.prompt,reply:answer.text});
  }
  // Typed-reply pairs use what live requests and host pairs leave, so the classifier input never grows past its previous ceiling.
  let budget=Math.min(PROMPT_TOTAL_BYTES,MAX_AUTHORED_BYTES-live.reduce((sum,r)=>sum+Buffer.byteLength(r.text),0))-(PROMPT_TOTAL_BYTES-hostBudget);
  for(const request of live.reverse()) {
   if(!request.prompt) continue;
   const size=Buffer.byteLength(request.prompt)+Buffer.byteLength(request.text);
   if(size>budget) continue;
   budget-=size;kept.unshift({prompt:request.prompt,reply:request.text});
  }
  return kept;
 }
 private protectedMutation(event: Pick<ToolCallEvent,"toolName"|"input">, ctx: ExtensionContext): boolean {
  const args=event.input as Record<string,unknown>;
  if (!args || typeof args!=="object") return false;
  if ((event.toolName==="write" || event.toolName==="edit") && typeof args.path==="string") {
   try { return within(canonical(resolve(ctx.cwd,args.path)),canonical(this.configHome)); } catch { return true; }
  }
  if (["bash","bash_background","monitor"].includes(event.toolName) && typeof args.command==="string") {
   // Best-effort shell recognition supplements classification, not OS containment.
   return args.command.includes(this.configHome) || /(?:permission-mode|runtime-guardrails)\.json/.test(args.command);
  }
  return false;
 }
 private record(ctx: ExtensionContext, event: Pick<ToolCallEvent,"toolName"|"toolCallId">, result: Verdict, late=false, memoryContextAttached?: boolean): void {
  const usage=numericUsage(result.usage), diagnostic=safeDiagnostic(result.diagnostic);
  // Receipts carry no raw command, input, transcript, or provider-generated rationale.
  try {this.pi.appendEntry("gentle-auto-permission",{schema:1,toolCallId:event.toolCallId,toolName:event.toolName,
   status:result.status,decision:result.decision,code:result.code,usage,usageKnown:result.usageKnown,late,actualModel:result.actualModel,...(memoryContextAttached === undefined ? {} : {memoryContextAttached}),...(diagnostic ? {diagnostic} : {})});} catch { /* Missing persistence never creates permission. */ }
  if(!late)this.calls++;
  this.tokens+=usage.totalTokens ?? 0;this.cost+=usage.costTotal ?? 0;
  try {ctx.ui.setStatus("gentle:auto-usage",`Auto checks ${this.calls} · ${this.tokens} tokens · $${this.cost.toFixed(4)} (separate)`);} catch { /* Headless. */ }
 }
 guard(event: Pick<ToolCallEvent,"toolName"|"input">, ctx: ExtensionContext): ToolCallEventResult | undefined {
  return this.protectedMutation(event,ctx) ? block("Permission configuration is human-controlled. Use the mode settings UI; model tools cannot change it.") : undefined;
 }
 async check(event: Pick<ToolCallEvent,"toolName"|"input"|"toolCallId">, ctx: ExtensionContext, primary=true): Promise<ToolCallEventResult|undefined> {
  if(!primary)return undefined;
  this.own(ctx);
  if(this.protectedMutation(event,ctx))return block("Permission configuration is human-controlled. Use the mode settings UI; model tools cannot change it.");
  // Revocation while identity lookup is pending must not become a fresh grant.
  const generation=this.generation, epoch=this.modes.epoch(), owner=this.owner;
  const mode=await this.modes.mode(ctx);
  if(generation!==this.generation || epoch!==this.modes.epoch() || owner!==this.owner || ctx.signal?.aborted)
   return block("Auto decision expired during mode lookup. The action was not run.");
  if(mode!=="auto") { this.memory.admitted(event,ctx,epoch);return undefined; }
  this.observeAnswers(ctx);
  // Independent executors retain their own consent and delegation authorities.
  if(OWNED_CONTROL_TOOLS.has(event.toolName))return undefined;
  if(this.consecutive>=DENIAL_LIMIT || this.total>=TOTAL_DENIAL_LIMIT || this.unavailable>=DENIAL_LIMIT)
   return block("Auto mode is paused after repeated denials or unavailable checks. Stop this attempt and ask the user for a safer, specific instruction; do not route around the boundary.");
  // Local reads can disclose explicitly forbidden data; they need the same check.
  if(!ctx.model)return block("Auto could not evaluate this action: no session model is available. The action was not run.");
  // Copy identity values: a host can update its model object in place.
  const model={id:ctx.model.id,provider:ctx.model.provider};
  const window=this.trusted(ctx), trustedMessages=window.messages, answeredPrompts=this.answered(ctx,window);
  const omittedTrustedMessages=window.omitted || undefined;
  const branchIds=new Set(this.branch(ctx).map(entry=>entry.id));
  const trustedEntryIds=[...this.requests.flatMap(request=>request.entryId && branchIds.has(request.entryId) ? [request.entryId] : []),
   ...this.liveHostAnswers(ctx).map(answer=>answer.anchor)];
  let serialized: string;
  try {serialized=JSON.stringify(event.input);}catch{return block("Auto could not evaluate invalid tool input. The action was not run.");}
  const memoryContext=this.memory.context(event,ctx,epoch);
  const memoryContextAttached=["mem_save","mem_session_summary"].includes(event.toolName) ? memoryContext !== undefined : undefined;
  const memoryBinding=JSON.stringify(memoryContext);
  const toolContext=this.toolContext(event.toolName),toolBinding=JSON.stringify(toolContext);
  const current=()=>{ try {
   // SDK branch changes must revoke removed input even before a host tree event.
   const currentBranchIds=new Set(this.branch(ctx).map(entry=>entry.id));
   return generation===this.generation && epoch===this.modes.epoch() && owner===this.owner &&
   owner?.manager===ctx.sessionManager && owner.id===ctx.sessionManager.getSessionId() && owner.cwd===ctx.cwd &&
   model.id===ctx.model?.id && model.provider===ctx.model?.provider && JSON.stringify(event.input)===serialized &&
   trustedEntryIds.every(id=>currentBranchIds.has(id)) &&
   JSON.stringify(this.memory.context(event,ctx,epoch))===memoryBinding &&
   JSON.stringify(this.toolContext(event.toolName))===toolBinding;
  } catch {return false;} };
  const paths=evidencePaths(event.toolName,JSON.parse(serialized),ctx.cwd);
  // Canonical cwd allows safe inspection in workspaces reached through /tmp-like aliases.
  const classifierCwd=paths.length ? canonical(ctx.cwd) : ctx.cwd;
  const controller=new AbortController();this.active.add(controller);
  const onAbort=()=>controller.abort();ctx.signal?.addEventListener("abort",onAbort,{once:true});
  if(ctx.signal?.aborted)controller.abort();
  let result: Verdict = {status:"unavailable",code:"provider-error"};
  try {
   // Classification has no side effects, so a transient provider failure is retried within the same live binding.
   for(let attempt=0;attempt<=this.retryDelaysMs.length;attempt++){
    if(attempt>0 && (!(await pause(this.retryDelaysMs[attempt-1],controller.signal)) || !current()))break;
    try {
     result=await this.classifier.run({trustedMessages,...(omittedTrustedMessages ? {omittedTrustedMessages} : {}),answeredPrompts,memoryContext,toolContext,action:{toolName:event.toolName,input:JSON.parse(serialized)},
      priorActions:this.priorActions,evidencePaths:paths,cwd:classifierCwd,model:ctx.model,modelRegistry:ctx.modelRegistry,isCurrent:current,signal:controller.signal,
      onUsage:(late: Omit<Verdict,"status">)=>{
       if(owner?.manager===ctx.sessionManager && owner.id===ctx.sessionManager.getSessionId()) this.record(ctx,event,{...late,status:"settled"},true,memoryContextAttached);
      }});
    }catch{result={status:"unavailable",code:"provider-error"};}
    // Record attempts even when revoked; never transplant old receipts into a replacement session.
    if(owner?.manager===ctx.sessionManager && owner.id===ctx.sessionManager.getSessionId())this.record(ctx,event,result,false,memoryContextAttached);
    if(result.status==="available" || result.code!=="provider-error" || controller.signal.aborted)break;
   }
  }finally{ctx.signal?.removeEventListener("abort",onAbort);this.active.delete(controller);}
  const stillAuto=await this.modes.mode(ctx)==="auto";
  if(!current() || controller.signal.aborted || !stillAuto)return block("Auto decision expired because the action, mode, request or session changed. The action was not run.");
  if(result.status!=="available" || !["allow","deny"].includes(result.decision ?? "")){
   // Contention and revocation are not failed safety judgements or provider outages.
   if(!["busy","cancelled","revoked"].includes(result.code ?? ""))this.unavailable++;
   if(result.code==="provider-error")return block(`Auto could not reach its classifier model (provider error after ${this.retryDelaysMs.length+1} attempts). The action was not run. Retry later, switch the session model, or continue with manual permissions; do not treat a missing verdict as permission or evade this check.`);
   const diagnostic=["timeout","evidence-limit"].includes(result.code ?? "") ? safeDiagnostic(result.diagnostic) : undefined;
   const detail=diagnostic ? ` Diagnostic: ${JSON.stringify(diagnostic)}.` : "";
   return block(`${UNAVAILABLE_REASONS[result.code ?? ""] ?? "Auto received no usable classifier verdict. Retry later or use manual permissions."} The action was not run. A missing verdict is not permission; do not evade this check.${detail}`);
  }
  this.unavailable=0;
  if(result.decision==="deny"){
   this.consecutive++;this.total++;
   // Model reasoning is shown as advice only, never authorization or executable instructions.
   const reason=(result.reason ?? "Outside the authorized safe scope").slice(0,600);
   return block(`Auto denied this action: ${reason}. Find a materially safer alternative within the request, or ask the user; do not pursue the same effect through another tool.`);
  }
  this.consecutive=0;
  this.memory.admitted(event,ctx,epoch);
  // Keep only complete recent records: truncated source could hide side effects. Missing
  // script evidence can be inspected by the reviewer, never inferred from an omitted record.
  const action={toolName:event.toolName,input:JSON.parse(serialized)};
  if(Buffer.byteLength(JSON.stringify([action]))<=HISTORY_BYTES) {
   const history=[...this.priorActions,action];
   while(history.length>HISTORY_ENTRIES || Buffer.byteLength(JSON.stringify(history))>HISTORY_BYTES)history.shift();
   this.priorActions=history;
  }
  return undefined;
 }
}
