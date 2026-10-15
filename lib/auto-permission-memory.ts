import type { ExtensionContext, ToolCallEvent, ToolInfo, ToolResultEvent } from "@earendil-works/pi-coding-agent";

export interface AutoPermissionMemoryContext {
 provider: "gentle-engram";
 operation: "mem_save" | "mem_session_summary";
 project: string;
 cwd: string;
}
type Call = Pick<ToolCallEvent,"toolName"|"input"|"toolCallId">;
type Identity = {manager: ExtensionContext["sessionManager"]; id:string; cwd:string; epoch:number; anchor:string; source:string};
/** Live native-provider evidence only: never restore bindings from transcript text. */
export class AutoPermissionMemory {
 private readonly tools: () => ToolInfo[];
 constructor(tools: () => ToolInfo[]) { this.tools=tools; }
 private pending?: Identity & {callId:string};
 private binding?: Identity & {project:string};
 clear(): void { this.pending=undefined;this.binding=undefined; }
 private source(name:string):string|undefined {
  const matches=this.tools().filter(tool=>tool.name===name);
  if(matches.length!==1)return undefined;
  const s=matches[0].sourceInfo;
  if(!s || s.origin!=="package" || !/^npm:gentle-engram(?:@[^\s/]+)?$/.test(s.source) ||
   typeof s.path!=="string" || !s.path || s.path.startsWith("builtin:") || s.path.startsWith("<"))return undefined;
  return JSON.stringify([s.path,s.source,s.scope,s.origin,s.baseDir ?? null]);
 }
 private valid(value:Identity,ctx:ExtensionContext,epoch:number):boolean {
  return value.manager===ctx.sessionManager && value.id===ctx.sessionManager.getSessionId() && value.cwd===ctx.cwd &&
   value.epoch===epoch && this.source("mem_current_project")===value.source &&
   ctx.sessionManager.getBranch().some(entry=>entry.id===value.anchor);
 }
 admitted(event:Call,ctx:ExtensionContext,epoch:number):void {
  if(event.toolName!=="mem_current_project")return;
  this.clear();
  try {
   const source=this.source(event.toolName),id=ctx.sessionManager.getSessionId();
   const args=event.input as Record<string,unknown>;
   const anchor=ctx.sessionManager.getBranch().at(-1)?.id;
   if(!source || !id || !anchor || !args || args.cwd!==ctx.cwd ||
    Object.keys(args).some(key=>key!=="cwd"))return;
   this.pending={manager:ctx.sessionManager,id,cwd:ctx.cwd,epoch,anchor,source,callId:event.toolCallId};
  } catch { this.clear(); }
 }
 result(event:ToolResultEvent,ctx:ExtensionContext,epoch:number):void {
  if(event.toolName!=="mem_current_project")return;
  const pending=this.pending;
  if(!pending || event.toolCallId!==pending.callId)return;
  this.clear();
  try {
   if(event.isError || !this.valid(pending,ctx,epoch) || (event.input as Record<string,unknown>)?.cwd!==ctx.cwd)return;
   const data=(event.details as {data?:Record<string,unknown>} | undefined)?.data;
   if(!data || data.cwd!==ctx.cwd || typeof data.project!=="string" || !data.project.trim() || data.project.length>256 ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(data.project) || typeof data.project_source!=="string" || !["git_remote","dir_basename"].includes(data.project_source) ||
    (data.available_projects!=null && (!Array.isArray(data.available_projects) || data.available_projects.length>0)) ||
    Object.keys(data).some(key=>/error|warning|fallback/i.test(key)))return;
   this.binding={...pending,project:data.project};
  } catch { this.clear(); }
 }
 context(event:Pick<Call,"toolName"|"input">,ctx:ExtensionContext,epoch:number):AutoPermissionMemoryContext|undefined {
  try {
   if(event.toolName!=="mem_save" && event.toolName!=="mem_session_summary")return undefined;
   const binding=this.binding,args=event.input as Record<string,unknown>;
   if(!binding || !this.valid(binding,ctx,epoch) || this.source(event.toolName)!==binding.source ||
    !args || args.cwd!==ctx.cwd || args.project!==binding.project || (args.scope!==undefined && args.scope!=="project"))return undefined;
   const allowed=event.toolName==="mem_save" ? ["cwd","project","title","content","type","scope","topic_key","capture_prompt"] : ["cwd","project","content"];
   if(Object.keys(args).some(key=>!allowed.includes(key)))return undefined;
   return {provider:"gentle-engram",operation:event.toolName,project:binding.project,cwd:binding.cwd};
  } catch { return undefined; }
 }
}
