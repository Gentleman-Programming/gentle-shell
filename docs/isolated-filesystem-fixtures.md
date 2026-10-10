# Isolated filesystem fixtures

Registry fixtures place invalid `.git` metadata at their disposable outer directory. This stops Git from discovering an unrelated ancestor repository; real child repositories still use their own metadata. A nested-parent witness proves the barrier works even under a genuine Git repository. Bootstrap adoption, same-clone rejection, and poisoned-environment checks remain unchanged.

The history-GC unreadable-input test first tries real `chmod 000` permissions. If the file is still readable (Windows or privileged POSIX), it injects `EACCES` only for reads and opens of that exact sealed fixture path. All other filesystem operations remain real. Filesystem methods and builtin ESM exports are restored in `finally`; the test checks the compacted contents and byte-for-byte preservation of the sealed original. The scenario is never skipped.
