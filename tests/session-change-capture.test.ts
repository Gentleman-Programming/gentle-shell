import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSessionChangeCapture } from "../lib/session-change-capture.ts";
import { SessionChanges, SESSION_CHANGE_ENTRY } from "../lib/session-changes.ts";

async function fixture(run: (f: any) => Promise<void>, child = false) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "change-capture-")));
	const handlers = new Map<string, Function>();
	const entries: any[] = [];
	const listeners = new Map<string, Function>();
	const pi = { on: (key, fn) => handlers.set(key, fn), appendEntry: (customType, data) => entries.push({type:"custom",customType,data}),
		events: { on: (key, fn) => { listeners.set(key, fn); return () => listeners.delete(key); }, emit: (key, data) => listeners.get(key)?.(data) } };
	let id = "session";
	const ctx = { cwd:root, sessionManager: { getSessionId: () => id, getEntries: () => entries } };
	installSessionChangeCapture(pi as never, child ? {GENTLE_PI_AGENTS_CHILD:"1"} : {}, () => ({root,commonDir:root}));
	const fire = (key, event = {}) => handlers.get(key)?.(event, ctx);
	try { await fire("session_start"); await run({root, entries, ctx, fire, switchSession: () => id = "other"}); }
	finally { await rm(root, {recursive:true,force:true}); }
}

test("capture reads no inventory at startup and ignores read-only tools", async () => fixture(async ({fire, entries}) => {
	await fire("tool_call", {toolCallId:"r",toolName:"read",input:{path:"missing"}});
	await fire("tool_result", {toolCallId:"r",toolName:"read",input:{path:"missing"},isError:false});
	await fire("tool_execution_end", {toolCallId:"r",toolName:"read",isError:false});
	assert.deepEqual(entries, []);
}));

test("successful writes capture only the exact tool target and persist for reload", async () => fixture(async ({root,fire,entries}) => {
	await writeFile(join(root,"file"),"human baseline\n");
	const event = {toolCallId:"w",toolName:"write",input:{path:"file",content:"agent output\n"}};
	await fire("tool_call",event);
	await writeFile(join(root,"file"),event.input.content);
	await fire("tool_result",{...event,isError:false});
	assert.equal(entries.length,0);
	await fire("tool_execution_end",{toolCallId:"w",toolName:"write",isError:false});
	assert.equal(entries[0].customType,SESSION_CHANGE_ENTRY);
	await writeFile(join(root,"file"),"later human output\n");
	const changes = new SessionChanges("session",entries);
	assert.match(changes.loadDiff(root,changes.model.files[0]),/\+agent output/);
	assert.doesNotMatch(changes.loadDiff(root,changes.model.files[0]),/later human/);
}));

test("failed and stale-session tool outcomes never add session changes", async () => fixture(async ({root,fire,entries,switchSession}) => {
	const event={toolCallId:"w",toolName:"write",input:{path:"new",content:"agent\n"}};
	await fire("tool_call",event);
	await writeFile(join(root,"new"),event.input.content);
	await fire("tool_result",{...event,isError:false});
	await fire("tool_execution_end",{toolCallId:"w",toolName:"write",isError:true});
	assert.equal(entries.length,0);
	await fire("tool_call",{...event,toolCallId:"x"});
	switchSession();
	await fire("tool_result",{...event,toolCallId:"x",isError:false});
	await fire("tool_execution_end",{toolCallId:"x",toolName:"write",isError:false});
	assert.equal(entries.length,0);
}));

test("child carries bounded evidence in the existing tool-result details transport", async () => fixture(async ({root,fire,entries}) => {
	const event={toolCallId:"w",toolName:"write",input:{path:"new",content:"agent\n"}};
	await fire("tool_call",event); await writeFile(join(root,"new"),event.input.content);
	const result=await fire("tool_result",{...event,isError:false,details:{original:"preserved"}});
	assert.equal(result.details.original,"preserved");
	assert.equal(result.details.gentleSessionChange.id,"w");
	assert.equal(result.details.gentleSessionChange.path,"new");
	assert.deepEqual(entries,[]);
},true));
