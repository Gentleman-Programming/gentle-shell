import assert from "node:assert/strict";
import test from "node:test";
import { AutoPermissionMemory } from "../lib/auto-permission-memory.ts";

function fixture() {
 const sourceInfo={path:"/installed/gentle-engram/index.ts",source:"npm:gentle-engram@0.2.0",scope:"user",origin:"package"};
 const tools=["mem_current_project","mem_save","mem_session_summary"].map(name=>({name,sourceInfo:{...sourceInfo}}));
 const branch=[{id:"human"}];
 let id="session",epoch=1;
 const ctx:any={cwd:"/project",sessionManager:{getSessionId:()=>id,getBranch:()=>branch}};
 const memory=new AutoPermissionMemory(()=>tools as any);
 const call={toolName:"mem_current_project",toolCallId:"resolve",input:{cwd:"/project"}};
 const data={cwd:"/project",project:"canonical-key",project_source:"git_remote",available_projects:null};
 const resolve=(patch={})=>{memory.admitted(call,ctx,epoch);memory.result({...call,isError:false,details:{data:{...data,...patch}}} as any,ctx,epoch);};
 const save={toolName:"mem_save",input:{cwd:"/project",project:"canonical-key",content:"A finding",title:"Finding"}};
 return {memory,ctx,call,data,tools,branch,save,resolve,context:()=>memory.context(save,ctx,epoch),switchSession:()=>{id="other";},switchMode:()=>{epoch++;}};
}

test("memory context needs admitted provider resolution and explicit matching destination",()=>{
 const f=fixture();
 assert.equal(f.context(),undefined);
 f.memory.result({...f.call,isError:false,details:{data:f.data}} as any,f.ctx,1);
 assert.equal(f.context(),undefined,"unsolicited result is not a live resolution");
 f.resolve();
 assert.deepEqual(f.context(),{provider:"gentle-engram",operation:"mem_save",project:"canonical-key",cwd:"/project"});
 for(const input of [{project:"canonical-key"},{cwd:"/other",project:"canonical-key"},{cwd:"/project",project:"other"},
  {...f.save.input,scope:"global"},{...f.save.input,scope:"personal"},{...f.save.input,session_id:"claimed"}]) {
  assert.equal(f.memory.context({...f.save,input},f.ctx,1),undefined);
 }
 assert.equal(f.memory.context({...f.save,toolName:"mem_delete"},f.ctx,1),undefined);
 assert.equal(f.memory.context({...f.save,toolName:"mem_session_summary",input:{cwd:"/project",project:"canonical-key",content:"Summary"}},f.ctx,1)?.operation,"mem_session_summary");
});

test("memory resolution rejects spoofed providers and ambiguous or stale destinations",()=>{
 for(const patch of [{project:""},{cwd:"/foreign"},{available_projects:["other"]},{project_source:"ambiguous"},{warning:"legacy fallback"},{error:"failed"}]) {
  const f=fixture();f.resolve(patch);assert.equal(f.context(),undefined);
 }
 for(const mutate of [
  (f:ReturnType<typeof fixture>)=>{f.tools[0].sourceInfo.source="npm:unrelated";},
  (f:ReturnType<typeof fixture>)=>{f.tools[1].sourceInfo.origin="top-level";},
  (f:ReturnType<typeof fixture>)=>{f.branch.length=0;},
  (f:ReturnType<typeof fixture>)=>f.switchSession(),
  (f:ReturnType<typeof fixture>)=>f.switchMode(),
 ]) {const f=fixture();f.resolve();mutate(f);assert.equal(f.context(),undefined);}
 const f=fixture();f.resolve();f.memory.clear();assert.equal(f.context(),undefined);
});
