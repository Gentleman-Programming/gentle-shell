import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import choiceExtension from "../extensions/ask-user-choice.ts";
import questionnaireExtension from "../extensions/ask-user-question.ts";

for (const toolName of ["ask_user_choice", "ask_user_question"] as const) {
 test(`public ${toolName} UI answer unpauses Auto without synthetic input`, async t => {
  const root=mkdtempSync(join(tmpdir(),"auto-human-answer-")), home=join(root,"config");
  mkdirSync(home);t.after(()=>rmSync(root,{recursive:true,force:true}));
  const manager=SessionManager.inMemory(root);
  const hooks=new Map<string,any[]>(), commands=new Map<string,any>(), tools=new Map<string,any>();
  const requests:any[]=[];
  let allow=false;
  const pi:any={
   events:{on(){return ()=>{};},emit(){}},
   on(name:string,fn:any){hooks.set(name,[...hooks.get(name)??[],fn]);},
   registerTool(tool:any){tools.set(tool.name,tool);},
   registerCommand(name:string,command:any){commands.set(name,command);},
   registerFlag(){},registerMessageRenderer(){},getActiveTools(){return [];},appendEntry(){},
  };
  const ctx:any={cwd:root,mode:"tui",hasUI:true,sessionManager:manager,model:{id:"fixture",provider:"fixture"},
   signal:new AbortController().signal,
   ui:{notify(){},setStatus(){},setWidget(){},confirm:async()=>false,
    custom:async()=>toolName==="ask_user_choice" ? {index:1,label:"Yes",value:"opaque-choice"} :
     {cancelled:false,answers:[{questionIndex:0,question:"May I edit source.ts?",kind:"option",answer:"Yes"}]}},
  };
  createGentleAiExtension({processEnv:{GENTLE_PI_CONFIG_HOME:home},nativeReviewCli:null,candidateViews:null,
   autoPermissionClassifier:{cancel(){},async run(request:any){requests.push(request);return {status:"available",decision:allow?"allow":"deny",reason:"Fixture scope"};}},
   resolveTelemetryTriggerBinary:()=>{throw Error("native disabled in fixture");},
  })(pi);
  choiceExtension(pi);questionnaireExtension(pi);
  const emit=async(name:string,event:any)=>{
   let output:any;
   for(const hook of hooks.get(name)??[]){const next=await hook(event,ctx);if(next!==undefined)output=next;}
   return output;
  };
  await commands.get("gentle:mode").handler("auto",ctx);
  await emit("input",{source:"interactive",text:"Inspect only; ask before editing."});
  manager.appendMessage({role:"user",content:"Inspect only; ask before editing.",timestamp:1});
  const action={toolName:"write",toolCallId:"edit",input:{path:join(root,"source.ts"),content:"x"}};
  for(let i=0;i<3;i++)assert.equal((await emit("tool_call",action))?.block,true);
  assert.match((await emit("tool_call",action)).reason,/paused/);
  const question="May I edit source.ts?";
  const options=[{label:"Yes",description:"Edit source.ts only; do not publish.",value:"opaque-choice"},
   {label:"No",description:"Keep this task read-only.",value:"opaque-no"}];
  const args=toolName==="ask_user_choice" ? {question,options} :
   {questions:[{question,header:"Scope",options:options.map(({label,description})=>({label,description}))}]};
  manager.appendMessage({role:"assistant",content:[{type:"toolCall",id:"question",name:toolName,arguments:args}],
   api:"fixture" as any,provider:"fixture",model:"fixture",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"toolUse",timestamp:2});
  assert.equal((await emit("tool_call",{toolName,toolCallId:"question",input:args}))?.block,undefined);
  const result=await tools.get(toolName).execute("question",args,ctx.signal,undefined,ctx);
  assert.ok(result.content.length>0,"the original question result is retained");
  allow=true;
  assert.equal((await emit("tool_call",action))?.block,undefined);
  assert.deepEqual(requests.at(-1).trustedMessages,["Inspect only; ask before editing.","Yes"]);
  const pair=requests.at(-1).answeredPrompts.find((item:any)=>item.reply==="Yes");
  assert.match(pair.prompt,/Edit source.ts only; do not publish\./);
  assert.ok(!pair.prompt.includes("opaque-choice"));
  await emit("session_tree",{});
  await emit("tool_call",action);
  assert.deepEqual(requests.at(-1).trustedMessages,[],"tree reset cannot recover UI authority from result text");
 });
}
