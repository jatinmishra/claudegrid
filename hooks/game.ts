// Light cycles. You (cyan) against Clu (orange) on a grid; hit a wall or any trail and you de-rez.
// Pure logic: no Claude Code APIs, so it is easy to test.

export type Dir = 'up' | 'down' | 'left' | 'right'
export type GameState = 'ready' | 'running' | 'paused' | 'won' | 'lost' | 'draw'
export type Level = 'easy' | 'normal' | 'hard' | 'insane'

// stepMs: how long one move takes. Lower is faster.
export const LEVELS: Record<Level, { label: string; stepMs: number }> = {
  easy: { label: 'EASY', stepMs: 150 },
  normal: { label: 'NORMAL', stepMs: 100 },
  hard: { label: 'HARD', stepMs: 80 },
  insane: { label: 'INSANE', stepMs: 60 },
}
export const LEVEL_ORDER: Level[] = ['easy', 'normal', 'hard', 'insane']

export const DX: Record<Dir, number> = { up: 0, down: 0, left: -1, right: 1 }
export const DY: Record<Dir, number> = { up: -1, down: 1, left: 0, right: 0 }
const LEFT_OF: Record<Dir, Dir> = { up: 'left', left: 'down', down: 'right', right: 'up' }
const RIGHT_OF: Record<Dir, Dir> = { up: 'right', right: 'down', down: 'left', left: 'up' }
const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' }

export interface Cycle {
  x: number
  y: number
  dir: Dir
  alive: boolean
}

export interface Game {
  w: number
  h: number
  grid: Uint8Array // 0 empty, 1 your trail, 2 Clu's trail
  stamp: Uint32Array // the move on which each trail cell was laid, so the renderer can fade trails by age
  you: Cycle
  clu: Cycle
  queued: Dir | null
  state: GameState
  level: Level
  wins: number
  losses: number
  draws: number
  ticks: number
  seed: number
}

const idx = (g: Game, x: number, y: number) => y * g.w + x
const inside = (g: Game, x: number, y: number) => x >= 0 && y >= 0 && x < g.w && y < g.h
export const cellOpen = (g: Game, x: number, y: number) => inside(g, x, y) && g.grid[idx(g, x, y)] === 0
const isOpen = (g: Game, x: number, y: number) => inside(g, x, y) && g.grid[idx(g, x, y)] === 0

// mulberry32: small seeded generator so games can be replayed in tests
function rnd(g: Game): number {
  g.seed = (g.seed + 0x6d2b79f5) | 0
  let t = Math.imul(g.seed ^ (g.seed >>> 15), 1 | g.seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export function newGame(w: number, h: number, prev?: Game | null, seed: number = Date.now()): Game {
  const W = Math.max(8, Math.floor(w))
  const H = Math.max(6, Math.floor(h))
  const g: Game = {
    w: W, h: H, grid: new Uint8Array(W * H), stamp: new Uint32Array(W * H),
    you: { x: Math.floor(W * 0.2), y: Math.floor(H / 2), dir: 'right', alive: true },
    clu: { x: Math.floor(W * 0.8), y: Math.floor(H / 2), dir: 'left', alive: true },
    queued: null, state: 'ready', level: prev?.level ?? 'normal',
    wins: prev?.wins ?? 0, losses: prev?.losses ?? 0, draws: prev?.draws ?? 0,
    ticks: 0, seed,
  }
  g.grid[idx(g, g.you.x, g.you.y)] = 1
  g.grid[idx(g, g.clu.x, g.clu.y)] = 2
  return g
}

// Steer. The first press starts the run. A cycle can't reverse into its own trail.
export function turn(g: Game, dir: Dir) {
  if (g.state === 'won' || g.state === 'lost' || g.state === 'draw' || g.state === 'paused') return
  if (dir === OPPOSITE[g.you.dir]) return // a reversal does nothing, and doesn't start the run either
  if (g.state === 'ready') g.state = 'running'
  g.queued = dir
}

export function togglePause(g: Game) {
  if (g.state === 'running') g.state = 'paused'
  else if (g.state === 'paused') g.state = 'running'
}

export function restart(g: Game): Game {
  return newGame(g.w, g.h, g)
}

// Changing level starts a fresh run (scores are kept).
export function setLevel(g: Game, level: Level): Game {
  const n = newGame(g.w, g.h, g)
  n.level = level
  return n
}

export function nextLevel(g: Game): Game {
  return setLevel(g, LEVEL_ORDER[(LEVEL_ORDER.indexOf(g.level) + 1) % LEVEL_ORDER.length])
}

// How much open floor is reachable from here (capped), so Clu can avoid boxing itself in.
export function freeSpace(g: Game, x: number, y: number, cap = 500): number {
  if (!isOpen(g, x, y)) return 0
  const seen = new Uint8Array(g.w * g.h)
  const queue: number[] = [idx(g, x, y)]
  seen[queue[0]] = 1
  let count = 0
  for (let q = 0; q < queue.length && count < cap; q++) {
    const cx = queue[q] % g.w
    const cy = Math.floor(queue[q] / g.w)
    count++
    for (const d of ['up', 'down', 'left', 'right'] as Dir[]) {
      const nx = cx + DX[d]
      const ny = cy + DY[d]
      if (isOpen(g, nx, ny) && !seen[idx(g, nx, ny)]) {
        seen[idx(g, nx, ny)] = 1
        queue.push(idx(g, nx, ny))
      }
    }
  }
  return count
}

// How often HARD plays the territory move (INSANE always does). Lower is easier.
export const HARD_FOCUS = 0.6

const FOUR: Dir[] = ['up', 'down', 'left', 'right']

// Who gets to each empty cell first? Returns (cells Clu reaches first) - (cells you reach first).
// Cells both reach on the same move are nobody's. This is the classic light-cycle evaluation:
// the move that leaves Clu the bigger territory also cuts you off.
function territory(g: Game, clu: number, you: number): number {
  const n = g.w * g.h
  const owner = new Int8Array(n) // 0 free, 1 Clu, 2 you, 3 closed
  for (let i = 0; i < n; i++) if (g.grid[i] !== 0) owner[i] = 3
  let fc: number[] = [clu]
  let fy: number[] = [you]
  owner[clu] = 1
  if (owner[you] === 1) owner[you] = 3
  else owner[you] = 2
  let cc = 0
  let yc = 0
  const grab = (frontier: number[]): number[] => {
    const out: number[] = []
    for (const c of frontier) {
      const cx = c % g.w
      const cy = Math.floor(c / g.w)
      for (const d of FOUR) {
        const nx = cx + DX[d]
        const ny = cy + DY[d]
        if (inside(g, nx, ny) && owner[ny * g.w + nx] === 0) out.push(ny * g.w + nx)
      }
    }
    return out
  }
  while (fc.length || fy.length) {
    const a = grab(fc)
    const b = grab(fy)
    const setB = new Set(b)
    const setA = new Set(a)
    const nextC: number[] = []
    const nextY: number[] = []
    for (const c of setA) {
      if (setB.has(c)) owner[c] = 3
      else { owner[c] = 1; cc++; nextC.push(c) }
    }
    for (const c of setB) {
      if (!setA.has(c)) { owner[c] = 2; yc++; nextY.push(c) }
    }
    fc = nextC
    fy = nextY
  }
  return cc - yc
}

function aiPick(g: Game): Dir {
  const d = g.clu.dir
  const opts = ([d, LEFT_OF[d], RIGHT_OF[d]] as Dir[]).map((o) => {
    const nx = g.clu.x + DX[o]
    const ny = g.clu.y + DY[o]
    return { o, nx, ny, free: isOpen(g, nx, ny) }
  })
  const safe = opts.filter((s) => s.free)
  if (safe.length === 0) return d // boxed in: nothing to choose
  if (safe.length === 1) return safe[0].o

  // EASY: avoids the wall right in front of it and little else, and wanders.
  if (g.level === 'easy') {
    const straight = safe.find((s) => s.o === d)
    if (straight && rnd(g) > 0.1) return d
    const others = safe.filter((s) => s.o !== d)
    return (others.length ? others : safe)[Math.floor(rnd(g) * (others.length || safe.length))].o
  }

  // NORMAL (and the moves HARD plays by feel): keeps to open floor, mostly straight, the odd unpredictable turn.
  // HARD plays the territory move HARD_FOCUS of the time and falls back to this the rest, so it can be beaten.
  if (g.level === 'normal' || (g.level === 'hard' && rnd(g) > HARD_FOCUS)) {
    const scored = safe.map((s) => ({ ...s, room: freeSpace(g, s.nx, s.ny) }))
    const best = Math.max(...scored.map((s) => s.room))
    const straight = scored.find((s) => s.o === d)
    if (straight && straight.room >= best * 0.85) {
      const turns = scored.filter((s) => s.o !== d && s.room >= best * 0.6)
      if (turns.length > 0 && rnd(g) < 0.05) return turns[Math.floor(rnd(g) * turns.length)].o
      return d
    }
    return scored.reduce((a, b) => (b.room > a.room ? b : a)).o
  }

  // INSANE (and HARD when it is focused): pick the move that wins the most territory.
  // look where you are about to be, not where you are
  const yAhead = isOpen(g, g.you.x + DX[g.you.dir], g.you.y + DY[g.you.dir])
    ? idx(g, g.you.x + DX[g.you.dir], g.you.y + DY[g.you.dir])
    : idx(g, g.you.x, g.you.y)
  let bestMove = safe[0]
  let bestScore = -Infinity
  for (const s of safe) {
    const cell = idx(g, s.nx, s.ny)
    g.grid[cell] = 2 // pretend we moved there
    const score = territory(g, cell, yAhead) + (s.o === d ? 0.5 : 0)
    g.grid[cell] = 0
    if (score > bestScore) { bestScore = score; bestMove = s }
  }
  return bestMove.o
}

export function step(g: Game) {
  if (g.state !== 'running') return
  if (g.queued) {
    g.you.dir = g.queued
    g.queued = null
  }
  g.clu.dir = aiPick(g)

  const yx = g.you.x + DX[g.you.dir]
  const yy = g.you.y + DY[g.you.dir]
  const cx = g.clu.x + DX[g.clu.dir]
  const cy = g.clu.y + DY[g.clu.dir]
  const headOn = yx === cx && yy === cy
  const youDead = headOn || !isOpen(g, yx, yy)
  const cluDead = headOn || !isOpen(g, cx, cy)

  if (youDead) g.you.alive = false
  else { g.you.x = yx; g.you.y = yy; g.grid[idx(g, yx, yy)] = 1; g.stamp[idx(g, yx, yy)] = g.ticks }
  if (cluDead) g.clu.alive = false
  else { g.clu.x = cx; g.clu.y = cy; g.grid[idx(g, cx, cy)] = 2; g.stamp[idx(g, cx, cy)] = g.ticks }

  g.ticks++
  if (youDead && cluDead) { g.state = 'draw'; g.draws++ }
  else if (youDead) { g.state = 'lost'; g.losses++ }
  else if (cluDead) { g.state = 'won'; g.wins++ }
}
