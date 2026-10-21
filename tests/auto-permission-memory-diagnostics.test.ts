import assert from "node:assert/strict";
import test from "node:test";
import { AutoPermissionMemory } from "../lib/auto-permission-memory.ts";
test("binder diagnostics retain rejection cause without destination or content",()=>{
 const memory=new AutoPermissionMemory(()=>[]);
 const ctx:any={cwd:"PRIVATE_CWD",sessionManager:{getSessionId:()=>"PRIVATE_SESSION",getBranch:()=>[{id:"PRIVATE_ANCHOR"}]}};
 memory.admitted({toolName:"mem_current_project",toolCallId:"PRIVATE_CALL",input:{cwd:ctx.cwd}},ctx,1);
 memory.context({toolName:"mem_save",input:{cwd:ctx.cwd,project:"PRIVATE_PROJECT",content:"PRIVATE_CONTENT"}},ctx,1);
 assert.deepEqual(memory.diagnostic(),{stage:"admission",reason:"untrusted-source",sourceRejection:"tool-missing"});
 assert.doesNotMatch(JSON.stringify(memory.diagnostic()),/PRIVATE/);
 memory.clear();
 memory.context({toolName:"mem_session_summary",input:{}},ctx,1);
 assert.deepEqual(memory.diagnostic(),{stage:"clear",reason:"binding-cleared"});
});

test("source rejection reports only the first failed provenance predicate",()=>{
 const sourceInfo={path:"/installed/engram.ts",source:"npm:gentle-engram@latest",scope:"user",origin:"package"};
 const tool={name:"mem_current_project",sourceInfo};
 const cases:[string,any[]][]=[
  ["tool-missing",[]],["tool-ambiguous",[tool,tool]],
  ["metadata-missing",[{name:tool.name}]],
  ["origin",[{...tool,sourceInfo:{...sourceInfo,origin:"top-level",source:"local"}}]],
  ["source-format",[{...tool,sourceInfo:{...sourceInfo,source:"PRIVATE_SOURCE"}}]],
  ["path",[{...tool,sourceInfo:{...sourceInfo,path:"<PRIVATE_PATH>"}}]],
 ];
 const ctx:any={cwd:"/project",sessionManager:{getSessionId:()=>"session",getBranch:()=>[{id:"human"}]}};
 const call={toolName:tool.name,toolCallId:"resolve",input:{cwd:ctx.cwd}};
 for(const [sourceRejection,tools] of cases){
  const memory=new AutoPermissionMemory(()=>tools);
  memory.admitted(call,ctx,1);
  assert.deepEqual(memory.diagnostic(),{stage:"admission",reason:"untrusted-source",sourceRejection});
  memory.context({toolName:"mem_save",input:{}},ctx,1);
  assert.equal(memory.diagnostic()?.sourceRejection,sourceRejection);
  assert.doesNotMatch(JSON.stringify(memory.diagnostic()),/PRIVATE/);
 }
 const memory=new AutoPermissionMemory(()=>[tool] as any);
 memory.admitted(call,ctx,1);
 assert.deepEqual(memory.diagnostic(),{stage:"admission",reason:"admitted"});
});

test("registry exceptions replace successful attachment diagnostics",()=>{
 let fail=false;
 const sourceInfo={path:"/installed/engram.ts",source:"npm:gentle-engram",scope:"user",origin:"package"};
 const memory=new AutoPermissionMemory(()=>{if(fail)throw Error("PRIVATE_ERROR");return ["mem_current_project","mem_save"].map(name=>({name,sourceInfo})) as any;});
 const ctx:any={cwd:"/project",sessionManager:{getSessionId:()=>"session",getBranch:()=>[{id:"human"}]}};
 const call={toolName:"mem_current_project",toolCallId:"resolve",input:{cwd:ctx.cwd}};
 memory.admitted(call,ctx,1);
 memory.result({...call,isError:false,details:{data:{cwd:ctx.cwd,project:"project",project_source:"git_remote"}}} as any,ctx,1);
 const save={toolName:"mem_save",input:{cwd:ctx.cwd,project:"project"}};
 assert.ok(memory.context(save,ctx,1));
 assert.deepEqual(memory.diagnostic(),{stage:"write",reason:"attached"});
 fail=true;
 assert.equal(memory.context(save,ctx,1),undefined);
 assert.deepEqual(memory.diagnostic(),{stage:"write",reason:"unexpected-error"});
 assert.doesNotMatch(JSON.stringify(memory.diagnostic()),/PRIVATE/);
});
