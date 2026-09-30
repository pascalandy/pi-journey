# Pi Journey

A Pi extension for work that takes several stops. Chat with your Pi agent as usual. When the plan is settled, start a journey and one XState coordinator carries it through owned workers, checks, reviews, and publication, stopping with a named reason whenever something needs you.

The design and acceptance contract are in [plan.html](plan.html). The `implement` mode recreates [the implementation guide](docs/journeys-guides/implementation-v1-1.md).

## Try it

Requirements are Linux or macOS, Node 24+, pnpm, Pi 0.99.1, Git, an authenticated GitHub CLI, a Pi model from a built-in or `models.json` provider, and a logged-in Codex CLI. Run journeys from a clean repository root at the current GitHub `origin` base commit, with a Git identity configured.

```sh
pnpm install --frozen-lockfile
cd /path/to/your/repository
pi -e /path/to/pi-journey/src/index.ts
```

This explicit extension invocation changes no installed Pi settings and loads alongside your other extensions. Use a disposable project for your first model-backed run.

## Pick a mode

Type `/journey` to open the picker, or name the mode directly. Tab completes the names.

| Command | Behavior |
| --- | --- |
| `/journey` | Pick a mode, or a control that applies to the current run |
| `/journey implement` | Ask the Pi agent to draft a plan from the conversation, then open the approval dialog |
| `/journey implement <note or issue>` | Draft the plan from that source instead, such as `#42` |
| `/journey implement <digest>` | Open the approval dialog for a plan already recorded in this branch |
| `/journey implement <digest> --allow-checks` | Approve that plan without a dialog, for RPC and scripts |
| `/journey ping` | Placeholder mode: the Pi agent answers ping |
| `/journey status` | Show the phase, the plan digest, and any blocker |
| `/journey stop` | Stop drafting, or cancel owned work, drain it, and release the repository |
| `/journey resume` | Reconcile an unfinished run and continue from its durable stage |
| `/journey resume --accept-edits` | Also accept recovered edits that match recorded paths and content hashes |
| `/journey retire` | Drain and retire an unfinished run, keeping its files, branches, PRs, and history |

`/journey implement` turns on the `journey_plan` tool and asks the Pi agent to record goal, body, ordered units with writable paths and commit messages, the project's own check command, and single or stack delivery. The dialog opens once the Pi agent finishes. It lists every unit's writable paths and commit message, the checks with their declared effects, and the delivery. Declining starts nothing and keeps drafting open, so you can ask for a revision. `/journey stop` turns drafting off.

The session is yours whenever no stage runs. While a stage runs, the Pi agent keeps only `read`, `grep`, `find`, and `ls`, and `!` shell commands are refused until you run `/journey stop`.

## The implement journey

`preflight` → for each unit: `work` → `commit` → `checks` → `secondPass` → `impacts`; then, once every unit passes: `publish` → `retrospective` → delivered

- `work`: one Pi worker edits only the unit's approved paths; the coordinator commits the result
- `checks`: the coordinator runs the plan's checks against the committed tree and rejects checks that change it
- `secondPass`: a read-only Pi worker follows the 2nd-pass skill and writes its own premortem
- `impacts`: a read-only Codex run applies the blast-radius skill and a premortem to the unit's diff
- `publish`: push each branch and open one regular PR, or one PR per unit for a stack; a PR counts only while it is open on the recorded base and head
- `retrospective`: a read-only Pi worker follows the pa-retro skill; its result stays in the journal

Open P0 to P2 findings send the unit through repair, up to `maxRepairRounds`. A journey ends with the PRs open and unmerged. Merging belongs to the project, for example with its own `just merge`. The guide's polish review, confidence report, merge gate, and issue filing are not part of the journey yet.

## Configuration

Put overrides in the target repository's `.pi/journey.json`. Unknown keys are rejected, and approval snapshots the configuration into the run.

```json
{
  "baseBranch": "main",
  "secondPassSkill": "/absolute/path/to/2nd-pass/SKILL.md",
  "impactsSkill": "/absolute/path/to/blast-radius/SKILL.md",
  "retrospectiveSkill": "/absolute/path/to/pa-retro/SKILL.md",
  "reviewerBinary": "codex",
  "reviewerModel": "gpt-6.1-sol",
  "reviewerEffort": "xhigh",
  "maxRepairRounds": 3
}
```

The skills default to `~/.codex/skills/`. Missing skills, a worker model the worker session cannot load, reviewer capability failures, conflicting Git state, and an exhausted repair budget block the run with a reason. Resume rechecks the failed gate and cannot renew an exhausted repair budget. Worker and review timeouts default to 15 minutes. See [ConfigSchema](src/contracts.ts) for the accepted keys and bounds.

## Boundaries and recovery

File tools normalize POSIX scopes before approval, reject repository metadata and escaping symlinks, and serialize the complete edit operation. Before overwriting a file, they require its content to match the committed baseline or an owned edit, including one whose bytes landed just before a crash. External content is preserved. They cannot sandbox arbitrary repository scripts: approving checks trusts their declared effects, Git hooks, checkout filters, and the code they execute. Controlled workers discover no ambient extensions, skills, prompt templates, themes, or context files, so preflight rejects a model whose provider only an extension registered.

The journal lives in the checkout's Git directory at `pi-journey/`, so Git never tracks it. It holds the active pointer, validated run records, edit hashes, operation intents, private check logs, reviewer artifacts, and retrospectives. A process lease prevents two coordinators from owning the same checkout, and each command has an IPC supervisor that kills its process group when the coordinator dies. Reloading never starts effects on its own.

Recovery inspects Git and GitHub before retrying uncertain operations. It rejects a changed remote repository, unrecorded commits, missing active records, and unattributed dirty files. The extension does not reset, delete data, force-push, or silently rebase. If the remote base advances and the run cannot resume, `/journey retire` keeps the old work and permits a fresh plan at the current base. Tree navigation, forks, and session switches first drain owned work and are cancelled when it cannot drain. Navigation reloads the proposal from the visible conversation branch and revokes open approval dialogs.

`single` delivery publishes one cumulative PR. `stack` delivery gives each unit a branch based on the previous unit and publishes the PRs bottom-up.

## Verification

`just check` runs strict TypeScript, the behavioral tests, Biome, the build, an isolated Pi RPC load that must list `/journey`, and the standard-library tests of `scripts/signoff.py` and `scripts/merge.py`. Tests use real temporary Git repositories and process groups. Offline pipeline tests simulate GitHub and workers while exercising actual commits, pushes to a local bare remote, ordered PR publication, and recovery from lost responses. SDK tests load the real extension, drive its commands and dialogs, and make no model call. Model-backed writer quality and interactive terminal rendering need a live run; offline fixtures do not establish them.

## Develop

Run `just install` once per clone. It installs dependencies and the lefthook hooks: gitleaks and Biome on staged files before each commit, and `just check` before each push. The GitHub Actions workflow runs `just check` on Linux and macOS only when started by hand with `gh workflow run ci.yml --ref <branch>`.

A PR merges into `main` only with a green `signoff` status on its head commit. Push the branch, then run `just signoff`: it installs, runs `just check` and `just gitleaks`, and posts the status on the tested commit. `just merge` signs off the PR head and merges exactly that commit. `just signoff-setup` installs the rule once per repository, and `just signoff-check` verifies it. Both scripts come from pascalandy-blog-paper and need `uv`, `gitleaks`, and the `gh signoff` extension (`gh extension install basecamp/gh-signoff`).

`just merge` checks the PR's base and `main` right before it merges, but `--match-head-commit` pins only the head. A retarget, or another merge into `main`, in the seconds between that last check and GitHub's merge can land a tree the checks never built. The script reports a wrong destination afterward and cannot undo it. An admin token bypasses repository rules, so only a non-admin merging identity or a merge queue closes this window.
