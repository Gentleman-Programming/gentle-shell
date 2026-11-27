// The session keeper process `gentle-shell serve` starts for each session
// (lib/serve-session-keeper.ts); run as `node serve-session-keeper-main.mjs`
// with its config on stdin.

import { runKeeperProcess } from "./serve-session-keeper.ts";

await runKeeperProcess();
