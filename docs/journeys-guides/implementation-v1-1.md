$poteto-mode ;
Implement everything we agreed on, and open the PRs.

**Agency**
Do everything you think is advisable based on all of that, and start trying to close the biggest gaps yourself, especially the ones with the most "bang for the buck" in terms of the work needed to get a huge benefit in moving us closer to achieving the stated goals of the project (things like wiring in finished code that just isn't properly connected yet would be examples of that, but you can interpret the remit more broadly yourself using your own expert judgment).

I want you to show real agency and follow your gut instincts as to what will most improve the project. Also, start systematically, methodically, meticulously, and diligently executing any remaining issues/tasks in the optimal logical order!

Remember: use your expert judgment on all decisions to make the optimal choice. I believe in you! Keep cranking away on all that, friend! You're doing a great job.

**Scope**
- Order the work by value for effort. Wiring in finished code that isn't connected yet is the typical quick win
- When you find a gap outside those items, leave it unfixed and file it as a new issue with `$label-for-issues`
- Done when every item is implemented and verified, or reported as blocked with the reason

**Rules**
- One PR per verifiable unit, stacked with `$gh-stack` when they depend on each other. Assign each PR to pascalandy
- `$headless` runs use **Codex with GPT-6.1 Sol at xhigh**. Show each command in a code block before you run it.
- Keep going without me. You may push your own stack branches (`--force-with-lease` is fine), open and update PRs and issues, and merge when step 5 allows it.
- Stop and ask only when :
  - a contradiction or an unavailable live step blocks you (report it)
  - you need a decision from me
  - the next action deletes data, changes anything outside this repository and its PRs and issues, or force-pushes a branch you didn't create

Run these steps in order once you finished implementing the specs. Finish each one before you start the next:

**1. Self-check**
- Run $2nd-pass

**2. Impacts**
- Start a read-only headless run and ask it: "Use $poteto-mode and $blast-radius on 'stack PR URLs'. Then run a premortem: assume this stack merged and broke something a week later. Which blind spots explain it?"
- While it runs, write your own premortem. What could go wrong? Are we adding debt or code smells?
- Fix every high-severity finding from both premortems, then run `$2nd-pass` again

**3. External review**
- Start a headless run with `-s workspace-write` in the stack's checkout and ask it: "Use $poteto-mode to review the stack at 'URL'. The solution works. Make it great and pristine while keeping the solution simple. Fix what you find by editing the files directly, leave the changes uncommitted, and list each change with its reason."
	- the agent keeps `.git` read-only and has no network, so the commit is yours. Review its diff, run the checks, commit each change to the layer it belongs to with $gh-stack, and push

**4. Report**
- PR links, links to the issues you filed
- What you couldn't confirm, and where you looked
- Confidence to merge: XX %

**5. Merge gate**
- If confidence is at least 90 %, checks are green on every PR (or the repo has no CI and you say so), and no high-severity finding is open, land the stack with poteto's Shipping playbook.
- Otherwise, ask me how to unblock it (format below).

**6. Close**
- Feedback(s)on my skills: run `$pa-retro`. Publish its issues as needed (max: 3)
- Environment feedback: run `$retro`
- If the final code changed documented behavior, run `$pa-doc-update`
- Say goodbye

**When you need me**
Ask at most 4 questions per round, ordered by impact. Mark your recommendation and say in one line why each question matters, so I can reply "1a, 2b":

1) Question… (why it matters)
   - a) … (recommended)
   - b) …
   - c) …

If nothing is left to decide, write:

0) Implemented. [high-level summary of what landed]

After my answers, apply them and go back to step 1.