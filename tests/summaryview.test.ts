import { expect, test } from 'claude-code/testing'
import { renderSummaryPane, mainAggs, rangeLabel } from '../hooks/summaryview.ts'
import type { SumState } from '../hooks/summaryview.ts'
import type { Row } from '../hooks/summary.ts'

const NOW = Date.parse('2026-01-15T12:00:00Z')
const row = (session: string, n: number, card: string | null, cost: number, daysAgo: number): Row => ({
  v: 1, id: `${session}:T${n}`, session, kind: 'turn', n, at: new Date(NOW - daysAgo * 86400e3).toISOString(), card, branch: 'b', project: 'p',
  models: { m1: 2 }, in: 10, out: 500, cacheRead: 9000, cacheWrite: 100, steps: 2, toolCalls: 2, toolMs: 10, fails: 0, tools: { Bash: 2 },
  skills: ['tdd'], agents: [], durationMs: 1000, costUsd: cost,
})
const state = (over: Partial<SumState> = {}): SumState => ({
  rows: [row('s1', 1, 'ABC-1', 2, 1), row('s1', 2, 'ABC-1', 3, 1), row('s2', 1, 'ABC-2', 1, 2), row('s3', 1, null, 4, 3)],
  loaded: true, loading: false, loadedAt: NOW, note: 'x', view: 'overview', days: 30, sel: 0, detailCard: null, now: NOW, ...over,
})

test('overview, detail and every dimension draw at the requested size', () => {
  for (const view of ['overview', 'card', 'day', 'week', 'month', 'model', 'skill', 'tool', 'agent', 'project', 'session'] as const) {
    const c = renderSummaryPane(state({ view }), 120, 34)
    expect(c.cols).toBe(120)
    expect(c.rows).toBe(34)
  }
  const d = renderSummaryPane(state({ view: 'detail', detailCard: 'ABC-1' }), 120, 34)
  expect(d.rows).toBe(34)
})

test('the main table is sorted by cost and respects the range and the card filter', () => {
  const all = mainAggs(state())
  expect(all[0].key).toBe('ABC-1') // $5 beats the $4 of turns without a card
  expect(all[1].key).toBe('(no card)')
  expect(mainAggs(state({ days: 1 })).length).toBe(0)
  expect(mainAggs(state({ view: 'detail', detailCard: 'ABC-1' })).length).toBe(1)
})

test('loading and empty states draw instead of crashing; narrow panes still work', () => {
  expect(renderSummaryPane(state({ loaded: false, loading: true, rows: [] }), 80, 20).rows).toBe(20)
  expect(renderSummaryPane(state({ rows: [] }), 80, 20).rows).toBe(20)
  expect(renderSummaryPane(state(), 60, 16).cols).toBe(60)
  expect(rangeLabel(null)).toBe('all time')
})
