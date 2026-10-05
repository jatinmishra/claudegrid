// The SUMMARY tab: the central ledger drawn in the same Raster style as the rest of the console.
// Pure (state in, Canvas out) so it can be tested and previewed without Claude Code.

import { Canvas, C, DEFAULT, lerp3 } from './canvas.ts'
import { group, filterRows, colsFor, barValue } from './summary.ts'
import type { Row, Agg, Dim, ColDef } from './summary.ts'
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
  onLayout?: (info: { visibleRows: number }) => void // told how many rows the selectable table shows, so a page key can jump that far
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

// The dimension a view counts: its tables use that dimension's own columns.
export const viewDim = (v: SView): Dim => (v === 'overview' || v === 'card' ? 'card' : v === 'detail' ? 'session' : (v as Dim))

// ---------- drawing helpers ----------
const clip = (s: string, w: number) => (s.length > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s.padEnd(w))
const right = (s: string, w: number) => s.padStart(w)

function highlightRow(cv: Canvas, x0: number, x1: number, y: number) {
  for (let x = x0; x <= x1; x++) {
    const i = y * cv.cols + x
    cv.bg[i] = C.cyan
    const ch = cv.ch[i]
    if (ch !== 0x2588 && ch !== 0x2591) cv.fg[i] = C.ink // keep the bar fill visible
  }
}

// A framed table. `sel` highlights a row and the window follows it.
function drawTable(cv: Canvas, x: number, y: number, w: number, h: number, title: string, aggs: Agg[], keyLabel: string, dim: Dim, sel: number | null, skip: string[] = [], onVisible?: (n: number) => void) {
  if (w < 16 || h < 4) return
  const visible = h - 3 // frame (2) + header (1)
  if (onVisible) onVisible(visible)
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
  // this dimension's own columns, in priority order, while the key column still has 12+ characters; then the bar
  const cols: ColDef[] = []
  let used = 0
  for (const c of colsFor(dim)) {
    if (!c.pane || skip.includes(c.id)) continue
    if (innerW - (used + c.w + 1) >= 12) { cols.push(c); used += c.w + 1 }
  }
  const BAR_W = 6
  const hasBar = innerW - (used + BAR_W + 1) >= 12
  if (hasBar) used += BAR_W + 1
  const kw = innerW - used
  let cx = ix + kw + 1
  cv.text(ix, y + 1, clip(keyLabel, kw), C.dim)
  for (const c of cols) { cv.text(cx, y + 1, right(c.head, c.w), C.dim); cx += c.w + 1 }

  if (total === 0) { cv.text(ix, y + 2, 'nothing recorded for this range', C.dim, DEFAULT, ix + innerW - 1); return }
  const maxBar = Math.max(1e-9, ...aggs.map((a) => barValue(a, dim)))
  for (let i = start; i < end; i++) {
    const a = aggs[i]
    const yy = y + 2 + (i - start)
    const noCard = a.key === '(no card)'
    cv.text(ix, yy, clip(a.key, kw), noCard ? C.dim : C.hot)
    let px = ix + kw + 1
    for (const c of cols) {
      const color = c.id === 'cost' ? C.hot : c.id === 'fail' && a.fail > 0 ? C.alert : c.id === 'last' ? C.dim : C.text
      cv.text(px, yy, right(c.get(a), c.w), color)
      px += c.w + 1
    }
    if (hasBar) cv.bar(px, yy, BAR_W, barValue(a, dim) / maxBar, C.cyan, C.deep, C.magenta)
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
    cv.text(2, 2, st.note.includes('loose') ? st.note : 'press r for a wider range, or b to go back', st.note.includes('loose') ? C.alert : C.dim, DEFAULT, cols - 3)
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
  const aggs = st.loaded ? mainAggs(st) : []
  const sel = aggs.length ? clamp(st.sel, 0, aggs.length - 1) : null
  const dim = viewDim(st.view)
  const keyLabel = detail ? 'SESSION' : st.view === 'overview' || st.view === 'card' ? 'CARD' : VIEW_LABEL[st.view].replace('BY ', '')
  const mainTitle = detail ? 'SESSIONS' : st.view === 'overview' ? 'BY CARD  (↑↓ select, Enter opens)' : st.view === 'skill' || st.view === 'agent' ? `${VIEW_LABEL[st.view]}  (* whole turns that used it)` : VIEW_LABEL[st.view]
  const multi = (st.view === 'overview' || detail) && st.loaded && filtered.length > 0 && areaH >= 14
  const skip: string[] = detail ? ['sess'] : [] // every row in a list of sessions is one session
  const vis = (n: number) => st.onLayout?.({ visibleRows: n })

  // Panels stacked in a column; each gets the rows it wants, and later ones are dropped if there is no room.
  const stack = (x: number, y0: number, w: number, h: number, defs: [string, Dim, string, number][]) => {
    const groups = defs.map(([title, dim, label, n]) => ({ title, dim, label, list: group(filtered, dim).slice(0, n) })).filter((g) => g.list.length > 0)
    let remaining = h
    let y = y0
    groups.forEach((g, i) => {
      const left = groups.length - i - 1
      const ph = Math.min(g.list.length + 3, remaining - left * 4)
      if (ph >= 4) { drawTable(cv, x, y, w, ph, g.title, g.list, g.label, g.dim, null); y += ph; remaining -= ph }
    })
  }

  if (multi) {
    const mainRows = detail ? aggs.map((a) => ({ ...a, key: a.key.slice(0, 8) })) : aggs
    const side: [string, Dim, string, number][] = [
      ['BY MODEL', 'model', 'MODEL', 4], [detail ? 'SKILLS' : 'TOP SKILLS', 'skill', 'SKILL', 4],
      [detail ? 'AGENTS' : 'TOP AGENTS', 'agent', 'AGENT', 3], [detail ? 'TOOLS' : 'TOP TOOLS', 'tool', 'TOOL', 5],
    ]
    if (cols >= 76) {
      // two columns: the main table with the days under it, and models, skills, agents and tools beside
      const leftW = Math.floor(cols * 0.55)
      const mainH = clamp(aggs.length + 3, 6, Math.floor(areaH * 0.55))
      drawTable(cv, 0, top, leftW, mainH, mainTitle, mainRows, keyLabel, dim, sel, skip, vis)
      const days = group(filtered, 'day').slice(0, 14)
      const dayH = Math.min(days.length + 3, areaH - mainH)
      if (dayH >= 4) drawTable(cv, 0, top + mainH, leftW, dayH, 'BY DAY', days, 'DAY', 'day', null)
      stack(leftW, top, cols - leftW, areaH, side)
    } else {
      // a narrow pane: one column, everything stacked under the main table
      const mainH = clamp(aggs.length + 3, 6, Math.floor(areaH * 0.35))
      drawTable(cv, 0, top, cols, mainH, mainTitle, mainRows, keyLabel, dim, sel, skip, vis)
      stack(0, top + mainH, cols, areaH - mainH, [['BY DAY', 'day', 'DAY', 7], ...side])
    }
  } else {
    drawTable(cv, 0, top, cols, areaH, mainTitle, aggs, keyLabel, dim, sel, skip, vis)
  }

  // status strip, like the other tabs
  const bar = ` 3 [summary]  ${rangeLabel(st.days)}  ${VIEW_LABEL[st.view].toLowerCase()}  ${st.loaded ? st.rows.length + ' turns on file' : 'loading'}`
  const note = st.loaded ? ` ${st.note} ` : ''
  for (let x = 0; x < cols; x++) cv.set(x, H - 1, 32, C.ink, lerp3(C.cyan, C.blue, C.magenta, x / Math.max(1, cols - 1)))
  cv.text(0, H - 1, bar, C.ink)
  if (note.length < cols - bar.length - 2) cv.text(cols - note.length, H - 1, note, C.ink)
  return cv
}
