# Delivery checklist

- [x] Read the Principles section of poteto-mode
- [x] Ground Pi APIs, repository patterns, scope, and acceptance criteria
- [x] Compare four independent architecture candidates
- [x] Cross-judge candidates and select the smallest coherent design
- [x] Publish the canonical HTML plan and review it with GPT-6 Astra high
- [x] Build and verify the mode policy and state-machine core
- [x] Build and verify owned workers, cancellation, and recovery
- [x] Build and verify GitHub delivery, reviews, monitoring, and merge gates
- [x] Exercise the actual Pi extension in an isolated SDK session
- [x] Complete documentation and the decision trail
- [ ] Run a second pass and independent code review and acceptance QA
- [ ] Open a regular PR and check its CI
- [ ] Leave the PR unmerged for Pascal

## Throughput checkpoint

- Blocking first steps: publish and review the plan, then establish types and the verification harness before feature code
- Independent workstreams: read-only design and review agents; Root owns all source writes
- Shared mutable state: one coordinator and one active writer per repository; reviews inspect a frozen candidate
- Smallest safe decomposition: one implementation owner keeps state, effect receipts, and SDK lifecycle contracts aligned

## Evidence boundary

`just check` covers strict types, 40 behavioral tests, formatting, prompt drift, a build, and isolated Pi RPC loading. The pipeline harness uses real temporary Git commits and remote refs, with simulated GitHub and model workers. It verifies unmerged delivery, lost-response reconciliation, denied protection, atomic head mismatch, changed destinations/remotes/commits, and three-layer landing with interrupted descendant preparation. The real process test kills the coordinator and proves its command stops. Reviewer protocol tests reject wrong runtime metadata, empty/malformed results, and stale heads. Actual model-backed worker quality and live protected merges remain unconfirmed. CI and the final independent gates follow next.

This checklist is a snapshot before the final candidate review. The PR description owns final review and CI outcomes so those changing results do not invalidate the reviewed source.
