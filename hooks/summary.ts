// The central ledger: one compact row per completed turn, kept per session in ~/.claude/claudegrid/<session>/rows.json.
// Everything here is pure (rows in, text out) so it can be tested without Claude Code.

import { fmtUsd, fmtTokens, fmtDur, cacheHit, trunc } from './lib.ts'

export interface Row {
  v: 1
  id: string // "<session>:<T3|B1>", unique, so a row is never counted twice
  session: string
  kind: 'turn' | 'bg'
  n: number
  at: string // when the turn ended (ISO)
  card: string | null // Jira key
  branch: string
  project: string // the folder name of the working directory
  models: Record<string, number> // model -> requests
  in: number
  out: number
  cacheRead: number
  cacheWrite: number
  steps: number
  toolCalls: number
  toolMs: number
  fails: number
  tools: Record<string, number>
  skills: string[]
  agents: string[]
  durationMs: number
  costUsd: number
  billing?: string
}

const num = (v: any): number => (typeof v === 'number' && isFinite(v) ? v : 0)
const str = (v: any): string => (typeof v === 'string' ? v : '')

// Turn a saved turn record (what turn-0001.json holds) into a compact row.
export function rowFromRecord(rec: any, ctx: { session: string; project?: string; billing?: string }): Row {
  const models: Record<string, number> = {}
  for (const s of rec?.steps ?? []) models[str(s?.model) || 'unknown'] = (models[str(s?.model) || 'unknown'] ?? 0) + 1
  const tools: Record<string, number> = {}
  let toolMs = 0
  let fails = 0
  for (const t of rec?.tools ?? []) {
    const name = str(t?.name) || 'unknown'
    tools[name] = (tools[name] ?? 0) + 1
    toolMs += num(t?.wallMs)
    if (t?.ok === false) fails++
  }
  const kind: 'turn' | 'bg' = rec?.kind === 'bg' ? 'bg' : 'turn'
  const n = kind === 'turn' ? num(rec?.turn) : num(rec?.bg)
  const tot = rec?.totals ?? {}
  return {
    v: 1,
    id: `${ctx.session}:${kind === 'turn' ? 'T' : 'B'}${n}`,
    session: ctx.session, kind, n,
    at: str(rec?.endedAt) || str(rec?.startedAt) || new Date(0).toISOString(),
    card: str(rec?.jira) || null,
    branch: str(rec?.branch),
    project: ctx.project ?? '',
    models,
    in: num(tot.in), out: num(tot.out), cacheRead: num(tot.cacheRead), cacheWrite: num(tot.cacheWrite),
    steps: (rec?.steps ?? []).length,
    toolCalls: (rec?.tools ?? []).length, toolMs, fails, tools,
    skills: (rec?.skills ?? []).map((s: any) => str(s?.name)).filter(Boolean),
    agents: (rec?.agents ?? []).map((a: any) => str(a?.type)).filter(Boolean),
    durationMs: num(rec?.durationMs),
    costUsd: num(rec?.costUsd),
    billing: ctx.billing,
  }
}

// ---------- arguments ----------
export type Dim = 'card' | 'day' | 'week' | 'month' | 'model' | 'skill' | 'tool' | 'agent' | 'project' | 'session'
const DIMS: Dim[] = ['card', 'day', 'week', 'month', 'model', 'skill', 'tool', 'agent', 'project', 'session']
const JIRA = /^[A-Za-z][A-Za-z0-9]{1,9}-\d{1,6}$/

export interface SummaryArgs {
  dim: Dim | null
  card: string | null
  days: number | null // null = all time
  label: string
  error?: string
}

// /grid summary [card|day|week|month|model|skill|tool|agent|project|session] [ABC-123] [today|7d|2w|30d|all]
export function parseSummaryArgs(text: string): SummaryArgs {
  const a: SummaryArgs = { dim: null, card: null, days: 30, label: 'last 30 days' }
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    const t = raw.toLowerCase()
    if ((DIMS as string[]).includes(t)) a.dim = t as Dim
    else if (t === 'all') { a.days = null; a.label = 'all time' }
    else if (t === 'today') { a.days = 1; a.label = 'today' }
    else if (/^\d+d$/.test(t)) { a.days = Number(t.slice(0, -1)); a.label = `last ${a.days} days` }
    else if (/^\d+w$/.test(t)) { a.days = Number(t.slice(0, -1)) * 7; a.label = `last ${a.days} days` }
    else if (JIRA.test(raw)) a.card = raw.toUpperCase()
    else a.error = `Don't know "${raw}". Try: card day week month model skill tool agent project session, a key like ABC-123, today 7d 2w 30d all.`
  }
  if (a.days === 0) a.error = 'A range of 0 days is empty.'
  return a
}

export function filterRows(rows: Row[], a: { days: number | null; card: string | null }, now: Date = new Date()): Row[] {
  let cutoff = -Infinity
  if (a.days != null) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (a.days - 1)) // local midnight, N days including today
    cutoff = d.getTime()
  }
  return rows.filter((r) => Date.parse(r.at) >= cutoff && (!a.card || r.card === a.card))
}

// ---------- grouping ----------
const pad2 = (n: number) => String(n).padStart(2, '0')
const localDay = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
const weekStart = (iso: string): string => {
  const d = new Date(iso)
  const back = (d.getDay() + 6) % 7 // Monday = 0
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back)
  return `${m.getFullYear()}-${pad2(m.getMonth() + 1)}-${pad2(m.getDate())}`
}

export function keysFor(r: Row, dim: Dim): string[] {
  switch (dim) {
    case 'card': return [r.card ?? '(no card)']
    case 'day': return [localDay(r.at)]
    case 'week': return [weekStart(r.at)]
    case 'month': return [localDay(r.at).slice(0, 7)]
    case 'model': return Object.keys(r.models).length ? Object.keys(r.models) : ['unknown']
    case 'skill': return [...new Set(r.skills)]
    case 'tool': return Object.keys(r.tools)
    case 'agent': return [...new Set(r.agents)]
    case 'project': return [r.project || '(unknown)']
    case 'session': return [r.session]
  }
}

export interface Agg {
  key: string
  cost: number
  turns: number
  sessions: Set<string>
  in: number
  out: number
  cr: number
  cw: number
  tools: number
  ms: number
  first: string
  last: string
}

// Multi-valued dimensions (skill, tool, agent, model) count a turn once under each value it used.
export function group(rows: Row[], dim: Dim): Agg[] {
  const m = new Map<string, Agg>()
  for (const r of rows) {
    for (const key of keysFor(r, dim)) {
      const a = m.get(key) ?? { key, cost: 0, turns: 0, sessions: new Set<string>(), in: 0, out: 0, cr: 0, cw: 0, tools: 0, ms: 0, first: r.at, last: r.at }
      a.cost += r.costUsd; a.turns += 1; a.sessions.add(r.session)
      a.in += r.in; a.out += r.out; a.cr += r.cacheRead; a.cw += r.cacheWrite
      a.tools += r.toolCalls; a.ms += r.durationMs
      if (r.at < a.first) a.first = r.at
      if (r.at > a.last) a.last = r.at
      m.set(key, a)
    }
  }
  const list = [...m.values()]
  const byTime = dim === 'day' || dim === 'week' || dim === 'month'
  return list.sort((x, y) => (byTime ? (x.key < y.key ? 1 : -1) : y.cost - x.cost || y.turns - x.turns))
}

// ---------- text ----------
const R = (s: string, w: number) => s.padStart(w)
const L = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w))

function table(title: string, aggs: Agg[], keyLabel: string, limit: number): string[] {
  if (aggs.length === 0) return []
  const shown = aggs.slice(0, limit)
  const kw = Math.min(28, Math.max(keyLabel.length, ...shown.map((a) => a.key.length)))
  const head = `${L(keyLabel, kw)} ${R('COST', 9)} ${R('TURNS', 5)} ${R('SESS', 4)} ${R('OUT', 7)} ${R('IN', 7)} ${R('CACHE', 5)} ${R('TOOLS', 5)} ${R('TIME', 8)}  LAST`
  const rows = shown.map((a) =>
    `${L(a.key, kw)} ${R(fmtUsd(a.cost), 9)} ${R(String(a.turns), 5)} ${R(String(a.sessions.size), 4)} ${R(fmtTokens(a.out), 7)} ${R(fmtTokens(a.in), 7)} ${R(Math.round(cacheHit(a.in, a.cr, a.cw) * 100) + '%', 5)} ${R(String(a.tools), 5)} ${R(fmtDur(a.ms), 8)}  ${a.last.slice(0, 10)}`)
  const out = [title, head, ...rows]
  if (aggs.length > limit) out.push(`… and ${aggs.length - limit} more`)
  return out
}

function headline(rows: Row[], a: SummaryArgs): string {
  const cost = rows.reduce((s, r) => s + r.costUsd, 0)
  const out = rows.reduce((s, r) => s + r.out, 0)
  const inn = rows.reduce((s, r) => s + r.in, 0)
  const cr = rows.reduce((s, r) => s + r.cacheRead, 0)
  const cw = rows.reduce((s, r) => s + r.cacheWrite, 0)
  const sessions = new Set(rows.map((r) => r.session)).size
  const tools = rows.reduce((s, r) => s + r.toolCalls, 0)
  const ms = rows.reduce((s, r) => s + r.durationMs, 0)
  return `GRID SUMMARY · ${a.label}${a.card ? ' · ' + a.card : ''} · ${sessions} sessions · ${rows.length} turns · ${fmtUsd(cost)} · out ${fmtTokens(out)} · in ${fmtTokens(inn)} · cache hit ${Math.round(cacheHit(inn, cr, cw) * 100)}% · ${tools} tool calls · ${fmtDur(ms)} of Claude time`
}

export function renderSummary(all: Row[], a: SummaryArgs, note = '', now: Date = new Date()): string {
  if (a.error) return a.error
  const rows = filterRows(all, a, now)
  if (rows.length === 0) {
    return `No ledger data for ${a.card ? a.card + ' in ' : ''}${a.label}.${note ? '\n' + note : ''}`
  }
  const lines: string[] = [headline(rows, a)]

  if (a.dim) {
    const labels: Record<Dim, string> = { card: 'CARD', day: 'DAY', week: 'WEEK OF', month: 'MONTH', model: 'MODEL', skill: 'SKILL', tool: 'TOOL', agent: 'AGENT', project: 'PROJECT', session: 'SESSION' }
    const multi = a.dim === 'skill' || a.dim === 'tool' || a.dim === 'agent' || a.dim === 'model'
    lines.push('', ...table(`BY ${labels[a.dim]}${multi ? '  (a turn counts under each one it used, so rows add up to more than the total)' : ''}`, group(rows, a.dim), labels[a.dim], 40))
  } else if (a.card) {
    // one card: where the money went
    const sessions = group(rows, 'session')
    lines.push('', ...table('SESSIONS', sessions.map((s) => ({ ...s, key: s.key.slice(0, 8) })), 'SESSION', 15))
    lines.push('', ...table('BY DAY', group(rows, 'day'), 'DAY', 14))
    lines.push('', ...table('BY MODEL', group(rows, 'model'), 'MODEL', 8))
    lines.push('', ...table('SKILLS', group(rows, 'skill'), 'SKILL', 8))
    lines.push('', ...table('AGENTS', group(rows, 'agent'), 'AGENT', 8))
    lines.push('', ...table('TOOLS', group(rows, 'tool'), 'TOOL', 8))
  } else {
    lines.push('', ...table('BY CARD', group(rows, 'card'), 'CARD', 10))
    lines.push('', ...table('BY DAY', group(rows, 'day'), 'DAY', 7))
    lines.push('', ...table('BY MODEL', group(rows, 'model'), 'MODEL', 5))
    lines.push('', ...table('TOP SKILLS', group(rows, 'skill'), 'SKILL', 5))
    lines.push('', ...table('TOP AGENTS', group(rows, 'agent'), 'AGENT', 5))
    lines.push('', ...table('TOP TOOLS', group(rows, 'tool'), 'TOOL', 6))
    lines.push('', 'Drill down: /grid summary card ABC-123 · /grid summary skill 7d · /grid export')
  }
  if (note) lines.push('', note)
  return lines.join('\n')
}

// ---------- CSV ----------
const cell = (v: unknown): string => {
  const s = String(v ?? '')
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

export function toCsv(rows: Row[]): string {
  const head = ['at', 'session', 'kind', 'turn', 'card', 'branch', 'project', 'models', 'cost_usd', 'in', 'out', 'cache_read', 'cache_write', 'steps', 'tool_calls', 'tool_ms', 'tool_failures', 'duration_ms', 'skills', 'agents', 'tools']
  const body = [...rows].sort((a, b) => (a.at < b.at ? -1 : 1)).map((r) => [
    r.at, r.session, r.kind, r.n, r.card ?? '', r.branch, r.project, Object.keys(r.models).join('|'), r.costUsd.toFixed(6),
    r.in, r.out, r.cacheRead, r.cacheWrite, r.steps, r.toolCalls, r.toolMs, r.fails, r.durationMs,
    [...new Set(r.skills)].join('|'), [...new Set(r.agents)].join('|'),
    Object.entries(r.tools).map(([k, c]) => `${k}:${c}`).join('|'),
  ].map(cell).join(','))
  return [head.join(','), ...body].join('\n') + '\n'
}

export { trunc }
