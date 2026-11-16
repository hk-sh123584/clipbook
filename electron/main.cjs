const path = require('node:path')
const fs = require('node:fs')
const { execFile } = require('node:child_process')
const { createHash } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  screen,
  Tray,
} = require('electron')
const { ClipStore } = require('./store.cjs')

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)
const HOTKEY = 'Control+Shift+V'
const HIDDEN_WINDOW_TTL = 5000
const CLEAR_UNDO_TTL = 10000

let win = null
let tray = null
let store = null
let lastText = ''
let lastImageKey = ''
let lastFilesKey = ''
let pollTimer = null
let hiddenWindowTimer = null
let clearUndoTimer = null
let savedWindowBounds = null
let savedWindowMaximized = false
let alwaysOnTop = false
let showWindowWhenReady = false

protocol.registerSchemesAsPrivileged([
  { scheme: 'clipimg', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

// 界面以静态内容为主，软件渲染可显著降低 GPU 进程内存。
app.disableHardwareAcceleration()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
}

function broadcast() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('clips:updated', store.items)
  }
}

// 把追踪状态对齐到“剪贴板当前内容”，而不是清空。
// 清空/删除后若置空追踪，下一轮轮询会把剪贴板上残留的内容当成新内容重新录回来。
function syncClipboardTrackers() {
  const files = readClipboardFiles()
  if (files.length) {
    lastFilesKey = files.join('|')
    lastText = ''
    lastImageKey = ''
    return
  }
  const text = clipboard.readText()
  lastFilesKey = ''
  if (text) {
    lastText = text
    lastImageKey = ''
    return
  }
  lastText = ''
  if (clipboard.availableFormats().some((format) => format.startsWith('image/'))) {
    const image = clipboard.readImage()
    lastImageKey = image.isEmpty() ? '' : imageKey(image).key
  } else {
    lastImageKey = ''
  }
}

function clearHistory() {
  store.clear()
  // 清空只删记录，不把剪贴板上现有内容重新录回
  syncClipboardTrackers()
  broadcast()
  // 撤销窗口结束后才真正删除被清空的图片与长文本
  if (clearUndoTimer) clearTimeout(clearUndoTimer)
  clearUndoTimer = setTimeout(() => {
    clearUndoTimer = null
    store.commitClear()
  }, CLEAR_UNDO_TTL)
}

function undoClear() {
  if (clearUndoTimer) {
    clearTimeout(clearUndoTimer)
    clearUndoTimer = null
  }
  store.undoClear()
  syncClipboardTrackers()
  broadcast()
}

function assetPath(name) {
  return path.join(__dirname, '..', 'assets', name)
}

function imageKey(image) {
  const size = image.getSize()
  const hash = createHash('sha1').update(image.toBitmap()).digest('hex')
  return { key: `${size.width}x${size.height}-${hash}`, hash, width: size.width, height: size.height }
}

function createThumbnail(image) {
  const { width, height } = image.getSize()
  const scale = Math.min(1, 480 / width, 320 / height)
  return image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  })
}

function ensureImageThumbnails() {
  let changed = false
  for (const item of store.items) {
    if (item.kind !== 'image' || !item.image) continue
    const thumbFile = `${path.parse(item.image.file).name}-thumb.png`
    const thumbPath = path.join(store.imagesDir, thumbFile)
    if (item.image.thumbFile === thumbFile && fs.existsSync(thumbPath)) continue

    try {
      const image = nativeImage.createFromPath(path.join(store.imagesDir, item.image.file))
      if (image.isEmpty()) continue
      fs.writeFileSync(thumbPath, createThumbnail(image).toPNG())
      item.image.thumbFile = thumbFile
      changed = true
    } catch (err) {
      console.error('[thumbnail] 生成失败', err)
    }
  }
  if (changed) {
    store.persist()
    broadcast()
  }
}

function registerImageProtocol() {
  protocol.handle('clipimg', async (request) => {
    try {
      const name = path.basename(decodeURIComponent(new URL(request.url).pathname))
      if (!/^[0-9a-f]{40}(?:-thumb)?\.png$/.test(name)) {
        return new Response('not found', { status: 404 })
      }
      return await net.fetch(pathToFileURL(path.join(store.imagesDir, name)).toString())
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

function readClipboardFiles() {
  try {
    const buffer = clipboard.readBuffer('FileNameW')
    if (!buffer || buffer.length < 2) return []
    return buffer
      .toString('utf16le')
      .split('\u0000')
      .map((name) => name.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function pollClipboard() {
  const files = readClipboardFiles()
  if (files.length) {
    const key = files.join('|')
    if (key !== lastFilesKey) {
      lastFilesKey = key
      lastText = ''
      lastImageKey = ''
      if (store.addFiles(files)) broadcast()
    }
    return
  }

  const text = clipboard.readText()
  if (text) {
    if (text !== lastText) {
      lastText = text
      // 文字变了，之前记下的图片 / 文件标记失效，否则再次复制同样内容不会被记录
      lastImageKey = ''
      lastFilesKey = ''
      if (store.add(text)) broadcast()
    }
    return
  }
  if (!clipboard.availableFormats().some((format) => format.startsWith('image/'))) {
    // 剪贴板为空，清掉标记，之后重新复制同样内容仍能记录
    lastText = ''
    lastFilesKey = ''
    return
  }

  const image = clipboard.readImage()
  if (image.isEmpty()) return
  const info = imageKey(image)
  if (info.key === lastImageKey) return

  lastImageKey = info.key
  lastText = ''
  lastFilesKey = ''
  const thumbnail = createThumbnail(image).toPNG()
  if (store.addImage(image.toPNG(), info.hash, info.width, info.height, thumbnail)) broadcast()
}

function createWindow() {
  const current = new BrowserWindow({
    width: savedWindowBounds?.width || 460,
    height: savedWindowBounds?.height || 600,
    minWidth: 360,
    minHeight: 420,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: true,
    },
  })
  win = current

  current.once('ready-to-show', () => {
    if (win === current && showWindowWhenReady) presentWindow()
  })

  current.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault()
      hideWindow()
    }
  })

  current.on('closed', () => {
    if (win === current) win = null
  })

  current.on('maximize', () => {
    savedWindowMaximized = true
  })

  current.on('unmaximize', () => {
    savedWindowMaximized = false
  })

  if (isDev) {
    current.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    current.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

function positionWindow() {
  const cursor = screen.getCursorScreenPoint()
  const area = screen.getDisplayNearestPoint(cursor).workArea
  const [w, h] = win.getSize()
  const x = Math.round(area.x + (area.width - w) / 2)
  const y = Math.round(area.y + area.height * 0.18)
  win.setPosition(
    Math.max(area.x, Math.min(x, area.x + area.width - w)),
    Math.max(area.y, Math.min(y, area.y + area.height - h)),
  )
}

function presentWindow() {
  if (!win || win.isDestroyed()) return
  showWindowWhenReady = false
  if (savedWindowMaximized) {
    const area = screen.getDisplayMatching(savedWindowBounds || win.getBounds()).workArea
    win.setBounds(area)
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send('window:shown')
}

function showWindow() {
  if (hiddenWindowTimer) {
    clearTimeout(hiddenWindowTimer)
    hiddenWindowTimer = null
  }
  showWindowWhenReady = true

  if (!win || win.isDestroyed()) {
    createWindow()
    if (savedWindowBounds) win.setBounds(savedWindowBounds)
    else {
      positionWindow()
      savedWindowBounds = win.getBounds()
    }
    return
  }
  presentWindow()
}

function hideWindow() {
  if (!win || win.isDestroyed()) return
  const current = win
  if (current.isMaximized()) {
    savedWindowMaximized = true
    savedWindowBounds = current.getNormalBounds()
  } else if (!savedWindowMaximized) {
    savedWindowBounds = current.getBounds()
  }
  showWindowWhenReady = false
  current.hide()

  if (hiddenWindowTimer) clearTimeout(hiddenWindowTimer)
  hiddenWindowTimer = setTimeout(() => {
    if (win === current && !current.isDestroyed() && !current.isVisible()) {
      current.destroy()
    }
    hiddenWindowTimer = null
  }, HIDDEN_WINDOW_TTL)
}

function toggleWindow() {
  if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) hideWindow()
  else showWindow()
}

function loginItemPath() {
  // 便携版实际运行在临时目录，自启必须指向用户双击的那个 exe。
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
}

function isAutoStartEnabled() {
  try {
    return app.getLoginItemSettings({ path: loginItemPath() }).openAtLogin
  } catch {
    return false
  }
}

function setAutoStart(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, path: loginItemPath() })
  } catch (err) {
    console.error('[autostart] 设置失败', err)
  }
  refreshTrayMenu()
}

async function chooseFolder(title) {
  const options = { title, properties: ['openDirectory', 'createDirectory'] }
  const result = win && !win.isDestroyed()
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) return null
  return result.filePaths[0]
}

async function exportRecords() {
  const dir = await chooseFolder('选择导出文件夹')
  if (!dir) return { ok: false, canceled: true }
  try {
    const { count } = store.exportTo(dir)
    return { ok: true, count }
  } catch (err) {
    console.error('[export] 导出失败', err)
    return { ok: false, error: String(err.message || err) }
  }
}

async function importRecords() {
  const dir = await chooseFolder('选择导入文件夹（含 clips.json）')
  if (!dir) return { ok: false, canceled: true }
  try {
    const { added, skipped } = store.importFrom(dir)
    broadcast()
    return { ok: true, added, skipped }
  } catch (err) {
    console.error('[import] 导入失败', err)
    return { ok: false, error: String(err.message || err) }
  }
}

function refreshTrayMenu() {
  if (!tray) return
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示剪贴簿', click: () => showWindow() },
      { type: 'separator' },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: isAutoStartEnabled(),
        click: (item) => setAutoStart(item.checked),
      },
      { label: '导出记录…', click: () => { exportRecords() } },
      { label: '导入记录…', click: () => { importRecords() } },
      { type: 'separator' },
      { label: '清空历史', click: () => clearHistory() },
      { type: 'separator' },
      { label: '退出', click: () => { app.isQuitting = true; app.quit() } },
    ]),
  )
}

function createTray() {
  const icon = nativeImage.createFromPath(assetPath('tray.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('剪贴簿 · Ctrl+Shift+V')
  refreshTrayMenu()
  tray.on('click', () => toggleWindow())
}

function promoteTrayIcon(callback) {
  if (process.platform !== 'win32') return callback(false)
  // 系统没有提供设置托盘位置的接口，只能改写用户级托盘配置。
  // 系统的托盘记录条目要过几秒才出现，这里在系统内部轮询等待。
  const exe = process.execPath
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$root = 'HKCU:\\Control Panel\\NotifyIconSettings'",
    `$exe = '${exe.replace(/'/g, "''")}'`,
    '$deadline = (Get-Date).AddSeconds(40)',
    'while ((Get-Date) -lt $deadline) {',
    '  $found = $false',
    '  Get-ChildItem -LiteralPath $root | ForEach-Object {',
    '    $path = (Get-ItemProperty -LiteralPath $_.PSPath).ExecutablePath',
    '    if ($path -and $path -eq $exe) {',
    '      New-ItemProperty -LiteralPath $_.PSPath -Name IsPromoted -Value 1 -PropertyType DWord -Force | Out-Null',
    '      $found = $true',
    '    }',
    '  }',
    "  if ($found) { Write-Output 'MATCHED'; break }",
    '  Start-Sleep -Milliseconds 800',
    '}',
  ].join('\n')

  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    { windowsHide: true, timeout: 60000 },
    (_error, stdout) => callback(String(stdout || '').includes('MATCHED')),
  )
}

function initTrayPlacement() {
  const stateFile = path.join(app.getPath('userData'), 'tray-state.json')
  let initialized = false
  try {
    initialized = Boolean(JSON.parse(fs.readFileSync(stateFile, 'utf8')).initialized)
  } catch {
    initialized = false
  }
  if (initialized) return

  promoteTrayIcon((matched) => {
    if (!matched) return
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      fs.writeFileSync(stateFile, JSON.stringify({ initialized: true }, null, 2), 'utf8')
    } catch (err) {
      console.error('[tray] 状态写入失败', err)
    }
  })
}

function registerIpc() {
  ipcMain.handle('clips:list', () => store.items)

  ipcMain.handle('clips:copy', (_event, id) => {
    const item = store.items.find((it) => it.id === id)
    if (!item) return store.items

    if (item.kind === 'image' && item.image) {
      const image = nativeImage.createFromPath(path.join(store.imagesDir, item.image.file))
      if (image.isEmpty()) return store.items
      clipboard.writeImage(image)
      lastText = ''
      lastFilesKey = ''
      lastImageKey = imageKey(image).key
    } else {
      const fullText = store.getFullText(id) || item.text
      clipboard.writeText(fullText)
      lastText = fullText
      lastFilesKey = ''
      lastImageKey = ''
    }

    store.markCopied(id)
    return store.items
  })

  ipcMain.handle('clips:delete', (_event, id) => {
    const items = store.remove(id)
    // 删掉的记录不应在下一轮轮询被重新录回
    syncClipboardTrackers()
    broadcast()
    return items
  })

  ipcMain.handle('clips:deleteMany', (_event, ids) => {
    if (!Array.isArray(ids) || !ids.length) return store.items
    store.removeMany(ids)
    syncClipboardTrackers()
    broadcast()
    return store.items
  })

  ipcMain.handle('clips:togglePin', (_event, id) => {
    const items = store.togglePin(id)
    broadcast()
    return items
  })

  ipcMain.handle('clips:toggleTop', (_event, id) => {
    const items = store.toggleTop(id)
    broadcast()
    return items
  })

  ipcMain.handle('clips:clear', () => {
    clearHistory()
    return store.items
  })

  ipcMain.handle('clips:undoClear', () => {
    undoClear()
    return store.items
  })

  ipcMain.handle('window:hide', () => {
    hideWindow()
  })

  ipcMain.handle('window:alwaysOnTop', () => {
    if (win && !win.isDestroyed()) {
      alwaysOnTop = !win.isAlwaysOnTop()
      win.setAlwaysOnTop(alwaysOnTop)
    }
    return alwaysOnTop
  })

  ipcMain.on('window:control', (_event, action) => {
    if (!win) return
    if (action === 'minimize') {
      hideWindow()
    } else if (action === 'maximize') {
      if (savedWindowMaximized) {
        savedWindowMaximized = false
        if (savedWindowBounds) win.setBounds(savedWindowBounds)
      } else {
        savedWindowBounds = win.getNormalBounds()
        const area = screen.getDisplayMatching(win.getBounds()).workArea
        savedWindowMaximized = true
        win.setBounds(area)
      }
    } else if (action === 'close') {
      win.close()
    }
  })

  ipcMain.on('window:resize', (_event, { width, height }) => {
    if (!win || !Number.isFinite(width) || !Number.isFinite(height)) return
    const bounds = win.getBounds()
    const area = screen.getDisplayMatching(bounds).workArea
    const nextWidth = Math.round(Math.min(Math.max(width, 360), area.width))
    const nextHeight = Math.round(Math.min(Math.max(height, 420), area.height))
    const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - nextWidth)
    const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - nextHeight)
    win.setBounds({ x, y, width: nextWidth, height: nextHeight })
  })

  ipcMain.handle('app:info', () => ({
    hotkey: HOTKEY,
    version: app.getVersion(),
    dataFile: store.file,
    alwaysOnTop: Boolean(win && !win.isDestroyed() && win.isAlwaysOnTop()),
  }))

  ipcMain.handle('data:export', () => exportRecords())
  ipcMain.handle('data:import', () => importRecords())
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.clipbook.app')
  store = new ClipStore(app.getPath('userData'))
  registerImageProtocol()
  registerIpc()
  createTray()
  initTrayPlacement()
  setTimeout(ensureImageThumbnails, 500)

  if (!globalShortcut.register(HOTKEY, toggleWindow)) {
    console.warn(`[hotkey] ${HOTKEY} 注册失败，可能被其他程序占用`)
  }

  lastText = clipboard.readText()
  if (!lastText) {
    const current = clipboard.readImage()
    if (!current.isEmpty()) lastImageKey = imageKey(current).key
  }
  pollTimer = setInterval(pollClipboard, 400)
})

app.on('window-all-closed', () => {
  // 常驻托盘，不随窗口关闭退出
})

app.on('will-quit', () => {
  if (pollTimer) clearInterval(pollTimer)
  if (hiddenWindowTimer) clearTimeout(hiddenWindowTimer)
  if (clearUndoTimer) clearTimeout(clearUndoTimer)
  globalShortcut.unregisterAll()
  if (store) {
    // 退出时未撤销的清空立即落地，避免遗孤图片与长文本文件
    store.commitClear()
    store.flush()
  }
})
