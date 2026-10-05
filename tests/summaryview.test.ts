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

const text = (c: { ch: number[] }): string => String.fromCodePoint(...c.ch)

test('a docked pane about 89 columns wide still shows the side panels, in overview and in a card', () => {
  const o = text(renderSummaryPane(state(), 89, 40))
  expect(o.includes('BY DAY')).toBe(true)
  expect(o.includes('BY MODEL')).toBe(true)
  expect(o.includes('TOP TOOLS')).toBe(true)
  const d = text(renderSummaryPane(state({ view: 'detail', detailCard: 'ABC-1' }), 89, 40))
  expect(d.includes('SESSIONS')).toBe(true)
  expect(d.includes('BY MODEL')).toBe(true)
  expect(d.includes('BY DAY')).toBe(true)
})

test('a narrow pane stacks the panels under the main table when it is tall enough', () => {
  const n = text(renderSummaryPane(state(), 64, 40))
  expect(n.includes('BY DAY')).toBe(true)
  expect(n.includes('BY MODEL')).toBe(true)
  const short = text(renderSummaryPane(state(), 64, 12))
  expect(short.includes('BY CARD')).toBe(true)
})

test('the tool and model views draw their own columns in the pane', () => {
  const withStats = (r: Row): Row => ({ ...r, v: 2, toolStats: { Bash: { n: 2, ms: 6000, fail: 1, est: 600 }, Read: { n: 1, ms: 50, fail: 0, est: 900 } }, modelStats: { m1: { steps: 2, in: 10, out: 500, cacheRead: 9000, cacheWrite: 100 } }, tools: { Bash: 2, Read: 1 } })
  const rows = state().rows.map(withStats)
  const tool = text(renderSummaryPane(state({ rows, view: 'tool' }), 120, 30))
  expect(tool.includes('CALLS')).toBe(true)
  expect(tool.includes('FAIL')).toBe(true)
  const model = text(renderSummaryPane(state({ rows, view: 'model' }), 120, 30))
  expect(model.includes('REQS')).toBe(true)
  const skill = text(renderSummaryPane(state({ rows, view: 'skill' }), 120, 30))
  expect(skill.includes('COST*')).toBe(true)
  expect(skill.includes('whole turns')).toBe(true)
})
