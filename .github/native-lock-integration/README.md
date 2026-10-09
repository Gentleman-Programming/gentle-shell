# Temporary candidate integration

Only pushes to `ci/4946-native-lock-integration` run this Ubuntu 24.04 matrix.
Node 22.19.0 and 24.14.0 run independently. This is S6 preparation; S1–S5
context and earlier partial Windows evidence are inherited, not rerun here.

The root graph uses the unchanged frozen pnpm lock with scripts disabled.
Only the existing integrity-pinned Gentle AI Node installer is explicitly run.
All HOME, temporary, configuration and cache locations are fresh runner-owned
paths. No workflow secrets, write permissions, environments, OIDC, release,
publication or persisted checkout credentials are requested.

Independent checks retain their actual outcomes; the final always-run gate
requires every named check to succeed. Timeouts, skips and missing results fail.
Each command is bounded; runner termination still marks the job unsuccessful.
The complete suite retains its stage/count/final-summary stdout. Gate outcomes
are also written to the job summary. No retries or automatic repairs are used.

The packed probe performs `npm pack --ignore-scripts` on this checkout and an
actual scripts-disabled npm installation in a separate consumer. SDK 1.0.0 and
native 1.5.1 are exact. **Consumer transitives resolve independently**, rather
than using the root pnpm lock; npm creates a consumer receipt lockfile in its
isolated temporary workspace. No installed files are patched. Native, SDK and
Jiti realpaths must belong to that consumer; the native platform/architecture
prebuild must be the loaded binding. Public SDK extension discovery loads the
installed TypeScript via SDK Jiti (not Node strip-types), then exercises the
registered model-save command and public saved-model startup application.
Assertions cover routes, Markdown, ownership, unrelated configuration,
permanent-lock inode and lock exclusion. JSON includes checkout commit and
packed tarball hash; the commit alone does not describe uncommitted content.

Network trust remains: pinned action code, pnpm/npm registries (root integrity
lock vs independently resolved consumer transitives), and the project's
integrity-verified native binary download. Script suppression is not a sandbox:
tests, the installer and SDK extension code execute trusted candidate code.
Read-only GitHub permissions and fresh ephemeral paths bound that exposure.
Parent-owned independent safety review must precede publication.

Local syntax/structural validation is not Linux execution. Hosted matrix results
are pending publication. Automated public SDK proof is **not interactive Pi
proof**, native review authority, full integration GREEN or fix delivery.
