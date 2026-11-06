const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('vacuum', {
  // onglets / sections
  getState: () => ipcRenderer.invoke('ui:state'),
  getI18n: () => ipcRenderer.invoke('i18n:get'),
  onI18n: on('i18n:changed'),
  onState: on('ui:state'),
  onCommand: on('ui:command'),
  setBounds: (b) => ipcRenderer.send('ui:bounds', b),
  switchSection: (s) => ipcRenderer.send('ui:switch-section', s),
  newTab: (section, url) => ipcRenderer.send('ui:new-tab', section, url),
  activateTab: (id) => ipcRenderer.send('ui:activate-tab', id),
  closeTab: (id) => ipcRenderer.send('ui:close-tab', id),
  moveTab: (id, index) => ipcRenderer.send('ui:move-tab', id, index),
  nav: (action, id) => ipcRenderer.send('ui:nav', action, id),
  navigate: (input) => ipcRenderer.send('ui:navigate', input),
  focusView: () => ipcRenderer.send('ui:focus-view'),
  // paramètres
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (k, v) => ipcRenderer.invoke('settings:set', k, v),
  chooseDir: () => ipcRenderer.invoke('settings:choose-dir'),
  openDir: () => ipcRenderer.invoke('settings:open-dir'),
  updateAdblock: () => ipcRenderer.invoke('adblock:update'),
  ytdlpVersion: () => ipcRenderer.invoke('ytdlp:version'),
  ytdlpUpdate: () => ipcRenderer.invoke('ytdlp:update'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  clearData: (what) => ipcRenderer.invoke('app:clear-data', what),
  vdhStatus: () => ipcRenderer.invoke('vdh:status'),
  vdhOpen: (url) => ipcRenderer.invoke('vdh:open', url),
  // téléchargements
  startDownload: (opts) => ipcRenderer.invoke('dl:start', opts),
  listDownloads: () => ipcRenderer.invoke('dl:list'),
  cancelDownload: (id) => ipcRenderer.send('dl:cancel', id),
  retryDownload: (id) => ipcRenderer.send('dl:retry', id),
  removeDownload: (id) => ipcRenderer.send('dl:remove', id),
  clearDownloads: () => ipcRenderer.send('dl:clear'),
  openDownload: (id) => ipcRenderer.send('dl:open', id),
  showDownload: (id) => ipcRenderer.send('dl:show', id),
  onDownloadUpdate: on('vacuum:download-update'),
  onDownloadList: on('vacuum:download-list'),
});
