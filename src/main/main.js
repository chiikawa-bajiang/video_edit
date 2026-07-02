'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const engine = require('./ffmpeg-engine');
const delivery = require('./delivery-engine');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#1e1f22',
    title: '一刀 · 视频处理工作台',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => (mainWindow = null));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC ----

ipcMain.handle('dialog:openFile', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择视频文件',
    properties: ['openFile'],
    filters: [
      { name: '视频文件', extensions: ['mp4', 'mov', 'mkv', 'avi', 'flv', 'wmv', 'webm', 'm4v', 'ts', 'mpg', 'mpeg'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('dialog:openFiles', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择视频文件（可多选）',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '视频文件', extensions: ['mp4', 'mov', 'mkv', 'avi', 'flv', 'wmv', 'webm', 'm4v', 'ts', 'mpg', 'mpeg'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return [];
  return res.filePaths;
});

ipcMain.handle('dialog:saveFile', async (e, defaultPath) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: '保存输出文件',
    defaultPath,
    filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'mkv', 'webm'] }],
  });
  if (res.canceled || !res.filePath) return null;
  return res.filePath;
});

ipcMain.handle('ffmpeg:probe', async (e, input) => {
  return engine.probe(input);
});

ipcMain.handle('ffmpeg:run', async (e, opts) => {
  return engine.run(
    opts,
    (pct, time) => mainWindow && mainWindow.webContents.send('ffmpeg:progress', { pct, time }),
    (line) => mainWindow && mainWindow.webContents.send('ffmpeg:log', line)
  );
});

ipcMain.handle('ffmpeg:cancel', async () => {
  engine.cancel();
  return true;
});

ipcMain.handle('ffmpeg:preview', async (e, opts) => {
  return engine.buildArgs(opts);
});

ipcMain.handle('shell:showItem', async (e, p) => {
  if (p) shell.showItemInFolder(p);
  return true;
});

ipcMain.handle('shell:openPath', async (e, p) => {
  if (p) shell.openPath(p);
  return true;
});

// 选择输出目录
ipcMain.handle('dialog:openDir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择输出目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// 保存 CSV 模板
ipcMain.handle('csv:saveDemo', async (e, content) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: '保存 CSV 微调参数模板',
    defaultPath: '一刀_微调参数模板.csv',
    filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
  });
  if (res.canceled || !res.filePath) return null;
  // 加 BOM 以便 Excel 正确识别 UTF-8
  fs.writeFileSync(res.filePath, '\ufeff' + content, 'utf8');
  return res.filePath;
});

// 选择并读取 CSV
ipcMain.handle('csv:open', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择微调参数 CSV',
    properties: ['openFile'],
    filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  let text = fs.readFileSync(res.filePaths[0], 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { path: res.filePaths[0], text };
});

// 批量执行
ipcMain.handle('ffmpeg:runBatch', async (e, jobs) => {
  return engine.runBatch(jobs, {
    itemStart: (i, job) => mainWindow && mainWindow.webContents.send('batch:itemStart', { index: i, output: job.output }),
    progress: (i, pct, time) => mainWindow && mainWindow.webContents.send('batch:progress', { index: i, pct, time }),
    itemDone: (i, r) => mainWindow && mainWindow.webContents.send('batch:itemDone', { index: i, ...r }),
    log: (i, line) => mainWindow && mainWindow.webContents.send('batch:log', { index: i, line }),
  });
});

ipcMain.handle('ffmpeg:cancelBatch', async () => {
  engine.cancelBatch();
  return true;
});

/* ============ 千川素材交付 ============ */
ipcMain.handle('delivery:init', async (e, dir) => delivery.initWorkspace(dir));

ipcMain.handle('delivery:writeManifest', async (e, workspace, key, data) =>
  delivery.writeManifest(workspace, key, data));

ipcMain.handle('delivery:openVideos', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '导入原始视频',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] }],
  });
  if (res.canceled || !res.filePaths.length) return [];
  const assets = [];
  for (const p of res.filePaths) {
    try {
      const meta = await delivery.probe(p);
      assets.push({
        id: 'A' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        sourcePath: p, fileName: path.basename(p),
        duration: meta.duration, width: meta.width, height: meta.height,
        format: meta.vcodec, hasAudio: meta.hasAudio, fps: meta.fps,
        importedAt: new Date().toISOString(),
      });
    } catch (err) {
      assets.push({ sourcePath: p, fileName: path.basename(p), error: err.message });
    }
  }
  return assets;
});

ipcMain.handle('delivery:cutSegments', async (e, items) => {
  return delivery.runQueue(items, delivery.buildCutArgs, (it) => it.end - it.start, {
    itemStart: (i) => mainWindow && mainWindow.webContents.send('delivery:cutStart', { index: i }),
    progress: (i, pct) => mainWindow && mainWindow.webContents.send('delivery:cutProgress', { index: i, pct }),
    itemDone: (i, r) => mainWindow && mainWindow.webContents.send('delivery:cutDone', { index: i, ...r }),
  });
});

ipcMain.handle('delivery:renderJobs', async (e, items, options) => {
  return delivery.runRenderJobs(items, {
    itemStart: (i) => mainWindow && mainWindow.webContents.send('delivery:renderStart', { index: i }),
    progress: (i, pct) => mainWindow && mainWindow.webContents.send('delivery:renderProgress', { index: i, pct }),
    itemDone: (i, r) => mainWindow && mainWindow.webContents.send('delivery:renderDone', { index: i, ...r }),
  }, options || {});
});

ipcMain.handle('delivery:pauseRender', async () => { delivery.setPaused(true); return true; });
ipcMain.handle('delivery:resumeRender', async () => { delivery.setPaused(false); return true; });

ipcMain.handle('delivery:exportTemplates', async (e, templates) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: '导出模板',
    defaultPath: '一刀_模板.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, JSON.stringify(templates, null, 2), 'utf8');
  return res.filePath;
});

ipcMain.handle('delivery:importTemplates', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '导入模板',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  try {
    let text = fs.readFileSync(res.filePaths[0], 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [data];
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('delivery:quality', async (e, items) => {
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const r = await delivery.qualityCheck(items[i]);
    results.push(r);
    if (mainWindow) mainWindow.webContents.send('delivery:qualityProgress', { index: i, total: items.length, result: r });
  }
  return results;
});

ipcMain.handle('delivery:export', async (e, payload) => {
  return delivery.exportDelivery(payload, {
    progress: (pct) => mainWindow && mainWindow.webContents.send('delivery:exportProgress', { pct }),
  });
});

ipcMain.handle('delivery:cancel', async () => { delivery.cancel(); return true; });

ipcMain.handle('delivery:openMusic', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择配乐',
    properties: ['openFile'],
    filters: [{ name: '音频文件', extensions: ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg'] }, { name: '所有文件', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});
