# Installer CI: one native Windows pass

The installer job still runs all eight suites on Linux, macOS and Windows. On Windows it checks the first run's TAP against the 30 literal native declarations and eight process modes: every name must appear exactly once as an executed pass. Other platform-specific skips remain valid. The job preserves the test process exit status and fails if TAP capture or verification fails. It no longer repeats the native suite.

## Compare hosted runs

Compare the exact base and candidate commits using the same event, runner image, Node and Go versions, and cache state. Record the queue, setup and installer execution times, exit status and full test inventories for each OS; repeat runs to expose variance. On Windows verify all 38 native passes and zero native skips from the first run. Local non-Windows runs and synthetic TAP fixtures do not prove native Windows behavior or a hosted speedup.

## Superseded pull requests

Only a newer run of the same pull request cancels its predecessor. Main pushes have unique run-ID groups and are never cancelled by this policy. Required tests and the native fail-closed evidence check are unchanged; hosted supersession behavior still needs observation.
