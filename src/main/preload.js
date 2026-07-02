'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  saveFile: (defaultPath) => ipcRenderer.invoke('dialog:saveFile', defaultPath),
  openDir: () => ipcRenderer.invoke('dialog:openDir'),
  probe: (input) => ipcRenderer.invoke('ffmpeg:probe', input),
  run: (opts) => ipcRenderer.invoke('ffmpeg:run', opts),
  cancel: () => ipcRenderer.invoke('ffmpeg:cancel'),
  preview: (opts) => ipcRenderer.invoke('ffmpeg:preview', opts),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  onProgress: (cb) => ipcRenderer.on('ffmpeg:progress', (e, d) => cb(d)),
  onLog: (cb) => ipcRenderer.on('ffmpeg:log', (e, line) => cb(line)),

  // 批量
  runBatch: (jobs) => ipcRenderer.invoke('ffmpeg:runBatch', jobs),
  cancelBatch: () => ipcRenderer.invoke('ffmpeg:cancelBatch'),
  onBatchItemStart: (cb) => ipcRenderer.on('batch:itemStart', (e, d) => cb(d)),
  onBatchProgress: (cb) => ipcRenderer.on('batch:progress', (e, d) => cb(d)),
  onBatchItemDone: (cb) => ipcRenderer.on('batch:itemDone', (e, d) => cb(d)),
  onBatchLog: (cb) => ipcRenderer.on('batch:log', (e, d) => cb(d)),

  // CSV
  saveCsvDemo: (content) => ipcRenderer.invoke('csv:saveDemo', content),
  openCsv: () => ipcRenderer.invoke('csv:open'),

  // 千川素材交付
  dvInit: (dir) => ipcRenderer.invoke('delivery:init', dir),
  dvWriteManifest: (workspace, key, data) => ipcRenderer.invoke('delivery:writeManifest', workspace, key, data),
  dvOpenVideos: () => ipcRenderer.invoke('delivery:openVideos'),
  dvCutSegments: (items) => ipcRenderer.invoke('delivery:cutSegments', items),
  dvRenderJobs: (items, options) => ipcRenderer.invoke('delivery:renderJobs', items, options),
  dvQuality: (items) => ipcRenderer.invoke('delivery:quality', items),
  dvExport: (payload) => ipcRenderer.invoke('delivery:export', payload),
  dvCancel: () => ipcRenderer.invoke('delivery:cancel'),
  dvOpenMusic: () => ipcRenderer.invoke('delivery:openMusic'),
  dvPause: () => ipcRenderer.invoke('delivery:pauseRender'),
  dvResume: () => ipcRenderer.invoke('delivery:resumeRender'),
  dvExportTemplates: (templates) => ipcRenderer.invoke('delivery:exportTemplates', templates),
  dvImportTemplates: () => ipcRenderer.invoke('delivery:importTemplates'),
  onDvCutStart: (cb) => ipcRenderer.on('delivery:cutStart', (e, d) => cb(d)),
  onDvCutProgress: (cb) => ipcRenderer.on('delivery:cutProgress', (e, d) => cb(d)),
  onDvCutDone: (cb) => ipcRenderer.on('delivery:cutDone', (e, d) => cb(d)),
  onDvRenderStart: (cb) => ipcRenderer.on('delivery:renderStart', (e, d) => cb(d)),
  onDvRenderProgress: (cb) => ipcRenderer.on('delivery:renderProgress', (e, d) => cb(d)),
  onDvRenderDone: (cb) => ipcRenderer.on('delivery:renderDone', (e, d) => cb(d)),
  onDvQualityProgress: (cb) => ipcRenderer.on('delivery:qualityProgress', (e, d) => cb(d)),
  onDvExportProgress: (cb) => ipcRenderer.on('delivery:exportProgress', (e, d) => cb(d)),
});
