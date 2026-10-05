import { expect, test } from 'claude-code/testing'
import { renderBand, renderConsole } from '../hooks/hud.ts'
import { Canvas, THEMES, THEME_ORDER, setTheme, T } from '../hooks/canvas.ts'

const snap: any = {
  id: 'abcdef123456', jira: 'ABC-1', branch: 'feature/ABC-1-x', working: true, now: 1_000_000, startedAt: 0,
  turns: 3, steps: 7, toolCalls: 5, toolFail: 1,
  tokens: { in: 50, out: 12_000, cacheRead: 900_000, cacheWrite: 150_000 },
  costUsd: 0.9, turnCostUsd: 0.05, models: { 'claude-sonnet-5-5': 7 },
  toolStats: { Bash: { n: 4, ms: 1000, fail: 1 }, Read: { n: 1, ms: 5, fail: 0 } },
  skills: { x: { n: 1 } }, agents: { Explore: { n: 1 } }, ctxPct: 7, fiveHour: 6, sevenDay: 90,
  log: [{ t: 0, kind: 'tool', name: 'Bash', detail: 'ls', ms: 12, ok: true }],
  stepLog: [{ n: 1, label: 'T1', stop: 'tool_use', out: 100, in: 2, cr: 1000, cw: 50, ms: 900, tools: 1 }],
  turnLog: [{ label: 'T1', out: 1000, ms: 5000, usd: 0.1 }],
}

test('band is framed at 6 rows and compact below', () => {
  expect(renderBand(snap, 100, 6).rows).toBe(6)
  expect(renderBand(snap, 70, 3).rows).toBe(3)
})

test('console fills the requested size', () => {
  const c = renderConsole(snap, 110, 20)
  expect(c.cols).toBe(110)
  expect(c.rows).toBe(20)
})

test('packed cells round trip to cols*rows*3 numbers', () => {
  const c = new Canvas(10, 4)
  const back = new Uint32Array(Uint8Array.from(atob(c.pack()), (ch) => ch.charCodeAt(0)).buffer)
  expect(back.length).toBe(10 * 4 * 3)
})

test('text never draws past the right edge', () => {
  const c = new Canvas(8, 1)
  c.text(0, 0, 'this is far too long', 0xffffff)
  expect(c.cells().length).toBe(8 * 3)
})

test('the resting laser does not move between frames', () => {
  const a = renderBand({ ...snap, working: false, now: 1_000 }, 100, 6).cells()
  const b = renderBand({ ...snap, working: false, now: 1_000 + 7_000 }, 100, 6).cells()
  expect(JSON.stringify(a.slice(100 * 3 * 2, 100 * 3 * 3))).toBe(JSON.stringify(b.slice(100 * 3 * 2, 100 * 3 * 3)))
})

test('every theme renders the band and the console', () => {
  for (const name of THEME_ORDER) {
    expect(setTheme(name)).toBe(true)
    expect(renderBand(snap, 100, 6).rows).toBe(6)
    expect(renderConsole(snap, 92, 30).rows).toBe(30)
  }
  expect(setTheme('no-such-theme')).toBe(false)
  setTheme('soft')
})

test('soft (the default) uses the terminal background, neon draws its own near-black', () => {
  expect(T.name).toBe('soft')
  expect(new Canvas(4, 2).bg[0]).toBe(0x01000000)
  setTheme('neon')
  expect(new Canvas(4, 2).bg[0]).toBe(THEMES.neon.bg)
  setTheme('soft')
  expect(T.name).toBe('soft')
})

test('console draws the agent radar, card lifetime and budget without overflowing', () => {
  const c = renderConsole({
    ...snap, view: 'ledger', todayUsd: 6.4, budgetUsd: 20, cardLife: { usd: 14.8, out: 41200, turns: 63, sessions: 5 },
    agentRuns: [{ type: 'Explore', desc: 'Find callers of a helper', t0: 1000, t1: 4000 }, { type: 'Plan', desc: 'Outline', t0: 2000, t1: null }],
  }, 92, 44)
  expect(c.cols).toBe(92)
  expect(c.rows).toBe(44)
})

test('limit bars take an elapsed-time marker', () => {
  const c = new Canvas(20, 1)
  c.bar(0, 0, 12, 0.2, 0xffffff, undefined, undefined, 0.5)
  expect(c.charAt(1 + 5, 0)).toBe('│'.codePointAt(0))
})
