# Profiles roadmap: predictable session routing and explicit editing

**Status:** maintainer-approved plan. Sequencing, unit status, and readiness live in the Profiles roadmap index issue (link added on publication); this document records the contracts behind them.
**Scope:** Track A completes the remaining session-profile guarantees in [#1064](https://github.com/Gentleman-Programming/gentle-shell/issues/1064) and closes it on its own acceptance; Track B then evolves Profiles toward session-first editing without implicit shared writes.
**Implementation:** this document assigns no one and authorizes no delivery by itself.

## Evidence and limits

Local static inspection used commit `49b3bff8c154c1a4a554f46e60b1c48a6386d626`. GitHub issue and PR metadata were also inspected during planning; refresh affected evidence before implementation or publication. Do not assume the local snapshot is the latest remote head.

Sources include `extensions/gentle-ai.ts`, `lib/agents-config.ts`, `lib/session-profile-freeze.ts`, the session-profile persistence/authority/integration modules, `docs/session-profile-format.md`, and existing profile task records under `odd/tasks/`.

No functional tests, provider calls for routing verification, or interactive TUI walkthroughs were performed by this planning effort. Existing test names and PR-reported results are evidence of coverage intent, not fresh passing results. The full historical Profiles PRD was not available locally; undocumented historical commitments are not claimed as verified.

Reviewer parity concerns model resolution, not permissions: no reviewer gains rights to edit another session's routing.

## Current baseline

| Area | Evidence-backed state | Planning consequence |
| --- | --- | --- |
| Explicit session binding | Implemented by #1557/#1558 and follow-ups. Selection captures content rather than repeatedly resolving a name. | Reuse existing mechanisms. |
| Explicit selection persistence/lifecycle | Delivered through #1918, #1919, #1922, #1948, #1984, and #1990–#1993. | Do not reopen the completed Enter/persistence integration based on adjacent calls in the UI. |
| Inherited startup freeze | #1825–#1827 and #2007 implement freeze, follow opt-in, drift notices, and consumers. The inspected inherited freeze remains in memory. | Complete continuity across a new process. |
| Original D2 editing concern | #2276 was closed by the maintainer after the unified screen landed. A contributor reports saving the selected profile updates its definition without changing global `models.json`. | Do not describe original D2 as wholly undelivered or reopen it merely to justify a redesign. |
| Private session edits | The inspected dirty `use-session` UI path saves the named definition before binding. Definition editing is not private snapshot editing. | This is an explicit Profiles evolution, distinct from the original global-routing mismatch. |
| Reviewer resolution | The inspected reviewer reader omits inherited freeze; a contributor reports a prepared fix for frozen resolution and refuter/validator fallback through the session profile orchestrator. | Review and reuse that candidate; no parallel replacement implementation. Its code/test results remain unverified here. |
| Routing-screen read side | #2604 supersedes unmerged #2493 after the unified UI in #2588. | Build on the current screen, not obsolete panels. |
| Clear | Removes explicit binding, exposing the separate inherited freeze when present. Documentation and runtime fallback need reconciliation. | Specify the destination and restoration semantics. |
| Definition writes | Atomic temporary-file rename prevents truncated replacement, not stale-editor overwrites or multiwriter races. | State the intended concurrency guarantee honestly. |

The earlier search found 24 PR references to #1064: 22 merged and two closed without merge (#1926, #2493). This is a historical search result, not an exhaustive delivery ledger or proof of completion.

## Product direction and scope

The user should know, before confirming: **what is being edited, where it is saved, who will use it, and when it takes effect.**

Use one reusable editor with two explicit contexts:

| Context | Displayed configuration | Primary action |
| --- | --- | --- |
| This session | Session routing snapshot plus any local draft, with effective values and fallback provenance distinguished. | Apply to this session. |
| Saved profile: name | Stored definition plus its draft. | Save that definition. |

Separate applied state, draft state, and stored definition. The editor must not become a second routing authority.

Included: inherited continuity, reviewer parity, private editing, explicit definition save/load, truthful source/persistence information, existing default-scope clarity, tests, and documentation.

Excluded: a generic configuration-layers framework, duplicate editor implementations, whole-product UX redesign, automatic cleanup, unverified materialization removal, new agent-write permissions, and reconfiguration of queued/running children. New complete default managers and guaranteed multiwriter locking are not part of the initial proposal.

## Interaction contract

| Action | Session effect | Shared effect |
| --- | --- | --- |
| Edit a field | Draft only. | None. |
| Apply to this session | Adopt an explicit snapshot through existing authority/persistence mechanisms; report actual outcome. | No saved-profile, pin, or default writes. |
| Discard changes | Return to the relevant context base; in follow, display current live resolution. | None. |
| Save as profile | Does not apply; unapplied session edits remain unapplied. | Save displayed draft as a named definition. |
| Save profile | Does not update session snapshot. | Update the explicitly identified definition. |
| Load saved profile/version | Load into draft; Apply is separate. | None. |
| Remove session override | Remove explicit selection and expose the session's inherited base, or live resolution in follow. | None. |
| Change an existing default | Do not silently replace current snapshots. Follow sessions retain their documented live behavior. | Affect only the announced existing global/clone/repository scope. |

Overwriting a definition requires an explicit target and confirmation. Model edits do not require repetitive confirmations. A default action must not silently change destination because a pin exists or implicitly save a dirty draft.

Leaving, changing context, or loading another saved profile with a dirty draft offers discard or return. Cancelled pickers and failed writes preserve the draft. Avoid multiple hidden drafts per profile in the initial implementation.

Capture the session identity when the editor opens and revalidate it before session-scoped effects. A stale editor must never apply to a replacement session.

### Follow and visible state

Editing captures a stable draft base without disabling follow for launches. External changes do not mutate the draft. Indicate when effective resolution moved; Discard returns to current resolution. Applying explicitly adopts the displayed snapshot and takes precedence over follow.

Show source, mode, persistence, and relation to a saved definition separately. A comparison can be same, different, deleted, or not verifiable; do not infer deletion from a failed read. No named profile is a legitimate state.

### Sparse and empty profiles

Preserve omitted fields as omitted. Current role resolution selects each field from profile, agent definition, then defaults. A selected profile replaces the prior profile routing map rather than merging materialized entries back in.

Display configured values separately from effective values and their sources. Do not persist fallback values merely to fill the table. An empty snapshot is not clear/unbind.

[#2304](https://github.com/Gentleman-Programming/gentle-shell/issues/2304) remains a concrete acceptance case. Preserve sparse representation without automatically declaring its reported orchestrator fallback correct. Resolve whether the required change is routing, disclosure, or both before claiming that issue fixed.

A sparse routing snapshot does not freeze every agent definition or runtime fallback. Do not promise complete environment reproducibility.

## Persistence and lifecycle proposal

**Selected planning direction:** separate inherited baseline and explicit override logically; each new authoritative record carries complete relevant state, avoiding two independent histories or a new cache/authority.

**Selected representation: v1-additive.** Keep the v1 codec; no new record kind or version. Record the inherited baseline as a v1 `bind` with origin `local`, `repo`, or `global`, as the earlier 3b-i plan already agreed and the v1 decoder already accepts. Carry complete state through optional fields that v1 readers ignore, for example a base on user `bind` and `clear` records, so the newest record still determines state. Older programs keep routing the same snapshot and may mislabel it (explicit instead of inherited, already cleared). Field names are illustrative. A2 must confirm, before the contract is contribution-ready, that the disk reader and append controller tolerate the extra fields and how an explicit no-profile baseline is represented (candidate: a startup `clear` carrying an empty base).

Conceptual state, not a wire schema:

```text
Session state
  Inherited base: captured routing and origin, including explicit no-profile
  Override: none, named-profile snapshot, or private snapshot
  Provenance: descriptive source, not a live reference to a saved definition
```

The newest authoritative record on the selected branch should determine state. Clear records complete state with no override, retaining the baseline. Exact schema/versioning, follow interaction, no-baseline legacy handling, validation, and compatibility are the first technical work unit, not already implemented.

### Identity and compatibility

A private edit should be representable as a custom session snapshot, optionally based on a named profile. That name is provenance, not a claim of equality with a stored definition. Do not manufacture a saved-profile name to satisfy the existing codec.

The v1 codec requires `origin`, `name`, and `modelProfiles`. Any extension must preserve old reads, avoid rewriting history or migrating saved profile files, and specify older-program behavior on new records. Unsupported/invalid terminal records must not revive an earlier valid binding.

An original inherited baseline that was never persisted cannot be recovered retrospectively. Preserve corroborated explicit selections; identify a missing historical baseline as unavailable. Explicit adoption of current defaults is reconstruction, not restoration. The clear UI must not promise recovery of a nonexistent baseline.

### Required examples

| Example | Required observable result |
| --- | --- |
| Start on balanced; defaults change to fast; resume. | Restore captured balanced routing when persisted, not current defaults or the edited balanced definition. |
| Apply a private edit; remove override. | Shared definitions stay unchanged; return to the captured inherited base, not newly changed defaults. |
| Save unapplied draft as experimental. | Definition saved; applied session unchanged; draft still identified as unapplied. |
| Fork/tree at a selected history cut. | Use only state belonging to that branch/cut; never adopt future or sibling selections. |
| Resume legacy session without a recorded inherited base. | Do not fabricate historical state or label reconstruction as restoration. |
| Follow plus external change while editing. | Launches follow documented live rules; draft stays stable; explicit Apply changes to a session selection. |

### Failure behavior

Distinguish active-before-corroboration from failed append. An active but unpersisted selection must advertise that restoration is not guaranteed after process termination. Failed append must not adopt its failed entry or report success; preserve established authoritative state or block affected launches when authority cannot be established.

Keep live orchestrator switching separate from routing adoption. Report partial outcomes without claiming atomicity. Future launches use new routing; queued/running children retain their resolved routing.

### Shared-definition conflicts

Re-read the store before saving and compare with the editor baseline. Preserve the draft on conflict and offer reload or explicit overwrite. Preserve unrelated definitions changed by other writers.

This detects stale edits but is not compare-and-swap: another writer can intervene between the check and rename. Do not claim race-proof writes. If strict multiwriter protection becomes a requirement, give serialization/locking across all participating writers its own unit and acceptance tests.

## Milestones and ODD work units

Milestones express outcomes, not dates or promised versions. Unit labels are coordination identifiers, not instructions to create duplicate issues.

The work splits into two tracks. **Track A completes #1064** and closes it on its own acceptance. **Track B evolves Profiles** and does not gate #1064 closure. Track B builds on Track A's state contract; Track A never waits for Track B.

### Track A: complete #1064

| Unit | Outcome | Dependencies and readiness |
| --- | --- | --- |
| A1 Reviewer parity (formerly P3) | Reviewer resolution matches the parent-session authority launches use, including the inherited freeze, and the documented refuter/validator fallback. | No dependency; can proceed first. Reuse the contributor's reported fix; inspect the candidate and both ordinary/grouped paths. Acceptance: reviewers resolve through the same session-profile rule as launches, so later continuity changes reach reviewers without another reviewer change. |
| A2 State contract (formerly part of P1) | Representation of inherited base and explicit override, clear, legacy missing-base handling, branch-cut replay, and older-program behavior on new records. | First technical specification, using the v1-additive representation; wire contract not yet contribution-ready. Excludes private-snapshot identity (B1). |
| A3 Continuity (formerly P2) | Persist and restore inherited base and override across a new process; clear exposes the documented base and reports it truthfully. | Depends on A2. Specify capture/append timing and follow interaction; include legacy missing-base and branch-cut cases. |
| A4 Acceptance and closure (formerly P7/P8 for #1064) | Functional and interactive evidence for the original #1064 invariants, including how "Reload in this session" is satisfied; reconciled help, docs, and task history. | Closes #1064. Do not move unmet original requirements out merely to close it. |

### Track B: evolve Profiles

| Unit | Outcome | Dependencies and readiness |
| --- | --- | --- |
| B1 Private snapshot identity (formerly part of P1) | A custom session snapshot with provenance, never a manufactured saved-profile name. | Extends the A2 contract compatibly. |
| B2 Session-first editor (formerly P4) | Shared editor in session context, private drafts/apply, inheritance display, identity guard. | Depends on B1; no implicit shared writes. Open before readiness: what Make default does with a dirty draft, since a default names a saved definition; every consumer that reads the profile name as identity (drift notices, footer label, panel marker, status, Usage); announcing that Use in this session and Make default no longer save the draft first. |
| B3 Explicit library (formerly P5) | Definition editing, save/load/adopt, comparisons, stale-edit checks. | Coordinate with B2 as one editor integration surface. |
| B4 Acceptance (formerly P7 for Profiles) | Functional and interactive evidence for the complete editing contract. | No readiness claim based solely on labels or historical PR reports. |

Honest actions (formerly P6) are not a separate unit: source/status, partial outcomes, and existing default scopes ship with the unit whose behavior they describe. Clear honesty belongs to A3.

For each executable unit, specify scope, non-goals, acceptance, allowed edit surfaces, shared seams, applicable checks, dependencies, and owner only after confirmation. Tests and documentation travel with behavior. Use reviewable work-unit slices and native review under repository/user policy; this plan grants no review consent or delivery authority.

No blanket pause is required for independent fixes. A maintainer-requested scoped contributor pause was communicated while this plan is consolidated. On publication:

- **Resumes:** A1 reviewer parity through the contributor's reported fix; the independent fixes #2684, #2688, and #1803; and the work the reuse table below already marks as independent.
- **Remains paused:** A2 and A3 until the A2 state contract is specified; Track B units until their plans are complete.

Contributors are not assigned by this document.

## Existing GitHub work: reuse, do not replace

| Reference | Relationship and treatment |
| --- | --- |
| [#1064](https://github.com/Gentleman-Programming/gentle-shell/issues/1064) | Original execution umbrella. The roadmap is a coordination index, not a competing implementation issue. |
| [#2276](https://github.com/Gentleman-Programming/gentle-shell/issues/2276) | Original D2-related concern closed after unified screens. Do not reopen solely to justify private editing evolution. |
| [#2583](https://github.com/Gentleman-Programming/gentle-shell/issues/2583) | Broad editing-clarity input to UX acceptance, not a complete D2 specification or automatically resolved request. |
| [#2304](https://github.com/Gentleman-Programming/gentle-shell/issues/2304) | Empty-profile fallback defect report; retain explicit reproduction and acceptance. |
| [#2437](https://github.com/Gentleman-Programming/gentle-shell/issues/2437) | Agent mutation/guard policy is separate. No broad permission exemption follows from the human editor design. |
| [#2165](https://github.com/Gentleman-Programming/gentle-shell/issues/2165) | Import/export UX is complementary, not prerequisite to core continuity/private editing; do not silently change store/export paths. |
| [#2629](https://github.com/Gentleman-Programming/gentle-shell/issues/2629), [#2630](https://github.com/Gentleman-Programming/gentle-shell/pull/2630), [#2631](https://github.com/Gentleman-Programming/gentle-shell/pull/2631) | Independent opt-in shared-store cleanup. Preserve its explicit scope; coordinate UI integration and assess its own failure/inventory evidence separately. |
| [#2477](https://github.com/Gentleman-Programming/gentle-shell/pull/2477) | Legacy project routing merge can continue; preserve intentional profile omissions. It does not implement legacy global-home migration from #2163. |
| [#2684](https://github.com/Gentleman-Programming/gentle-shell/issues/2684), [#2688](https://github.com/Gentleman-Programming/gentle-shell/issues/2688), [#1803](https://github.com/Gentleman-Programming/gentle-shell/pull/1803) | Warning/render/test fixes are not automatically blocked by the roadmap. |

A contributor reports branch `fix/1064-reviewer-session-profile`; no matching PR was found by an exact-head query during planning. This does not prove the branch is absent. Bound-profile definition deletion and footer polling were also volunteered, not assigned or implemented by this effort. Make-default redesign and `models.json` migration remain separately scoped proposals.

## Acceptance and costs

Required evidence covers two parents in the same project; private editing with shared files unchanged; save without adoption; sparse/empty profiles; queued/running/future children; reviewer parity; resume/reload/new/tree/fork; clear versus definition deletion; drift; unknown versions; failed persistence; stale editor identity; shared-save conflicts; and partial orchestrator outcomes.

Run focused behavioral checks and applicable repository suites, then a real TUI walkthrough. Existing package scripts include `pnpm test`, `pnpm typecheck`, `pnpm test:harness`, and `pnpm run check:provider-contract`; choose applicability per unit and refresh current repository policy. Report failed, skipped, and unavailable checks explicitly.

The main cost is state transitions, compatibility, and verification, not evidenced runtime overhead. Reuse editor/codec/controller/resolver mechanisms; avoid new generic layers or duplicated screens. Explicit save/apply adds user actions but removes hidden shared effects. Avoid repetitive prompts. Performance, storage growth, and support improvements are not quantitatively measured.

## Living source

The Profiles roadmap index issue is the living source for sequencing, unit status, and readiness. Approved revisions are appended there, never rewritten. When a contract in this document changes, the index records the revision that changed it.

Community discussion starts from this plan. Maintainers own claiming, unit approval, and delivery decisions.
