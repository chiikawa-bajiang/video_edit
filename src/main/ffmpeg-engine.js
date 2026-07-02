'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function resolveBinary(mod) {
  let p = mod;
  if (p && typeof p === 'object' && p.path) p = p.path;
  if (typeof p !== 'string') return null;
  return p.replace('app.asar', 'app.asar.unpacked');
}

const ffmpegPath = resolveBinary(require('ffmpeg-static'));
const ffprobePath = resolveBinary(require('ffprobe-static'));

// 各平台内置字体（drawtext 默认字体）。冒号在滤镜串里需转义（Windows 盘符）。
function defaultFontFile() {
  switch (process.platform) {
    case 'win32':
      return 'C\\:/Windows/Fonts/arial.ttf';
    case 'darwin':
      return '/System/Library/Fonts/Supplemental/Arial.ttf';
    default:
      return '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  }
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? undefined : n;
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 构建“内容”滤镜（竖屏画布与叠加层之外的所有处理）。
 * 顺序：去噪 -> 几何(透视/旋转/裁切变焦+平移/翻转/缩放) -> 变速 ->
 *      调色(eq/色温/色调/色相/曝光/阴影高光) -> 锐化 -> 模糊 -> 噪点 -> 暗角
 */
function buildContentFilters(opts) {
  const f = [];

  // ---- 去噪（尽量靠前）----
  const denoise = num(opts.denoise);
  if (denoise && denoise > 0) {
    const l = clamp(denoise, 0.1, 8);
    f.push(`hqdn3d=${l.toFixed(2)}:${(l * 0.75).toFixed(2)}:${(l * 3).toFixed(2)}:${(l * 3).toFixed(2)}`);
  }

  // ---- 几何：透视 ----
  const persp = num(opts.perspective);
  if (persp && Math.abs(persp) > 0.001) {
    const s = clamp(persp, -0.12, 0.12);
    // 水平梯形：顶部相对底部横向偏移 s*W
    const dx = `${s.toFixed(4)}*W`;
    f.push(`perspective=x0=${dx}:y0=0:x1=W+${dx}:y1=0:x2=0:y2=H:x3=W:y3=H:interpolation=linear`);
  }

  // ---- 几何：旋转 ----
  const rotDeg = num(opts.rotate);
  let rotRad = 0;
  if (rotDeg && Math.abs(rotDeg) > 0.001) {
    rotRad = clamp(rotDeg, -8, 8) * Math.PI / 180;
    f.push(`rotate=${rotRad.toFixed(5)}:ow=iw:oh=ih:c=black`);
  }

  // ---- 几何：裁切变焦 + 平移（合并为一次 crop，并为旋转/平移预留余量隐藏黑边）----
  let z = num(opts.zoom) || 0;
  const panX = clamp(num(opts.panX) || 0, -1, 1);
  const panY = clamp(num(opts.panY) || 0, -1, 1);
  const needPan = panX !== 0 || panY !== 0;
  if (rotRad) z = Math.max(z, 0.04 + Math.abs(rotDeg) * 0.02);
  if (needPan) z = Math.max(z, 0.06);
  if (z > 0) {
    z = clamp(z, 0.01, 0.3);
    const keep = (1 - z).toFixed(4);
    // 中心 + 平移；偏移上限为可用余量，保证不超出边界
    const ox = `iw*${(z / 2).toFixed(4)}*${(1 + panX).toFixed(4)}`;
    const oy = `ih*${(z / 2).toFixed(4)}*${(1 + panY).toFixed(4)}`;
    f.push(`crop=iw*${keep}:ih*${keep}:${ox}:${oy}`);
  }

  // ---- 几何：动态运镜（Ken Burns，随时间缓慢推拉/平移）----
  const kb = opts.kenburns;
  const kbDur = effectiveDuration(opts);
  if (kb && num(kb.zoom) > 0 && kbDur > 0) {
    const kz = clamp(num(kb.zoom), 0.01, 0.2);
    const keep = (1 - kz).toFixed(4);
    const ow = `floor(iw*${keep}/2)*2`;
    const oh = `floor(ih*${keep}/2)*2`;
    const p = `min(t/${kbDur.toFixed(3)}\\,1)`;
    const cx = `(iw-ow)/2`;
    const cy = `(ih-oh)/2`;
    let xExpr = cx;
    let yExpr = cy;
    const dir = (num(kb.dir) || 0) % 4;
    if (dir === 0) xExpr = `(iw-ow)*${p}`;
    else if (dir === 1) yExpr = `(ih-oh)*${p}`;
    else if (dir === 2) xExpr = `(iw-ow)*(1-${p})`;
    else yExpr = `(ih-oh)*(1-${p})`;
    f.push(`crop=${ow}:${oh}:${xExpr}:${yExpr}`);
  }

  // ---- 几何：手持抖动（正弦位移）----
  const shake = opts.shake;
  if (shake && num(shake.amp) > 0) {
    const amp = clamp(num(shake.amp), 0.5, 12);
    const freq = clamp(num(shake.freq) || 8, 3, 16);
    const margin = Math.ceil(amp) + 2;
    const ow = `floor((iw-${margin * 2})/2)*2`;
    const oh = `floor((ih-${margin * 2})/2)*2`;
    const xExpr = `(iw-ow)/2+sin(t*${freq.toFixed(2)})*${amp.toFixed(2)}`;
    const yExpr = `(ih-oh)/2+cos(t*${(freq * 1.3).toFixed(2)})*${amp.toFixed(2)}`;
    f.push(`crop=${ow}:${oh}:${xExpr}:${yExpr}`);
  }

  if (opts.flip) f.push('hflip');

  const vEnabled = opts.vertical && opts.vertical.enabled;
  if (!vEnabled && (num(opts.width) || num(opts.height))) {
    const w = num(opts.width) ? Math.round(num(opts.width)) : -2;
    const h = num(opts.height) ? Math.round(num(opts.height)) : -2;
    f.push(`scale=${w}:${h}`);
  }

  const speed = num(opts.speed);
  if (speed && speed !== 1) {
    f.push(`setpts=${(1 / clamp(speed, 0.5, 2)).toFixed(4)}*PTS`);
  }

  // ---- 调色：eq ----
  const eq = [];
  const b = num(opts.brightness);
  const c = num(opts.contrast);
  const s = num(opts.saturation);
  const g = num(opts.gamma);
  if (b && b !== 0) eq.push(`brightness=${b.toFixed(3)}`);
  if (c && c !== 1) eq.push(`contrast=${c.toFixed(3)}`);
  if (s != null && !isNaN(s) && s !== 1) eq.push(`saturation=${s.toFixed(3)}`);
  if (g && g !== 1) eq.push(`gamma=${g.toFixed(3)}`);
  if (eq.length) f.push(`eq=${eq.join(':')}`);

  // ---- 调色：色温 ----
  const temp = num(opts.temperature);
  if (temp && Math.abs(temp - 6500) > 30) {
    f.push(`colortemperature=temperature=${Math.round(clamp(temp, 3000, 12000))}:mix=1`);
  }

  // ---- 调色：色调（绿-品红，中间调）----
  const tint = num(opts.tint);
  if (tint && Math.abs(tint) > 0.002) {
    f.push(`colorbalance=gm=${clamp(tint, -0.5, 0.5).toFixed(3)}`);
  }

  // ---- 调色：色相 ----
  const hue = num(opts.hue);
  if (hue && Math.abs(hue) > 0.05) {
    f.push(`hue=h=${clamp(hue, -30, 30).toFixed(2)}`);
  }

  // ---- 调色：曝光（master 曲线整体提亮/压暗中间调）----
  const exposure = num(opts.exposure);
  if (exposure && Math.abs(exposure) > 0.002) {
    const m = clamp(0.5 + exposure, 0.1, 0.9);
    f.push(`curves=m=0/0 0.5/${m.toFixed(3)} 1/1`);
  }

  // ---- 调色：阴影/高光 ----
  const sh = num(opts.shadowHL);
  if (sh && Math.abs(sh) > 0.002) {
    const lo = clamp(0.12 * sh, -0.3, 0.3);
    const p0 = clamp(lo, 0, 0.35).toFixed(3);
    const p1 = clamp(1 - lo, 0.65, 1).toFixed(3);
    f.push(`curves=all=0/${p0} 0.5/0.5 1/${p1}`);
  }

  // ---- 风格滤镜（curves 预设）----
  if (opts.curvePreset) {
    f.push(`curves=preset=${String(opts.curvePreset).replace(/[^a-z_]/g, '')}`);
  }

  // ---- 色散（RGB 通道轻微偏移）----
  const chroma = num(opts.chromashift);
  if (chroma && chroma > 0) {
    const c = Math.round(clamp(chroma, 1, 6));
    f.push(`rgbashift=rh=${c}:bh=${-c}`);
  }

  const sharpen = num(opts.sharpen);
  if (sharpen && sharpen > 0) f.push(`unsharp=5:5:${sharpen.toFixed(2)}:5:5:0`);

  const blur = num(opts.blur);
  if (blur && blur > 0) f.push(`gblur=sigma=${blur.toFixed(2)}`);

  // ---- 噪点（颗粒）----
  const grain = num(opts.grain);
  if (grain && grain > 0) {
    f.push(`noise=alls=${Math.round(clamp(grain, 1, 60))}:allf=t+u`);
  }

  // ---- 暗角 ----
  const vig = num(opts.vignette);
  if (vig && vig > 0.02) {
    f.push(`vignette=a=${clamp(vig, 0.05, 1.3).toFixed(3)}`);
  }

  return f;
}

/**
 * 内容叠加滤镜（作用在最终画布尺寸之上，追加到链尾）。
 * 边框描边 / 角标色块 / 进度条 / 文字水印。
 */
function buildOverlayFilters(opts) {
  const f = [];

  const border = opts.border;
  if (border && num(border.t) > 0) {
    const t = Math.round(clamp(num(border.t), 1, 60));
    const color = border.color || 'black';
    f.push(`drawbox=x=0:y=0:w=iw:h=ih:color=${color}:t=${t}`);
  }

  const badge = opts.cornerBadge;
  if (badge && num(badge.size) > 0) {
    const sz = Math.round(clamp(num(badge.size), 6, 400));
    const m = Math.round(num(badge.margin) || 16);
    const color = badge.color || 'white@0.6';
    const corner = badge.corner || 'tr';
    const x = /l/.test(corner) ? `${m}` : `iw-${sz}-${m}`;
    const y = /b/.test(corner) ? `ih-${sz}-${m}` : `${m}`;
    f.push(`drawbox=x=${x}:y=${y}:w=${sz}:h=${sz}:color=${color}:t=fill`);
  }

  const pb = opts.progressBar;
  if (pb && num(pb.h) > 0) {
    const dur = effectiveDuration(opts);
    if (dur > 0) {
      const h = Math.round(clamp(num(pb.h), 2, 120));
      const color = pb.color || 'white@0.85';
      // 用输出时间 t 驱动宽度，限制在 [0,dur]
      f.push(`drawbox=x=0:y=ih-${h}:w='iw*min(t\\,${dur.toFixed(3)})/${dur.toFixed(3)}':h=${h}:color=${color}:t=fill`);
    }
  }

  const tm = opts.textMark;
  if (tm && tm.text) {
    const text = String(tm.text).replace(/[\\:']/g, '');
    const fs = Math.round(clamp(num(tm.size) || 22, 8, 200));
    const color = tm.color || 'white@0.5';
    const x = tm.x != null ? tm.x : '20';
    const y = tm.y != null ? tm.y : '20';
    const font = (opts.fontFile || defaultFontFile());
    f.push(`drawtext=fontfile=${font}:text='${text}':fontcolor=${color}:fontsize=${fs}:x=${x}:y=${y}`);
  }

  return f;
}

function effectiveDuration(opts) {
  let d = num(opts.duration) > 0 ? num(opts.duration) : (num(opts.totalDuration) || 0) - (num(opts.startTime) || 0);
  const speed = num(opts.speed);
  if (speed && speed !== 1) d = d / clamp(speed, 0.5, 2);
  return d > 0 ? d : 0;
}

/**
 * 组装画面滤镜，处理竖屏画布。
 * 返回 { vf } 或 { filterComplex, map }
 */
function buildVisual(opts) {
  const content = buildContentFilters(opts);
  const overlays = buildOverlayFilters(opts);
  const V = opts.vertical;

  if (!V || !V.enabled) {
    const chain = content.concat(overlays);
    return chain.length ? { vf: chain.join(',') } : {};
  }

  const W = Math.round(num(V.width) || 1080);
  const H = Math.round(num(V.height) || 1920);
  const mode = V.mode || 'fill';

  if (mode === 'fit') {
    const chain = content.concat([
      `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`,
    ]).concat(overlays);
    return { vf: chain.join(',') };
  }

  if (mode === 'blur') {
    const pre = content.length ? content.join(',') + ',' : '';
    const sigma = num(V.bgBlur) || 22;
    let fc =
      `[0:v]${pre}split=2[a][b];` +
      `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=${sigma}[bg];` +
      `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2` + (overlays.length ? '[vb];' : '[v]');
    if (overlays.length) fc += `[vb]${overlays.join(',')}[v]`;
    return { filterComplex: fc, map: '[v]' };
  }

  // fill（默认）：放大后居中裁剪铺满
  const chain = content.concat([
    `scale=${W}:${H}:force_original_aspect_ratio=increase`,
    `crop=${W}:${H}`,
  ]).concat(overlays);
  return { vf: chain.join(',') };
}

function buildArgs(opts) {
  const args = [];

  const startTime = num(opts.startTime);
  if (startTime && startTime > 0) args.push('-ss', String(startTime));

  args.push('-i', opts.input);

  // 时长封顶：显式时长 / 尾部微剪（在原时长基础上裁掉尾部一小段，改变时长与帧序列）
  let cutDur = num(opts.duration);
  const tailTrim = num(opts.tailTrim);
  if (tailTrim && tailTrim > 0) {
    if (!(cutDur > 0)) {
      const base = (num(opts.totalDuration) || 0) - (num(opts.startTime) || 0);
      if (base > 0) cutDur = base;
    }
    if (cutDur > 0) cutDur = Math.max(0.5, +(cutDur - clamp(tailTrim, 0, cutDur - 0.5)).toFixed(3));
  }
  if (cutDur && cutDur > 0) args.push('-t', String(cutDur));

  const visual = buildVisual(opts);
  const hasVideoFilter = !!(visual.vf || visual.filterComplex);

  const speed = num(opts.speed);
  const af = [];
  if (!opts.muteAudio) {
    const vol = num(opts.volume);
    if (vol != null && !isNaN(vol) && vol !== 1) af.push(`volume=${clamp(vol, 0, 4).toFixed(3)}`);
    const pitch = num(opts.pitch);
    if (pitch && pitch !== 1) af.push(`rubberband=pitch=${clamp(pitch, 0.5, 2).toFixed(4)}`);
    const bassG = num(opts.bassGain);
    if (bassG && bassG !== 0) af.push(`bass=g=${clamp(bassG, -20, 20).toFixed(2)}`);
    const trebleG = num(opts.trebleGain);
    if (trebleG && trebleG !== 0) af.push(`treble=g=${clamp(trebleG, -20, 20).toFixed(2)}`);
    const echo = num(opts.echo);
    if (echo && echo > 0) af.push(`aecho=0.8:0.88:${Math.round(clamp(echo, 20, 120))}:0.3`);
    const stereoBal = num(opts.stereoBalance);
    if (stereoBal && Math.abs(stereoBal) > 0.001) af.push(`stereotools=balance_out=${clamp(stereoBal, -0.5, 0.5).toFixed(3)}`);
    if (speed && speed !== 1) af.push(`atempo=${clamp(speed, 0.5, 2).toFixed(4)}`);
    const afadeD = num(opts.afade);
    if (afadeD && afadeD > 0) {
      const dur = effectiveDuration(opts);
      if (dur > 0.6) {
        const d = clamp(afadeD, 0.05, Math.min(1, dur / 2));
        af.push(`afade=t=in:st=0:d=${d.toFixed(2)}`);
        af.push(`afade=t=out:st=${(dur - d).toFixed(2)}:d=${d.toFixed(2)}`);
      }
    }
  }

  let vcodec = opts.codec || 'libx264';
  if (vcodec === 'copy' && (hasVideoFilter || (speed && speed !== 1))) vcodec = 'libx264';

  // 画面滤镜与音视频流映射
  if (visual.filterComplex) {
    let fc = visual.filterComplex;
    const maps = ['-map', visual.map];
    if (opts.muteAudio) {
      // 无音频
    } else if (af.length) {
      fc += `;[0:a]${af.join(',')}[aout]`;
      maps.push('-map', '[aout]');
    } else {
      maps.push('-map', '0:a?');
    }
    args.push('-filter_complex', fc, ...maps);
  } else if (visual.vf) {
    args.push('-vf', visual.vf);
  }

  args.push('-c:v', vcodec);

  if (/x26[45]/.test(vcodec)) args.push('-pix_fmt', 'yuv420p');

  const fps = num(opts.fps);
  if (fps && fps > 0) args.push('-r', String(fps));

  if (opts.bitrate && String(opts.bitrate).trim()) {
    args.push('-b:v', String(opts.bitrate).trim());
  } else if (/x26[45]/.test(vcodec)) {
    args.push('-crf', String(opts.crf != null ? opts.crf : 23));
  }

  if (/x26[45]/.test(vcodec) && opts.preset) args.push('-preset', opts.preset);

  // ---- 编码指纹：参考帧 / 调优 ----
  const refs = num(opts.refs);
  if (refs && refs > 0 && /x26[45]/.test(vcodec)) args.push('-refs', String(Math.round(clamp(refs, 1, 8))));
  if (opts.tune && /x264/.test(vcodec)) args.push('-tune', String(opts.tune).replace(/[^a-z]/g, ''));

  // ---- 色彩范围标记 ----
  if (opts.colorRange === 'tv' || opts.colorRange === 'pc') {
    args.push('-color_range', opts.colorRange);
  }

  // ---- 编码与文件层 ----
  const gop = num(opts.gop);
  if (gop && gop > 0) args.push('-g', String(Math.round(gop)));

  const bframes = num(opts.bframes);
  if (bframes != null && !isNaN(bframes) && /x26[45]/.test(vcodec)) {
    args.push('-bf', String(Math.round(clamp(bframes, 0, 8))));
  }

  // Profile：仅 libx264 使用通用 profile 名；libx265 跳过以免无效值
  if (opts.profile && /x264/.test(vcodec)) {
    args.push('-profile:v', String(opts.profile));
  }

  // 色彩空间标记（仅写入元数据标签，不做转换）
  if (opts.colorTag) {
    if (opts.colorTag === 'bt601') {
      args.push('-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m');
    } else if (opts.colorTag === 'bt709') {
      args.push('-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709');
    }
  }

  if (opts.muteAudio) {
    args.push('-an');
  } else {
    if (!visual.filterComplex && af.length) args.push('-af', af.join(','));
    args.push('-c:a', 'aac');
    const ar = num(opts.sampleRate);
    if (ar && ar > 0) args.push('-ar', String(Math.round(ar)));
    const abK = num(opts.audioBitrateK);
    args.push('-b:a', `${abK && abK > 0 ? Math.round(clamp(abK, 64, 320)) : 192}k`);
  }

  // 元数据：清空原始元数据并写入自定义注释/标签（强去重信号）
  if (opts.clearMeta) {
    args.push('-map_metadata', '-1');
    if (opts.metaComment) args.push('-metadata', `comment=${opts.metaComment}`);
    if (opts.metaTags && typeof opts.metaTags === 'object') {
      for (const [k, val] of Object.entries(opts.metaTags)) {
        if (val != null && val !== '') args.push('-metadata', `${k}=${val}`);
      }
    }
  }

  const out = String(opts.output || '');
  if (/\.(mp4|mov|m4v)$/i.test(out)) args.push('-movflags', '+faststart');
  args.push('-y', out);
  return args;
}

function timeToSeconds(t) {
  if (!t) return 0;
  const parts = t.split(':').map(parseFloat);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function probe(input) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', input];
    const proc = spawn(ffprobePath, args);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `ffprobe exited ${code}`));
      try {
        const data = JSON.parse(out);
        const v = (data.streams || []).find((s) => s.codec_type === 'video') || {};
        const a = (data.streams || []).find((s) => s.codec_type === 'audio') || {};
        let fps = 0;
        if (v.r_frame_rate && v.r_frame_rate.includes('/')) {
          const [n, d] = v.r_frame_rate.split('/').map(Number);
          if (d) fps = n / d;
        }
        resolve({
          duration: parseFloat((data.format && data.format.duration) || v.duration || 0),
          size: parseInt((data.format && data.format.size) || 0, 10),
          width: v.width || 0,
          height: v.height || 0,
          vcodec: v.codec_name || '',
          acodec: a.codec_name || '',
          fps: fps ? Math.round(fps * 100) / 100 : 0,
          bitrate: parseInt((data.format && data.format.bit_rate) || 0, 10),
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

function run(opts, onProgress, onLog) {
  return new Promise((resolve, reject) => {
    if (opts && opts.output) {
      try { fs.mkdirSync(path.dirname(String(opts.output)), { recursive: true }); } catch (e) { /* noop */ }
    }
    const args = buildArgs(opts);
    if (onLog) onLog(`ffmpeg ${args.join(' ')}`);

    const proc = spawn(ffmpegPath, args);
    let stderr = '';

    let totalSeconds = opts.totalDuration || 0;
    if (opts.duration && Number(opts.duration) > 0) {
      totalSeconds = Number(opts.duration);
    } else if (opts.startTime && opts.totalDuration) {
      totalSeconds = opts.totalDuration - Number(opts.startTime);
    }
    const speed = num(opts.speed);
    if (speed && speed !== 1) totalSeconds = totalSeconds / clamp(speed, 0.5, 2);

    proc.stderr.on('data', (d) => {
      const line = d.toString();
      stderr += line;
      if (onLog) onLog(line.trim());
      const m = line.match(/time=(\d+:\d+:\d+\.\d+)/);
      if (m && totalSeconds > 0 && onProgress) {
        const cur = timeToSeconds(m[1]);
        const pct = Math.min(100, Math.round((cur / totalSeconds) * 100));
        onProgress(pct, m[1]);
      }
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        if (onProgress) onProgress(100, 'done');
        resolve({ ok: true, args });
      } else {
        reject(new Error(stderr.split('\n').slice(-12).join('\n') || `ffmpeg exited ${code}`));
      }
    });
    run._current = proc;
  });
}

function cancel() {
  if (run._current) {
    try { run._current.kill('SIGKILL'); } catch (e) { /* noop */ }
    run._current = null;
  }
}

// ---- 批量执行 ----
let batchCancelled = false;

async function runBatch(jobs, hooks) {
  batchCancelled = false;
  const results = [];
  for (let i = 0; i < jobs.length; i++) {
    if (batchCancelled) break;
    if (hooks.itemStart) hooks.itemStart(i, jobs[i]);
    try {
      await run(
        jobs[i],
        (pct, time) => hooks.progress && hooks.progress(i, pct, time),
        (line) => hooks.log && hooks.log(i, line)
      );
      results.push({ index: i, output: jobs[i].output, ok: true });
      if (hooks.itemDone) hooks.itemDone(i, { ok: true, output: jobs[i].output });
    } catch (e) {
      results.push({ index: i, output: jobs[i].output, ok: false, error: e.message });
      if (hooks.itemDone) hooks.itemDone(i, { ok: false, output: jobs[i].output, error: e.message });
    }
  }
  return { results, cancelled: batchCancelled, total: jobs.length };
}

function cancelBatch() {
  batchCancelled = true;
  cancel();
}

module.exports = {
  probe, run, cancel, runBatch, cancelBatch, buildArgs, buildContentFilters, ffmpegPath, ffprobePath,
};
