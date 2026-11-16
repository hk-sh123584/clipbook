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
  const [filter, setFilter] = useState<Filter>('all')
  const [active, setActive] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [notice, setNotice] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const copiedTimer = useRef<number | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<VariableSizeList>(null)
  const resizeStart = useRef<{ x: number; y: number; width: number; height: number } | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((item) => {
      if (filter === 'link' && item.kind !== 'link') return false
      if (filter === 'image' && item.kind !== 'image') return false
      if (filter === 'pinned' && !item.pinned) return false
      if (filter === 'today' && !isToday(item.createdAt)) return false
      if (!q) return true
      return item.text.toLowerCase().includes(q)
    })
  }, [items, query, filter])

  useEffect(() => {
    const api = window.clipbook
    if (!api) return
    api.list().then(setItems)
    const offUpdate = api.onUpdate(setItems)
    const offShown = api.onShown(() => {
      setQuery('')
      setActive(0)
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

  const clearAll = async () => {
    const api = window.clipbook
    if (!api) return
    if (!confirming) {
      setConfirming(true)
      return
    }
    const next = await api.clear()
    setItems(next)
    setConfirming(false)
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
        if (query) {
          setQuery('')
          inputRef.current?.focus()
        } else {
          window.clipbook?.hide()
        }
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
  }, [filtered, active, query])

  const pinnedCount = items.filter((item) => item.pinned).length

  return (
    <div className="app">
      <header className="bar">
        <span className="seal">剪贴</span>
        <h1>剪贴簿</h1>
        <span className="hotkey">Ctrl+Shift+V</span>
        <div className="window-controls">
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
          title="清空全部历史"
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
                      className={`row ${index === active ? 'active' : ''} ${item.pinned ? 'pinned' : ''}`}
                      style={{ ...style, width: 'calc(100% - 12px)' }}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => copyItem(item.id)}
                    >
                      <div className="meta">
                        <span className="time">{formatTime(item.createdAt)}</span>
                        {KIND_LABEL[item.kind] && <span className="tag">{KIND_LABEL[item.kind]}</span>}
                        {item.truncated && <span className="tag">超长</span>}
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
                        <div className="shot">
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
                      <div className="actions">
                        <button
                          type="button"
                          className={item.pinned ? 'starred' : ''}
                          title={item.pinned ? '取消收藏' : '收藏置顶'}
                          onClick={(event) => {
                            event.stopPropagation()
                            togglePin(item.id)
                          }}
                        >
                          {item.pinned ? '★' : '☆'}
                        </button>
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
                    </div>
                  )
                }}
              </VariableSizeList>
            )}
          </AutoSizer>
        </div>
      )}

      <footer className="foot">
        <span className={notice ? 'notice' : ''}>
          {notice || `共 ${items.length} 条${pinnedCount > 0 ? ` · 收藏 ${pinnedCount}` : ''}`}
        </span>
        <span>↑↓ 选择 · Enter 复制 · Esc 收起</span>
      </footer>

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
