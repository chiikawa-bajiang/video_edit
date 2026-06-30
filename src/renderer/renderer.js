'use strict';

const state = {
  input: null,
  output: null,
  meta: null,
};

const $ = (id) => document.getElementById(id);

// ---- 模块导航 ----
const MODULES = ['module-ffmpeg', 'module-batch', 'module-delivery', 'module-placeholder'];
function showModule(id, title) {
  MODULES.forEach((m) => ($(m).hidden = m !== id));
  if (id === 'module-placeholder' && title) $('placeholderTitle').textContent = title + ' · 开发中';
}
document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    const mod = item.dataset.module;
    if (item.classList.contains('disabled')) {
      document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
      showModule('module-placeholder', item.querySelector('.nav-text').textContent);
      return;
    }
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
    item.classList.add('active');
    if (mod === 'ffmpeg') showModule('module-ffmpeg');
    else if (mod === 'batch') showModule('module-batch');
    else if (mod === 'delivery') showModule('module-delivery');
    else showModule('module-placeholder', item.querySelector('.nav-text').textContent);
  });
});

// ---- 工具函数 ----
function fmtDuration(sec) {
  if (!sec) return '-';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h > 0 ? h + ':' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function fmtSize(bytes) {
  if (!bytes) return '-';
  const mb = bytes / 1024 / 1024;
  return mb > 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
}
function fmtBitrate(bps) {
  if (!bps) return '-';
  return (bps / 1000).toFixed(0) + ' kbps';
}

let toastTimer = null;
function toast(msg, type = '') {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.className = 'toast ' + type;
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

function defaultOutputPath(input) {
  if (!input) return null;
  const dot = input.lastIndexOf('.');
  const dir = input.substring(0, dot < 0 ? input.length : dot);
  return dir + '_一刀输出.mp4';
}

// ---- 收集参数 ----
function collectOptions() {
  const num = (id) => {
    const v = parseFloat($(id).value);
    return isNaN(v) ? undefined : v;
  };
  return {
    input: state.input,
    output: state.output || defaultOutputPath(state.input),
    codec: $('codec').value,
    preset: $('preset').value,
    bitrate: $('bitrate').value.trim() || undefined,
    crf: num('crf'),
    width: num('width'),
    height: num('height'),
    fps: num('fps'),
    brightness: num('brightness'),
    saturation: num('saturation'),
    sharpen: num('sharpen'),
    blur: num('blur'),
    startTime: num('startTime'),
    duration: num('duration'),
    muteAudio: $('muteAudio').checked,
    vertical: readVertical('vEnabled', 'vSize', 'vMode'),
    totalDuration: state.meta ? state.meta.duration : 0,
  };
}

function readVertical(enId, sizeId, modeId) {
  const enabled = $(enId).checked;
  const [w, h] = $(sizeId).value.split('x').map(Number);
  return { enabled, width: w, height: h, mode: $(modeId).value };
}

// ---- 命令预览 ----
async function updatePreview() {
  if (!state.input) {
    $('cmdPreview').textContent = '选择文件后生成命令…';
    return;
  }
  try {
    const args = await window.api.preview(collectOptions());
    $('cmdPreview').textContent = 'ffmpeg ' + args.map((a) =>
      /\s/.test(a) ? `"${a}"` : a
    ).join(' ');
  } catch (e) {
    $('cmdPreview').textContent = '(' + e.message + ')';
  }
}

// ---- 选择文件 ----
$('btnOpen').addEventListener('click', async () => {
  const file = await window.api.openFile();
  if (!file) return;
  state.input = file;
  $('inputPath').textContent = file;
  state.output = null;
  $('outputPath').textContent = defaultOutputPath(file);
  $('btnRun').disabled = false;

  $('mediaInfo').hidden = true;
  try {
    const meta = await window.api.probe(file);
    state.meta = meta;
    $('infoDuration').textContent = fmtDuration(meta.duration);
    $('infoResolution').textContent = meta.width ? `${meta.width}×${meta.height}` : '-';
    $('infoFps').textContent = meta.fps ? meta.fps + ' fps' : '-';
    $('infoVcodec').textContent = meta.vcodec || '-';
    $('infoBitrate').textContent = fmtBitrate(meta.bitrate);
    $('infoSize').textContent = fmtSize(meta.size);
    $('mediaInfo').hidden = false;
  } catch (e) {
    toast('读取视频信息失败：' + e.message, 'error');
  }
  updatePreview();
});

// ---- 选择输出 ----
$('btnOutput').addEventListener('click', async () => {
  const out = await window.api.saveFile(state.output || defaultOutputPath(state.input) || '一刀输出.mp4');
  if (!out) return;
  state.output = out;
  $('outputPath').textContent = out;
  updatePreview();
});

// ---- 分辨率预设 ----
$('resPreset').addEventListener('change', (e) => {
  const v = e.target.value;
  if (!v) return;
  const [w, h] = v.split('x');
  $('width').value = w;
  $('height').value = h;
  updatePreview();
});

// ---- 滑块数值显示 ----
const sliders = [
  ['brightness', 'brightnessVal', 2],
  ['saturation', 'saturationVal', 2],
  ['sharpen', 'sharpenVal', 2],
  ['blur', 'blurVal', 1],
];
sliders.forEach(([id, valId, digits]) => {
  $(id).addEventListener('input', () => {
    $(valId).textContent = parseFloat($(id).value).toFixed(digits);
    updatePreview();
  });
});

// ---- 其余输入变化时刷新预览 ----
['codec', 'preset', 'bitrate', 'crf', 'width', 'height', 'fps', 'startTime', 'duration', 'muteAudio', 'vEnabled', 'vSize', 'vMode'].forEach((id) => {
  $(id).addEventListener('input', updatePreview);
  $(id).addEventListener('change', updatePreview);
});

// ---- 重置 ----
$('btnReset').addEventListener('click', () => {
  ['bitrate', 'width', 'height', 'fps', 'startTime', 'duration'].forEach((id) => ($(id).value = ''));
  $('codec').value = 'libx264';
  $('preset').value = 'medium';
  $('crf').value = '23';
  $('resPreset').value = '';
  $('muteAudio').checked = false;
  $('brightness').value = '0'; $('brightnessVal').textContent = '0.00';
  $('saturation').value = '1'; $('saturationVal').textContent = '1.00';
  $('sharpen').value = '0'; $('sharpenVal').textContent = '0.00';
  $('blur').value = '0'; $('blurVal').textContent = '0.0';
  updatePreview();
});

// ---- 日志 ----
function appendLog(line) {
  const box = $('logBox');
  box.textContent += line + '\n';
  box.scrollTop = box.scrollHeight;
}
$('btnClearLog').addEventListener('click', () => ($('logBox').textContent = ''));

window.api.onLog((line) => appendLog(line));
window.api.onProgress(({ pct, time }) => {
  $('progressFill').style.width = pct + '%';
  $('progressText').textContent = pct + '%';
});

// ---- 运行 ----
let running = false;
$('btnRun').addEventListener('click', async () => {
  if (!state.input) return toast('请先选择视频文件', 'error');
  if (running) return;

  const opts = collectOptions();
  state.output = opts.output;
  $('outputPath').textContent = opts.output;

  running = true;
  $('btnRun').disabled = true;
  $('btnRun').textContent = '处理中…';
  $('btnCancel').hidden = false;
  $('progressWrap').hidden = false;
  $('progressFill').style.width = '0%';
  $('progressText').textContent = '0%';
  $('engineStatus').textContent = 'FFmpeg 处理中…';
  $('engineStatus').classList.add('busy');
  appendLog('—— 开始处理 ——');

  try {
    await window.api.run(opts);
    appendLog('—— 处理完成 ——');
    toast('处理完成！文件已保存', 'success');
    window.api.showItem(opts.output);
  } catch (e) {
    appendLog('错误：' + e.message);
    toast('处理失败，详见日志', 'error');
  } finally {
    running = false;
    $('btnRun').disabled = false;
    $('btnRun').textContent = '开始处理';
    $('btnCancel').hidden = true;
    $('engineStatus').textContent = 'FFmpeg 引擎就绪';
    $('engineStatus').classList.remove('busy');
  }
});

// ---- 取消 ----
$('btnCancel').addEventListener('click', async () => {
  await window.api.cancel();
  appendLog('—— 已取消 ——');
  toast('已取消处理', 'error');
});

/* ======================================================================
 *  批量生成模块
 * ==================================================================== */
const batch = {
  input: null,
  meta: null,
  outDir: null,
  mode: 'auto',      // auto | csv
  csvRows: null,
  running: false,
};

// ---- 选择原视频 ----
$('bOpen').addEventListener('click', async () => {
  const file = await window.api.openFile();
  if (!file) return;
  batch.input = file;
  $('bInputPath').textContent = file;
  $('bMediaInfo').hidden = true;
  try {
    const meta = await window.api.probe(file);
    batch.meta = meta;
    $('bInfoDuration').textContent = fmtDuration(meta.duration);
    $('bInfoResolution').textContent = meta.width ? `${meta.width}×${meta.height}` : '-';
    $('bInfoFps').textContent = meta.fps ? meta.fps + ' fps' : '-';
    $('bInfoVcodec').textContent = meta.vcodec || '-';
    $('bInfoBitrate').textContent = fmtBitrate(meta.bitrate);
    $('bInfoSize').textContent = fmtSize(meta.size);
    $('bMediaInfo').hidden = false;
  } catch (e) {
    toast('读取视频信息失败：' + e.message, 'error');
  }
  refreshBatchRunState();
});

// ---- 选择输出目录 ----
$('bOutputDir').addEventListener('click', async () => {
  const dir = await window.api.openDir();
  if (!dir) return;
  batch.outDir = dir;
  $('bOutputPath').textContent = dir;
  refreshBatchRunState();
});

// 千川投流推荐维度（有人物/产品 + 背景音，适中强度，100+条批量）
const QIANCHUAN_PRESET = new Set([
  'brightness', 'contrast', 'saturation', 'gamma', 'sharpen',
  'fps', 'bitrate', 'speed', 'zoom',
  'temperature', 'hue', 'exposure', 'shadowHL', 'grain',
  'gop', 'profile', 'bframes', 'colorTag', 'clearMeta', 'colorRange', 'refs', 'metaRich', 'timestamp',
  'volume', 'pitch', 'afade', 'sampleRate', 'audioBitrate',
  'border',
]);

$('autoQianchuanPreset').addEventListener('click', () => {
  $('autoDims').querySelectorAll('input[type=checkbox]').forEach((c) => {
    c.checked = QIANCHUAN_PRESET.has(c.value);
  });
  $('autoIntensity').value = 'normal';
  $('autoCodec').value = 'libx264';
  $('autoMute').checked = false;
  toast('已应用千川推荐预设（适中强度 · 保留背景音）', 'success');
});

// ---- 选项卡 ----
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    batch.mode = tab.dataset.tab;
    $('tab-auto').hidden = batch.mode !== 'auto';
    $('tab-csv').hidden = batch.mode !== 'csv';
    refreshBatchRunState();
  });
});

function refreshBatchRunState() {
  let ready = !!batch.input && !!batch.outDir && !batch.running;
  if (batch.mode === 'csv') ready = ready && !!(batch.csvRows && batch.csvRows.length);
  $('bRun').disabled = !ready;
}

// ---- 工具：随机数 ----
function rnd(min, max) { return Math.random() * (max - min) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function round(v, d = 3) { const p = Math.pow(10, d); return Math.round(v * p) / p; }

// ---- 自动微调参数生成 ----
// 三档强度对应的抖动幅度
const INTENSITY = {
  subtle: {
    bri: 0.04, con: 0.04, sat: 0.06, gam: 0.04, sharp: 0.4, blur: 0.4, speed: 0.02, zoom: 0.03,
    fpsSet: [null, 30], bitJitter: 0.08, startMax: 0.3,
    temp: 250, tint: 0.03, hue: 3, exposure: 0.04, shadowHL: 0.04, vignette: 0.25, grain: 6, denoise: 1.5,
    resPx: 4, rotDeg: 0.6, panAmp: 0.35, persp: 0.015, vol: 0.08, pitch: 0.01, eqG: 1.5,
    borderMax: 8, pbMax: 10, badgeMax: 44, textMax: 22,
    kenAmp: 0.04, shakeAmp: 2, chromaPx: 1, echoDelay: 30, fadeDur: 0.2, stereoBal: 0.12, tailMax: 0.3,
  },
  normal: {
    bri: 0.08, con: 0.07, sat: 0.12, gam: 0.07, sharp: 0.8, blur: 0.7, speed: 0.04, zoom: 0.05,
    fpsSet: [null, 30, 25], bitJitter: 0.15, startMax: 0.6,
    temp: 500, tint: 0.05, hue: 6, exposure: 0.07, shadowHL: 0.08, vignette: 0.4, grain: 12, denoise: 2.5,
    resPx: 8, rotDeg: 1.2, panAmp: 0.6, persp: 0.03, vol: 0.15, pitch: 0.02, eqG: 3,
    borderMax: 14, pbMax: 16, badgeMax: 60, textMax: 28,
    kenAmp: 0.07, shakeAmp: 4, chromaPx: 2, echoDelay: 50, fadeDur: 0.35, stereoBal: 0.22, tailMax: 0.6,
  },
  strong: {
    bri: 0.13, con: 0.12, sat: 0.2, gam: 0.1, sharp: 1.4, blur: 1.0, speed: 0.07, zoom: 0.08,
    fpsSet: [null, 30, 24, 60], bitJitter: 0.25, startMax: 1.2,
    temp: 900, tint: 0.09, hue: 10, exposure: 0.11, shadowHL: 0.13, vignette: 0.6, grain: 20, denoise: 4,
    resPx: 12, rotDeg: 2.0, panAmp: 1.0, persp: 0.05, vol: 0.25, pitch: 0.04, eqG: 5,
    borderMax: 22, pbMax: 22, badgeMax: 72, textMax: 32,
    kenAmp: 0.10, shakeAmp: 7, chromaPx: 3, echoDelay: 80, fadeDur: 0.5, stereoBal: 0.32, tailMax: 1.2,
  },
};

// ---- 确定性随机：mulberry32 + 简单字符串哈希 ----
function strHash(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}
// 在 [min,max] 上均匀铺开 count 个值（每格内带轻微抖动），再洗牌
function spreadNum(count, min, max, digits, rng) {
  const out = []; const step = (max - min) / count;
  for (let i = 0; i < count; i++) {
    let v = min + step * (i + 0.5) + (rng() - 0.5) * step * 0.6;
    v = Math.max(min, Math.min(max, v));
    out.push(round(v, digits));
  }
  return shuffleInPlace(out, rng);
}
function spreadSet(count, values, rng) {
  const out = []; for (let i = 0; i < count; i++) out.push(values[i % values.length]);
  return shuffleInPlace(out, rng);
}
function spreadBool(count, rng) {
  const out = []; for (let i = 0; i < count; i++) out.push(i < count / 2);
  return shuffleInPlace(out, rng);
}
function pickByAux(arr, a) { return arr[Math.min(arr.length - 1, Math.floor(a * arr.length))]; }

// ---- 维度配置：每个 key 与 UI 复选框 value 对应 ----
// make(R,ctx) 返回 {kind:'num',min,max,digits} | {kind:'set',values} | {kind:'bool'} | null(跳过)
// apply(o,v,aux,ctx) 把值写入 job 选项
const DIM_DEFS = {
  // 基础
  brightness: { make: (R) => ({ kind: 'num', min: -R.bri, max: R.bri, digits: 3 }), apply: (o, v) => { o.brightness = v; } },
  contrast: { make: (R) => ({ kind: 'num', min: 1 - R.con, max: 1 + R.con, digits: 3 }), apply: (o, v) => { o.contrast = v; } },
  saturation: { make: (R) => ({ kind: 'num', min: 1 - R.sat, max: 1 + R.sat, digits: 3 }), apply: (o, v) => { o.saturation = v; } },
  gamma: { make: (R) => ({ kind: 'num', min: 1 - R.gam, max: 1 + R.gam, digits: 3 }), apply: (o, v) => { o.gamma = v; } },
  sharpen: { make: (R) => ({ kind: 'num', min: 0, max: R.sharp, digits: 2 }), apply: (o, v) => { o.sharpen = v; } },
  blur: { make: (R) => ({ kind: 'num', min: 0, max: R.blur, digits: 2 }), apply: (o, v) => { o.blur = v; } },
  speed: { make: (R) => ({ kind: 'num', min: 1 - R.speed, max: 1 + R.speed, digits: 3 }), apply: (o, v) => { o.speed = v; } },
  zoom: { make: (R) => ({ kind: 'num', min: 0, max: R.zoom, digits: 3 }), apply: (o, v) => { o.zoom = v; } },
  flip: { make: () => ({ kind: 'bool' }), apply: (o, v) => { o.flip = v; } },
  startTime: { make: (R) => ({ kind: 'num', min: 0, max: R.startMax, digits: 2 }), apply: (o, v) => { o.startTime = v; } },
  fps: { make: (R) => ({ kind: 'set', values: R.fpsSet }), apply: (o, v) => { if (v) o.fps = v; } },
  bitrate: { make: (R) => ({ kind: 'num', min: 1 - R.bitJitter, max: 1 + R.bitJitter, digits: 3 }), apply: (o, v, aux, ctx) => { o.bitrate = Math.round(ctx.baseBitrateK * v) + 'k'; } },

  // 画面类
  temperature: { make: (R) => ({ kind: 'num', min: 6500 - R.temp, max: 6500 + R.temp, digits: 0 }), apply: (o, v) => { o.temperature = v; } },
  tint: { make: (R) => ({ kind: 'num', min: -R.tint, max: R.tint, digits: 3 }), apply: (o, v) => { o.tint = v; } },
  hue: { make: (R) => ({ kind: 'num', min: -R.hue, max: R.hue, digits: 2 }), apply: (o, v) => { o.hue = v; } },
  exposure: { make: (R) => ({ kind: 'num', min: -R.exposure, max: R.exposure, digits: 3 }), apply: (o, v) => { o.exposure = v; } },
  shadowHL: { make: (R) => ({ kind: 'num', min: -R.shadowHL, max: R.shadowHL, digits: 3 }), apply: (o, v) => { o.shadowHL = v; } },
  vignette: { make: (R) => ({ kind: 'num', min: 0, max: R.vignette, digits: 3 }), apply: (o, v) => { o.vignette = v; } },
  grain: { make: (R) => ({ kind: 'num', min: 0, max: R.grain, digits: 0 }), apply: (o, v) => { o.grain = v; } },
  denoise: { make: (R) => ({ kind: 'num', min: 0, max: R.denoise, digits: 2 }), apply: (o, v) => { o.denoise = v; } },

  // 编码与文件层
  gop: { make: () => ({ kind: 'set', values: [48, 60, 90, 120, 250] }), apply: (o, v) => { o.gop = v; } },
  profile: { make: (R, ctx) => (/x264/.test(ctx.codec) ? { kind: 'set', values: ['high', 'main'] } : null), apply: (o, v) => { o.profile = v; } },
  bframes: { make: (R, ctx) => (/x26[45]/.test(ctx.codec) ? { kind: 'set', values: [0, 1, 2, 3] } : null), apply: (o, v) => { o.bframes = v; } },
  colorTag: { make: () => ({ kind: 'set', values: ['bt709', 'bt601'] }), apply: (o, v) => { o.colorTag = v; } },
  clearMeta: { make: () => ({ kind: 'num', min: 0, max: 1, digits: 5 }), apply: (o, v, aux, ctx) => { o.clearMeta = true; o.metaComment = 'yd' + ctx.idx + '-' + Math.round(v * 1e5); } },
  container: { make: () => ({ kind: 'set', values: ['mp4', 'mov', 'mkv'] }), apply: (o, v) => { o.__ext = v; } },
  resJitter: {
    make: (R) => ({ kind: 'num', min: -R.resPx, max: R.resPx, digits: 0 }),
    apply: (o, v, aux, ctx) => {
      const even = (n) => { n = Math.round(n); return n % 2 ? n + 1 : n; };
      const dW = even(v); const dH = even((aux * 2 - 1) * ctx.R.resPx);
      o.vertical = Object.assign({}, o.vertical, {
        width: Math.max(2, even(ctx.vertical.width + dW)),
        height: Math.max(2, even(ctx.vertical.height + dH)),
      });
    },
  },

  // 构图与几何
  rotate: { make: (R) => ({ kind: 'num', min: -R.rotDeg, max: R.rotDeg, digits: 2 }), apply: (o, v) => { o.rotate = v; } },
  translate: { make: (R) => ({ kind: 'num', min: -R.panAmp, max: R.panAmp, digits: 3 }), apply: (o, v, aux, ctx) => { o.panX = v; o.panY = round((aux * 2 - 1) * ctx.R.panAmp, 3); } },
  perspective: { make: (R) => ({ kind: 'num', min: -R.persp, max: R.persp, digits: 4 }), apply: (o, v) => { o.perspective = v; } },

  // 音频维度
  volume: { make: (R) => ({ kind: 'num', min: 1 - R.vol, max: 1 + R.vol, digits: 3 }), apply: (o, v) => { o.volume = v; } },
  pitch: { make: (R) => ({ kind: 'num', min: 1 - R.pitch, max: 1 + R.pitch, digits: 4 }), apply: (o, v) => { o.pitch = v; } },
  audioEq: { make: (R) => ({ kind: 'num', min: -R.eqG, max: R.eqG, digits: 2 }), apply: (o, v, aux, ctx) => { o.bassGain = v; o.trebleGain = round((aux * 2 - 1) * ctx.R.eqG, 2); } },

  // 内容叠加
  border: { make: (R) => ({ kind: 'num', min: 3, max: R.borderMax, digits: 0 }), apply: (o, v, aux) => { o.border = { t: v, color: pickByAux(['black', 'white', 'black@0.7', 'white@0.7'], aux) }; } },
  progressBar: { make: (R) => ({ kind: 'num', min: 4, max: R.pbMax, digits: 0 }), apply: (o, v, aux) => { o.progressBar = { h: v, color: pickByAux(['white@0.85', 'red@0.8', 'cyan@0.85', 'yellow@0.8'], aux) }; } },
  cornerBadge: { make: (R) => ({ kind: 'num', min: 24, max: R.badgeMax, digits: 0 }), apply: (o, v, aux) => { o.cornerBadge = { size: v, margin: 16, corner: ['tr', 'tl', 'br', 'bl'][v % 4], color: pickByAux(['white@0.6', 'black@0.55', 'red@0.7', 'cyan@0.7'], aux) }; } },
  textMark: { make: (R) => ({ kind: 'num', min: 16, max: R.textMax, digits: 0 }), apply: (o, v, aux, ctx) => { o.textMark = { text: 'YD' + String(ctx.idx + 1).padStart(3, '0'), size: v, color: pickByAux(['white@0.5', 'white@0.35', 'black@0.5'], aux), x: pickByAux(['20', 'iw-tw-20'], aux), y: pickByAux(['20', 'ih-th-20'], (aux * 3) % 1) }; } },

  // ===== 新增 · 动态/运镜 =====
  kenburns: { make: (R) => ({ kind: 'num', min: R.kenAmp * 0.5, max: R.kenAmp, digits: 3 }), apply: (o, v, aux) => { o.kenburns = { zoom: v, dir: Math.floor(aux * 4) % 4 }; } },
  shake: { make: (R) => ({ kind: 'num', min: R.shakeAmp * 0.5, max: R.shakeAmp, digits: 1 }), apply: (o, v, aux) => { o.shake = { amp: v, freq: round(6 + aux * 6, 2) }; } },
  lut: { make: () => ({ kind: 'set', values: ['vintage', 'lighter', 'darker', 'increase_contrast', 'linear_contrast'] }), apply: (o, v) => { o.curvePreset = v; } },
  chromashift: { make: (R) => ({ kind: 'num', min: 1, max: R.chromaPx, digits: 0 }), apply: (o, v) => { o.chromashift = v; } },

  // ===== 新增 · 音频 =====
  reverb: { make: (R) => ({ kind: 'num', min: R.echoDelay * 0.6, max: R.echoDelay, digits: 0 }), apply: (o, v) => { o.echo = v; } },
  sampleRate: { make: () => ({ kind: 'set', values: [44100, 48000] }), apply: (o, v) => { o.sampleRate = v; } },
  audioBitrate: { make: () => ({ kind: 'set', values: [128, 192, 256] }), apply: (o, v) => { o.audioBitrateK = v; } },
  afade: { make: (R) => ({ kind: 'num', min: R.fadeDur * 0.5, max: R.fadeDur, digits: 2 }), apply: (o, v) => { o.afade = v; } },
  stereoPan: { make: (R) => ({ kind: 'num', min: -R.stereoBal, max: R.stereoBal, digits: 3 }), apply: (o, v) => { o.stereoBalance = v; } },

  // ===== 新增 · 编码/文件层 =====
  colorRange: { make: () => ({ kind: 'set', values: ['tv', 'pc'] }), apply: (o, v) => { o.colorRange = v; } },
  refs: { make: () => ({ kind: 'set', values: [2, 3, 4] }), apply: (o, v) => { o.refs = v; } },
  tune: { make: (R, ctx) => (/x264/.test(ctx.codec) ? { kind: 'set', values: ['film', 'grain', 'fastdecode'] } : null), apply: (o, v) => { o.tune = v; } },
  metaRich: {
    make: () => ({ kind: 'num', min: 0, max: 1, digits: 6 }),
    apply: (o, v, aux, ctx) => {
      o.clearMeta = true;
      const rid = Math.round(v * 1e6);
      o.metaTags = Object.assign({}, o.metaTags, {
        title: 'YD' + String(ctx.idx + 1).padStart(3, '0'),
        artist: 'creator' + (rid % 97),
        encoder: 'Lavf' + (58 + (rid % 6)) + '.' + (rid % 76),
        handler_name: 'vid' + rid,
      });
    },
  },
  timestamp: {
    make: () => ({ kind: 'num', min: 0, max: 1, digits: 6 }),
    apply: (o, v) => {
      o.clearMeta = true;
      const d = new Date(Date.now() - Math.round(v * 900) * 86400000);
      o.metaTags = Object.assign({}, o.metaTags, { creation_time: d.toISOString() });
    },
  },

  // ===== 新增 · 结构 =====
  tailTrim: { make: (R) => ({ kind: 'num', min: R.tailMax * 0.3, max: R.tailMax, digits: 2 }), apply: (o, v) => { o.tailTrim = v; } },
};

function makeValues(desc, count, rng) {
  if (desc.kind === 'num') return spreadNum(count, desc.min, desc.max, desc.digits, rng);
  if (desc.kind === 'set') return spreadSet(count, desc.values, rng);
  if (desc.kind === 'bool') return spreadBool(count, rng);
  return [];
}

function generateAutoJobs() {
  const count = clampInt(parseInt($('autoCount').value, 10) || 1, 1, 360);
  const intensity = $('autoIntensity').value;
  const R = INTENSITY[intensity] || INTENSITY.normal;
  const codec = $('autoCodec').value;
  const mute = $('autoMute').checked;
  const dims = Array.from($('autoDims').querySelectorAll('input[type=checkbox]:checked')).map((c) => c.value);

  const vertical = readVertical('bvEnabled', 'bvSize', 'bvMode');
  const baseName = baseFileName(batch.input);
  const baseBitrateK = batch.meta && batch.meta.bitrate ? Math.round(batch.meta.bitrate / 1000) : 4000;
  const ctxBase = { R, codec, baseBitrateK, vertical };
  const intensitySeed = strHash(intensity) ^ count;

  // 为每个参与维度预生成「确定性铺开」的取值数组 + 辅助通道
  const active = [];
  for (const key of dims) {
    const def = DIM_DEFS[key];
    if (!def) continue;
    const desc = def.make(R, ctxBase);
    if (!desc) continue;
    const seed = (strHash(key) ^ intensitySeed) >>> 0;
    const values = makeValues(desc, count, mulberry32(seed));
    const aux = spreadNum(count, 0, 0.999999, 6, mulberry32((seed ^ 0xabcdef) >>> 0));
    active.push({ key, def, values, aux });
  }

  const jobs = [];
  for (let i = 0; i < count; i++) {
    const idx = String(i + 1).padStart(3, '0');
    const o = {
      input: batch.input,
      codec,
      preset: 'veryfast',
      crf: 23,
      muteAudio: mute,
      vertical: Object.assign({}, vertical),
      totalDuration: batch.meta ? batch.meta.duration : 0,
    };
    const ctx = { R, codec, baseBitrateK, vertical, idx: i };
    for (const a of active) a.def.apply(o, a.values[i], a.aux[i], ctx);
    const ext = o.__ext || 'mp4';
    delete o.__ext;
    o.output = joinPath(batch.outDir, `${baseName}_抖音_${idx}.${ext}`);
    jobs.push(o);
  }
  return jobs;
}

function clampInt(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---- 路径/文件名工具 ----
function baseFileName(p) {
  const seg = p.replace(/\\/g, '/').split('/').pop();
  const dot = seg.lastIndexOf('.');
  return dot > 0 ? seg.substring(0, dot) : seg;
}
function joinPath(dir, name) {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.replace(/[\\/]$/, '') + sep + name;
}

/* ---- CSV 模板（中文表头 + 英文兼容） ---- */
const CSV_FIELDS = [
  { key: 'filename', zh: '文件名' },
  { key: 'codec', zh: '编码' },
  { key: 'fps', zh: '帧率' },
  { key: 'bitrate', zh: '码率' },
  { key: 'brightness', zh: '亮度' },
  { key: 'contrast', zh: '对比度' },
  { key: 'saturation', zh: '饱和度' },
  { key: 'gamma', zh: '伽马' },
  { key: 'sharpen', zh: '锐化' },
  { key: 'blur', zh: '模糊' },
  { key: 'speed', zh: '变速' },
  { key: 'zoom', zh: '缩放' },
  { key: 'flip', zh: '水平镜像' },
  { key: 'startTime', zh: '起始秒' },
  { key: 'duration', zh: '时长' },
  { key: 'muteAudio', zh: '移除音频' },
  { key: 'vertical_mode', zh: '竖屏模式' },
  { key: 'vertical_size', zh: '竖屏尺寸' },
];
const CSV_DEMO_ROWS = [
  ['示例_01', 'libx264', '30', '4000k', '0.03', '1.02', '1.05', '1.00', '0.3', '', '1.01', '0.02', '0', '0', '', '0', 'fill', '1080x1920'],
  ['示例_02', 'libx264', '', '3500k', '-0.02', '0.98', '0.95', '1.03', '0.5', '', '0.98', '0.03', '1', '0.2', '', '0', 'blur', '1080x1920'],
  ['示例_03', 'libx265', '25', '', '0.05', '1.05', '1.10', '0.97', '0', '0.4', '1.03', '0', '0', '0', '15', '0', 'fit', '720x1280'],
];
function buildCsvText() {
  const lines = [CSV_FIELDS.map((f) => f.zh).join(',')];
  CSV_DEMO_ROWS.forEach((r) => lines.push(r.join(',')));
  return lines.join('\r\n');
}

$('csvDownload').addEventListener('click', async () => {
  const p = await window.api.saveCsvDemo(buildCsvText());
  if (p) toast('模板已保存：' + p, 'success');
});

// 简单 CSV 解析（支持引号）
function parseCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  for (const line of lines) {
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ',') { cells.push(cur); cur = ''; }
        else cur += ch;
      }
    }
    cells.push(cur);
    rows.push(cells.map((c) => c.trim()));
  }
  return rows;
}

function csvRowsToJobs(rows) {
  // 将表头（中文或英文）映射为内部字段 key -> 列下标
  const header = rows[0].map((h) => h.trim());
  const colIndex = {};
  header.forEach((cell, i) => {
    const lower = cell.toLowerCase();
    const field = CSV_FIELDS.find((f) => f.zh === cell || f.key.toLowerCase() === lower);
    if (field) colIndex[field.key] = i;
  });
  const jobs = [];
  const baseName = baseFileName(batch.input);
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row.length || row.every((c) => !c)) continue;
    const get = (name) => { const i = colIndex[name]; return i != null && i >= 0 ? (row[i] || '') : ''; };
    const n = (name) => { const v = parseFloat(get(name)); return isNaN(v) ? undefined : v; };

    const fname = get('filename') || `${baseName}_${String(jobs.length + 1).padStart(3, '0')}`;
    let vmode = (get('vertical_mode') || '').toLowerCase();
    const vsize = get('vertical_size');
    let vertical = readVertical('bvEnabled', 'bvSize', 'bvMode');
    if (vmode || vsize) {
      const [w, h] = (vsize || `${vertical.width}x${vertical.height}`).split('x').map(Number);
      vertical = { enabled: true, mode: vmode || vertical.mode, width: w || 1080, height: h || 1920 };
    }
    const o = {
      input: batch.input,
      output: joinPath(batch.outDir, fname.replace(/\.[^.]+$/, '') + '.mp4'),
      codec: get('codec') || 'libx264',
      preset: 'veryfast',
      crf: 23,
      bitrate: get('bitrate') || undefined,
      fps: n('fps'),
      brightness: n('brightness'),
      contrast: n('contrast'),
      saturation: n('saturation'),
      gamma: n('gamma'),
      sharpen: n('sharpen'),
      blur: n('blur'),
      speed: n('speed'),
      zoom: n('zoom'),
      flip: /^(1|true|yes|是)$/i.test(get('flip')),
      startTime: n('startTime'),
      duration: n('duration'),
      muteAudio: /^(1|true|yes|是)$/i.test(get('muteAudio')),
      vertical,
      totalDuration: batch.meta ? batch.meta.duration : 0,
    };
    jobs.push(o);
  }
  return jobs;
}

$('csvOpen').addEventListener('click', async () => {
  const res = await window.api.openCsv();
  if (!res) return;
  try {
    const rows = parseCsv(res.text);
    if (rows.length < 2) throw new Error('CSV 至少需要表头 + 1 行数据');
    batch.csvRows = rows;
    const dataCount = rows.length - 1;
    $('csvStatus').textContent = `已导入 ${dataCount} 行 → 将生成 ${dataCount} 条视频`;
    $('csvStatus').classList.add('ok');
    $('csvPreview').hidden = false;
    $('csvPreview').textContent = rows.slice(0, 8).map((r) => r.join(' | ')).join('\n') + (rows.length > 8 ? '\n…' : '');
  } catch (e) {
    toast('CSV 解析失败：' + e.message, 'error');
  }
  refreshBatchRunState();
});

/* ---- 批量执行与进度 ---- */
let batchJobs = [];

function renderResultList(jobs) {
  const list = $('bResultList');
  list.innerHTML = '';
  jobs.forEach((j, i) => {
    const el = document.createElement('div');
    el.className = 'result-item pending';
    el.id = 'ri-' + i;
    el.innerHTML =
      `<span class="ri-status">⏳</span>` +
      `<span class="ri-name">${baseFileName(j.output)}.mp4</span>` +
      `<span class="ri-info"></span>`;
    list.appendChild(el);
  });
}

window.api.onBatchItemStart(({ index }) => {
  const el = $('ri-' + index);
  if (el) { el.className = 'result-item running'; el.querySelector('.ri-status').textContent = '▶'; el.querySelector('.ri-info').textContent = '处理中…'; }
  $('bItemWrap').hidden = false;
  $('bItemFill').style.width = '0%';
  $('bItemText').textContent = '0%';
});
window.api.onBatchProgress(({ index, pct }) => {
  $('bItemFill').style.width = pct + '%';
  $('bItemText').textContent = pct + '%';
});
window.api.onBatchItemDone(({ index, ok, output, error }) => {
  const el = $('ri-' + index);
  if (el) {
    el.className = 'result-item ' + (ok ? 'ok' : 'fail');
    el.querySelector('.ri-status').textContent = ok ? '✔' : '✘';
    const info = el.querySelector('.ri-info');
    if (ok) {
      info.innerHTML = '<span class="ri-open">打开</span>';
      info.querySelector('.ri-open').addEventListener('click', () => window.api.showItem(output));
    } else {
      info.textContent = (error || '失败').split('\n').pop().slice(0, 40);
    }
  }
  const done = document.querySelectorAll('.result-item.ok, .result-item.fail').length;
  const total = batchJobs.length;
  $('bOverallFill').style.width = Math.round((done / total) * 100) + '%';
  $('bOverallText').textContent = `${done} / ${total}`;
});

$('bRun').addEventListener('click', async () => {
  if (batch.running) return;
  if (!batch.input) return toast('请先选择原视频', 'error');
  if (!batch.outDir) return toast('请先选择输出目录', 'error');

  try {
    batchJobs = batch.mode === 'auto' ? generateAutoJobs() : csvRowsToJobs(batch.csvRows);
  } catch (e) {
    return toast('生成任务失败：' + e.message, 'error');
  }
  if (!batchJobs.length) return toast('没有可生成的任务', 'error');

  batch.running = true;
  $('bRun').disabled = true;
  $('bRun').textContent = '生成中…';
  $('bCancel').hidden = false;
  $('bShowDir').hidden = false;
  $('bOverallWrap').hidden = false;
  $('bOverallFill').style.width = '0%';
  $('bOverallText').textContent = `0 / ${batchJobs.length}`;
  $('batchSummary').textContent = `共 ${batchJobs.length} 条`;
  $('engineStatus').textContent = '批量处理中…';
  $('engineStatus').classList.add('busy');
  renderResultList(batchJobs);

  try {
    const res = await window.api.runBatch(batchJobs);
    const okCount = res.results.filter((r) => r.ok).length;
    if (res.cancelled) toast(`已停止，已完成 ${okCount} 条`, 'error');
    else toast(`批量完成！成功 ${okCount} / ${res.total} 条`, 'success');
  } catch (e) {
    toast('批量执行出错：' + e.message, 'error');
  } finally {
    batch.running = false;
    $('bRun').disabled = false;
    $('bRun').textContent = '开始批量生成';
    $('bCancel').hidden = true;
    $('bItemWrap').hidden = true;
    $('engineStatus').textContent = 'FFmpeg 引擎就绪';
    $('engineStatus').classList.remove('busy');
    refreshBatchRunState();
  }
});

$('bCancel').addEventListener('click', async () => {
  await window.api.cancelBatch();
  toast('正在停止…', 'error');
});

$('bShowDir').addEventListener('click', () => {
  if (batch.outDir) window.api.openPath(batch.outDir);
});

$('bvEnabled, bvSize, bvMode'.split(', ')).forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener('change', () => {});
});
