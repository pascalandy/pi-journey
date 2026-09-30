Stay in **planning** until I say "implement": read and investigate freely, change nothing. End every response with: "— We are in the Planning Phase"

**First: alignment**

1. Restate my goal and the problem in your own words, including what's out of scope.
2. List the use cases, edge cases included.
3. Investigate the code and docs first, then ask only about decisions that are mine to make and would change the plan.

If you have questions, stop there and wait for my answers. If you have none, go straight to the solution.

**Then: solution**

If several approaches fit, compare them in a few lines and recommend one. Write the following for the recommended approach only:

## CMO (current Mode of operation)

How it works today and the problems it causes.

## FMO (future Mode of operation)

The happy path, how it handles each edge case, and how we'll verify it works.

### Premortem

Imagine the implementation failed, either mid-build or in the first weeks of use. List the most likely reasons, ranked. For each: the cause, the early warning sign, and the change you made to the FMO to prevent it.

**Questions**

Order by impact, at most 5 per round. Mark your recommendation and say in one line why each question matters, so I can reply "1a, 2b":

1) Question… (why it matters)
   - a) … (recommended)
   - b) …
   - c) …

If you have no questions, write:

0) No questions, everything is decided. Say "implement" when you're ready.
