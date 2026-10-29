import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

function harness(t:test.TestContext) {
 const home=mkdtempSync(join(tmpdir(),"auto-hook-"));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const previous=process.env.GENTLE_PI_CONFIG_HOME;process.env.GENTLE_PI_CONFIG_HOME=home;
 t.after(()=>{if(previous===undefined)delete process.env.GENTLE_PI_CONFIG_HOME;else process.env.GENTLE_PI_CONFIG_HOME=previous;});
 const commands=new Map<string,any>(),handlers=new Map<string,any[]>(),entries:any[]=[],requests:any[]=[],records:any[]=[];
 let confirmations=0,decision="allow";
 const ctx:any={cwd:process.cwd(),mode:"tui",hasUI:true,sessionManager:{getSessionId:()=>"auto-test",getBranch:()=>entries},
  model:{provider:"test",id:"test"},modelRegistry:{},ui:{notify(){},setStatus(){},setWidget(){},confirm:async()=>{confirmations++;return false;}}};
 const pi:any={on(name:string,fn:any){handlers.set(name,[...handlers.get(name)??[],fn]);},registerCommand(name:string,v:any){commands.set(name,v);},
  registerTool(){},registerMessageRenderer(){},registerFlag(){},events:{emit(){},on(){return ()=>{};}},getActiveTools:()=>[],appendEntry:(...v:any[])=>records.push(v)};
 createGentleAiExtension({nativeReviewCli:null,candidateViews:null,processEnv:{GENTLE_PI_CONFIG_HOME:home},
  resolveTelemetryTriggerBinary:()=>{throw Error("fixture");},autoPermissionClassifier:{cancel(){},run:async(request:any)=>{requests.push(request);return {status:"available",decision,reason:"Fixture",usage:{totalTokens:3}};}}} as any)(pi);
 const emit=async(name:string,event:any)=>{let output:any;for(const fn of handlers.get(name)??[]){const value=await fn(event,ctx);if(value!==undefined)output=value;}return output;};
 return {home,ctx,commands,requests,records,confirmations:()=>confirmations,setDecision:(v:string)=>decision=v,emit,
  enable:async()=>{assert.ok(commands.get("gentle:mode"));await commands.get("gentle:mode").handler("auto",ctx);},
  input:async(text:string)=>{await emit("input",{text,source:"interactive"});entries.push({type:"message",id:"human-1",message:{role:"user",content:text}});},
  call:(toolName:string,input:any)=>emit("tool_call",{toolName,input,toolCallId:"call"})};
}

test("production hook Auto reviews eligible default confirmations and all tool families without per-call questions",async t=>{
 const h=harness(t);await h.enable();await h.input("Implement my change, run tests, and push this branch.");
 for(const tool of ["bash","bash_background","monitor"]){assert.equal(await h.call(tool,{command:"git push origin feature"}),undefined);}
 for(const tool of ["powershell","mcp__fixture__update","custom_tool","codemode"]){assert.equal(await h.call(tool,{command:"local work"}),undefined);}
 assert.equal(h.requests.length,7);assert.equal(h.confirmations(),0);assert.equal(h.records.length,7);
 h.setDecision("deny");assert.equal((await h.call("custom_tool",{action:"publish"})).block,true);
});

test("Auto cannot bypass data-loss, configured confirmation, protected paths or independent consent",async t=>{
 const h=harness(t);await h.enable();await h.input("Implement the feature");
 assert.equal((await h.call("bash",{command:"git reset --hard"})).block,true);assert.equal(h.confirmations(),0,"existing unconditional destructive block remains");assert.equal(h.requests.length,0);
 writeFileSync(join(h.home,"runtime-guardrails.json"),JSON.stringify({guardedCommands:{gitPush:"confirm"}}));
 assert.equal((await h.call("bash",{command:"git push origin feature"})).block,true);assert.equal(h.confirmations(),1);assert.equal(h.requests.length,0);
 assert.equal((await h.call("write",{path:join(h.home,"permission-mode.json"),content:"yolo"})).block,true);
 for(const tool of ["gentle_review","gentle_review_capture","ask_user_choice"]){assert.equal(await h.call(tool,{}),undefined);}
 assert.equal(h.requests.length,0);
});

test("production hook classifies companion updates without granting permission to change authority",async t=>{
 const h=harness(t);await h.enable();await h.input("Update the installed companion tools from main; preserve permissions.");
 for(const toolName of ["write","edit"]) {
  assert.equal(await h.call(toolName,{path:join(h.home,"dev-binary.json"),content:"fixture companion update"}),undefined);
 }
 assert.equal(h.requests.length,2,"updates reach the ordinary Auto classifier");
 h.setDecision("deny");
 assert.equal((await h.call("write",{path:join(h.home,"channel.json"),content:"unapproved"})).block,true);
 assert.equal(h.requests.length,3);
 h.setDecision("allow");
 for(const name of ["permission-mode.json","runtime-guardrails.json","models.json","persona.json"]) {
  assert.equal((await h.call("write",{path:join(h.home,name),content:"{}"})).block,true);
 }
 assert.equal(h.requests.length,3,"a classifier allow cannot override protected authority");
 assert.equal(h.confirmations(),0);
});

test("normal mode preserves previous guard behavior and named children do not inherit Auto",async t=>{
 const h=harness(t);assert.equal((await h.call("bash",{command:"git push origin feature"})).block,true);assert.equal(h.requests.length,0);
 await h.enable();await h.emit("before_agent_start",{agent:{name:"worker"},systemPromptOptions:{}});
 assert.equal((await h.call("bash",{command:"git push origin feature"})).block,true);assert.equal(h.requests.length,0);
});
