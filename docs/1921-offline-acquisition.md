# Windows lock and npm-input acquisition

The push-only workflow on `ci/2360-offline-acquisition` acquires inputs on one
fresh GitHub-hosted Windows runner. It does not execute Shell, Core, Pi, Go,
native builds or package lifecycle hooks. Publication belongs to the parent
controller after review; this implementation has not been run on Actions.

## Local checks: no acquisition

- `node --test tests/offline-acquisition.test.mjs`
- `node scripts/offline-acquisition/runner.mjs --help`

Tests use Node built-ins, public pure helpers and inert help/actual host refusal.
They do not download tools, import the candidate/SDK, run a package manager or
simulate a positive Actions environment. Workflow tests are bounded source
checks, not a YAML parser or actionlint proof. PowerShell AST parsing proves
syntax only, not execution compatibility or isolation.

## Hosted sequence and effects

1. SHA-pinned checkout actions obtain controls at the workflow SHA and a separate
   immutable `c1617e90b81bac5a897a10211797bc30169794bf` candidate. Credentials
   are not persisted. Pinned setup-node supplies Node 24.21.0; no action cache.
2. The PowerShell launcher clears the Node orchestrator's entire environment,
   forwarding only named host facts. The runner rejects non-Windows,
   non-canonical/non-hosted/non-push contexts before creating files. These facts
   are runner context checks, not cryptographic host attestation.
3. All work is under a fresh `RUNNER_TEMP/shell-acquisition`, except the fixed
   fresh `C:/ShellFixtureInput/gentle-pi-4.3.0.tgz`. Existing paths cause refusal,
   never deletion or reuse. Children get only `closedEnvironment` keys, private
   HOME/AppData/temp/config/store paths and explicit executable paths; no inherited
   tokens, proxies, npmrc, pnpmfile or preloads. Ancestor configuration is rejected.
4. Direct public-registry HTTPS downloads yaml 2.9.0 and pnpm 11.1.1 once each.
   YAML's exact SRI comes from candidate `pnpm-lock.yaml`; pnpm's SRI is in policy.
   No redirects/retries; 60-second wall/inactivity deadlines and 64 MiB per tool.
   SHA512 is checked before narrow ustar inspection/extraction. Links, traversal,
   Windows device/ADS paths, duplicate names and unsupported PAX/GNU formats fail
   closed. The verified YAML tool has no runtime dependency closure to install.
5. Bundled npm packs the candidate with `--ignore-scripts --offline`, explicit
   empty user/global config and private cache. Candidate code is never imported;
   its package/workspace are inspected as data. This is a newly measured source
   tar, not historical eebd9 bytes, registry gentle-pi 4.3.0 or a published upgrade.
6. A genuine distribution pair retains Pi 1.2.0 and changes only gentle-pi's
   dependency to that fixed local tar. The candidate's original `allowBuilds`
   workspace entry is preserved; mandatory command flags disable lifecycle hooks.
   pnpm resolves with `--lockfile-only --ignore-scripts --ignore-pnpmfile
   --pm-on-fail=error`; it does not install product dependencies here.
7. The verified YAML parser rejects diagnostics/duplicates/aliases. Semantic
   traversal admits only supported lock v9 settings, the exact pair importer,
   all packages and snapshots, and resolvable dependency/optional references.
   Unknown schema/config fields and Git/custom/file origins fail closed, except
   the exact candidate tar with measured integrity. Registry sources need exact
   canonical npm URLs and SHA512. Strict schema/source rejection may stop a real
   run; local fixture tests do not prove compatibility with an actual resolved lock.
8. Only after admission does `pnpm fetch --ignore-scripts --ignore-pnpmfile
   --pm-on-fail=error` download inputs into private store/virtual-store paths,
   with fetch retries disabled. Fetch DOES materialize a virtual store. No fetched
   package is imported or executed. `--registry` is selection, NOT a network ACL.
9. System tar archives the owned store/virtual-store. Artifact upload runs even
   on failure, with only the owned artifact directory selected. One evidence-only
   archive attempt can follow a failed acquisition; acquisition itself never retries.

## Evidence and limitations

`evidence.json` retains pins, host/workflow/candidate identity, closed child env,
exact argv/cwd, exit/signal/error, bounded summaries and stream-file names. Full
captured stdout/stderr are separate files. Commands have a five-minute limit and
32 MiB capture bound; timeout/buffer exhaustion remains a failure, not complete
output. Tool GET parameters, original errors and partial archive bytes survive.
Artifacts also include pair files, actual lock, new local tar, tool archives,
admitted origins/SRIs, store archive and SHA256 inventory. The inventory excludes
itself and mutable evidence.json. No profiles, npmrc files or secret-bearing
parent environment are uploaded. Evidence projection is not a secret redactor.

Success status is only `LOCK_AND_NPM_INPUTS_ONLY`. Companion npm/Go/native inputs
remain unknown. No complete offline closure, functional success, network
containment, runtime compatibility or release/publication is claimed. Hosted
execution and data-only artifact inspection remain parent tasks after independent
security/environment review. No automatic rerun is authorized by this workflow.
