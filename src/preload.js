'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** The only surface the settings window can touch. */
const api = {
  getState: () => ipcRenderer.invoke('wisp:get-state'),
  getSettings: () => ipcRenderer.invoke('wisp:get-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('wisp:save-settings', patch),
  resetSettings: () => ipcRenderer.invoke('wisp:reset-settings'),

  listDevices: () => ipcRenderer.invoke('wisp:list-devices'),
  checkOllama: () => ipcRenderer.invoke('wisp:check-ollama'),
  testCleanup: (text) => ipcRenderer.invoke('wisp:test-cleanup', text),
  reloadModel: () => ipcRenderer.invoke('wisp:reload-model'),

  start: () => ipcRenderer.invoke('wisp:start'),
  stop: () => ipcRenderer.invoke('wisp:stop'),
  cancel: () => ipcRenderer.invoke('wisp:cancel'),
  copyTranscript: (text) => ipcRenderer.invoke('wisp:copy', text),
  clearHistory: () => ipcRenderer.invoke('wisp:clear-history'),
  diagnostics: () => ipcRenderer.invoke('wisp:diagnostics'),

  openAccessibility: () => ipcRenderer.invoke('wisp:open-accessibility'),
  openExternal: (url) => ipcRenderer.invoke('wisp:open-external', url),
  quit: () => ipcRenderer.invoke('wisp:quit'),

  onEvent: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('wisp:event', listener);
    return () => ipcRenderer.removeListener('wisp:event', listener);
  },
};

contextBridge.exposeInMainWorld('wisp', api);
