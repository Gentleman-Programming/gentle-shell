# Observe native MCP connection status

Gentle Shell extensions use Pi's native MCP status API directly. No second MCP manager, polling command or installed-dependency patch is involved.

## Availability

Use a Pi build that exposes `pi.getMcpStatus()` and `pi.onMcpStatusChanged()`. Published Pi 1.4.0 predates these methods; this Shell change does not claim that an upstream release is already available or raise the optional peer requirement to a nonexistent version. Feature-detect both methods on older Pi builds.

The native implementation targets Pi base `6291b9b` (commit `c8fb968` on a local contribution branch) and has not yet been proposed upstream. Shell never patches installed dependencies to provide it.

Configured-server counts and `pi.getAllTools()` are **not** connection health. A server can retain registered tools after its transport dies. Until the native API is available, show `connection status: /mcp`, not an inferred ready/error state.

## Extension example

This optional JavaScript extension uses the existing footer-status interface; it is not enabled by default:

```javascript
export default function (pi) {
  let subscription;
  pi.on("session_start", (_event, ctx) => {
    subscription?.dispose();
    if (typeof pi.getMcpStatus !== "function" ||
        typeof pi.onMcpStatusChanged !== "function") {
      ctx.ui.setStatus("mcp-health", "connection status: /mcp");
      return;
    }
    const render = (all) => ctx.ui.setStatus("mcp-health",
      all.map((server) => server.name + " · " + server.state +
        (server.error ? " (" + server.error.kind + ")" : "")).join(" | ") || undefined);
    subscription = pi.onMcpStatusChanged(render);
    render(pi.getMcpStatus());
  });
  pi.on("session_shutdown", () => subscription?.dispose());
}
```

Snapshots contain only `name`, `state`, optional `tools` and `error.kind`, and `since`. States are exactly `connecting`, `ready`, `error`, `disabled`; categories are `auth`, `timeout`, `transport`, `config`, `unknown`. The normalized name matches the tool namespace suffix: `dev-docs` becomes `dev_docs` in `mcp__dev_docs`.

Reads and subscriptions never start connections, retries or authentication. Events include count/category changes; `since` changes only when the public state changes. Empty snapshots do not prove health: the native manager may not have started, may be disabled/replaced, or may have no servers. Invalid entries without runtime records remain diagnostics in `/mcp`.

The API excludes credentials, configuration values, URLs, raw errors, stderr and auth prompts. Keep all authentication and connection management in `/mcp`.

## Maintainer integration check

Build the Pi coding-agent package containing the API, then run:

```bash
GENTLE_MCP_STATUS_PI_ROOT=/path/to/pi/packages/coding-agent \
  node --experimental-strip-types --test tests/maintainer/mcp-status.maintest.ts
```

The explicit probe uses Shell's child invocation builder and Pi's real bundled CLI with a disposable home, an inert disabled MCP server and a synthetic provider that rejects model calls. It checks the exact snapshot and change event for one disabled server — normalized namespace and no fields beyond `name`, `state` and `since` — the exit status, that a server environment value never appears in the output, plus empty stdout and one exact status report on stderr (Pi's print-mode output guard redirects extension writes there). It does not exercise `tools`, `error.kind`, state transitions or provider credentials; Pi's own tests cover the full state, error-category and redaction contract. Without the selected runtime it reports a skip, not proof of API support. It neither reads your MCP configuration nor contacts a server or model provider.
