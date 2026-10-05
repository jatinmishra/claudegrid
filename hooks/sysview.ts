// The SYSTEM tab: CPU, memory, temperature and the busiest processes, drawn like the other tabs.
// Pure (state in, Canvas out) so it can be tested and previewed without Claude Code.

import { Canvas, C, DEFAULT, lerp3 } from './canvas.ts'
import type { Sample } from './sysmon.ts'
import { fmtBytes, spark, topByCpu, topByMem } from './sysmon.ts'
import { clamp } from './lib.ts'

export interface SysState {
  sample: Sample | null
  cpuHist: number[]
  memHist: number[]
  tempHist: number[]
  loading: boolean
  error: string
  now: number
  everyMs: number
}

// Primary colour while there is room, then yellow, then the alert colour.
const heat = (frac: number): number => (frac >= 0.85 ? C.alert : frac >= 0.65 ? C.yellow : C.cyan)
const pct = (n: number) => `${Math.round(n)}%`
const clip = (s: string, w: number) => (s.length > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s)

// Break text into lines of at most `w` characters, on spaces.
function wrap(text: string, w: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + word).length > w) { out.push(line); line = word }
    else line = line ? line + ' ' + word : word
  }
  if (line) out.push(line)
  return out
}

// ▕█████░░░░▏ with a fill colour that follows the load.
function meter(cv: Canvas, x: number, y: number, w: number, frac: number): void {
  cv.bar(x, y, w, frac, heat(frac), C.deep, frac < 0.65 ? C.magenta : undefined)
}

// A stacked bar: each part gets its share of the width; what is left over is the empty track.
function stacked(cv: Canvas, x: number, y: number, w: number, parts: { frac: number; color: number }[]): void {
  const inner = Math.max(1, w - 2)
  cv.set(x, y, '▕'.codePointAt(0)!, C.dim)
  let at = 0
  for (const p of parts) {
    const n = Math.round(clamp(p.frac, 0, 1) * inner)
    for (let i = 0; i < n && at < inner; i++, at++) cv.set(x + 1 + at, y, '█'.codePointAt(0)!, p.color)
  }
  for (; at < inner; at++) cv.set(x + 1 + at, y, '░'.codePointAt(0)!, C.deep)
  cv.set(x + 1 + inner, y, '▏'.codePointAt(0)!, C.dim)
}

// A sparkline coloured by value.
function sparkline(cv: Canvas, x: number, y: number, w: number, values: number[], max: number): void {
  const s = spark(values, w, max)
  const tail = values.slice(-w)
  for (let i = 0; i < w; i++) {
    const v = tail[i - (w - tail.length)]
    if (v == null) continue
    cv.set(x + i, y, s.codePointAt(i)!, heat(v / max))
  }
}

// A history chart `h` rows tall: each column is one sample, filled from the bottom with block glyphs (eight levels a row).
// With one row it is a sparkline.
function areaChart(cv: Canvas, x: number, y: number, w: number, h: number, values: number[], max: number): void {
  if (h <= 1) { sparkline(cv, x, y, w, values, max); return }
  const LEVELS = ' ▁▂▃▄▅▆▇█'
  const tail = values.slice(-w)
  for (let i = 0; i < tail.length; i++) {
    const col = x + w - tail.length + i
    const eighths = clamp(Math.round((tail[i] / max) * h * 8), 0, h * 8)
    const color = heat(tail[i] / max)
    for (let r = 0; r < h; r++) {
      const fromBottom = h - 1 - r
      const level = clamp(eighths - fromBottom * 8, 0, 8)
      if (level > 0) cv.set(col, y + r, LEVELS.codePointAt(level)!, color)
    }
  }
}

function label(cv: Canvas, x: number, y: number, text: string, color: number = C.dim): number {
  return cv.text(x, y, text, color)
}

// ---------- panels ----------

function cpuPanel(cv: Canvas, s: SysState, x: number, y: number, w: number, h: number): void {
  if (w < 24 || h < 4) return
  const smp = s.sample
  cv.frame(x, y, w, h, { color: C.cyan, label: 'CPU', labelColor: C.hot })
  const ix = x + 2
  const iw = w - 4
  if (!smp?.cpu) { label(cv, ix, y + 1, smp ? 'CPU use is not available here' : 'reading …'); return }
  const c = smp.cpu
  let e = label(cv, ix, y + 1, 'USED ')
  const barW = Math.max(8, iw - 28) // leaves room for "39%" and "user 31  sys 8" after the bar
  meter(cv, e, y + 1, barW, c.total / 100)
  e = cv.text(e + barW + 1, y + 1, pct(c.total).padStart(4), heat(c.total / 100))
  cv.text(e + 1, y + 1, `user ${Math.round(c.user)}  sys ${Math.round(c.sys)}`, C.text, DEFAULT, ix + iw - 1)
  // below the bar: a history chart on whatever rows are left, then the per-core bars (or the load average)
  const inner = h - 2
  const cell = 18 // "C00 ▕████▏  88%" and a gap
  const perRow = Math.max(1, Math.floor(iw / cell))
  const coreRows = smp.perCore && smp.perCore.length > 0 ? Math.ceil(smp.perCore.length / perRow) : smp.load ? 1 : 0
  const chartH = clamp(inner - 1 - coreRows, 0, 6)
  if (chartH >= 1) {
    label(cv, ix, y + 2, 'TREND')
    areaChart(cv, ix + 6, y + 2, Math.max(4, iw - 6), chartH, s.cpuHist, 100)
  }
  const row = y + 2 + chartH
  if (smp.perCore && smp.perCore.length > 0) {
    smp.perCore.forEach((v, i) => {
      const r = row + Math.floor(i / perRow)
      if (r > y + h - 2) return
      const cx = ix + (i % perRow) * cell
      const l = cv.text(cx, r, `C${String(i).padStart(2, '0')} `, C.dim)
      meter(cv, l, r, 6, v / 100)
      cv.text(l + 7, r, pct(v).padStart(4), heat(v / 100))
    })
  } else if (smp.load && row <= y + h - 2) {
    e = label(cv, ix, row, 'LOAD ')
    e = cv.text(e, row, smp.load.map((n) => n.toFixed(2)).join('  '), C.text)
    if (smp.cores) cv.text(e + 2, row, `${smp.cores} cores`, C.dim)
  }
}

function memPanel(cv: Canvas, s: SysState, x: number, y: number, w: number, h: number): void {
  if (w < 24 || h < 4) return
  const smp = s.sample
  cv.frame(x, y, w, h, { color: C.cyan, label: 'MEMORY', labelColor: C.hot })
  const ix = x + 2
  const iw = w - 4
  if (!smp?.mem) { label(cv, ix, y + 1, smp ? 'memory is not available here' : 'reading …'); return }
  const m = smp.mem
  const frac = m.used / m.total
  const barW = Math.max(8, iw - 14)
  // segments: what is in use (split on macOS), cached files, then free
  const parts = m.app != null && m.wired != null && m.compressed != null
    ? [{ frac: m.app / m.total, color: C.cyan }, { frac: m.wired / m.total, color: C.blue }, { frac: m.compressed / m.total, color: C.magenta }, { frac: m.cached / m.total, color: C.dim }]
    : [{ frac: m.used / m.total, color: heat(frac) }, { frac: m.cached / m.total, color: C.dim }]
  stacked(cv, ix, y + 1, barW, parts)
  cv.text(ix + barW + 1, y + 1, pct(frac * 100).padStart(4), heat(frac))
  let row = y + 2
  if (row <= y + h - 2) {
    let e = label(cv, ix, row, 'USED ')
    e = cv.text(e, row, `${fmtBytes(m.used)} of ${fmtBytes(m.total)}`, C.hot)
    e = label(cv, e + 2, row, 'FREE ')
    cv.text(e, row, fmtBytes(m.free), C.text, DEFAULT, ix + iw - 1)
    row++
  }
  if (row <= y + h - 2 && m.app != null) {
    let e = cv.text(ix, row, '█', C.cyan)
    e = label(cv, e, row, ` APP ${fmtBytes(m.app)}  `, C.text)
    e = cv.text(e, row, '█', C.blue)
    e = label(cv, e, row, ` WIRED ${fmtBytes(m.wired ?? 0)}  `, C.text)
    e = cv.text(e, row, '█', C.magenta)
    cv.text(e, row, ` COMPRESSED ${fmtBytes(m.compressed ?? 0)}`, C.text, DEFAULT, ix + iw - 1)
    row++
  }
  if (row <= y + h - 2) {
    let e = label(cv, ix, row, 'SWAP ')
    e = cv.text(e, row, smp.swap && smp.swap.total > 0 ? `${fmtBytes(smp.swap.used)} of ${fmtBytes(smp.swap.total)}` : 'none', C.text)
    if (smp.pressure) {
      e = label(cv, e + 2, row, 'PRESSURE ')
      cv.text(e, row, smp.pressure, smp.pressure === 'normal' ? C.hot : smp.pressure === 'warn' ? C.yellow : C.alert)
    }
    row++
  }
  const chartH = clamp(y + h - 1 - row, 0, 6)
  if (chartH >= 1) {
    label(cv, ix, row, 'TREND')
    areaChart(cv, ix + 6, row, Math.max(4, iw - 6), chartH, s.memHist, 100)
  }
}

function tempPanel(cv: Canvas, s: SysState, x: number, y: number, w: number, h: number): void {
  if (w < 24 || h < 4) return
  const smp = s.sample
  cv.frame(x, y, w, h, { color: C.cyan, label: 'TEMPERATURE', labelColor: C.hot })
  const ix = x + 2
  const iw = w - 4
  if (!smp) { label(cv, ix, y + 1, 'reading …'); return }
  if (smp.temp) {
    const frac = smp.temp.c / 100
    const e = cv.text(ix, y + 1, `${smp.temp.c.toFixed(1)}°C`, heat(frac))
    const barW = Math.max(8, iw - 12)
    meter(cv, e + 1, y + 1, barW, frac)
    if (h >= 4) label(cv, ix, y + 2, `from ${clip(smp.temp.source, iw - 6)}`)
    const th = clamp(y + h - 1 - (y + 3), 0, 4)
    if (th >= 1) {
      label(cv, ix, y + 3, 'TREND')
      areaChart(cv, ix + 6, y + 3, Math.max(4, iw - 6), th, s.tempHist, 100)
    }
    return
  }
  // no reading: say what the machine reports instead, and why
  if (smp.thermal) {
    const t = smp.thermal
    const e = label(cv, ix, y + 1, 'THERMAL ')
    cv.text(e, y + 1, t.state === 'nominal' ? 'nominal (not slowed)' : t.state === 'throttled' ? `slowed to ${t.limit}% to cool` : 'unknown', t.state === 'throttled' ? C.alert : C.hot)
  }
  const why = wrap(smp.notes.filter((n) => /temp|thermal|sensor/i.test(n)).join(' '), iw)
  why.slice(0, Math.max(0, h - 3)).forEach((line, i) => cv.text(ix, y + 2 + i, line, C.dim, DEFAULT, ix + iw - 1))
}

function procPanel(cv: Canvas, s: SysState, x: number, y: number, w: number, h: number): void {
  if (w < 30 || h < 4) return
  cv.frame(x, y, w, h, { color: C.cyan, label: 'PROCESSES', labelColor: C.hot })
  const smp = s.sample
  const ix = x + 2
  const iw = w - 4
  if (!smp || smp.procs.length === 0) { label(cv, ix, y + 1, smp ? 'process list is not available here' : 'reading …'); return }
  const rows = h - 3
  const side = iw >= 62 // two lists side by side, else one list after the other
  const draw = (x0: number, width: number, title: string, list: typeof smp.procs, by: 'cpu' | 'mem', top: number, count: number) => {
    cv.text(x0, top, title, C.dim, DEFAULT, x0 + width - 1)
    const nameW = Math.max(6, width - 19)
    list.slice(0, count).forEach((p, i) => {
      const r = top + 1 + i
      cv.text(x0, r, String(p.pid).padStart(6), C.dim)
      cv.text(x0 + 7, r, `${p.cpu.toFixed(1)}%`.padStart(6), by === 'cpu' ? heat(p.cpu / 100) : C.text)
      cv.text(x0 + 14, r, fmtBytes(p.rssKb * 1024).padStart(5), by === 'mem' ? C.hot : C.text)
      cv.text(x0 + 20, r, clip(p.name, nameW), C.hot, DEFAULT, x0 + width - 1)
    })
  }
  if (side) {
    const half = Math.floor(iw / 2)
    draw(ix, half - 1, '   PID   CPU    MEM NAME  (top by CPU)', topByCpu(smp.procs, rows - 1), 'cpu', y + 1, rows - 1)
    draw(ix + half, iw - half, '   PID   CPU    MEM NAME  (top by memory)', topByMem(smp.procs, rows - 1).filter((p) => p.rssKb > 0), 'mem', y + 1, rows - 1)
  } else {
    const each = Math.max(1, Math.floor((rows - 2) / 2))
    draw(ix, iw, '   PID   CPU    MEM NAME  (top by CPU)', topByCpu(smp.procs, each), 'cpu', y + 1, each)
    draw(ix, iw, '   PID   CPU    MEM NAME  (top by memory)', topByMem(smp.procs, each).filter((p) => p.rssKb > 0), 'mem', y + 2 + each, each)
  }
}

// ---------- the pane ----------
export function renderSystemPane(s: SysState, cols: number, rows: number): Canvas {
  const H = Math.max(12, rows)
  const cv = new Canvas(cols, H)
  const body = H - 1
  const smp = s.sample
  const platformName = smp ? (smp.platform === 'darwin' ? 'macOS' : smp.platform === 'linux' ? 'Linux' : 'this system') : 'system'

  // headline
  cv.frame(0, 0, cols, 4, { color: C.hot, label: 'SYSTEM', labelColor: C.white, tab: `${platformName} · every ${Math.round(s.everyMs / 1000)}s`, tabColor: C.cyan, tabInset: 6 })
  if (!smp) {
    cv.text(2, 1, s.error ? `could not read the system: ${s.error}` : 'reading the system …', s.error ? C.alert : C.dim, DEFAULT, cols - 3)
  } else {
    let x = 2
    const stat = (name: string, value: string, color: number = C.hot) => {
      const e = cv.text(x, 1, name + ' ', C.dim)
      x = cv.text(e, 1, value, color, DEFAULT, cols - 3) + 2
    }
    if (smp.cpu) stat('CPU', pct(smp.cpu.total), heat(smp.cpu.total / 100))
    if (smp.mem) stat('MEM', `${pct((smp.mem.used / smp.mem.total) * 100)} (${fmtBytes(smp.mem.used)} of ${fmtBytes(smp.mem.total)})`, heat(smp.mem.used / smp.mem.total))
    if (smp.swap && smp.swap.total > 0) stat('SWAP', fmtBytes(smp.swap.used), C.text)
    if (smp.load) stat('LOAD', smp.load.map((n) => n.toFixed(2)).join(' '), C.text)
    x = 2
    const cv2 = cv
    const put = (name: string, value: string, color: number = C.hot) => { const e = cv2.text(x, 2, name + ' ', C.dim); x = cv2.text(e, 2, value, color, DEFAULT, cols - 3) + 2 }
    if (smp.temp) put('TEMP', `${smp.temp.c.toFixed(1)}°C`, heat(smp.temp.c / 100))
    else if (smp.thermal) put('THERMAL', smp.thermal.state === 'throttled' ? `slowed to ${smp.thermal.limit}%` : smp.thermal.state, smp.thermal.state === 'throttled' ? C.alert : C.hot)
    if (smp.cores) put('CORES', String(smp.cores), C.text)
    if (smp.pressure) put('PRESSURE', smp.pressure, smp.pressure === 'normal' ? C.hot : smp.pressure === 'warn' ? C.yellow : C.alert)
  }

  // panels
  const top = 4
  const areaH = body - top
  const wide = cols >= 100 && areaH >= 14
  const perCoreRows = smp?.perCore ? Math.ceil(smp.perCore.length / Math.max(1, Math.floor((Math.floor(cols * 0.55) - 4) / 16))) : 0
  if (wide) {
    const leftW = Math.floor(cols * 0.55)
    const cpuH = clamp(4 + Math.max(1, perCoreRows), 6, Math.floor(areaH * 0.5))
    cpuPanel(cv, s, 0, top, leftW, cpuH)
    memPanel(cv, s, 0, top + cpuH, leftW, Math.max(4, areaH - cpuH))
    const tempH = smp?.temp ? 8 : 7
    tempPanel(cv, s, leftW, top, cols - leftW, tempH)
    procPanel(cv, s, leftW, top + tempH, cols - leftW, Math.max(4, areaH - tempH))
  } else {
    // one column: CPU, memory, temperature, processes, each as tall as it needs and the rest dropped when short
    let y = top
    let left = areaH
    const place = (h: number, f: (y: number, h: number) => void) => { const hh = Math.min(h, left); if (hh >= 4) { f(y, hh); y += hh; left -= hh } }
    place(smp?.perCore ? 5 : 5, (yy, hh) => cpuPanel(cv, s, 0, yy, cols, hh))
    place(7, (yy, hh) => memPanel(cv, s, 0, yy, cols, hh))
    place(smp?.temp ? 8 : 7, (yy, hh) => tempPanel(cv, s, 0, yy, cols, hh))
    place(Math.max(6, left), (yy, hh) => procPanel(cv, s, 0, yy, cols, hh))
  }

  // status strip, like the other tabs
  const age = smp ? Math.max(0, Math.round((s.now - smp.at) / 1000)) : 0
  const bar = ` 4 [system]  ${platformName}  ${smp ? `sampled ${age}s ago` : 'sampling'}${s.loading ? ' …' : ''}`
  for (let x = 0; x < cols; x++) cv.set(x, H - 1, 32, C.ink, lerp3(C.cyan, C.blue, C.magenta, x / Math.max(1, cols - 1)))
  cv.text(0, H - 1, bar, C.ink)
  const right = 'read-only: nothing is saved'
  if (cols > bar.length + right.length + 2) cv.text(cols - right.length - 1, H - 1, right, C.ink)
  return cv
}

// A plain-text snapshot for the transcript (/grid system text).
export function systemText(s: SysState): string {
  const smp = s.sample
  if (!smp) return 'No reading yet: open the SYSTEM tab (/grid system) and try again.'
  const lines: string[] = [`SYSTEM · ${smp.platform}`]
  if (smp.cpu) lines.push(`cpu      ${pct(smp.cpu.total)} (user ${Math.round(smp.cpu.user)}, sys ${Math.round(smp.cpu.sys)})${smp.cores ? ` · ${smp.cores} cores` : ''}`)
  if (smp.load) lines.push(`load     ${smp.load.map((n) => n.toFixed(2)).join('  ')}`)
  if (smp.mem) {
    const m = smp.mem
    lines.push(`memory   ${fmtBytes(m.used)} of ${fmtBytes(m.total)} (${pct((m.used / m.total) * 100)}) · cached ${fmtBytes(m.cached)} · free ${fmtBytes(m.free)}`)
    if (m.app != null) lines.push(`         app ${fmtBytes(m.app)} · wired ${fmtBytes(m.wired ?? 0)} · compressed ${fmtBytes(m.compressed ?? 0)}`)
  }
  if (smp.swap) lines.push(`swap     ${smp.swap.total > 0 ? `${fmtBytes(smp.swap.used)} of ${fmtBytes(smp.swap.total)}` : 'none'}${smp.pressure ? ` · pressure ${smp.pressure}` : ''}`)
  lines.push(smp.temp ? `temp     ${smp.temp.c.toFixed(1)}°C (${smp.temp.source})` : smp.thermal ? `thermal  ${smp.thermal.state === 'throttled' ? `slowed to ${smp.thermal.limit}%` : smp.thermal.state} (no temperature reading)` : 'temp     not available (see the note below)')
  const cpuTop = topByCpu(smp.procs, 5)
  if (cpuTop.length) lines.push('top cpu  ' + cpuTop.map((p) => `${p.name} ${p.cpu.toFixed(0)}%`).join(' · '))
  const memTop = topByMem(smp.procs, 5)
  if (memTop.length) lines.push('top mem  ' + memTop.map((p) => `${p.name} ${fmtBytes(p.rssKb * 1024)}`).join(' · '))
  for (const n of smp.notes) lines.push('note     ' + n)
  return lines.join('\n')
}
