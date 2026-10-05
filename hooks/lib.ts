// Pure helpers for claudegrid. No Claude Code APIs in here, so they are easy to test.

// ---------- Jira ----------
const PROMPT_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/
const BRANCH_KEY = /(?:^|[\/_-])([a-z][a-z0-9]{1,9}-\d{1,6})(?=$|[\/_-])/i
// Words that look like a Jira project key in a branch name but are not one (e.g. release-2024).
const NOT_PROJECTS = new Set([
  'feature', 'feat', 'fix', 'bugfix', 'hotfix', 'release', 'chore', 'task',
  'spike', 'refactor', 'test', 'docs', 'v', 'build', 'ci',
])

export function jiraKeyFromPrompt(text?: string | null): string | null {
  if (!text) return null
  const m = PROMPT_KEY.exec(text)
  return m ? m[1] : null
}

export function jiraKeyFromBranch(branch?: string | null): string | null {
  if (!branch) return null
  const m = BRANCH_KEY.exec(branch)
  if (!m) return null
  const key = m[1].toUpperCase()
  const project = key.split('-')[0].toLowerCase()
  return NOT_PROJECTS.has(project) ? null : key
}

// Branch wins (it is deliberate), the prompt is the fallback.
export function jiraKey(branch?: string | null, prompt?: string | null): string | null {
  return jiraKeyFromBranch(branch) ?? jiraKeyFromPrompt(prompt)
}

// ---------- Redaction / summaries ----------
export function redact(s: string): string {
  return s
    .replace(/(bearer\s+)[\w.\-~+/=]+/gi, '$1[redacted]')
    .replace(/\b(token|secret|password|passwd|api[_-]?key)(\s*[=:]\s*)\S+/gi, '$1$2[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, '[redacted]')
}

export function trunc(s: string, n = 80): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

const ARG_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']

// One short, redacted line describing a tool call. Never the full input.
export function summarizeArgs(e: any): string {
  for (const src of [e, e?.input]) {
    if (!src || typeof src !== 'object') continue
    for (const k of ARG_KEYS) {
      if (typeof src[k] === 'string' && src[k]) return trunc(redact(src[k]))
    }
  }
  return ''
}

export function safeLen(v: unknown): number {
  if (v == null) return 0
  if (typeof v === 'string') return v.length
  try { return JSON.stringify(v).length } catch { return 0 }
}

// Rough: ~3.5 chars per token for mixed code/text. Always label results as estimated.
export function estTokens(chars: number): number {
  return Math.ceil(chars / 3.5)
}

export function mcpServer(tool: string): string | null {
  const m = /^mcp__([^_].*?)__/.exec(tool || '')
  return m ? m[1] : null
}

// ---------- Formatting ----------
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 2 : 1) + 'k'
  return (n / 1_000_000).toFixed(2) + 'M'
}

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function meter(frac: number, width: number): string {
  const f = Math.min(1, Math.max(0, frac || 0))
  const filled = Math.round(f * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function cacheHit(inTok: number, cacheRead: number, cacheWrite: number): number {
  const total = inTok + cacheRead + cacheWrite
  return total > 0 ? cacheRead / total : 0
}

// The "laser": a bright head with a fading trail bouncing along a grid line.
export function laser(width: number, now: number, active: boolean): string {
  const w = Math.max(8, width)
  const cells: string[] = Array(w).fill('─')
  const period = (w - 1) * 2
  const speed = active ? 45 : 140 // ms per cell
  const p = Math.floor(now / speed) % period
  const head = p < w ? p : period - p
  const trailDir = p < w ? -1 : 1
  cells[head] = '█'
  const trail = ['▓', '▒', '░']
  for (let k = 1; k <= 3; k++) {
    const i = head + trailDir * k
    if (i >= 0 && i < w) cells[i] = trail[k - 1]
  }
  return cells.join('')
}

// ---------- v0.2 additions ----------
export function fmtUsd(n: number): string {
  if (!isFinite(n)) return '$0.00'
  return n < 10 ? '$' + n.toFixed(3) : '$' + n.toFixed(2)
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

export function shortModel(m: string): string {
  return (m || '—').replace(/^claude-/, '')
}

export function clock(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return Math.round(ms) + 'ms'
  if (ms < 60_000) return (ms / 1000).toFixed(1) + 's'
  return fmtDur(ms)
}
