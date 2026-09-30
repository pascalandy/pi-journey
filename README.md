# Pi mode workflow

A Pi extension for planning without repository edits and delivering an accepted plan through an owned XState workflow.

The canonical design and acceptance criteria are in [plan.html](plan.html). The [published plan](https://om1.donkey-arcturus.ts.net:8444/html-publish/pi-mode-workflow-plan/) is private to the configured tailnet.

Start in Planning, share your idea, and resolve alignment questions. The assistant records a CMO/FMO/premortem plan with ordered units, writable paths, and named checks. Press **Ctrl+Alt+M** to approve the displayed plan and enter Implementation. Press it again to cancel owned work and return to Planning after it drains.

Implementation runs one Pi writer, commits its changes, runs checks against that commit, performs a second pass, and asks GPT-6 Astra high for an independent read-only Codex review. Verified defects enter a bounded repair loop. The coordinator publishes regular PRs, monitors checks and review threads, and records a retrospective. Ordinary approval leaves the PRs unmerged.

## Try it

Requirements are Linux or macOS, Node 24+, pnpm, Pi 0.99.1, Git, authenticated GitHub CLI, an available Pi model, and a logged-in Codex CLI supporting `gpt-6-astra` with high effort. Run from a clean repository root at the current GitHub `origin` base commit. Git identity must already be configured.

```sh
pnpm install --frozen-lockfile
just check
cd /path/to/your/repository
pi --no-extensions -e /home/pascal/Projects/pi-mode-workflow/src/index.ts
```

This explicit extension invocation changes no installed Pi settings. The conversation admits only `read`, `grep`, `find`, `ls`, and Planning's `workflow_plan`. Shell commands and other extension tools are blocked. Use a disposable project for your first model-backed run.

| Command | Behavior |
| --- | --- |
| `/workflow status` | Show mode, phase, proposal digest, and blocker |
| `/workflow plan` | Cancel, drain, release ownership, then enter Planning |
| `/workflow implement` | Display a confirmation of the current plan and command effects |
| `/workflow implement <digest> --allow-checks` | Approve that exact plan, trusted checks, and PR publication |
| `/workflow implement <digest> --allow-checks --merge` | Also authorize this run's protected merge gate |
| `/workflow resume` | Reconcile an unfinished run and resume its durable phase |
| `/workflow resume --accept-edits` | Also accept recovery edits that match recorded paths and content hashes |

Merge permission belongs to one run. It is never inferred from an assistant message. The Planning footer is exactly `— We are in the Planning Phase`.

## Configuration

Optional overrides live in the target repository's `.pi/mode-workflow.json`. Unknown keys are rejected. The extension snapshots configuration when approval creates a run.

```json
{
  "baseBranch": "main",
  "secondPassSkill": "/absolute/path/to/2nd-pass/SKILL.md",
  "retrospectiveSkill": "/absolute/path/to/pa-retro/SKILL.md",
  "reviewerBinary": "codex",
  "maxRepairRounds": 3,
  "requiredChecks": ["verify"],
  "requiredReviewers": ["your-reviewer"]
}
```

Defaults resolve the two skills under `~/.codex/skills/`. Missing skills, reviewer capability failures, unavailable permissions, conflicting Git state, and exhausted repair budgets block the run with a reason. Worker and review timeouts default to 15 minutes. Monitoring defaults to 15 minutes with a 10-second interval. See [ConfigSchema](src/contracts.ts) for accepted keys and bounds.

## Boundaries and recovery

File tools enforce canonical approved paths, reject repository metadata and escaping symlinks, and serialize the complete edit operation. They cannot sandbox arbitrary repository scripts. Approving checks trusts their declared effects, Git hooks, and the repository code they execute. Read-only tool admission also cannot sandbox other extensions' JavaScript. Controlled workers discover no ambient extensions, skills, prompt templates, themes, or context files.

The journal is under the checkout's Git directory at `pi-mode-workflow/`. It contains the active pointer, validated run records, edit hashes, operation intents, private check logs, reviewer artifacts, and retrospectives. A process lease prevents two coordinators from owning the same checkout. Each command has an IPC supervisor that kills its process group when the coordinator dies. Reloading or reopening an unfinished run never automatically starts effects.

Recovery inspects Git and GitHub before retrying uncertain operations. It rejects a changed remote repository, unrecorded commits, missing active records, and unattributed dirty files. The extension does not reset, delete data, force-push, or silently rebase. Resolve ambiguous changes yourself before resuming. An unfinished run must be resumed instead of replaced by a new approval.

Ordered units can select `single` delivery for one cumulative PR or `stack` for dependent branches and PRs. Stacks publish bottom-up. Repairs merge ancestor updates into descendants and recheck them. Authorized landing retargets the next layer and invalidates its prior evidence. Conflicts stop with files preserved.

Auto-merge uses `--match-head-commit` and requires classic GitHub branch protection with strict required checks, approving reviews, stale-review dismissal, and enforcement for admins. Missing protection, unsupported ruleset-only policies, missing access, changed destinations, stale base/head evidence, pending checks, or unresolved threads block merging. Queued remote merges require explicit reconciliation and are never blindly replayed. No admin override is used. Review histories exceeding 100 threads or 100 reviews block for explicit reconciliation.

## Verification

`just check` runs strict TypeScript, behavioral tests, Biome, the canonical prompt drift check, the build, and an isolated Pi RPC load. Tests use real temporary Git repositories and process groups. Offline pipeline tests simulate GitHub and workers while exercising actual commits, pushes to a local bare remote, ordered PR publication, and recovery from a lost PR-creation response. SDK tests load the real extension and verify tool guards, shell interception, plan recording, stale approvals, and the finalized footer.

The CI workflow runs these checks on Linux and macOS. Model-backed writer quality, remote merge policy enforcement, and interactive terminal rendering require a live acceptance run; offline fixtures do not establish those results. The delivery PR will remain unmerged for Pascal.
