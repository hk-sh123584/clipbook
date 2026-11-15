const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('clipbook', {
  list: () => ipcRenderer.invoke('clips:list'),
  copy: (id) => ipcRenderer.invoke('clips:copy', id),
  remove: (id) => ipcRenderer.invoke('clips:delete', id),
  togglePin: (id) => ipcRenderer.invoke('clips:togglePin', id),
  clear: () => ipcRenderer.invoke('clips:clear'),
  hide: () => ipcRenderer.invoke('window:hide'),
  resize: (width, height) => ipcRenderer.send('window:resize', { width, height }),
  control: (action) => ipcRenderer.send('window:control', action),
  info: () => ipcRenderer.invoke('app:info'),
  onUpdate: (callback) => {
    const handler = (_event, items) => callback(items)
    ipcRenderer.on('clips:updated', handler)
    return () => ipcRenderer.removeListener('clips:updated', handler)
  },
  onShown: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('window:shown', handler)
    return () => ipcRenderer.removeListener('window:shown', handler)
  },
})
