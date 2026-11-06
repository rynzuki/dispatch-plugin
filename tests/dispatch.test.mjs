import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'workflows', 'dispatch.js'), 'utf8')

// Whole-script syntax check (strip the ESM export so Function can parse it).
const AsyncFunction = (async function () {}).constructor
new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', src.replace(/^export const meta/m, 'const meta'))

const start = src.indexOf('// --- helpers')
const end = src.indexOf('// --- end helpers')
assert.ok(start >= 0 && end > start, 'helper markers present')
const names = ['validateUnits', 'computeWaves', 'nextTier', 'tierOpts', 'normPath', 'pathsOverlap', 'inScope', 'limiter', 'judgeResult', 'runUnit', 'resolveBase', 'unitPrompt', 'mergePrompt']
const h = new Function(src.slice(start, end) + `\nreturn { ${names.join(', ')} }`)()

const u = (id, files, dependsOn = [], tier = 'standard', extra = {}) => ({ id, task: 't', tier, files, dependsOn, check: 'true', ...extra })
const good = (files = ['a']) => ({ checkPassed: true, branch: 'b', filesChanged: files, strayFiles: [], checkOutput: '', summary: 's', question: '' })

// --- validation
assert.throws(() => h.validateUnits([u('u1', ['a']), u('u2', ['a'])]), /units u1 and u2 overlap/)
h.validateUnits([u('u1', ['a']), u('u2', ['a'], ['u1'])]) // overlap across waves is fine
assert.throws(() => h.validateUnits([u('u1', ['./src/a.ts']), u('u2', ['src/a.ts'])]), /overlap/, 'normalised paths overlap')
assert.throws(() => h.validateUnits([u('u1', ['src/lib/']), u('u2', ['src/lib/x.ts'])]), /overlap/, 'directory overlaps file inside it')
h.validateUnits([u('u1', ['src/lib']), u('u2', ['src/library.ts'])]) // prefix without separator is not an overlap
assert.throws(() => h.validateUnits([u('u3', ['c'], ['u9'])]), /unit u3 depends on unknown unit u9/)
assert.throws(() => h.validateUnits([u('u1', ['a'], ['u2']), u('u2', ['b'], ['u1'])]), /dependency cycle involving u1/)
assert.throws(() => h.validateUnits([u('u1', ['a']), u('u1', ['b'])]), /duplicate unit id u1/)
assert.throws(() => h.validateUnits([u('u1', ['a'], [], 'huge')]), /unknown tier huge/)
assert.throws(() => h.validateUnits([u('u 1', ['a'])]), /may only contain/)
assert.throws(() => h.validateUnits([u('u1', ['../x'])]), /without \.\./)
assert.throws(() => h.validateUnits([u('u1', ['/etc/x'])]), /relative/)
assert.throws(() => h.validateUnits([u('u1', ['a'], [], 'standard', { commit: 'feat: "x"' })]), /commit header/)
assert.throws(() => h.validateUnits([u('u1', ['a'], [], 'standard', { check: 'echo `x`' })]), /backticks/)
assert.throws(() => h.validateUnits([u('u1', ['a'], [], 'strong', { maxTier: 'standard' })]), /below its tier/)

assert.deepEqual(h.computeWaves([u('u1', ['a']), u('u2', ['b']), u('u3', ['c'], ['u1'])]), [['u1', 'u2'], ['u3']])

// --- tiers
assert.equal(h.nextTier('mechanical'), 'standard')
assert.equal(h.nextTier('standard'), 'strong')
assert.equal(h.nextTier('strong'), null)
assert.equal(h.nextTier('mechanical', 'mechanical'), null, 'maxTier caps escalation')
assert.deepEqual(h.tierOpts('mechanical'), { agentType: 'dispatch:dispatch-mechanical' })
assert.deepEqual(h.tierOpts('standard'), { agentType: 'dispatch:dispatch-standard' })
assert.deepEqual(h.tierOpts('strong'), { agentType: 'dispatch:dispatch-strong' })

// --- scope
assert.ok(h.inScope('src/lib/x.ts', ['./src/lib/']))
assert.ok(!h.inScope('src/library.ts', ['src/lib']))

// --- judgeResult: never trusts checkPassed alone
assert.equal(h.judgeResult(u('u1', ['a']), good()).ok, true)
assert.match(h.judgeResult(u('u1', ['a']), good(['a', 'b'])).reason, /outside its list: b/)
assert.match(h.judgeResult(u('u1', ['a']), { ...good(), strayFiles: ['c'] }).reason, /uncommitted changes/)
assert.match(h.judgeResult(u('u1', ['a']), { ...good(), filesChanged: [] }).reason, /no committed changes/)
assert.match(h.judgeResult(u('u1', ['a']), { ...good(), branch: '' }).reason, /no branch/)
assert.equal(h.judgeResult(u('u1', ['a']), { ...good(), checkPassed: false, question: 'which API?' }).question, 'which API?')
assert.match(h.judgeResult(u('u1', ['a']), null).reason, /returned nothing/)

// --- escalation passes the failure forward
{
  const calls = []; const esc = []
  const r = await h.runUnit(u('u1', ['a'], [], 'mechanical'), async (tier, attempt, prev) => {
    calls.push([tier, attempt, prev ? prev.checkOutput : undefined])
    return tier === 'standard' ? good() : { ...good(), checkPassed: false, checkOutput: 'boom' }
  }, esc)
  assert.deepEqual(calls, [['mechanical', 1, undefined], ['standard', 2, 'boom']])
  assert.deepEqual(esc, [{ id: 'u1', from: 'mechanical', to: 'standard', reason: 'check failed' }])
  assert.equal(r.ok, true); assert.equal(r.tier, 'standard'); assert.deepEqual(r.superseded, ['b'])
}
// a question stops escalation
{
  const esc = []; let n = 0
  const r = await h.runUnit(u('u1', ['a'], [], 'mechanical'), async () => { n++; return { ...good(), checkPassed: false, question: 'which table?' } }, esc)
  assert.equal(n, 1); assert.deepEqual(esc, []); assert.equal(r.question, 'which table?')
}
// maxTier caps; strong failure is final
{
  const esc = []
  const r = await h.runUnit(u('u1', ['a'], [], 'mechanical', { maxTier: 'standard' }), async () => null, esc)
  assert.deepEqual(esc.map(e => e.to), ['standard']); assert.equal(r.ok, false); assert.equal(r.tier, 'standard')
}
{
  const esc = []
  const r = await h.runUnit(u('u2', ['b'], [], 'standard'), async () => null, esc)
  assert.deepEqual(esc, [{ id: 'u2', from: 'standard', to: 'strong', reason: 'agent returned nothing' }])
  assert.equal(r.tier, 'strong'); assert.equal(r.ok, false)
}

// --- limiter keeps at most n running and starts the next as soon as one finishes
{
  const limit = h.limiter(2)
  let active = 0; let peak = 0; const order = []
  const task = (id, ms) => () => new Promise(res => { active++; peak = Math.max(peak, active); order.push(`start ${id}`); setTimeout(() => { active--; order.push(`end ${id}`); res(id) }, ms) })
  const out = await Promise.all([limit(task('slow', 40)), limit(task('fast', 5)), limit(task('next', 5))])
  assert.deepEqual(out, ['slow', 'fast', 'next'])
  assert.equal(peak, 2)
  assert.ok(order.indexOf('start next') < order.indexOf('end slow'), 'next starts before the slow one ends')
}

// --- base
assert.throws(() => h.resolveBase({}), /args.base is required/)
assert.throws(() => h.resolveBase({ base: 'main; rm' }), /not a plain branch name/)
assert.equal(h.resolveBase({ base: 'feature/x' }), 'feature/x')

// --- prompts
{
  const p1 = h.unitPrompt(u('u1', ['./src/a.ts', 'src/a.test.ts'], [], 'standard', { setup: 'pnpm install --frozen-lockfile' }), 'standard', 1, null, 'main')
  assert.match(p1, /git add -A -- 'src\/a.ts' 'src\/a.test.ts'/)
  assert.match(p1, /Run the setup command first: `pnpm install --frozen-lockfile`/)
  assert.match(p1, /git merge-base HEAD main/)
  assert.doesNotMatch(p1, /This is attempt/)
  assert.match(p1, /\n\nTask: t\n\n/, 'sections stay separated by blank lines')
  const p2 = h.unitPrompt(u('u1', ['a']), 'strong', 2, { tier: 'standard', reason: 'check failed', summary: 's', checkOutput: 'TypeError at x' }, 'main')
  assert.match(p2, /attempt 2/); assert.match(p2, /TypeError at x/)
  const pc = h.unitPrompt(u('u1', ['a'], [], 'standard', { commit: 'feat(x): y' }), 'standard', 1, null, 'main')
  assert.match(pc, /git commit -m "feat\(x\): y"/)
}
{
  const m = h.mergePrompt('main', [{ id: 'u1', branch: 'b1', check: 'pnpm test', setup: 'pnpm install' }, { id: 'u2', branch: 'b2', check: 'pnpm lint' }])
  assert.match(m, /u1 -> b1; u2 -> b2/)
  assert.match(m, /u1: setup `pnpm install`, check `pnpm test`; u2: check `pnpm lint`/)
  assert.match(m, /git status --porcelain --untracked-files=no/)
  assert.match(m, /git rev-parse --verify/)
}

console.log('dispatch.test.mjs: all assertions passed')
