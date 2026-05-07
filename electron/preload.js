const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('talkcut', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  pickVideo: () => ipcRenderer.invoke('dialog:pick-video'),
  pickOutputDir: () => ipcRenderer.invoke('dialog:pick-output'),
  checkDependencies: () => ipcRenderer.invoke('deps:check'),
  testLlmConnection: (input) => ipcRenderer.invoke('llm:test', input),
  testAsrConnection: (input) => ipcRenderer.invoke('asr:test', input),
  getTask: () => ipcRenderer.invoke('task:get'),
  getHistory: () => ipcRenderer.invoke('history:get'),
  deleteHistory: (entry) => ipcRenderer.invoke('history:delete', entry),
  relinkHistoryVideo: (entry) => ipcRenderer.invoke('history:relink-video', entry),
  startTask: (input) => ipcRenderer.invoke('task:start', input),
  openReviewWindow: () => ipcRenderer.invoke('task:open-review'),
  openProjectFolder: () => ipcRenderer.invoke('task:open-folder'),
  openHistoryProject: (entry) => ipcRenderer.invoke('history:open-project', entry),
  resumeHistoryReview: (entry) => ipcRenderer.invoke('history:resume-review', entry),
  getUpdateState: () => ipcRenderer.invoke('update:get-state'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getWhisperModelStatus: (options) => ipcRenderer.invoke('model:status', options),
  scanWhisperModels: () => ipcRenderer.invoke('model:scan'),
  installWhisperModel: () => ipcRenderer.invoke('model:install'),
  onTaskUpdate: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on('task:update', listener);
    return () => ipcRenderer.removeListener('task:update', listener);
  },
  onUpdateState: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on('update:state', listener);
    return () => ipcRenderer.removeListener('update:state', listener);
  },
  onModelInstallState: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on('model:install-state', listener);
    return () => ipcRenderer.removeListener('model:install-state', listener);
  },
});
