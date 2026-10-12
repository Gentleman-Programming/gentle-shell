import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import shell, { shellGitRunner } from "../extensions/gentle-shell.ts";
import { SESSION_CHANGE_ENTRY, SESSION_CHANGE_EVENT } from "../lib/session-changes.ts";

function fixture(entries: any[] = [], options: { root?: string; gitRunner?: (root: string) => (args: string[]) => Promise<any> } = {}) {
	const handlers = new Map<string, Function[]>(), listeners = new Map<string, Function[]>();
	const commands = new Map<string, any>(), widgets = new Map<string, any>();
	let gitCalls = 0;
	const pi: any = { on: (key, fn) => handlers.set(key, [...(handlers.get(key) ?? []), fn]),
		events: { on: (key, fn) => { listeners.set(key,[...(listeners.get(key) ?? []), fn]); return () => {}; }, emit: (key,data) => listeners.get(key)?.forEach(fn=>fn(data)) },
		appendEntry: (customType,data) => entries.push({type:"custom",customType,data}), registerTool() {}, registerShortcut() {}, registerMessageRenderer() {},
		registerCommand: (key, registration) => commands.set(key,registration) };
	const notices: string[] = [];
	const root = options.root ?? "/repo";
	const ctx: any = { hasUI:true, cwd:root, sessionManager:{getSessionId:()=>"session",getEntries:()=>entries},
		ui: { setFooter() {}, getEditorComponent:()=>({}), setWorkingVisible() {}, setWidget:(key,value)=>widgets.set(key,value), notify:(text)=>notices.push(text) } };
	shell(pi,{}, {resolveWorktree:()=>({root,commonDir:root+"/.git"}),devBinary:()=>undefined,
		gitRunner:(cwd)=>async(args)=>{gitCalls++; return options.gitRunner ? options.gitRunner(cwd)(args) : await new Promise<any>(()=>{});} });
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
test("the changes overlay labels each session tree with its root's branch instead of detached",async()=>{
	const evidence=(root:string,id:string)=>({type:"custom",customType:SESSION_CHANGE_ENTRY,data:{sessionId:"session",evidence:{id,root,path:"own.ts",before:{kind:"absent"},after:{kind:"text",text:"own\n"}}}});
	const entries=[evidence("/repo","child:1"),evidence("/other","child:2")];
	const handlers=new Map<string,Function[]>();
	const commands=new Map<string,any>();
	const gitRoots:string[]=[];
	const pi:any={on:(key,fn)=>handlers.set(key,[...(handlers.get(key)??[]),fn]),events:{on:()=>()=>{},emit(){}},appendEntry(){},registerTool(){},registerShortcut(){},registerMessageRenderer(){},registerCommand:(key,registration)=>commands.set(key,registration)};
	let view:any; let renders=0;
	const ctx:any={hasUI:true,cwd:"/repo",sessionManager:{getSessionId:()=>"session",getEntries:()=>entries},
		ui:{setFooter(){},getEditorComponent:()=>({}),setWorkingVisible(){},setWidget(){},notify(){},
			custom:async(factory:any)=>{view=factory({terminal:{rows:40,columns:120},requestRender:()=>renders++},{fg:(_c:string,t:string)=>t,bold:(t:string)=>t},{},()=>{});return new Promise(()=>{});}}};
	shell(pi,{},{resolveWorktree:()=>({root:"/repo",commonDir:"/git"}),devBinary:()=>undefined,
		gitRunner:(root:string)=>async(args:string[])=>{gitRoots.push(root);await new Promise(r=>setImmediate(r));
			if(args[0]==="symbolic-ref")return root==="/repo"?{stdout:"feature\n",code:0}:{stdout:"",code:1};
			// Opening reconciles captured paths; both stay dirty so both trees are listed.
			if(args[0]==="status")return {stdout:"?? own.ts\0",code:0};
			return {stdout:"deadbeef\n",code:0};}});
	for(const fn of handlers.get("session_start")??[])await fn({},ctx);
	void commands.get("gentle:changes").handler("",ctx);
	await new Promise(r=>setImmediate(r));
	assert.ok(view,"the overlay opened");
	for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));
	const rendered=view.render(120).join("\n");
	assert.match(rendered,/feature · repo/,"the repo tree carries its branch");
	assert.match(rendered,/detached · other/,"a genuinely detached root still reads detached");
	assert.deepEqual([...new Set(gitRoots)].sort(),["/other","/repo"],"git is asked once per root, only while the overlay is open");
	assert.ok(renders>0,"a resolved label asks the overlay to repaint");
	for(const fn of handlers.get("session_shutdown")??[])await fn({},ctx);
});

function tempRepo() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-changes-")));
	const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
	git("init", "-q");
	writeFileSync(join(root, "file.ts"), "base\n");
	git("add", "file.ts"); git("commit", "-q", "-m", "base");
	return { root, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const captured = (root: string, id: string, before: string, after: string) => ({ type: "custom", customType: SESSION_CHANGE_ENTRY,
	data: { sessionId: "session", evidence: { id, root, path: "file.ts", before: { kind: "text", text: before }, after: { kind: "text", text: after } } } });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 5)); };

test("an agent edit that is committed leaves Changes and the counter, and reappears when edited again", async () => {
	const repo = tempRepo();
	try {
		writeFileSync(join(repo.root, "file.ts"), "agent\n");
		const entries: any[] = [captured(repo.root, "a", "base\n", "agent\n")];
		const f = fixture(entries, { root: repo.root, gitRunner: (cwd) => shellGitRunner(cwd) });
		await f.fire("session_start");
		assert.equal(f.gitCalls(), 0, "startup never reconciles");
		await f.fire("agent_end"); await settle();
		assert.equal(typeof f.widgets.get("gentle-shell-changes"), "function", "an uncommitted agent edit stays listed");
		repo.git("commit", "-q", "-am", "agent work");
		await f.fire("agent_end"); await settle();
		assert.equal(f.widgets.get("gentle-shell-changes"), undefined, "committed work leaves the widget and counter");
		await f.commands.get("gentle:changes").handler("", f.ctx);
		assert.match(f.notices.join("\n"), /No captured agent changes/);
		writeFileSync(join(repo.root, "file.ts"), "edited again\n");
		await f.fire("agent_end"); await settle();
		assert.equal(typeof f.widgets.get("gentle-shell-changes"), "function", "a dirty file reappears with its session diff");
		await f.fire("session_shutdown");
	} finally { repo.cleanup(); }
});

test("a failing Git leaves the captured list unchanged", async () => {
	const f = fixture([captured("/repo", "a", "base\n", "agent\n")], { gitRunner: () => async () => ({ stdout: "", code: 128 }) });
	await f.fire("session_start");
	await f.fire("agent_end"); await settle();
	assert.ok(f.gitCalls() > 0, "agent end reconciles captured roots");
	assert.equal(typeof f.widgets.get("gentle-shell-changes"), "function");
	await f.fire("session_shutdown");
});
