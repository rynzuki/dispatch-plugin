# Changelog

## 0.1.0

First public release.

- Worker agents renamed to `dispatch-mechanical`, `dispatch-standard` and `dispatch-strong`, and shipped with the plugin.
- Escalation passes the rejection reason and check output to the next attempt; `maxTier` caps how far a unit escalates.
- Workers can return a `question`; a question stops the unit and goes back to the lead instead of escalating.
- Results are judged in code: changed files must stay within the unit's list, no uncommitted leftovers, a branch and a commit must exist.
- `filesChanged` comes from the merge-base, so units with more than one commit report correctly.
- Path overlap check normalises paths and treats a directory as overlapping everything under it.
- Units run through a pool of 4 instead of fixed batches.
- New optional `setup` field: runs in the worktree, and in the merge step only when a manifest or lockfile changed.
- The merge step treats a check that modifies tracked files as a failure.
- Earlier attempts' branches are returned as `superseded` and removed by the lead, even when nothing in the wave passed.
- Precheck reads the effective `worktree.baseRef` across local, project and user settings, and ignores untracked files.
- Workflow labels keep the planned tier across escalations, so progress panels keep matching.
- Unit ids, paths, commit headers and the base branch are validated before they go into shell commands.
- Personal tooling (progress panel, permission hooks) is optional and named generically.
