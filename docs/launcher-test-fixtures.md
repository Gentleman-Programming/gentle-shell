# Launcher fixtures on Windows

Disposable Node-script mocks use a Windows-only preload restricted to the fixture root. Missing, nonfixture and non-Node executables retain native behavior; POSIX keeps native shebang execution.

The provisioning interrupt test uses a private IPC message to deliver `SIGINT` to the real launcher's handler on Windows. Node's `child.kill("SIGINT")` force-terminates a Windows process rather than delivering a console event. POSIX still sends the actual signal. Both branches require normal exit `130`, no Pi launch, and termination of the provisioning child.

The Windows result proves modeled event handling and child cleanup, not an end-to-end console Ctrl+C interaction. The separate child-self-termination case remains an ordinary setup failure and still allows Pi to launch.
