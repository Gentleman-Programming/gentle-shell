import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import { CandidateTreeSymlinkScanner } from "../lib/review-candidate-symlink-scan.ts";

function store(t: test.TestContext): string {
 const root = realpathSync(mkdtempSync(join(tmpdir(), "symlink-cache-")));
 mkdirSync(join(root, "refs"));
 writeFileSync(join(root, "config"), "[core]\nrepositoryformatversion = 0\n");
 t.after(() => rmSync(root, { recursive: true, force: true }));
 return root;
}

test("workspace identity and tree scans remove mixed-case Git overrides before dispatch", async () => {
 const previousEnv = process.env, original = childProcess.execFileSync;
 const seen: NodeJS.ProcessEnv[] = [];
 const cwd = realpathSync(process.cwd());
 process.env = { ...previousEnv, git_dir: "fixture-must-not-select-a-repository", GiT_WoRk_TrEe: "fixture-must-not-select-a-worktree" };
 childProcess.execFileSync = ((_file, args, options) => {
  assert.equal(args[0], "rev-parse");
  seen.push(options.env);
  return cwd + "\n";
 }) as typeof childProcess.execFileSync;
 syncBuiltinESMExports();
 try {
  const scanner = new CandidateTreeSymlinkScanner((_file, _args, options) => { seen.push(options.env); return ""; });
  assert.equal(scanner.scan(cwd, "f".repeat(40)), "no-symlinks");
  const result = await __testing.executeReviewControllerOperation({ operation: "status", workspaceRoot: cwd }, cwd, {} as any);
  assert.equal(result.outcome, "native-status-unsupported");
  assert.equal(seen.length, 3, "one tree scan and both workspace identity queries exercised");
  for (const env of seen) assert.deepEqual(Object.keys(env).filter(key => /^git_/i.test(key)), []);
 } finally { process.env = previousEnv; childProcess.execFileSync = original; syncBuiltinESMExports(); }
});

test("repeated inspect scans reuse an unchanged literal tree without launching another Git process", t => {
 const common = store(t), original = childProcess.execFileSync;
 let listings = 0;
 childProcess.execFileSync = ((file, args) => {
  assert.equal(file, "git"); assert.ok(args.includes("ls-tree")); listings++;
  return "100644 blob " + "a".repeat(40) + "\tfile.txt\n";
 }) as typeof childProcess.execFileSync;
 syncBuiltinESMExports();
 try {
  for (let i = 0; i < 5; i++) assert.equal(__testing.scanCandidateTreeForSymlinks(process.cwd(), "1".repeat(40), common), "no-symlinks");
  assert.equal(listings, 1);
 } finally { childProcess.execFileSync = original; syncBuiltinESMExports(); }
});

test("active or malformed replacement refs bypass old cache entries without poisoning literal answers", t => {
 const common = store(t);
 let listing = "", listings = 0;
 const argumentsSeen: string[][] = [];
 const scanner = new CandidateTreeSymlinkScanner((_file, args) => { listings++; argumentsSeen.push([...args]); return listing; });
 const scan = () => scanner.scan(process.cwd(), "2".repeat(40), common);
 assert.equal(scan(), "no-symlinks");
 mkdirSync(join(common, "refs", "replace"));
 const replacement = join(common, "refs", "replace", "2".repeat(40));
 writeFileSync(replacement, "3".repeat(40) + "\n");
 listing = "120000 blob " + "a".repeat(40) + "\tlink\n";
 assert.equal(scan(), "tracks-symlinks");
 unlinkSync(replacement);
 writeFileSync(join(common, "packed-refs"), "malformed refs\n");
 assert.equal(scan(), "tracks-symlinks", "unknown eligibility does not borrow the cached negative");
 unlinkSync(join(common, "packed-refs"));
 assert.equal(scan(), "no-symlinks", "replacement answers never overwrite a literal tree entry");
 assert.equal(listings, 3);
 assert.ok(argumentsSeen[0].includes("--no-replace-objects"));
 assert.ok(argumentsSeen.slice(1).every(args => !args.includes("--no-replace-objects")));
});

test("failed scans are retried, cache is bounded by LRU and trees remain isolated", t => {
 const common = store(t);
 let fail = true, listings = 0;
 const scanner = new CandidateTreeSymlinkScanner(() => {
  listings++; if (fail) throw new Error("output limit or timeout"); return "";
 }, 2);
 const scan = (id: string) => scanner.scan(process.cwd(), id.repeat(40), common);
 assert.equal(scan("a"), "unconfirmed"); fail = false;
 assert.equal(scan("a"), "no-symlinks"); assert.equal(scan("a"), "no-symlinks");
 assert.equal(listings, 2);
 scan("b"); scan("a"); scan("c"); scan("b");
 assert.equal(listings, 5, "least recently used tree is scanned after eviction");
});

test("repository identity, unsupported refs and missing verified context never share cached scans", t => {
 const a = store(t), b = store(t);
 let listings = 0;
 const scanner = new CandidateTreeSymlinkScanner(() => { listings++; return ""; });
 const scan = (common?: string) => scanner.scan(process.cwd(), "d".repeat(40), common);
 for (const common of [a, b, a, b]) assert.equal(scan(common), "no-symlinks");
 assert.equal(listings, 2);
 mkdirSync(join(a, "reftable"));
 scan(a); scan(a); scan(); scan();
 assert.equal(listings, 6, "unknown backend or context always scans afresh");
 writeFileSync(join(b, "packed-refs"), "x".repeat(1024 * 1024 + 1));
 scan(b); scan(b);
 assert.equal(listings, 8, "oversized refs do not borrow cached classifications");
});

test("real Git loose and packed replacements are respected, including changes and removal", t => {
 const cwd = store(t);
 const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
 const git = (args: string[], input?: string) => childProcess.execFileSync("git", args, { cwd, env, encoding: "utf8", input, windowsHide: true }).trim();
 git(["-c", "init.defaultRefFormat=files", "init", "--quiet"]);
 const common = realpathSync(resolve(cwd, git(["rev-parse", "--git-common-dir"])));
 const blob = git(["hash-object", "-w", "--stdin"], "fixture\n");
 const regular = git(["mktree"], `100644 blob ${blob}\tfile.txt\n`);
 const link = git(["mktree"], `120000 blob ${blob}\tlink\n`);
 let listings = 0;
 const scanner = new CandidateTreeSymlinkScanner((file, args, options) => { listings++; return childProcess.execFileSync(file, args, options); });
 assert.equal(scanner.scan(cwd, regular, common), "no-symlinks");
 assert.equal(scanner.scan(cwd, regular, common), "no-symlinks");
 assert.equal(listings, 1, "the real-Git fixture must hit the cache before replacements");
 git(["replace", regular, link]);
 assert.equal(scanner.scan(cwd, regular, common), "tracks-symlinks");
 git(["pack-refs", "--all"]);
 assert.equal(scanner.scan(cwd, regular, common), "tracks-symlinks");
 git(["replace", "-d", regular]);
 assert.equal(scanner.scan(cwd, regular, common), "no-symlinks");
 git(["replace", link, regular]);
 assert.equal(scanner.scan(cwd, link, common), "no-symlinks");
 git(["replace", "-d", link]);
 assert.equal(scanner.scan(cwd, link, common), "tracks-symlinks");
 const originalConfig = readFileSync(join(common, "config"), "utf8");
 writeFileSync(join(common, "config"), originalConfig + "\n[core]\nrepositoryformatversion = 1\n[extensions]\nrefStorage = unknown-review-backend\n");
 assert.equal(scanner.scan(cwd, regular, common), "unconfirmed", "unknown configured backend never borrows a warm answer");
 writeFileSync(join(common, "config"), originalConfig);
 assert.equal(scanner.scan(cwd, regular, common), "no-symlinks");
});

test("noncanonical packed refs never borrow a warm answer", t => {
 const common = store(t), oid = "a".repeat(40);
 const header = "# pack-refs with: peeled fully-peeled sorted \n";
 let listing = "", listings = 0;
 const scanner = new CandidateTreeSymlinkScanner(() => { listings++; return listing; });
 const scan = () => scanner.scan(process.cwd(), "e".repeat(40), common);
 assert.equal(scan(), "no-symlinks");
 listing = `120000 blob ${oid}\tlink\n`;
 const invalid = [
  `^${oid}\n`, `${oid} refs/heads/x`, `${header}${oid} refs/heads/x\n# comment\n`, "# junk\n",
  `${header}${oid} refs/tags/v1\n^${oid}\n^${oid}\n`,
  `${header}${oid} refs/heads/z\n${oid} refs/heads/a\n`,
 ];
 for (const contents of invalid) {
  writeFileSync(join(common, "packed-refs"), contents);
  assert.equal(scan(), "tracks-symlinks", JSON.stringify(contents));
 }
 assert.equal(listings, 1 + invalid.length);
 writeFileSync(join(common, "packed-refs"), `${header}${oid} refs/tags/v1.0\n^${oid}\n`);
 assert.equal(scan(), "no-symlinks", "canonical peeled tag can reuse the literal tree");
 assert.equal(listings, 1 + invalid.length);
});
