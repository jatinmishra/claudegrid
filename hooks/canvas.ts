// A tiny character canvas for the terminal Raster element, plus the colour themes.
// One cell = one character + foreground + background. Only single-width glyphs here
// (box drawing, block elements), so cells never drift out of alignment.

export const DEFAULT = 0x01000000 // "use the terminal's own color" (and, in set(), "leave the background as it is")

// ---------- themes ----------
// `cyan` is the theme's primary colour; `magenta` is its secondary (a light blue in SOFT, pink in NEON).
export interface Palette {
  white: number; hot: number; cyan: number; text: number; dim: number; deep: number; trail: number
  magenta: number; lime: number; yellow: number; blue: number; orange: number; alert: number; ink: number
  you: number; youHead: number; clu: number; cluHead: number; grid: number; wreck: number
}
export interface Theme { label: string; bg: number; glow: number; p: Palette }

export const THEMES: Record<string, Theme> = {
  // The default: the earlier cool-blue look with just a touch more electric. Same palette family,
  // slightly brighter cyan, cyan-to-blue gradients on bars and the laser, no solid background, no glow.
  soft: {
    label: 'SOFT', bg: DEFAULT, glow: 0,
    p: {
      white: 0xf2ffff, hot: 0xb4f8ff, cyan: 0x2ee6ff, text: 0x9fe8f5, dim: 0x4d9fb0, deep: 0x1c5f70, trail: 0x0d3a46,
      magenta: 0x5aa8ff, lime: 0xb4f8ff, yellow: 0xb4f8ff, blue: 0x3d8bff, orange: 0xff7a18, alert: 0xff7a18, ink: 0x03141c,
      you: 0x2ee6ff, youHead: 0xf2ffff, clu: 0xd9600f, cluHead: 0xffd2a0, grid: 0x14404b, wreck: 0xff3b1f,
    },
  },
  // The bold version: near-black panels, a glow inside every frame, pink and lime accents. Opt in with `t`.
  neon: {
    label: 'NEON', bg: 0x030812, glow: 0.11,
    p: {
      white: 0xeaffff, hot: 0x8cfbff, cyan: 0x00f0ff, text: 0xb4f4ff, dim: 0x3a9fb5, deep: 0x0a5568, trail: 0x06303c,
      magenta: 0xff2bd6, lime: 0x39ff14, yellow: 0xffe81f, blue: 0x3d7bff, orange: 0xff8a00, alert: 0xff2a6d, ink: 0x02131c,
      you: 0x00f0ff, youHead: 0xefffff, clu: 0xff7a00, cluHead: 0xffd27a, grid: 0x0b4558, wreck: 0xff2a6d,
    },
  },
}
export const THEME_ORDER = ['soft', 'neon']

// Live palette: renderers read these at draw time, so switching theme restyles everything on the next frame.
export const C: Palette = { ...THEMES.soft.p }
export const T = { name: 'soft', bg: THEMES.soft.bg, glow: THEMES.soft.glow }

export function setTheme(name: string): boolean {
  const th = THEMES[name]
  if (!th) return false
  Object.assign(C, th.p)
  T.name = name
  T.bg = th.bg
  T.glow = th.glow
  return true
}

export function nextThemeName(): string {
  return THEME_ORDER[(THEME_ORDER.indexOf(T.name) + 1) % THEME_ORDER.length]
}

export function lerp(a: number, b: number, t: number): number {
  const k = Math.min(1, Math.max(0, t))
  const ch = (shift: number) => Math.round(((a >> shift) & 255) * (1 - k) + ((b >> shift) & 255) * k)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

// Three-stop gradient: a at t=0, b at 0.5, c at 1.
export function lerp3(a: number, b: number, c: number, t: number): number {
  return t < 0.5 ? lerp(a, b, t * 2) : lerp(b, c, (t - 0.5) * 2)
}

const cp = (s: string) => s.codePointAt(0) as number
const LIGHT_H = cp('─')

export class Canvas {
  readonly cols: number
  readonly rows: number
  readonly baseBg: number
  ch: number[]
  fg: number[]
  bg: number[]

  constructor(cols: number, rows: number) {
    this.cols = Math.max(1, Math.floor(cols))
    this.rows = Math.max(1, Math.floor(rows))
    this.baseBg = T.bg
    const n = this.cols * this.rows
    this.ch = Array(n).fill(32)
    this.fg = Array(n).fill(C.text)
    this.bg = Array(n).fill(this.baseBg)
  }

  // bg === DEFAULT keeps whatever background the cell already has (so glow survives text drawn over it).
  set(x: number, y: number, code: number, fg: number, bg: number = DEFAULT) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return
    const i = y * this.cols + x
    this.ch[i] = code
    this.fg[i] = fg
    if (bg !== DEFAULT) this.bg[i] = bg
  }

  charAt(x: number, y: number): number {
    return x < 0 || y < 0 || x >= this.cols || y >= this.rows ? 32 : this.ch[y * this.cols + x]
  }

  // Blend a cell's background toward a colour: the "bloom" next to something bright.
  tint(x: number, y: number, color: number, amount: number) {
    if (T.glow <= 0 || x < 0 || y < 0 || x >= this.cols || y >= this.rows) return
    const i = y * this.cols + x
    const base = this.bg[i] === DEFAULT ? 0x05090d : this.bg[i]
    this.bg[i] = lerp(base, color, amount)
  }

  // Draw a string; stops at maxX (inclusive). Returns the x after the last drawn cell.
  text(x: number, y: number, s: string, fg: number, bg: number = DEFAULT, maxX: number = this.cols - 1): number {
    for (const c of s) {
      if (x > maxX) break
      this.set(x, y, cp(c), fg, bg)
      x++
    }
    return x
  }

  fill(x: number, y: number, w: number, h: number, glyph: string, fg: number, bg: number = DEFAULT) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, cp(glyph), fg, bg)
  }

  hline(x: number, y: number, w: number, glyph: string, fg: number) {
    for (let i = 0; i < w; i++) this.set(x + i, y, cp(glyph), fg)
  }

  // Heavy corners + light edges read like the notched frames in the film.
  // `label` sits in a tab on the top edge, `tab` is a second tab at the right.
  // The cells just inside the frame get a faint tint of the frame colour, which reads as a glow.
  frame(x: number, y: number, w: number, h: number, o: { color: number; label?: string; labelColor?: number; tab?: string; tabColor?: number; tabInset?: number }) {
    if (w < 4 || h < 2) return
    const col = o.color
    for (let j = 1; j < h - 1; j++) {
      this.tint(x + 1, y + j, col, T.glow)
      this.tint(x + w - 2, y + j, col, T.glow)
      this.tint(x + 2, y + j, col, T.glow * 0.4)
      this.tint(x + w - 3, y + j, col, T.glow * 0.4)
    }
    for (let i = 1; i < w - 1; i++) {
      this.tint(x + i, y + 1, col, T.glow)
      this.tint(x + i, y + h - 2, col, T.glow)
      if (h > 4) { this.tint(x + i, y + 2, col, T.glow * 0.4); this.tint(x + i, y + h - 3, col, T.glow * 0.4) }
    }
    this.set(x, y, cp('┏'), col)
    this.set(x + w - 1, y, cp('┓'), col)
    this.set(x, y + h - 1, cp('┗'), col)
    this.set(x + w - 1, y + h - 1, cp('┛'), col)
    this.hline(x + 1, y, w - 2, '─', col)
    this.hline(x + 1, y + h - 1, w - 2, '─', col)
    for (let j = 1; j < h - 1; j++) {
      this.set(x, y + j, cp('│'), col)
      this.set(x + w - 1, y + j, cp('│'), col)
    }
    if (o.label) {
      this.set(x + 1, y, cp('━'), col)
      this.set(x + 2, y, cp('┫'), col)
      const end = this.text(x + 3, y, ' ' + o.label + ' ', o.labelColor ?? C.hot, DEFAULT, x + w - 3)
      this.set(end, y, cp('┣'), col)
    }
    if (o.tab) {
      const t = ' ' + o.tab + ' '
      const start = x + w - (o.tabInset ?? 3) - [...t].length
      if (start > x + 6 + (o.label ? [...o.label].length : 0)) {
        this.set(start - 1, y, cp('┫'), col)
        this.text(start, y, t, o.tabColor ?? col)
        this.set(start + [...t].length, y, cp('┣'), col)
        this.set(start + [...t].length + 1, y, cp('━'), col)
      }
    }
  }

  // ▕████░░░░▏ ; width counts the caps. With `onEnd` the filled part is a gradient. Returns x after the bar.
  bar(x: number, y: number, w: number, frac: number, on: number, off: number = C.deep, onEnd?: number, mark?: number): number {
    const inner = Math.max(1, w - 2)
    const filled = Math.round(Math.min(1, Math.max(0, frac || 0)) * inner)
    this.set(x, y, cp('▕'), C.dim)
    for (let i = 0; i < inner; i++) {
      const c = i < filled ? (onEnd == null ? on : lerp(on, onEnd, inner > 1 ? i / (inner - 1) : 0)) : off
      this.set(x + 1 + i, y, cp(i < filled ? '█' : '░'), c)
    }
    // optional marker: how far through its window we are (e.g. time elapsed in a 5-hour limit)
    if (mark != null && mark > 0 && mark < 1) this.set(x + 1 + Math.min(inner - 1, Math.floor(mark * inner)), y, cp('│'), C.white)
    this.set(x + 1 + inner, y, cp('▏'), C.dim)
    return x + inner + 2
  }

  cells(): number[] {
    const out: number[] = new Array(this.cols * this.rows * 3)
    for (let i = 0; i < this.ch.length; i++) {
      out[i * 3] = this.ch[i]
      out[i * 3 + 1] = this.fg[i]
      out[i * 3 + 2] = this.bg[i]
    }
    return out
  }

  // The packed string a Raster's `cells` prop takes.
  pack(): string {
    const bytes = new Uint8Array(Uint32Array.from(this.cells()).buffer)
    const anyBytes = bytes as any
    if (typeof anyBytes.toBase64 === 'function') return anyBytes.toBase64()
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(bin)
  }

  // For tests and previews outside Claude Code.
  toAnsi(): string {
    const rgb = (n: number) => (n === DEFAULT ? null : `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`)
    const lines: string[] = []
    for (let y = 0; y < this.rows; y++) {
      let line = ''
      for (let x = 0; x < this.cols; x++) {
        const i = y * this.cols + x
        const f = rgb(this.fg[i])
        const b = rgb(this.bg[i])
        line += `\x1b[${f ? '38;2;' + f : '39'};${b ? '48;2;' + b : '49'}m${String.fromCodePoint(this.ch[i])}`
      }
      lines.push(line + '\x1b[0m')
    }
    return lines.join('\n')
  }
}

export { LIGHT_H }
