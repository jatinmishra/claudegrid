import { expect, test } from 'claude-code/testing'
import { newGame, turn, step, togglePause, restart } from '../hooks/game.ts'

test('first steer starts the run, reversal is ignored', () => {
  const g = newGame(30, 12, null, 1)
  expect(g.state).toBe('ready')
  turn(g, 'left') // opposite of the starting heading (right)
  expect(g.queued).toBe(null)
  turn(g, 'up')
  expect(g.state).toBe('running')
  step(g)
  expect(g.you.dir).toBe('up')
})

test('hitting a wall loses the run', () => {
  const g = newGame(10, 6, null, 1)
  g.you.x = 9; g.you.y = 3
  turn(g, 'right')
  g.state = 'running'
  step(g)
  expect(g.state === 'lost' || g.state === 'draw').toBe(true)
})

test('pause stops stepping and restart keeps the score', () => {
  const g = newGame(30, 12, null, 1)
  turn(g, 'up')
  togglePause(g)
  const t = g.ticks
  step(g)
  expect(g.ticks).toBe(t)
  g.wins = 2
  expect(restart(g).wins).toBe(2)
})

import { setLevel, nextLevel, LEVEL_ORDER, LEVELS } from '../hooks/game.ts'

test('levels cycle, keep the score and get faster', () => {
  let g = newGame(30, 12, null, 1)
  expect(g.level).toBe('normal')
  g.wins = 3
  g = nextLevel(g)
  expect(g.level).toBe('hard')
  expect(g.wins).toBe(3)
  expect(g.state).toBe('ready')
  expect(LEVELS.easy.stepMs > LEVELS.normal.stepMs).toBe(true)
  expect(LEVELS.hard.stepMs > LEVELS.insane.stepMs).toBe(true)
})

test('every level finishes a run without throwing', () => {
  for (const level of LEVEL_ORDER) {
    const g = setLevel(newGame(26, 20, null, 7), level)
    turn(g, 'up')
    let guard = 0
    while (g.state === 'running' && guard++ < 2000) step(g)
    expect(g.state === 'running').toBe(false)
  }
})
