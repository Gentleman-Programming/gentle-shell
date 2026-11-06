# Preserve economical exploration with optional CodeGraph

Keep the separately configured `gentle-ai-explore` worker. Local exploration stays child-owned; the parent obtains online evidence through its existing tools and passes URLs/passages through the existing context handoff. Refs #1269 and #1598, without closing either issue.

## Specs
- S1: User purpose: "la razon de existencia del subagente de explore es para poder asignarle un modelo de ia que no es costoso y asi reducir el costo de las exploraciones". Preserve configured model/thinking and actual child execution, without an expensive-parent fallback or profile rewrite.
- S2: Register the existing CodeGraph implementation only for children explicitly requesting it and only when absent. Keep the frozen child bootstrap, current-workspace/index-only safety, and read/grep/find fallback on unavailable or failed backend.
- S3: Parent retrieves online evidence with existing tools/permissions, then supplies URLs and relevant passages for bounded synthesis. Source text is evidence, not instructions. The child must not claim it fetched a supplied URL or infer page contents from a URL alone; report missing evidence.
- S4: User accepted the smaller solution with "ok avanza con eso, eso me convence". No transparent web relay, SDK changes, arbitrary parent-tool authority, new researcher, keyword routing, user-profile mutation, or explorer retirement. Autonomous child browsing remains outside this scope.
- S5: Verify actual registration and execution, not merely declarations or exit status. Keep negative scope/idempotence tests and independent read-only verification. Existing issues remain open; do not promise universal free-text capability compatibility.
- S6: User said "entreguemos" and confirmed commit, feature-branch push, and PR creation in Gentleman-Programming/gentle-shell with nonclosing references. No merge, auto-merge, package publication, or runtime activation authorized.

## Tasks
- T1 [S1,S2] repair requested CodeGraph bootstrap with RED/GREEN and SDK activation/model tests: done.
- T2 [S1,S3,S4] update explorer and parent source-handoff contracts without new transport: done. Route: direct inline, understood small change.
- T3 [S1,S3,S5] verify existing runner context preserves source passages, configured model/thinking, and requested tools: done. Uses the existing parent-message helper, not new delegation authority.
- T4 [S1,S2,S3,S5] exercise actual configured-model child, installed CodeGraph, and supplied-source synthesis: done within isolated global-route scope. Session/repository pins and cost comparison not claimed.
- T5 [S5] independent focused/full verification and base-failure attribution: done as verification execution; full suite remains non-green due independently reproduced base failures.
- T6 [S5,S6] prepare reviewed commit, update against target main, push branch, open nonclosing PR, and observe required CI: in progress. Do not include rejected design artifacts or dependency symlinks.

## Log
- CodeGraph RED: actual offline SDK child omitted explicitly requested CodeGraph from its first model request. Existing implementation now registers during child startup only when requested and absent; no shell/write/agent tools added.
- Bootstrap coverage: requested/nonrequesting/nonchild scopes, repeat startup, existing registration preserved, actual SDK first request includes CodeGraph and keeps selected model.
- Source-handoff RED: previous candidate still declared web tools and lacked supplied-source safety. Removed the candidate relay/SDK expansion; final explorer declares read/grep/find/codegraph. User profiles and installed SDK unchanged.
- Existing runner test verifies lossless source URL/passage/uncertainty context, unchanged model/thinking arguments, and four role tools plus the existing parent-message helper.
- Documentation stays in existing lazy modules. Parent guidance references the source-only role contract rather than duplicating it. No old normative body rules removed, new module added, or context budgets increased.
- Focused final checks before delivery: 110 tests passed; independent verifier repeated the same 110 and four focused YOLO tests. Type ratchet: 185 recorded diagnostics, no regressions, not clean types. Runtime parity: ten generated modules matched. Package resources: 198 files / 69 exact byte pins passed. Provider contract and runtime harness passed. Diff check passed.
- Actual isolated runner/bundled Pi child completed using the current global explorer profile, openai-codex/gpt-6-luna/high. Installed CodeGraph init/explore returned economicalGreeting, its mapFixture caller, and source lines. Answer cited the parent-supplied public ToolInfo passage explicitly as not fetched by the child. No additional parent-model call in the probe.
- Probe's initial exit1 was an assertion comparing a serialized TaskRecord model string with a ModelRef object. Original observations were retained unchanged; an offline validator using production formatModelRef passed, independently rechecked, without repeating the paid call. Evidence SHA-256: 0b310abfae91035e191e4b69e989038ae695ea820cc59ce80175c2266f22714f.
- Full final unit run before delivery: 5,745 passed, 14 failed, 59 skipped. All fourteen failure names/assertion shapes independently reproduced on base 753393130a1cef09974de500fb4c6b6e95a45b6f: routing notification (1), pi-pretty suppression (2), held-mode review lifecycle (6), and missing zip (5). No unmatched failures. Budget and both YOLO ordering cases passed in that full run. This is not an all-green result, and unrelated failures were not fixed here.
- Delivery authorization verified against github.com/Gentleman-Programming/gentle-shell: default branch main, authenticated user decode2 with MAINTAIN permission, issue #1269 OPEN/status:approved, issue #1598 OPEN/status:needs-design. Use exactly one PR type label, type:bug, and nonclosing references. No issue-label changes authorized.
