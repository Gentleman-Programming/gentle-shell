import assert from "node:assert/strict";
import test from "node:test";
import {
 mkdirSync,
 mkdtempSync,
 readFileSync,
 rmSync,
 writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
 createEventBus,
 createExtensionRuntime,
 ExtensionRunner,
 SessionManager,
 type ExtensionAPI,
 type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import gentleAgents, {
 type SessionTransportFactory,
} from "../extensions/gentle-agents.ts";
import { bindSessionRepositoryPreparation } from "../lib/bounded-writer-admission.ts";
import { SESSION_PROFILE_CUSTOM_TYPE } from "../lib/session-profile-persistence.ts";

// Admission tests use actual factory loader/runner and manager. They do not
// claim runtime lifecycle or visual evidence: those are separate fixtures.
for (const order of ["agents-only", "agents-first", "owner-first"] as const)
 for (const agent of ["explore", "worker"] as const)
  test(`U3 unavailable authority blocks ${agent} admission before effects (${order})`, async (t) => {
   const root = mkdtempSync(join(tmpdir(), "u3-admission-")),
    home = join(root, "home");
   const definitions = join(home, ".pi", "agent", "agents");
   mkdirSync(definitions, { recursive: true });
   for (const name of ["explore", "worker"])
    writeFileSync(
     join(definitions, `${name}.md`),
     "---\ndescription: fixture\nmodel: openai/gpt-4o\ntools: [read]\n---\nOffline fixture",
    );
   const manager = SessionManager.create(root, join(root, "sessions"));
   manager.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
   manager.appendCustomEntry("gentle-pi.session-profile/v99", {
    kind: "future",
   });
   const initialDisk = readFileSync(manager.getSessionFile()!, "utf8");
   const counts = { registry: 0, prepare: 0, child: 0, config: 0 };
   const transport: SessionTransportFactory = {
    createRegistry: async () => ({
     list: async () => [],
     listActivations: async () => [],
    }),
    createListener: (registry) => ({
     registry,
     start: async () => {},
     close: async () => {},
    }),
    createClient: () => ({
     close() {},
     sendNotification: async () => {
      throw Error("no messaging in fixture");
     },
    }),
   };
   const runtime = createExtensionRuntime(),
    bus = createEventBus();
   const agentsFactory = (pi: ExtensionAPI) =>
    gentleAgents(
     pi,
     {},
     {
      home,
      agentHome: join(home, ".pi", "agent"),
      env: { GENTLE_PI_CONFIG_HOME: join(root, "config") },
      sessionTransport: transport,
      schedule: () => () => {},
      childExtensionPaths: [],
      resolveWorktree: () => {
       counts.registry++;
       return undefined;
      },
      spawn: () => {
       counts.child++;
       throw Error("fixture forbids actual children");
      },
     },
    );
   const ownerFactory = createGentleAiExtension({
    nativeReviewCli: null,
    candidateViews: null,
    processEnv: { GENTLE_PI_AGENTS_CHILD: "1" },
   });
   const factories =
    order === "agents-only"
     ? [agentsFactory]
     : order === "agents-first"
       ? [agentsFactory, ownerFactory]
       : [ownerFactory, agentsFactory];
   const extensions = [];
   for (const factory of factories)
    extensions.push(
     await loadExtensionFromFactory(factory, root, bus, runtime),
    );
   const runner = new ExtensionRunner(extensions, runtime, root, manager, {
    find: () => {
     counts.config++;
     return { provider: "openai", id: "gpt-4o" };
    },
    getAll: () => [],
   } as never);
   runner.setUIContext(
    {
     notify() {},
     setStatus() {},
     setWidget() {},
    } as unknown as ExtensionUIContext,
    "tui",
   );
   runner.bindCommandContext();
   await runner.emit({ type: "session_start", reason: "startup" });
   const unbind = bindSessionRepositoryPreparation(
    manager,
    root,
    async () => {
     counts.prepare++;
     return false;
    },
    () => true,
   );
   t.after(async () => {
    unbind();
    await runner.emit({ type: "session_shutdown", reason: "quit" });
    runner.invalidate();
    rmSync(root, { recursive: true, force: true });
   });
   counts.registry = 0;
   counts.config = 0;
   const entries = manager.getEntries().length;
   const tool = runner
    .getAllRegisteredTools()
    .find(({ definition }) => definition.name === "subagent_run")!.definition;
   await assert.rejects(
    tool.execute(
     "unavailable",
     {
      agent,
      task:
       agent === "worker"
        ? "Implement\n## Allowed edit surfaces\nsrc/app.ts"
        : "Map safely",
      mode: "background",
     } as never,
     undefined,
     undefined,
     runner.createCommandContext() as never,
    ),
    /session profile authority unavailable/i,
   );
   assert.deepEqual(
    counts,
    { registry: 0, prepare: 0, child: 0, config: 0 },
    "unavailable authority cannot silently fall through to shared routing",
   );
   assert.equal(
    manager.getEntries().length,
    entries,
    "no queue/publication entries",
   );
   assert.equal(
    readFileSync(manager.getSessionFile()!, "utf8"),
    initialDisk,
    "rejected data and disk remain unchanged",
   );
  });

test("U3 independently evaluated binding readers share only process-local snapshots", async () => {
 const {
  bindSessionProfile,
  readSessionProfileBinding,
  clearSessionProfileBinding,
 } = await import("../lib/session-profile-binding.ts");
 const moduleUrl = new URL(
  "../lib/session-profile-binding.ts?u3-module-isolation",
  import.meta.url,
 ).href;
 const copy = (await import(
  moduleUrl
 )) as typeof import("../lib/session-profile-binding.ts");
 const models = { worker: { model: "openai/gpt-4o" } };
 bindSessionProfile("u3-module", "team", models);
 models.worker.model = "changed";
 assert.equal(
  copy.readSessionProfileBinding("u3-module")?.modelProfiles.worker?.model,
  "openai/gpt-4o",
 );
 const snapshot = copy.readSessionProfileBinding("u3-module")!;
 snapshot.modelProfiles.worker.model = "changed-reader";
 assert.equal(
  readSessionProfileBinding("u3-module")?.modelProfiles.worker?.model,
  "openai/gpt-4o",
 );
 clearSessionProfileBinding("u3-module");
 assert.equal(copy.readSessionProfileBinding("u3-module"), undefined);
 assert.equal(SESSION_PROFILE_CUSTOM_TYPE, "gentle-pi.session-profile/v1");
});
