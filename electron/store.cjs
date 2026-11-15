const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const MAX_ITEMS = 1000
const MAX_IMAGES = 100
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
    this.items = []
    this.saveTimer = null
    this.read()
  }

  read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (Array.isArray(data)) {
        this.items = data
          .filter((it) => it && typeof it.id === 'string' && (typeof it.text === 'string' || it.kind === 'image'))
          .map((it) => ({
            id: it.id,
            text: typeof it.text === 'string' ? it.text : '',
            kind: it.kind || 'text',
            image: it.image,
            hash: it.hash,
            pinned: Boolean(it.pinned),
            createdAt: Number(it.createdAt) || Date.now(),
            copiedCount: Number(it.copiedCount) || 0,
          }))
          .filter((it) => it.kind !== 'image' || this.imageFileExists(it))
          .slice(0, MAX_ITEMS)
      }
    } catch {
      this.items = []
    }
    this.sort()
    this.enforceImageLimit()
  }

  imageFileExists(item) {
    return Boolean(item.image && item.image.file && fs.existsSync(path.join(this.imagesDir, item.image.file)))
  }

  sort() {
    this.items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt)
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
    const existing = this.items.findIndex((it) => it.text === trimmed)
    if (existing >= 0) {
      const [item] = this.items.splice(existing, 1)
      item.createdAt = Date.now()
      this.items.unshift(item)
    } else {
      this.items.unshift({
        id: randomUUID(),
        text: trimmed,
        kind: detectKind(trimmed),
        pinned: false,
        createdAt: Date.now(),
        copiedCount: 0,
      })
      if (this.items.length > MAX_ITEMS) this.items.length = MAX_ITEMS
    }
    this.sort()
    this.persist()
    return true
  }

  addImage(png, hash, width, height, thumbnailPng) {
    const existing = this.items.find((it) => it.kind === 'image' && it.hash === hash)
    if (existing) {
      existing.createdAt = Date.now()
      this.sort()
      this.persist()
      return false
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
    if (this.items.length > MAX_ITEMS) {
      const dropped = this.items.pop()
      this.deleteImageFile(dropped)
    }
    this.sort()
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
    }
    this.persist()
    return this.items
  }
}

module.exports = { ClipStore }
