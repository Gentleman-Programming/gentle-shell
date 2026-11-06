import assert from "node:assert/strict";
import test from "node:test";
import { AutoPermissionRuntime } from "../lib/auto-permission-runtime.ts";

test("bounded compound evidence preserves the original action and denial",async()=>{
 const requests:any[]=[];const entries:any[]=[];let decision="deny";
 const ctx:any={cwd:process.cwd(),sessionManager:{getSessionId:()=>"compound",getBranch:()=>entries},model:{id:"fixture",provider:"fixture"},ui:{setStatus(){}}};
 const runtime=new AutoPermissionRuntime({appendEntry(){}} as any,{mode:async()=>"auto",epoch:()=>1},
 {run:async(request:any)=>{requests.push(request);return {status:"available",decision,reason:"Fixture verdict"};},cancel(){}}, {configHome:process.cwd()+"/config"});
 runtime.input({text:"Verify the authorized change.",source:"interactive"},ctx);
 entries.push({id:"human",type:"message",message:{role:"user",content:"Verify the authorized change."}});
 const command="node scripts/check-types.mjs && git diff --check";
 assert.equal((await runtime.check({toolName:"bash",toolCallId:"compound",input:{command}},ctx))?.block,true);
 assert.deepEqual(requests.at(-1).evidencePaths,["scripts/check-types.mjs"]);
 assert.deepEqual(requests.at(-1).action.input,{command});
 decision="allow"; // Exercise selection without exhausting the denial counter.
 for(const command of ["node scripts/check-types.mjs && cd other","node scripts/check-types.mjs || git diff --check","node scripts/check-types.mjs && node -e 'run()'","node scripts/check-types.mjs && git diff --output=other","node scripts/check-types.mjs &&", "node scripts/check-types.mjs && node --cwd other test.js"]) {
  const before=requests.length;
  await runtime.check({toolName:"bash",toolCallId:command,input:{command}},ctx);
  assert.equal(requests.length,before+1,"each negative grammar case reaches classification");
  assert.deepEqual(requests.at(-1).evidencePaths,[],command);
 }
 runtime.reset();
});
