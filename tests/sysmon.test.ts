import { expect, test } from 'claude-code/testing'
import {
  parseVmStat, parseTopCpu, parseSwapUsage, parsePressure, parsePmsetTherm, parseTempText, parseMeminfo, parseProcStat, cpuBetween,
  parseLoad, pickLinuxTemp, parsePs, topByCpu, topByMem, fmtBytes, spark,
} from '../hooks/sysmon.ts'
import { renderSystemPane, systemText } from '../hooks/sysview.ts'
import type { Sample } from '../hooks/sysmon.ts'

// Output shaped like a 16 GiB Apple Silicon Mac's vm_stat (16 KiB pages).
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               5230.
Pages active:                           279511.
Pages inactive:                         272038.
Pages speculative:                        3411.
Pages throttled:                             0.
Pages wired down:                        98233.
Pages purgeable:                          4122.
"Translation faults":                 91234567.
File-backed pages:                      168042.
Anonymous pages:                        386918.
Pages stored in compressor:             421003.
Pages occupied by compressor:           152812.
`

test('macOS memory follows Activity Monitor: app + wired + compressed is "used"', () => {
  const m = parseVmStat(VM_STAT, 17179869184)!
  const page = 16384
  expect(m.app).toBe((386918 - 4122) * page)
  expect(m.wired).toBe(98233 * page)
  expect(m.compressed).toBe(152812 * page)
  expect(m.used).toBe(m.app! + m.wired! + m.compressed!)
  expect(m.cached).toBe((168042 + 4122) * page)
  expect(m.used + m.cached + m.free).toBe(m.total)
  expect(parseVmStat('nothing useful', 1)).toBe(null)
})

test('macOS top, swap, pressure, load and thermal state', () => {
  const top = 'CPU usage: 30.1% user, 20.0% sys, 49.9% idle \nLoad Avg: 2.4, 2.3, 2.2\nCPU usage: 8.45% user, 5.63% sys, 85.91% idle \n'
  const cpu = parseTopCpu(top)!
  expect(Math.round(cpu.total)).toBe(14) // the LAST sample, not the average since boot
  expect(cpu.user).toBe(8.45)
  const swap = parseSwapUsage('total = 3072.00M  used = 1450.25M  free = 1621.75M  (encrypted)')!
  expect(swap.total).toBe(3072 * 1024 * 1024)
  expect(Math.round(swap.used / 1024 / 1024)).toBe(1450)
  expect(parsePressure('1\n')).toBe('normal')
  expect(parsePressure('2')).toBe('warn')
  expect(parsePressure('4')).toBe('critical')
  expect(parseLoad('{ 1.78 1.92 2.01 }')).toEqual([1.78, 1.92, 2.01])
  expect(parsePmsetTherm('Note: No thermal warning level has been recorded\n').state).toBe('nominal')
  expect(parsePmsetTherm('CPU_Speed_Limit \t= 70\n')).toEqual({ state: 'throttled', limit: 70 })
  expect(parsePmsetTherm('').state).toBe('unknown')
})

test('temperature tools: osx-cpu-temp and istats formats, and Apple Silicon zero is no reading', () => {
  expect(parseTempText('61.2°C')).toBe(61.2)
  expect(parseTempText('CPU: 61.2 C')).toBe(61.2)
  expect(parseTempText('58.50\n')).toBe(58.5)
  expect(parseTempText('0.0°C')).toBe(null)
  expect(parseTempText('')).toBe(null)
})

test('Linux memory, CPU deltas, load and temperature zones', () => {
  const mi = parseMeminfo('MemTotal: 16000000 kB\nMemFree: 2000000 kB\nMemAvailable: 9000000 kB\nBuffers: 500000 kB\nCached: 4000000 kB\nSwapTotal: 2000000 kB\nSwapFree: 1500000 kB\n')!
  expect(mi.mem.total).toBe(16000000 * 1024)
  expect(mi.mem.used).toBe(7000000 * 1024)
  expect(mi.swap.used).toBe(500000 * 1024)
  const a = parseProcStat('cpu  100 0 50 800 50 0 0 0\ncpu0 100 0 50 800 50 0 0 0\n')
  const b = parseProcStat('cpu  200 0 100 1600 100 0 0 0\ncpu0 200 0 100 1600 100 0 0 0\n')
  const u = cpuBetween(a[0], b[0])!
  expect(Math.round(u.total)).toBe(15) // busy 150 of 1000 ticks (idle includes iowait)
  expect(Math.round(u.user)).toBe(10)
  expect(cpuBetween(a[0], a[0])).toBe(null) // no time passed
  expect(parseLoad('0.12 0.20 0.18 1/234 5678')).toEqual([0.12, 0.2, 0.18])
  const t = pickLinuxTemp([{ type: 'acpitz', milli: 41000 }, { type: 'x86_pkg_temp', milli: 58000 }, { type: 'iwlwifi', milli: 70000 }])!
  expect(t.c).toBe(58) // the CPU zone wins over a hotter wifi chip
  expect(pickLinuxTemp([])).toBe(null)
  expect(pickLinuxTemp([{ type: 'x', milli: 0 }])).toBe(null)
})

test('ps lines, including a name with spaces, sort by CPU and by memory', () => {
  const procs = parsePs('  101  12.5  204800 /usr/bin/node\n  202   3.1 1048576 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n  303  55.0   10240 xcodebuild\nnot a line\n')
  expect(procs.length).toBe(3)
  expect(procs[1].name).toBe('Google Chrome')
  expect(topByCpu(procs, 1)[0].name).toBe('xcodebuild')
  expect(topByMem(procs, 1)[0].name).toBe('Google Chrome')
})

test('formatting helpers', () => {
  expect(fmtBytes(512 * 1024)).toBe('512K')
  expect(fmtBytes(300 * 1024 ** 2)).toBe('300M')
  expect(fmtBytes(9.5 * 1024 ** 3)).toBe('9.5G')
  expect(fmtBytes(32 * 1024 ** 3)).toBe('32G')
  expect(spark([0, 50, 100], 5)).toBe('  ▁▅█')
})

const sample = (over: Partial<Sample> = {}): Sample => ({
  at: 1000, platform: 'darwin', cores: 10, cpu: { total: 23, user: 15, sys: 8 }, perCore: null, load: [2.3, 2.1, 2],
  mem: { total: 16 * 1024 ** 3, used: 9 * 1024 ** 3, cached: 4 * 1024 ** 3, free: 3 * 1024 ** 3, app: 5 * 1024 ** 3, wired: 2 * 1024 ** 3, compressed: 2 * 1024 ** 3 },
  swap: { total: 2 * 1024 ** 3, used: 1024 ** 3 }, pressure: 'normal', temp: null, thermal: { state: 'nominal' },
  procs: [{ pid: 1, cpu: 50, rssKb: 100000, name: 'node' }, { pid: 2, cpu: 10, rssKb: 900000, name: 'Xcode' }], notes: ['Temperature: macOS gives no sensor reading without admin rights.'], ...over,
})
const state = (over = {}) => ({ sample: sample(), cpuHist: [10, 20, 30], memHist: [50, 55, 60], tempHist: [], loading: false, error: '', now: 4000, everyMs: 3000, ...over })
const text = (c: { ch: number[] }): string => String.fromCodePoint(...c.ch)

test('the SYSTEM pane draws at every size and in every state', () => {
  for (const [cols, rows] of [[120, 34], [89, 30], [63, 28], [60, 14]] as const) {
    const c = renderSystemPane(state(), cols, rows)
    expect(c.cols).toBe(cols)
    expect(c.rows).toBe(rows)
  }
  expect(renderSystemPane(state({ sample: null }), 100, 20).rows).toBe(20)
  expect(renderSystemPane(state({ sample: null, error: 'boom' }), 100, 20).rows).toBe(20)
  const linux = sample({ platform: 'linux', perCore: [10, 90, 40, 5], temp: { c: 61.5, source: 'x86_pkg_temp' }, thermal: null, pressure: null, notes: [] })
  expect(renderSystemPane(state({ sample: linux, tempHist: [55, 60, 61.5] }), 120, 34).rows).toBe(34)
})

test('the pane shows CPU, memory, temperature and processes, and says why there is no degrees reading on a Mac', () => {
  const t = text(renderSystemPane(state(), 120, 34))
  for (const word of ['SYSTEM', 'CPU', 'MEMORY', 'TEMPERATURE', 'PROCESSES', 'COMPRESSED', 'THERMAL', 'nominal', 'Xcode']) expect(t.includes(word)).toBe(true)
  expect(t.includes('admin rights')).toBe(true)
  const hot = text(renderSystemPane(state({ sample: sample({ temp: { c: 71.2, source: 'osx-cpu-temp' } }) }), 120, 34))
  expect(hot.includes('71.2')).toBe(true)
})

test('the transcript snapshot lists the readings and the process leaders', () => {
  const t = systemText(state())
  expect(t.includes('cpu      23%')).toBe(true)
  expect(t.includes('memory   9.0G of 16G')).toBe(true)
  expect(t.includes('top cpu  node 50%')).toBe(true)
  expect(systemText(state({ sample: null })).includes('No reading yet')).toBe(true)
})
