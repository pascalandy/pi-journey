# Bare `just` lists these recipes in file order
set shell := ["bash", "-euo", "pipefail", "-c"]
set positional-arguments

[private]
default:
    @{{ just_executable() }} --justfile {{ quote(justfile()) }} --list --unsorted

# Install dependencies from the lockfile and the Git hooks; once per clone
[group('setup')]
install:
    pnpm install --frozen-lockfile
    lefthook install

# Typecheck, test, lint, build, and load the extension in an isolated Pi
[group('checks')]
check:
    #!/usr/bin/env bash
    set -euo pipefail
    # A Git hook exports GIT_DIR; the checks' own git calls must not reach this repository
    unset $(compgen -e | grep '^GIT_' || true)
    pnpm run check
    pnpm run build
    pnpm run verify
    uv run --quiet --no-project --python ">=3.11" python -m unittest discover --quiet --start-directory scripts/tests

# Lint and format-check with Biome; lefthook passes the staged files
[group('checks')]
lint *files:
    @if [ "$#" -eq 0 ]; then set -- src tests scripts; fi; pnpm exec biome check --no-errors-on-unmatched --files-ignore-unknown=true "$@"

# Scan staged changes for secrets; lefthook runs it on every commit
[group('checks')]
gitleaks-staged:
    @env -u GITLEAKS_CONFIG GITLEAKS_CONFIG_TOML="$(printf '[extend]\nuseDefault = true\n')" gitleaks git "$(git rev-parse --git-dir)" --staged --gitleaks-ignore-path /dev/null --ignore-gitleaks-allow --no-banner --redact --log-level warn --verbose --no-color

# Scan this branch's commits since origin/main for secrets
[group('checks')]
gitleaks:
    @env -u GITLEAKS_CONFIG GITLEAKS_CONFIG_TOML="$(printf '[extend]\nuseDefault = true\n')" gitleaks git "$(git rev-parse --git-dir)" --log-opts="origin/main..HEAD" --gitleaks-ignore-path /dev/null --ignore-gitleaks-allow --no-banner --redact --verbose

# Install, run `just check` and `just gitleaks`, then mark the pushed HEAD green on GitHub; push first
[group('ship')]
signoff:
    @uv run --quiet scripts/signoff.py

# Verify that main requires the signoff status to merge; reads GitHub, changes nothing
[group('ship')]
signoff-check:
    @uv run --quiet scripts/signoff.py check

# Require the signoff status to merge into main, then verify it; once per repository
[group('ship')]
signoff-setup:
    @uv run --quiet scripts/signoff.py setup

# Merge this branch's PR into main: sign off its pushed head, then merge exactly that commit
[group('ship')]
merge *args:
    @uv run --quiet scripts/merge.py "$@"
