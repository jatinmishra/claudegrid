import { expect, test } from 'claude-code/testing'
import { rowFromRecord, parseSummaryArgs, filterRows, group, renderSummary, toCsv } from '../hooks/summary.ts'
import type { Row } from '../hooks/summary.ts'

const rec = (turn: number, jira: string | null, cost: number, at: string) => ({
  kind: 'turn', turn, jira, branch: 'feature/x', endedAt: at, durationMs: 1000, costUsd: cost,
  steps: [{ model: 'm1' }, { model: 'm1' }], tools: [{ name: 'Bash', wallMs: 100, ok: true }, { name: 'Bash', wallMs: 50, ok: false }],
  skills: [{ name: 'tdd' }], agents: [{ type: 'Explore' }], totals: { in: 5, out: 100, cacheRead: 900, cacheWrite: 50 },
})
const rows = (): Row[] => [
  rowFromRecord(rec(1, 'ABC-1', 1, '2026-01-10T10:00:00Z'), { session: 's1', project: 'p' }),
  rowFromRecord(rec(2, 'ABC-1', 2, '2026-01-11T10:00:00Z'), { session: 's1', project: 'p' }),
  rowFromRecord(rec(1, null, 4, '2026-01-11T11:00:00Z'), { session: 's2', project: 'q' }),
]

test('a record becomes a compact row', () => {
  const r = rows()[0]
  expect(r.id).toBe('s1:T1')
  expect(r.steps).toBe(2)
  expect(r.toolCalls).toBe(2)
  expect(r.fails).toBe(1)
  expect(r.tools.Bash).toBe(2)
  expect(r.card).toBe('ABC-1')
})

test('arguments: dimension, card key and range in any order', () => {
  const a = parseSummaryArgs('abc-123 skill 7d')
  expect(a.dim).toBe('skill')
  expect(a.card).toBe('ABC-123')
  expect(a.days).toBe(7)
  expect(parseSummaryArgs('all').days).toBe(null)
  expect(parseSummaryArgs('banana').error).toContain('banana')
})

test('grouping by card sums cost and turns; a missing card is its own group', () => {
  const g = group(rows(), 'card')
  expect(g.find((x) => x.key === 'ABC-1')!.cost).toBe(3)
  expect(g.find((x) => x.key === '(no card)')!.turns).toBe(1)
})

test('summary text and filters', () => {
  const t = renderSummary(rows(), parseSummaryArgs('all'), '', new Date('2026-01-15T12:00:00Z'))
  expect(t).toContain('3 turns')
  expect(t).toContain('$7.000')
  expect(filterRows(rows(), { days: null, card: 'ABC-1' }).length).toBe(2)
  expect(renderSummary(rows(), parseSummaryArgs('card ZZZ-9 all'))).toContain('No ledger data')
})

test('csv quotes commas and quotes', () => {
  const r = rows()[0]
  r.branch = 'a,"b"'
  expect(toCsv([r])).toContain('"a,""b"""')
})

// ---- per-dimension figures: a BY TOOL table is about the tool, not the turn ----
const toolRec = () => ({
  kind: 'turn', turn: 1, jira: 'ABC-1', branch: 'b', endedAt: '2026-01-10T10:00:00Z', durationMs: 5000, costUsd: 0.5,
  steps: [{ model: 'm1', usage: { in: 2, out: 300, cacheRead: 100, cacheWrite: 10 } }, { model: 'm2', usage: { in: 3, out: 700, cacheRead: 200, cacheWrite: 20 } }],
  tools: [
    { name: 'Bash', wallMs: 4000, ok: false, estResultTokens: 500 }, { name: 'Bash', wallMs: 2000, ok: true, estResultTokens: 100 },
    { name: 'Read', wallMs: 50, ok: true, estResultTokens: 900 },
  ],
  skills: [{ name: 'tdd' }], agents: [{ type: 'Explore' }, { type: 'Explore' }], totals: { in: 5, out: 1000, cacheRead: 300, cacheWrite: 30 },
})

test('tools get their own calls, time and failures, not the turn totals', () => {
  const r = [rowFromRecord(toolRec(), { session: 's1' })]
  const g = group(r, 'tool')
  const bash = g.find((x) => x.key === 'Bash')!
  const read = g.find((x) => x.key === 'Read')!
  expect(bash.calls).toBe(2)
  expect(bash.toolMs).toBe(6000)
  expect(bash.fail).toBe(1)
  expect(bash.est).toBe(600)
  expect(read.calls).toBe(1)
  expect(read.toolMs).toBe(50)
  expect(bash.cost).toBe(0) // the turn's cost is not attributed to a tool
  expect(g[0].key).toBe('Bash') // sorted by calls
})

test('models get their own requests and tokens from each request, so two models in one turn split correctly', () => {
  const g = group([rowFromRecord(toolRec(), { session: 's1' })], 'model')
  const m1 = g.find((x) => x.key === 'm1')!
  const m2 = g.find((x) => x.key === 'm2')!
  expect(m1.out).toBe(300)
  expect(m2.out).toBe(700)
  expect(m1.reqs).toBe(1)
  expect(g[0].key).toBe('m2') // sorted by output tokens
})

test('skills and agents carry the whole turn; an agent also counts its own spawns', () => {
  const r = [rowFromRecord(toolRec(), { session: 's1' })]
  expect(group(r, 'skill')[0].cost).toBe(0.5)
  const ag = group(r, 'agent')[0]
  expect(ag.spawns).toBe(2)
  expect(ag.turns).toBe(1)
})

test('rows from before per-tool figures still count calls, and say time is unknown', () => {
  const old = rowFromRecord(toolRec(), { session: 's1' })
  delete (old as any).toolStats
  old.v = 1
  const bash = group([old], 'tool').find((x) => x.key === 'Bash')!
  expect(bash.calls).toBe(2)
  expect(bash.msKnown).toBe(false)
  const text = renderSummary([old], parseSummaryArgs('tool all'))
  expect(text.includes('—')).toBe(true)
})

test('the tool table prints its own columns and the skill table prints the whole-turn note', () => {
  const r = [rowFromRecord(toolRec(), { session: 's1' })]
  const t = renderSummary(r, parseSummaryArgs('tool all'))
  expect(t.includes('CALLS')).toBe(true)
  expect(t.includes('FAIL')).toBe(true)
  expect(t.includes('COST')).toBe(false)
  const s = renderSummary(r, parseSummaryArgs('skill all'))
  expect(s.includes('COST*')).toBe(true)
  expect(s.includes('whole turns')).toBe(true)
})
