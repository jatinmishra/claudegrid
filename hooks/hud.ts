// Pure renderers: Snapshot in, Canvas out. No Claude Code APIs, so they run (and are
// previewed and tested) outside a session.

import { Canvas, C, T, DEFAULT, lerp, lerp3, LIGHT_H } from './canvas.ts'
import { fmtTokens, fmtDur, fmtMs, cacheHit, fmtUsd, trunc, shortModel, clock, clamp } from './lib.ts'
import { LEVELS } from './game.ts'
import type { Game, Level } from './game.ts'

export interface LogEntry {
  t: number
  kind: 'tool' | 'skill' | 'agent' | 'turn'
  name: string
  detail: string
  ms: number
  ok: boolean
}

export interface StepEntry {
  n: number
  label: string // which turn record it belongs to, e.g. T2 or B1
  stop: string
  out: number
  in: number
  cr: number
  cw: number
  ms: number
  tools: number
}

export interface Snapshot {
  id: string
  jira: string | null
  branch: string
  working: boolean
  now: number
  startedAt: number
  turns: number
  steps: number
  toolCalls: number
  toolFail: number
  tokens: { in: number; out: number; cacheRead: number; cacheWrite: number }
  costUsd: number
  turnCostUsd: number
  models: Record<string, number>
  toolStats: Record<string, { n: number; ms: number; fail: number }>
  skills: Record<string, { n: number }>
  agents: Record<string, { n: number }>
  ctxPct: number
  fiveHour: number | null
  sevenDay: number | null
  log: LogEntry[]
  stepLog: StepEntry[]
  turnLog: { label: string; out: number; ms: number; usd: number }[]
  view?: 'ledger' | 'game'
  game?: Game | null
  // v1.0
  fiveHourElapsed?: number | null // fraction of the 5-hour window already gone
  sevenDayElapsed?: number | null
  todayUsd?: number
  budgetUsd?: number | null
  cardLife?: { usd: number; out: number; turns: number; sessions: number } | null
  agentRuns?: { type: string; desc: string; t0: number; t1: number | null }[]
  claudeDone?: boolean
  // 'subscription': the cost is an API-equivalent estimate (shown as COST~). 'api' / 'cloud': real charges.
  costMode?: 'subscription' | 'api' | 'cloud' | 'unknown'
}

// Tools that are plumbing for skills/agents, which have their own rows.
const PLUMBING = new Set(['Skill', 'Agent', 'SubagentHandback'])

// ---------- segments: a line made of coloured pieces, optionally right-aligned ----------
type Seg = { t: string; c: number } | { bar: number; w: number; c: number; mark?: number }

const segLen = (s: Seg) => ('bar' in s ? s.w : [...s.t].length)

function drawSegs(cv: Canvas, x: number, y: number, segs: Seg[], maxX: number): number {
  for (const s of segs) {
    if (x > maxX) break
    if ('bar' in s) x = cv.bar(x, y, s.w, s.bar, s.c, C.deep, undefined, s.mark)
    else x = cv.text(x, y, s.t, s.c, DEFAULT, maxX)
  }
  return x
}

const lab = (t: string): Seg => ({ t, c: C.dim })
const val = (t: string, c: number = C.text): Seg => ({ t, c })
const gap = (n = 2): Seg => ({ t: ' '.repeat(n), c: C.text })

// The laser: a visible grid line. Sweeps only while a turn is running; at rest it sits still.
function laser(cv: Canvas, x: number, y: number, w: number, now: number, active: boolean) {
  if (w < 6) return
  cv.hline(x, y, w, '─', C.deep)
  if (!active) {
    // resting beam: fixed at the left end, no motion
    cv.set(x, y, '█'.codePointAt(0)!, C.hot)
    cv.set(x + 1, y, '▓'.codePointAt(0)!, C.cyan)
    cv.set(x + 2, y, '▒'.codePointAt(0)!, C.dim)
    cv.set(x + 3, y, '░'.codePointAt(0)!, C.deep)
    return
  }
  const period = (w - 1) * 2
  const p = Math.floor(now / 28) % period
  const head = p < w ? p : period - p
  const dir = p < w ? -1 : 1
  const TAIL = 24
  for (let k = TAIL; k >= 1; k--) {
    const i = head + dir * k
    if (i < 0 || i >= w) continue
    const glyph = k === 1 ? '▓' : k <= 3 ? '▒' : '░'
    cv.set(x + i, y, glyph.codePointAt(0)!, lerp3(C.hot, C.cyan, C.magenta, k / TAIL))
  }
  cv.set(x + head, y, '█'.codePointAt(0)!, C.white)
}

// While a turn runs, a segment races around the top edge like a light-cycle trail.
function cycleTrail(cv: Canvas, now: number) {
  const span = cv.cols - 2
  if (span < 12) return
  const head = Math.floor(now / 35) % span
  for (let k = 0; k < 16; k++) {
    const i = head - k
    if (i < 0) continue
    const x = 1 + i
    if (cv.charAt(x, 0) !== LIGHT_H) continue
    cv.set(x, 0, '━'.codePointAt(0)!, lerp3(C.white, C.cyan, C.magenta, k / 14))
  }
}

const pct = (n: number | null) => (n == null ? '--' : Math.round(n) + '%')
// Neon traffic light for anything with a limit: primary neon, then yellow, then the alert colour.
const heat = (frac: number): number => (frac >= 0.8 ? C.alert : frac >= 0.6 ? C.yellow : C.cyan)
const hot = (n: number | null) => heat((n ?? 0) / 100)
const visibleTools = (s: Snapshot) =>
  Object.entries(s.toolStats).filter(([k]) => !PLUMBING.has(k)).sort((a, b) => b[1].n - a[1].n)

// ---------- the band above the prompt ----------
export function renderBand(s: Snapshot, cols: number, rows: number): Canvas {
  const framed = rows >= 6 && cols >= 50
  const H = framed ? 6 : 3
  const cv = new Canvas(cols, H)
  const x0 = framed ? 2 : 0
  const x1 = framed ? cols - 3 : cols - 1
  const w = x1 - x0 + 1
  const y0 = framed ? 1 : 0
  const state = s.working ? 'PROGRAM ACTIVE' : 'ON THE GRID'

  if (framed) {
    cv.frame(0, 0, cols, H, {
      color: C.cyan, label: 'CLAUDEGRID', labelColor: C.hot,
      tab: state, tabColor: s.working ? C.white : C.cyan,
    })
    if (s.working) cycleTrail(cv, s.now)
  }

  // line 1: identity + clock (+ plan limits on the right when there's room)
  const id: Seg[] = [
    ...(framed ? [] : [val('CLAUDEGRID ', C.hot), val(state + '  ', s.working ? C.white : C.cyan)]),
    lab('CARD '), val(s.jira ?? 'NO-CARD', s.jira ? C.hot : C.dim), gap(),
    lab('SESSION '), val(s.id.slice(0, 6)), gap(),
    lab('TURN '), val(String(s.turns)), gap(),
    lab('T+'), val(fmtDur(s.now - s.startedAt)),
  ]
  const idEnd = drawSegs(cv, x0, y0, id, x1)
  const rate: Seg[] = [
    lab('5H '), { bar: (s.fiveHour ?? 0) / 100, w: 8, c: hot(s.fiveHour), mark: s.fiveHourElapsed ?? undefined }, val(' ' + pct(s.fiveHour), hot(s.fiveHour)),
    gap(),
    lab('7D '), { bar: (s.sevenDay ?? 0) / 100, w: 8, c: hot(s.sevenDay), mark: s.sevenDayElapsed ?? undefined }, val(' ' + pct(s.sevenDay), hot(s.sevenDay)),
  ]
  const rateW = rate.reduce((a, g) => a + segLen(g), 0)
  if (framed && x1 - rateW + 1 > idEnd + 2) drawSegs(cv, x1 - rateW + 1, y0, rate, x1)

  // line 2: the laser
  laser(cv, x0, y0 + 1, w, s.now, s.working)

  // line 3: tokens + cost
  const t = s.tokens
  const hit = Math.round(cacheHit(t.in, t.cacheRead, t.cacheWrite) * 100)
  drawSegs(cv, x0, y0 + 2, [
    lab('OUT '), val(fmtTokens(t.out), C.hot), gap(),
    lab('IN '), val(fmtTokens(t.in)), gap(),
    lab('CACHE R '), val(fmtTokens(t.cacheRead)), lab(' W '), val(fmtTokens(t.cacheWrite)), lab(' HIT '), val(hit + '%'), gap(),
    lab(s.costMode === 'subscription' ? 'COST~ ' : 'COST '), val(fmtUsd(s.costUsd), C.hot), ...(framed && s.turnCostUsd > 0 ? [lab(' LAST '), val(fmtUsd(s.turnCostUsd))] : []),
    ...(framed && s.todayUsd ? [gap(), lab('TODAY '), val(fmtUsd(s.todayUsd), s.budgetUsd ? heat(s.todayUsd / s.budgetUsd) : C.text), ...(s.budgetUsd ? [lab('/'), val(fmtUsd(s.budgetUsd))] : [])] : []),
  ], x1)

  // line 4: context + model + programs
  const ctx = s.ctxPct / 100
  const line4: Seg[] = [
    lab('CTX '), { bar: ctx, w: 10, c: heat(ctx) }, val(' ' + Math.round(s.ctxPct) + '%'), gap(),
    lab('MODEL '), val(shortModel(Object.keys(s.models).slice(-1)[0] ?? '—')), gap(),
    lab('TOOLS '), val(String(s.toolCalls)), ...(s.toolFail ? [val(' ✗' + s.toolFail, C.alert)] : []), gap(),
    lab('SKILLS '), val(String(Object.keys(s.skills).length)), gap(),
    lab('AGENTS '), val(String(Object.values(s.agents).reduce((a, g) => a + g.n, 0))),
    ...((s.agentRuns ?? []).some((r) => r.t1 == null) ? [val(' ▶' + (s.agentRuns ?? []).filter((r) => r.t1 == null).length, C.white)] : []),
  ]
  if (framed) drawSegs(cv, x0, y0 + 3, line4, x1) // compact mode has no room for this row

  if (s.turns === 0 && s.steps === 0) {
    cv.fill(x0, y0 + 2, w, framed ? 2 : 1, ' ', C.text)
    cv.text(x0, y0 + 2, 'AWAITING USER INPUT ▸ DISC READY', C.dim, DEFAULT, x1)
  }
  return cv
}

// ---------- the console (opened by /grid) ----------

// One place for the console's geometry, so the game arena and the drawing never disagree.
export function layout(cols: number, rows: number) {
  const H = Math.max(8, rows)
  const body = H - 1 // last row is the status bar
  const wide = cols >= 84 && body >= 12
  const leftW = wide ? clamp(Math.floor(cols * 0.4), 32, 54) : 0
  const rw = cols - leftW
  return { H, body, wide, leftW, rw, gw: Math.floor((rw - 4) / 2), gh: body - 3 }
}

const gameLabel = (g: Game): { text: string; color: number } => {
  switch (g.state) {
    case 'ready': return { text: 'W/A/S/D TO START', color: C.hot }
    case 'running': return { text: 'RUNNING', color: C.white }
    case 'paused': return { text: 'PAUSED (p)', color: C.dim }
    case 'won': return { text: 'VICTORY (g)', color: C.hot }
    case 'lost': return { text: 'DE-REZZED (g)', color: C.alert }
    default: return { text: 'MUTUAL DE-REZ (g)', color: C.alert }
  }
}

const levelColor = (l: Level): number => ({ easy: C.lime, normal: C.cyan, hard: C.orange, insane: C.wreck })[l]

// Each game cell is two characters wide so cells look square.
// Neon: a grid floor, trails that burn white-hot at the head and settle to the cycle's colour,
// and a bloom of colour on the floor next to every trail.
function drawArena(cv: Canvas, ox: number, oy: number, g: Game) {
  const base = T.bg === DEFAULT ? 0x05090d : T.bg
  const at = (gx: number, gy: number) => (gx < 0 || gy < 0 || gx >= g.w || gy >= g.h ? 0 : g.grid[gy * g.w + gx])
  const put = (gx: number, gy: number, a: string, b: string, fg: number, bg: number) => {
    const x = ox + gx * 2
    const y = oy + gy
    cv.set(x, y, a.codePointAt(0)!, fg, bg)
    cv.set(x + 1, y, b.codePointAt(0)!, fg, bg)
  }
  const bloom = (gx: number, gy: number): number => {
    if (T.glow <= 0) return DEFAULT // SOFT: the floor stays on your terminal background
    let bg = base
    for (const [dx, dy, w] of [[1, 0, 0.22], [-1, 0, 0.22], [0, 1, 0.22], [0, -1, 0.22], [1, 1, 0.09], [-1, 1, 0.09], [1, -1, 0.09], [-1, -1, 0.09]] as const) {
      const v = at(gx + dx, gy + dy)
      if (v) bg = lerp(bg, v === 1 ? C.you : C.clu, w * (T.glow > 0 ? 1 : 0))
    }
    return bg
  }
  for (let gy = 0; gy < g.h; gy++) {
    for (let gx = 0; gx < g.w; gx++) {
      const i = gy * g.w + gx
      const v = g.grid[i]
      if (v) {
        const body = v === 1 ? C.you : C.clu
        const hotHead = v === 1 ? C.youHead : C.cluHead
        const age = g.ticks - g.stamp[i]
        const color = age < 12 ? lerp(hotHead, body, age / 12) : body
        put(gx, gy, ' ', ' ', color, color)
      } else {
        const onH = gy % 4 === 0
        const onV = gx % 4 === 0
        put(gx, gy, onH && onV ? '┼' : onH ? '─' : onV ? '│' : ' ', onH ? '─' : ' ', C.grid, bloom(gx, gy))
      }
    }
  }
  const head = (c: { x: number; y: number; alive: boolean }, color: number) => {
    if (c.alive) put(c.x, c.y, ' ', ' ', color, color)
    else {
      put(c.x, c.y, '▒', '▒', C.white, C.wreck)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (at(c.x + dx, c.y + dy) === 0 && c.x + dx >= 0 && c.y + dy >= 0 && c.x + dx < g.w && c.y + dy < g.h) put(c.x + dx, c.y + dy, '░', '░', C.wreck, T.glow > 0 ? lerp(base, C.wreck, 0.3) : DEFAULT)
      }
    }
  }
  head(g.clu, C.cluHead)
  head(g.you, C.youHead)
}

function drawGameView(cv: Canvas, s: Snapshot, rx: number, rw: number, body: number) {
  const g = s.game
  const ix = rx + 2
  const imax = rx + rw - 3
  if (!g || g.w < 8 || g.h < 6) {
    cv.text(ix, 2, 'ARENA TOO SMALL - widen the terminal', C.dim, DEFAULT, imax)
    return
  }
  const lab2 = gameLabel(g)
  const hdr: Seg[] = [lab('YOU '), val(String(g.wins), C.you), lab('  CLU '), val(String(g.losses), C.clu), gap(), val(lab2.text, lab2.color)]
  const hdrEnd = drawSegs(cv, ix, 1, hdr, imax)
  const status = s.claudeDone ? 'CLAUDE DONE' : s.working ? `CLAUDE s${s.steps} t${s.toolCalls}` : 'CLAUDE IDLE'
  const sx = imax - status.length + 1
  if (sx > hdrEnd + 2) cv.text(sx, 1, status, s.claudeDone ? C.hot : s.working ? C.white : C.dim, DEFAULT, imax)
  const ox = ix + Math.floor((rw - 4 - g.w * 2) / 2)
  drawArena(cv, ox, 2, g)
}

function drawLedgerView(cv: Canvas, s: Snapshot, rx: number, rw: number, body: number) {
  const ix = rx + 2
  const imax = rx + rw - 3
  const t = s.tokens
  const hit = Math.round(cacheHit(t.in, t.cacheRead, t.cacheWrite) * 100)
  const models = Object.entries(s.models).map(([m, n]) => `${shortModel(m)} ×${n}`).join('  ') || '—'
  const vt = visibleTools(s)
  const tools = vt.slice(0, 4).map(([k, v]) => `${k} ${v.n}`).join('  ') + (vt.length > 4 ? `  +${vt.length - 4}` : '') || '—'
  const skills = Object.entries(s.skills).map(([k, v]) => (v.n > 1 ? `${k} ×${v.n}` : k)).join(', ') || '—'
  const agents = Object.entries(s.agents).map(([k, v]) => `${k} ×${v.n}`).join('  ') || '—'

  const lines: Seg[][] = [
    [val('/grid # ', C.cyan), val('ledger --session', C.white)],
    [lab('SESSION  '), val(s.id)],
    [lab('BRANCH   '), val(s.branch || '—')],
    [lab('CARD     '), val(s.jira ?? 'NO-CARD', s.jira ? C.hot : C.dim), ...(s.cardLife ? [lab('  lifetime '), val(fmtUsd(s.cardLife.usd), C.hot), lab(` · ${s.cardLife.turns} turns · ${s.cardLife.sessions} sess`)] : [])],
    [lab('TOKENS   '), lab('out '), val(fmtTokens(t.out), C.hot), lab('  in '), val(fmtTokens(t.in))],
    [lab('CACHE    '), lab('read '), val(fmtTokens(t.cacheRead)), lab('  write '), val(fmtTokens(t.cacheWrite)), lab('  hit '), val(hit + '%')],
    [lab(s.costMode === 'subscription' ? 'COST~    ' : 'COST     '), val(fmtUsd(s.costUsd), C.hot), ...(s.costMode === 'subscription' ? [lab(' est.')] : []), lab('   5h '), val(pct(s.fiveHour), hot(s.fiveHour)), lab('  7d '), val(pct(s.sevenDay), hot(s.sevenDay))],
    ...(s.todayUsd ? [[lab('TODAY    '), val(fmtUsd(s.todayUsd), s.budgetUsd ? heat(s.todayUsd / s.budgetUsd) : C.hot), ...(s.budgetUsd ? [lab(' of '), val(fmtUsd(s.budgetUsd)), lab(` budget (${Math.round((100 * s.todayUsd) / s.budgetUsd)}%)`)] : [])]] : []),
    [lab('CONTEXT  '), { bar: s.ctxPct / 100, w: 12, c: heat(s.ctxPct / 100) }, val(' ' + Math.round(s.ctxPct) + '%')],
    [lab('MODELS   '), val(models)],
    [lab('TOOLS    '), val(tools)],
    [lab('SKILLS   '), val(skills)],
    [lab('AGENTS   '), val(agents)],
  ]
  const innerRows = body - 2
  const hintY = body - 2 // last inner row: a pointer to the game
  const stepRoom = innerRows - 1 - lines.length - 2 // minus hint row, blank + header
  const showSteps = stepRoom >= 3
  const shown = showSteps ? lines : lines.slice(0, Math.max(1, innerRows - 1))
  shown.forEach((segs, i) => drawSegs(cv, ix, 1 + i, segs, imax))

  if (showSteps) {
    // one shared row format so the header and the rows always line up (48 columns)
    const row = (n: string, tn: string, stop: string, out: string, inn: string, cr: string, cw: string, ms: string) =>
      `${n.padStart(3)} ${tn.padEnd(3)} ${stop.slice(0, 9).padEnd(9)} ${out.padStart(5)} ${inn.padStart(4)} ${cr.padStart(6)} ${cw.padStart(6)} ${ms.padStart(6)}`
    const hy = 1 + lines.length + 1
    cv.text(ix, hy, row('STP', 'TRN', 'STOP', 'OUT', 'IN', 'C-READ', 'C-WRIT', 'TIME'), C.dim, DEFAULT, imax)
    s.stepLog.slice(-stepRoom).forEach((st, i) => {
      const y = hy + 1 + i
      const stopColor = st.stop === 'tool_use' ? C.cyan : st.stop === 'end_turn' ? C.lime : C.text
      const text = row(String(st.n), st.label, st.stop || '—', fmtTokens(st.out), fmtTokens(st.in), fmtTokens(st.cr), fmtTokens(st.cw), fmtMs(st.ms))
      cv.text(ix, y, text, C.text, DEFAULT, imax)
      cv.text(ix, y, text.slice(0, 3), C.dim, DEFAULT, imax) // step number
      cv.text(ix + 8, y, text.slice(8, 17), stopColor, DEFAULT, imax) // stop reason
    })
  }
  if (hintY > shown.length) cv.text(ix, hintY, '2 GRID RUN · 3 SUMMARY · 4 SYSTEM', C.dim, DEFAULT, imax)
}

export function renderConsole(s: Snapshot, cols: number, rows: number): Canvas {
  const L = layout(cols, rows)
  const { H, body, wide, leftW, rw } = L
  const cv = new Canvas(cols, H)

  // ---- left column: data log, per-turn bars, tool time ----
  if (wide) {
    const big = body >= 30
    const runs = s.agentRuns ?? []
    const radarH = big && runs.length > 0 ? clamp(runs.length + 2, 4, Math.floor(body * 0.2)) : 0
    const logH = Math.floor(body * (big ? (radarH ? 0.3 : 0.4) : 0.6))
    const turnH = big ? Math.floor(body * (radarH ? 0.2 : 0.27)) : body - logH
    const toolH = body - logH - radarH - turnH

    cv.frame(0, 0, leftW, logH, { color: C.cyan, label: 'DATA LOG CONSOLE', labelColor: C.hot })
    const inner = leftW - 4
    const tail = s.log.slice(-(logH - 2))
    tail.forEach((e, i) => {
      const y = 1 + i
      const ms = e.ms > 0 ? fmtMs(e.ms) : ''
      const nameColor = !e.ok ? C.alert : e.kind === 'agent' ? C.magenta : e.kind === 'skill' ? C.lime : e.kind === 'turn' ? C.blue : C.hot
      const maxX = 2 + inner - 1
      let x = cv.text(2, y, clock(e.t), C.dim, DEFAULT, maxX)
      x = cv.text(x + 1, y, e.name.slice(0, 6).padEnd(6), nameColor, DEFAULT, maxX)
      const room = maxX - (x + 1) - (ms ? ms.length + 1 : 0) + 1
      if (room > 2) cv.text(x + 1, y, trunc(e.detail, room), C.text, DEFAULT, x + room)
      if (ms) cv.text(maxX - ms.length + 1, y, ms, C.dim)
    })
    if (tail.length === 0) cv.text(2, 1, 'no activity yet', C.dim)

    if (radarH > 0) {
      // Agent radar: one live line per subagent, with a running clock and a tick when it returns.
      cv.frame(0, logH, leftW, radarH, { color: C.cyan, label: 'AGENT RADAR', labelColor: C.hot })
      const maxX = leftW - 3
      runs.slice(-(radarH - 2)).forEach((r, i) => {
        const y = logH + 1 + i
        const running = r.t1 == null
        const dur = fmtDur((r.t1 ?? s.now) - r.t0)
        let x = cv.text(2, y, running ? '▶' : '✓', running ? C.white : C.lime)
        x = cv.text(x + 1, y, r.type.slice(0, 8).padEnd(8), running ? C.magenta : C.hot, DEFAULT, maxX)
        const room = maxX - (x + 1) - dur.length
        if (room > 2) cv.text(x + 1, y, trunc(r.desc, room), C.text, DEFAULT, x + room)
        cv.text(maxX - dur.length + 1, y, dur, running ? C.white : C.dim)
      })
    }

    if (turnH >= 4) {
      const ty = logH + radarH
      cv.frame(0, ty, leftW, turnH, { color: C.cyan, label: 'PRESENTATION DATA', labelColor: C.hot })
      const tl = s.turnLog.slice(-(turnH - 2))
      const maxOut = Math.max(1, ...tl.map((t) => t.out))
      tl.forEach((t, i) => {
        const y = ty + 1 + i
        let x = cv.text(2, y, t.label.padEnd(3), C.dim)
        x = cv.bar(x, y, 8, t.out / maxOut, C.cyan, C.deep, C.magenta)
        cv.text(x + 1, y, `${fmtTokens(t.out)} ${fmtUsd(t.usd)} ${fmtDur(t.ms)}`, C.text, DEFAULT, leftW - 3)
      })
      if (tl.length === 0) cv.text(2, ty + 1, 'no turns yet', C.dim)
    }

    if (toolH >= 5) {
      const y0 = logH + radarH + turnH
      cv.frame(0, y0, leftW, toolH, { color: C.cyan, label: 'TOOL TIME', labelColor: C.hot })
      const rowsN = toolH - 2
      const byTime = Object.entries(s.toolStats).filter(([k]) => !PLUMBING.has(k)).sort((a, b) => b[1].ms - a[1].ms).slice(0, rowsN)
      const maxMs = Math.max(1, ...byTime.map(([, v]) => v.ms))
      byTime.forEach(([k, v], i) => {
        const y = y0 + 1 + i
        let x = cv.text(2, y, k.slice(0, 8).padEnd(8), v.fail ? C.alert : C.hot)
        x = cv.bar(x, y, 10, v.ms / maxMs, v.fail ? C.alert : C.cyan, C.deep, v.fail ? C.alert : C.blue)
        cv.text(x + 1, y, `${fmtMs(v.ms)} ×${v.n}`, C.text, DEFAULT, leftW - 3)
      })
      if (byTime.length === 0) cv.text(2, y0 + 1, 'no tool calls yet', C.dim)
    }
  }

  // ---- right: the window (ledger or game) ----
  const game = s.view === 'game'
  const gl = s.game ? gameLabel(s.game) : null
  cv.frame(leftW, 0, rw, body, {
    color: C.hot, label: game ? 'GRID RUN' : 'TERMINAL//LEDGER', labelColor: C.white,
    tab: game && s.game ? `${LEVELS[s.game.level].label} ${s.game.state.toUpperCase()}` : s.working ? 'ACTIVE' : 'IDLE',
    tabColor: game && s.game ? levelColor(s.game.level) : s.working ? C.white : C.cyan, tabInset: 6, // clear of the pane's own close mark
  })
  if (game) drawGameView(cv, s, leftW, rw, body)
  else drawLedgerView(cv, s, leftW, rw, body)

  // ---- status bar: lit strip like the one under the film's terminal ----
  const vt = visibleTools(s)
  const bar = ` ${game ? '2 [grid run]' : '1 [ledger]'}  ${s.jira ?? 'NO-CARD'}  turns ${s.turns}  steps ${s.steps}  tools ${s.toolCalls}  ${fmtUsd(s.costUsd)}`
  for (let x = 0; x < cols; x++) cv.set(x, H - 1, 32, C.ink, lerp3(C.cyan, C.blue, C.magenta, x / Math.max(1, cols - 1)))
  cv.text(0, H - 1, bar, C.ink)
  const top = vt[0] ? `${vt[0][0]}×${vt[0][1].n}` : '—'
  const right = ` ${top}  T+${fmtDur(s.now - s.startedAt)} `
  cv.text(cols - right.length, H - 1, right, C.ink)
  return cv
}

// A plain-text line for surfaces that can't draw a Raster (the Desktop app).
export function plainLine(s: Snapshot): string {
  const t = s.tokens
  return `CLAUDEGRID ${s.jira ?? 'NO-CARD'} · out ${fmtTokens(t.out)} in ${fmtTokens(t.in)} cache ${fmtTokens(t.cacheRead)} · ${fmtUsd(s.costUsd)} · tools ${s.toolCalls}`
}
