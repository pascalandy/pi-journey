# Working on Pi mode workflow

Read [plan.html](plan.html) for the design and acceptance contract. [README.md](README.md) owns user-facing setup and commands. [prompts/planning.md](prompts/planning.md) owns the literal Planning instructions; run `node scripts/plan-prompt.mjs` after changing that source to refresh its HTML snapshot.

Use pnpm and Node 24+. Run `just check` before delivery. No model calls, GitHub writes, or daily-driver configuration changes belong in the default verification path. Tests own temporary repositories and must preserve unrelated user files.

Keep the XState coordinator authoritative. Pi callbacks register capabilities and translate trusted operator events. Workers own no Git, shell, publication, or merge authority. Reviews stay read-only. Root owns source changes and mutating commands; delegated analyses stay read-only.

Record effect intent before remote mutation and confirm actual outcomes afterward. Reconcile uncertainty before retrying. Evidence belongs to a clean commit, approved plan, repository, and relevant base. Preserve findings across pushes. Add behavioral tests for ownership, cancellation, recovery, or merge-gate changes.

Do not reset files, force-push, install globally, change personal skills, or merge a delivery PR without explicit authorization. Keep private reviewer output and journals out of Git. Update the existing canonical document when behavior changes, then record a concise decision in `decisions.tsv`.
