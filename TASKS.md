# Delivery checklist

- [x] Read the Principles section of poteto-mode
- [x] Ground Pi APIs, repository patterns, scope, and acceptance criteria
- [x] Compare four independent architecture candidates
- [x] Cross-judge candidates and select the smallest coherent design
- [ ] Publish the canonical HTML plan and review it with GPT-6 Astra high
- [ ] Build and verify the mode policy and state-machine core
- [ ] Build and verify owned workers, cancellation, and recovery
- [ ] Build and verify GitHub delivery, reviews, monitoring, and merge gates
- [ ] Exercise the actual Pi extension in an isolated SDK session
- [ ] Complete documentation and the decision trail
- [ ] Run a second pass and independent code review and acceptance QA
- [ ] Open a regular PR and check its CI
- [ ] Leave the PR unmerged for Pascal

## Throughput checkpoint

- Blocking first steps: publish and review the plan, then establish types and the verification harness before feature code
- Independent workstreams: read-only design and review agents; Root owns all source writes
- Shared mutable state: one coordinator and one active writer per repository; reviews inspect a frozen candidate
- Smallest safe decomposition: one implementation owner keeps state, effect receipts, and SDK lifecycle contracts aligned
