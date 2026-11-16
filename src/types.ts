export type ClipKind = 'text' | 'link' | 'code' | 'image' | 'file'

export interface ClipImage {
  file: string
  thumbFile?: string
  width: number
  height: number
  bytes: number
}

export interface ClipItem {
  id: string
  text: string
  kind: ClipKind
  image?: ClipImage
  hash?: string
  pinned: boolean
  top?: boolean
  createdAt: number
  copiedCount: number
  truncated?: boolean
}

export interface AppInfo {
  hotkey: string
  version: string
  dataFile: string
}

export interface ImportResult {
  ok: boolean
  count?: number
  added?: number
  skipped?: number
  error?: string
  canceled?: boolean
}

export interface ClipbookApi {
  list: () => Promise<ClipItem[]>
  copy: (id: string) => Promise<ClipItem[]>
  remove: (id: string) => Promise<ClipItem[]>
  togglePin: (id: string) => Promise<ClipItem[]>
  toggleTop: (id: string) => Promise<ClipItem[]>
  clear: () => Promise<ClipItem[]>
  hide: () => Promise<void>
  resize: (width: number, height: number) => void
  control: (action: 'minimize' | 'maximize' | 'close') => void
  info: () => Promise<AppInfo>
  exportData: () => Promise<ImportResult>
  importData: () => Promise<ImportResult>
  onUpdate: (callback: (items: ClipItem[]) => void) => () => void
  onShown: (callback: () => void) => () => void
}

declare global {
  interface Window {
    clipbook?: ClipbookApi
  }
}
