'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ffmpegPath, ffprobePath, buildContentFilters } = require('./ffmpeg-engine');

/* ============ 工作区 ============ */
// 工作区子目录（中文名）
const DIR = {
  input: '原片', segments: '切片', temp: '临时文件', output: '成片',
  delivery: '交付包', logs: '日志', manifests: '进度数据',
};
const WORKSPACE_DIRS = Object.values(DIR);
const MANIFEST_FILES = {
  project: 'project.json',
  assets: 'assets.manifest.json',
  segments: 'segments.manifest.json',
  templates: 'templates.manifest.json',
  renderJobs: 'render-jobs.manifest.json',
  quality: 'quality.manifest.json',
  delivery: 'delivery.manifest.json',
};

function initWorkspace(dir) {
  WORKSPACE_DIRS.forEach((d) => fs.mkdirSync(path.join(dir, d), { recursive: true }));
  const manifestDir = path.join(dir, DIR.manifests);
  const loaded = {};
  for (const [key, file] of Object.entries(MANIFEST_FILES)) {
    loaded[key] = readJson(path.join(manifestDir, file));
  }
  if (!loaded.project) {
    loaded.project = { workspace: dir, createdAt: new Date().toISOString(), batchSeq: 0 };
    writeManifest(dir, 'project', loaded.project);
  }
  if (!loaded.templates) {
    loaded.templates = builtinTemplates();
    writeManifest(dir, 'templates', loaded.templates);
  }
  return loaded;
}

function readJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

// 写 manifest：先备份 .bak，再原子写入（写临时文件后改名）
function writeManifest(workspace, key, data) {
  const file = MANIFEST_FILES[key];
  if (!file) throw new Error('未知 manifest: ' + key);
  const target = path.join(workspace, DIR.manifests, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    try { fs.copyFileSync(target, target + '.bak'); } catch (e) { /* noop */ }
  }
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  return target;
}

/* ============ 内置模板 ============ */
// 切片顺序按切片标签（切片1/切片2…）配置，初始为空，待切片后在「模板」步骤里选择与排序
function builtinTemplates() {
  return [
    { id: 'TPL01', name: '竖屏顺序(9:16)', aspectRatio: '9:16', durationTarget: 0, segmentOrder: [], speedOptions: [1] },
    { id: 'TPL02', name: '竖屏快剪(9:16)', aspectRatio: '9:16', durationTarget: 0, segmentOrder: [], speedOptions: [1, 1.05] },
    { id: 'TPL03', name: '方形展示(1:1)', aspectRatio: '1:1', durationTarget: 0, segmentOrder: [], speedOptions: [1] },
  ];
}

const RATIO_RES = {
  '9:16': { w: 1080, h: 1920 },
  '1:1': { w: 1080, h: 1080 },
  '16:9': { w: 1920, h: 1080 },
};

/* ============ ffprobe 元信息 ============ */
function probe(input) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', input];
    const proc = spawn(ffprobePath, args);
    let out = '', err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `ffprobe ${code}`));
      try {
        const data = JSON.parse(out);
        const v = (data.streams || []).find((s) => s.codec_type === 'video') || {};
        const a = (data.streams || []).find((s) => s.codec_type === 'audio');
        let fps = 0;
        if (v.r_frame_rate && v.r_frame_rate.includes('/')) {
          const [n, d] = v.r_frame_rate.split('/').map(Number);
          if (d) fps = n / d;
        }
        resolve({
          duration: parseFloat((data.format && data.format.duration) || v.duration || 0),
          size: parseInt((data.format && data.format.size) || 0, 10),
          width: v.width || 0, height: v.height || 0,
          vcodec: v.codec_name || '', acodec: a ? a.codec_name : '',
          hasAudio: !!a,
          fps: fps ? Math.round(fps * 100) / 100 : 0,
          bitrate: parseInt((data.format && data.format.bit_rate) || 0, 10),
        });
      } catch (e) { reject(e); }
    });
  });
}

/* ============ 通用 ffmpeg 执行 ============ */
const _procs = new Set();   // 支持并发：跟踪所有运行中的进程
let _cancelled = false;
let _paused = false;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function runFfmpeg(args, totalSeconds, onProgress, onLog) {
  return new Promise((resolve, reject) => {
    if (onLog) onLog('ffmpeg ' + args.join(' '));
    const proc = spawn(ffmpegPath, args);
    _procs.add(proc);
    let stderr = '';
    proc.stderr.on('data', (d) => {
      const line = d.toString();
      stderr += line;
      const m = line.match(/time=(\d+:\d+:\d+\.\d+)/);
      if (m && totalSeconds > 0 && onProgress) {
        const parts = m[1].split(':').map(parseFloat);
        const cur = parts[0] * 3600 + parts[1] * 60 + parts[2];
        onProgress(Math.min(100, Math.round((cur / totalSeconds) * 100)));
      }
    });
    proc.on('error', (e) => { _procs.delete(proc); reject(e); });
    proc.on('close', (code) => {
      _procs.delete(proc);
      if (code === 0) resolve(true);
      else reject(new Error(stderr.split('\n').slice(-10).join('\n') || `ffmpeg ${code}`));
    });
  });
}

// 运行到 null 输出，仅采集 stderr（用于黑屏/静音检测）
function runNull(args) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, args);
    _procs.add(proc);
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', () => { _procs.delete(proc); resolve(''); });
    proc.on('close', () => { _procs.delete(proc); resolve(err); });
  });
}

function cancel() {
  _cancelled = true;
  _paused = false;
  for (const p of _procs) { try { p.kill('SIGKILL'); } catch (e) { /* noop */ } }
  _procs.clear();
}

function setPaused(v) { _paused = !!v; }

/* ============ 切片 ============ */
// seg: { input, start, end, output }  统一重编码，便于后续拼接
function buildCutArgs(seg) {
  const dur = Math.max(0.1, seg.end - seg.start);
  return [
    '-ss', String(seg.start), '-i', seg.input, '-t', String(dur),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2',
    '-y', seg.output,
  ];
}

/* ============ 拼接渲染 ============ */
// job: { inputs:[{path,hasAudio}], width, height, fps, speed, output,
//        audio:{ mode:'original'|'music'|'mix'|'mute', musicPath, musicVolume, originalVolume } }
function buildRenderArgs(job, forceMute = false) {
  const dedup = job.dedup || null;
  const enc = (dedup && dedup.enc) || {};
  const W = job.width, H = job.height;
  const fps = (enc.fps && enc.fps > 0) ? enc.fps : (job.fps || 30);
  const n = job.inputs.length;
  const allAudio = job.inputs.every((i) => i.hasAudio);
  const speed = job.speed && job.speed !== 1 ? job.speed : null;
  const atempo = speed ? Math.max(0.5, Math.min(2, speed)).toFixed(4) : null;

  const audio = job.audio || {};
  let mode = forceMute ? 'mute' : (audio.mode || 'original');
  const musicPath = audio.musicPath;
  if ((mode === 'music' || mode === 'mix') && !musicPath) mode = 'original';
  if (mode === 'original' && !allAudio) mode = 'mute';   // 原声但有片段缺音轨 → 转静音
  if (mode === 'mix' && !allAudio) mode = 'music';       // 混音但无原声 → 仅配乐

  // 切片间转场：需 ≥2 段且每段已知时长；用 xfade(视频) / acrossfade(音频) 实现
  const transition = (job.transition && job.transition.dur > 0 && n >= 2
    && job.inputs.every((i) => i.duration > 0)) ? job.transition : null;

  const args = [];
  job.inputs.forEach((i) => args.push('-i', i.path));
  let musicIdx = -1;
  if (mode === 'music' || mode === 'mix') { args.push('-stream_loop', '-1', '-i', musicPath); musicIdx = n; }

  let fc = '';
  // 视频：先把每段统一到目标画布/帧率
  for (let i = 0; i < n; i++) {
    fc += `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps}[v${i}];`;
  }
  if (transition) {
    // 转场：xfade 链式叠加，offset = 当前累计时长 - 重叠时长
    const D = transition.dur;
    let prev = '[v0]';
    let L = job.inputs[0].duration;
    for (let k = 1; k < n; k++) {
      const name = (transition.names && (transition.names[k - 1] || transition.names[0])) || 'fade';
      const off = Math.max(0, L - D).toFixed(3);
      const out = (k === n - 1) ? '[vcat]' : `[vxf${k}]`;
      fc += `${prev}[v${k}]xfade=transition=${name}:duration=${D.toFixed(3)}:offset=${off}${out};`;
      prev = out;
      L = L + job.inputs[k].duration - D;
    }
  } else {
    const vlabels = [];
    for (let i = 0; i < n; i++) vlabels.push(`[v${i}]`);
    fc += vlabels.join('') + `concat=n=${n}:v=1:a=0[vcat];`;
  }
  let vOut = '[vcat]';
  if (speed) { fc += `[vcat]setpts=${(1 / speed).toFixed(4)}*PTS[vsp];`; vOut = '[vsp]'; }

  // 逐条随机去重：在拼接(及变速)之后注入调色/几何/噪点等内容滤镜，
  // 并归一化回目标分辨率，避免几何变换导致质检「分辨率不符」。
  if (dedup) {
    const cf = buildContentFilters(dedup);
    if (cf.length) {
      fc += `${vOut}${cf.join(',')},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[vdd];`;
      vOut = '[vdd]';
    }
  }

  // 音频
  let aOut = null;
  const needOrig = (mode === 'original' || mode === 'mix');
  if (needOrig) {
    for (let i = 0; i < n; i++) fc += `[${i}:a]aresample=48000[a${i}];`;
    if (transition) {
      // 音频随转场淡接，保持与视频等长
      const D = transition.dur;
      let prev = '[a0]';
      for (let k = 1; k < n; k++) {
        const out = (k === n - 1) ? '[acat]' : `[axf${k}]`;
        fc += `${prev}[a${k}]acrossfade=d=${D.toFixed(3)}:c1=tri:c2=tri${out};`;
        prev = out;
      }
    } else {
      const al = [];
      for (let i = 0; i < n; i++) al.push(`[a${i}]`);
      fc += al.join('') + `concat=n=${n}:v=0:a=1[acat];`;
    }
    let oa = '[acat]';
    if (atempo) { fc += `[acat]atempo=${atempo}[asp];`; oa = '[asp]'; }
    if (mode === 'original') {
      aOut = oa;
    } else { // mix
      const mv = audio.musicVolume != null ? audio.musicVolume : 0.3;
      const ov = audio.originalVolume != null ? audio.originalVolume : 1.0;
      fc += `${oa}volume=${ov}[ov];[${musicIdx}:a]volume=${mv}[mv];[ov][mv]amix=inputs=2:duration=first:dropout_transition=0[aout];`;
      aOut = '[aout]';
    }
  } else if (mode === 'music') {
    const mv = audio.musicVolume != null ? audio.musicVolume : 1.0;
    fc += `[${musicIdx}:a]volume=${mv}[aout];`;
    aOut = '[aout]';
  }

  fc = fc.replace(/;$/, '');

  args.push('-filter_complex', fc, '-map', vOut);
  if (aOut) args.push('-map', aOut);
  const crf = (enc.crf != null && !isNaN(enc.crf)) ? Math.max(14, Math.min(34, Math.round(enc.crf))) : 23;
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(crf), '-preset', 'veryfast', '-r', String(fps));
  // 编码层随机去重：GOP / B帧 / profile 改变编码指纹
  if (enc.gop && enc.gop > 0) args.push('-g', String(Math.round(enc.gop)));
  if (enc.bframes != null && !isNaN(enc.bframes)) args.push('-bf', String(Math.max(0, Math.min(8, Math.round(enc.bframes)))));
  if (enc.profile) args.push('-profile:v', String(enc.profile));
  if (aOut) args.push('-c:a', 'aac', '-b:a', '192k'); else args.push('-an');
  // 时长封顶：模板「目标时长」用于裁剪；配乐为无限循环也必须封顶，否则不会终止
  let cap = (job.trimTo && job.trimTo > 0) ? job.trimTo : null;
  // 随机微剪：在原时长基础上裁掉尾部一小段，改变时长与帧序列（强去重）
  const tailTrim = dedup && dedup.tailTrim > 0 ? dedup.tailTrim : 0;
  if (tailTrim > 0) {
    const base = cap != null ? cap : (job.estDuration > 0 ? job.estDuration : 0);
    if (base > 0) cap = Math.max(0.5, +(base - tailTrim).toFixed(3));
  }
  if (mode === 'music' || mode === 'mix') {
    const musicCap = cap != null ? cap : (job.estDuration > 0 ? job.estDuration : null);
    if (musicCap != null) args.push('-t', String(Number(musicCap).toFixed(3)));
    else args.push('-shortest');
  } else if (cap != null) {
    args.push('-t', String(Number(cap).toFixed(3)));
  }
  // 元数据去重：清空原始元数据并写入自定义注释（改变文件层指纹）
  if (dedup) {
    args.push('-map_metadata', '-1');
    if (dedup.comment) args.push('-metadata', 'comment=' + dedup.comment);
  }
  args.push('-movflags', '+faststart', '-y', job.output);
  return args;
}

// 生成封面（取第 1 秒一帧）
function buildCoverArgs(input, output) {
  return ['-ss', '1', '-i', input, '-frames:v', '1', '-q:v', '3', '-y', output];
}

/* ============ 批量执行（切片 / 渲染） ============ */
async function runQueue(items, buildArgs, estDuration, hooks) {
  _cancelled = false;
  const results = [];
  for (let i = 0; i < items.length; i++) {
    if (_cancelled) break;
    if (hooks.itemStart) hooks.itemStart(i, items[i]);
    try {
      await runFfmpeg(
        buildArgs(items[i]),
        estDuration ? estDuration(items[i]) : 0,
        (pct) => hooks.progress && hooks.progress(i, pct),
        (line) => hooks.log && hooks.log(i, line)
      );
      results.push({ index: i, ok: true, output: items[i].output });
      if (hooks.itemDone) hooks.itemDone(i, { ok: true, output: items[i].output });
    } catch (e) {
      results.push({ index: i, ok: false, output: items[i].output, error: e.message });
      if (hooks.itemDone) hooks.itemDone(i, { ok: false, output: items[i].output, error: e.message });
    }
  }
  return { results, cancelled: _cancelled, total: items.length };
}

// 渲染队列：并发池 + 暂停/继续 + 失败自动去音频重试
async function runRenderJobs(items, hooks, options = {}) {
  _cancelled = false;
  _paused = false;
  const concurrency = Math.max(1, Math.min(6, options.concurrency || 1));
  const results = new Array(items.length).fill(null);
  let next = 0;

  async function processItem(i) {
    if (hooks.itemStart) hooks.itemStart(i);
    const job = items[i];
    let ok = false, err = null, note = null;
    try {
      await runFfmpeg(buildRenderArgs(job, false), job.estDuration || 0, (p) => hooks.progress && hooks.progress(i, p));
      ok = true;
    } catch (e) {
      err = e.message;
      if (!_cancelled) {
        try {
          await runFfmpeg(buildRenderArgs(job, true), job.estDuration || 0, (p) => hooks.progress && hooks.progress(i, p));
          ok = true; note = '音频处理失败，已自动转静音后成功'; err = null;
        } catch (e2) { err = e2.message; }
      }
    }
    results[i] = { index: i, ok, output: job.output, error: err, note };
    if (hooks.itemDone) hooks.itemDone(i, results[i]);
  }

  async function worker() {
    while (true) {
      if (_cancelled) return;
      while (_paused && !_cancelled) await sleep(250);
      if (_cancelled) return;
      const i = next++;
      if (i >= items.length) return;
      await processItem(i);
    }
  }

  const workers = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);
  return { results: results.filter(Boolean), cancelled: _cancelled, total: items.length };
}

/* ============ 质检 ============ */
// 黑屏检测：返回黑屏总秒数
async function detectBlack(file) {
  const out = await runNull(['-i', file, '-vf', 'blackdetect=d=0.1:pix_th=0.10', '-an', '-f', 'null', '-']);
  let total = 0; const re = /black_duration:(\d+(?:\.\d+)?)/g; let m;
  while ((m = re.exec(out))) total += parseFloat(m[1]);
  return total;
}
// 静音检测：返回静音总秒数
async function detectSilence(file) {
  const out = await runNull(['-i', file, '-af', 'silencedetect=noise=-50dB:d=0.5', '-vn', '-f', 'null', '-']);
  let total = 0; const re = /silence_duration:\s*(\d+(?:\.\d+)?)/g; let m;
  while ((m = re.exec(out))) total += parseFloat(m[1]);
  return total;
}

async function qualityCheck(item) {
  // item: { jobId, filePath, expectW, expectH, targetDuration, deep }
  const reasons = [];
  const warnings = [];
  let passed = true;
  let meta = null;
  if (!fs.existsSync(item.filePath)) {
    return { jobId: item.jobId, filePath: item.filePath, passed: false, reasons: ['文件不存在'] };
  }
  const size = fs.statSync(item.filePath).size;
  if (size < 500 * 1024) { reasons.push('文件过小(<500KB)'); passed = false; }
  try {
    meta = await probe(item.filePath);
  } catch (e) {
    return { jobId: item.jobId, filePath: item.filePath, passed: false, fileSize: size, reasons: ['无法读取(可能损坏)'] };
  }
  // 时长检查（含过短）
  if (!meta.duration || meta.duration < 0.5) { reasons.push('时长异常'); passed = false; }
  else if (meta.duration < 1) { reasons.push('视频过短(<1s)'); passed = false; }
  else if (item.targetDuration && meta.duration < item.targetDuration * 0.5) { warnings.push(`偏短(${meta.duration.toFixed(1)}s)`); }
  // 分辨率
  if (item.expectW && (meta.width !== item.expectW || meta.height !== item.expectH)) {
    reasons.push(`分辨率不符(${meta.width}x${meta.height})`); passed = false;
  }
  // 深度检查：黑屏 / 静音
  if (item.deep) {
    try {
      const black = await detectBlack(item.filePath);
      if (black > 0.5) warnings.push(`黑屏${black.toFixed(1)}s`);
    } catch (e) { /* noop */ }
    if (!meta.hasAudio) {
      warnings.push('无音轨');
    } else {
      try {
        const sil = await detectSilence(item.filePath);
        if (sil >= meta.duration - 0.6) warnings.push('整条静音');
      } catch (e) { /* noop */ }
    }
  }
  return {
    jobId: item.jobId, filePath: item.filePath, passed,
    duration: meta.duration, resolution: `${meta.width}x${meta.height}`,
    fileSize: size, reasons: reasons.concat(warnings.map((w) => '⚠' + w)), warnings,
  };
}

/* ============ 交付导出 ============ */
function pad(n, len = 3) { return String(n).padStart(len, '0'); }

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function exportDelivery(payload, hooks) {
  // payload: { workspace, batchId, items:[{job, qc}], stats }
  const { workspace, batchId } = payload;
  const dateStr = new Date().toISOString().slice(0, 10);
  const batchNo = String(batchId).replace(/[^0-9]/g, '') || '001';
  const batchDir = path.join(workspace, DIR.delivery, `${dateStr}_批次${batchNo}`);
  const videosDir = path.join(batchDir, '视频');
  const coversDir = path.join(batchDir, '封面');
  fs.mkdirSync(videosDir, { recursive: true });
  fs.mkdirSync(coversDir, { recursive: true });

  const passed = payload.items.filter((it) => it.qc && it.qc.passed);
  const manifestItems = [];

  for (let i = 0; i < passed.length; i++) {
    const { job, qc } = passed[i];
    const destVideo = path.join(videosDir, job.outputFileName);
    fs.copyFileSync(job.outputPath, destVideo);
    const coverName = job.outputFileName.replace(/\.[^.]+$/, '.jpg');
    const destCover = path.join(coversDir, coverName);
    try {
      await runFfmpeg(buildCoverArgs(destVideo, destCover), 0, null, null);
    } catch (e) { /* 封面失败不阻断 */ }
    manifestItems.push({
      materialId: job.id, batchId, templateId: job.templateId,
      fileName: job.outputFileName, filePath: destVideo,
      duration: qc.duration || 0, resolution: qc.resolution || '',
      segmentOrder: (job.segmentLabels || []).join('|'), sourceAssetIds: job.sourceAssetIds || [],
      dedupSeed: job.dedup && job.dedup.seed != null ? job.dedup.seed : '',
      dedup: job.dedup || null,
      transition: job.transition || null,
      createdAt: new Date().toISOString(),
    });
    if (hooks && hooks.progress) hooks.progress(Math.round(((i + 1) / passed.length) * 100));
  }

  // delivery-manifest.json / csv
  fs.writeFileSync(path.join(batchDir, 'delivery-manifest.json'), JSON.stringify(manifestItems, null, 2), 'utf8');
  const cols = ['materialId', 'batchId', 'templateId', 'fileName', 'filePath', 'duration', 'resolution', 'segmentOrder', 'sourceAssetIds', 'dedupSeed', 'createdAt'];
  const csvLines = [cols.join(',')];
  manifestItems.forEach((m) => csvLines.push(cols.map((c) => csvEscape(Array.isArray(m[c]) ? m[c].join('|') : m[c])).join(',')));
  fs.writeFileSync(path.join(batchDir, 'delivery-manifest.csv'), '\ufeff' + csvLines.join('\r\n'), 'utf8');

  // qc-report.json / csv
  const qcAll = payload.items.map((it) => it.qc).filter(Boolean);
  fs.writeFileSync(path.join(batchDir, 'qc-report.json'), JSON.stringify(qcAll, null, 2), 'utf8');
  const qcCols = ['jobId', 'filePath', 'passed', 'duration', 'resolution', 'fileSize', 'reasons'];
  const qcLines = [qcCols.join(',')];
  qcAll.forEach((q) => qcLines.push(qcCols.map((c) => csvEscape(Array.isArray(q[c]) ? q[c].join('|') : q[c])).join(',')));
  fs.writeFileSync(path.join(batchDir, 'qc-report.csv'), '\ufeff' + qcLines.join('\r\n'), 'utf8');

  // readme.txt
  const s = payload.stats || {};
  const readme = [
    `批次名称：${dateStr}_${batchId}`,
    `生成时间：${new Date().toLocaleString()}`,
    `原片数量：${s.assetCount || 0}`,
    `模板数量：${s.templateCount || 0}`,
    `计划生成数量：${s.planned || payload.items.length}`,
    `成功视频数量：${s.success || 0}`,
    `失败视频数量：${s.failed || 0}`,
    `质检通过数量：${passed.length}`,
    `质检失败数量：${qcAll.length - passed.length}`,
    `说明：本交付包由「一刀 · 千川素材交付」生成，仅包含素材文件，不含投放数据。`,
  ].join('\r\n');
  fs.writeFileSync(path.join(batchDir, 'readme.txt'), readme, 'utf8');

  return { batchDir, deliveredCount: passed.length, manifestItems };
}

module.exports = {
  initWorkspace, writeManifest, readJson,
  probe, RATIO_RES,
  buildCutArgs, buildRenderArgs,
  runQueue, runRenderJobs, qualityCheck, exportDelivery,
  cancel, setPaused, pad,
};
