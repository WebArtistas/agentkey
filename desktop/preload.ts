import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../shared/contracts';

const api: DesktopApi = {
  snapshot: () => ipcRenderer.invoke('vault:snapshot'),
  initialize: (password) => ipcRenderer.invoke('vault:initialize', password),
  unlock: (password) => ipcRenderer.invoke('vault:unlock', password),
  lock: () => ipcRenderer.invoke('vault:lock'),
  saveItem: (item) => ipcRenderer.invoke('vault:save-item', item),
  deleteItem: (name) => ipcRenderer.invoke('vault:delete-item', name),
  saveOperation: (operation) => ipcRenderer.invoke('vault:save-operation', operation),
  saveDatabase: (database) => ipcRenderer.invoke('vault:save-database', database),
  prepareSQLite: (source) => ipcRenderer.invoke('vault:prepare-sqlite', source),
  saveSQLite: (input) => ipcRenderer.invoke('vault:save-sqlite', input),
  cancelSQLite: (token) => ipcRenderer.invoke('vault:cancel-sqlite', token),
  deleteOperation: (name) => ipcRenderer.invoke('vault:delete-operation', name),
  approve: (operation, duration, revision, dataSharingAccepted) =>
    ipcRenderer.invoke('vault:approve', { operation, duration, revision, dataSharingAccepted }),
  showWindow: (view) => ipcRenderer.invoke('window:show', view),
  hidePanel: () => ipcRenderer.invoke('window:hide-panel'),
  revoke: (operation) => ipcRenderer.invoke('vault:revoke', operation),
  connection: () => ipcRenderer.invoke('vault:connection'),
};
// Window lifecycle comes from main; Chromium visibility events can be coalesced.
// This value-free notification can only conceal fields, never read or reveal them.
ipcRenderer.on('window:conceal', () => window.dispatchEvent(new Event('agentkey-conceal')));
contextBridge.exposeInMainWorld('agentkey', api);
