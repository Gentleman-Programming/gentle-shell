import type { ExtensionContext, ToolCallEvent, ToolInfo, ToolResultEvent } from "@earendil-works/pi-coding-agent";

export interface AutoPermissionMemoryContext {
 provider: "gentle-engram";
 operation: "mem_save" | "mem_session_summary";
 project: string;
 cwd: string;
}
/** First failed provenance predicate, in evaluation order. */
export type AutoPermissionMemorySourceRejection = "tool-missing" | "tool-ambiguous" | "metadata-missing" | "origin" | "source-format" | "path";
/** Closed, content-free observation of the latest binder decision; never an authorization input. */
export type AutoPermissionMemoryDiagnostic =
 | {stage:"admission" | "write"; reason:"untrusted-source"; sourceRejection:AutoPermissionMemorySourceRejection}
 | ({sourceRejection?:undefined} & (
  | {stage:"admission"; reason:"admitted" | "invalid-request" | "unexpected-error"}
  | {stage:"resolution"; reason:"bound" | "provider-error" | "stale-identity" | "invalid-request" | "invalid-result" | "unexpected-error"}
  | {stage:"write"; reason:"attached" | "stale-binding" | "source-mismatch" | "destination-mismatch" | "invalid-arguments" | "unexpected-error"}
  | {stage:"clear"; reason:"binding-cleared"}));
type Call = Pick<ToolCallEvent,"toolName"|"input"|"toolCallId">;
type Identity = {manager: ExtensionContext["sessionManager"]; id:string; cwd:string; epoch:number; anchor:string; source:string};
type Source = {source:string; rejection?:undefined} | {source?:undefined; rejection:AutoPermissionMemorySourceRejection};
/** Live native-provider evidence only: never restore bindings from transcript text. */
export class AutoPermissionMemory {
 private readonly tools: () => ToolInfo[];
 constructor(tools: () => ToolInfo[]) { this.tools=tools; }
 private pending?: Identity & {callId:string};
 private binding?: Identity & {project:string};
 private last?: AutoPermissionMemoryDiagnostic;
 /** Snapshot of the latest decision; mutating it never affects the binder. */
 diagnostic(): AutoPermissionMemoryDiagnostic | undefined { return this.last && {...this.last}; }
 clear(): void { this.reset();this.last={stage:"clear",reason:"binding-cleared"}; }
 private reset(): void { this.pending=undefined;this.binding=undefined; }
 private inspect(name:string):Source {
  const matches=this.tools().filter(tool=>tool.name===name);
  if(matches.length!==1)return {rejection:matches.length ? "tool-ambiguous" : "tool-missing"};
  const s=matches[0].sourceInfo;
  if(!s)return {rejection:"metadata-missing"};
  if(s.origin!=="package")return {rejection:"origin"};
  if(!/^npm:gentle-engram(?:@[^\s/]+)?$/.test(s.source))return {rejection:"source-format"};
  if(typeof s.path!=="string" || !s.path || s.path.startsWith("builtin:") || s.path.startsWith("<"))return {rejection:"path"};
  return {source:JSON.stringify([s.path,s.source,s.scope,s.origin,s.baseDir ?? null])};
 }
 private source(name:string):string|undefined { return this.inspect(name).source; }
 private valid(value:Identity,ctx:ExtensionContext,epoch:number):boolean {
  return value.manager===ctx.sessionManager && value.id===ctx.sessionManager.getSessionId() && value.cwd===ctx.cwd &&
   value.epoch===epoch && this.source("mem_current_project")===value.source &&
   ctx.sessionManager.getBranch().some(entry=>entry.id===value.anchor);
 }
 admitted(event:Call,ctx:ExtensionContext,epoch:number):void {
  if(event.toolName!=="mem_current_project")return;
  this.reset();
  try {
   const {source,rejection}=this.inspect(event.toolName),id=ctx.sessionManager.getSessionId();
   const args=event.input as Record<string,unknown>;
   const anchor=ctx.sessionManager.getBranch().at(-1)?.id;
   if(rejection){this.last={stage:"admission",reason:"untrusted-source",sourceRejection:rejection};return;}
   if(!source || !id || !anchor || !args || args.cwd!==ctx.cwd ||
    Object.keys(args).some(key=>key!=="cwd")){this.last={stage:"admission",reason:"invalid-request"};return;}
   this.pending={manager:ctx.sessionManager,id,cwd:ctx.cwd,epoch,anchor,source,callId:event.toolCallId};
   this.last={stage:"admission",reason:"admitted"};
  } catch { this.reset();this.last={stage:"admission",reason:"unexpected-error"}; }
 }
 result(event:ToolResultEvent,ctx:ExtensionContext,epoch:number):void {
  if(event.toolName!=="mem_current_project")return;
  const pending=this.pending;
  if(!pending || event.toolCallId!==pending.callId)return;
  this.reset();
  try {
   if(event.isError){this.last={stage:"resolution",reason:"provider-error"};return;}
   if(!this.valid(pending,ctx,epoch)){this.last={stage:"resolution",reason:"stale-identity"};return;}
   if((event.input as Record<string,unknown>)?.cwd!==ctx.cwd){this.last={stage:"resolution",reason:"invalid-request"};return;}
   const data=(event.details as {data?:Record<string,unknown>} | undefined)?.data;
   if(!data || data.cwd!==ctx.cwd || typeof data.project!=="string" || !data.project.trim() || data.project.length>256 ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(data.project) || typeof data.project_source!=="string" || !["git_remote","dir_basename"].includes(data.project_source) ||
    (data.available_projects!=null && (!Array.isArray(data.available_projects) || data.available_projects.length>0)) ||
    Object.keys(data).some(key=>/error|warning|fallback/i.test(key))){this.last={stage:"resolution",reason:"invalid-result"};return;}
   this.binding={...pending,project:data.project};
   this.last={stage:"resolution",reason:"bound"};
  } catch { this.reset();this.last={stage:"resolution",reason:"unexpected-error"}; }
 }
 /** Without a binding the diagnostic keeps the cause that prevented one. */
 context(event:Pick<Call,"toolName"|"input">,ctx:ExtensionContext,epoch:number):AutoPermissionMemoryContext|undefined {
  try {
   if(event.toolName!=="mem_save" && event.toolName!=="mem_session_summary")return undefined;
   const binding=this.binding,args=event.input as Record<string,unknown>;
   if(!binding)return undefined;
   if(!this.valid(binding,ctx,epoch)){this.last={stage:"write",reason:"stale-binding"};return undefined;}
   const {source,rejection}=this.inspect(event.toolName);
   if(rejection){this.last={stage:"write",reason:"untrusted-source",sourceRejection:rejection};return undefined;}
   if(source!==binding.source){this.last={stage:"write",reason:"source-mismatch"};return undefined;}
   if(!args || args.cwd!==ctx.cwd || args.project!==binding.project || (args.scope!==undefined && args.scope!=="project")){
    this.last={stage:"write",reason:"destination-mismatch"};return undefined;}
   const allowed=event.toolName==="mem_save" ? ["cwd","project","title","content","type","scope","topic_key","capture_prompt"] : ["cwd","project","content"];
   if(Object.keys(args).some(key=>!allowed.includes(key))){this.last={stage:"write",reason:"invalid-arguments"};return undefined;}
   this.last={stage:"write",reason:"attached"};
   return {provider:"gentle-engram",operation:event.toolName,project:binding.project,cwd:binding.cwd};
  } catch { this.last={stage:"write",reason:"unexpected-error"};return undefined; }
 }
}
