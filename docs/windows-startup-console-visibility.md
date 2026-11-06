# Windows Startup Console Capture

Use this protocol to validate the startup Git child processes on a real Windows desktop. Linux CI can verify spawn configuration but cannot observe Windows console windows.

## Capture

1. Start a Windows window-event trace before launching Pi. Capture `EVENT_OBJECT_SHOW`, its timestamp, HWND, owner PID, and owner session.
2. Deliberately launch a known visible, short-lived console as a positive control. If its show event is absent, the capture is **INCONCLUSIVE**.
3. Build or install the candidate Gentle Pi package and start `pi` from a repository whose path contains spaces. Leave it idle for at least 10 seconds so the startup identity lookups (`git rev-parse --show-toplevel` and `git rev-parse --git-common-dir`), branch lookup, initial shell scan, and repeated poll run.
4. Correlate each show event with `GetWindowThreadProcessId`, then use its timestamp, host PID/session, and Procmon process-creation ancestry and command line to associate it with a Pi-launched Git invocation. The HWND can be owned by `conhost.exe`, OpenConsole, or Windows Terminal rather than `git.exe`.

## Expected Result

No `WS_VISIBLE` show event is associated with the Git invocation for the startup identity lookups, banner branch lookup, initial shell scan, or repeated shell polling. A visible show event proves window visibility, not that it was unobscured on screen. Process start alone is not visible-window evidence. If event-to-invocation association cannot be established, report **INCONCLUSIVE**, not pass.

## Scope

This protocol does not cover user-configured external editors. Their inherited-stdio launch is intentional and may open a visible window.
