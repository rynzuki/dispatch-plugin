---
name: dispatch
description: Use for implementation requests in a git repository ("implement", "add", "build", "refactor", "migrate", "wire up") whose work splits into independent units. The lead scopes and plans, cheaper models implement each unit in parallel worktrees via the dispatch workflow, the lead reviews the merged diff. Not for questions, reviews, or single-file fixes the lead can make in one edit.
---

# dispatch

The lead model is the expensive part of a session. Its job here is planning and review; execution goes to cheaper models through the `dispatch` workflow that ships with this plugin.

## Prechecks

Run these before planning. Stop and tell the user if one of the first three fails.

```bash
git rev-parse --is-inside-work-tree
```
Must print `true`. Worktrees need git.

```bash
for f in .claude/settings.local.json .claude/settings.json ~/.claude/settings.json; do
  [ -f "$f" ] && v=$(jq -r '.worktree.baseRef // empty' "$f") && [ -n "$v" ] && { echo "$f: $v"; break; }
done
```
Must print a line ending in `head`; the first file listed wins. Otherwise wave-two worktrees branch from the default branch and cannot see wave one's merged changes. Fix: add `"worktree": {"baseRef": "head"}` to one of those files. Managed (organisation) settings can override all three; if the run behaves as if `baseRef` were unset, check there.

Do not set `worktree.symlinkDirectories` for `node_modules` or similar: an install inside a worktree rewrites the shared module metadata and breaks the main checkout (seen with pnpm). Each worktree installs its own dependencies through the unit's `setup`.

```bash
git status --porcelain --untracked-files=no
```
Must print nothing. Merges run in this checkout and back out failures with `git reset --hard`, so modified tracked files would be lost; commit or stash first. Untracked files are fine.

```bash
git check-ignore -q .claude/worktrees/x || echo "not ignored"
```
If it prints `not ignored`, suggest adding `.claude/worktrees/` to `.gitignore` so leftover worktrees never get committed. Not a blocker.

## Steps

1. **Scope.** Read what planning needs: directory layout, the exported signatures and types a unit will use or change, which tests and check commands exist. Skip implementation bodies of files a unit will edit; the implementer reads those. Precise tasks are what keep units from failing and escalating, so read enough to write them.

2. **Write the unit list.** One object per unit:

   ```json
   {
     "id": "u1",
     "task": "What to change, where, and the acceptance criteria. One paragraph. Name the files and the behaviour; the implementer has no conversation context.",
     "tier": "mechanical | standard | strong",
     "files": ["src/a.ts", "src/a.test.ts"],
     "dependsOn": [],
     "setup": "pnpm install --frozen-lockfile",
     "check": "pnpm vitest run src/a.test.ts"
   }
   ```

   - `files`: every path the unit may touch, relative to the repo root. A directory covers everything under it. Units in the same wave (same dependency depth) must not overlap; the workflow refuses overlaps after normalising paths. A unit whose committed diff leaves this list, or that leaves uncommitted changes behind, is rejected in code.
   - `setup` (optional): runs once in the fresh worktree before the check. A worktree has tracked files only: no installed dependencies and no `.env` unless `.worktreeinclude` lists it. The merge step re-runs `setup` only when a merge changed a manifest or lockfile.
   - `check`: must exit non-zero on failure. A unit with nothing testable gets the project's lint or typecheck command. It runs in the worktree and again after merging, and must not modify tracked files.
   - `dependsOn`: unit ids whose merged result this unit builds on. A unit that calls or imports anything another unit adds (a new parameter, constant or export) must list that unit even when their files are disjoint; units in the same wave cannot see each other's code. A unit that needs a new dependency must own the manifest and lockfile, or depend on the unit that does.
   - `commit` (optional): exact commit header, for repos with commitlint (e.g. `feat(engine): port rule resolver`). No quotes, backticks or `$`. Merge commits are `chore: merge unit <id>`.
   - `maxTier` (optional): the highest tier escalation may reach. Use it to stop a cheap unit from escalating to the expensive tier.
   - `id`: letters, digits, `-` and `_` only.

3. **Assign the tier by scope and risk**, after scoping, never from the wording of the request:

   | Tier | Fits | Agent type | Model | Effort |
   |---|---|---|---|---|
   | mechanical | rename, extract, boilerplate, apply a given pattern to listed sites; a small explicit edit whose `check` really tests the behaviour | `dispatch:dispatch-mechanical` | haiku | low |
   | standard | explicit, local implementation with clear acceptance criteria, one module | `dispatch:dispatch-standard` | sonnet | medium |
   | strong | cross-module change, concurrency, ambiguous spec, anything you would want to do yourself | `dispatch:dispatch-strong` | session model | high |

   A rejected unit re-runs one tier up, with the rejection reason and check output in its prompt, until it passes or reaches `maxTier` (default `strong`). A mechanical unit can therefore run up to three times. Pick the cheaper tier only when its `check` would really catch a wrong result; a weak check lets a cheap model pass with bad work, and a failure costs a full re-run.

   A unit that hits a decision its task does not settle returns a `question` instead of guessing. Questions are not escalated; they come back to you.

4. **Is a workflow worth it?** The fan-out pays off when at least one wave has three or more units. Otherwise skip the workflow: run each unit yourself in dependency order with the Agent tool, `subagent_type` set to the unit's `dispatch:dispatch-<tier>` agent and its task, files and check in the prompt, and review each diff before the next.

5. **Show the unit list** to the user as a table (id, tier, files, dependsOn, check). On approval, record the base commit with `git rev-parse HEAD`, then run the workflow with `base` set to the checked-out branch from `git rev-parse --abbrev-ref HEAD` (required; worktrees branch from HEAD and the merge step refuses any other branch):

   `Workflow({ name: "dispatch:dispatch", args: { units: <the list>, base: "<checked-out branch>" } })`

   Use the full name: plugin workflows are registered as `<plugin>:<workflow>`, and a bare `dispatch` would pick up a personal workflow of the same name if one exists.

   Run it in the background. Tell the user the merge step runs `git reset --hard <hash>` to back out a merge whose check fails; if a permission hook holds destructive commands, a prompt will appear during the merge, and an unattended run may be denied.

6. **Review and report.** When the workflow returns `{merged, failed, questions, skipped, escalations, superseded, waves}`:
   - Review the merged diff with `git diff <base-commit>..HEAD` and run the project's full check once.
   - Report merged units, failed units with their `reason` and last `checkOutput`, skipped units and why, and every escalation.
   - Put each entry in `questions` to the user verbatim. Once answered, re-plan those units (and their skipped dependents) as a new, smaller run.
   - Remove the `superseded` branches (earlier attempts of escalated units): find each worktree with `git worktree list`, then `git worktree remove --force <path>` and `git branch -D <branch>`.
   - Branches of failed units stay under `.claude/worktrees/` for the user to inspect.

## Optional: progress panel

If the `savvy-progress` plugin is installed (`mcp__savvy-progress__progress` exists), report to it; otherwise skip this section.
- Right after launching: `title`, `total`, `tasks` (one per unit, `title` = `<id> [<tier>]` with the planned tier, `tier` mapped mechanical → `light`, standard → `medium`, strong → `careful`, `after` = the numbers of its `dependsOn` units) and `phase: "delegate"`. Workflow labels keep the planned tier across escalations, so the titles keep matching.
- On return: `phase: "review"`; after review `done` = merged count and `finished: true`.
