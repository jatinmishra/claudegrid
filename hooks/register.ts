// claudegrid v1.3 — granular session ledger for Claude Code, drawn like a light-cycle HUD.
//
// Records per turn: prompt, Jira card, timing, every model request (model + the four token
// counts + stop reason), every tool call, skills, subagents, and cost.
// Files: ~/.claude/claudegrid/<sessionId>/turn-0001.json … and session.json.
//
// UI: a framed band above the prompt, plus `/grid` which opens the console.
// Both are drawn with a Raster (terminal only); other surfaces get a plain text line.

import {
  jiraKey, jiraKeyFromPrompt, summarizeArgs, safeLen, estTokens, mcpServer,
  fmtTokens, fmtDur, fmtMs, fmtUsd, cacheHit, trunc, clamp,
} from './lib.ts'
import { renderBand, renderConsole, plainLine, layout } from './hud.ts'
import { setTheme, nextThemeName, THEMES, T } from './canvas.ts'
import { newGame, turn as steer, step as stepGame, togglePause, restart, nextLevel, LEVELS } from './game.ts'
import { rowFromRecord, parseSummaryArgs, renderSummary, toCsv } from './summary.ts'
import { renderSummaryPane, mainAggs, RANGE_PRESETS, SVIEWS } from './summaryview.ts'
import type { SView } from './summaryview.ts'
import type { Row } from './summary.ts'
import type { Snapshot, LogEntry, StepEntry } from './hud.ts'

const SCHEMA_VERSION = 3 // the per-turn ledger files are unchanged since v0.3
const COMMANDS = ['grid', 'claudegrid', 'cgrid'] // first one Claude Code accepts wins (a clash with another mod falls through)
const PANE = 'claudegrid'
const TICK_MS = 50

const S: any = {
  inited: false,
  id: 's' + Date.now().toString(36),
  dir: '', cwd: '', branch: '', jira: null as string | null,
  startedAt: Date.now(),
  lastPrompt: '',
  turns: 0, bgCount: 0, seq: 0, dupCompletes: 0, lastActivity: Date.now(),
  active: new Set<string>(), records: {} as Record<string, any>, mainKey: '', fallback: null as any,
  lastRecord: null as any, lastFile: '', lastOrigin: '',
  paneOpen: false, paneSeen: 0, timer: null as any, tick: 0, timerTicks: 0,
  tab: 'ledger' as 'ledger' | 'game' | 'summary', game: null as any, acc: 0,
  sum: { rows: [] as Row[], loaded: false, loading: false, loadedAt: 0, note: '', view: 'overview' as SView, days: 30 as number | null, sel: 0, detailCard: null as string | null },
  totals: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, steps: 0, tools: 0, toolMs: 0, toolFail: 0 },
  models: {} as Record<string, number>,
  tools: {} as Record<string, { n: number; ms: number; fail: number; estTokens: number }>,
  skills: {} as Record<string, { n: number; chars: number }>,
  agents: {} as Record<string, { n: number; models: Record<string, number> }>,
  cost: null as any, costUsd: 0, cumBySeq: {} as Record<number, number>,
  context: null as any, rateLimits: null as any,
  log: [] as LogEntry[],
  stepLog: [] as StepEntry[],
  turnLog: [] as { label: string; out: number; ms: number; seq: number }[],
  seenFields: {} as Record<string, string[]>,
  lastError: '',
  cmd: 'grid',
  agentRuns: [] as { type: string; desc: string; t0: number; t1: number | null }[],
  acct: { usd: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, seq: 0 },
  today: 0, budget: null as number | null, logPrompts: true,
  cardLife: null as any, cardCounted: new Set<string>(), alerted: new Set<string>(),
  doneFlash: false, acctLoaded: false, usageTriedAt: 0,
  envBilling: null as null | 'api' | 'cloud', probe: {} as Record<string, any>,
  home: '', root: '', rows: [] as Row[], lastRow: null as Row | null, lastRowSeq: -1,
}

// ---------- utilities ----------
const str = (v: any): string => (typeof v === 'string' ? v : '')
const num = (v: any): number => (typeof v === 'number' && isFinite(v) ? v : 0)
const pad = (n: number): string => String(n).padStart(4, '0')
// Working = a turn is open AND something happened in the last two minutes.
const isWorking = (): boolean => S.active.size > 0 && Date.now() - S.lastActivity < 120_000
const touch = () => { S.lastActivity = Date.now() }
// The pane counts as visible if it was drawn in the last 2.5s. This does not depend on this module having
// opened it, so it still works after a hot reload (which resets module state while the pane stays open).
const paneVisible = (): boolean => Date.now() - S.paneSeen < 2500
const redraw = ($: any) => { try { $.ui.invalidate('ui.render') } catch { /* cosmetic */ } }

function seen(name: string, obj: any) {
  if (S.seenFields[name] || !obj || typeof obj !== 'object') return
  try { S.seenFields[name] = Object.keys(obj) } catch { /* ignore */ }
}

function pushLog(kind: LogEntry['kind'], name: string, detail: string, ms: number, ok: boolean) {
  S.log.push({ t: Date.now(), kind, name, detail, ms, ok })
  if (S.log.length > 80) S.log.splice(0, S.log.length - 80)
}

async function sh($: any, argv: string[]): Promise<string> {
  try {
    const r = await $.process.run(argv)
    return (typeof r === 'string' ? r : str(r?.stdout)).trim()
  } catch { return '' }
}

async function save($: any, name: string, data: unknown, compact = false) {
  if (!S.dir) return
  try { await $.fs.write(`${S.dir}/${name}`, compact ? JSON.stringify(data) : JSON.stringify(data, null, 2)) }
  catch (err) { S.lastError = `write ${name}: ${String(err)}` }
}

const costFor = (seq: number): number =>
  Math.max(0, (S.cumBySeq[seq] ?? S.cumBySeq[seq - 1] ?? 0) - (S.cumBySeq[seq - 1] ?? 0))

function rate(kind: string): number | null {
  const r = Array.isArray(S.rateLimits) ? S.rateLimits.find((x: any) => x?.kind === kind) : null
  return r && typeof r.percentUsed === 'number' ? r.percentUsed : null
}

// How far through a limit window we are (drawn as a marker on the bar).
const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 86_400_000 }
function limit(kind: string): { pct: number; elapsed: number; resetsAt: string } | null {
  const r = Array.isArray(S.rateLimits) ? S.rateLimits.find((x: any) => x?.kind === kind) : null
  if (!r || typeof r.percentUsed !== 'number') return null
  const reset = Date.parse(str(r.resetsAt))
  const win = WINDOW_MS[kind]
  const elapsed = isFinite(reset) && win ? clamp(1 - (reset - Date.now()) / win, 0, 1) : 0
  return { pct: r.percentUsed, elapsed, resetsAt: str(r.resetsAt) }
}

// Read cost, context and plan limits from the session. session.measure only fires after a turn, so without
// this the limits would show dashes until the first turn finishes.
async function refreshUsage($: any): Promise<boolean> {
  S.usageTriedAt = Date.now()
  try {
    const u = await $.session.usage()
    seen('session.usage', u)
    S.cost = u?.cost ?? S.cost
    S.costUsd = num(u?.cost?.usd) || S.costUsd
    S.context = u?.context ?? S.context
    if (Array.isArray(u?.rateLimits)) S.rateLimits = u.rateLimits
    return true
  } catch (err) {
    S.lastError = `usage: ${String(err)}`
    return false
  }
}

// Called from the draw hooks: if the limits still haven't loaded, fetch them now (at most every 5 seconds).
function ensureUsage($: any) {
  if (S.rateLimits || Date.now() - S.usageTriedAt < 5000) return
  refreshUsage($).then(() => redraw($)).catch(() => {})
}

// How is this session billed? That decides what the cost figure means.
//  - ANTHROPIC_API_KEY set  -> Claude Code bills the API with it (so COST is real money)
//  - Bedrock / Vertex flags -> billed by the cloud provider
//  - otherwise, 5h/7d limits present -> a subscription login (COST is an API-equivalent estimate, shown as COST~)
// $.env.get returns the value, so the mod only tests whether it is non-empty and discards it: it is never
// stored, logged, written to a file, or shown.
async function detectEnvBilling($: any) {
  // Claude Code's validator wants a literal variable name at every $.env.get call, so each one is spelled out.
  const set = (v: unknown): boolean => typeof v === 'string' && v.length > 0
  let bedrock = false
  let vertex = false
  let key = false
  try { bedrock = set(await $.env.get('CLAUDE_CODE_USE_BEDROCK')) } catch { /* not set */ }
  try { vertex = set(await $.env.get('CLAUDE_CODE_USE_VERTEX')) } catch { /* not set */ }
  try { key = set(await $.env.get('ANTHROPIC_API_KEY')) } catch { /* not set */ }
  if (bedrock || vertex) S.envBilling = 'cloud'
  else if (key) S.envBilling = 'api'
}
const billingMode = (): 'subscription' | 'api' | 'cloud' | 'unknown' =>
  S.envBilling ?? (Array.isArray(S.rateLimits) && S.rateLimits.length ? 'subscription' : 'unknown')
const billingNote = (): string => ({
  subscription: 'subscription login (5h/7d limits present): COST~ is an API-equivalent estimate, not what you pay',
  api: 'ANTHROPIC_API_KEY is set: Claude Code bills the API, so COST is real charges',
  cloud: 'Bedrock/Vertex is enabled: billed by your cloud provider, so COST is real charges',
  unknown: 'could not tell (no plan limits and no API key found): COST is Claude Code\'s own figure',
})[billingMode()]

// A one-off look at what else this Claude Code build exposes to a mod, in case it names the plan.
// It records the SHAPE only (key names, row names, a few short harmless values), never settings values.
async function probeApi($: any) {
  const shape = (v: any): any => {
    if (Array.isArray(v)) {
      const first = v[0]
      const rowNames = v.map((r: any) => (r && typeof r === 'object' ? str(r.key) || str(r.label) || str(r.id) || str(r.name) : '')).filter(Boolean).slice(0, 80)
      return { type: 'array', length: v.length, itemKeys: first && typeof first === 'object' ? Object.keys(first).slice(0, 30) : typeof first, rowNames }
    }
    if (v && typeof v === 'object') return { type: 'object', keys: Object.keys(v).slice(0, 80) }
    return { type: typeof v }
  }
  const tryCall = async (name: string, fn: () => any, keepValue = false) => {
    try {
      const v = await fn()
      S.probe[name] = keepValue && (typeof v === 'string' || Array.isArray(v)) ? { value: Array.isArray(v) ? v.slice(0, 10) : v.slice(0, 40) } : shape(v)
    } catch (err) { S.probe[name] = { error: String(err).slice(0, 120) } }
  }
  await tryCall('settings.read', () => $.settings.read())
  await tryCall('config.list', () => $.config.list())
  await tryCall('session.version', () => $.session.version(), true)
  await tryCall('session.surfaces', () => $.session.surfaces(), true)
  await tryCall('session.model', () => $.session.model(), true)
  // names anywhere in what we saw that look plan-related
  const names: string[] = []
  const walk = (o: any) => {
    if (Array.isArray(o)) o.forEach(walk)
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { names.push(k); walk(v) }
    else if (typeof o === 'string') names.push(o)
  }
  walk(S.probe)
  walk(S.seenFields)
  S.probe.planHints = [...new Set(names.filter((n) => /plan|subscri|tier|account|billing|seat|org|oauth|login/i.test(n)))].slice(0, 30)
}

const toast = async ($: any, msg: string) => { try { await $.ui.toast(msg) } catch { /* cosmetic */ } }
const storeGet = async ($: any, k: string): Promise<any> => { try { return await $.store.get(k) } catch { return undefined } }
const storeSet = async ($: any, k: string, v: any) => {
  try { await $.store.set(k, v) } catch (err) { S.lastError = `store ${k}: ${String(err)}` }
}
const dayKey = (): string => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `day:${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// Cross-session books, kept in $.store: spend per day, and tokens/cost per Jira card.
// Called after each turn with the change since the last call, so nothing is counted twice.
async function account($: any) {
  if (!S.acctLoaded) {
    // After a hot reload this module's state starts from zero but the session's cost does not. The cost
    // already booked is remembered per session, so a reload can't count it twice. (Tokens are counted
    // from what this module instance has seen, so they start from zero either way.)
    S.acctLoaded = true
    const saved = await storeGet($, 'acct:' + S.id)
    if (saved && typeof saved.usd === 'number') S.acct.usd = saved.usd
  }
  const t = S.totals
  const d = {
    usd: Math.max(0, S.costUsd - S.acct.usd), in: t.in - S.acct.in, out: t.out - S.acct.out,
    cacheRead: t.cacheRead - S.acct.cacheRead, cacheWrite: t.cacheWrite - S.acct.cacheWrite, turns: S.seq - S.acct.seq,
  }
  if (!d.usd && !d.in && !d.out && !d.cacheRead && !d.cacheWrite && !d.turns) return
  S.acct = { usd: S.costUsd, in: t.in, out: t.out, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, seq: S.seq }
  await storeSet($, 'acct:' + S.id, { usd: S.costUsd })

  const dk = dayKey()
  const day = (await storeGet($, dk)) ?? { usd: 0 }
  day.usd = (day.usd ?? 0) + d.usd
  await storeSet($, dk, day)
  S.today = day.usd

  if (S.jira) {
    const ck = 'card:' + S.jira
    const c = (await storeGet($, ck)) ?? { usd: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, turns: 0, sessions: 0, firstAt: new Date().toISOString() }
    c.usd += d.usd; c.in += d.in; c.out += d.out; c.cacheRead += d.cacheRead; c.cacheWrite += d.cacheWrite; c.turns += d.turns
    if (!S.cardCounted.has(ck)) { S.cardCounted.add(ck); c.sessions += 1 }
    c.lastAt = new Date().toISOString()
    await storeSet($, ck, c)
    S.cardLife = c
  }
}

// One toast per threshold per window: limits at 80% and 90%, and the daily budget.
async function alerts($: any) {
  const once = async (key: string, msg: string) => { if (!S.alerted.has(key)) { S.alerted.add(key); await toast($, msg) } }
  for (const [kind, name] of [['five_hour', '5-hour'], ['seven_day', '7-day']] as const) {
    const l = limit(kind)
    if (!l) continue
    for (const th of [80, 90]) if (l.pct >= th) await once(`${kind}:${th}:${l.resetsAt}`, `${name} limit at ${Math.round(l.pct)}%`)
  }
  if (S.budget && S.today >= S.budget * 0.8) await once(`budget80:${dayKey()}`, `Daily budget 80% used (${fmtUsd(S.today)} of ${fmtUsd(S.budget)})`)
  if (S.budget && S.today >= S.budget) await once(`budget100:${dayKey()}`, `Daily budget reached (${fmtUsd(S.today)})`)
}

function snapshot(): Snapshot {
  const lastSeq = S.turnLog.length ? S.turnLog[S.turnLog.length - 1].seq : 0
  return {
    id: S.id, jira: S.jira, branch: S.branch, working: isWorking(), now: Date.now(), startedAt: S.startedAt,
    turns: S.turns, steps: S.totals.steps, toolCalls: S.totals.tools, toolFail: S.totals.toolFail,
    tokens: { in: S.totals.in, out: S.totals.out, cacheRead: S.totals.cacheRead, cacheWrite: S.totals.cacheWrite },
    costUsd: S.costUsd, turnCostUsd: costFor(lastSeq),
    models: S.models, toolStats: S.tools, skills: S.skills, agents: S.agents,
    ctxPct: num(S.context?.percent), fiveHour: rate('five_hour'), sevenDay: rate('seven_day'),
    log: S.log, stepLog: S.stepLog,
    turnLog: S.turnLog.map((t: any) => ({ label: t.label, out: t.out, ms: t.ms, usd: costFor(t.seq) })),
    fiveHourElapsed: limit('five_hour')?.elapsed ?? null, sevenDayElapsed: limit('seven_day')?.elapsed ?? null,
    todayUsd: S.today, budgetUsd: S.budget,
    cardLife: S.cardLife ? { usd: S.cardLife.usd, out: S.cardLife.out, turns: S.cardLife.turns, sessions: S.cardLife.sessions } : null,
    agentRuns: S.agentRuns.slice(-8), claudeDone: S.doneFlash, costMode: billingMode(),
  }
}

function sessionSummary() {
  return {
    schemaVersion: SCHEMA_VERSION, sessionId: S.id, cwd: S.cwd, branch: S.branch, jira: S.jira,
    startedAt: new Date(S.startedAt).toISOString(), elapsedMs: Date.now() - S.startedAt, turns: S.turns,
    totals: S.totals, models: S.models, tools: S.tools, skills: S.skills, agents: S.agents,
    cost: S.cost, records: S.turnLog.map((t: any) => ({ label: t.label, out: t.out, ms: t.ms, costUsd: costFor(t.seq) })),
    context: S.context, rateLimits: S.rateLimits, duplicateCompletes: S.dupCompletes, billing: billingMode(), probe: S.probe, seenFields: S.seenFields, lastError: S.lastError || undefined,
  }
}

// A record is one turn.start..turn.complete span. Records are keyed by turnId so a background
// subagent's turn (or a turn that completes twice) never overwrites the main one.
function newRecord(kind: 'turn' | 'bg', turnId: any, key?: string) {
  const rec: any = {
    schemaVersion: SCHEMA_VERSION, sessionId: S.id, kind,
    turn: kind === 'turn' ? S.turns : null, bg: kind === 'bg' ? ++S.bgCount : null,
    turnId: turnId ?? null, prompt: '', origin: null, jira: S.jira, branch: S.branch,
    startedAt: new Date().toISOString(), t0: Date.now(), steps: [], tools: [], skills: [], agents: [],
  }
  if (key) S.records[key] = rec
  return rec
}

const label = (rec: any): string => (rec.kind === 'turn' ? 'T' + rec.turn : 'B' + rec.bg)

// The record tool/skill/agent events attach to (they carry no turnId): the latest started turn.
function mainRec() {
  return (S.mainKey && S.records[S.mainKey]) || (S.fallback ??= newRecord('bg', null))
}

function recFor(turnId: any) {
  if (turnId == null) return mainRec()
  return S.records[String(turnId)] ?? newRecord('bg', turnId, String(turnId))
}

// "<agent-message …>" and similar system prompts are noise in a log; say what they are.
function cleanPrompt(raw: string): string {
  const t = raw.trim()
  if (t.startsWith('<')) {
    const inner = t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    return inner ? 'system: ' + trunc(inner, 80) : 'system message'
  }
  return trunc(t, 200)
}

// ---------- the central ledger ----------
// Each session keeps rows.json: one compact row per completed turn. A summary reads every session's rows.json
// from ~/.claude/claudegrid/, so nothing is shared between running sessions and nothing can be overwritten by another.
const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? ''

async function readJson($: any, path: string): Promise<any> {
  try {
    const r = await $.fs.read(path)
    const t = typeof r === 'string' ? r : str(r?.content) || str(r?.text)
    return t ? JSON.parse(t) : null
  } catch { return null }
}

function pushRow(rec: any): Row {
  const row = rowFromRecord(rec, { session: S.id, project: baseName(S.cwd), billing: billingMode() })
  const i = S.rows.findIndex((r: Row) => r.id === row.id)
  if (i >= 0) S.rows[i] = row
  else S.rows.push(row)
  return row
}

// After a hot reload this module starts empty while the session's files do not. Pick the numbering and the
// running totals back up from rows.json, so turn files are never overwritten and the HUD doesn't drop to zero.
async function restoreOwnRows($: any) {
  if (!S.dir) return
  const rows = await readJson($, `${S.dir}/rows.json`)
  if (!Array.isArray(rows) || rows.length === 0) return
  S.rows = rows.filter((r: any) => r && r.id)
  for (const r of S.rows as Row[]) {
    if (r.kind === 'turn') S.turns = Math.max(S.turns, r.n)
    else S.bgCount = Math.max(S.bgCount, r.n)
    S.totals.in += r.in; S.totals.out += r.out; S.totals.cacheRead += r.cacheRead; S.totals.cacheWrite += r.cacheWrite
    S.totals.steps += r.steps; S.totals.tools += r.toolCalls; S.totals.toolMs += r.toolMs; S.totals.toolFail += r.fails
    for (const [m, c] of Object.entries(r.models)) S.models[m] = (S.models[m] ?? 0) + c
    for (const [name, c] of Object.entries(r.tools)) {
      const t = (S.tools[name] ??= { n: 0, ms: 0, fail: 0, estTokens: 0 })
      t.n += c
    }
    for (const k of r.skills) (S.skills[k] ??= { n: 0, chars: 0 }).n += 1
    for (const a of r.agents) (S.agents[a] ??= { n: 0, models: {} }).n += 1
  }
  S.seq = S.rows.length
  S.acct = { ...S.acct, in: S.totals.in, out: S.totals.out, cacheRead: S.totals.cacheRead, cacheWrite: S.totals.cacheWrite, seq: S.seq }
}

const isDir = (e: any): boolean => !str(e?.name).startsWith('.') && (/dir/i.test(str(e?.kind)) || (!str(e?.kind) && !str(e?.name).includes('.')))

// Sessions recorded before rows.json existed: rebuild their rows from the per-turn files (once; the result is cached).
async function backfill($: any, base: string, session: string): Promise<Row[]> {
  let files: any[] = []
  try { files = await $.fs.list(base) } catch { return [] }
  const project = baseName(str((await readJson($, `${base}/session.json`))?.cwd))
  const out: Row[] = []
  for (const f of files) {
    if (!/^(turn|bg)-\d+\.json$/.test(str(f?.name))) continue
    const rec = await readJson($, `${base}/${f.name}`)
    if (rec && rec.endedAt) out.push(rowFromRecord(rec, { session: str(rec.sessionId) || session, project }))
  }
  return out
}

async function loadAllRows($: any): Promise<{ rows: Row[]; note: string }> {
  const CAP = 800
  const seen = new Set<string>()
  const rows: Row[] = []
  const add = (list: Row[]) => { for (const r of list) if (r && r.id && !seen.has(r.id)) { seen.add(r.id); rows.push(r) } }
  let entries: any[] = []
  try { entries = await $.fs.list(S.root) } catch (err) { return { rows: S.rows.slice(), note: `Could not read ${S.root}: ${String(err)}` } }
  const dirs = entries.filter(isDir).map((e: any) => str(e.name))
  let backfilled = 0
  for (const name of dirs.slice(0, CAP)) {
    if (name === S.id) continue
    const base = `${S.root}/${name}`
    let list = await readJson($, `${base}/rows.json`)
    if (!Array.isArray(list)) {
      list = await backfill($, base, name)
      if (list.length) {
        backfilled++
        try { await $.fs.write(`${base}/rows.json`, JSON.stringify(list)) } catch { /* cache only */ }
      }
    }
    add(list)
  }
  add(S.rows) // this session, live
  const notes: string[] = [`${new Set(rows.map((r) => r.session)).size} sessions in ${S.root}`]
  if (dirs.length > CAP) notes.push(`only the first ${CAP} of ${dirs.length} session folders were read`)
  if (backfilled) notes.push(`${backfilled} older sessions were rebuilt from their turn files`)
  return { rows, note: notes.join(' · ') }
}

async function loadSummary($: any) {
  if (S.sum.loading) return
  S.sum.loading = true
  redraw($)
  try {
    const { rows, note } = await loadAllRows($)
    S.sum.rows = rows
    S.sum.note = note
    S.sum.loaded = true
    S.sum.loadedAt = Date.now()
  } catch (err) { S.lastError = `summary: ${String(err)}` } finally {
    S.sum.loading = false
    redraw($)
  }
}

async function exportCsv($: any, target: string): Promise<string> {
  if (!S.root) return 'The ledger folder is unavailable (no home directory found).'
  const { rows, note } = await loadAllRows($)
  const path = (target || `${S.root}/claudegrid.csv`).replace(/^~(?=[\\/])/, S.home)
  let csv = toCsv(rows)
  let kept = rows.length
  if (csv.length > 3_900_000) { // the file API stops at 4 MiB: keep the newest turns
    const newest = [...rows].sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, Math.floor(rows.length * (3_800_000 / csv.length)))
    csv = toCsv(newest); kept = newest.length
  }
  try { await $.fs.write(path, csv) } catch (err) { return `Could not write ${path}: ${String(err)}` }
  return `Wrote ${kept} turns${kept < rows.length ? ` (the newest; ${rows.length} exist)` : ''} to ${path}\n${note}`
}

async function openPane($: any): Promise<boolean> {
  try {
    await refreshUsage($)
    await $.ui.open({ id: PANE, title: 'ClaudeGrid', focus: true, closeOnEscape: true })
    S.paneOpen = true
    return true
  } catch (err) { S.lastError = `open pane: ${String(err)}`; return false }
}

// ---------- recorders ----------
function addStep(e: any, result: any, ms: number) {
  const cur = recFor(e?.turnId)
  const u = result?.usage ?? {}
  const model = str(u?.model) || str(result?.model) || str(e?.model) || 'unknown'
  const usage = {
    in: num(u.input_tokens), out: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens),
  }
  cur.steps.push({
    i: cur.steps.length, index: e?.index ?? null, model, effort: e?.effort ?? null,
    messageCount: e?.messageCount ?? null, stopReason: result?.stopReason ?? null,
    toolUses: Array.isArray(result?.toolUses) ? result.toolUses.length : num(result?.toolUses),
    ms, usage,
  })
  S.totals.in += usage.in; S.totals.out += usage.out
  S.totals.cacheRead += usage.cacheRead; S.totals.cacheWrite += usage.cacheWrite
  S.totals.steps += 1
  S.models[model] = (S.models[model] ?? 0) + 1
  const last = cur.steps[cur.steps.length - 1]
  S.stepLog.push({ n: S.totals.steps, label: label(cur), stop: str(last.stopReason), out: usage.out, in: usage.in, cr: usage.cacheRead, cw: usage.cacheWrite, ms, tools: last.toolUses })
  if (S.stepLog.length > 120) S.stepLog.splice(0, S.stepLog.length - 120)
}

function skillName(e: any): string {
  return str(e?.skill) || str(e?.name) || str(e?.skillName) || str(e?.input?.skill) || str(e?.command) || str(e?.args) || 'unknown'
}

function addSkill(cur: any, name: string, via: 'tool' | 'prompt', chars: number) {
  if (cur.skills.some((s: any) => s.name === name)) return // the Skill tool and skill.prompt can both fire
  cur.skills.push({ name, via, step: cur.steps.length, expansionChars: chars })
  const s = (S.skills[name] ??= { n: 0, chars: 0 })
  s.n += 1
  s.chars += chars
  pushLog('skill', 'SKILL', name, 0, true)
}

function addTool(e: any, result: any, ms: number, ok: boolean): { type: string; ms: number } | null {
  const cur = mainRec()
  const name = str(e?.tool) || 'unknown'
  const resultChars = safeLen(result?.result ?? result)
  const est = estTokens(resultChars)
  const server = mcpServer(name)
  const isAgentPlumbing = name === 'Agent' || name === 'SubagentHandback'
  const args = summarizeArgs(e)
  cur.tools.push({
    i: cur.tools.length, step: Math.max(0, cur.steps.length - 1), name,
    source: server ? 'mcp' : isAgentPlumbing ? 'agent' : 'builtin', mcpServer: server,
    toolUseId: e?.tool_use_id ?? null, args,
    wallMs: ms, // includes any permission-prompt wait
    ok, resultChars, estResultTokens: est, // ESTIMATE, not an API number
  })
  const t = (S.tools[name] ??= { n: 0, ms: 0, fail: 0, estTokens: 0 })
  t.n += 1; t.ms += ms; t.estTokens += est
  if (!ok) t.fail += 1
  S.totals.tools += 1; S.totals.toolMs += ms
  if (!ok) S.totals.toolFail += 1
  // Skill/Agent get their own log rows (SKILL, AGENT); don't log the plumbing twice.
  if (name === 'SubagentHandback') pushLog('agent', 'AGENT', 'returned', ms, ok)
  else if (name !== 'Skill' && name !== 'Agent') pushLog('tool', name, args || str(e?.description), ms, ok)
  if (name === 'Skill') addSkill(cur, skillName(e), 'tool', 0)
  // A handback means the oldest still-running subagent has returned (the event carries no agent id).
  if (name === 'SubagentHandback') {
    const run = S.agentRuns.find((r: any) => r.t1 == null)
    if (run) { run.t1 = Date.now(); return { type: run.type, ms: run.t1 - run.t0 } }
  }
  return null
}

// ---------- text views ----------
function cardLine(key: string, c: any): string {
  return `${key.padEnd(14)} ${fmtUsd(c.usd).padStart(8)} · out ${fmtTokens(c.out)} · in ${fmtTokens(c.in)} · cache r ${fmtTokens(c.cacheRead)} w ${fmtTokens(c.cacheWrite)} · ${c.turns} turns · ${c.sessions} sessions · last ${str(c.lastAt).slice(0, 10)}`
}

function helpText(): string {
  const c = '/' + S.cmd
  return [
    'CLAUDEGRID',
    `${c}                open the console (1 ledger, 2 GRID RUN, 3 SUMMARY, t theme; Esc closes)`,
    `${c} text           session summary in the transcript`,
    `${c} tools|skills|agents|turn N`,
    `${c} summary [card|day|week|month|model|skill|tool|agent|project|session] [ABC-123] [today|7d|30d|all]`,
    `                    the SUMMARY tab: metrics across ALL your sessions (default: last 30 days)`,
    `${c} summary text [...]  the same, printed in the transcript`,
    `${c} card [KEY]     one Jira card across every session, all time (default: this session's)`,
    `${c} cards          every card by cost`,
    `${c} export [path]  every turn as CSV (default ~/.claude/claudegrid/claudegrid.csv)`,
    `${c} today          spend today, across sessions`,
    `${c} budget N|off   daily budget in USD; toasts at 80% and 100%`,
    `${c} theme [soft|neon]`,
    `${c} prompts on|off save prompt text in the ledger files`,
    `${c} billing       how this session is billed, and what COST means`,
    `${c} probe         what else this build exposes to a mod (shape only)`,
  ].join('\n')
}
const topTools = (n = 8) => Object.entries(S.tools as Record<string, any>).sort((a, b) => b[1].n - a[1].n).slice(0, n)

function view(arg: string): string {
  const t = S.totals
  const hit = Math.round(cacheHit(t.in, t.cacheRead, t.cacheWrite) * 100)
  const parts = arg.trim().split(/\s+/)
  const sub = parts[0] || ''
  if (sub === 'tools') {
    const rows = topTools(20).map(([k, v]: any) =>
      `${k.padEnd(26)} ×${String(v.n).padStart(3)}  ${fmtDur(v.ms)}  ~${fmtTokens(v.estTokens)} tok result${v.fail ? `  ✗${v.fail}` : ''}`)
    return ['TOOLS (time includes permission waits; tokens estimated)', ...(rows.length ? rows : ['none yet'])].join('\n')
  }
  if (sub === 'skills') {
    const rows = Object.entries(S.skills as Record<string, any>).map(([k, v]: any) => `${k.padEnd(26)} ×${v.n}`)
    return ['SKILLS', ...(rows.length ? rows : ['none yet'])].join('\n')
  }
  if (sub === 'agents') {
    const rows = S.agentRuns.map((r: any) =>
      `${r.t1 == null ? '▶ running' : '✓ done   '}  ${r.type.padEnd(14)} ${fmtDur((r.t1 ?? Date.now()) - r.t0)}  ${trunc(r.desc, 50)}`)
    return ['AGENTS (a subagent counts as done when its handback arrives)', ...(rows.length ? rows : ['none yet'])].join('\n')
  }
  if (sub === 'turn') {
    const n = Number(parts[1])
    return n ? `Turn ${n}: open ${S.dir}/turn-${pad(n)}.json` : `Usage: /${S.cmd} turn <number>`
  }
  const lines = [
    `CLAUDEGRID  session ${S.id}  ${S.jira ?? 'no card'}  ${S.branch || 'no branch'}`,
    `elapsed ${fmtDur(Date.now() - S.startedAt)} · turns ${S.turns} · requests ${t.steps} · tool calls ${t.tools} (${t.toolFail} failed) · ${fmtUsd(S.costUsd)}`,
    `tokens   in ${fmtTokens(t.in)} · out ${fmtTokens(t.out)} · cache read ${fmtTokens(t.cacheRead)} · cache write ${fmtTokens(t.cacheWrite)} · hit ${hit}%`,
    `models   ${Object.entries(S.models).map(([m, c]) => `${m}×${c}`).join('  ') || 'none yet'}`,
    `top tools ${topTools(5).map(([k, v]: any) => `${k}×${v.n}`).join('  ') || 'none yet'}`,
    `skills   ${Object.keys(S.skills).join(', ') || 'none'}`,
    `agents   ${Object.keys(S.agents).join(', ') || 'none'}`,
    `files    ${S.dir || '(no HOME; not writing)'}`,
  ]
  lines.push(`theme    ${THEMES[T.name].label}`)
  lines.push(`game     ${S.game ? S.game.level + ' ' + S.game.state : 'none'} · tab ${S.tab} · moves ${S.game ? S.game.ticks : 0} · timer ticks ${S.timerTicks} · pane drawn ${S.paneSeen ? Math.round((Date.now() - S.paneSeen) / 1000) + 's ago' : 'never'}`)
  if (S.lastError) lines.push(`last error: ${S.lastError}`)
  lines.push(`try: /${S.cmd} help`)
  return lines.join('\n')
}

// ---------- the mod ----------
export function register(on: any, _options: any) {
  on('session.start', async ($: any, e: any, next: any) => {
    if (!S.inited) {
      S.inited = true
      try { const id = str(await $.session.id()); if (id) S.id = id } catch { /* keep fallback */ }
      try { S.cwd = str(await $.session.cwd()) } catch { /* ignore */ }
      const home = str(await $.env.get('HOME')) || str(await $.env.get('USERPROFILE'))
      if (home) {
        S.home = home
        S.root = `${home}/.claude/claudegrid`
        S.dir = `${S.root}/${S.id}`
        await sh($, ['mkdir', '-p', S.dir])
        await restoreOwnRows($)
      }
      S.branch = await sh($, ['git', 'branch', '--show-current'])
      S.jira = jiraKey(S.branch, null)
    }
    try {
      const saved = str(await $.store.get('theme2')) // new key: an older saved choice must not force the bold theme
      if (saved && saved !== T.name) setTheme(saved)
    } catch { /* first run: keep the default */ }
    await refreshUsage($)
    await detectEnvBilling($)
    await probeApi($)
    if (!S.acctLoaded) {
      // Spend already in this session (a resumed one, or a mod installed mid-session) must not count as new.
      S.acctLoaded = true
      const saved = await storeGet($, 'acct:' + S.id)
      S.acct.usd = typeof saved?.usd === 'number' ? saved.usd : S.costUsd
      await storeSet($, 'acct:' + S.id, { usd: S.acct.usd })
      S.cumBySeq[S.seq] = S.costUsd // this turn's cost is measured from here, not from zero
    }
    {
      const b = await storeGet($, 'budget')
      S.budget = typeof b === 'number' && b > 0 ? b : null
      S.logPrompts = (await storeGet($, 'logPrompts')) !== false
      const day = await storeGet($, dayKey())
      S.today = day?.usd ?? 0
      if (S.jira) S.cardLife = (await storeGet($, 'card:' + S.jira)) ?? null
    }
    // The first command name Claude Code accepts wins, so a clash with another mod can't stop the rest of start-up.
    for (const name of COMMANDS) {
      try {
        await $.command.register({
          name,
          description: 'Open the ClaudeGrid console: ledger, agent radar, light cycles (/' + name + ' help)',
          argumentHint: '[help | text | tools | skills | agents | turn N | card [KEY] | cards | today | budget N | theme | prompts on|off]',
          immediate: true,
        })
        S.cmd = name
        break
      } catch (err) { S.lastError = `register /${name}: ${String(err)}` }
    }
    // One 50ms loop: moves the light cycles at the level's speed while the game runs; otherwise it only keeps
    // the HUD fresh (every 100ms while working or while the console is open, once a second at rest).
    if (!S.timer) {
      try {
        S.timer = $.clock.every(TICK_MS, () => {
          S.tick += 1
          S.timerTicks += 1
          const visible = paneVisible()
          if (visible && S.tick % 1200 === 0) refreshUsage($).catch(() => {})
          if (visible && S.tab === 'summary' && S.sum.loaded && !S.sum.loading && Date.now() - S.sum.loadedAt > 60_000) loadSummary($).catch(() => {})
          if (S.game?.state === 'running' && !(visible && S.tab === 'game')) {
            S.game.state = 'paused' // never run a game nobody can see
          }
          if (visible && S.tab === 'game' && S.game?.state === 'running') {
            S.acc += TICK_MS
            const need = LEVELS[S.game.level as keyof typeof LEVELS].stepMs
            if (S.acc >= need) {
              S.acc = S.acc >= need * 2 ? 0 : S.acc - need
              stepGame(S.game)
              redraw($)
            }
          } else {
            S.acc = 0
            if (isWorking() || visible) { if (S.tick % 2 === 0) redraw($) }
            else if (S.tick % 20 === 0) redraw($)
          }
        })
      } catch (err) { S.lastError = `timer: ${String(err)}` }
    }
    return next(e)
  })

  on('command.run', async ($: any, e: any, next: any) => {
    if (e?.command !== S.cmd) return next(e)
    const arg = str(e?.args).trim()
    const [first, ...rest] = arg.split(/\s+/)
    const word = (first || '').toLowerCase()
    const tail = rest.join(' ').trim()

    if (word === 'help') return { text: helpText() }

    if (word === 'theme') {
      const name = THEMES[tail.toLowerCase()] ? tail.toLowerCase() : nextThemeName()
      setTheme(name)
      await storeSet($, 'theme2', name)
      redraw($)
      return { text: `theme: ${THEMES[name].label}  (soft | neon)` }
    }

    if (word === 'prompts') {
      if (tail !== 'on' && tail !== 'off') return { text: `prompt text in ledger files: ${S.logPrompts ? 'on' : 'off'}. Use: /${S.cmd} prompts on|off` }
      S.logPrompts = tail === 'on'
      await storeSet($, 'logPrompts', S.logPrompts)
      return { text: S.logPrompts ? 'Prompts are saved (trimmed to 200 characters) in the ledger files.' : 'Prompts are no longer saved. Tool arguments are still stored as one redacted line; turn those off by not sharing the files.' }
    }

    if (word === 'budget') {
      if (tail === '') return { text: S.budget ? `daily budget ${fmtUsd(S.budget)} · today ${fmtUsd(S.today)}` : `No daily budget. Set one: /${S.cmd} budget 25   (USD per day)` }
      if (tail === 'off') { S.budget = null; await storeSet($, 'budget', 0); return { text: 'Daily budget removed.' } }
      const n = Number(tail.replace('$', ''))
      if (!(n > 0)) return { text: `Usage: /${S.cmd} budget <usd> | off` }
      S.budget = n
      await storeSet($, 'budget', n)
      redraw($)
      return { text: `Daily budget set to ${fmtUsd(n)}. You will get a toast at 80% and at 100%.` }
    }

    if (word === 'billing') return { text: `billing: ${billingMode()}\n${billingNote()}` }

    if (word === 'probe') return { text: ['What this Claude Code build exposes to a mod (shape only, no values):', JSON.stringify(S.probe, null, 1)].join('\n') }

    if (word === 'today') {
      return { text: `today ${fmtUsd(S.today)}${S.budget ? ` of ${fmtUsd(S.budget)} (${Math.round((100 * S.today) / S.budget)}%)` : ''} · this session ${fmtUsd(S.costUsd)}${billingMode() === 'subscription' ? ' (API-equivalent estimates, not what you pay)' : ''}` }
    }

    if (word === 'summary' || word === 'card' || word === 'cards') {
      // summary [args] opens the SUMMARY tab with those filters. "summary text [args]" prints it in the transcript.
      // card KEY = that card's detail (all time). cards = the by-card table.
      let argText = word === 'summary' ? tail : word === 'cards' ? `card ${tail}` : tail || S.jira || ''
      const asText = word === 'summary' && /^text(\s|$)/i.test(argText)
      if (asText) argText = argText.replace(/^text\s*/i, '')
      if (word === 'card' && !argText) return { text: 'No Jira card for this session yet. Name your branch with a key, like feature/ABC-123-thing, or pass one: /' + S.cmd + ' card ABC-123' }
      if (!S.root) return { text: 'The ledger folder is unavailable (no home directory found), so there is nothing to summarise.' }
      const args = parseSummaryArgs(word === 'card' ? argText + ' all' : argText)
      if (args.error) return { text: args.error }
      if (asText) {
        const { rows, note } = await loadAllRows($)
        return { text: renderSummary(rows, args, note) }
      }
      S.sum.days = args.days
      S.sum.sel = 0
      S.sum.detailCard = args.card
      S.sum.view = args.card ? 'detail' : args.dim ? (args.dim as SView) : word === 'cards' ? 'card' : 'overview'
      S.tab = 'summary'
      await loadSummary($)
      if (!(await openPane($))) return { text: renderSummary(S.sum.rows, args, S.sum.note) } // no pane available: fall back to text
      redraw($)
      return {}
    }

    if (word === 'export') return { text: await exportCsv($, tail) }

    if (word === '' || word === 'console') {
      if (await openPane($)) return {}
    }
    return { text: view(word === 'text' ? '' : arg) }
  })

  on('ui.close', async ($: any, e: any, next: any) => {
    if (e?.id === PANE) {
      S.paneOpen = false
      S.paneSeen = 0
      if (S.game?.state === 'running') S.game.state = 'paused'
    }
    return next(e)
  })

  on('prompt.submit', async ($: any, e: any, next: any) => {
    seen('prompt.submit', e)
    S.lastPrompt = S.logPrompts ? cleanPrompt(str(e?.text)) : '(prompt hidden)'
    const o = e?.origin
    S.lastOrigin = typeof o === 'string' ? o : str(o?.kind) || (o ? JSON.stringify(o).slice(0, 40) : '')
    if (!S.jira && !str(e?.text).trim().startsWith('<')) S.jira = jiraKeyFromPrompt(str(e?.text))
    return next(e)
  })

  on('turn.start', async ($: any, e: any, next: any) => {
    seen('turn.start', e)
    S.turns += 1
    const branch = await sh($, ['git', 'branch', '--show-current'])
    if (branch && branch !== S.branch) {
      S.branch = branch
      S.jira = jiraKey(branch, S.lastPrompt) ?? S.jira
    }
    const key = e?.turnId != null ? String(e.turnId) : 'main-' + S.turns
    const rec = newRecord('turn', e?.turnId, key)
    rec.prompt = S.lastPrompt
    rec.origin = S.lastOrigin || null
    S.mainKey = key
    S.active.add(key)
    S.doneFlash = false
    touch()
    pushLog('turn', 'TURN ' + S.turns, S.lastPrompt, 0, true)
    redraw($)
    return next(e)
  })

  on('turn.step', async function* ($: any, e: any, next: any) {
    const t0 = Date.now()
    const result = yield* next(e)
    try {
      seen('turn.step', e); seen('turn.step.result', result); seen('turn.step.result.usage', result?.usage)
      addStep(e, result, Date.now() - t0)
      touch()
    } catch (err) { S.lastError = `turn.step: ${String(err)}` }
    redraw($)
    return result
  })

  on('tool.call', async ($: any, e: any, next: any) => {
    seen('tool.call', e)
    seen('tool.call:' + str(e?.tool), e) // first call of each tool: shows that tool's own fields
    const t0 = Date.now()
    let result: any
    let ok = true
    try {
      result = await next(e)
      ok = !(result && typeof result === 'object' && 'deny' in result)
      return result
    } catch (err) {
      ok = false
      throw err
    } finally {
      touch()
      try {
        const done = addTool(e, result, Date.now() - t0, ok)
        if (done) await toast($, `Agent ${done.type} finished (${fmtMs(done.ms)})`)
      } catch (err) { S.lastError = `tool.call: ${String(err)}` }
      redraw($)
    }
  })

  on('skill.prompt', async ($: any, e: any, next: any) => {
    seen('skill.prompt', e)
    const result = await next(e)
    try { addSkill(mainRec(), skillName(e), 'prompt', safeLen(result?.text)) } catch (err) { S.lastError = `skill.prompt: ${String(err)}` }
    redraw($)
    return result
  })

  on('agent.spawn', async ($: any, e: any, next: any) => {
    seen('agent.spawn', e)
    const result = await next(e)
    try {
      const type = str(e?.subagentType) || str(e?.name) || 'unknown'
      const model = str(result?.model) || str(e?.model) || 'default'
      const cur = mainRec()
      cur.agents.push({
        type, name: str(e?.name) || null, description: trunc(str(e?.description), 120), model,
        parentModel: str(e?.parentModel) || null, background: Boolean(e?.background), fork: Boolean(e?.fork),
        toolUseId: e?.tool_use_id ?? null, step: cur.steps.length, spawnedAt: new Date().toISOString(),
      })
      const a = (S.agents[type] ??= { n: 0, models: {} })
      a.n += 1
      a.models[model] = (a.models[model] ?? 0) + 1
      pushLog('agent', 'AGENT', `${type} ${trunc(str(e?.description), 40)}`, 0, true)
      S.agentRuns.push({ type, desc: str(e?.description) || type, t0: Date.now(), t1: null })
      if (S.agentRuns.length > 30) S.agentRuns.splice(0, S.agentRuns.length - 30)
    } catch (err) { S.lastError = `agent.spawn: ${String(err)}` }
    redraw($)
    return result
  })

  on('turn.complete', async ($: any, e: any, next: any) => {
    seen('turn.complete', e)
    const key = e?.turnId != null ? String(e.turnId) : S.mainKey
    let c = recFor(e?.turnId)
    if (c.done) {
      // The engine can report a turn complete twice. Keep the first record untouched and
      // only open a new one if the repeat actually carried work of its own.
      if (c.steps.length === c.stepsAtDone && c.tools.length === c.toolsAtDone) { S.dupCompletes += 1; return next(e) }
      c = newRecord('bg', null)
    }
    c.done = true
    c.stepsAtDone = c.steps.length
    c.toolsAtDone = c.tools.length
    c.endedAt = new Date().toISOString()
    c.durationMs = num(e?.durationMs) || Date.now() - c.t0
    c.end = e?.reason ?? null
    c.aborted = Boolean(e?.isAborted)
    c.reportedUsage = e?.usage ?? null // the engine's own total for this turn, to cross-check the step sum
    c.totals = c.steps.reduce(
      (a: any, s: any) => ({
        in: a.in + s.usage.in, out: a.out + s.usage.out,
        cacheRead: a.cacheRead + s.usage.cacheRead, cacheWrite: a.cacheWrite + s.usage.cacheWrite,
      }),
      { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    )
    S.active.delete(key)
    S.seq += 1
    c.seq = S.seq
    const record = { ...c }
    delete (record as any).t0
    delete (record as any).stepsAtDone
    delete (record as any).toolsAtDone
    S.lastRecord = record
    S.lastFile = c.kind === 'turn' ? `turn-${pad(c.turn)}.json` : `bg-${pad(c.bg)}.json`
    S.turnLog.push({ label: label(c), out: c.totals.out, ms: c.durationMs, seq: S.seq })
    await save($, S.lastFile, record)
    S.lastRow = pushRow(record)
    S.lastRowSeq = S.seq
    await save($, 'rows.json', S.rows, true)
    redraw($)
    if (c.kind === 'turn' && paneVisible() && S.tab === 'game') {
      // Like an arcade pause: when Claude is done, the game stops and says so, so a reply is never missed.
      S.doneFlash = true
      if (S.game?.state === 'running') S.game.state = 'paused'
      await toast($, 'Claude finished a turn')
    }
    return next(e)
  })

  // After each turn (and when a plan limit changes): cost, context, limits.
  on('session.measure', async ($: any, e: any, next: any) => {
    try {
      await refreshUsage($)
      S.cumBySeq[S.seq] = S.costUsd
      if (S.lastRecord && S.lastRecord.seq === S.seq) {
        S.lastRecord.costUsd = costFor(S.seq)
        await save($, S.lastFile, S.lastRecord)
      }
      if (S.lastRow && S.lastRowSeq === S.seq) {
        S.lastRow.costUsd = costFor(S.seq)
        await save($, 'rows.json', S.rows, true)
      }
      await save($, 'session.json', sessionSummary())
      await account($)
      await alerts($)
    } catch (err) { S.lastError = `session.measure: ${String(err)}` }
    redraw($)
    return next(e)
  })

  on('session.end', async ($: any, e: any, next: any) => {
    await save($, 'session.json', sessionSummary())
    return next(e)
  })

  // ---------- the grid ----------
  on('ui.render', { component: 'AbovePrompt' }, async ($: any, e: any, next: any) => {
    const { Box, Text, Raster } = $.ui.resolve(e)
    const theirs = await next(e)
    ensureUsage($)
    const snap = snapshot()
    let mine: any
    if (e.surface !== 'terminal') {
      mine = Text({ color: 'cyan', children: [plainLine(snap)] })
    } else {
      const cols = clamp(num(e?.props?.bodyColumns) || 80, 24, 400)
      const canvas = renderBand(snap, cols, num(e?.props?.maxRows) || 6)
      mine = Raster({ key: 'ledger-band', columns: canvas.cols, rows: canvas.rows, cells: canvas.pack() })
    }
    return Box({ flexDirection: 'column', children: [theirs, mine].filter(Boolean) })
  })

  on('ui.render', { component: 'Pane' }, async ($: any, e: any, next: any) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Raster } = $.ui.resolve(e)
    if (e.surface !== 'terminal') return Text({ children: [view('')] })
    S.paneSeen = Date.now()
    S.paneOpen = true
    ensureUsage($)

    const cols = clamp(num(e?.props?.bodyColumns) || 60, 24, 400)
    const dock = e?.props?.placement === 'dock'
    const total = dock ? clamp(num(e?.props?.scroll?.bodyRows) || 24, 8, 60) : 16
    const isGame = S.tab === 'game'
    const isSummary = S.tab === 'summary'
    const rows = Math.max(8, total - 1 - (isGame || isSummary ? 1 : 0)) // one row for the tabs, one for the keys

    // The arena always matches the window. A resize starts a fresh run (scores are kept).
    const L = layout(cols, rows)
    if (isGame && (!S.game || S.game.w !== L.gw || S.game.h !== L.gh)) S.game = newGame(L.gw, L.gh, S.game)

    if (isSummary && !S.sum.loaded && !S.sum.loading) loadSummary($).catch(() => {})
    const canvas = isSummary
      ? renderSummaryPane({ ...S.sum, now: Date.now() }, cols, rows)
      : renderConsole({ ...snapshot(), view: S.tab === 'summary' ? 'ledger' : S.tab, game: isGame ? S.game : null }, cols, rows)
    const again = () => { try { $.ui.invalidate('ui.render') } catch { /* cosmetic */ } }

    // Hotkeys only work while this pane has keyboard focus (the mod never reads the keyboard itself).
    const tabBtn = (name: 'ledger' | 'game' | 'summary', label: string, hotkey: string) =>
      Button({
        key: 'tab-' + name, label, hotkey, plain: true, dimColor: S.tab !== name,
        onPress: () => {
          S.tab = name
          if (name !== 'game' && S.game?.state === 'running') S.game.state = 'paused'
          if (name === 'summary') loadSummary($).catch(() => {})
          again()
        },
      })
    const themeBtn = Button({
      key: 'theme', label: 'THEME', hotkey: 't', plain: true,
      onPress: async () => {
        const name = nextThemeName()
        setTheme(name)
        again()
        try { await $.store.set('theme2', name) } catch { /* cosmetic */ }
      },
    })
    const tabs = Box({ flexDirection: 'row', columnGap: 3, children: [tabBtn('ledger', 'LEDGER', '1'), tabBtn('game', 'GRID RUN', '2'), tabBtn('summary', 'SUMMARY', '3'), themeBtn] })

    const key = (k: string, label: string, hotkey: string, fn: () => void) =>
      Button({ key: 'game-' + k, label, hotkey, plain: true, onPress: () => { if (S.game) fn(); again() } })
    const sumKey = (k: string, label: string, hotkey: string, fn: () => void | Promise<void>) =>
      Button({ key: 'sum-' + k, label, hotkey, plain: true, onPress: async () => { await fn(); again() } })
    const sumLen = () => mainAggs({ ...S.sum, now: Date.now() }).length
    const keys = isSummary
      ? Box({
          flexDirection: 'row', columnGap: 2,
          children: [
            sumKey('range', 'RANGE', 'r', () => { const i = RANGE_PRESETS.indexOf(S.sum.days); S.sum.days = RANGE_PRESETS[(i + 1) % RANGE_PRESETS.length]; S.sum.sel = 0 }),
            sumKey('view', 'VIEW', 'v', () => { const i = SVIEWS.indexOf(S.sum.view); S.sum.view = SVIEWS[(i + 1) % SVIEWS.length]; S.sum.detailCard = null; S.sum.sel = 0 }),
            sumKey('next', 'NEXT', 'n', () => { S.sum.sel = Math.min(S.sum.sel + 1, Math.max(0, sumLen() - 1)) }),
            sumKey('prev', 'PREV', 'p', () => { S.sum.sel = Math.max(0, S.sum.sel - 1) }),
            sumKey('open', 'OPEN', 'o', () => {
              if (S.sum.view !== 'overview' && S.sum.view !== 'card') return
              const a = mainAggs({ ...S.sum, now: Date.now() })[S.sum.sel]
              if (a && a.key !== '(no card)') { S.sum.detailCard = a.key; S.sum.view = 'detail'; S.sum.sel = 0 }
            }),
            sumKey('back', 'BACK', 'b', () => { if (S.sum.view === 'detail') { S.sum.view = 'overview'; S.sum.detailCard = null; S.sum.sel = 0 } }),
            sumKey('refresh', 'REFRESH', 'u', () => loadSummary($)),
            sumKey('export', 'EXPORT', 'x', async () => { await toast($, (await exportCsv($, '')).split('\n')[0]) }),
          ],
        })
      : isGame
      ? Box({
          flexDirection: 'row', columnGap: 2,
          children: [
            key('up', 'UP', 'w', () => steer(S.game, 'up')),
            key('left', 'LEFT', 'a', () => steer(S.game, 'left')),
            key('down', 'DOWN', 's', () => steer(S.game, 'down')),
            key('right', 'RIGHT', 'd', () => steer(S.game, 'right')),
            key('new', 'NEW RUN', 'g', () => { S.game = restart(S.game) }),
            key('pause', 'PAUSE', 'p', () => togglePause(S.game)),
            key('level', 'LEVEL', 'l', () => { S.game = nextLevel(S.game) }),
          ],
        })
      : null

    return Box({
      flexDirection: 'column',
      children: [
        tabs,
        Raster({ key: 'ledger-console', columns: canvas.cols, rows: canvas.rows, cells: canvas.pack() }),
        keys,
      ].filter(Boolean),
    })
  })
}
