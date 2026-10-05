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
