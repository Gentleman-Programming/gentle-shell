import assert from "node:assert/strict";
import test from "node:test";
import shell from "../extensions/gentle-shell.ts";
import { SESSION_CHANGE_ENTRY, SESSION_CHANGE_EVENT } from "../lib/session-changes.ts";

function fixture(entries: any[] = []) {
	const handlers = new Map<string, Function[]>(), listeners = new Map<string, Function[]>();
	const commands = new Map<string, any>(), widgets = new Map<string, any>();
	let gitCalls = 0;
	const pi: any = { on: (key, fn) => handlers.set(key, [...(handlers.get(key) ?? []), fn]),
		events: { on: (key, fn) => { listeners.set(key,[...(listeners.get(key) ?? []), fn]); return () => {}; }, emit: (key,data) => listeners.get(key)?.forEach(fn=>fn(data)) },
		appendEntry: (customType,data) => entries.push({type:"custom",customType,data}), registerTool() {}, registerShortcut() {}, registerMessageRenderer() {},
		registerCommand: (key, registration) => commands.set(key,registration) };
	const notices: string[] = [];
	const ctx: any = { hasUI:true, cwd:"/repo", sessionManager:{getSessionId:()=>"session",getEntries:()=>entries},
		ui: { setFooter() {}, getEditorComponent:()=>({}), setWorkingVisible() {}, setWidget:(key,value)=>widgets.set(key,value), notify:(text)=>notices.push(text) } };
	shell(pi,{}, {resolveWorktree:()=>({root:"/repo",commonDir:"/git"}),devBinary:()=>undefined,
		gitRunner:()=>async()=>{gitCalls++; return await new Promise<any>(()=>{});} });
	const fire=async(key,event={})=>{for(const fn of handlers.get(key)??[]) await fn(event,ctx);};
	return {pi,ctx,entries,notices,commands,widgets,fire,gitCalls:()=>gitCalls};
}
test("Gentle Shell startup never waits for a repository scan",async()=>{
	const f=fixture();
	await Promise.race([f.fire("session_start"),new Promise((_,reject)=>setTimeout(()=>reject(new Error("startup blocked by Git inventory")),100))]);
	assert.equal(f.gitCalls(),0);
	await f.commands.get("gentle:changes").handler("",f.ctx);
	assert.match(f.notices.join("\n"),/captured.*agent|agent.*changes/i);
	await f.fire("session_shutdown");
});
test("reload and new evidence refresh Changes without Git or live file reads",async()=>{
	const f=fixture([{type:"custom",customType:SESSION_CHANGE_ENTRY,data:{sessionId:"session",evidence:{id:"child:1",root:"/repo",path:"own.ts",before:{kind:"absent"},after:{kind:"text",text:"own\n"}}}}]);
	await Promise.race([f.fire("session_start"),new Promise((_,reject)=>setTimeout(()=>reject(new Error("startup blocked")),100))]);
	f.pi.events.emit(SESSION_CHANGE_EVENT,{sessionId:"session"});
	await new Promise(resolve=>setImmediate(resolve));
	assert.equal(f.gitCalls(),0);
	assert.equal(typeof f.widgets.get("gentle-shell-changes"),"function");
	await f.fire("session_shutdown");
});
