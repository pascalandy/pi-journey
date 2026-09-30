"""Stand in for gh, pnpm, just, and gitleaks in the ship-script tests.

Run as `fake.py PROGRAM ARGS...`. Each call appends its argv and GH_REPO to the
calls in the JSON state named by FAKE_STATE, runs the first hook whose key
starts the command line, then answers from the state. A hook is a shell
command, or fields to change on the PR, as someone editing it on GitHub would. gh answers from main's
rules, the commit statuses, and the pull requests, whose open heads are branch
tips in the bare origin. Every other program fails when listed in `failing`.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

REPO = "pascalandy/pi-journey"
SIGNOFF_RULES = [
    {
        "type": "required_status_checks",
        "parameters": {"required_status_checks": [{"context": "signoff"}]},
    }
]


def origin(state: dict, *args: str) -> str:
    return subprocess.run(
        ("git", "--git-dir", state["origin"], *args),
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def pull_request(state: dict, number: str) -> dict:
    """The PR as `gh pr view --json` prints it; an open PR's head follows its branch."""
    pr = next(pr for pr in state["prs"] if str(pr["number"]) == number)
    if pr["state"] == "OPEN":
        pr["headRefOid"] = origin(state, "rev-parse", f"refs/heads/{pr['headRefName']}")
    signed_off = state["statuses"].get(pr["headRefOid"]) == "success"
    if pr["state"] != "OPEN":
        merge_state = "UNKNOWN"
    elif pr["isDraft"]:
        merge_state = "DRAFT"
    elif pr["conflicts"]:
        merge_state = "DIRTY"
    else:
        merge_state = "CLEAN" if signed_off else "BLOCKED"
    rollup = [{"__typename": "StatusContext", "context": "signoff", "state": "SUCCESS"}]
    return {
        **pr,
        "url": f"https://github.com/{REPO}/pull/{number}",
        "mergeStateStatus": merge_state,
        "statusCheckRollup": rollup if signed_off else [],
    }


def merge(state: dict, number: str, sha: str, subject: str) -> int:
    """Merge an unmoved head into the PR's current base, when the rules allow it."""
    if state["merge_error"] == "refused":
        print("error connecting to api.github.com", file=sys.stderr)
        return 1
    pr = pull_request(state, number)
    if pr["headRefOid"] != sha:
        print("GraphQL: Head branch was modified", file=sys.stderr)
        return 1
    if pr["mergeStateStatus"] != "CLEAN":
        print("the base branch policy prohibits the merge", file=sys.stderr)
        return 1
    base_ref = f"refs/heads/{pr['baseRefName']}"
    base = origin(state, "rev-parse", base_ref)
    tree = origin(state, "merge-tree", "--write-tree", base, sha)
    commit = origin(state, "commit-tree", tree, "-p", base, "-p", sha, "-m", subject)
    origin(state, "update-ref", base_ref, commit)
    stored = next(pr for pr in state["prs"] if str(pr["number"]) == number)
    stored.update(state="MERGED", headRefOid=sha, mergeCommit={"oid": commit})
    if state["merge_error"] == "lost":
        print("error: the request timed out", file=sys.stderr)
        return 1
    return 0


def gh(state: dict, args: list[str]) -> int:
    if args[:2] == ["auth", "status"]:
        if state["signed_in"]:
            return 0
        print("You are not logged into any GitHub hosts", file=sys.stderr)
        return 1
    if args[:2] == ["extension", "list"]:
        print("gh signoff\tbasecamp/gh-signoff\tv0.4.1")
        return 0
    # Real gh guesses the repository from the remotes, and a fork's second
    # remote makes it guess wrong; this one refuses unless it is named
    if os.environ.get("GH_REPO") != REPO:
        print("fake gh: GH_REPO does not name the repository", file=sys.stderr)
        return 1
    match args:
        case ["api", path] if path == f"repos/{REPO}/rules/branches/main":
            if state["rules"] is None:
                print("gh: Bad credentials (HTTP 401)", file=sys.stderr)
                return 1
            print(json.dumps(state["rules"]))
        case ["signoff", "install"]:
            state["rules"] = SIGNOFF_RULES
            print("✓ Required signoff on main")
        case ["signoff", "--commit", sha]:
            state["statuses"][sha] = "success"
            print(f"✓ Signed off on {sha}")
        case ["pr", "list", "--head", branch, "--state", "all", "--json", _]:
            # Newest first, as gh lists them
            numbers = [str(pr["number"]) for pr in state["prs"]]
            listed = [pull_request(state, number) for number in reversed(numbers)]
            print(json.dumps([pr for pr in listed if pr["headRefName"] == branch]))
        case ["pr", "view", number, "--json", _]:
            print(json.dumps(pull_request(state, number)))
        # Any other flag, such as --admin, is unsupported
        case [
            "pr",
            "merge",
            number,
            "--merge",
            "--match-head-commit",
            sha,
            "--subject",
            subject,
        ]:
            return merge(state, number, sha, subject)
        case _:
            print(f"fake gh does not support: {' '.join(args)}", file=sys.stderr)
            return 2
    return 0


def main() -> int:
    path = Path(os.environ["FAKE_STATE"])
    state = json.loads(path.read_text(encoding="utf-8"))
    argv = sys.argv[1:]
    state["calls"].append({"argv": argv, "repo": os.environ.get("GH_REPO")})
    command = " ".join(argv)
    for start, hook in state["hooks"].items():
        if not command.startswith(start):
            continue
        if isinstance(hook, dict):
            state["prs"][0].update(hook)
        else:
            subprocess.run(hook, shell=True, check=True)
        break
    if argv[0] == "gh":
        code = gh(state, argv[1:])
    else:
        code = 1 if command in state["failing"] else 0
    path.write_text(json.dumps(state), encoding="utf-8")
    return code


if __name__ == "__main__":
    sys.exit(main())
