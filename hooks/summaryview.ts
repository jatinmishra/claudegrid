// The SUMMARY tab: the central ledger drawn in the same Raster style as the rest of the console.
// Pure (state in, Canvas out) so it can be tested and previewed without Claude Code.

import { Canvas, C, DEFAULT, lerp3 } from './canvas.ts'
import { group, filterRows } from './summary.ts'
import type { Row, Agg, Dim } from './summary.ts'
import { fmtUsd, fmtTokens, fmtDur, cacheHit, clamp } from './lib.ts'

export type SView = 'overview' | 'card' | 'day' | 'week' | 'month' | 'model' | 'skill' | 'tool' | 'agent' | 'project' | 'session' | 'detail'
export const SVIEWS: SView[] = ['overview', 'card', 'day', 'model', 'skill', 'agent', 'tool', 'project']
export const RANGE_PRESETS: (number | null)[] = [1, 7, 30, null]

export interface SumState {
  rows: Row[]
  loaded: boolean
  loading: boolean
  loadedAt: number
  note: string
  view: SView
  days: number | null
  sel: number // selected row in the main table
  detailCard: string | null
  now: number
}

export const rangeLabel = (days: number | null): string => (days == null ? 'all time' : days === 1 ? 'today' : `last ${days} days`)
export const rangeShort = (days: number | null): string => (days == null ? 'ALL' : days === 1 ? 'TODAY' : `${days}D`)

const VIEW_LABEL: Record<SView, string> = {
  overview: 'OVERVIEW', card: 'BY CARD', day: 'BY DAY', week: 'BY WEEK', month: 'BY MONTH', model: 'BY MODEL', skill: 'BY SKILL',
  tool: 'BY TOOL', agent: 'BY AGENT', project: 'BY PROJECT', session: 'BY SESSION', detail: 'CARD',
}

// The rows the main (selectable) table shows for this state.
export function mainAggs(st: SumState): Agg[] {
  const rows = filterRows(st.rows, { days: st.days, card: st.view === 'detail' ? st.detailCard : null }, new Date(st.now))
  const dim: Dim = st.view === 'overview' || st.view === 'card' ? 'card' : st.view === 'detail' ? 'session' : (st.view as Dim)
  return group(rows, dim)
}

// ---------- drawing helpers ----------
const clip = (s: string, w: number) => (s.length > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s.padEnd(w))
const right = (s: string, w: number) => s.padStart(w)

interface Col { id: 'bar' | 'cost' | 'turns' | 'sess' | 'out' | 'last'; w: number; head: string }
const COLS: Col[] = [
  { id: 'cost', w: 8, head: 'COST' }, { id: 'turns', w: 5, head: 'TURNS' }, { id: 'sess', w: 4, head: 'SESS' },
  { id: 'out', w: 7, head: 'OUT' }, { id: 'last', w: 10, head: 'LAST' }, { id: 'bar', w: 6, head: '' },
]

function highlightRow(cv: Canvas, x0: number, x1: number, y: number) {
  for (let x = x0; x <= x1; x++) {
    const i = y * cv.cols + x
    cv.bg[i] = C.cyan
    const ch = cv.ch[i]
    if (ch !== 0x2588 && ch !== 0x2591) cv.fg[i] = C.ink // keep the bar fill visible
  }
}

// A framed table. `sel` highlights a row and the window follows it.
function drawTable(cv: Canvas, x: number, y: number, w: number, h: number, title: string, aggs: Agg[], keyLabel: string, sel: number | null) {
  if (w < 16 || h < 4) return
  const visible = h - 3 // frame (2) + header (1)
  const total = aggs.length
  let start = 0
  if (sel != null && total > visible) start = clamp(sel - Math.floor(visible / 2), 0, total - visible)
  const end = Math.min(total, start + visible)
  cv.frame(x, y, w, h, {
    color: C.cyan, label: title, labelColor: C.hot,
    tab: total > visible ? `${start + 1}-${end} of ${total}` : undefined, tabColor: C.dim,
  })
  const ix = x + 2
  const innerW = w - 4
  // keep columns while the key column still has 12+ characters
  const cols: Col[] = []
  let used = 0
  for (const c of COLS) {
    if (innerW - (used + c.w + 1) >= 12) { cols.push(c); used += c.w + 1 }
  }
  const kw = innerW - used
  let cx = ix + kw + 1
  cv.text(ix, y + 1, clip(keyLabel, kw), C.dim)
  for (const c of cols) { if (c.head) cv.text(cx, y + 1, right(c.head, c.w), C.dim); cx += c.w + 1 }

  if (total === 0) { cv.text(ix, y + 2, 'nothing recorded for this range', C.dim, DEFAULT, ix + innerW - 1); return }
  const maxCost = Math.max(1e-9, ...aggs.map((a) => a.cost))
  for (let i = start; i < end; i++) {
    const a = aggs[i]
    const yy = y + 2 + (i - start)
    const noCard = a.key === '(no card)'
    cv.text(ix, yy, clip(a.key, kw), noCard ? C.dim : C.hot)
    let px = ix + kw + 1
    for (const c of cols) {
      if (c.id === 'cost') cv.text(px, yy, right(fmtUsd(a.cost), c.w), C.hot)
      else if (c.id === 'turns') cv.text(px, yy, right(String(a.turns), c.w), C.text)
      else if (c.id === 'sess') cv.text(px, yy, right(String(a.sessions.size), c.w), C.text)
      else if (c.id === 'out') cv.text(px, yy, right(fmtTokens(a.out), c.w), C.text)
      else if (c.id === 'last') cv.text(px, yy, right(a.last.slice(0, 10), c.w), C.dim)
      else if (c.id === 'bar') cv.bar(px, yy, c.w, a.cost / maxCost, C.cyan, C.deep, C.magenta)
      px += c.w + 1
    }
    if (sel === i) highlightRow(cv, ix - 1, ix + innerW, yy)
  }
}

// ---------- the pane ----------
export function renderSummaryPane(st: SumState, cols: number, rows: number): Canvas {
  const H = Math.max(10, rows)
  const cv = new Canvas(cols, H)
  const body = H - 1
  const detail = st.view === 'detail'

  // headline panel
  const filtered = filterRows(st.rows, { days: st.days, card: detail ? st.detailCard : null }, new Date(st.now))
  const sum = (f: (r: Row) => number) => filtered.reduce((s, r) => s + f(r), 0)
  const cost = sum((r) => r.costUsd)
  const out = sum((r) => r.out)
  const inn = sum((r) => r.in)
  const cr = sum((r) => r.cacheRead)
  const cw = sum((r) => r.cacheWrite)
  const sessions = new Set(filtered.map((r) => r.session)).size
  const headTitle = detail ? `CARD ${st.detailCard}` : 'GRID SUMMARY'
  cv.frame(0, 0, cols, 4, { color: C.hot, label: headTitle, labelColor: C.white, tab: `${rangeShort(st.days)} · ${VIEW_LABEL[st.view]}`, tabColor: C.cyan, tabInset: 6 })
  const stat = (x: number, y: number, label: string, value: string, color: number = C.hot) => {
    const e = cv.text(x, y, label + ' ', C.dim)
    return cv.text(e, y, value, color) + 2
  }
  if (!st.loaded) {
    cv.text(2, 1, st.loading ? 'reading every session in ~/.claude/claudegrid …' : 'press u to load', C.dim)
  } else if (filtered.length === 0) {
    cv.text(2, 1, `no turns recorded for ${detail ? st.detailCard + ' in ' : ''}${rangeLabel(st.days)}`, C.dim)
    cv.text(2, 2, 'press r for a wider range, or b to go back', C.dim)
  } else {
    let x = 2
    x = stat(x, 1, 'SESSIONS', String(sessions))
    x = stat(x, 1, 'TURNS', String(filtered.length))
    x = stat(x, 1, 'COST', fmtUsd(cost))
    x = stat(x, 1, 'CLAUDE TIME', fmtDur(sum((r) => r.durationMs)))
    x = 2
    x = stat(x, 2, 'OUT', fmtTokens(out))
    x = stat(x, 2, 'IN', fmtTokens(inn))
    x = stat(x, 2, 'CACHE R', fmtTokens(cr), C.text)
    x = stat(x, 2, 'W', fmtTokens(cw), C.text)
    x = stat(x, 2, 'HIT', Math.round(cacheHit(inn, cr, cw) * 100) + '%')
    x = stat(x, 2, 'TOOLS', String(sum((r) => r.toolCalls)))
  }

  // main area
  const top = 4
  const areaH = body - top
  const wide = cols >= 100 && areaH >= 12
  const aggs = st.loaded ? mainAggs(st) : []
  const sel = aggs.length ? clamp(st.sel, 0, aggs.length - 1) : null
  const keyLabel = detail ? 'SESSION' : st.view === 'overview' || st.view === 'card' ? 'CARD' : VIEW_LABEL[st.view].replace('BY ', '')
  const mainTitle = detail ? 'SESSIONS' : st.view === 'overview' ? 'BY CARD  (n/p select, o open)' : VIEW_LABEL[st.view]
  const showSide = (st.view === 'overview' || detail) && wide && st.loaded && filtered.length > 0

  if (showSide) {
    const leftW = Math.floor(cols * 0.55)
    const sideW = cols - leftW
    const mainAggs2 = detail ? aggs.map((a) => ({ ...a, key: a.key.slice(0, 8) })) : aggs
    drawTable(cv, 0, top, leftW, areaH, mainTitle, mainAggs2, keyLabel, sel)
    const panels: [string, Dim, string, number][] = detail
      ? [['BY DAY', 'day', 'DAY', 7], ['BY MODEL', 'model', 'MODEL', 4], ['SKILLS', 'skill', 'SKILL', 4], ['TOOLS', 'tool', 'TOOL', 5]]
      : [['BY DAY', 'day', 'DAY', 7], ['BY MODEL', 'model', 'MODEL', 4], ['TOP SKILLS', 'skill', 'SKILL', 4], ['TOP TOOLS', 'tool', 'TOOL', 5]]
    // share the side column by how many rows each panel wants (a table needs rows + 3 for frame and header)
    const groups = panels.map(([title, dim, label, n]) => ({ title, label, list: group(filtered, dim).slice(0, n) })).filter((g) => g.list.length > 0)
    const wants = groups.map((g) => g.list.length + 3)
    let remaining = areaH
    let y = top
    groups.forEach((g, i) => {
      const left = groups.length - i - 1
      const h = Math.min(wants[i], remaining - left * 4)
      if (h >= 4) { drawTable(cv, leftW, y, sideW, h, g.title, g.list, g.label, null); y += h; remaining -= h }
    })
  } else {
    drawTable(cv, 0, top, cols, areaH, mainTitle, aggs, keyLabel, sel)
  }

  // status strip, like the other tabs
  const bar = ` 3 [summary]  ${rangeLabel(st.days)}  ${VIEW_LABEL[st.view].toLowerCase()}  ${st.loaded ? st.rows.length + ' turns on file' : 'loading'}`
  const note = st.loaded ? ` ${st.note} ` : ''
  for (let x = 0; x < cols; x++) cv.set(x, H - 1, 32, C.ink, lerp3(C.cyan, C.blue, C.magenta, x / Math.max(1, cols - 1)))
  cv.text(0, H - 1, bar, C.ink)
  if (note.length < cols - bar.length - 2) cv.text(cols - note.length, H - 1, note, C.ink)
  return cv
}
