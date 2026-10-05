// The central ledger: one compact row per completed turn, kept per session in ~/.claude/claudegrid/<session>/rows.json.
// Everything here is pure (rows in, text out) so it can be tested without Claude Code.

import { fmtUsd, fmtTokens, fmtDur, fmtMs, cacheHit, trunc } from './lib.ts'

export interface ToolStat { n: number; ms: number; fail: number; est: number } // calls, wall ms, failures, estimated result tokens
export interface ModelStat { steps: number; in: number; out: number; cacheRead: number; cacheWrite: number }

export interface Row {
  v: number // 2 adds toolStats and modelStats; older rows are upgraded from their turn files when those exist
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
  toolStats?: Record<string, ToolStat> // per tool: what makes a BY TOOL table real, instead of the turn's totals repeated
  modelStats?: Record<string, ModelStat> // per model: exact tokens from each request's usage
}

const num = (v: any): number => (typeof v === 'number' && isFinite(v) ? v : 0)
const str = (v: any): string => (typeof v === 'string' ? v : '')

// Turn a saved turn record (what turn-0001.json holds) into a compact row.
export function rowFromRecord(rec: any, ctx: { session: string; project?: string; billing?: string }): Row {
  const models: Record<string, number> = {}
  const modelStats: Record<string, ModelStat> = {}
  for (const s of rec?.steps ?? []) {
    const m = str(s?.model) || 'unknown'
    models[m] = (models[m] ?? 0) + 1
    const ms = (modelStats[m] ??= { steps: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0 })
    ms.steps += 1
    ms.in += num(s?.usage?.in); ms.out += num(s?.usage?.out)
    ms.cacheRead += num(s?.usage?.cacheRead); ms.cacheWrite += num(s?.usage?.cacheWrite)
  }
  const tools: Record<string, number> = {}
  const toolStats: Record<string, ToolStat> = {}
  let toolMs = 0
  let fails = 0
  for (const t of rec?.tools ?? []) {
    const name = str(t?.name) || 'unknown'
    tools[name] = (tools[name] ?? 0) + 1
    toolMs += num(t?.wallMs)
    if (t?.ok === false) fails++
    const ts = (toolStats[name] ??= { n: 0, ms: 0, fail: 0, est: 0 })
    ts.n += 1; ts.ms += num(t?.wallMs); ts.est += num(t?.estResultTokens)
    if (t?.ok === false) ts.fail += 1
  }
  const kind: 'turn' | 'bg' = rec?.kind === 'bg' ? 'bg' : 'turn'
  const n = kind === 'turn' ? num(rec?.turn) : num(rec?.bg)
  const tot = rec?.totals ?? {}
  return {
    v: 2,
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
    toolStats, modelStats,
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
  // per-dimension figures. For tool and model rows these are the tool's or model's own; the turn totals above are not used for them.
  calls: number
  toolMs: number
  fail: number
  est: number
  reqs: number
  spawns: number
  msKnown: boolean // some turn in this group had per-tool timing (older rows only know call counts)
  tokKnown: boolean // the model's own tokens are known
}

// Multi-valued dimensions (skill, tool, agent, model) put a turn under each value it used. What is added differs by dimension:
//   tool  -> that tool's own calls, time, failures and result size (never the turn's totals)
//   model -> that model's own requests and tokens (a turn on one model attributes all of it; on two, from the per-request usage)
//   skill, agent -> the whole turn's cost and tokens ("the turns that used it"), plus the agent's own spawn count
// Everything else (card, day, project, session...) adds the turn's totals.
export function group(rows: Row[], dim: Dim): Agg[] {
  const m = new Map<string, Agg>()
  for (const r of rows) {
    for (const key of keysFor(r, dim)) {
      const a = m.get(key) ?? { key, cost: 0, turns: 0, sessions: new Set<string>(), in: 0, out: 0, cr: 0, cw: 0, tools: 0, ms: 0, first: r.at, last: r.at, calls: 0, toolMs: 0, fail: 0, est: 0, reqs: 0, spawns: 0, msKnown: false, tokKnown: false }
      a.turns += 1; a.sessions.add(r.session); a.ms += r.durationMs
      if (r.at < a.first) a.first = r.at
      if (r.at > a.last) a.last = r.at
      if (dim === 'tool') {
        const ts = r.toolStats?.[key]
        a.calls += ts?.n ?? r.tools[key] ?? 0
        if (ts) { a.toolMs += ts.ms; a.fail += ts.fail; a.est += ts.est; a.msKnown = true }
      } else if (dim === 'model') {
        const st = r.modelStats?.[key]
        const only = Object.keys(r.models).length <= 1
        if (st) { a.reqs += st.steps; a.in += st.in; a.out += st.out; a.cr += st.cacheRead; a.cw += st.cacheWrite; a.tokKnown = true }
        else if (only) { a.reqs += r.models[key] ?? 0; a.in += r.in; a.out += r.out; a.cr += r.cacheRead; a.cw += r.cacheWrite; a.tokKnown = true }
        else a.reqs += r.models[key] ?? 0 // two models in one old row: the split is unknown, so no tokens
      } else {
        a.cost += r.costUsd
        a.in += r.in; a.out += r.out; a.cr += r.cacheRead; a.cw += r.cacheWrite
        a.tools += r.toolCalls
        if (dim === 'agent') a.spawns += r.agents.filter((x) => x === key).length
      }
      m.set(key, a)
    }
  }
  const list = [...m.values()]
  const byTime = dim === 'day' || dim === 'week' || dim === 'month'
  return list.sort((x, y) => {
    if (byTime) return x.key < y.key ? 1 : -1
    if (dim === 'tool') return y.calls - x.calls || y.turns - x.turns
    if (dim === 'model') return y.out - x.out || y.reqs - x.reqs
    if (dim === 'skill' || dim === 'agent') return y.turns - x.turns || y.cost - x.cost
    return y.cost - x.cost || y.turns - x.turns
  })
}

// ---------- columns: what each kind of table shows ----------
// A table's columns depend on what it counts, so a BY TOOL table is about calls and time and a BY MODEL table about requests and tokens.
// `pane` marks the columns the narrower console panes try first (in this order, as many as fit).
export interface ColDef { id: string; head: string; w: number; get: (a: Agg) => string; pane?: boolean }

const pct = (a: Agg) => Math.round(cacheHit(a.in, a.cr, a.cw) * 100) + '%'
const MONEY: ColDef[] = [
  { id: 'cost', head: 'COST', w: 8, get: (a) => fmtUsd(a.cost), pane: true },
  { id: 'turns', head: 'TURNS', w: 5, get: (a) => String(a.turns), pane: true },
  { id: 'sess', head: 'SESS', w: 4, get: (a) => String(a.sessions.size), pane: true },
  { id: 'out', head: 'OUT', w: 7, get: (a) => fmtTokens(a.out), pane: true },
  { id: 'in', head: 'IN', w: 7, get: (a) => fmtTokens(a.in) },
  { id: 'cache', head: 'CACHE', w: 5, get: pct },
  { id: 'tools', head: 'TOOLS', w: 5, get: (a) => String(a.tools) },
  { id: 'time', head: 'TIME', w: 8, get: (a) => fmtDur(a.ms) },
  { id: 'last', head: 'LAST', w: 10, get: (a) => a.last.slice(0, 10), pane: true },
]
const TOOL: ColDef[] = [
  { id: 'calls', head: 'CALLS', w: 5, get: (a) => String(a.calls), pane: true },
  { id: 'tms', head: 'TIME', w: 7, get: (a) => (a.msKnown ? fmtMs(a.toolMs) : '—'), pane: true },
  { id: 'avg', head: 'AVG', w: 6, get: (a) => (a.msKnown && a.calls ? fmtMs(a.toolMs / a.calls) : '—'), pane: true },
  { id: 'fail', head: 'FAIL', w: 4, get: (a) => (a.msKnown ? String(a.fail) : '—'), pane: true },
  { id: 'turns', head: 'TURNS', w: 5, get: (a) => String(a.turns), pane: true },
  { id: 'sess', head: 'SESS', w: 4, get: (a) => String(a.sessions.size) },
  { id: 'est', head: 'RESULT~', w: 7, get: (a) => (a.msKnown ? fmtTokens(a.est) : '—') },
  { id: 'last', head: 'LAST', w: 10, get: (a) => a.last.slice(0, 10) },
]
const MODEL: ColDef[] = [
  { id: 'reqs', head: 'REQS', w: 5, get: (a) => String(a.reqs), pane: true },
  { id: 'out', head: 'OUT', w: 7, get: (a) => (a.tokKnown ? fmtTokens(a.out) : '—'), pane: true },
  { id: 'in', head: 'IN', w: 7, get: (a) => (a.tokKnown ? fmtTokens(a.in) : '—'), pane: true },
  { id: 'turns', head: 'TURNS', w: 5, get: (a) => String(a.turns), pane: true },
  { id: 'cr', head: 'CACHE-R', w: 8, get: (a) => (a.tokKnown ? fmtTokens(a.cr) : '—') },
  { id: 'cw', head: 'CACHE-W', w: 8, get: (a) => (a.tokKnown ? fmtTokens(a.cw) : '—') },
  { id: 'sess', head: 'SESS', w: 4, get: (a) => String(a.sessions.size) },
  { id: 'last', head: 'LAST', w: 10, get: (a) => a.last.slice(0, 10) },
]
// Skills and agents: the figures are for the whole turns that used them (marked *), so two skills in one turn each carry that turn.
const SKILL: ColDef[] = [
  { id: 'turns', head: 'USES', w: 5, get: (a) => String(a.turns), pane: true },
  { id: 'sess', head: 'SESS', w: 4, get: (a) => String(a.sessions.size), pane: true },
  { id: 'cost', head: 'COST*', w: 8, get: (a) => fmtUsd(a.cost), pane: true },
  { id: 'out', head: 'OUT*', w: 7, get: (a) => fmtTokens(a.out), pane: true },
  { id: 'last', head: 'LAST', w: 10, get: (a) => a.last.slice(0, 10) },
]
const AGENT: ColDef[] = [
  { id: 'spawns', head: 'SPAWNS', w: 6, get: (a) => String(a.spawns), pane: true },
  { id: 'turns', head: 'TURNS', w: 5, get: (a) => String(a.turns), pane: true },
  { id: 'sess', head: 'SESS', w: 4, get: (a) => String(a.sessions.size), pane: true },
  { id: 'cost', head: 'COST*', w: 8, get: (a) => fmtUsd(a.cost), pane: true },
  { id: 'last', head: 'LAST', w: 10, get: (a) => a.last.slice(0, 10) },
]

export function colsFor(dim: Dim): ColDef[] {
  return dim === 'tool' ? TOOL : dim === 'model' ? MODEL : dim === 'skill' ? SKILL : dim === 'agent' ? AGENT : MONEY
}

// What the bar next to a row measures, and its scale: calls for tools, output tokens for models, uses for skills and agents, cost otherwise.
export function barValue(a: Agg, dim: Dim): number {
  return dim === 'tool' ? a.calls : dim === 'model' ? a.out : dim === 'skill' || dim === 'agent' ? a.turns : a.cost
}

export const WHOLE_TURN_NOTE = '* cost and tokens of the whole turns that used it; a turn that used two skills (or agents) counts under both, so these rows add up to more than the total'

// ---------- text ----------
const R = (s: string, w: number) => s.padStart(w)
const L = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w))

function table(title: string, aggs: Agg[], keyLabel: string, limit: number, dim: Dim): string[] {
  if (aggs.length === 0) return []
  const cols = colsFor(dim)
  const shown = aggs.slice(0, limit)
  const kw = Math.min(28, Math.max(keyLabel.length, ...shown.map((a) => a.key.length)))
  const head = `${L(keyLabel, kw)} ${cols.map((c) => R(c.head, c.w)).join(' ')}`
  const rows = shown.map((a) => `${L(a.key, kw)} ${cols.map((c) => R(c.get(a), c.w)).join(' ')}`)
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
  let wholeTurn = false // a skill or agent table was printed: say what its cost means
  const add = (title: string, dim: Dim, keyLabel: string, limit: number, list: Agg[] = group(rows, dim)) => {
    const t = table(title, list, keyLabel, limit, dim)
    if (t.length) { lines.push('', ...t); if (dim === 'skill' || dim === 'agent') wholeTurn = true }
  }

  if (a.dim) {
    const labels: Record<Dim, string> = { card: 'CARD', day: 'DAY', week: 'WEEK OF', month: 'MONTH', model: 'MODEL', skill: 'SKILL', tool: 'TOOL', agent: 'AGENT', project: 'PROJECT', session: 'SESSION' }
    const hint: Partial<Record<Dim, string>> = {
      tool: '  (each tool\'s own calls, time and failures; RESULT~ is an estimate of tokens its results added)',
      model: '  (each model\'s own requests and tokens)',
    }
    add(`BY ${labels[a.dim]}${hint[a.dim] ?? ''}`, a.dim, labels[a.dim], 40)
  } else if (a.card) {
    // one card: where the money went
    add('SESSIONS', 'session', 'SESSION', 15, group(rows, 'session').map((s) => ({ ...s, key: s.key.slice(0, 8) })))
    add('BY DAY', 'day', 'DAY', 14)
    add('BY MODEL', 'model', 'MODEL', 8)
    add('SKILLS', 'skill', 'SKILL', 8)
    add('AGENTS', 'agent', 'AGENT', 8)
    add('TOOLS', 'tool', 'TOOL', 8)
  } else {
    add('BY CARD', 'card', 'CARD', 10)
    add('BY DAY', 'day', 'DAY', 7)
    add('BY MODEL', 'model', 'MODEL', 5)
    add('TOP SKILLS', 'skill', 'SKILL', 5)
    add('TOP AGENTS', 'agent', 'AGENT', 5)
    add('TOP TOOLS', 'tool', 'TOOL', 6)
    lines.push('', 'Drill down: /grid summary card ABC-123 · /grid summary skill 7d · /grid export')
  }
  if (wholeTurn) lines.push('', WHOLE_TURN_NOTE)
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
