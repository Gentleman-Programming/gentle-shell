# Bounded diagnosis of the Windows entry deadline

User approved a separate isolated diagnosis after PR #2019's Windows installer job failed. This branch is diagnostic only, not a production fix or a merge candidate. PR #2019 stays at bdde57728bfce0ac373fa211ce539dbf8327c8f4 with its failed check intact.

## Evidence and classification

Class E: the cause is unresolved. Run 38029244843 / job 114146519522 reports the normal entry reaching its existing 5,000 ms guard, null status and no expected missing-bundle diagnostic. The same unchanged installer/probe/workflow passed at a674c9b2 in 3,121 ms. Variable timing does not prove a CPU, PowerShell startup or Node failure.

## One experiment

Run the same eight-file installer suite once on windows-latest with Node 24. Add fixture-only timing evidence for CMD spawn, the existing first PowerShell ownership-record observation, first stderr, expected diagnostic, guard and exit/close. A dedicated push workflow selects only this isolated diagnostic branch. No dependency installation or production changes.

Keep the five-second entry guard, ownership-scoped cleanup, output limits and every acceptance assertion unchanged. Do not retry to convert a failure to success. A diagnostic pass does not validate the failed PR head or explain its failure. If the experiment does not localize the cause, stop and report the evidence gap rather than repeat broad runs or invent a fix.

No main push, merge, auto-merge, issue closure, private configuration access, runtime activation or release is authorized. The closed #1965 and merged #2008 are historical context, not an open tracker or pending sibling fix.
