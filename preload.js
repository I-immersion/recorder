// preload.js v1.1.0 — pont sécurisé entre main et renderer
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  app: {
    version: () => ipcRenderer.invoke('app:version')
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch) => ipcRenderer.invoke('config:set', patch),
    chooseOutputDir: () => ipcRenderer.invoke('config:choose-output-dir')
  },
  audio: {
    listDevices: () => ipcRenderer.invoke('audio:list-devices'),
    open: (deviceId, channels, sampleRate) =>
      ipcRenderer.invoke('audio:open', { deviceId, channels, sampleRate }),
    close: () => ipcRenderer.invoke('audio:close'),
    state: () => ipcRenderer.invoke('audio:state')
  },
  rec: {
    start: (opts) => ipcRenderer.invoke('rec:start', opts),
    pause: () => ipcRenderer.invoke('rec:pause'),
    resume: () => ipcRenderer.invoke('rec:resume'),
    stop: () => ipcRenderer.invoke('rec:stop'),
    marker: (note) => ipcRenderer.invoke('rec:marker', { note })
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    reveal: (folder) => ipcRenderer.invoke('sessions:reveal', folder),
    openFolder: (folder) => ipcRenderer.invoke('sessions:open-folder', folder),
    delete: (folder) => ipcRenderer.invoke('sessions:delete', folder),
    repairAll: () => ipcRenderer.invoke('sessions:repair-all')
  },
  on: (channel, cb) => {
    const allowed = [
      'cmd-rec', 'cmd-stop', 'cmd-pause', 'cmd-marker', 'cmd-new',
      'osc-in', 'master-ready',
      'audio:peaks', 'audio:error'
    ];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_evt, data) => cb(data));
  }
});
