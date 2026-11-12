# Agent tool overlay layer

Add a load-time overlay for subagent tools so users/extensions can `tools.add`/`tools.remove` without editing the package-owned agent file (which today freezes it out of `managed-assets.json`). Mirrors the existing routing layer (`models.json`). Issue Gentleman-Programming/gentle-shell#3133.

## Specs

**S1 — User request, verbatim.**
> fijate esto, por eso lo pregunto: Estimados caballeros de la mesa cuadrada
>
> En la 4.7.0 no se permite agregar herramientas a los subagentes ya que de otro modo estos ya no se actualizan.
>
> Ejemplo: agregó bash_background al worker en la 4.6.0 y en consecuencia la 4.7.0 ya no actualiza agregando el MCP de Codegraph
>
> Aunque lo cree como feature, es un bug para quien desea extender GS por medio de extensiónes
>
> https://github.com/Gentleman-Programming/gentle-shell/issues/3133

> vamos directo con la implementacion'

**S2 — Issue #3133 problem and proposed outcome, verbatim.**

Problem: "Routing (`model` / `thinking`) is kept in a separate layer (`models.json`, `/gentle:profiles`) and applied on top of the package-owned agent files at load. That is why a user can route agents to other models and the agents keep being refreshed on upgrades. The **tool allowlist has no such layer**. The only way to give a subagent a tool the package does not declare ... is to edit the `tools:` list inside the agent file."

Measured consequences (shipped installer, isolated agent home): editing `tools:` on a current body drops package ownership (`managed-assets.json` entry dropped) so the agent is never refreshed; on an outdated body the file is replaced and the added tool is lost; a user must choose between *keeping the tool* and *receiving updates*.

Proposed outcome: "Treat tool additions the way routing is already treated: a small declarative layer kept **outside** the package-owned file and applied at load." Per agent `tools.add` / `tools.remove` lists in the same places routing lives (global next to `models.json`, optionally project-level). "The package-owned part stays exactly what the package ships, so upgrades replace it freely; the overlay is re-applied on top." Manifest hash covers the rendered result. Extension registration via a drop-in directory (`agent-overlays.d/<extension>.json`) with merge order `package < extensions < user global < project`. Safe failure: unknown tool skipped with a notice; `remove` of an already-dropped tool is a no-op; invalid JSON ignored with a warning.

**S3 — Acceptance sketch, verbatim.**
1. Add `bash_background` to the worker via the overlay → installed worker lists it, manifest still owns the file.
2. Upgrade to a release that changes the worker body → body updated, `bash_background` still present, ownership kept.
3. Remove the overlay entry → next load drops the tool and the file equals the shipped one (plus routing).
4. Two overlay sources disagree → precedence is deterministic and visible.
5. Existing behavior for hand-edited files is unchanged (the current ownership tests keep passing).

## Tasks

T1 | S2, S3 | Overlay loader: read `tools.json` (global next to `models.json`, project `.pi/gentle-ai/tools.json`) and `agent-overlays.d/*.json`, merge order package < extensions < user global < project, safe-failure parsing (invalid JSON → warning, unknown keys skipped) | inline
T2 | S2, S3 | Apply overlay to `agent.tools` at load in the resolution layer (mirror of `resolveAgentProfile`), so the launch path (`lib/agents-runner.ts` `requestedTools`) and the harness see the overlaid list; `add` appends, `remove` filters, never written back to the agent file | inline
T3 | S2, S3 | Acceptance tests S3.1–S3.5, including the upgrade/ownership proof against `installPackageAssets`/`copyDirectoryFiles` and the existing hand-edit ownership tests staying green | inline
T4 | S2, S3 | Docs: `docs/gentle-shell.md` (or the tools/routing reference) describes the overlay file, merge order, and safe-failure behavior | inline

## Log

L1. 2026-11-12 user: "fijate esto, por eso lo pregunto: ... issue #3133 ..." then "vamos directo con la implementacion'". Authorized full implementation.
L2. Explored: routing layer is `models.json`/`subagents.json` resolved by `resolveAgentProfile` (`lib/agents-config.ts:414`), applied at load, never written to agent files; tools come only from `parseAgentDefinition` (`lib/agents-config.ts:206` `parseTools`) and are consumed by `lib/agents-runner.ts:336` `requestedTools`. Installer `lib/agent-assets.ts` `copyDirectoryFiles` migrates only `model`/`thinking` across upgrades; any other frontmatter edit drops the `managed-assets.json` entry or loses the tool.
L3. Implemented T1-T4. T1/T2 delegated to worker mwe0fwsn-1-eklx: `lib/agent-tool-overlay.ts` (`loadToolOverlays` drop-in < global < project with per-tool higher-precedence set merge + notices; `applyToolOverlay` add/remove); `DiscoveryRoots.configHome`, `DiscoveryResult.notices`, overlay applied in `discoverAgents`, `configHome` wired in `roots()`. Parent fixed the `notices` field regression in `tests/agents-config.test.ts:164` and added notices to `list_agents` output. T3 acceptance tests `tests/agent-tool-overlay-acceptance.test.ts` (S3.1/S3.3 overlay add/remove + ownership kept through forced refresh; S3.2 upgrade replaces outdated body while overlay survives; S3.4 precedence). T4 docs in `docs/readme-reference.md`. Verified: 105 tests (agents-config + overlay unit + acceptance + generic-agent-tools + package-manifest), 384 tests incl. gentle-agents, typecheck 0 diagnostics, `git diff --check` clean.
