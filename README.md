# gentle-pi

[![npm](https://img.shields.io/npm/v/gentle-pi?color=blue)](https://www.npmjs.com/package/gentle-pi)
[![pi package](https://img.shields.io/badge/Pi-package-6f42c1)](https://pi.dev/packages/gentle-pi)
[![license](https://img.shields.io/npm/l/gentle-pi?color=blue)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Gentleman-Programming/gentle-pi?style=flat&color=yellow)](https://github.com/Gentleman-Programming/gentle-pi/stargazers)
[![Gentle-AI](https://img.shields.io/badge/Gentle--AI-ecosystem-ff69b4)](https://github.com/Gentleman-Programming/gentle-ai)
[![Gentleman Programming](https://img.shields.io/badge/by-Gentleman%20Programming-black)](https://github.com/Gentleman-Programming)
[![YouTube](https://img.shields.io/badge/YouTube-Gentleman%20Programming-red?logo=youtube&logoColor=white)](https://www.youtube.com/c/GentlemanProgramming)
[![Discord](https://img.shields.io/badge/Discord-community-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/gentleman-programming-769863833996754944)
[![SDD/OpenSpec](https://img.shields.io/badge/SDD-OpenSpec-00ADD8)](#sddopenspec-flow)
[![Subagents](https://img.shields.io/badge/Pi-subagents-brightgreen)](#what-it-adds)

**[Gentle-AI website](https://gentle-ai.gentlemanprogramming.com/)** &bull; **[Gentle-AI wiki](https://gentle-ai-wiki.gentlemanprogramming.com/)** &bull; **[Engram](https://engram.gentlemanprogramming.com/)**

<div align="center">

<!--
  sealed_token is a GitHub fine-grained token encrypted against Star History's
  public key, so only the encrypted value is published here. It is required
  because GitHub restricted the stargazers API to a repository's admins and
  collaborators on 2026-06-30; without it the chart renders an error placeholder.
  Regenerate it at https://www.star-history.com/?repos=Gentleman-Programming%2Fgentle-pi&type=date&legend=top-left
-->

<a href="https://www.star-history.com/?repos=Gentleman-Programming%2Fgentle-pi&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Gentleman-Programming%2Fgentle-pi&type=date&theme=dark&legend=top-left&sealed_token=zwrd_DfwYZeJU7nhGYNtREEheKWYEslW_uzrqORlZ36v-JSMepdqGLkKExp1M-xbNq6t-ebVS5iM3WoPDO26tXbSGkjXC2Jo3kHQ3uNzlRkCrWoqRHkPVQXvosKciY109ObiwGV1z8aajyedcloppmekCGrvVKJb6KWxGLXW_mHcRAVIBZUOa4SzW75D" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Gentleman-Programming%2Fgentle-pi&type=date&legend=top-left&sealed_token=zwrd_DfwYZeJU7nhGYNtREEheKWYEslW_uzrqORlZ36v-JSMepdqGLkKExp1M-xbNq6t-ebVS5iM3WoPDO26tXbSGkjXC2Jo3kHQ3uNzlRkCrWoqRHkPVQXvosKciY109ObiwGV1z8aajyedcloppmekCGrvVKJb6KWxGLXW_mHcRAVIBZUOa4SzW75D" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Gentleman-Programming%2Fgentle-pi&type=date&legend=top-left&sealed_token=zwrd_DfwYZeJU7nhGYNtREEheKWYEslW_uzrqORlZ36v-JSMepdqGLkKExp1M-xbNq6t-ebVS5iM3WoPDO26tXbSGkjXC2Jo3kHQ3uNzlRkCrWoqRHkPVQXvosKciY109ObiwGV1z8aajyedcloppmekCGrvVKJb6KWxGLXW_mHcRAVIBZUOa4SzW75D" />
  </picture>
</a>

</div>

**Turn Pi from a powerful coding agent into a controlled development harness.**

`gentle-pi` installs **el Gentleman** in Pi: a senior-architect operating layer for Spec-Driven Development, focused subagents, strict TDD evidence, reviewable work units, safety guards, project/user skill discovery, and bounded native review.

Pi already has strong tools. `gentle-pi` adds the discipline for using them well, keeps review evidence Git-derived instead of agent narration, and leaves delivery decisions to ordinary repository policy.

`gentle-pi` is the Pi-native package from the [Gentle-AI ecosystem](https://github.com/Gentleman-Programming/gentle-ai), built by [Gentleman Programming](https://github.com/Gentleman-Programming): the broader open-source project for turning AI coding agents into disciplined engineering environments with SDD workflows, skills, memory integrations, model routing, and review guardrails across multiple agents.

> **Trademark notice:** The gentle-pi name and logo are trademarks of Alan Buscaglia. The MIT License applies to the code; it does not permit implying endorsement or official affiliation. See [TRADEMARKS.md](TRADEMARKS.md).

Follow the project and the community around it:

- GitHub: [Gentleman-Programming](https://github.com/Gentleman-Programming)
- YouTube: [Gentleman Programming](https://www.youtube.com/c/GentlemanProgramming)
- Community Discord: [Gentleman Programming](https://discord.com/invite/gentleman-programming-769863833996754944)

Startup intro collaboration: thanks to [@aporcelli](https://github.com/aporcelli) for [`pi-gentle-startup`](https://github.com/aporcelli/pi-gentle-startup), which inspired the clean-screen startup animation, compact runtime panel, and pink visual treatment.

## The problem

Most coding-agent sessions fail for operational reasons, not model reasons:

- the agent jumps into code before requirements are clear;
- architectural decisions disappear into chat history;
- one request quietly becomes a huge multi-area diff;
- tests run late, or not at all;
- reviewers get handed a wall of changes;
- subagents are available, but the parent session has no orchestration discipline;
- project skills exist, but the model forgets to load them.

`gentle-pi` fixes the workflow around the agent.

## What it adds

| Capability                     | What it does                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **el Gentleman persona**       | Makes Pi behave like a senior architect and teacher, not a generic chatbot. Spanish responses use Rioplatense voseo by default; neutral mode is saved globally with project overrides. |
| **Configurable startup intro** | Adds a rose/text-logo startup intro, compact runtime panel, color presets, and commands to hide or show the decorative parts.                  |
| **Work routing discipline**    | Small tasks stay inline. Context-heavy exploration can be delegated. Large or risky changes go through SDD/OpenSpec.                          |
| **SDD/OpenSpec assets**        | Installs phase agents and chains for `init`, `onboard`, `explore`, `proposal`, `spec`, `design`, `tasks`, `apply`, `verify`, `sync`, and `archive`. |
| **Lazy SDD preflight**         | Resolves SDD mode, artifact store, delivery strategy, and review budget once per session; prompts only when a choice is genuinely unresolved.              |
| **Subagent orchestration**     | Keeps one parent session responsible while child agents explore, implement, test, or review with focused context.                             |
| **Strict TDD support**         | When project config declares a test command, apply/verify phases must record RED → GREEN → TRIANGULATE → REFACTOR evidence.                   |
| **Closed choice prompts** | Per-option hover/click/wheel in fullscreen; keyboard selection in either TUI mode. |
| **Native pointer regions** | Compose hover, press, click, and wheel behavior around public TUI components. |
| **Agent overlay close control** | Adds a header close button that adapts to available width. |
| **Reviewer protection**        | Surfaces review workload risk before a task turns into an oversized PR.                                                                       |
| **Per-agent model assignment** | Pi-native modal for assigning stronger or cheaper models to specific SDD/custom agents.                                                       |
| **Skill discovery registry**   | Maintains `.atl/skill-registry.md` from project and user skills so review/comment/PR workflows do not silently miss the right skill.          |
| **Skill creation workflow**    | Provides the `gentle-ai-skill-creator`/`gentle-ai-skill-improver` skills, `/skill-creation` prompt, and packaged style guide for LLM-first skills. |
| **Delivery skills**            | Includes issue-first PRs, chained PRs, work-unit commits, cognitive docs, comment writing, and Judgment Day review.                           |
| **Bounded native review**      | Freezes one candidate, dispatches only controller-selected lenses, and records native authority. Review outcomes are informational; delivery follows ordinary repository policy. |
| **Verified native runtime**    | Provisions the exact package-local Gentle AI v2.7.0 runtime: signed, SHA-256-pinned release archives on Darwin/Linux and a Go SumDB-verified source build on Windows x64/arm64. It validates package-local integrity and rejects PATH, global, sibling, symlink, and mode fallbacks. |
| **Runtime safety**             | Blocks destructive shell commands, asks for confirmation for sensitive operations, and blocks direct read/write/edit access to sensitive paths. |

## Native pointer regions

Compose pointer behavior around public `Text`, `Box`, or custom content without making it a keyboard target:

```ts
const scope = createNativePointerScope();
const openInput = scope.wrap(new Text("Open input", 0, 0), {
  onClick: () => {
    openInputEditor();
    return { handled: true };
  },
});
const panel = new Container();
panel.addChild(openInput);
const observer = scope.createMouseObserver(() => tui.requestRender());
```

Pass `observer` around the root's native mouse dispatch; reuse `panel` as custom or overlay content.
Pointer input is fullscreen-only. Regions preserve a consuming child's native result and do not focus
`Text`, activate on press or wheel, synthesize outside leave events, or alter terminal tracking.
Callers own keyboard policy, theme state, and business actions.

**Migration note:** Do not enable `pi-tool-cards` and `quiet-tools` together: Pi rejects duplicate `bash`, `read`, `edit`, and `write` registrations. Disable or remove the standalone package during migration; gentle-pi does not change those package registrations or delete that repository. The global fullscreen setting described below is a separate install-time change.

## Install

```bash
pi install npm:gentle-pi@0.14.0
```

### Install-time fullscreen

For this release, a successful postinstall in Pi's **global npm-managed** `agent-home/npm/node_modules/gentle-pi` installation persists `"tuiMode": "fullscreen"` in `agent-home/settings.json`, preserving other settings. Agent home resolves through `GENTLE_PI_AGENT_HOME`, then `PI_CODING_AGENT_DIR`, then `~/.pi/agent`. Use `/settings` to switch back to regular; rerunning this recognized postinstall resets it to fullscreen. Existing project overrides still take precedence.

Project-local installs (`pi install -l`), Git/local-path installs, temporary packages, development checkouts, ordinary npm consumers, and pnpm symlink-store packages do **not** receive this change. Updates or installs that do not execute postinstall cannot reassert it; this is not a universal install/update guarantee or a change to historical releases.

Malformed/nonobject JSON, symlink/nonregular settings, unsafe paths, or a busy settings lock fail without replacing settings. The installer coordinates with Pi's cooperative settings lock and uses atomic replacement; it does not guarantee safety against noncooperating writers or malicious concurrent directory replacement. Already-fullscreen settings remain byte-identical. Native installation failure leaves settings untouched; `GENTLE_PI_SKIP_GENTLE_AI_INSTALL=1` skips only native provisioning, not the recognized global fullscreen setting.

### RDD version policy

Native RDD started in `gentle-pi` `v0.15.0` on 2026-07-10 with bounded review transactions. Every release from `v0.15.0` onward is part of the unstable RDD development line. New releases will continue improving RDD until the project declares the line stable. The stable version for normal use without native RDD is the last preceding release, `v0.14.0`.

```bash
# Stable version without native RDD
pi install npm:gentle-pi@0.14.0

# Latest released RDD build (unstable)
pi install npm:gentle-pi@latest
```

The latest RDD package installs Gentle AI only into its private `.gentle-ai/` directory. Darwin and Linux use pinned release assets with asset and executable SHA-256 verification (signed archives for stable pins such as the current v2.7.0; raw prerelease binaries only under a prerelease pin). Windows x64 and arm64 build the exact `v2.7.0` source tag with a local Go 1.25.10+ toolchain, a sealed Go environment, `GOTOOLCHAIN=local`, and `GOSUMDB=sum.golang.org`; it does not download Go automatically. Windows provenance is Go-toolchain plus SumDB evidence and postinstall tamper detection, **not** Authenticode or protection against a malicious joint binary-and-manifest replacement. Package-private locks coordinate cooperative concurrent or crashed installers; their tombstones fail closed. A malicious same-user process with write access to package-private `node_modules` is outside that protocol because it can already replace package code, binary, or manifest, and portable Node has no pathname-delete CAS. It never uses `PATH` or a global `gentle-ai` installation. For development or offline installs only, set `GENTLE_PI_SKIP_GENTLE_AI_INSTALL=1`; native review operations then fail closed with an actionable `package-local-binary-missing` error until the package is reinstalled normally.

Recommended companion packages:

```bash
pi install npm:pi-intercom
pi install npm:gentle-engram
pi install npm:pi-web-access
pi install npm:pi-lens
pi install npm:@juicesharp/rpiv-ask-user-question
```

Then start Pi in a project:

```bash
pi
```

`gentle-pi` provides SDD agents as global Pi runtime assets, not per-project setup. The first SDD flow in a session still runs a one-time SDD preflight for preferences; for natural-language requests, el Gentleman decides when SDD is needed and runs the explicit preflight first.

## Quick start

```text
/gentle:status          Check package, SDD assets, OpenSpec, and global model config.
/gentle:doctor          Run read-only diagnostics for SDD assets, config, tools, and guards.
/gentle:sdd-preflight   Run or reuse the session SDD preflight explicitly.
/gentle-sdd-init           Create or refresh openspec/config.yaml (openspec/both stores only).
/gentle:models             Assign global model/effort routing to SDD/custom agents.
/gentle:persona            Switch between gentleman and neutral persona modes.
/gentle:background-subagents  Show or set the managed background-subagents policy, with its deciding source.
/gentle:banner             Configure startup rose, text logo, and color preset.
```

Typical flow:

1. Open Pi in your repo.
2. Run `/gentle:status`.
3. Run `/gentle-sdd-init` once per project, or when test/project capabilities change. This also runs the session SDD preflight.
4. For a substantial change, ask Pi to use SDD. Natural-language requests are classified by the parent agent, not by brittle runtime regexes.
5. Review the phase artifacts instead of trusting floating chat context.

## Core workflow

1. **Install and inspect.** Install `gentle-pi`, open Pi in the target repository, then run `/gentle:status` or `/gentle:doctor`.
2. **Plan when risk justifies it.** Small work stays direct; substantial work uses SDD with Engram, OpenSpec, or both so requirements and decisions survive compaction.
3. **Build with evidence.** One focused writer implements the approved scope. When Strict TDD is available, apply and verify preserve RED → GREEN → TRIANGULATE → REFACTOR evidence.
4. **Use runtime-owned RDD when available.** Gentle AI supplies any runtime-specific review instructions; this package does not recreate a lifecycle in documentation or prompts.
5. **Deliver through ordinary repository policy.** Review and Judgment Day evidence is informational only; Pi never creates a delivery route, authorization, target rederivation, or receipt gate.

> **Trust what the system can derive, not what an agent claims.** Agents analyze the candidate. The package-local Gentle AI runtime owns scope, risk, findings, and review authority. Review outcomes inform delivery; ordinary repository policy decides delivery commands. Dangerous-command safety and destructive-review consent remain independent. See Gentle AI's [review authority threat model](https://github.com/Gentleman-Programming/gentle-ai/blob/main/docs/review-authority-threat-model.md) and [Chapter 21 — Verifiable Trust](https://the-amazing-gentleman-programming-book.vercel.app/en/book/Chapter21_Verifiable-Trust).

## How the harness decides what to do

`gentle-pi` routes through the smallest safe workflow:

| Request shape                                                               | Harness                      |
| --------------------------------------------------------------------------- | ---------------------------- |
| Small, clear, local edit                                                    | Inline direct work.          |
| Unknown codebase area or context-heavy investigation                        | Focused subagent delegation. |
| Large, ambiguous, architectural, product-facing, or high-review-risk change | SDD/OpenSpec flow.           |

The goal is not ceremony. The goal is to avoid accidental chaos. Once a task stops being small, delegation is mandatory.

### Delegation triggers

`gentle-pi` keeps the parent session thin and delegates at the narrowest useful point. When the Pi Subagents extension is installed, the preferred runtime is the `subagent_*` tool family because it runs the user's configured project/global subagent definitions and preserves history/background behavior. With the background policy on, delegations default to background mode: the terminal stays free and each result comes back as a message that starts a new turn; task mode is reserved for delegations that must ask the user something mid-flight. If those tools are unavailable, the parent should fall back to Pi's native `Agent` tool or another available delegation mechanism. The requirement is delegation; the runtime is capability-dependent.

| Trigger                                                                                                                     | Required behavior                                                             |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Reading 4+ files to understand a flow                                                                                       | Launch `scout`, `context-builder`, or the closest read-only mapping subagent. |
| Touching 2+ non-trivial code files                                                                                          | Delegate one writer; do not continue inline unless delegation is unavailable. |
| Commit, push, or PR after code changes                                                                                      | Follow the loaded native instruction, or ordinary repository policy when none is supplied. |
| Wrong cwd, worktree/git accident, merge recovery, confusing test/env issue                                                  | Stop, preserve the affected scope, and investigate separately before resuming. |
| Long monolithic session with accumulating complexity, roughly 20 tool calls, 5 exploratory reads, or 2 non-mechanical edits | Pause and delegate the remaining work, or stop and explain the exact blocker. |

The intended balanced loop for a bounded bugfix is:

```text
parent git/status + clarify → one worker writes authorized fixes → focused verification → parent reports
```

`scout`/`context-builder` save parent context by compressing broad exploration. `worker` preserves a single writer thread. Any RDD-specific actor behavior belongs to the runtime instruction supplied by Gentle AI, not to this README.

### Review authority recovery and reset safety

Legacy pre-graph authority is never migrated. `gentle_review inspect` reports an exact repository-bound destructive reset challenge for legacy corruption; after that fresh interactive authorization, RESET and RECOVER_LOCK route to the audited native `gentle-ai review reclaim` operation and RECOVER routes to native `gentle-ai review recover`, so every destructive transition is executed and audited by the native authority store. Native inputs the request did not carry return a `native-input-required` envelope instead of being invented. Existing graph-v1 ordinary lineages remain readable and gate-validatable but are read-only; Judgment Day remains mutable on graph-v1.

`gentle_review abandon`, `quarantine-legacy`, and `reconcile-authority` remain explicit v2.1.11 maintenance routes. Pi derives and displays the published nine-line `gentle-ai.review-abandon-authorization/v2` binding only for a caller-specified compact lineage, revision, snapshot identity, and discarded-work summary (captured lens results, findings presence, evidence-record presence); the native CLI re-derives non-terminal compact-v2 eligibility and the exact discarded work before accepting it. Legacy quarantine accepts only `historical findings freeze changed unrelated transaction state` with disposition `quarantine-malformed-freeze-event` and uses its exact eight-line binding. Both require fresh interactive approval and fail closed headlessly.

`gentle_review reconcile-authority` accepts one predecessor lineage and revision, one successor lineage and revision, an actor, and a reason. Pi derives the exact seven-line `gentle-ai.review-reconcile-authorization/v1` binding, or appends exactly `anomalies=unchanged_target,malformed_recovery_authorization` for the published dual anomaly in that order. Native code re-derives every anomaly; malformed bindings, changed revisions, unavailable native support, cancellation, and native refusal fail closed through typed envelopes.

Reconciliation is intentionally narrow: native code may quarantine only the bound invalid compact-v2 recovery successor and persists the returned audit record; the predecessor stays untouched. Pi never recreates the retired `prepare-supersession`/`supersede` authority writer and never falls back to RESET or RECOVER.

`gentle_review repair-legacy-alias` is the sole v2.1.11 route for `unsupported historical v1 operation alias`. The model supplies only lineage, actor, and reason. Pi freshly reads the native inventory, derives the canonical repository, exact legacy revision, fixed diagnostic, and fixed `quarantine-approved-historical-alias` disposition, displays the LF-only eight-line binding, and requires a new interactive approval. Native re-derives eligibility and quarantines rather than rewriting or validating the historical chain.

`review dispose-result` is deliberately unsupported by Pi pending a separate design; it has no controller operation or fallback. All maintenance routes fail closed headlessly and never auto-run against legacy history.

Native lifecycle status remains informational. VALIDATE does not authorize delivery; commit, push, PR, and release commands follow ordinary repository policy. Recovery grants no new budget, and legacy graph bundle export/import is retired.

This is the post-U8 boundary, not the final architecture. [Issue #191](https://github.com/Gentleman-Programming/gentle-pi/issues/191) is the immediate final unit in this same delivery: extract the remaining Pi command-projection and lifecycle-gate surface from `review-transaction.ts`, repoint runtime enforcement, then delete only dependencies proven unreachable without weakening graph-v1 Judgment Day. The branch-wide High-tier 4R runs after that extraction, before the single size-exception PR.

### Review Lens Selection (architecture reference)

`reviewer` is not an installed subagent name. It is historical routing vocabulary, not a static instruction. When a runtime-specific Gentle AI instruction applies, it alone determines whether any concrete lens is used:

| Context | Review lens |
| --- | --- |
| Clear naming, structure, maintainability, small refactors | `review-readability` |
| Behavior, state, tests, determinism, regressions | `review-reliability` |
| Shell/process integration, partial failures, recovery, degraded dependencies | `review-resilience` |
| Security, permissions, data exposure/loss, architecture, dependencies | `review-risk` |
| Large PR, hot path, or >400 changed lines | Full 4R: `review-risk`, `review-resilience`, `review-readability`, `review-reliability` |

The former compact controller classified documentation/comment/formatting-only changes as zero-lens, standard changes as one dominant lens, and higher-risk paths as full 4R. This describes compatibility architecture only; never derive or run those choices from this README.

### Review authority architecture (reference only)

Gentle AI dynamically supplies runtime-specific RDD instructions. `gentle-pi` does not define an RDD lifecycle, command route, approval path, recovery sequence, or fallback. The historical compact-controller material below documents architecture and compatibility boundaries only; it is not an operator instruction.

Concretely: `gentle-pi` mirrors the Gentle AI provider contract bundle's `orchestration/pi.md` locally (`contracts/review-provider-contract-mirror/`, verified against the mirror lock's recorded SHA-256 before injection) and injects that mirrored text into the primary session's system prompt at session start. Gentle AI does not write anything into Pi's system prompt; when the mirrored contract is absent, unreadable, or fails digest verification, `gentle-pi` invents no fallback lifecycle.

```mermaid
flowchart TD
    A["Clarify scope and acceptance criteria"] --> B{"Choose the smallest safe workflow"}
    B -->|Small and local| C["Inline implementation"]
    B -->|Context-heavy or multi-file| D["Focused subagent"]
    B -->|Large or architectural| E["SDD phase artifacts"]
    C --> F["Implement with test evidence"]
    D --> F
    E --> F
    F --> G["Independent verification"]
    G --> H["Target-scoped native status"]
    H -->|Ambiguous or corrupted| X["Blocked: native maintainer action"]
    H -->|Unrelated| I["START freezes candidate, scope, tier, lenses, and budget"]

    subgraph Ordinary_review["Ordinary bounded review"]
        I --> R["reviewing"]
        R --> J["Run each selected lens once"]
        J --> K{"Severe candidate-caused blocker?"}
        K -->|No| A1["approved"]
        K -->|Yes| C1["correction_required"]
        C1 --> C2["Forecast bounded correction"]
        C2 --> C3["Apply scoped fix"]
        C3 --> V["validating"]
        V -->|Validator passes| A1
		V -->|Fails, malformed, or out of scope| E1["escalated"]
    end

    A1 --> O["Review outcome is informational"]
    E1 --> O
```

VALIDATE is informational. Commit, push, PR, and release commands follow ordinary repository policy; RDD never authorizes, rewrites, consumes review state for, or blocks them. Dangerous-command safety and destructive-review consent remain independent.

Native contract pairing is exact: this adapter resolves only the integrity-verified package-local Gentle AI v2.7.0 executable, independently hashes it, then negotiates `gentle-ai.review-integration/v2` outside the repository. Capabilities are cached by that executable digest. Every START, target status, FINALIZE, validate, and BIND-SDD request passes the same contract identifier. Negotiated envelopes decode exactly against the vendored schemas; `recover` routes only the provider-selected `action_disposition`, and optional additions require a future compatible schema/minor that the provider explicitly advertises and the consumer negotiates.

Contract `/v2` replaces the Base64 `candidate_diff` reviewer transport of `/v1` with immutable `base_tree`/`candidate_tree` plus an ordered `changed_path_manifest` and never an inline patch. `gentle-pi` negotiates `/v2` only, with no dual-lane fallback; the cutover landed as one atomic commit against gentle-ai v2.2.2 (tracked by the `migrate-review-integration-v2` change), and the `/v1` schemas stay packaged because the `/v2` schemas `$ref` into their fragments. This provider contract version is unrelated to Pi's own internal "compact-v2" review-authority naming used below — the shared digit is coincidental, not a version pairing.

Target status owns `current_target`, `unrelated`, `ambiguous`, and `corrupted` applicability and returns one native action. Pi does not reconstruct ordinary authority from provider-private files or choose a lineage from repository-wide history. Restart recovery rebuilds only the derived candidate view from the native Git/content projection, including intended-untracked paths, symlinks, and immutable gitlink identities. Native failure envelopes retain their exact mutation outcome, replayability, required inputs, request digest, and next action. After an unknown or lost mutating result, Pi calls target status before any replay decision and returns only the provider-declared action.

Once the pinned gentle-ai runtime (currently v2.7.0) has written review authority, rollback MUST preserve every native store and receipt and MUST NOT run a downgraded binary against that repository. Disable the Pi route or roll forward to a compatible authority-aware release instead; deleting authority data or reinstalling an older binary is not a rollback path.

### FINALIZE wrapper input

`gentle_review` accepts `input` as a JSON-serialized object string. For initial results, provide `review_result.lens_results[]`; each selected lens appears exactly once with `lens`, `findings`, and non-empty `evidence`. A clean lens uses `findings: []`. Pair `final_evidence` with exactly one of `final_verification_passed` or `final_verification_outcome`.

```json
{
  "review_result": {
    "lens_results": [
      {
        "lens": "review-reliability",
        "findings": [],
        "evidence": ["complete candidate reviewed"]
      }
    ]
  }
}
```

This is the Pi wrapper contract, not the native CLI file contract. The native command receives separate `--result`, `--refuter`, `--validation`, and `--evidence` files from the wrapper.

START derives the complete Git/untracked snapshot, lineage, persisted `low | medium | high` tier, zero/one/four lenses, authored changed lines, and correction budget `min(200, ceil(original_changed_lines / 2))`. Generated `testdata/golden/**` stays in snapshot identity but does not count as authored risk lines.

Every finding requires `evidence_class`, `causal_disposition`, and concrete changed-hunk, candidate-created-path, differential-test, or before/after proof. Missing IDs are assigned natively and selected-lens results are canonicalized deterministically.

Actor output is untrusted data and cannot authorize transitions, fixes, receipts, gates, or delivery.

Only severe `introduced`, `behavior-activated`, or `worsened` findings with valid proof enter correction IDs. `pre-existing` and `base-only` become follow-ups; `unknown`, insufficient, malformed, or inconclusive severe claims escalate. WARNING and SUGGESTION are informational.

Deterministic blockers need no refuter. Inferential blockers use exactly one complete read-only refuter batch.

Refuter proof may be independent concrete reproduction evidence; it does not need to duplicate reviewer `proof_refs`. Invalid, empty, malformed, missing, duplicate, unknown, or inconclusive refuter output escalates without a replacement refuter.

When native IDs are assigned to inferential findings, the first FINALIZE returns their canonical rows and a content-derived request hash without mutation; the second replays identical lens input with that hash and one complete refuter batch.

Ordinary permits one correction transaction within the original budget. FINALIZE requires a positive forecast before editing and derives actual correction lines from Git; one targeted validator and final verification close that transaction. Initial lenses are never rerun, while frozen findings and genesis scope remain unchanged.

The validator checks original criteria and correction regression only and cannot add scope or findings. Final evidence is hashed during FINALIZE, never at START.

Compact ordinary has five states: `reviewing`, `correction_required`, `validating`, `approved`, and `escalated`.

The validator cannot change claims, add findings, request fixes, launch actors, or request another attempt. A failed correction escalates instead of opening another review budget.

Compact authority uses content-derived CAS under the Git common directory. Exact retries are idempotent; stale/semantic retries, terminal mutation, and same-lineage graph-v1/compact-v2 ambiguity fail closed.

Trust boundary: The local orchestrator and same-user process are trusted to execute selected actors and submit their exact outputs. Native code owns scope, risk, IDs, canonicalization, state, receipts, and gates, and rejects malformed or inconsistent results structurally and causally. Malicious same-user host/process authenticity is a non-goal because that actor can replace the extension or mutate local authority; externally trusted attestation would require a separately privileged signer/service and is not claimed.

Ordinary ends only as `approved` or `escalated`.

Judgment Day starts only when explicitly requested and replaces ordinary review for that lineage.

Judgment Day starts with exactly two blind judges and zero refuters.

Judgment Day alone may iterate discovery and scoped re-judgment, for at most two rounds.

Findings surviving round two escalate; no third-round transition exists.

Native review mode and the two candidate choices remain provider-owned lifecycle semantics. For a validated `consent/v3` envelope in the interactive parent TUI, Pi displays those two choices unchanged and adds a clearly separate host-owned action: **Run this review and allow reviews for this Pi session**. Only direct human selection creates this process-memory grant. Its scope is the coordinating live SessionManager session and the canonical Git common-directory identity of the selected repository: it runs the current envelope's exact provider `granted` invocation through the existing one-shot `answer-consent` path, then does the same for later fresh validated envelopes in sibling worktrees of that same clone, including package-owned children. An unrelated repository requires a separate explicit human grant. Reload preserves it; `/tree` retains it; revoke removes the current repository grant; quit, new, resume, fork, or process restart removes all session grants. The command's `status` action reports the in-memory state without changing provider mode or authority.

The host grant is held only in a schema-checked `globalThis[Symbol.for(...)]` WeakMap registry keyed by session and canonical Git common-directory digest. It is never written through session entries, settings, environment variables, or the old asked latch. A package-owned Gentle Agents child can request one bounded parent-owned stdio authorization for its own validated pending ordinary START; it sends only that target's canonical repository digest, and the parent rechecks the live task, digest, and current parent session grant before the child replays its exact provider grant locally. No candidate bytes, provider vectors, paths, local child grant, or delivery authority crosses that channel. External or legacy `pi-subagents` launchers do not receive this channel and remain unsupported. Headless/RPC/unsupported UI, external processes, model prose, tool arguments, cancellation, identity drift, malformed identity, and uncertain native results cannot create or consume the grant. Native workspace binding remains canonical and target-specific; session-wide consent never authorizes an unselected target or an unrelated repository. The grant conveys no review verdict, forecast/cost approval, acknowledgement, maintenance, delivery, or cross-repository authority. When the host cannot resolve the choice, `gentle_review` returns the original unresolved two-choice provider envelope unchanged for the normal lossless relay. SessionManager binding isolates simultaneous SDK sessions; Pi does not claim universal same-process agent-principal isolation because the SDK exposes no principal identity.

When RDD is on and an agent loop ends with an unreviewed candidate, `gentle-pi` sends one read-only reminder pointing the agent back to `gentle_review {"operation":"inspect"}` before it reports completion. This nudge is idempotent (at most once per target identity per session), never fires for a headless session or a subagent's own loop, and never runs START or answers consent itself. Pi treats a child `agent_end` as a latest-answer update, not completion: queued retry, compaction, follow-up, required verification, and legitimate post-correction verification remain live until `agent_settled`. It does not claim ready or RDD-ready first, but this ordering rule does not impose a universal full-suite requirement or turn a receipt into a delivery gate. At session start, `gentle-pi` records the current target identity as a baseline, so a candidate that already existed before the session began (the user's own prior work, not this session's output) never draws the reminder.

Review outcomes and receipt state are informational; commit, push, pull-request, and release delivery follow ordinary repository policy. No one-shot command authorization, publication-target revalidation, or receipt gate is required for delivery, and Pi does not inspect RDD mode or native authority to decide a Bash delivery command.

Dangerous-command safety remains independent and authoritative. Destructive-review-maintenance consent remains separate from delivery. Review operations, informational VALIDATE, and SDD perform no commit, push, pull-request, release, or publication operation.

The Pi host relay bounds each locked-down reviewer subprocess by materialized prompt size rather than by one fixed number: a 15-minute floor plus 15 minutes per mebibyte of prompt, clamped to a 2-hour ceiling. Set `GENTLE_PI_REVIEW_RELAY_PI_TIMEOUT_MS` to a positive decimal to replace that derived bound with your own; malformed values are ignored and the same 2-hour ceiling still applies, so no configuration turns a foreground finalize into an unbounded child process. A reviewer killed by the bound reports `pi-host-relay-timeout` with the elapsed time and the limit it was measured against, and it explicitly does not ask you to relaunch the identical slot — that would re-spend the model tokens to reach the same wall. Reviewer results admitted earlier in the same finalize stay admitted and are not re-run.

Adversarial review roles (the refuter and the targeted validator) are never Pi-authored: the provider renders self-contained `review.capture-refuter` / `review.capture-validation` vectors and Go runs its own locked-down `pi` process on them. Package agent assets remain a package-managed isolated installation. Project and user overrides may shadow a package asset; `gentle-pi` preserves those definitions and does not claim their effective permissions are package-compliant.

## SDD/OpenSpec flow

```text
init
  ↓
explore → research (optional) → proposal → spec ─┬→ design ─┐
                                                  └─────────┴→ tasks → apply → verify → sync → archive
```

The main loop is intentionally file-backed when you choose `openspec` or `both`:

```text
planning artifacts                implementation evidence        canonical update
──────────────────                ───────────────────────        ────────────────
proposal/spec/design/tasks   →    apply-progress/verify-report → sync-report → archive-report
```

For substantial work, the parent session coordinates the flow and each phase writes artifacts. That gives you:

- explicit requirements and non-goals;
- design decisions that survive compaction;
- task plans reviewers can reason about;
- implementation evidence;
- verification reports;
- sync reports that update canonical specs while keeping the change active;
- archive notes for future agents.

### OpenSpec artifact model

`gentle-pi` treats OpenSpec-compatible behavior as part of the harness. You do not need to install the external OpenSpec CLI/package for SDD.

In file-backed modes, canonical accepted behavior lives in `openspec/specs/`, while active changes carry deltas under `openspec/changes/`:

```text
openspec/
├── specs/                                      # accepted source of truth
│   └── {domain}/spec.md
└── changes/
    ├── {change}/                              # active work
    │   ├── proposal.md
    │   ├── specs/{domain}/spec.md             # full spec or delta spec
    │   ├── design.md
    │   ├── tasks.md
    │   ├── apply-progress.md
    │   ├── verify-report.md
    │   └── sync-report.md
    └── archive/YYYY-MM-DD-{change}/           # immutable audit trail
```

Delta flow:

```text
openspec/changes/{change}/specs/{domain}/spec.md
        │
        │  sdd-sync applies ADDED / MODIFIED / REMOVED
        ▼
openspec/specs/{domain}/spec.md
        │
        │  sdd-archive moves the completed change folder
        ▼
openspec/changes/archive/YYYY-MM-DD-{change}/
```

When a canonical spec already exists, change specs use requirement operation sections:

```markdown
## ADDED Requirements

## MODIFIED Requirements

## REMOVED Requirements
```

`MODIFIED` requirements must include the full requirement block, including still-valid scenarios, because sync replaces the canonical block by requirement name. `sdd-sync` syncs file-backed deltas into `openspec/specs/{domain}/spec.md` while keeping the change active; `sdd-archive` then moves the synced change to `openspec/changes/archive/YYYY-MM-DD-{change}/`.

Engram-only mode is different by design: Engram is working memory and does not maintain a canonical spec merge layer. Use `openspec` or `both` (hybrid file + memory persistence) when you need canonical spec evolution.

## SDD preflight and project files

`gentle-pi` does not require SDD agents to be copied into every project. The package ensures global Pi SDD assets exist under the Pi agent home and treats project-local files only as overrides/debug copies. Slash SDD flows such as `/sdd-*`, `/gentle-sdd-init`, and the explicit `/gentle:sdd-preflight` command run a lazy preflight and resolve session-scoped SDD preferences. For natural-language requests, the parent agent decides whether the work should use SDD and must run/reuse `/gentle:sdd-preflight` before continuing.

```text
~/.pi/agent/agents/sdd-*.md
~/.pi/agent/chains/sdd-*.chain.md
~/.pi/agent/gentle-ai/support/strict-tdd*.md
```

Preflight values resolve in this order: explicit current user/session choice, valid persisted preference, capability or already-selected strategy constraint, canonical default, then a prompt only when genuinely unresolved. Resolved values are reused for later SDD flows in the session.

Canonical values are `auto` execution mode, `openspec` artifact store, `ask-on-risk` delivery strategy, and a `400` changed-line review threshold. The delivery strategy domain is `ask-on-risk`, `auto-chain`, `single-pr`, or `exception-ok`; `chain_strategy` remains deferred until chaining is selected. `exception-ok` requires explicit `size:exception` acceptance and is never inferred. Consent, authorization, security, destructive/publishing, interactive phase approval, and ambiguous-scope gates remain human-controlled.

It does **not** overwrite existing global assets unless you explicitly run:

```text
/gentle:install-sdd --force
```

Manual preflight command:

```text
/gentle:sdd-preflight
```

## Skill registry

`gentle-pi` keeps a local registry at:

```text
.atl/skill-registry.md
```

The registry scans project and user skill roots, not package-owned skills. It exists to catch workflow skills that are present on disk but not visible in Pi's injected skill list.

It scans common roots such as:

```text
./skills
.opencode/skills
.claude/skills
.gemini/skills
.cursor/skills
.github/skills
.codex/skills
.qwen/skills
.kiro/skills
.openclaw/skills
.pi/skills
.agent/skills
.agents/skills
.atl/skills
~/.pi/agent/skills
~/.config/agents/skills
~/.agents/skills
~/.kimi/skills
~/.config/opencode/skills
~/.config/kilo/skills
~/.claude/skills
~/.gemini/skills
~/.gemini/antigravity/skills
~/.cursor/skills
~/.copilot/skills
~/.codex/skills
~/.codeium/windsurf/skills
~/.qwen/skills
~/.kiro/skills
~/.openclaw/skills
```

Behavior:

- `.atl/` is added to `.gitignore` when needed;
- the registry refreshes on session start;
- startup refresh is skipped when Pi starts with `--no-skills` / `-ns`, `--no-skill-registry`, or `GENTLE_PI_NO_SKILL_REGISTRY=1`;
- `/skill-registry:refresh` forces regeneration;
- a best-effort watcher refreshes when skill files change;
- the registry indexes skill names, full descriptions, scope, and exact `SKILL.md` paths without copying skill body rules.

Skill discovery is a guardrail, not a workflow router: it helps Pi load the right skill without forcing extra ceremony.

`gentle-pi` also ships package-owned `gentle-ai-skill-creator` and `gentle-ai-skill-improver` skills plus the `/skill-creation` prompt for creating or updating project skills. Both skills use `docs/skill-style-guide.md` as their normative style contract. The workflow checks for duplicates, keeps `SKILL.md` concise, uses one-line trigger-rich frontmatter, and reminds maintainers to refresh the registry after skill changes.

Packaged skills include `cognitive-doc-design`, `comment-writer`, `gentle-ai-judgment-day`, `gentle-ai-skill-creator`, `gentle-ai-skill-improver`, and the other delivery/review skills under `skills/`. SDD init is installed as the packaged `sdd-init` runtime agent under `assets/agents/` and refreshed with the SDD assets.

Compatibility: the package keeps the existing skill folders (`skills/branch-pr`, `skills/cognitive-doc-design`, `skills/comment-writer`, `skills/judgment-day`, `skills/skill-creator`, `skills/skill-registry`, and `skills/work-unit-commits`) but their exported frontmatter names are prefixed to avoid collisions with user/global skills. Treat former package names such as `branch-pr`, `cognitive-doc-design`, `comment-writer`, `judgment-day`, `skill-creator`, `skill-registry`, and `work-unit-commits` as legacy aliases in prose; runtime skill selection should use `gentle-ai-branch-pr`, `gentle-ai-cognitive-doc-design`, `gentle-ai-comment-writer`, `gentle-ai-judgment-day`, `gentle-ai-skill-creator`, `gentle-ai-skill-registry`, and `gentle-ai-work-unit-commits`.

Delegation contract:

- parent/orchestrator resolves project/user skills from the registry and passes matching paths under `## Skills to load before work`;
- SDD subagents still use their assigned executor/phase skill;
- during normal runtime, subagents should not independently discover additional project/user `SKILL.md` files or the registry;
- fallback loading is degraded self-healing and must be reported via `skill_resolution` as `fallback-registry`, `fallback-path`, or `none`.

## Persona modes

```text
/gentle:persona
```

| Persona     | Behavior                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| `gentleman` | Senior architect, teacher, direct technical feedback, Rioplatense Spanish/voseo when the user writes Spanish. |
| `neutral`   | Same discipline, warmer professional language, no regional expression.                                        |

Saved globally at:

```text
~/.pi/gentle-ai/persona.json
```

A project can still override the global default with:

```text
.pi/gentle-ai/persona.json
```

`/gentle:persona` writes the global config and updates an existing project override when one is present, so the current project does not stay stale. Run `/reload` or start a new Pi session after switching persona.

## Model and effort assignment

```text
/gentle:models
```

The modal discovers:

- project agents in `.pi/subagents/`, `.pi/agents/`, and `.agents/`;
- user agents in `~/.pi/agent/subagents/`, `~/.pi/agent/agents/`, and `~/.agents/`.

When applying routing, project agents write runtime profiles to `.pi/subagents.json`; global and built-in agents write profiles to `~/.pi/agent/subagents.json`.

Recommended model/effort shape:

| Agent kind                 | Recommended model                                    | Recommended effort (`thinking`) |
| -------------------------- | ---------------------------------------------------- | ------------------------------- |
| Explore, proposal, archive | Fast and cheap is usually enough.                    | `off` to `low`                  |
| Spec, design, tasks        | Strong reasoning model.                              | `medium` to `high`              |
| Apply                      | Strong coding and tool-use model.                    | `medium` to `high`              |
| Verify / review            | Strong fresh-context model.                          | `high`                          |
| Tiny utilities             | Inherit active/default model unless they bottleneck. | `inherit`                       |

Saved globally at:

```text
~/.pi/gentle-ai/models.json
```

Existing project-local `.pi/gentle-ai/models.json` files are still read as a legacy fallback when no global model config exists, but `/gentle:models` writes the shared global config.

Inside `/gentle:models`, press `x` to export the saved routing to `~/.pi/gentle-ai/models.export.json`, or `r` to restore from that file after confirmation. Export uses a versioned envelope and restore writes the normal `models.json` shape before applying routing to agents.

Config shape (per agent):

```json
{
  "sdd-design": {
    "model": "anthropic/claude-sonnet-4",
    "thinking": "high"
  },
  "sdd-archive": {
    "model": "openai/gpt-5-mini"
  }
}
```

Legacy string entries are still accepted and treated as `model`-only config.

## Gentle Shell

Gentle Shell is the visual layer gentle-pi puts on top of pi. It follows the Gentle themes: one border language, champagne titles, rose for whatever is alive.

In fullscreen at 140 columns or wider, the right sidebar scrolls **✿ Gentle-Pi ✿ → Status → Changes → Agents → TODO** together. The one-line heading is horizontally centered within the usable rail width, with pink flowers and normal white text in the Gentleman themes. Colors follow the active theme; no artwork scaling or custom fonts are used. Narrow/mobile terminals and regular mode retain bottom widgets without the sidebar heading. The original rose and text logo remain in the main chat startup intro.

The status bar replaces pi's three-line footer with a single line of segments:

```text
✿ gentle-pi ⟡ ~/work/gentle-pi main ⟡ gpt-5.5 · medium ⟡ ctx ▰▰▰▰▱▱▱▱ 45% ⟡ $9.49 sub ⟡ MCP: 3 servers enabled        Release notes
```

- Context is a gauge, not a number. It turns amber at 80% and red at 95%; after compaction it shows `?%` until the next response.
- Cost carries `sub` when the active model runs on a subscription login.
- Statuses other extensions publish through `setStatus` are appended as trailing segments; the session name sits at the right edge.
- On narrow terminals the session name is dropped first, then trailing segments, before the line is truncated.

The prompt wraps pi's editor in a rounded frame with a petal that shows what the agent is doing:

```text
╭─ ✿ working ──────────────────────────────────────────╮
│ type, or / for commands                              │
╰──────────────────────────────────────────────────────╯
```

- The petal is still while pi waits, spins with a `working` label while the agent works, and turns amber with a `queued` label when messages are waiting behind the current turn. pi's own "Working" row above the editor is hidden, since the frame already says it.
- The frame uses the theme's border color over the panel background, so the prompt reads as one panel with the cards around it; the editor's scroll indicators stay inside the frame.
- The hint appears only while the editor is empty.
- If another extension already installed a custom editor, Gentle Shell leaves it alone.

Changes across this session's registered worktrees show up below the editor and as an aggregate `±N` next to the session branch in the bar:

```text
✎ 3 files · +42 −7 · extensions/gentle-shell.ts, lib/shell-bar.ts, tests/x.test.ts · /gentle:changes
```

- Each registered root shows **all** dirty files: plain `git diff` against HEAD plus untracked files, including edits that predate this session. There are no baselines or file-level attribution filters.
- The canonical session cwd root is included automatically. Successful standard `read`, `write`, `edit`, `grep`, `find`, and `ls` calls register their target worktree after completion. Failed calls, shell command text, and prose never register roots. Only roots sharing the session's Git common directory are accepted.
- For opaque shell use or worktrees used earlier, call `session_worktree_register` with `{"path":"/path/to/worktree"}`. Registration is explicit, canonicalized, and deduplicated; unrelated dirty siblings remain invisible without an ignored-roots list.
- The root registry persists in Pi custom entries (`gentle-pi.session-worktree/v1`). Exit/resume and `/reload` restore the same session UUID; `/tree` keeps roots session-wide. New sessions, `/fork`, and `/clone` ignore inherited registrations with another UUID. Clean roots stay registered but hidden until dirty; missing/prunable roots are skipped safely. Ephemeral `--no-session` runs cannot persist across exit.
- Counts refresh after every tool call, at the end of each turn, and every 5 seconds in the background, so edits made from nvim or another agent show up without touching pi. `GENTLE_PI_SHELL_CHANGES_WATCH_MS` changes the interval; `off` leaves only the tool-driven refresh. Outside a git repository the widget stays hidden.
- On narrow terminals the file list is dropped before the summary is truncated.

`/gentle:changes` or `alt+g` opens the framed two-pane viewer. Dirty worktrees are accordion groups in the left pane, labeled with branch and directory basename (`detached` when there is no branch). Expand groups to reveal indented changed files; multiple groups can stay expanded. The right pane previews the selected file's lazy-loaded diff, or shows the selected group's full directory and summary. Clean, bare, missing, and prunable roots remain hidden; untracked-only roots are included.

- `j`/`k` or up/down traverse visible groups and files, keeping the selection in view. On a group, `enter`, space, or right arrow toggles expansion. Left arrow or backspace moves a file selection to its parent, or collapses the selected group. `ctrl+j`/`ctrl+k` or `pgdn`/`pgup` scroll the diff; `esc` or `q` closes the overlay.
- Opening, pressing `r`, and the background/overlay refresh cadence scan only registered roots. Worktree discovery supplies branch labels, never registration. No changes in registered roots means no widget and an informational notice instead of an overlay.
- While the overlay is open, git is polled every 2 seconds, so edits made from nvim, another agent, or a checkout show up in place. Expansion and selection stick to the raw worktree root and file path across refreshes; a diff reloads when its counts move.
- `GENTLE_PI_SHELL_CHANGES_KEY` rebinds the shortcut (pi key syntax, for example `ctrl+shift+g`); `off` disables it. On macOS, `alt+g` needs the terminal to send Option as Meta.
- On a file row, `o` (or `enter`) opens the selected file in `$VISUAL` or `$EDITOR`, with the selected worktree as the editor's working directory, and returns to pi when the editor exits. Diff lookup and caches are also scoped to that root; identical relative filenames in other worktrees cannot share a diff.
- Untracked files are diffed against an empty file so new files show their full content.

Subscription usage shows in the bar after the cost, and `/gentle:usage` opens a panel with every window per provider:

```text
✿ gentle-pi ⟡ … ⟡ $9.49 sub ⟡ codex 5h ▰▰▰▰▰▱▱▱ 62% · week 31%
```

- For Codex, usage comes from the same account usage endpoint the Codex CLI reads, using the OAuth token pi already holds. It is fetched at session start, at most every 5 minutes after a turn, and on `r` in the panel. Rate-limit headers on SSE responses are picked up too.
- For Claude Pro/Max, usage arrives in the rate-limit headers of every response, so the 5h and weekly windows appear after the first turn.
- The bar names the subscription it shows (`codex`, `claude`) and always follows the active model. The panel puts the active provider first, marked with the petal, and says why it has no data when it does not: API-key providers have no subscription windows, Claude reports after the first response, Codex waits for a fetch.
- Only the plan name and the windows are kept; account details in the payload are discarded.
- Gauges turn amber at 80% and red at 95%, like the context gauge.

Gentle notices are drawn as cards: the same rounded frame as the prompt, with the left rail and the title in the tone of the notice and the rest of the frame in the theme's border color.

```text
╭─ ✿ Gentle AI · review preflight ─────────────────────────────────────╮
│ Receipt-driven development is enabled, and this worktree holds an…   │
╰──────────────────────────────────────────────────────────────────────╯
```

- Every call into the gentle-ai binary and every `gentle_review` tool renders as a card under the rose, `🌹︎ Gentle AI`: the rail is amber while it runs, green when it finished, red when it failed; the expand key sits in the top rule once the tool finished, and the collapsed result shows only its line count. Reviewer captures name their lens (`review capture · risk`; the group lists all four).
- The review preflight reminder renders as a card in the transcript with the expand key in its top rule.
- An active dev-binary override shows above the editor at startup, in amber, naming the binary and its digest, and leaves with the first prompt; an invalid override shows in red with the reason.
- Subagents draw their own card; see Gentle Agents below.

### Gentle Agents

The current package requires Pi 0.85.1 or newer (development tests pin 0.85.1). Use the latest Pi release; gentle-pi does not update your installed Pi automatically. Children, including any `GENTLE_PI_AGENTS_PI` override, must emit `agent_settled`: `agent_end` records a run's output but is not completion because retries or queued continuations may follow.

The `subagent_*` tools and the agents card replace the third-party subagents package (remove `npm:pi-subagents-j0k3r` from your pi packages; while it is still installed the tools stay unregistered and a warning says so at startup). Agent definitions and settings are the ones you already have: markdown agents in `~/.pi/agent/agents/`, `~/.pi/agent/subagents/`, `<cwd>/.pi/agents/`, `<cwd>/.pi/subagents/` (project beats global, `subagents/` beats `agents/`), and `subagents.json` at the global and project level (`default_model`, `default_effort`, `default_mode`, `model_profiles`, `stall_timeout_ms`, `max_concurrency`, `history_max_tasks`).

Agent paths follow `GENTLE_PI_AGENT_HOME`, then `PI_CODING_AGENT_DIR`, then `~/.pi/agent` for definitions, config, history, child sessions, and transcripts. These overrides select the agent profile; they do not sandbox project or shared global resources.

```text
╭─ ❀ Agents · 1 active · 1 done ─────────────────────────────── 1m24s ╮
│ ✓  sdd-explore  map footer data sources    gpt-5.6-terra · 34k · $0.27 · 25s │
│ ◐  sdd-apply    write gentle-shell footer  gpt-5.6-terra · 12k · $0.09 · 41s │
╰──────────────────────────────────────────────────────────────────────────────╯
```

Every subagent is its own `pi --mode rpc` child process, so the terminal never runs subagent work: the host reads JSON lines, applies each one as a small delta to a bounded per-task thread, and notifies only the listeners of that task. A task-mode child's question (`ctx.ui.select`, `confirm`, `input`, `editor`) reaches you as an ordinary pi dialog; a background child's question is dismissed. Subagents have no automatic total execution timeout: a long-running child remains live while it continues emitting RPC events. A silent child still times out through the configurable `stall_timeout_ms` watchdog (default four minutes). Closing pi stops the children that are still running.

- `subagent_list_agents`, `subagent_run` (`agent`, `task`, `label?`, `context?`, `workspace_root?`, `mode?` task or background), `subagent_status`, `subagent_result`, `subagent_list_tasks`, `subagent_reply` (one current-session reply to a live child query), `subagent_cancel`, `subagent_send_message` (steer a running child), `subagent_continue` (resume a finished task in its own session).
- `subagent_run.workspace_root` selects an existing worktree in the session's Git clone. Validation happens before queueing; the child runs at that canonical root. Successful OS spawn registers the root in the originating parent session, including delayed queued launches, even without an active shell listener. Failed spawns do not register. `subagent_continue` retains the previous task's cwd; status and task details expose it.
- A background task's result comes back to the model as a `gentle-agents.result` message, drawn as a rose card, and starts a new turn when the agent is idle; the model never polls.
- A configured child can call `subagent_parent_message` with bounded, well-formed Unicode text. Notifications retain their existing admission semantics. A `kind: "query"` waits for one strictly correlated `subagent_reply` for at most 30 seconds; each child has at most four pending queries, and disconnect, timeout, stop, and send failure settle each request once. The current parent session alone can reply. The first admitted task-mode query ends the original tool response while its child keeps running; its eventual non-cancelled completion returns once as a follow-up only if that same session is still active. Channel closure prevents later sends and automatic retry is not provided. Peer transport, offline delivery, retries, and broadcasts are unsupported.
- The card shows the active session's tasks only: after `/new` or `/resume` the earlier session's tasks leave it and come back with their session. Finished rows stay for one minute (three at most), and the card spends at most a quarter of the terminal (three to eight rows) on tasks; beyond that the rest fold into one `… N more · alt+a to view` line so the editor never leaves the screen. Questions and running work keep their rows first.
- `/gentle:agents` or `alt+a` opens a full-terminal overlay. At 60+ columns, the split view shows groups/tasks beside the retained semantic thread; uppercase `F` or **Fullscreen** expands that thread. At 12–59 columns, click a current subagent directly to inspect its thread; in All sessions, first select its orchestrator. `Enter`/`Tab` also enter a narrow selection. **Back** or `Escape` returns one level, closing only at the root; **Close** or `q` closes globally without cancelling children. Selection and manual thread scrolling survive Back and resize.
- Mouse controls take priority over keyboard hints: **Follow** (`f`), **Open session** (`o`), **Stop** (`s`, legacy `c`, owned active tasks only), and **Scope** (`a`). A compact footer's `>` cycles through actions. Scope switches between this session's direct active children and all open orchestrators, including idle ones. Open writes a markdown transcript for `$EDITOR`, not a resumed child session. `j`/`k` move through lists or scroll an expanded thread; `ctrl+j`/`ctrl+k` and Page Down/Up page the thread. In Pi fullscreen mode, the wheel scrolls the viewport under the pointer; regular terminal mode does not capture mouse input. Below 12 columns or three rows, only a bounded Close cell remains; zero-sized terminals render nothing.
- The thread displays all retained Text, Thinking, Note, and Tool content without an additional presentation cap; existing store limits and truncation markers still apply. Only the selected task is subscribed while the overlay is open.
- Thread entries are presented as labeled Text, Thinking, Note, or Tool blocks; tool blocks show their status and nonempty output.
- Current scope has no orchestrator wrapper and excludes every terminal task. All sessions discovers open Pi instances sharing the same agent profile, even across repositories; it does not infer open sessions from retained tasks. Directory headings support left/right and mouse expansion, and cannot stop or open a task. Peer children and their retained threads are read-only: no local stop, editor-open, or continuation routing, and no import into the local task store.
- Presence refresh is paged while the overlay is open. Graceful shutdown withdraws an instance; after abrupt closure its last heartbeat may remain visible for up to 15 seconds plus the time to complete the next directory refresh. A recent heartbeat is a heuristic, not proof that a process is alive. Same-profile, same-user processes share retained activity text; this is not an authorization channel.
- `alt+s` confirms stopping the current active or queued subagents owned by the current process. `GENTLE_PI_AGENTS_STOP_KEY` rebinds it; `off` disables it.
- Finished tasks are written to `~/.pi/agent/gentle-agents/tasks/` (one JSON per task, newest `history_max_tasks` kept, default 200) and come back on demand for `subagent_result` and `subagent_continue`, never as overlay history. Child sessions live under `~/.pi/agent/gentle-agents/sessions/`.
- `ctrl+shift+a` collapses the card to its first row (`GENTLE_PI_AGENTS_KEY`), `GENTLE_PI_AGENTS_VIEW_KEY` rebinds the overlay, `GENTLE_PI_AGENTS_PI` overrides the pi command used for children, and `GENTLE_PI_AGENTS=0` disables the tools and the card.

### Gentle Todo

The `todo` tool and its card replace the third-party todo extension (remove `npm:@juicesharp/rpiv-todo` from your pi packages; sessions written by it replay into the new card).

```text
╭─ ❀ Todos · 1 of 3 ──────────────────────────────────────╮
│ ✓ Add quiet tool rendering                              │
│ ◐ Fix quiet tools conflict · fixing conflict            │
│ ○ Show git bash tails                                   │
╰─────────────────────────────────────────────────────────╯
```

Three things keep the list current, which a static tool description cannot:

- `write` replaces the whole list in one call, so the model rewrites the plan instead of patching it; `add`, `update`, `clear`, and `list` remain for single moves.
- Every turn's system prompt carries the open tasks and the rules: in_progress before starting, done right after finishing, update before ending the turn.
- A list that goes two turns untouched while tasks stay open turns amber with `stale · N turns`, and the prompt says so, so the model brings it up to date.

A finished list stays on screen for the turn it finished in and clears at the next. `ctrl+shift+t` collapses the card to the task in progress (`GENTLE_PI_TODO_KEY` rebinds it, `off` disables it); `GENTLE_PI_TODO=0` disables the tool and the card.

Set `GENTLE_PI_SHELL=0` to keep pi's built-in footer and editor.

## Commands

| Command                          | What it does                                                        |
| -------------------------------- | ------------------------------------------------------------------- |
| `/gentle:status`              | Shows package, SDD asset, OpenSpec, and global model config status. |
| `/gentle:doctor`              | Runs read-only diagnostics for SDD assets, model/persona config, memory tools, and safety guards. |
| `/gentle:models`                 | Opens global model + effort assignment UI. Press `x` to export and `r` to restore saved routing. |
| `/gentle:persona`                | Switches global persona mode, with project override support.        |
| `/gentle:background-subagents`   | Shows or sets the managed background-subagents policy (`status\|enable\|disable`), naming the source that decided it. |
| `/gentle:telemetry`              | Shows or changes the local Gentle AI telemetry trigger (`status\|enable\|disable\|preview`).  |
| `/gentle:banner`                 | Configures startup banner rose, text logo, and color preset.        |
| `/gentle:toggle-rose`            | Toggles the startup rose.                                           |
| `/gentle:toggle-text-logo`       | Toggles the startup text logo.                                      |
| `/gentle:banner-color`           | Selects a startup banner color preset.                              |
| `/gentle-sdd-init`               | Initializes or refreshes `openspec/config.yaml` (openspec/both stores only). |
| `/gentle:install-sdd`         | Repairs missing global SDD runtime assets without overwriting files. |
| `/gentle:install-sdd --force` | Force-refreshes installed global SDD assets.                         |
| `/skill-registry:refresh`        | Regenerates `.atl/skill-registry.md`.                               |
| `/skill-creation`                | Creates or updates an LLM-first skill using the packaged `gentle-ai-skill-creator` contract and style guide. |

Package-owned global SDD runtime assets are also refreshed automatically on session start when `gentle-pi` changes. Project-local `.pi/agents` and `.pi/chains` remain manual overrides and are never overwritten by startup refresh.

### Background subagents policy

Background delegation is off unless you turn it on. The policy is user-owned: only an explicit `/gentle:background-subagents enable` or `disable` writes it, and Pi automation never toggles it.

```text
/gentle:background-subagents           Report the effective policy, the deciding source, and the resolved capability.
/gentle:background-subagents enable    Write "on" to the global file.
/gentle:background-subagents disable   Write "off" to the global file.
```

Four sources can decide the policy, and the first hit wins:

| Priority | Source                                            | Notes                                                        |
| -------- | ------------------------------------------------- | ------------------------------------------------------------ |
| 1        | `<cwd>/.pi/gentle-ai/background-subagents.json`   | Project file. Outranks everything, including a global write.  |
| 2        | `<configHome>/background-subagents.json`          | Global file, written by `enable`/`disable`. `configHome` honors `GENTLE_PI_CONFIG_HOME` and defaults to `~/.pi/gentle-ai`. |
| 3        | `GENTLE_PI_BACKGROUND_SUBAGENTS`                  | Exactly `on` or `off`. Any other value is ignored.            |
| 4        | Built-in default                                  | `off`.                                                        |

Both files use the strict shape `{"schema":"gentle-pi.background-subagents/v1","policy":"on"}`. A file that is present but malformed fails closed to `off` and is **not** skipped in favor of a lower-priority source, so a typo in the project file disables background subagents rather than silently handing the decision to the global file. The command reports that case as a warning instead of an ordinary `off`.

Because the project file outranks the global one, `enable` still writes the global file but reports plainly when a project file keeps the effective policy unchanged. The resolved capability (`ready` or `absent`) reports whether `subagent_run` is actually callable in this session; a policy of `on` with capability `absent` means Gentle Agents is disabled or the retired subagents package is still installed.

Startup banner settings remain global in `banner.json` under `GENTLE_PI_CONFIG_HOME` (default `~/.pi/gentle-ai`). Existing `showRose` and `showTextLogo` opt-outs independently control the main startup artwork; both default to enabled. Changes apply on the next session or `/reload`. Color presets are `pink` (default), `cyan`, `yellow`, and `green`. The static sidebar heading is independent of these preferences and follows the active theme.

Startup flag:

```text
pi --no-skill-registry
```

Use it when you want skills available normally but do not want Gentle AI to refresh/watch `.atl/skill-registry.md` on startup. `pi -ns` / `pi --no-skills` also skip the registry startup work because Pi is already disabling skill loading.

## Included skills

- `gentle-ai` — harness discipline for controlled Pi work.
- `gentle-ai-branch-pr` — issue-first PR preparation.
- `gentle-ai-chained-pr` — split oversized changes into reviewable PR chains.
- `work-unit-commits` — commits as reviewable work units.
- `gentle-ai-judgment-day` — blind dual review, fixes, and re-judgment.
- `cognitive-doc-design` — documentation that reduces cognitive load.
- `comment-writer` — concise, warm, postable collaboration comments.
- `gentle-ai-issue-creation` — issue workflow with checks before creation.
- `gentle-ai-skill-creator` — create LLM-first skills with valid frontmatter.
- `gentle-ai-skill-improver` — audit and upgrade existing LLM-first skills.

## Memory

`gentle-pi` does **not** provide persistent memory by itself.

For memory, install the companion package:

```bash
pi install npm:gentle-engram
```

When memory tools are actually active, el Gentleman can save decisions, bug fixes, discoveries, user prompts, and session summaries across Pi sessions.

Memory contract for SDD delegation:

- parent/orchestrator owns memory retrieval and passes selected context into subagent prompts;
- subagents should not independently search memory during normal runtime unless explicitly instructed to retrieve a specific artifact or observation;
- subagents should save significant discoveries, decisions, bug fixes, and completed SDD phase artifacts before returning when memory tools are available;
- in memory/hybrid mode, SDD artifacts use stable topic keys such as `sdd/<change>/proposal`, `sdd/<change>/spec`, `sdd/<change>/design`, `sdd/<change>/tasks`, `sdd/<change>/apply-progress`, and `sdd/<change>/verify-report`.

## Telemetry

`gentle-pi` does not collect anything itself. [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai) owns anonymous usage telemetry end to end — install and heartbeat events, what fields are sent, rate limiting, and every opt-out. See its README/docs for the exact contract.

At session start, for a primary session only (never for a named or SDD sub-agent), Gentle Pi asks the local `gentle-ai` binary to send its own telemetry: it spawns `gentle-ai telemetry trigger --json` detached, with a 3 s deadline, discards its output, and never blocks session start or surfaces an error — an older binary without the verb is silently treated as nothing to do. This runs at most once per process.

Install counts for `gentle-pi` and `gentle-engram` come from npm download statistics; the package itself never emits an install event.

To opt out:

- `/gentle:telemetry disable` — asks the local `gentle-ai` binary to disable telemetry (also `status` and `preview` to inspect it without leaving Pi).
- `DO_NOT_TRACK=1` — Gentle Pi itself will not spawn the trigger, and `gentle-ai` also honors this standard on its own.
- `GENTLE_AI_TELEMETRY=0` — same effect, `gentle-ai`'s own environment switch.

`CI=true` also suppresses the trigger, since automated runs are not a real usage signal.

## Package contents

| Path                           | Purpose                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `extensions/gentle-ai.ts`      | Injects identity, orchestrates native review authority, refreshes global SDD assets, registers commands, applies model/persona config, and enforces runtime safety. |
| `lib/native-review-cli.ts`     | Strict package-local adapter for Gentle AI START, FINALIZE, VALIDATE, SDD binding, and status contracts.     |
| `lib/review-integration-v2.ts` | Strict consumer decoder for negotiated capabilities, operations, target status, projections, repair, and failures against contract `review-integration/v2` (active today).  |
| `lib/review-candidate-view.ts` | Builds immutable changed-scope actor views while preserving full-tree, path, mode, symlink, and index integrity. |
| `lib/review-canonical.ts`      | Permanent Pi-owned canonical JSON and domain-hash primitives for consumer-side identities.                   |
| `lib/review-repository.ts`     | Permanent Pi-owned Git common-directory identity, safe Git environment, and authority-root binding.          |
| `lib/gentle-ai-binary.ts`      | Resolves and verifies the confined package-local Gentle AI runtime without global or PATH fallback.          |
| `scripts/gentle-ai-installer.mjs` | Installs signed Darwin/Linux archives or exact Go SumDB-verified Windows source builds into the package-local runtime. |
| `contracts/review-integration/v1/` | Byte-identical provider schemas and conformance fixtures for contract `review-integration/v1`, hash-checked before packaging; retained on disk permanently because `/v2`'s schemas `$ref` into these fragments. |
| `contracts/review-integration/v2/` | Byte-identical provider schemas and conformance fixtures for contract `review-integration/v2` (immutable `base_tree`/`candidate_tree`, ordered `changed_path_manifest`, no inline candidate diff), hash-checked before packaging. |
| `extensions/startup-banner.ts` | Shows and configures the startup intro, color presets, and compact runtime panel.     |
| `extensions/sdd-init.ts`       | Registers `/gentle-sdd-init` for OpenSpec initialization.                                                         |
| `extensions/skill-registry.ts` | Maintains `.atl/skill-registry.md` from project/user skills and closes file watchers on shutdown.          |
| `assets/orchestrator.md`       | Parent-session orchestration contract (always-on core).                                                    |
| `assets/orchestrator-delegation.md` | Lazy-loaded delegation/routing/review detail, including the mirrored gentle-ai canon.                 |
| `assets/orchestrator-memory.md` | Lazy-loaded SDD memory phase table, artifact keys, and lifecycle rule.                                    |
| `assets/orchestrator-skills.md` | Lazy-loaded skill registry fallback semantics and intent-driven skill discovery.                          |
| `assets/sdd-orchestrator-workflow.md` | Lazy-loaded SDD workflow surface for the parent orchestrator.                                       |
| `assets/agents/`               | SDD agents installed as global Pi runtime assets.                                                          |
| `assets/chains/`               | SDD chains installed as global Pi runtime assets.                                                          |
| `assets/support/`              | Strict TDD support docs for apply/verify phases.                                                           |
| `skills/`                      | Gentle AI delivery and collaboration skills.                                                               |
| `prompts/`                     | The `/skill-creation` prompt template.                                                                     |
| `docs/skill-style-guide.md`    | Normative style guide used by the packaged skill creation/improvement skills.                              |
| `docs/native-authority-architecture.md` | Post-U8 ownership boundary, reproducible slimming metrics, Windows evidence, exact #191 seam, and the `review-integration/v1`→`v2` migration status, including the "compact-v2" naming disambiguation.     |
| `docs/review-integration.md`   | Negotiated provider/consumer contract and the current Gentle Pi adoption boundary.                         |
| `docs/prompt-history.md`       | Prompt-history slice 1: opt-in capture switch, storage layout, readers, and disable/removal semantics.      |

## Development

Install from this repo:

```bash
pi install .
```

Validate before publishing:

```bash
pnpm test
bun build extensions/skill-registry.ts --target=node --format=esm --outfile=/tmp/skill-registry.js
node --experimental-strip-types --check extensions/gentle-ai.ts
node --experimental-strip-types --check extensions/sdd-init.ts
node --experimental-strip-types --check extensions/startup-banner.ts
npm pack --dry-run
```

### Running the cross-lane battery

The cross-lane battery (`tests/crosslane/cross-lane.mjs`) validates the adapter against a real `gentle-ai` binary, end to end and out of CI on purpose. The pinned decoder lane only ever sees vendored fixtures, so new envelope schemas and full controller sequencing are never driven through a live lifecycle before merge; the battery closes that gap.

```bash
pnpm test:cross-lane                # requires the dev-binary override
pnpm test:cross-lane --with-model   # adds the real Go-owned pi reviewer run (model spend)
```

What it checks, against live scratch repositories:

- a low-risk lifecycle: START → native-approved FINALIZE → terminal burn; the `pre-commit` gate is informational and unmanaged, not an allow decision or retained receipt;
- the medium-risk `consent/v3` granted round-trip through the direct decoder lane;
- controller sequencing: each decoded offered next step equals the native transition; correction evidence precedes Go-owned targeted validation, then native approval and terminal burn leave no retained receipt;
- the active audited abandon end to end, asserting the adapter builds the exact nine-line `gentle-ai.review-abandon-authorization/v2` discarded-work binding and the native gate commits the quarantine record;
- after a scope change, a burned approved predecessor exposes no recoverable authority; recovered-successor hydration remains covered at unit level;
- forward-decoder freshness: every live envelope captured from the binary must decode without unknown-key rejection, the early warning that gentle-ai main grew a field gentle-pi lacks;
- the default no-model lane: 13 of 14 checks pass while the real-model check is intentionally skipped; Go-owned validation uses a deterministic scratch fake `pi`, and only `--with-model` runs the real locked-down reviewer with model spend.

Prerequisites:

- A real `gentle-ai` binary selected through the dev-binary override; there is no PATH or pinned-binary fallback, and the battery refuses to run without one. Either export `GENTLE_PI_GENTLE_AI_DEV_BINARY=<absolute path>` for the session, or register a persistent override with `/gentle:dev-binary <absolute path>` (stored at `~/.pi/gentle-ai/dev-binary.json` with schema `gentle-pi.dev-binary/v1`; the environment variable takes precedence over the registration, and the binary is re-validated and re-hashed on every resolution). Any real build works: an installed release binary or a locally built gentle-ai main.
- A Git checkout or worktree of this repository. The battery is a contributor tool wired to the repository layout and is excluded from `pnpm test` and CI by construction; run it from the repo, not from an installed Pi package.

The battery owns one throwaway scratch root under the OS temp directory and never touches the enclosing repository. Before any review lifecycle it creates private `HOME`, XDG config/cache/data/state, temporary, and RDD state directories inside that root; it proves RDD starts `off/default`, explicitly opts in with sandbox-global RDD, and removes the complete root after the run. It never requires or changes the user's ambient RDD mode. The default run spends no model tokens; `--with-model` launches one real reviewer model run and costs model spend.

It prints one PASS/FAIL/SKIP row per check plus a note, and exits non-zero when any check fails. A check blocked by a known upstream class is reported with a `known-red` prefix instead of being hidden; it remains a failure, not a success.

Running this battery against new gentle-ai builds (release candidates or main) and reporting red checks is a valuable contribution. The sibling provider-side battery lives at `scripts/cross-lane-battery.sh` in [Gentleman-Programming/gentle-ai](https://github.com/Gentleman-Programming/gentle-ai).

Publish npm through GitHub Actions only:

```bash
version="$(node -p "require('./package.json').version")"
tag="v${version}"
git fetch --no-tags origin "refs/tags/${tag}"
test "$(git rev-parse 'FETCH_HEAD^{commit}')" = "$(git rev-parse "${tag}^{commit}")"
gh workflow run publish.yml \
  --repo Gentleman-Programming/gentle-pi \
  --ref main \
  -f tag="${tag}"
gh run watch <run-id> --repo Gentleman-Programming/gentle-pi --exit-status
npm view gentle-pi@<version> version --registry=https://registry.npmjs.org/
npm dist-tag ls gentle-pi --registry=https://registry.npmjs.org/
```

Do not run `npm publish` locally for `gentle-pi`. Dispatch the trusted workflow definition only from protected default `main` and provide its sole `tag` input. The workflow requires an exact annotated `vSemVer` tag whose peeled commit, current remote `main`, dispatch/main workflow commit, checkout, and `package.json` version are identical. It rechecks remote tag and `main` immediately before publishing through OIDC with provenance and environment protection; an advanced `main` requires a new release version, never a moved tag.

## Principles

- Human control over agent momentum.
- Concepts before code.
- Artifacts over floating chat context.
- SDD when risk justifies it.
- Strict TDD when tests exist.
- One parent orchestrator, focused subagents.
- Reviewable changes over giant diffs.
