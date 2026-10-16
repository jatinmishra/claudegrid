// Parsers for the SYSTEM tab. Text in, numbers out, no Claude Code APIs: the mod collects the raw text (from `vm_stat`, `top`,
// `sysctl`, `pmset`, `ps` on macOS; /proc and /sys on Linux) and these functions turn it into a Sample.

export type Platform = 'darwin' | 'linux' | 'other'

export interface Mem {
  total: number // bytes
  used: number
  cached: number
  free: number
  app?: number // macOS: app memory, wired and compressed are what Activity Monitor adds up to "Memory Used"
  wired?: number
  compressed?: number
}
export interface CpuUse { total: number; user: number; sys: number } // percent, 0 to 100
export interface Proc { pid: number; cpu: number; rssKb: number; name: string }
export interface Thermal { state: 'nominal' | 'throttled' | 'unknown'; limit?: number } // macOS thermal pressure, not a temperature
export type Pressure = 'normal' | 'warn' | 'critical'

export interface Sample {
  at: number
  platform: Platform
  cores: number | null
  cpu: CpuUse | null
  perCore: number[] | null
  load: [number, number, number] | null
  mem: Mem | null
  swap: { total: number; used: number } | null
  pressure: Pressure | null
  thermal: Thermal | null
  procs: Proc[]
  notes: string[] // what could not be read, and why
}

const UNIT: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }

// ---------- macOS ----------

// vm_stat, with the machine's total memory. Follows Activity Monitor: Memory Used = App Memory + Wired + Compressed,
// where App Memory is anonymous pages less purgeable ones, and "cached files" are file-backed plus purgeable pages.
export function parseVmStat(text: string, totalBytes: number): Mem | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096)
  const get = (label: string): number | null => {
    const m = new RegExp(`^"?${label}"?:\\s+(\\d+)`, 'mi').exec(text)
    return m ? Number(m[1]) : null
  }
  const wired = get('Pages wired down')
  if (wired == null) return null
  const free = get('Pages free') ?? 0
  const spec = get('Pages speculative') ?? 0
  const active = get('Pages active') ?? 0
  const inactive = get('Pages inactive') ?? 0
  const purgeable = get('Pages purgeable') ?? 0
  const anon = get('Anonymous pages')
  const file = get('File-backed pages')
  const comp = get('Pages occupied by compressor') ?? 0
  const P = (n: number) => n * pageSize
  const app = anon != null ? Math.max(0, P(anon - purgeable)) : P(active)
  const total = totalBytes > 0 ? totalBytes : P(free + spec + active + inactive + wired + comp)
  const used = Math.min(total, app + P(wired) + P(comp))
  const cached = Math.min(total - used, file != null ? P(file + purgeable) : P(inactive + purgeable))
  return { total, used, cached, free: Math.max(0, total - used - cached), app, wired: P(wired), compressed: P(comp) }
}

// The last "CPU usage:" line of `top -l 2` (the first sample is an average since boot, the second is live).
export function parseTopCpu(text: string): CpuUse | null {
  const all = [...text.matchAll(/CPU usage:\s*([\d.]+)%\s*user,\s*([\d.]+)%\s*sys,\s*([\d.]+)%\s*idle/g)]
  const m = all[all.length - 1]
  if (!m) return null
  const user = Number(m[1])
  const sys = Number(m[2])
  const idle = Number(m[3])
  return { total: clamp(100 - idle, 0, 100), user, sys }
}

// "total = 3072.00M  used = 1450.25M  free = 1621.75M  (encrypted)"
export function parseSwapUsage(text: string): { total: number; used: number } | null {
  const m = /total\s*=\s*([\d.]+)([KMGT])\s+used\s*=\s*([\d.]+)([KMGT])/.exec(text)
  return m ? { total: Number(m[1]) * UNIT[m[2]], used: Number(m[3]) * UNIT[m[4]] } : null
}

// kern.memorystatus_vm_pressure_level: 1 normal, 2 warning, 4 critical
export function parsePressure(text: string): Pressure | null {
  const n = Number(text.trim())
  return n === 1 ? 'normal' : n === 2 ? 'warn' : n === 4 ? 'critical' : null
}

// `pmset -g therm` lists "CPU_Speed_Limit = 70" only when the system has been slowed to stay cool.
export function parsePmsetTherm(text: string): Thermal {
  if (!text.trim()) return { state: 'unknown' }
  const m = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(text)
  if (m && Number(m[1]) < 100) return { state: 'throttled', limit: Number(m[1]) }
  return { state: 'nominal' }
}

// ---------- Linux ----------

export function parseMeminfo(text: string): { mem: Mem; swap: { total: number; used: number } } | null {
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, 'mi').exec(text)
    return m ? Number(m[1]) * 1024 : null
  }
  const total = kb('MemTotal')
  if (total == null) return null
  const free = kb('MemFree') ?? 0
  const buffers = kb('Buffers') ?? 0
  const cachedFiles = kb('Cached') ?? 0
  const available = kb('MemAvailable') ?? free + buffers + cachedFiles
  const used = Math.max(0, total - available)
  const swapTotal = kb('SwapTotal') ?? 0
  const swapFree = kb('SwapFree') ?? 0
  return {
    mem: { total, used: Math.min(used, total), cached: Math.min(buffers + cachedFiles, Math.max(0, total - used)), free },
    swap: { total: swapTotal, used: Math.max(0, swapTotal - swapFree) },
  }
}

export interface CpuTimes { name: string; busyUser: number; busySys: number; idle: number; total: number }

// /proc/stat: one "cpu" line for the whole machine and one per core.
export function parseProcStat(text: string): CpuTimes[] {
  const out: CpuTimes[] = []
  for (const line of text.split('\n')) {
    const m = /^(cpu\d*)\s+(.+)$/.exec(line)
    if (!m) continue
    const [user, nice, sys, idle, iowait, irq, softirq, steal] = m[2].trim().split(/\s+/).map(Number)
    if (![user, nice, sys, idle].every(Number.isFinite)) continue
    const idleAll = idle + (iowait || 0)
    const sysAll = sys + (irq || 0) + (softirq || 0)
    out.push({ name: m[1], busyUser: user + nice, busySys: sysAll, idle: idleAll, total: user + nice + sysAll + idleAll + (steal || 0) })
  }
  return out
}

// Utilisation between two reads of the same counter.
export function cpuBetween(prev: CpuTimes, cur: CpuTimes): CpuUse | null {
  const dt = cur.total - prev.total
  if (dt <= 0) return null
  const idle = cur.idle - prev.idle
  return {
    total: clamp(100 * (1 - idle / dt), 0, 100),
    user: clamp((100 * (cur.busyUser - prev.busyUser)) / dt, 0, 100),
    sys: clamp((100 * (cur.busySys - prev.busySys)) / dt, 0, 100),
  }
}

// "0.12 0.20 0.18 1/234 5678" (Linux) or "{ 1.78 1.92 2.01 }" (macOS)
export function parseLoad(text: string): [number, number, number] | null {
  const n = [...text.matchAll(/\d+\.\d+/g)].map((m) => Number(m[0]))
  return n.length >= 3 ? [n[0], n[1], n[2]] : null
}

// ---------- both ----------

// `ps` with pid, %cpu, rss (KiB) and command, one process a line.
export function parsePs(text: string): Proc[] {
  const out: Proc[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.*\S)\s*$/.exec(line)
    if (!m) continue
    const name = m[4].split('/').filter(Boolean).pop() ?? m[4]
    out.push({ pid: Number(m[1]), cpu: Number(m[2]), rssKb: Number(m[3]), name })
  }
  return out
}

export const topByCpu = (p: Proc[], n: number): Proc[] => [...p].sort((a, b) => b.cpu - a.cpu).slice(0, n)
export const topByMem = (p: Proc[], n: number): Proc[] => [...p].sort((a, b) => b.rssKb - a.rssKb).slice(0, n)

export function fmtBytes(n: number): string {
  if (n < 1024 ** 2) return `${Math.round(n / 1024)}K`
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)}M`
  const g = n / 1024 ** 3
  return `${g < 10 ? g.toFixed(1) : Math.round(g)}G`
}

const SPARK = '▁▂▃▄▅▆▇█'
// A line chart in one row of block glyphs, newest on the right.
export function spark(values: number[], width: number, max = 100): string {
  const v = values.slice(-width)
  const s = v.map((x) => SPARK[clamp(Math.round((x / max) * 7), 0, 7)]).join('')
  return s.padStart(width, ' ')
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}
