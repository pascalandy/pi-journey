# Working on Pi Journey

Read [plan.html](plan.html) for the design and acceptance contract. [README.md](README.md) owns user-facing setup and commands.

Use pnpm, Node 24+, uv, and just. Run `just install` once per clone; it installs dependencies and the lefthook hooks, which run gitleaks and Biome on staged files before each commit and `just check` before each push. Run `just check` before delivery. No model calls, GitHub writes, or daily-driver configuration changes belong in `just check`. Tests own temporary repositories and must preserve unrelated user files.

A PR merges into `main` only with a green `signoff` status on its head commit. Agents run `just check` and `just signoff-check` and report the result. When Pascal authorizes a merge, run `just merge` on the PR branch; that authorization covers its checks and signoff. Otherwise agents never run `just signoff`, `gh signoff`, or a merge. For a stack, sign off each layer, then run `gh stack merge`, or `gh stack unstack` and `just merge` each layer bottom-up. Never merge with `--admin`. CI runs only by hand with `gh workflow run ci.yml --ref <branch>`, and its result is not the signoff.

Keep the XState coordinator authoritative. Pi callbacks register capabilities and translate trusted operator events. Workers own no Git, shell, publication, or merge authority. Reviews stay read-only. Root owns source changes and mutating commands; delegated analyses stay read-only.

Record effect intent before remote mutation and confirm actual outcomes afterward. Reconcile uncertainty before retrying. Evidence belongs to a clean commit, approved plan, repository, and relevant base. Preserve findings across pushes. Add behavioral tests for ownership, cancellation, recovery, or merge-gate changes.

Do not reset files, force-push, install globally, change personal skills, or merge a delivery PR without explicit authorization. Keep private reviewer output and journals out of Git. Update the existing canonical document when behavior changes, then record a concise decision in `decisions.tsv`.
