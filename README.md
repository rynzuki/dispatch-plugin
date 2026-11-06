# dispatch

A Claude Code plugin for splitting an implementation into units and having cheaper models build them in parallel.

The session model plans the units and reviews the result. Haiku, Sonnet or the session model implements each unit in its own git worktree. Units that pass are merged wave by wave, and each unit's check runs again after its merge.

## What's inside

| Path | What it is |
|---|---|
| `skills/dispatch/SKILL.md` | The lead's procedure: prechecks, unit list format, tiers, review |
| `workflows/dispatch.js` | The workflow: validation, waves, worktree runs, escalation, merge |
| `agents/dispatch-{mechanical,standard,strong}.md` | Worker agents; model and effort pinned per tier |
| `tests/dispatch.test.mjs` | Tests for the workflow helpers: `node tests/dispatch.test.mjs` |

## Requirements

- Claude Code 2.1.295 or later (the `haiku` alias needs it) with the Workflow tool available.
- A git repository with a clean tracked tree.
- `"worktree": {"baseRef": "head"}` in your user, project or local settings. Without it, later waves cannot see earlier merges. The skill's precheck tells you if it's missing.
- `jq` for the precheck.
- Recommended: `.claude/worktrees/` in `.gitignore`.

## Install

```bash
claude plugin marketplace add rynzuki/dispatch-plugin
claude plugin install dispatch@lewo-dispatch
```

Or inside Claude Code: `/plugin install dispatch --marketplace rynzuki/dispatch-plugin`. Restart Claude Code afterwards.

Update: `claude plugin marketplace update lewo-dispatch && claude plugin update dispatch@lewo-dispatch`.

To try it for one session without installing, clone the repo and run `claude --plugin-dir ./dispatch-plugin`.

Then ask Claude to implement something that splits into units, or type `/dispatch:dispatch`. Claude Code registers everything from the plugin under the `dispatch:` prefix: the skill and workflow are `dispatch:dispatch`, the agents `dispatch:dispatch-<tier>`. If you already have a personal skill, workflow or agents named `dispatch`, remove them so the two versions don't compete.

## How a run works

1. The lead reads only what planning needs and writes a unit list: task, tier, files, dependencies, optional setup, check.
2. You approve the list.
3. Each wave runs up to 4 units at once, each in a fresh worktree. When one finishes, the next starts.
4. The workflow accepts a unit only if all of these hold, and checks them in code:
   - its check passed;
   - it committed changes;
   - every committed file is in its `files` list;
   - nothing was left uncommitted.
5. A rejected unit runs again one tier up (mechanical → standard → strong) with the rejection reason and check output in its prompt. `maxTier` caps how far it can go.
6. A unit that hits an undecided question stops and hands the question back. It is not escalated.
7. Units that pass are merged one by one into your branch, and each unit's check runs again after its merge. A merge whose check fails is reverted to the exact commit before it.
8. The lead reviews the merged diff, runs the full check, relays questions, and cleans up branches from earlier failed attempts.

## Cost

- A unit costs one run at its tier when it passes.
- A mechanical unit that keeps failing runs three times: Haiku, Sonnet, then the session model. Set `maxTier` to cap that.
- Cheap tiers only save money when the unit's check would really catch a wrong result.
- The merge step costs one Sonnet run per wave.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Wave two doesn't see wave one's changes | `worktree.baseRef` is not `head` in the settings that win |
| "base working tree dirty" | Tracked files were modified before or during the run; commit or stash them |
| Unit rejected: "committed files outside its list" | Its task needs more files; widen `files` or split the unit |
| Unit rejected: "uncommitted changes left" | The agent edited files it didn't commit, so its check result can't be trusted |
| A run stalls during merge | A permission hook is holding `git reset --hard`; approve or deny it |
| Agent type not found | The plugin isn't enabled in this session; check `/plugin` |

Failed units keep their worktree and branch under `.claude/worktrees/` so you can inspect them.
