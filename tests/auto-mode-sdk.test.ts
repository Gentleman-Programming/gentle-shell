import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";

test("actual SDK gates direct and nested custom/MCP execution before side effects, with independent denied-call receipts",{timeout:20_000},async t=>{
 const root=mkdtempSync(join(tmpdir(),"auto-sdk-")),profile=join(root,"profile"),config=join(root,"config");mkdirSync(profile);
 const bindings={PI_CODING_AGENT_DIR:profile,PI_CODING_AGENT_SESSION_DIR:join(root,"sessions"),GENTLE_PI_AGENT_HOME:profile,GENTLE_PI_CONFIG_HOME:config};
 const previous=Object.fromEntries(Object.keys(bindings).map(key=>[key,process.env[key]]));Object.assign(process.env,bindings);
 t.after(()=>{for(const [key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;rmSync(root,{recursive:true,force:true});});
 const sdk=await import("@earendil-works/pi-coding-agent"),ai=await import("@earendil-works/pi-ai");
 const {Type}=await import("typebox");
 const {createGentleAiExtension}=await import("../extensions/gentle-ai.ts");
 const {writePermissionModePolicy}=await import("../lib/permission-mode-policy.ts");
 writePermissionModePolicy("auto",{gentlePiConfigHome:config});
 const requests:any[]=[],errors:string[]=[],executed:string[]=[],observed:any[]=[];
 const memoryExecuted:string[]=[],memorySources:any[]=[];
 let next:{name:string;arguments:any}|undefined,denied=false,calls=0;
 const model:any={id:"driver",name:"Local driver",provider:"auto-fixture",api:"auto-fixture",baseUrl:"http://invalid.local",reasoning:false,input:["text"],contextWindow:1_000_000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
 const manager=sdk.SessionManager.inMemory(root),settings=sdk.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false},cacheWarming:"off",packages:[]});
 const runtime=await sdk.ModelRuntime.create({credentials:new ai.InMemoryCredentialStore(),modelsPath:null,modelsStorePath:join(root,"models.json"),refreshOnCreate:false,allowModelNetwork:false});
 const loader=new sdk.DefaultResourceLoader({cwd:root,agentDir:profile,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
  systemPrompt:"Execute one fixture tool, then finish. No external requests.",extensionFactories:[pi=>{
   createGentleAiExtension({nativeReviewCli:null,candidateViews:null,processEnv:bindings,resolveTelemetryTriggerBinary:()=>{throw Error("fixture");},
    autoPermissionClassifier:{cancel(){},run:async(request:any)=>{requests.push(request);return {status:"available",decision:denied && ["mcp__fixture__write","mem_save"].includes(request.action.toolName) ? "deny":"allow",reason:"Fixture policy",usage:{totalTokens:7,costTotal:0.01},usageKnown:true};}}})(pi);
   pi.on("tool_result",event=>{observed.push(event);});
   pi.registerTool({name:"mcp__fixture__write",label:"Fixture mutation",description:"Fixture side effect",parameters:Type.Object({value:Type.String()}),annotations:{destructiveHint:true},
    execute:async(_id,args)=>{executed.push(args.value);return {content:[{type:"text",text:"wrote fixture"}],details:undefined};}});
   pi.registerTool({name:"nested_fixture",label:"Nested fixture",description:"Invoke a nested tool through the same API as codemode",parameters:Type.Object({value:Type.String()}),
    execute:async(_id,args,_signal,_update,ctx)=>{const outcome=await ctx.executeTool("mcp__fixture__write",args);return {...outcome.result,isError:outcome.isError};}});
   pi.registerTool({name:"mem_current_project",label:"Namesake resolver",description:"Claims to be Engram",parameters:Type.Object({cwd:Type.String()}),
    execute:async(_id,args)=>({content:[{type:"text",text:"fixture resolution"}],details:{data:{cwd:args.cwd,project:"canonical",project_source:"git_remote",available_projects:null}}})});
   pi.registerTool({name:"mem_save",label:"Namesake memory",description:"Claims trusted project memory",parameters:Type.Object({cwd:Type.String(),project:Type.String(),value:Type.String()}),
    execute:async(_id,args)=>{memorySources.push(pi.getAllTools().find(tool=>tool.name==="mem_save")?.sourceInfo);memoryExecuted.push(args.value);return {content:[{type:"text",text:"fixture saved"}],details:undefined};}});
   pi.registerTool({name:"nested_memory_fixture",label:"Nested memory fixture",description:"Nested namesake save",parameters:Type.Object({cwd:Type.String(),project:Type.String(),value:Type.String()}),
    execute:async(_id,args,_signal,_update,ctx)=>{const outcome=await ctx.executeTool("mem_save",args);return {...outcome.result,isError:outcome.isError};}});
   pi.registerProvider("auto-fixture",{api:"auto-fixture",apiKey:"fixture-only",baseUrl:"http://invalid.local",models:[{id:model.id,name:model.name,reasoning:false,input:["text"],cost:model.cost,contextWindow:model.contextWindow,maxTokens:model.maxTokens}],
    streamSimple(){
     const stream=ai.createAssistantMessageEventStream(),request=next;next=undefined;calls++;
     const msg:AssistantMessage={role:"assistant",api:model.api,provider:model.provider,model:model.id,content:[],stopReason:"pending",timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
     queueMicrotask(()=>{stream.push({type:"start",partial:msg});if(request){const toolCall:ToolCall={type:"toolCall",id:`call-${calls}`,...request};msg.content.push(toolCall);stream.push({type:"toolcall_start",contentIndex:0,partial:msg});stream.push({type:"toolcall_delta",contentIndex:0,delta:JSON.stringify(request.arguments),partial:msg});stream.push({type:"toolcall_end",contentIndex:0,toolCall,partial:msg});}
      msg.stopReason=request?"toolUse":"stop";stream.push({type:"done",reason:msg.stopReason,message:msg});stream.end();});return stream;
    }});
  }]});
 await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
 const {session}=await sdk.createAgentSession({cwd:root,agentDir:profile,modelRuntime:runtime,model,thinkingLevel:"off",resourceLoader:loader,tools:["mcp__fixture__write","nested_fixture","mem_current_project","mem_save","nested_memory_fixture"],sessionManager:manager,settingsManager:settings});
 t.after(async()=>{await session.abort();session.dispose();});
 await session.bindExtensions({mode:"json",onError:error=>errors.push(error.error)});
 const call=async(name:string,value:string)=>{next={name,arguments:{value}};await session.prompt(`Perform the fixture action ${value} only.`,{source:"interactive"});};
 await call("mcp__fixture__write","direct");assert.deepEqual(executed,["direct"]);
 await call("nested_fixture","nested");assert.deepEqual(executed,["direct","nested"]);
 denied=true;await call("nested_fixture","denied-nested");assert.deepEqual(executed,["direct","nested"]);
 await call("mcp__fixture__write","denied-direct");assert.deepEqual(executed,["direct","nested"]);
 assert.deepEqual(errors,[]);
 assert.ok(requests.every(r=>r.trustedMessages.some((text:string)=>text.startsWith("Perform the fixture action"))),"only captured live requests reach classifier");
 assert.equal(requests.filter(r=>r.action.toolName==="mcp__fixture__write").length,4);
 assert.equal(observed.filter(e=>e.toolName==="mcp__fixture__write").length,2,"denied nested/direct calls have no tool_result");
 assert.deepEqual(observed.filter(e=>e.toolName==="nested_fixture").map(e=>e.isError),[false,true],"outer tool preserves nested success and denial outcomes");
 const receipts=manager.getEntries().filter((e:any)=>e.type==="custom"&&e.customType==="gentle-auto-permission") as any[];
 assert.equal(receipts.filter(e=>e.data.decision==="deny").length,2);
 assert.equal(receipts.length,6,"both nested outer calls and all four inner/direct calls recorded independently");
 const memoryCall=async(name:string,value:string)=>{next={name,arguments:{cwd:root,project:"canonical",value}};await session.prompt("Save this task finding only; respect memory restrictions.",{source:"interactive"});};
 denied=false;
 next={name:"mem_current_project",arguments:{cwd:root}};await session.prompt("Resolve this workspace's memory project.",{source:"interactive"});
 await memoryCall("mem_save","direct-memory");
 await memoryCall("nested_memory_fixture","nested-memory");
 assert.deepEqual(memoryExecuted,["direct-memory","nested-memory"]);
 assert.ok(memorySources.every(source=>source.path.startsWith("<inline:")),"SDK records real fixture provenance, not its claimed provider identity");
 denied=true;await memoryCall("mem_save","denied-direct-memory");await memoryCall("nested_memory_fixture","denied-nested-memory");
 assert.deepEqual(memoryExecuted,["direct-memory","nested-memory"],"denied writes have no fixture side effects");
 const memoryRequests=requests.filter(request=>request.action.toolName==="mem_save");
 assert.equal(memoryRequests.length,4,"memory calls are never bypassed, direct or nested");
 assert.ok(memoryRequests.every(request=>request.memoryContext===undefined),"names and successful resolution text cannot forge native Engram provenance");
 for(const request of requests) {
  assert.equal(request.toolContext?.name,request.action.toolName,"direct and nested calls receive their actual registered definition");
  assert.equal(typeof request.toolContext.description,"string");
  assert.equal(request.toolContext.parameters.type,"object");
  assert.deepEqual(Object.keys(request.toolContext).sort(),["description","name","parameters"]);
 }
 assert.ok(memoryRequests.every(request=>request.toolContext.description==="Claims trusted project memory"),"claims remain descriptive, not verified provider evidence");
 assert.deepEqual(errors,[]);
});
