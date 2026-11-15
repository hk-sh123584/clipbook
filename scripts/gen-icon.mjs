import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePng(size, pixels) {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// 画一张「纸质便签 + 朱红印章」的图标
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4)
  const s = size / 256
  const put = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    px[i] = r
    px[i + 1] = g
    px[i + 2] = b
    px[i + 3] = a
  }
  const insideRound = (x, y, x0, y0, x1, y1, r) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false
    const cx = Math.min(Math.max(x, x0 + r), x1 - r)
    const cy = Math.min(Math.max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
  }
  const fillRound = (x0, y0, x1, y1, r, color) => {
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
      for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
        if (insideRound(x + 0.5, y + 0.5, x0, y0, x1, y1, r)) put(x, y, ...color)
      }
    }
  }
  const strokeRound = (x0, y0, x1, y1, r, w, color) => {
    for (let y = Math.floor(y0 - w); y <= Math.ceil(y1 + w); y++) {
      for (let x = Math.floor(x0 - w); x <= Math.ceil(x1 + w); x++) {
        const outer = insideRound(x + 0.5, y + 0.5, x0 - w, y0 - w, x1 + w, y1 + w, r + w)
        const inner = insideRound(x + 0.5, y + 0.5, x0, y0, x1, y1, r)
        if (outer && !inner) put(x, y, ...color)
      }
    }
  }

  const paper = [245, 239, 224, 255]
  const ink = [43, 42, 38, 255]
  const rule = [210, 195, 165, 255]
  const seal = [166, 58, 43, 255]

  fillRound(24 * s, 16 * s, 232 * s, 240 * s, 26 * s, paper)
  strokeRound(24 * s, 16 * s, 232 * s, 240 * s, 26 * s, 5 * s, ink)

  // 三条横格线
  for (const y of [78, 120, 162]) {
    for (let x = Math.round(58 * s); x < Math.round(198 * s); x++) {
      for (let w = 0; w < Math.max(1, Math.round(4 * s)); w++) {
        put(x, Math.round(y * s) + w, ...rule)
      }
    }
  }

  // 朱红印章
  const cx = 172 * s
  const cy = 194 * s
  const rr = 28 * s
  for (let y = Math.floor(cy - rr); y <= cy + rr; y++) {
    for (let x = Math.floor(cx - rr); x <= cx + rr; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= rr * rr) put(x, y, ...seal)
    }
  }
  // 印章中间留一道纸色缺口，像盖歪的印
  for (let x = Math.floor(cx - rr * 0.62); x <= Math.floor(cx + rr * 0.62); x++) {
    for (let w = 0; w < Math.max(1, Math.round(3 * s)); w++) {
      put(x, Math.round(cy) + w, ...paper)
    }
  }

  return encodePng(size, px)
}

const outDir = path.join(process.cwd(), 'assets')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'icon.png'), drawIcon(256))
fs.writeFileSync(path.join(outDir, 'tray.png'), drawIcon(32))
console.log('icons written to assets/')
