'use strict'

/*
 * Build the app icon set from the OFFICIAL DeepSeek blue-whale favicon.
 * Decodes the 32bpp BGRA DIB inside the .ico, then resamples (premultiplied
 * bilinear) into every size the desktop shell needs, and packs a multi-size
 * Windows .ico. Produces: icon.png, icon-256.png, whale.png, tray.png,
 * tray@2x.png, and build/icon.ico.
 */

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const ROOT = path.join(__dirname, '..')
const ASSETS = path.join(ROOT, 'assets')
const BUILD = path.join(ROOT, 'build')
const SRC_ICO = path.join(ASSETS, 'official-favicon.ico')

function decodeIcoDib(icoBuf) {
  const offset = icoBuf.readUInt32LE(18)
  const biSize = icoBuf.readUInt32LE(offset)
  const w = icoBuf.readInt32LE(offset + 4)
  const hDoubled = icoBuf.readInt32LE(offset + 8)
  const h = Math.abs(hDoubled) / 2
  const pixelStart = offset + biSize
  const img = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    const srcY = h - 1 - y
    for (let x = 0; x < w; x++) {
      const s = pixelStart + (srcY * w + x) * 4
      const d = (y * w + x) * 4
      img[d] = icoBuf[s + 2]     // r
      img[d + 1] = icoBuf[s + 1] // g
      img[d + 2] = icoBuf[s]     // b
      img[d + 3] = icoBuf[s + 3] // a
    }
  }
  return { w, h, img }
}

// Premultiplied-alpha bilinear resample (avoids dark fringes on transparent edges).
function resample(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4)
  const xScale = sw / dw
  const yScale = sh / dh
  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) * yScale - 0.5
    const y0 = Math.floor(sy)
    const fy = sy - y0
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * xScale - 0.5
      const x0 = Math.floor(sx)
      const fx = sx - x0
      let r = 0, g = 0, b = 0, a = 0
      for (let dy = 0; dy < 2; dy++) {
        const py = Math.min(sh - 1, Math.max(0, y0 + dy))
        for (let dx = 0; dx < 2; dx++) {
          const px = Math.min(sw - 1, Math.max(0, x0 + dx))
          const i = (py * sw + px) * 4
          const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy)
          const alpha = src[i + 3]
          r += src[i] * alpha * w
          g += src[i + 1] * alpha * w
          b += src[i + 2] * alpha * w
          a += alpha * w
        }
      }
      const o = (y * dw + x) * 4
      if (a > 0.5) {
        out[o] = Math.min(255, Math.max(0, Math.round(r / a)))
        out[o + 1] = Math.min(255, Math.max(0, Math.round(g / a)))
        out[o + 2] = Math.min(255, Math.max(0, Math.round(b / a)))
        out[o + 3] = Math.min(255, Math.max(0, Math.round(a)))
      } else {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0
      }
    }
  }
  return out
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0, 0)
  return Buffer.concat([len, t, data, crc])
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

function encodeICO(sizes) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4)
  const dir = []
  let offset = 6 + 16 * sizes.length
  for (const e of sizes) {
    const d = Buffer.alloc(16)
    d[0] = e.size >= 256 ? 0 : e.size
    d[1] = e.size >= 256 ? 0 : e.size
    d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6)
    d.writeUInt32LE(e.png.length, 8); d.writeUInt32LE(offset, 12)
    dir.push(d); offset += e.png.length
  }
  return Buffer.concat([header].concat(dir).concat(sizes.map(e => e.png)))
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
function lerp(a, b, t) { return a + (b - a) * t }

/**
 * Tech-styled tray icon: dark navy squircle with a neon gradient ring and the
 * whale overlaid in near-white. `accent` picks the ring's gradient endpoints
 * (cyan->blue for normal, red tones for the low-balance state).
 */
function renderTechTray(src, size, accent) {
  const whale = resample(src.img, src.w, src.h, size, size)
  const out = Buffer.alloc(size * size * 4)
  const cornerR = size * 0.28
  const borderW = Math.max(1, Math.round(size * 0.055))
  const bgTop = [20, 38, 94]
  const bgBottom = [10, 17, 40]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ccx = clamp(x, cornerR, size - 1 - cornerR)
      const ccy = clamp(y, cornerR, size - 1 - cornerR)
      const dx = x - ccx, dy = y - ccy
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d > cornerR) continue
      const idx = (y * size + x) * 4
      if (d > cornerR - borderW) {
        const t = (x + y) / (2 * (size - 1))
        out[idx] = Math.round(lerp(accent.from[0], accent.to[0], t))
        out[idx + 1] = Math.round(lerp(accent.from[1], accent.to[1], t))
        out[idx + 2] = Math.round(lerp(accent.from[2], accent.to[2], t))
        out[idx + 3] = 255
      } else {
        const t = y / (size - 1)
        out[idx] = Math.round(lerp(bgTop[0], bgBottom[0], t))
        out[idx + 1] = Math.round(lerp(bgTop[1], bgBottom[1], t))
        out[idx + 2] = Math.round(lerp(bgTop[2], bgBottom[2], t))
        out[idx + 3] = 255
      }
    }
  }
  for (let i = 0; i < size * size * 4; i += 4) {
    const a = whale[i + 3]
    if (a < 8) continue
    const t = a / 255
    out[i] = Math.round(lerp(out[i], 240, t))
    out[i + 1] = Math.round(lerp(out[i + 1], 247, t))
    out[i + 2] = Math.round(lerp(out[i + 2], 255, t))
    out[i + 3] = Math.max(out[i + 3], a)
  }
  return out
}

function main() {
  fs.mkdirSync(ASSETS, { recursive: true })
  fs.mkdirSync(BUILD, { recursive: true })

  const src = decodeIcoDib(fs.readFileSync(SRC_ICO))
  console.log('source whale:', src.w + 'x' + src.h)

  const whale256 = resample(src.img, src.w, src.h, 256, 256)
  fs.writeFileSync(path.join(ASSETS, 'whale.png'), encodePNG(256, 256, whale256))

  fs.writeFileSync(path.join(ASSETS, 'icon-256.png'), encodePNG(256, 256, whale256))
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), encodePNG(512, 512, resample(src.img, src.w, src.h, 512, 512)))
  // Tech-styled tray icons: navy squircle + neon gradient ring + white whale.
  const techBlue = { from: [34, 211, 238], to: [77, 107, 254] }
  const techRed = { from: [255, 107, 107], to: [255, 45, 85] }
  fs.writeFileSync(path.join(ASSETS, 'tray.png'), encodePNG(32, 32, renderTechTray(src, 32, techBlue)))
  fs.writeFileSync(path.join(ASSETS, 'tray@2x.png'), encodePNG(64, 64, renderTechTray(src, 64, techBlue)))
  fs.writeFileSync(path.join(ASSETS, 'tray-red.png'), encodePNG(32, 32, renderTechTray(src, 32, techRed)))
  fs.writeFileSync(path.join(ASSETS, 'tray-red@2x.png'), encodePNG(64, 64, renderTechTray(src, 64, techRed)))

  const ico = encodeICO([16, 24, 32, 48, 64, 128, 256].map(s => ({ size: s, png: encodePNG(s, s, resample(src.img, src.w, src.h, s, s)) })))
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico)

  console.log('wrote official whale icon set (icon.png 512, tray 32, icon.ico 7 sizes)')
}

main()
