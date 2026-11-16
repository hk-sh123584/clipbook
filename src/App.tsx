import { useEffect, useMemo, useRef, useState } from 'react'
import AutoSizer from 'react-virtualized-auto-sizer'
import { VariableSizeList } from 'react-window'
import type { ClipItem } from './types'

const KIND_LABEL: Record<ClipItem['kind'], string> = {
  text: '',
  link: '链接',
  code: '代码',
  image: '图片',
  file: '文件',
}

type Filter = 'all' | 'link' | 'image' | 'pinned' | 'today'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'link', label: '链接' },
  { key: 'image', label: '图片' },
  { key: 'pinned', label: '收藏' },
  { key: 'today', label: '今天' },
]

function isToday(ts: number) {
  const date = new Date(ts)
  const now = new Date()
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  )
}

function pad(n: number) {
  return n < 10 ? `0${n}` : String(n)
}

function formatTime(ts: number) {
  const date = new Date(ts)
  const now = new Date()
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return hm

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return `昨天 ${hm}`
  }
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hm}`
}

export default function App() {
  const [items, setItems] = useState<ClipItem[]>([])
  const [query, setQuery] = useState('')
  const [searchText, setSearchText] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [active, setActive] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [notice, setNotice] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [preview, setPreview] = useState<ClipItem | null>(null)
  const [undo, setUndo] = useState<{ count: number; left: number } | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [confirmingBatch, setConfirmingBatch] = useState(false)
  const [onTop, setOnTop] = useState(false)
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const copiedTimer = useRef<number | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<VariableSizeList>(null)
  const resizeStart = useRef<{ x: number; y: number; width: number; height: number } | null>(null)

  // 搜索防抖：输入 200ms 后才真正过滤，避免大量记录时每次按键全量扫描
  useEffect(() => {
    const timer = window.setTimeout(() => setSearchText(query), 200)
    return () => window.clearTimeout(timer)
  }, [query])

  const filtered = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    return items.filter((item) => {
      if (filter === 'link' && item.kind !== 'link') return false
      if (filter === 'image' && item.kind !== 'image') return false
      if (filter === 'pinned' && !item.pinned) return false
      if (filter === 'today' && !isToday(item.createdAt)) return false
      if (!q) return true
      return item.text.toLowerCase().includes(q)
    })
  }, [items, searchText, filter])

  useEffect(() => {
    const api = window.clipbook
    if (!api) return
    api.list().then(setItems)
    api.info().then((info) => setOnTop(info.alwaysOnTop)).catch(() => {})
    const offUpdate = api.onUpdate(setItems)
    const offShown = api.onShown(() => {
      setQuery('')
      setSearchText('')
      setActive(0)
      setPreview(null)
      setUndo(null)
      window.setTimeout(() => inputRef.current?.focus(), 30)
    })
    window.setTimeout(() => inputRef.current?.focus(), 60)
    return () => {
      offUpdate()
      offShown()
    }
  }, [])

  useEffect(() => {
    setActive(0)
    setConfirming(false)
    setSelected([])
    setConfirmingBatch(false)
    listRef.current?.scrollTo(0)
  }, [query, filter])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 2600)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    listRef.current?.resetAfterIndex(0, false)
  }, [filtered])

  useEffect(() => {
    listRef.current?.scrollToItem(active, 'smart')
  }, [active, filtered.length])

  useEffect(() => {
    if (!confirming) return
    const timer = window.setTimeout(() => setConfirming(false), 3000)
    return () => window.clearTimeout(timer)
  }, [confirming])

  const undoing = undo !== null
  useEffect(() => {
    if (!undoing) return
    const timer = window.setInterval(() => {
      setUndo((state) => {
        if (!state) return state
        if (state.left <= 1) return null
        return { ...state, left: state.left - 1 }
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [undoing])

  useEffect(() => {
    if (!confirmingBatch) return
    const timer = window.setTimeout(() => setConfirmingBatch(false), 3000)
    return () => window.clearTimeout(timer)
  }, [confirmingBatch])

  const copyItem = async (id: string) => {
    const api = window.clipbook
    if (!api) return
    const next = await api.copy(id)
    setItems(next)
    setCopiedId(id)
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopiedId(null), 1300)
  }

  const removeItem = async (id: string) => {
    const api = window.clipbook
    if (!api) return
    const next = await api.remove(id)
    setItems(next)
  }

  const togglePin = async (id: string) => {
    const api = window.clipbook
    if (!api) return
    const next = await api.togglePin(id)
    setItems(next)
  }

  const toggleTop = async (id: string) => {
    const api = window.clipbook
    if (!api) return
    const next = await api.toggleTop(id)
    setItems(next)
  }

  const clearAll = async () => {
    const api = window.clipbook
    if (!api) return
    if (!confirming) {
      setConfirming(true)
      return
    }
    const removedCount = items.filter((item) => !item.pinned).length
    const next = await api.clear()
    setItems(next)
    setConfirming(false)
    if (removedCount > 0) setUndo({ count: removedCount, left: 10 })
    else setNotice('没有可清空的记录')
  }

  const undoClear = async () => {
    const api = window.clipbook
    if (!api) return
    const next = await api.undoClear()
    setItems(next)
    setUndo(null)
    setNotice('已撤销清空')
  }

  const toggleWindowTop = async () => {
    const api = window.clipbook
    if (!api) return
    setOnTop(await api.toggleAlwaysOnTop())
  }

  const exitSelect = () => {
    setSelectMode(false)
    setSelected([])
    setConfirmingBatch(false)
  }

  const enterSelect = () => {
    setSelectMode(true)
    setSelected([])
    setConfirmingBatch(false)
    setPreview(null)
  }

  const toggleSelect = (id: string) => {
    setConfirmingBatch(false)
    setSelected((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]))
  }

  const selectAllFiltered = () => {
    setSelected(filtered.map((item) => item.id))
    setConfirmingBatch(false)
  }

  const deleteSelected = async () => {
    const api = window.clipbook
    if (!api || !selected.length) return
    if (!confirmingBatch) {
      setConfirmingBatch(true)
      return
    }
    const count = selected.length
    const next = await api.removeMany(selected)
    setItems(next)
    setNotice(`已删除 ${count} 条`)
    exitSelect()
  }

  const exportData = async () => {
    const api = window.clipbook
    if (!api) return
    const result = await api.exportData()
    if (result.ok) setNotice(`已导出 ${result.count ?? 0} 条记录`)
    else if (!result.canceled) setNotice('导出失败，请换个文件夹重试')
  }

  const importData = async () => {
    const api = window.clipbook
    if (!api) return
    const result = await api.importData()
    if (!result.ok) {
      if (!result.canceled) setNotice('导入失败，请确认文件夹里有 clips.json')
      return
    }
    setItems(await api.list())
    setNotice(`导入 ${result.added ?? 0} 条，跳过 ${result.skipped ?? 0} 条`)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (preview) {
          setPreview(null)
        } else if (selectMode) {
          exitSelect()
        } else if (query) {
          setQuery('')
          setSearchText('')
          inputRef.current?.focus()
        } else {
          window.clipbook?.hide()
        }
        return
      }
      if (selectMode && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        selectAllFiltered()
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive((index) => Math.min(index + 1, filtered.length - 1))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((index) => Math.max(index - 1, 0))
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        const target = filtered[active]
        if (target) copyItem(target.id)
        return
      }
      if (event.key === '/' && document.activeElement !== inputRef.current) {
        event.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [filtered, active, query, preview, selectMode])

  const pinnedCount = items.filter((item) => item.pinned).length

  return (
    <div className="app">
      <header className="bar">
        <span className="seal">剪贴</span>
        <h1>剪贴簿</h1>
        <span className="hotkey">Ctrl+Shift+V</span>
        <div className="window-controls">
          <button
            type="button"
            className={`top-toggle ${onTop ? 'on' : ''}`}
            title={onTop ? '取消窗口置顶' : '窗口置顶'}
            onClick={toggleWindowTop}
          >
            {onTop ? '📌' : '📍'}
          </button>
          <button type="button" title="最小化到托盘" onClick={() => window.clipbook?.control('minimize')}>
            −
          </button>
          <button type="button" title="最大化 / 还原" onClick={() => window.clipbook?.control('maximize')}>
            □
          </button>
          <button
            type="button"
            className="window-close"
            title="关闭窗口（后台继续记录）"
            onClick={() => window.clipbook?.control('close')}
          >
            ✕
          </button>
        </div>
      </header>

      <div className="search">
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索剪贴记录…"
          spellCheck={false}
        />
        <button
          type="button"
          className={`clear ${confirming ? 'danger' : ''}`}
          onClick={clearAll}
          title="清空未收藏的历史（收藏项保留）"
        >
          {confirming ? '确认清空' : '清空'}
        </button>
      </div>

      <div className="filters">
        {FILTERS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className={`chip ${filter === entry.key ? 'on' : ''}`}
            onClick={() => setFilter(entry.key)}
          >
            {entry.label}
          </button>
        ))}
        <span className="filter-gap" />
        <button
          type="button"
          className={`chip action ${selectMode ? 'on' : ''}`}
          title={selectMode ? '退出多选' : '多选后批量删除'}
          onClick={() => (selectMode ? exitSelect() : enterSelect())}
        >
          {selectMode ? '完成' : '多选'}
        </button>
        <button type="button" className="chip action" title="导出到文件夹" onClick={exportData}>
          导出
        </button>
        <button type="button" className="chip action" title="从文件夹导入" onClick={importData}>
          导入
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          <p>{items.length === 0 ? '簿子里还空着' : '没有匹配的记录'}</p>
          <span>
            {items.length === 0
              ? '复制任何文字，它会自动誊到这一页'
              : '换个关键词试试，Esc 清空搜索'}
          </span>
        </div>
      ) : (
        <div className="list-area">
          <AutoSizer>
            {({ height, width }) => (
              <VariableSizeList
                ref={listRef}
                className="list"
                height={height}
                width={width}
                itemCount={filtered.length}
                itemData={filtered}
                itemKey={(index) => filtered[index].id}
                itemSize={(index) => (filtered[index].kind === 'image' ? 150 : 84)}
                estimatedItemSize={84}
                overscanCount={2}
              >
                {({ index, style }) => {
                  const item = filtered[index]
                  return (
                    <div
                      data-index={index}
                      className={`row ${index === active ? 'active' : ''} ${item.pinned ? 'pinned' : ''} ${selectedSet.has(item.id) ? 'selected' : ''}`}
                      style={{ ...style, width: 'calc(100% - 12px)' }}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => (selectMode ? toggleSelect(item.id) : copyItem(item.id))}
                    >
                      <div className="meta">
                        {selectMode && (
                          <span className={`pick ${selectedSet.has(item.id) ? 'on' : ''}`}>
                            {selectedSet.has(item.id) ? '✓' : ''}
                          </span>
                        )}
                        <span className="time">{formatTime(item.createdAt)}</span>
                        {KIND_LABEL[item.kind] && <span className="tag">{KIND_LABEL[item.kind]}</span>}
                        {item.truncated && <span className="tag">超长</span>}
                        {item.top && <span className="tag">置顶</span>}
                        {item.kind === 'image' && item.image && (
                          <span className="shot-meta">
                            {item.image.width} × {item.image.height} · {Math.max(1, Math.round(item.image.bytes / 1024))} KB
                          </span>
                        )}
                        {item.copiedCount > 0 && <span className="times">用过 {item.copiedCount} 次</span>}
                        {copiedId === item.id && <span className="copied">已复制</span>}
                        {item.pinned && <span className="pin-dot" title="已收藏" />}
                      </div>
                      {item.kind === 'image' && item.image ? (
                        <div
                          className="shot"
                          title={selectMode ? '点击选择这条' : '点击放大预览'}
                          onClick={(event) => {
                            event.stopPropagation()
                            if (selectMode) toggleSelect(item.id)
                            else setPreview(item)
                          }}
                        >
                          <img
                            src={`clipimg://img/${item.image.thumbFile || item.image.file}`}
                            alt="剪贴图片"
                            loading="lazy"
                            draggable={false}
                          />
                        </div>
                      ) : (
                        <p className="text">{item.text}</p>
                      )}
                      {!selectMode && (
                        <div className="actions">
                          <button
                            type="button"
                            className={item.pinned ? 'starred' : ''}
                            title={item.pinned ? '取消收藏' : '收藏（锁定不被清理）'}
                            onClick={(event) => {
                              event.stopPropagation()
                              togglePin(item.id)
                            }}
                          >
                            {item.pinned ? '★' : '☆'}
                          </button>
                          {item.pinned && (
                            <button
                              type="button"
                              className={item.top ? 'topped' : ''}
                              title={item.top ? '取消置顶' : '置顶到列表顶部'}
                              onClick={(event) => {
                                event.stopPropagation()
                                toggleTop(item.id)
                              }}
                            >
                              {item.top ? '📌' : '📍'}
                            </button>
                          )}
                          <button
                            type="button"
                            title="删除这条"
                            onClick={(event) => {
                              event.stopPropagation()
                              removeItem(item.id)
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      )}
                    </div>
                  )
                }}
              </VariableSizeList>
            )}
          </AutoSizer>
        </div>
      )}

      {undo && (
        <div className="undo-float">
          <button type="button" onClick={undoClear}>
            撤销清空（{undo.left}s）· 共 {undo.count} 条
          </button>
        </div>
      )}

      {selectMode && (
        <div className="select-bar">
          <span>已选 {selected.length} 条</span>
          <div className="select-actions">
            <button type="button" onClick={selectAllFiltered}>
              全选
            </button>
            <button
              type="button"
              className={`danger ${selected.length === 0 ? 'disabled' : ''}`}
              disabled={selected.length === 0}
              onClick={deleteSelected}
            >
              {confirmingBatch ? `确认删除 ${selected.length} 条` : '删除选中'}
            </button>
            <button type="button" onClick={exitSelect}>
              退出
            </button>
          </div>
        </div>
      )}

      <footer className="foot">
        <span className={notice ? 'notice' : ''}>
          {notice || `共 ${items.length} 条${pinnedCount > 0 ? ` · 收藏 ${pinnedCount}` : ''}`}
        </span>
        <span>
          {selectMode ? '点击选择 · Ctrl+A 全选 · Esc 退出多选' : '↑↓ 选择 · Enter 复制 · Esc 收起'}
        </span>
      </footer>

      {preview && preview.image && (
        <div className="lightbox" onClick={() => setPreview(null)}>
          <img
            src={`clipimg://img/${preview.image.file}`}
            alt="图片预览"
            draggable={false}
            onClick={(event) => event.stopPropagation()}
          />
          <div className="lightbox-bar" onClick={(event) => event.stopPropagation()}>
            <span className="lightbox-meta">
              {preview.image.width} × {preview.image.height} · {Math.max(1, Math.round(preview.image.bytes / 1024))} KB
            </span>
            <button type="button" onClick={() => copyItem(preview.id)}>
              复制图片
            </button>
            <button type="button" onClick={() => setPreview(null)}>
              关闭
            </button>
          </div>
        </div>
      )}

      <div
        className="resize-grip"
        title="拖拽调整窗口大小"
        aria-label="拖拽调整窗口大小"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          resizeStart.current = {
            x: event.clientX,
            y: event.clientY,
            width: window.innerWidth,
            height: window.innerHeight,
          }
        }}
        onPointerMove={(event) => {
          const start = resizeStart.current
          if (!start) return
          window.clipbook?.resize(
            start.width + event.clientX - start.x,
            start.height + event.clientY - start.y,
          )
        }}
        onPointerUp={(event) => {
          resizeStart.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
        }}
        onPointerCancel={() => {
          resizeStart.current = null
        }}
      />
    </div>
  )
}
