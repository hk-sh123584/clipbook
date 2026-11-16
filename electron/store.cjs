const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const MAX_ITEMS = 1000
const MAX_IMAGES = 100
const MAX_TEXT_LENGTH = 100 * 1024
const MAX_TEXT_PREVIEW = 8 * 1024
const URL_RE = /^https?:\/\/\S+$/i
const CODE_HINT = /[{};]\s*(?:'|"|`)?\s*$|\n\s+(?:const|let|function|import|def|class)\b/

function detectKind(text) {
  const trimmed = text.trim()
  if (URL_RE.test(trimmed)) return 'link'
  if (text.includes('\n') && CODE_HINT.test(text)) return 'code'
  return 'text'
}

class ClipStore {
  constructor(dir) {
    this.file = path.join(dir, 'clips.json')
    this.backupFile = `${this.file}.bak`
    this.imagesDir = path.join(dir, 'images')
    this.textsDir = path.join(dir, 'texts')
    this.items = []
    this.saveTimer = null
    this.read()
  }

  normalizeItems(data) {
    if (!Array.isArray(data)) return []
    return data
      .filter((it) => it && typeof it.id === 'string' && (typeof it.text === 'string' || it.kind === 'image'))
      .map((it) => {
        const truncated = Boolean(it.truncated) && fs.existsSync(path.join(this.textsDir, `${it.id}.txt`))
        return {
          id: it.id,
          text: typeof it.text === 'string' ? it.text : '',
          kind: it.kind || 'text',
          image: it.image,
          hash: it.hash,
          pinned: Boolean(it.pinned),
          createdAt: Number(it.createdAt) || Date.now(),
          copiedCount: Number(it.copiedCount) || 0,
          truncated: truncated || undefined,
        }
      })
      .filter((it) => it.kind !== 'image' || this.imageFileExists(it))
      .slice(0, MAX_ITEMS)
  }

  read() {
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      // 主文件损坏，尝试从备份恢复
      try {
        parsed = JSON.parse(fs.readFileSync(this.backupFile, 'utf8'))
        fs.copyFileSync(this.backupFile, this.file)
        console.warn('[store] 主文件损坏，已从备份恢复')
      } catch {
        // 备份也损坏，将损坏文件另存以防被覆盖丢失
        try {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          fs.renameSync(this.file, `${this.file}.corrupt-${stamp}`)
        } catch {}
        parsed = []
      }
    }
    this.items = this.normalizeItems(parsed)
    this.sort()
    this.enforceItemLimit()
    this.enforceImageLimit()
  }

  imageFileExists(item) {
    return Boolean(item.image && item.image.file && fs.existsSync(path.join(this.imagesDir, item.image.file)))
  }

  sort() {
    this.items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt)
  }

  enforceItemLimit() {
    while (this.items.length > MAX_ITEMS) {
      // 优先淘汰非 pinned 项，全部 pinned 时才淘汰最旧的 pinned 项
      let index = -1
      for (let i = this.items.length - 1; i >= 0; i--) {
        if (!this.items[i].pinned) {
          index = i
          break
        }
      }
      if (index === -1) index = this.items.length - 1
      const [removed] = this.items.splice(index, 1)
      if (removed.kind === 'image') this.deleteImageFile(removed)
      this.deleteTextFile(removed)
    }
  }

  persist() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flush(), 250)
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      if (fs.existsSync(this.file)) {
        fs.copyFileSync(this.file, this.backupFile)
      }
      fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2), 'utf8')
    } catch (err) {
      console.error('[store] 写入失败', err)
    }
  }

  add(text) {
    const trimmed = text.trim()
    if (!trimmed) return false
    const oversized = trimmed.length > MAX_TEXT_LENGTH
    const preview = oversized ? trimmed.slice(0, MAX_TEXT_PREVIEW) : trimmed
    const existing = this.items.findIndex((it) => it.text === preview)
    if (existing >= 0) {
      const [item] = this.items.splice(existing, 1)
      item.createdAt = Date.now()
      this.items.unshift(item)
    } else {
      const id = randomUUID()
      if (oversized) {
        try {
          fs.mkdirSync(this.textsDir, { recursive: true })
          fs.writeFileSync(path.join(this.textsDir, `${id}.txt`), text, 'utf8')
        } catch (err) {
          console.error('[store] 长文本写入失败', err)
        }
      }
      this.items.unshift({
        id,
        text: preview,
        kind: detectKind(preview),
        pinned: false,
        createdAt: Date.now(),
        copiedCount: 0,
        truncated: oversized || undefined,
      })
    }
    this.sort()
    this.enforceItemLimit()
    this.persist()
    return true
  }

  getFullText(id) {
    const item = this.items.find((it) => it.id === id)
    if (!item) return null
    if (!item.truncated) return item.text
    try {
      return fs.readFileSync(path.join(this.textsDir, `${id}.txt`), 'utf8')
    } catch {
      return item.text
    }
  }

  deleteTextFile(item) {
    if (!item || !item.truncated) return
    try {
      fs.unlinkSync(path.join(this.textsDir, `${item.id}.txt`))
    } catch {
      // 文件已不存在时忽略
    }
  }

  addFiles(paths) {
    const list = (paths || []).map((item) => String(item).trim()).filter(Boolean)
    if (!list.length) return false
    const text = list.join('\n')
    const existing = this.items.findIndex((it) => it.kind === 'file' && it.text === text)
    if (existing >= 0) {
      const [item] = this.items.splice(existing, 1)
      item.createdAt = Date.now()
      this.items.unshift(item)
    } else {
      this.items.unshift({
        id: randomUUID(),
        text,
        kind: 'file',
        pinned: false,
        createdAt: Date.now(),
        copiedCount: 0,
      })
    }
    this.sort()
    this.enforceItemLimit()
    this.persist()
    return true
  }

  exportTo(dir) {
    fs.mkdirSync(dir, { recursive: true })
    const imagesOut = path.join(dir, 'images')
    if (this.items.some((it) => it.kind === 'image')) fs.mkdirSync(imagesOut, { recursive: true })
    const textsOut = path.join(dir, 'texts')
    if (this.items.some((it) => it.truncated)) fs.mkdirSync(textsOut, { recursive: true })

    for (const item of this.items) {
      if (item.kind === 'image' && item.image) {
        for (const name of [item.image.file, item.image.thumbFile]) {
          if (!name) continue
          const from = path.join(this.imagesDir, name)
          const to = path.join(imagesOut, name)
          if (fs.existsSync(from) && !fs.existsSync(to)) {
            try {
              fs.copyFileSync(from, to)
            } catch (err) {
              console.error('[export] 图片复制失败', err)
            }
          }
        }
      }
      if (item.truncated) {
        const from = path.join(this.textsDir, `${item.id}.txt`)
        const to = path.join(textsOut, `${item.id}.txt`)
        if (fs.existsSync(from) && !fs.existsSync(to)) {
          try {
            fs.copyFileSync(from, to)
          } catch (err) {
            console.error('[export] 长文本复制失败', err)
          }
        }
      }
    }

    fs.writeFileSync(
      path.join(dir, 'clips.json'),
      JSON.stringify({ version: 1, exportedAt: Date.now(), items: this.items }, null, 2),
      'utf8',
    )
    return { count: this.items.length }
  }

  importFrom(dir) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'clips.json'), 'utf8'))
    const incoming = Array.isArray(raw) ? raw : Array.isArray(raw.items) ? raw.items : []
    const imagesIn = path.join(dir, 'images')
    const textsIn = path.join(dir, 'texts')
    let added = 0
    let skipped = 0

    for (const entry of incoming) {
      if (!entry || typeof entry.id !== 'string') {
        skipped += 1
        continue
      }

      if (entry.kind === 'image') {
        if (!entry.image || !entry.hash || this.items.some((it) => it.kind === 'image' && it.hash === entry.hash)) {
          skipped += 1
          continue
        }
        const source = path.join(imagesIn, entry.image.file)
        if (!fs.existsSync(source)) {
          skipped += 1
          continue
        }
        try {
          fs.mkdirSync(this.imagesDir, { recursive: true })
          fs.copyFileSync(source, path.join(this.imagesDir, entry.image.file))
          const thumbSource = entry.image.thumbFile && path.join(imagesIn, entry.image.thumbFile)
          if (thumbSource && fs.existsSync(thumbSource)) {
            fs.copyFileSync(thumbSource, path.join(this.imagesDir, entry.image.thumbFile))
          }
        } catch (err) {
          console.error('[import] 图片复制失败', err)
          skipped += 1
          continue
        }
        this.items.push({
          id: randomUUID(),
          text: typeof entry.text === 'string' ? entry.text : '',
          kind: 'image',
          image: entry.image,
          hash: String(entry.hash),
          pinned: Boolean(entry.pinned),
          createdAt: Number(entry.createdAt) || Date.now(),
          copiedCount: Number(entry.copiedCount) || 0,
        })
        added += 1
        continue
      }

      const text = typeof entry.text === 'string' ? entry.text.trim() : ''
      if (!text || this.items.some((it) => it.kind !== 'image' && it.text === text)) {
        skipped += 1
        continue
      }
      const newId = randomUUID()
      let truncated = Boolean(entry.truncated)
      if (truncated) {
        const source = path.join(textsIn, `${entry.id}.txt`)
        if (!fs.existsSync(source)) {
          truncated = false
        } else {
          try {
            fs.mkdirSync(this.textsDir, { recursive: true })
            fs.copyFileSync(source, path.join(this.textsDir, `${newId}.txt`))
          } catch (err) {
            console.error('[import] 长文本复制失败', err)
            truncated = false
          }
        }
      }
      this.items.push({
        id: newId,
        text,
        kind: entry.kind || detectKind(text),
        pinned: Boolean(entry.pinned),
        createdAt: Number(entry.createdAt) || Date.now(),
        copiedCount: Number(entry.copiedCount) || 0,
        truncated: truncated || undefined,
      })
      added += 1
    }

    this.sort()
    this.enforceItemLimit()
    this.enforceImageLimit()
    this.persist()
    return { added, skipped }
  }

  addImage(png, hash, width, height, thumbnailPng) {
    const existing = this.items.find((it) => it.kind === 'image' && it.hash === hash)
    if (existing) {
      existing.createdAt = Date.now()
      this.sort()
      this.persist()
      return true
    }

    const file = `${hash}.png`
    try {
      fs.mkdirSync(this.imagesDir, { recursive: true })
      fs.writeFileSync(path.join(this.imagesDir, file), png)
    } catch (err) {
      console.error('[store] 图片写入失败', err)
      return false
    }

    let thumbFile
    if (thumbnailPng) {
      thumbFile = `${hash}-thumb.png`
      try {
        fs.writeFileSync(path.join(this.imagesDir, thumbFile), thumbnailPng)
      } catch (err) {
        console.error('[store] 缩略图写入失败', err)
        thumbFile = undefined
      }
    }

    this.items.unshift({
      id: randomUUID(),
      text: `图片 ${width} × ${height}`,
      kind: 'image',
      image: { file, thumbFile, width, height, bytes: png.length },
      hash,
      pinned: false,
      createdAt: Date.now(),
      copiedCount: 0,
    })
    this.sort()
    this.enforceItemLimit()
    this.enforceImageLimit()
    this.persist()
    return true
  }

  enforceImageLimit() {
    const countImages = () => this.items.filter((it) => it.kind === 'image').length
    while (countImages() > MAX_IMAGES) {
      let index = -1
      for (let i = this.items.length - 1; i >= 0; i--) {
        if (this.items[i].kind === 'image' && !this.items[i].pinned) {
          index = i
          break
        }
      }
      if (index === -1) {
        for (let i = this.items.length - 1; i >= 0; i--) {
          if (this.items[i].kind === 'image') {
            index = i
            break
          }
        }
      }
      if (index === -1) return
      const [removed] = this.items.splice(index, 1)
      this.deleteImageFile(removed)
    }
  }

  deleteImageFile(item) {
    if (!item || !item.image || !item.image.file) return
    const shared = this.items.some((it) => it.image && it.image.file === item.image.file)
    if (shared) return
    try {
      fs.unlinkSync(path.join(this.imagesDir, item.image.file))
    } catch {
      // 文件已不存在时忽略
    }
    if (item.image.thumbFile) {
      try {
        fs.unlinkSync(path.join(this.imagesDir, item.image.thumbFile))
      } catch {
        // 文件已不存在时忽略
      }
    }
  }

  remove(id) {
    const index = this.items.findIndex((it) => it.id === id)
    if (index === -1) return this.items
    const [removed] = this.items.splice(index, 1)
    this.deleteImageFile(removed)
    this.deleteTextFile(removed)
    this.persist()
    return this.items
  }

  togglePin(id) {
    const item = this.items.find((it) => it.id === id)
    if (item) {
      item.pinned = !item.pinned
      this.sort()
      this.persist()
    }
    return this.items
  }

  markCopied(id) {
    const item = this.items.find((it) => it.id === id)
    if (item) {
      item.copiedCount += 1
      this.persist()
    }
  }

  clear() {
    const removed = this.items
    this.items = []
    for (const item of removed) {
      if (item.kind === 'image') this.deleteImageFile(item)
      this.deleteTextFile(item)
    }
    this.persist()
    return this.items
  }
}

module.exports = { ClipStore }
