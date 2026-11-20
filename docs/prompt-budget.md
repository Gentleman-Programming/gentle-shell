# Prompt byte budgets

The regression test measures a fixed primary-session fixture, not every live Pi loadout. Run it with:

```sh
node --experimental-strip-types --test tests/orchestrator-prompt-budget.test.ts tests/session-subject-routing-contract.test.ts tests/orchestrator-state.test.ts tests/orchestrator-work-search.test.ts tests/orchestrator-status-publication-contract.test.ts
```

Use isolated temporary and Gentle Pi configuration directories when running tests.

## Budgets and measurements

| Measurement | Ceiling | Before | After |
| --- | ---: | ---: | ---: |
| Rendered orchestrator core plus selected declarations | 16,600 B | 16,990 B | 16,554 B |
| Fixed assembled system text | 40,000 B | 33,993 B | 33,993 B |

The core is 9,114 B in both targeted measurements. The selected declarations decreased from 7,876 B to 7,440 B: a 436 B reduction. They are measured as UTF-8 bytes of compact JSON containing each registered tool's name, description and parameters, in the fixed order `orchestrator_session_id`, `orchestrator_list`, `subagent_run`. The targeted cap leaves 46 B of headroom. Only descriptions changed; the test also pins each tool's schema with descriptions excluded. The focused command includes the existing session-subject contract tests, retaining their exact exemption, identity-preservation, and privacy phrases.

The baseline is commit `eff5d24694b21663095a4790b3ef15de21c290c2`. Running the same fixture with that commit's `gentle-agents.ts` loaded in memory fails the targeted budget at 16,990 B and passes the non-description schema checks. The assembled system text is unchanged: this compaction reduces selected declaration bytes, not system-message bytes. These fixture results are not directly comparable to historical measurements with other loadouts or Pi versions.

## Fixed assembly fixture

The test calls Pi 1.4's actual pure system prompt builder, with the primary Gentleman harness in TUI mode, background policy off, RDD status unknown, and the verified mirrored review fragment. The production `appendSystemPromptOnce` helper appends harness then review; both complete fragments must appear exactly once in the assembled text. An explicit project-policy file inside the temporary fixture pins background off above ambient/global configuration; a regression check renders under both ambient `off` and `on` and requires identical output. Active tools are `read`, `bash`, `edit`, `write`, and the three named declarations above. Registered tool snippets and guidelines and one `work-unit-commits` skill are passed to the builder. The assets, installation/docs, fixture cwd and skill paths in the generated text are normalized to fixed `/fixture` paths before counting UTF-8 bytes.

Pi 1.4 does not export the builder at its package root. This test deliberately resolves its installed internal `core/system-prompt.js` adjacent to the public entrypoint; an upstream move or API change fails the test and requires maintenance. It starts no session and makes no model or native-review call.

The assembly budget excludes other extensions' guidelines, other skills, project instructions, dynamic session state, and provider serialization. The three declaration bytes are reported separately, not as part of the assembled system-text count. The fixture is not an exact provider request or a guarantee for other configurations. Bytes are not tokens, and these measurements do not establish latency or cost savings.

## Tools behind codemode

When `codemode` is declared in the primary session, rarely used or state-bound tools leave the per-turn declarations through each tool's `prepareLoadout` hook (`lib/hidden-tools.ts`, the same `hiddenDeclarations` projection as the RDD-off review loadout). They stay registered and active, so a codemode script calls them as `tools.<name>(args)`, and the system prompt gains one short route sentence per group:

- `orchestrator_list`, `orchestrator_consult`, `orchestrator_send_message`: always while codemode is declared.
- `gentle_guide`: always while codemode is declared.
- `gentle_design`, `gentle_design_comments`: only while the project has no `design/` directory; the route says "not declared in this run" (the state is read when a run starts) and names `tools.gentle_design({ action: "list" })`, the call the design hint requires before designing; the design skill names the same route once.

Without `codemode` (Pi's default when no MCP server or `defaultTools` entry activates it), every tool stays a direct declaration and no route sentence is added; `tool_search` alone is not treated as a route. Delegated children are unchanged.

Measured with an offline provider (RDD off, organic and full delegation alike): with codemode the declarations drop from 34,521 B to 27,321 B without `design/` and to 30,484 B with it; the system prompt grows by 114 B and 209 B. Without codemode both stay byte-identical (30,804 B). The decision is evaluated once per run, so consecutive requests carry the same tool list; a `design/` directory appearing takes effect at the next run and rewrites the cached request prefix once.
