import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Host regression for #2724: each step has a fresh module graph and empty
// CandidateViewRegistry. Provider durability is simulated through a file;
// this test makes no claim about the native engine, SDK session files or TUI.
// A real SDK/TUI + native process experiment separately established the flow.
const TARGET = `sha256:${"1".repeat(64)}`;
const REVISION = `sha256:${"2".repeat(64)}`;
const LINEAGE = "committed-restart-ack";

/** Build a fresh controller process with a file-backed, single-use provider fixture. */
function workerSource() {
	const extension = pathToFileURL(join(import.meta.dirname, "../extensions/gentle-ai.ts")).href;
	const registry = pathToFileURL(join(import.meta.dirname, "../lib/review-candidate-view.ts")).href;
	return `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const { __testing } = await import(${JSON.stringify(extension)});
const { CandidateViewRegistry } = await import(${JSON.stringify(registry)});
const [stateFile, mode, output] = process.argv.slice(-3);
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const { cwd, baseTree, candidateTree, baseCommit, target, revision, lineage, decoy } = state;
const requests = [];
const arguments_ = [
 { name:'cwd',value:cwd,token:'--cwd='+cwd },
 { name:'lineage',value:lineage,token:'--lineage='+lineage },
 { name:'target',value:target,token:'--target='+target },
 { name:'expected-revision',value:revision,token:'--expected-revision='+revision },
 { name:'token',value:'provider-issued-once',token:'--token=provider-issued-once' },
];
if(decoy) arguments_[2] = { name:'target',value:'sha256:'+'f'.repeat(64),token:'--target=sha256:'+'f'.repeat(64) };
const projection = {
 schema:'gentle-ai.review-candidate-projection/v1',kind:'base-diff',projection:'workspace',
 baseTree,initialReviewTree:candidateTree,currentCandidateTree:candidateTree,
 pathsDigest:target,paths:['candidate.ts'],intendedUntracked:[],intendedUntrackedProof:target,
 initialSnapshotIdentity:target,currentSnapshotIdentity:target,
};
const native = {
 targetStatus:async request => {
  requests.push(request);
  assert.equal(request.cwd,cwd);
  assert.equal(request.lineageId,lineage);
  // Recovering the lineage must not require host memory of a base selector.
  assert.equal(request.baseRef,undefined);
  assert.equal(request.committedOnly,undefined);
  return {
   contract:'gentle-ai.review-integration/v2',applicability:state.burns?'unrelated':'current_target',
   ...(state.burns?{}:{authority:{version:'compact-v2',lineageId:lineage,state:'approved',generation:1,revision}}),
   receipt:{status:'none'},action:'stop',replayability:'not_replayable',targetIdentity:target,projection,candidates:[],
   nextTransition:state.burns?{kind:'stop',reasonCode:'approved_acknowledged'}:{kind:'execute',reasonCode:'approved_acknowledgement_required',execute:{operation:'review.acknowledge-approved',command:'gentle-ai review acknowledge-approved --provider-vector',arguments:arguments_,preconditions:[{name:'state',value:'approved'}],binding:{lineageId:lineage,targetIdentity:target,revision}}},
   raw:{schema:'gentle-ai.review-integration.status/v9',contract:'gentle-ai.review-integration/v2',lineage_id:lineage,target_identity:target,projection:{kind:'base-diff',base_tree:baseTree,paths:['candidate.ts']},...(state.burns?{}:{authority:{lineage_id:lineage,state:'approved'}})},
  };
 },
 acknowledgeApproved:async request => {
  assert.equal(state.burns,0,'No second native burn is permitted');
  assert.deepEqual(request.argumentTokens,arguments_.map(a=>a.token));
  assert.deepEqual(request.binding,{lineageId:lineage,targetIdentity:target,revision});
  state.burns++;
  writeFileSync(stateFile,JSON.stringify(state));
 },
};
const views=new CandidateViewRegistry();
assert.equal(views.hasProjection(lineage,cwd),false);
const operation=mode==='inspect'?'status':'acknowledge-approved';
const result=await __testing.executeReviewControllerOperation({operation,lineageId:lineage,workspaceRoot:cwd},cwd,native,undefined,views);
writeFileSync(output,JSON.stringify({pid:process.pid,result,requests,burns:state.burns}));
`;
}

/** Create an isolated committed range and workers sharing only simulated provider state. */
function fixture(t: test.TestContext, decoy = false) {
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gentle-committed-restart-")));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
	const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=", "-c", "commit.gpgSign=false", "-c", "core.autocrlf=false", ...args], { cwd: scratch, env, encoding: "utf8", windowsHide: true }).trim();
	git("init", "-b", "main");
	writeFileSync(join(scratch, "candidate.ts"), "export const value = 1;\n");
	git("add", "candidate.ts");
	git("-c", "user.name=Restart Fixture", "-c", "user.email=restart@example.invalid", "commit", "-qm", "base");
	const baseCommit = git("rev-parse", "HEAD");
	const baseTree = git("rev-parse", "HEAD^{tree}");
	writeFileSync(join(scratch, "candidate.ts"), "export const value = 2;\n");
	git("add", "candidate.ts");
	git("-c", "user.name=Restart Fixture", "-c", "user.email=restart@example.invalid", "commit", "-qm", "committed correction");
	const stateFile = join(scratch, "provider.json");
	writeFileSync(stateFile, JSON.stringify({ cwd: scratch, baseCommit, baseTree, candidateTree: git("rev-parse", "HEAD^{tree}"), target: TARGET, revision: REVISION, lineage: LINEAGE, decoy, burns: 0 }));
	const run = (mode: string) => {
		const output = join(scratch, `${mode}.json`);
		execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", workerSource(), stateFile, mode, output], { env, encoding: "utf8", timeout: 30_000, windowsHide: true });
		return JSON.parse(readFileSync(output, "utf8"));
	};
	return { run, baseTree, stateFile };
}

test("fresh processes resume a committed approval and acknowledge it exactly once", (t) => {
	const { run, baseTree } = fixture(t);
	const inspected = run("inspect");
	assert.equal(inspected.burns, 0);
	assert.equal(inspected.result.result.authority.lineage_id, LINEAGE);
	assert.equal(inspected.result.result.projection.base_tree, baseTree);
	assert.deepEqual(inspected.result.result.projection.paths, ["candidate.ts"]);
	assert.match(inspected.result.next_action, /acknowledge-approved/);
	const acknowledged = run("ack");
	assert.notEqual(acknowledged.pid, inspected.pid);
	assert.equal(acknowledged.result.outcome, "native-approved-acknowledgement-completed");
	assert.equal(acknowledged.result.authority, "burned");
	assert.equal(acknowledged.result.target_identity, TARGET);
	assert.equal(acknowledged.result.delivery, "ordinary-repository-policy");
	assert.equal(acknowledged.burns, 1);
	const replay = run("replay");
	assert.notEqual(replay.pid, acknowledged.pid);
	assert.equal(replay.result.outcome, "native-approved-acknowledgement-not-current");
	assert.equal(replay.result.mutation_outcome, "none");
	assert.equal(replay.burns, 1);
});

test("a fresh process refuses an acknowledgement vector for another target before burn", (t) => {
	const { run, stateFile } = fixture(t, true);
	const result = run("ack");
	assert.equal(result.result.outcome, "native-operation-failed");
	assert.equal(result.result.mutation_outcome, "none");
	assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).burns, 0);
});
