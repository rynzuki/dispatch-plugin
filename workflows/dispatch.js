export const meta = {
  name: 'dispatch',
  description: 'Implement planned units in parallel worktrees on tiered models, escalate failed units with the failure as context, merge each wave',
  whenToUse: 'Invoked by the dispatch skill with args {units, base}. Each unit: {id, task, tier, files, dependsOn, check, setup?, commit?, maxTier?}.',
  phases: [
    { title: 'Validate', detail: 'check unit list, compute waves' },
    { title: 'Implement', detail: 'one implementer per unit, up to 4 at once within a wave, worktree-isolated' },
    { title: 'Merge', detail: 'merge passed branches into base, sequentially, after each wave' },
  ],
}

// --- helpers
const TIERS = ['mechanical', 'standard', 'strong']
const MAX_CONCURRENT = 4
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

// Agent definitions shipped in this plugin's agents/ folder pin model and effort per tier.
// Plugin agents are registered as <plugin>:<agent>; the full name avoids clashes with same-named user agents.
const AGENT_TYPES = { mechanical: 'dispatch:dispatch-mechanical', standard: 'dispatch:dispatch-standard', strong: 'dispatch:dispatch-strong' }

function tierOpts(tier) {
  return { agentType: AGENT_TYPES[tier] || AGENT_TYPES.strong }
}

function normPath(p) {
  let s = String(p).trim().replace(/\\/g, '/').replace(/\/+/g, '/')
  while (s.startsWith('./')) s = s.slice(2)
  return s.replace(/\/$/, '')
}

// A listed path that is a directory covers everything under it.
function pathsOverlap(a, b) {
  const x = normPath(a)
  const y = normPath(b)
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/')
}

function inScope(file, files) {
  const f = normPath(file)
  return files.some(p => {
    const n = normPath(p)
    return f === n || f.startsWith(n + '/')
  })
}

function validateUnits(units) {
  if (!Array.isArray(units) || units.length === 0) throw new Error('args.units must be a non-empty array')
  const ids = new Set(units.map(u => u && u.id))
  const seen = new Set()
  for (const u of units) {
    if (!u || !u.id) throw new Error('every unit needs an id')
    if (!ID_RE.test(u.id)) throw new Error(`unit id ${u.id} may only contain letters, digits, - and _`)
    if (seen.has(u.id)) throw new Error(`duplicate unit id ${u.id}`)
    seen.add(u.id)
    if (!TIERS.includes(u.tier)) throw new Error(`unit ${u.id} has unknown tier ${u.tier}`)
    if (u.maxTier !== undefined) {
      if (!TIERS.includes(u.maxTier)) throw new Error(`unit ${u.id} has unknown maxTier ${u.maxTier}`)
      if (TIERS.indexOf(u.maxTier) < TIERS.indexOf(u.tier)) throw new Error(`unit ${u.id} has maxTier ${u.maxTier} below its tier ${u.tier}`)
    }
    if (!u.task) throw new Error(`unit ${u.id} has no task`)
    if (!Array.isArray(u.files) || u.files.length === 0) throw new Error(`unit ${u.id} lists no files`)
    for (const f of u.files) {
      const n = normPath(f)
      if (!n) throw new Error(`unit ${u.id} lists an empty path`)
      if (n.startsWith('/') || n.split('/').includes('..')) throw new Error(`unit ${u.id} path ${f} must be relative to the repository root without ..`)
      if (n.includes("'")) throw new Error(`unit ${u.id} path ${f} contains a single quote`)
    }
    if (!u.check) throw new Error(`unit ${u.id} has no check command`)
    for (const k of ['check', 'setup']) {
      if (u[k] !== undefined && (typeof u[k] !== 'string' || u[k].includes('`'))) throw new Error(`unit ${u.id} ${k} must be a string without backticks`)
    }
    if (u.commit !== undefined && (typeof u.commit !== 'string' || /["`$\\\n]/.test(u.commit))) throw new Error(`unit ${u.id} commit header must not contain quotes, backticks, $, \\ or newlines`)
    for (const d of u.dependsOn || []) {
      if (!ids.has(d)) throw new Error(`unit ${u.id} depends on unknown unit ${d}`)
    }
  }
  // cycle detection via DFS colouring
  const byId = Object.fromEntries(units.map(u => [u.id, u]))
  const colour = {}
  const visit = id => {
    if (colour[id] === 1) throw new Error(`dependency cycle involving ${id}`)
    if (colour[id] === 2) return
    colour[id] = 1
    for (const d of byId[id].dependsOn || []) visit(d)
    colour[id] = 2
  }
  for (const u of units) visit(u.id)
  // same-wave path overlap (normalised; a directory overlaps every path under it)
  for (const wave of computeWaves(units)) {
    for (let i = 0; i < wave.length; i++) {
      for (let j = i + 1; j < wave.length; j++) {
        for (const a of byId[wave[i]].files) {
          for (const b of byId[wave[j]].files) {
            if (pathsOverlap(a, b)) throw new Error(`units ${wave[i]} and ${wave[j]} overlap on ${normPath(a)} / ${normPath(b)}`)
          }
        }
      }
    }
  }
  return true
}

function computeWaves(units) {
  const depth = {}
  const byId = Object.fromEntries(units.map(u => [u.id, u]))
  const d = id => {
    if (depth[id] !== undefined) return depth[id]
    const deps = byId[id].dependsOn || []
    depth[id] = deps.length ? 1 + Math.max(...deps.map(d)) : 0
    return depth[id]
  }
  const waves = []
  for (const u of units) {
    const n = d(u.id)
    ;(waves[n] = waves[n] || []).push(u.id)
  }
  return waves
}

function nextTier(tier, maxTier) {
  const i = TIERS.indexOf(tier)
  const ceiling = TIERS.indexOf(maxTier || 'strong')
  return i >= 0 && i < ceiling ? TIERS[i + 1] : null
}

// Keeps at most n tasks running; a slow unit no longer holds back a whole batch.
function limiter(n) {
  let active = 0
  const queue = []
  const next = () => {
    if (active >= n || queue.length === 0) return
    active++
    const { fn, resolve, reject } = queue.shift()
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--
        next()
      })
  }
  return fn => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject })
    next()
  })
}

// Decides in code whether an agent's report is acceptable; never trusts checkPassed alone.
function judgeResult(u, r) {
  if (!r) return { ok: false, reason: 'agent returned nothing' }
  if (r.question && String(r.question).trim()) return { ok: false, question: String(r.question).trim() }
  if (!r.checkPassed) return { ok: false, reason: 'check failed' }
  if (!r.branch) return { ok: false, reason: 'no branch reported' }
  const changed = Array.isArray(r.filesChanged) ? r.filesChanged : []
  if (changed.length === 0) return { ok: false, reason: 'no committed changes' }
  const outside = changed.filter(f => !inScope(f, u.files))
  if (outside.length) return { ok: false, reason: `committed files outside its list: ${outside.join(', ')}` }
  const stray = Array.isArray(r.strayFiles) ? r.strayFiles.filter(Boolean) : []
  if (stray.length) return { ok: false, reason: `uncommitted changes left in the worktree, so the check may have passed only because of them: ${stray.join(', ')}` }
  return { ok: true }
}

// Runs one unit, escalating one tier per failure up to maxTier. call(tier, attempt, prev) -> result|null.
// A returned question stops the unit: it goes back to the lead instead of to a pricier model.
async function runUnit(u, call, escalations, onLog) {
  let tier = u.tier
  let attempt = 1
  let prev = null
  const superseded = []
  for (;;) {
    const r = await call(tier, attempt, prev)
    const v = judgeResult(u, r)
    if (v.ok) return { id: u.id, tier, ok: true, result: r, superseded }
    if (v.question) return { id: u.id, tier, ok: false, question: v.question, result: r, superseded }
    const up = nextTier(tier, u.maxTier)
    if (!up) return { id: u.id, tier, ok: false, reason: v.reason, result: r, superseded }
    if (r && r.branch) superseded.push(r.branch)
    escalations.push({ id: u.id, from: tier, to: up, reason: v.reason })
    if (onLog) onLog(`escalate ${u.id}: ${tier} -> ${up} (${v.reason.slice(0, 120)})`)
    prev = { tier, reason: v.reason, summary: (r && r.summary) || '', checkOutput: (r && r.checkOutput) || '' }
    tier = up
    attempt++
  }
}

function resolveBase(args) {
  if (!args || typeof args.base !== 'string' || !args.base) throw new Error('args.base is required: the checked-out branch the merge agent merges into (worktrees branch from HEAD)')
  if (/[\s`"'$\\]/.test(args.base)) throw new Error(`args.base ${args.base} is not a plain branch name`)
  return args.base
}

function shellPaths(files) {
  return files.map(f => `'${normPath(f)}'`).join(' ')
}

function unitPrompt(u, tier, attempt, prev, base) {
  const lines = [`Implement unit ${u.id}.`]
  if (prev) {
    lines.push(
      '',
      `This is attempt ${attempt}. A ${prev.tier}-tier attempt was rejected: ${prev.reason}.`,
      prev.summary ? `Its summary: ${prev.summary}` : null,
      prev.checkOutput ? `Its last check output:\n\`\`\`\n${prev.checkOutput}\n\`\`\`` : null,
      'You start from a clean branch; that attempt\'s edits are not here. Use its failure to avoid the same mistake.',
    )
  }
  lines.push(
    '',
    `Task: ${u.task}`,
    '',
    `Files you may change (relative to the repository root; a directory covers everything under it): ${u.files.map(normPath).join(', ')}. Touch nothing else; other units edit other files in parallel. Committed files outside this list get the unit rejected.`,
    '',
    'If the task needs a decision the task text does not settle, or cannot be done within these files, do not guess and do not work around it: set question to exactly what you need decided, set checkPassed=false, and stop. The question goes back to the person who planned the work.',
    '',
    'Make file changes with the Edit or Write tools, not sed, heredocs or shell redirects, so every change is visible to reviewers and tooling. Do not run rm -rf, git reset --hard, git clean, force pushes or database migrations unless the task says so: this run is unattended, and a permission hook may deny them. If a command is denied, report it in summary instead of retrying or rephrasing it.',
    '',
    'Steps:',
    `1. You are in your own git worktree on a fresh branch: a plain checkout of tracked files, without installed dependencies or untracked config. ${u.setup ? `Run the setup command first: \`${u.setup}\`.` : 'If the check needs dependencies, install them first.'}`,
    '2. Make the change.',
    `3. From the repository root, run the check: \`${u.check}\`. Fix and re-run until it passes, but do not loop forever; after your best attempt, report the failure.`,
    `4. Commit only the allowed paths: \`git add -A -- ${shellPaths(u.files)} && git commit -m "${u.commit || `${u.id}: <one line>`}"\` (use exactly that message${u.commit ? '' : ', filling in the one line'}; drop listed paths from the add that you neither created, changed nor deleted, since git rejects paths that match nothing; if a commit hook rejects the commit, fix what it reports and never bypass it).`,
    '5. Report:',
    '   - branch: `git rev-parse --abbrev-ref HEAD`',
    `   - filesChanged: \`git diff --name-only $(git merge-base HEAD ${base})..HEAD\``,
    '   - strayFiles: the paths from `git status --porcelain` after committing (empty when clean; gitignored files such as installed dependencies do not appear there)',
    '   - checkPassed, checkOutput (last 30 lines of the final check run), summary, question (empty unless you stopped on a decision)',
  )
  return lines.filter(l => l !== null).join('\n')
}

function mergePrompt(base, items) {
  return [
    `Merge worktree branches into branch \`${base}\`. This runs in the user's main checkout, so guard it first:`,
    `1. \`git rev-parse --abbrev-ref HEAD\` must print \`${base}\`; if not, return every branch under conflicts with error "checked-out branch is not ${base}" and stop.`,
    '2. `git status --porcelain --untracked-files=no` must print nothing (untracked files are fine; only modified or staged tracked files block, because a failed check is backed out with reset --hard); if it prints anything, return every branch under conflicts with error "base working tree dirty" and stop. Never stash, reset or clean the user\'s tree at this point.',
    '',
    `Then merge in this exact order, one at a time: ${items.map(i => `${i.id} -> ${i.branch}`).join('; ')}.`,
    'Per branch:',
    '- `git rev-parse --verify <branch>` must succeed; if not, record it under conflicts with error "branch not found" and continue with the next branch.',
    '- Record `before=$(git rev-parse HEAD)`, then run `git merge --no-ff <branch> -m "chore: merge unit <id>"`.',
    '- If the merge reports a conflict: `git merge --abort`, record the id, branch and conflict message under conflicts, and stop; list the remaining branches as conflicts with error "skipped after earlier conflict".',
    `- Otherwise run that unit's check. If the merge changed a dependency manifest or lockfile, run the unit's setup command before the check. Commands: ${items.map(i => `${i.id}: ${i.setup ? `setup \`${i.setup}\`, ` : ''}check \`${i.check}\``).join('; ')}.`,
    '- After the check, `git status --porcelain --untracked-files=no` must print nothing. If the check failed or changed tracked files, run `git reset --hard <before>` (the exact hash you recorded), record it under conflicts with the check output or the changed files as the error, and continue with the next branch.',
    '- After a branch merges and passes, remove its worktree and branch: find the path with `git worktree list`, then `git worktree remove --force <path>` and `git branch -d <branch>`. Leave the worktree and branch of any branch that conflicts or fails, so the user can inspect it.',
    '',
    'Do not edit any source file; this is a merge-only task.',
  ].join('\n')
}
// --- end helpers

const UNIT_RESULT = {
  type: 'object',
  required: ['branch', 'filesChanged', 'strayFiles', 'checkPassed', 'checkOutput', 'summary', 'question'],
  properties: {
    branch: { type: 'string', description: 'git branch name the work is committed on' },
    filesChanged: { type: 'array', items: { type: 'string' }, description: 'files changed since the merge-base with the base branch' },
    strayFiles: { type: 'array', items: { type: 'string' }, description: 'paths git status still reports after committing; empty when clean' },
    checkPassed: { type: 'boolean' },
    checkOutput: { type: 'string', description: 'last 30 lines of the final check run' },
    summary: { type: 'string' },
    question: { type: 'string', description: 'a decision the task does not settle; empty string when none' },
  },
}

const MERGE_RESULT = {
  type: 'object',
  required: ['merged', 'conflicts'],
  properties: {
    merged: { type: 'array', items: { type: 'string' }, description: 'unit ids merged and passing, in order' },
    conflicts: {
      type: 'array',
      items: { type: 'object', required: ['id', 'branch', 'error'], properties: { id: { type: 'string' }, branch: { type: 'string' }, error: { type: 'string' } } },
    },
  },
}

// --- body
const units = args && args.units
const base = resolveBase(args)
phase('Validate')
validateUnits(units)
const byId = Object.fromEntries(units.map(u => [u.id, u]))
const waves = computeWaves(units)
log(`${units.length} units in ${waves.length} wave(s): ${waves.map(w => w.join(',')).join(' | ')}`)

const merged = []
const failed = []
const skipped = []
const questions = []
const escalations = []
const superseded = []
const unavailable = new Set() // ids that failed, were skipped, asked a question, or did not merge
const limit = limiter(MAX_CONCURRENT)

for (let w = 0; w < waves.length; w++) {
  const runnable = []
  for (const id of waves[w]) {
    const blocked = (byId[id].dependsOn || []).find(d => unavailable.has(d))
    if (blocked) {
      skipped.push({ id, reason: `dependency ${blocked} did not complete` })
      unavailable.add(id)
      log(`skip ${id}: dependency ${blocked} did not complete`)
    } else runnable.push(id)
  }
  if (!runnable.length) continue

  phase('Implement')
  log(`wave ${w + 1}: ${runnable.join(', ')}`)
  const results = (await parallel(runnable.map(id => () => limit(() => runUnit(
    byId[id],
    (tier, attempt, prev) => agent(unitPrompt(byId[id], tier, attempt, prev, base), {
      ...tierOpts(tier),
      isolation: 'worktree',
      schema: UNIT_RESULT,
      label: `${id} [${byId[id].tier}]`, // stable across escalations so progress panels keep matching the planned task
      phase: 'Implement',
    }),
    escalations,
    log,
  ))))).filter(Boolean)

  const passed = []
  for (const x of results) {
    superseded.push(...x.superseded)
    const r = x.result
    if (x.ok) passed.push({ id: x.id, branch: r.branch, check: byId[x.id].check, setup: byId[x.id].setup })
    else if (x.question) {
      questions.push({ id: x.id, tier: x.tier, question: x.question, branch: (r && r.branch) || '' })
      unavailable.add(x.id)
      log(`question from ${x.id}: ${x.question.slice(0, 120)}`)
    } else {
      failed.push({ id: x.id, tier: x.tier, reason: x.reason, checkOutput: (r && r.checkOutput) || '', branch: (r && r.branch) || '' })
      unavailable.add(x.id)
      log(`failed ${x.id} at tier ${x.tier}: ${x.reason.slice(0, 120)}`)
    }
  }
  for (const id of runnable) {
    if (!results.some(r => r.id === id)) {
      failed.push({ id, tier: byId[id].tier, reason: 'agent returned nothing', checkOutput: '', branch: '' })
      unavailable.add(id)
    }
  }

  if (passed.length) {
    phase('Merge')
    const m = await agent(mergePrompt(base, passed), { agentType: AGENT_TYPES.standard, schema: MERGE_RESULT, label: `merge wave ${w + 1}`, phase: 'Merge' })
    const mergedIds = [...new Set(((m && m.merged) || []).filter(id => passed.some(p => p.id === id)))]
    merged.push(...mergedIds)
    for (const p of passed) {
      if (!mergedIds.includes(p.id)) {
        const c = m && (m.conflicts || []).find(x => x.id === p.id)
        failed.push({ id: p.id, tier: 'merge', reason: c ? c.error : 'merge agent returned nothing', checkOutput: '', branch: p.branch })
        unavailable.add(p.id)
        log(`unmerged ${p.id}: ${c ? c.error.slice(0, 120) : 'merge agent returned nothing'}`)
      }
    }
  }
}

log(`done: ${merged.length} merged, ${failed.length} failed, ${questions.length} question(s), ${skipped.length} skipped, ${escalations.length} escalation(s), ${superseded.length} superseded branch(es) to clean up`)
return { merged, failed, questions, skipped, escalations, superseded, waves }
