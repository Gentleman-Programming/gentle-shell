# PR #3178: reviewer progress visual evidence

Actual Pi SDK terminal-component screenshots for [PR #3178](https://github.com/Gentleman-Programming/gentle-shell/pull/3178). The image files are unedited browser screenshots of a PTY rendered by ttyd/xterm.js. They are not image-generation outputs, manually drawn mockups, or screenshots of a physical device.

## Provenance and scope

- Before source: `34a3c15c8ac88ca5823997e972f4b1ca8c1e1227`.
- After source: `dd8be33fdc5814c2d8e59f1dab3544e7a2b1a4b2`.
- Both source snapshots were produced by `git archive` and extracted into isolated Linux directories. Both use the same Pi SDK **1.5.2** dependency set, Node 24.21.0, `TuiAltScreen`, `ProcessTerminal`, and the actual SDK `ToolExecutionComponent`.
- The actual registered `gentle_review_run` executor and nested capture flow run through the repository's `createCoordinatorRuntime` support fixture and production `prepareReviewHostRelaySlot` / `runInProcessReviewer`. Native authority and materialization use local fixtures. The reviewer returns a real SDK event stream under deterministic local control. No real provider, credentials, model request, review verdict or remote delivery is used.
- The live component uses the product's actual call/result renderers. A tool update is fed directly to `ToolExecutionComponent.updateResult`, as in the host. The screenshots prove rendering and progress delivery for this component, **not a full interactive Gentle Shell session or a real provider-stall recovery journey**.
- The source session and installed user profile are not accessed. Each capture uses an isolated config/profile and Linux source directory.
- Terminal: ttyd **1.7.7**, xterm.js canvas renderer, font `Consolas,monospace` at 15 px; headless Windows Chromium from Playwright build 1248; device scale 1. Character dimensions are checked after viewport fitting. Browser dimensions emulate terminal viewports and are not physical-device evidence.
- Before/after match at **180 columns × 50 rows** and **80 × 24**, in both SDK `dark` and `light` themes. Each stream begins silent; one non-empty thinking delta is emitted at 8 seconds. Waiting screenshots are captured near 6 seconds, and streaming screenshots near 11 seconds. Exact completion timing can differ by tens of milliseconds between runs.

The old component remains at generic running status. The corrected component shows `review-risk: waiting-for-output (5s)` during initial silence and `review-risk: streaming (10s)` after reasoning activity. The private fixture delta never appears. No clipping was observed at either width/theme.

## Captures

Each row lists the actual before and after screenshots at the same stage, theme and character dimensions. `.txt` siblings retain the captured xterm buffer; `sha256.json` fingerprints every PNG.

| Theme / terminal | Stage | Before | After |
| --- | --- | --- | --- |
| dark / 180×50 | waiting | [before](before-waiting-180x50-dark.png) | [after](after-waiting-180x50-dark.png) |
| dark / 180×50 | streaming | [before](before-streaming-180x50-dark.png) | [after](after-streaming-180x50-dark.png) |
| dark / 80×24 | waiting | [before](before-waiting-80x24-dark.png) | [after](after-waiting-80x24-dark.png) |
| dark / 80×24 | streaming | [before](before-streaming-80x24-dark.png) | [after](after-streaming-80x24-dark.png) |
| light / 180×50 | waiting | [before](before-waiting-180x50-light.png) | [after](after-waiting-180x50-light.png) |
| light / 180×50 | streaming | [before](before-streaming-180x50-light.png) | [after](after-streaming-180x50-light.png) |
| light / 80×24 | waiting | [before](before-waiting-80x24-light.png) | [after](after-waiting-80x24-light.png) |
| light / 80×24 | streaming | [before](before-streaming-80x24-light.png) | [after](after-streaming-80x24-light.png) |

Evidence lives on a separate branch so it does not change the reviewed PR candidate or its CI results. Before screenshots are historical; after screenshots bind to the exact PR head above.
