# Offline fixture acquisition: policy slice

Only pure policy helpers exist in this slice. There is no acquisition entry point
or workflow yet. Nothing here proves hosted acquisition or offline runtime success.

## Local check

Run `node --test tests/offline-acquisition.test.mjs`. Tests use Node built-ins and
public pure helpers only: no downloads, candidate imports, package managers,
lifecycle hooks, SDK imports or tool probes.

## Integration contract for the runner slice

- `closedEnvironment` constructs a fresh Windows environment, never copies the
  parent environment. Its caller must create private HOME/config/temp/store paths,
  use explicit verified executable paths and isolated cwd, and prevent npmrc,
  pnpmfile, configDependencies, preloads and proxy/token inheritance. This helper
  alone does not establish process isolation or validate host facts.
- `pairFiles` mirrors candidate distributionFiles as data, changing only gentle-pi
  to the fixed local tar path. Pi remains 1.2.0. The original workspace's allowBuilds
  entry is preserved; command-level ignore-scripts remains mandatory.
- `commandPlan` supplies finite argv vectors. The runner must inject explicit
  private store/config paths and stop after any substantive failure. Resolution
  uses lockfile-only; fetch can materialize a virtual store. Registry selection
  is NOT a network boundary.
- `admitSources` accepts a normalized array, NOT raw YAML or a lockfile. Every
  element must be either the exact candidate tar with its newly measured SHA256,
  or an exact registry package/version/tarball URL with canonical SHA512 SRI.
  Unknown fields/protocols fail closed. These checks are only source admission,
  not proof of a complete or honest normalized projection.
- Before calling admission, the runner must use a verified trusted YAML parser,
  validate the actual lock schema, walk all importers/packages/snapshots and
  dependency references (including optional/platform records), reject unsupported
  settings/config dependencies and unadmitted sources, and ensure every resolved
  node is represented. No parser was selected, installed or executed in this slice.
  Never substitute regex extraction or root development lock metadata.
- `projectEvidence` bounds summaries while retaining original exit/error and
  truncation lengths. It is NOT a secret redactor. Supply only already-closed
  environments and non-secret command/output data; retain full stdout/stderr in
  owned artifact files before projection. Never reinterpret truncation as success.

## Remaining work

Verified pnpm archive bootstrap, Windows/Actions host refusal, actual c161 packing,
semantic lock parsing, acquisition orchestration, artifacts and workflow are T1b.
No claim is made about historical tar identity, registry gentle-pi equivalence,
companion npm/Go/native input closure, product publication or runtime validation.
