# Gentle AI review provider contract

This data-only bundle describes the provider result contracts admitted by Gentle AI.

## Activation

1. Verify the signed release checksum manifest before using this archive.
2. Verify every listed file hash and the transport capability before activation.
3. Confirm your runtime identity appears in the manifest's registered runtimes before trusting the layout.
4. Pass the Go-materialized opaque prompt to the provider and return only raw output or an error.

## Orchestration

manifest.json's orchestration array lists, for closed runtimes only, one
orchestration/<runtime>.md file: the exact review execution contract text
Gentle AI's own installer would have spliced into that runtime's system
prompt, for a runtime whose adapter has no system prompt to splice it into.
It carries no executable content, same as every other file in this bundle: a
runtime mirrors and delivers the text as-is and still relies on Go for every
review decision, prompt, receipt, and delivery gate.

Go remains the admission authority for prompts, results, receipts, and delivery gates.
