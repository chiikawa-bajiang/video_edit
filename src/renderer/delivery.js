'use strict';
/* 千川素材交付模块 —— 独立 IIFE，复用 window.api 与全局 toast/fmt* 工具 */
(function () {
  const q = (id) => document.getElementById(id);
  const RATIO_RES = {
    '9:16': { w: 1080, h: 1920 },
    '1:1': { w: 1080, h: 1080 },
    '16:9': { w: 1920, h: 1080 },
  };
  const ACTIONS = ['walk', 'turn', 'show', 'detail', 'ending', 'custom'];

  const dv = {
    ws: null,
    data: { project: null, assets: [], segments: [], templates: [], renderJobs: [], quality: [], delivery: [] },
    jobs: [],
    qc: [],
    cuts: [],
    batchId: null,
  };

  // 工具
  function djoin(dir, name) { const sep = dir.includes('\\') ? '\\' : '/'; return dir.replace(/[\\/]$/, '') + sep + name; }
  function dbase(p) { const s = p.replace(/\\/g, '/').split('/').pop(); const d = s.lastIndexOf('.'); return d > 0 ? s.slice(0, d) : s; }
  function dpad(n, len = 3) { return String(n).padStart(len, '0'); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function fmtDur(s) { if (!s) return '0:00'; const m = Math.floor(s / 60), x = Math.floor(s % 60); return `${m}:${String(x).padStart(2, '0')}`; }
  async function persist(key) { if (dv.ws) await window.api.dvWriteManifest(dv.ws, key, dv.data[key]); }
  function ensureWs() { if (!dv.ws) { toast('请先在「工作区」步骤选择目录', 'error'); return false; } return true; }

  /* ============ 随机化去重引擎 ============ */
  // 三档强度对应的抖动幅度（与批量生成模块口径一致）
  const DEDUP_INTENSITY = {
    subtle: {
      bri: 0.04, con: 0.04, sat: 0.06, gam: 0.04, sharp: 0.4, blur: 0.4, grain: 6, vignette: 0.25, denoise: 1.0,
      temp: 250, tint: 0.03, hue: 3, exposure: 0.04, shadowHL: 0.04, rotDeg: 0.6, pan: 0.04, zoom: 0.03, persp: 0.012,
      tailTrim: 0.3, crfJitter: 2, gopSet: [60, 90, 120], fpsSet: [0, 30],
    },
    normal: {
      bri: 0.08, con: 0.07, sat: 0.12, gam: 0.07, sharp: 0.8, blur: 0.7, grain: 12, vignette: 0.4, denoise: 2.0,
      temp: 500, tint: 0.05, hue: 6, exposure: 0.07, shadowHL: 0.08, rotDeg: 1.2, pan: 0.06, zoom: 0.05, persp: 0.03,
      tailTrim: 0.5, crfJitter: 3, gopSet: [48, 60, 90, 120, 250], fpsSet: [0, 30, 25],
    },
    strong: {
      bri: 0.13, con: 0.12, sat: 0.2, gam: 0.1, sharp: 1.4, blur: 1.0, grain: 20, vignette: 0.6, denoise: 3.5,
      temp: 900, tint: 0.09, hue: 10, exposure: 0.11, shadowHL: 0.13, rotDeg: 2.0, pan: 0.1, zoom: 0.08, persp: 0.05,
      tailTrim: 0.8, crfJitter: 4, gopSet: [48, 60, 90, 120, 250], fpsSet: [0, 30, 24, 60],
    },
  };
  function dvHash(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function dvRng(seed) { let a = seed >>> 0; return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  /* ============ 自由组合排列 ============ */
  // 在切片池内随机排列；可固定某片为开头、某片为结尾，其余自由排列
  function shuffleOrder(pool, firstLabel, lastLabel, seed) {
    const set = pool.slice();
    const first = firstLabel && set.includes(firstLabel) ? firstLabel : null;
    let last = lastLabel && set.includes(lastLabel) ? lastLabel : null;
    if (last && last === first) last = null; // 同一片不能既首又尾
    const middle = set.filter((l) => l !== first && l !== last);
    const rng = dvRng(seed);
    for (let k = middle.length - 1; k > 0; k--) {
      const j = Math.floor(rng() * (k + 1));
      const tmp = middle[k]; middle[k] = middle[j]; middle[j] = tmp;
    }
    return [].concat(first ? [first] : [], middle, last ? [last] : []);
  }

  /* ============ 切片间转场 ============ */
  // 各转场风格对应的 FFmpeg xfade transition 名称池
  const TRANSITION_POOL = {
    fade: ['fade'],
    slide: ['slideleft', 'slideright', 'slideup', 'slidedown'],
    zoom: ['zoomin'],
    wipe: ['wipeleft', 'wiperight', 'wipeup', 'wipedown', 'circleopen', 'circleclose'],
    dissolve: ['dissolve', 'pixelize', 'fadegrays'],
  };
  // 「随机」模式从该综合池中每个衔接处随机取一种
  const TRANSITION_RANDOM = ['fade', 'slideleft', 'slideright', 'slideup', 'slidedown', 'zoomin', 'wipeleft', 'wiperight', 'circleopen', 'circleclose', 'dissolve', 'pixelize'];
  function pickTransition(type, rng) {
    const pool = type === 'random' ? TRANSITION_RANDOM : (TRANSITION_POOL[type] || ['fade']);
    return pool[Math.floor(rng() * pool.length)];
  }

  // 读取去重配置（未启用返回 null）
  function readDedupConfig() {
    if (!q('dvDedupOn').checked) return null;
    const intensity = q('dvDedupIntensity').value;
    const dims = {};
    q('dvDedupDims').querySelectorAll('input[type=checkbox]:checked').forEach((c) => { dims[c.value] = true; });
    return { R: DEDUP_INTENSITY[intensity] || DEDUP_INTENSITY.normal, dims };
  }

  // 为单条素材生成一组随机去重参数（字段与主进程 buildContentFilters 对齐）
  function makeDedup(seed, R, dims) {
    const rng = dvRng(seed);
    const U = (min, max, d = 3) => { const v = min + (max - min) * rng(); const p = Math.pow(10, d); return Math.round(v * p) / p; };
    const choose = (arr) => arr[Math.floor(rng() * arr.length)];
    const d = { seed };
    if (dims.color) {
      d.brightness = U(-R.bri, R.bri); d.contrast = U(1 - R.con, 1 + R.con);
      d.saturation = U(1 - R.sat, 1 + R.sat); d.gamma = U(1 - R.gam, 1 + R.gam);
      d.temperature = U(6500 - R.temp, 6500 + R.temp, 0); d.tint = U(-R.tint, R.tint);
      d.hue = U(-R.hue, R.hue, 2); d.exposure = U(-R.exposure, R.exposure); d.shadowHL = U(-R.shadowHL, R.shadowHL);
    }
    if (dims.style) {
      // 锐化与模糊互斥，避免相互抵消
      if (rng() < 0.5) d.sharpen = U(0, R.sharp, 2); else d.blur = U(0, R.blur, 2);
      d.grain = U(0, R.grain, 0); d.vignette = U(0, R.vignette); d.denoise = U(0, R.denoise, 2);
    }
    if (dims.geometry) {
      d.rotate = U(-R.rotDeg, R.rotDeg, 2); d.panX = U(-R.pan, R.pan); d.panY = U(-R.pan, R.pan);
      d.zoom = U(0, R.zoom); d.perspective = U(-R.persp, R.persp, 4);
    }
    if (dims.flip) d.flip = rng() < 0.5;
    if (dims.enc) {
      const e = { crf: 23 + U(-R.crfJitter, R.crfJitter, 0), gop: choose(R.gopSet), profile: choose(['high', 'main']), bframes: choose([1, 2, 3]) };
      const f = choose(R.fpsSet); if (f) e.fps = f;
      d.enc = e;
    }
    if (dims.trim) d.tailTrim = U(0.1, R.tailTrim, 2);
    if (dims.meta) d.comment = 'yd' + (seed >>> 0).toString(36);
    return d;
  }

  /* ---- 步骤导航 ---- */
  document.querySelectorAll('#stepNav .step').forEach((btn) => {
    btn.addEventListener('click', () => goStep(btn.dataset.step));
  });
  function goStep(n) {
    document.querySelectorAll('#stepNav .step').forEach((s) => s.classList.toggle('active', s.dataset.step === String(n)));
    for (let i = 1; i <= 5; i++) q('step-' + i).hidden = i !== Number(n);
    if (n === '2') loadPlayer();
    if (n === '3') renderTemplates();
    if (n === '4') {
      renderPlanTemplates();
      renderJobList();
      q('dvRender').disabled = dv.jobs.length === 0;
    }
    if (n === '5') {
      q('dvQuality').disabled = !dv.jobs.some((j) => j.status === 'success');
      q('dvExport').disabled = !(dv.qc && dv.qc.some((r) => r.passed));
    }
    refreshStepHints(n);
  }

  // 当某步前置条件未满足时，给出提示
  function refreshStepHints(n) {
    if (n === '5') {
      if (!dv.jobs.some((j) => j.status === 'success')) {
        q('dvQualitySummary').textContent = '请先在「4 生产·渲染」生成成片后再质检';
      }
      if (!(dv.qc && dv.qc.some((r) => r.passed)) && q('dvExportStats').hidden) {
        q('dvExport').title = '请先在上方「质检」通过至少 1 条';
      }
    }
  }
  function markDone(n) {
    const s = document.querySelector(`#stepNav .step[data-step="${n}"]`);
    if (s) s.classList.add('done');
  }

  /* ============ 步骤1 工作区 ============ */
  q('dvChooseWs').addEventListener('click', async () => {
    const dir = await window.api.openDir();
    if (!dir) return;
    dv.ws = dir;
    q('dvWsPath').textContent = dir;
    const loaded = await window.api.dvInit(dir);
    dv.data.project = loaded.project || { workspace: dir, batchSeq: 0 };
    dv.data.assets = loaded.assets || [];
    dv.data.segments = loaded.segments || [];
    dv.data.templates = loaded.templates || [];
    dv.data.renderJobs = loaded.renderJobs || [];
    dv.data.quality = loaded.quality || [];
    dv.data.delivery = loaded.delivery || [];
    dv.jobs = dv.data.renderJobs.slice();
    dv.qc = dv.data.quality.slice();
    dv.cuts = [];
    renderAssets();
    updateWsStats();
    markDone(1);
    toast('工作区已就绪', 'success');
  });

  function updateWsStats() {
    const el = q('dvWsStats');
    el.hidden = false;
    el.innerHTML = [
      ['原片', dv.data.assets.length],
      ['切片', dv.data.segments.length],
      ['模板', dv.data.templates.length],
      ['任务', dv.data.renderJobs.length],
    ].map(([k, v]) => `<div class="ws-stat"><label>${k}</label><span>${v}</span></div>`).join('');
  }

  /* ============ 步骤2 导入原片 ============ */
  q('dvImport').addEventListener('click', async () => {
    if (!ensureWs()) return;
    const assets = await window.api.dvOpenVideos();
    if (!assets.length) return;
    assets.forEach((a) => { if (!a.error) dv.data.assets.push(a); });
    await persist('assets');
    renderAssets();
    updateWsStats();
    markDone(1);
    const failed = assets.filter((a) => a.error).length;
    toast(`导入 ${assets.length - failed} 条` + (failed ? `，${failed} 条失败` : ''), failed ? 'error' : 'success');
  });

  function renderAssets() {
    const list = q('dvAssetList');
    q('dvAssetCount').textContent = `已导入 ${dv.data.assets.length} 条`;
    if (!dv.data.assets.length) { list.innerHTML = '<div class="result-empty">尚未导入原片</div>'; return; }
    list.innerHTML = dv.data.assets.map((a) =>
      `<div class="result-item ok"><span class="ri-status">🎞️</span>` +
      `<span class="ri-name">${a.fileName}</span>` +
      `<span class="ri-info">${fmtDur(a.duration)} · ${a.width}×${a.height}${a.hasAudio ? ' · 有声' : ' · 无声'}</span></div>`
    ).join('');
  }

  /* ============ 步骤2 切片（播放器手动切分） ============ */
  let cutIn = null, cutOut = null;
  let cutTotal = 0, cutDoneCount = 0;
  const player = q('dvPlayer');

  function toFileUrl(p) { return 'file:///' + encodeURI(p.replace(/\\/g, '/')); }
  function fmtT(s) { if (s == null || isNaN(s)) return '--'; const m = Math.floor(s / 60); const sec = s % 60; return `${m}:${sec.toFixed(2).padStart(5, '0')}`; }

  function loadPlayer() {
    const asset = dv.data.assets[0];
    if (!asset) { q('dvCutSource').textContent = '请先在「准备」步骤导入原片'; player.removeAttribute('src'); try { player.load(); } catch (e) { /* noop */ } dv.cuts = []; renderCutList(); return; }
    q('dvCutSource').textContent = asset.fileName + (asset.duration ? ` · ${asset.duration.toFixed(1)}s` : '');
    const url = toFileUrl(asset.sourcePath);
    if (player.dataset.src !== url) { player.src = url; player.dataset.src = url; }
    if (!dv.cuts.length && dv.data.segments.length) {
      dv.cuts = dv.data.segments.map((s) => ({ label: s.label || '切片', start: s.startTime, end: s.endTime, done: true, outputPath: s.outputPath, hasAudio: s.hasAudio }));
      relabelCuts();
    }
    renderCutList();
  }

  q('dvSetIn').addEventListener('click', () => { cutIn = player.currentTime; q('dvInVal').textContent = fmtT(cutIn); });
  q('dvSetOut').addEventListener('click', () => { cutOut = player.currentTime; q('dvOutVal').textContent = fmtT(cutOut); });
  q('dvAddSeg').addEventListener('click', () => {
    if (cutIn == null || cutOut == null) return toast('请先设入点和出点', 'error');
    let a = cutIn, b = cutOut; if (b < a) { const t = a; a = b; b = t; }
    if (b - a < 0.2) return toast('这段太短了（<0.2s）', 'error');
    dv.cuts.push({ label: '切片' + (dv.cuts.length + 1), start: +a.toFixed(3), end: +b.toFixed(3), done: false });
    relabelCuts();
    cutIn = cutOut = null; q('dvInVal').textContent = '--'; q('dvOutVal').textContent = '--';
    renderCutList();
    toast('已加入：切片' + dv.cuts.length, 'success');
  });

  function relabelCuts() { dv.cuts.forEach((c, i) => { c.label = '切片' + (i + 1); }); }

  function renderCutList() {
    const list = q('dvSegList');
    q('dvDoSlice').disabled = !dv.cuts.some((c) => !c.done);
    if (!dv.cuts.length) { list.innerHTML = '<div class="result-empty">尚无切片，先在上方切几段</div>'; return; }
    list.innerHTML = dv.cuts.map((c, i) =>
      `<div class="result-item seg-item ${c.done ? 'ok' : 'pending'}" id="cut-${i}">` +
      `<span class="ri-status">${c.done ? '✔' : '✂'}</span>` +
      `<span class="ri-name">${c.label}</span>` +
      `<span class="ri-info">${fmtT(c.start)} → ${fmtT(c.end)}（${(c.end - c.start).toFixed(2)}s）${c.done ? '' : ' · 待生成'}</span>` +
      `<button class="seg-del" data-i="${i}" title="删除">✕</button></div>`
    ).join('');
    list.querySelectorAll('.seg-del').forEach((b) => b.addEventListener('click', () => {
      dv.cuts.splice(Number(b.dataset.i), 1); relabelCuts(); renderCutList();
    }));
  }

  q('dvDoSlice').addEventListener('click', async () => {
    if (!ensureWs()) return;
    const asset = dv.data.assets[0];
    if (!asset) return toast('请先导入原片', 'error');
    if (!dv.cuts.length) return toast('请先切几段', 'error');

    const cutItems = dv.cuts.map((c, i) => ({
      input: asset.sourcePath, start: c.start, end: c.end,
      output: djoin(djoin(dv.ws, '切片'), `${dbase(asset.fileName)}_${dpad(i + 1, 2)}.mp4`),
    }));
    cutTotal = cutItems.length; cutDoneCount = 0;
    q('dvCutWrap').hidden = false; q('dvCutFill').style.width = '0%'; q('dvCutText').textContent = `0 / ${cutTotal}`;
    renderCutList();

    const res = await window.api.dvCutSegments(cutItems);
    const segs = [];
    res.results.forEach((r, i) => {
      if (r.ok) {
        const c = dv.cuts[i];
        c.done = true; c.outputPath = cutItems[i].output; c.hasAudio = !!asset.hasAudio;
        segs.push({
          id: 'S' + Math.random().toString(36).slice(2, 9),
          assetId: asset.id, label: c.label, startTime: c.start, endTime: c.end,
          duration: +(c.end - c.start).toFixed(3), outputPath: cutItems[i].output, hasAudio: !!asset.hasAudio,
        });
      }
    });
    dv.data.segments = segs;
    await persist('segments');
    renderCutList(); updateWsStats(); markDone(2);
    toast(`切片完成：成功 ${segs.length} / ${cutTotal}`, segs.length === cutTotal ? 'success' : 'error');
  });

  window.api.onDvCutStart(({ index }) => { const el = q('cut-' + index); if (el) { el.className = 'result-item seg-item running'; el.querySelector('.ri-status').textContent = '▶'; } });
  window.api.onDvCutDone(({ index, ok, error }) => {
    const el = q('cut-' + index);
    if (el) { el.className = 'result-item seg-item ' + (ok ? 'ok' : 'fail'); el.querySelector('.ri-status').textContent = ok ? '✔' : '✘'; if (!ok) el.querySelector('.ri-info').textContent = (error || '').split('\n').pop().slice(0, 30); }
    cutDoneCount++;
    q('dvCutFill').style.width = Math.round((cutDoneCount / cutTotal) * 100) + '%';
    q('dvCutText').textContent = `${cutDoneCount} / ${cutTotal}`;
  });

  /* ============ 步骤4 模板 ============ */
  function nextTplId() {
    let n = 1;
    const ids = new Set(dv.data.templates.map((t) => t.id));
    while (ids.has('TPL' + dpad(n, 2))) n++;
    return 'TPL' + dpad(n, 2);
  }

  function renderTemplates() {
    const list = q('dvTemplateList');
    if (!dv.data.templates.length) { list.innerHTML = '<div class="result-empty">暂无模板，点「+ 新增模板」或导入</div>'; return; }
    const segLabels = dv.data.segments.map((s) => s.label);

    function orderHtml(t) {
      const sel = (t.segmentOrder || []).filter((l) => segLabels.includes(l));
      const avail = segLabels.filter((l) => !sel.includes(l));
      const rows = sel.length
        ? sel.map((l, k) => `<div class="tpl-order-row" data-label="${l}">
            <span class="ord-label">${k + 1}. ${l}</span>
            <button class="ord-btn" data-op="up">↑</button>
            <button class="ord-btn" data-op="down">↓</button>
            <button class="ord-btn" data-op="rm">✕</button></div>`).join('')
        : `<div class="result-empty" style="padding:8px;">${segLabels.length ? '未选择切片，点下方按钮添加' : '请先在「切片」步骤切分出切片'}</div>`;
      const add = avail.length ? '<span style="color:var(--text-dim,#8b94a3);">添加：</span>' + avail.map((l) => `<button class="btn btn-sm" data-add-label="${l}">+ ${l}</button>`).join('') : '';
      const orderTitle = t.combineMode === 'shuffle'
        ? '参与组合的切片（顺序随机，可在上方固定首/尾）'
        : '切片顺序（成片将按此顺序拼接）';
      return `<div class="field wide"><label>${orderTitle}</label>
        <div class="tpl-order" data-order>${rows}</div>
        <div class="tpl-add-seg" data-add>${add}</div></div>`;
    }

    list.innerHTML = dv.data.templates.map((t, i) => `
      <div class="tpl-card" data-idx="${i}">
        <div class="tpl-title" style="display:flex;justify-content:space-between;align-items:center;">
          <span>${t.id} · ${t.name}</span>
          <span style="display:flex;gap:6px;">
            <button class="btn btn-sm" data-act="dup">复制</button>
            <button class="btn btn-sm" data-act="del">删除</button>
          </span>
        </div>
        <div class="tpl-row">
          <div class="field"><label>名称</label><input type="text" data-f="name" value="${t.name}" /></div>
          <div class="field"><label>比例</label>
            <select data-f="aspectRatio">
              ${['9:16', '1:1', '16:9'].map((r) => `<option value="${r}" ${t.aspectRatio === r ? 'selected' : ''}>${r}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>目标时长(秒，0=不限)</label><input type="number" data-f="durationTarget" value="${t.durationTarget || 0}" min="0" /></div>
          <div class="field"><label>变速选项(逗号)</label><input type="text" data-f="speedOptions" value="${(t.speedOptions || [1]).join(',')}" /></div>
        </div>
        <div class="tpl-row" style="margin-top:10px;">
          <div class="field"><label>组合方式</label>
            <select data-f="combineMode">
              <option value="fixed" ${t.combineMode === 'shuffle' ? '' : 'selected'}>固定顺序</option>
              <option value="shuffle" ${t.combineMode === 'shuffle' ? 'selected' : ''}>自由组合(随机排列)</option>
            </select>
          </div>
          ${t.combineMode === 'shuffle' ? `
          <div class="field"><label>固定开头</label>
            <select data-f="firstLabel">
              <option value="">不固定</option>
              ${segLabels.map((l) => `<option value="${l}" ${t.firstLabel === l ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>固定结尾</label>
            <select data-f="lastLabel">
              <option value="">不固定</option>
              ${segLabels.map((l) => `<option value="${l}" ${t.lastLabel === l ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>` : ''}
        </div>
        <div class="tpl-row" style="margin-top:10px;">
          <div class="field"><label>切片间转场</label>
            <select data-f="transitionType">
              ${[['none', '无（硬切）'], ['fade', '淡入淡出'], ['slide', '滑动'], ['zoom', '缩放'], ['wipe', '擦除'], ['dissolve', '溶解'], ['random', '每条随机']].map(([v, txt]) => `<option value="${v}" ${(t.transitionType || 'none') === v ? 'selected' : ''}>${txt}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>转场时长(秒)</label><input type="number" data-f="transitionDur" value="${t.transitionDur != null ? t.transitionDur : 0.3}" min="0.1" max="1" step="0.1" /></div>
        </div>
        <div class="tpl-row" style="margin-top:10px;">
          ${orderHtml(t)}
        </div>
      </div>`).join('');

    list.querySelectorAll('.tpl-card').forEach((card) => {
      const idx = Number(card.dataset.idx);
      card.querySelectorAll('[data-f]').forEach((inp) => {
        inp.addEventListener('change', async () => {
          const f = inp.dataset.f;
          const t = dv.data.templates[idx];
          if (f === 'speedOptions') t[f] = inp.value.split(',').map((s) => parseFloat(s)).filter((x) => !isNaN(x));
          else if (f === 'durationTarget' || f === 'transitionDur') t[f] = parseFloat(inp.value) || 0;
          else t[f] = inp.value;
          await persist('templates');
          if (f === 'combineMode') renderTemplates();
        });
      });
      // 切片顺序：↑ ↓ ✕
      card.querySelectorAll('[data-order] .ord-btn').forEach((btn) => btn.addEventListener('click', async () => {
        const t = dv.data.templates[idx];
        const label = btn.closest('.tpl-order-row').dataset.label;
        let arr = (t.segmentOrder || []).filter((l) => segLabels.includes(l));
        const pos = arr.indexOf(label);
        const op = btn.dataset.op;
        if (op === 'up' && pos > 0) { [arr[pos - 1], arr[pos]] = [arr[pos], arr[pos - 1]]; }
        else if (op === 'down' && pos < arr.length - 1) { [arr[pos + 1], arr[pos]] = [arr[pos], arr[pos + 1]]; }
        else if (op === 'rm') { arr.splice(pos, 1); }
        t.segmentOrder = arr; await persist('templates'); renderTemplates();
      }));
      // 切片顺序：添加
      card.querySelectorAll('[data-add-label]').forEach((btn) => btn.addEventListener('click', async () => {
        const t = dv.data.templates[idx];
        let arr = (t.segmentOrder || []).filter((l) => segLabels.includes(l));
        if (!arr.includes(btn.dataset.addLabel)) arr.push(btn.dataset.addLabel);
        t.segmentOrder = arr; await persist('templates'); renderTemplates();
      }));
      // 复制 / 删除
      card.querySelector('[data-act="dup"]').addEventListener('click', async () => {
        const src = dv.data.templates[idx];
        const copy = JSON.parse(JSON.stringify(src));
        copy.id = nextTplId();
        copy.name = src.name + ' 副本';
        dv.data.templates.splice(idx + 1, 0, copy);
        await persist('templates');
        renderTemplates();
        toast('已复制模板 ' + copy.id, 'success');
      });
      card.querySelector('[data-act="del"]').addEventListener('click', async () => {
        if (dv.data.templates.length <= 1) return toast('至少保留一个模板', 'error');
        dv.data.templates.splice(idx, 1);
        await persist('templates');
        renderTemplates();
        updateWsStats();
        toast('已删除模板', 'success');
      });
    });
  }

  // 模板工具栏：新增 / 导入 / 导出
  q('dvTplAdd').addEventListener('click', async () => {
    if (!ensureWs()) return;
    dv.data.templates.push({
      id: nextTplId(), name: '新模板', aspectRatio: '9:16', durationTarget: 0,
      segmentOrder: dv.data.segments.map((s) => s.label), speedOptions: [1],
      combineMode: 'fixed', firstLabel: '', lastLabel: '',
      transitionType: 'none', transitionDur: 0.3,
    });
    await persist('templates');
    renderTemplates();
    updateWsStats();
    toast('已新增模板', 'success');
  });
  q('dvTplExport').addEventListener('click', async () => {
    const p = await window.api.dvExportTemplates(dv.data.templates);
    if (p) toast('模板已导出：' + p, 'success');
  });
  q('dvTplImport').addEventListener('click', async () => {
    if (!ensureWs()) return;
    const data = await window.api.dvImportTemplates();
    if (!data) return;
    if (data.error) return toast('导入失败：' + data.error, 'error');
    let added = 0;
    data.forEach((t) => {
      if (!t || !t.aspectRatio) return;
      const tpl = {
        id: nextTplId(), name: t.name || '导入模板',
        aspectRatio: t.aspectRatio, durationTarget: t.durationTarget || 0,
        segmentOrder: Array.isArray(t.segmentOrder) ? t.segmentOrder : dv.data.segments.map((s) => s.label),
        speedOptions: Array.isArray(t.speedOptions) ? t.speedOptions : [1],
        combineMode: t.combineMode === 'shuffle' ? 'shuffle' : 'fixed',
        firstLabel: t.firstLabel || '', lastLabel: t.lastLabel || '',
        transitionType: t.transitionType || 'none', transitionDur: t.transitionDur != null ? t.transitionDur : 0.3,
      };
      dv.data.templates.push(tpl); added++;
    });
    await persist('templates');
    renderTemplates();
    updateWsStats();
    toast(`已导入 ${added} 个模板`, 'success');
  });

  /* ============ 步骤5 生产计划 ============ */
  function renderPlanTemplates() {
    q('dvPlanTemplates').innerHTML = dv.data.templates.map((t, i) =>
      `<label><input type="checkbox" value="${i}" ${i === 0 ? 'checked' : ''} /> ${t.id} ${t.name}</label>`
    ).join('');
  }

  q('dvDedupOn').addEventListener('change', () => {
    q('dvDedupBody').style.display = q('dvDedupOn').checked ? '' : 'none';
  });

  q('dvGenPlan').addEventListener('click', async () => {
    if (!ensureWs()) return;
    if (!dv.data.segments.length) return toast('请先生成切片', 'error');
    const sel = Array.from(q('dvPlanTemplates').querySelectorAll('input:checked')).map((c) => dv.data.templates[Number(c.value)]);
    if (!sel.length) return toast('请至少选择一个模板', 'error');
    const count = Math.max(1, Math.min(2000, parseInt(q('dvPlanCount').value, 10) || 1));

    dv.data.project.batchSeq = (dv.data.project.batchSeq || 0) + 1;
    const batchId = 'batch' + dpad(dv.data.project.batchSeq);
    dv.batchId = batchId;
    await persist('project');

    // 按 label 建索引：模板按切片标签精确排序
    const segByLabel = {};
    dv.data.segments.forEach((s) => { segByLabel[s.label] = s; });

    const dedupCfg = readDedupConfig();
    const jobs = [];
    let skipped = 0;
    for (let i = 0; i < count; i++) {
      const t = sel[i % sel.length];
      const tplNo = dpad(dv.data.templates.indexOf(t) + 1, 2);
      const res = RATIO_RES[t.aspectRatio] || RATIO_RES['9:16'];
      const poolLabels = (t.segmentOrder || []).filter((l) => segByLabel[l]);
      // 自由组合：每条素材独立随机排列（可固定首/尾）；固定顺序：沿用模板顺序
      const order = t.combineMode === 'shuffle'
        ? shuffleOrder(poolLabels, t.firstLabel, t.lastLabel, dvHash(batchId + '_' + t.id + '_' + (i + 1)))
        : poolLabels;
      const chosen = order.map((l) => segByLabel[l]);
      if (!chosen.length) { skipped++; continue; }
      const speed = (t.speedOptions && t.speedOptions.length) ? pick(t.speedOptions) : 1;
      const fileName = `${batchId.toUpperCase()}_TPL${tplNo}_V${dpad(i + 1)}.mp4`;

      // 切片间转场：为各衔接处解析转场名称（random 时每处随机），并钳制时长
      const durations = chosen.map((c) => c.duration || 0);
      let transition = null;
      if (t.transitionType && t.transitionType !== 'none' && chosen.length >= 2 && durations.every((d) => d > 0)) {
        const minDur = Math.min.apply(null, durations);
        const reqD = t.transitionDur > 0 ? t.transitionDur : 0.3;
        const D = Math.max(0.05, Math.min(reqD, minDur * 0.5));
        const trng = dvRng(dvHash(batchId + '_' + t.id + '_' + (i + 1) + '_tr'));
        const names = [];
        for (let b = 0; b < chosen.length - 1; b++) names.push(pickTransition(t.transitionType, trng));
        transition = { type: t.transitionType, dur: +D.toFixed(3), names };
      }

      // 转场重叠会缩短总时长：每个衔接处减少 D 秒
      const totalDur = durations.reduce((s, d) => s + d, 0);
      const xfadeReduce = transition ? transition.dur * (chosen.length - 1) : 0;
      const rawDuration = Math.max(0.1, totalDur - xfadeReduce) / (speed || 1);
      const trimTo = t.durationTarget && t.durationTarget > 0 ? Math.min(t.durationTarget, rawDuration) : 0;
      const estDuration = trimTo > 0 ? trimTo : rawDuration;
      const outPath = djoin(djoin(dv.ws, '成片'), fileName);
      jobs.push({
        id: 'J' + Math.random().toString(36).slice(2, 9),
        batchId, templateId: t.id, aspectRatio: t.aspectRatio,
        segmentIds: chosen.map((c) => c.id), segmentLabels: order, sourceAssetIds: [...new Set(chosen.map((c) => c.assetId))],
        inputs: chosen.map((c) => ({ path: c.outputPath, hasAudio: c.hasAudio, duration: c.duration || 0 })),
        width: res.w, height: res.h, fps: 30, speed,
        outputFileName: fileName, outputPath: outPath, output: outPath,
        estDuration, trimTo, transition,
        dedup: dedupCfg ? makeDedup(dvHash(batchId + '_' + (i + 1)), dedupCfg.R, dedupCfg.dims) : null,
        status: 'pending',
      });
    }
    if (skipped) toast(`有 ${skipped} 个任务因模板未选切片被跳过`, 'error');
    dv.jobs = jobs;
    dv.data.renderJobs = jobs;
    await persist('renderJobs');
    q('dvPlanSummary').textContent = `已生成 ${jobs.length} 个渲染任务（批次 ${batchId}）` + (dedupCfg ? ' · 🎲 已启用随机去重' : '');
    q('dvRender').disabled = jobs.length === 0;
    renderJobList();
    updateWsStats();
    markDone(4);
    toast(`生成 ${jobs.length} 个任务`, 'success');
  });

  /* ============ 步骤6 渲染 ============ */
  function renderJobList() {
    const list = q('dvJobList');
    if (!dv.jobs.length) { list.innerHTML = '<div class="result-empty">尚无渲染任务</div>'; return; }
    list.innerHTML = dv.jobs.map((j, i) => {
      const cls = j.status === 'success' ? 'ok' : j.status === 'failed' ? 'fail' : 'pending';
      const icon = j.status === 'success' ? '✔' : j.status === 'failed' ? '✘' : '⏳';
      const ord = (j.segmentLabels || []).join('→');
      return `<div class="result-item ${cls}" id="job-${i}"><span class="ri-status">${icon}</span>` +
        `<span class="ri-name">${j.outputFileName}</span>` +
        `<span class="ri-info">${j.aspectRatio}${ord ? ' · ' + ord : ' · ' + j.inputs.length + '段'}${j.speed !== 1 ? ' · ' + j.speed + 'x' : ''}${j.trimTo ? ' · ✂' + j.trimTo + 's' : ''}${j.transition ? ' · ⇄' + (j.transition.type === 'random' ? '随机' : j.transition.type) : ''}${j.dedup ? ' · 🎲' : ''}</span></div>`;
    }).join('');
  }

  /* 音频设置 */
  const dvAudio = { mode: 'original', musicPath: null, musicVolume: 1, originalVolume: 1 };
  function syncAudioUI() {
    const mode = q('dvAudioMode').value;
    dvAudio.mode = mode;
    const showMusic = (mode === 'music' || mode === 'mix');
    q('dvMusicRow').style.display = showMusic ? '' : 'none';
    q('dvVolRow').style.display = showMusic ? 'flex' : 'none';
    q('dvOrigVolWrap').style.display = (mode === 'mix') ? '' : 'none';
  }
  q('dvAudioMode').addEventListener('change', syncAudioUI);
  q('dvChooseMusic').addEventListener('click', async () => {
    const p = await window.api.dvOpenMusic();
    if (!p) return;
    dvAudio.musicPath = p;
    const name = p.replace(/\\/g, '/').split('/').pop();
    q('dvMusicName').textContent = name;
    q('dvMusicName').classList.add('ok');
  });
  q('dvMusicVol').addEventListener('input', () => { dvAudio.musicVolume = parseFloat(q('dvMusicVol').value); q('dvMusicVolVal').textContent = dvAudio.musicVolume.toFixed(2); });
  q('dvOrigVol').addEventListener('input', () => { dvAudio.originalVolume = parseFloat(q('dvOrigVol').value); q('dvOrigVolVal').textContent = dvAudio.originalVolume.toFixed(2); });

  let rendering = false;
  let idxMap = [];            // 子集位置 -> dv.jobs 真实下标
  let renderTotal = 0, renderDone = 0;
  const renderErrors = {};

  async function doRender(subset) {
    if (rendering) return;
    if (!subset.length) return toast('没有可渲染的任务', 'error');
    if ((dvAudio.mode === 'music' || dvAudio.mode === 'mix') && !dvAudio.musicPath) return toast('请先选择配乐文件', 'error');

    subset.forEach((j) => {
      j.audio = { mode: dvAudio.mode, musicPath: dvAudio.musicPath, musicVolume: dvAudio.musicVolume, originalVolume: dvAudio.originalVolume };
      j.status = 'pending';
    });
    idxMap = subset.map((j) => dv.jobs.indexOf(j));
    renderTotal = subset.length; renderDone = 0;

    rendering = true;
    q('dvRender').disabled = true; q('dvRender').textContent = '渲染中…';
    q('dvPause').hidden = false; q('dvResume').hidden = true;
    q('dvRenderCancel').hidden = false; q('dvRetryFailed').hidden = true;
    q('dvRenderWrap').hidden = false;
    q('dvRenderFill').style.width = '0%';
    q('dvRenderText').textContent = `0 / ${renderTotal}`;
    q('dvRenderSummary').textContent = `共 ${renderTotal} 条`;
    q('dvRenderErr').hidden = true;
    renderJobList();
    // 重置子集行状态
    idxMap.forEach((real) => { const el = q('job-' + real); if (el) { el.className = 'result-item pending'; el.querySelector('.ri-status').textContent = '⏳'; el.querySelector('.ri-info').textContent = '等待中'; } });

    const concurrency = parseInt(q('dvConcurrency').value, 10) || 1;
    try {
      const res = await window.api.dvRenderJobs(subset, { concurrency });
      res.results.forEach((r) => { const real = idxMap[r.index]; if (real >= 0) { dv.jobs[real].status = r.ok ? 'success' : 'failed'; if (!r.ok) dv.jobs[real].error = r.error; } });
      dv.data.renderJobs = dv.jobs;
      await persist('renderJobs');
      const ok = dv.jobs.filter((j) => j.status === 'success').length;
      const failed = dv.jobs.filter((j) => j.status === 'failed').length;
      q('dvQuality').disabled = ok === 0;
      q('dvRetryFailed').hidden = failed === 0;
      markDone(4);
      toast(res.cancelled ? `已停止` : `渲染完成：成功 ${ok}，失败 ${failed}`, failed ? 'error' : 'success');
    } catch (e) {
      toast('渲染出错：' + e.message, 'error');
    } finally {
      rendering = false;
      q('dvRender').disabled = false; q('dvRender').textContent = '开始渲染';
      q('dvPause').hidden = true; q('dvResume').hidden = true;
      q('dvRenderCancel').hidden = true; q('dvRenderItemWrap').hidden = true;
    }
  }

  q('dvRender').addEventListener('click', () => doRender(dv.jobs));
  q('dvRetryFailed').addEventListener('click', () => doRender(dv.jobs.filter((j) => j.status === 'failed')));
  q('dvRenderCancel').addEventListener('click', () => window.api.dvCancel());
  q('dvPause').addEventListener('click', async () => { await window.api.dvPause(); q('dvPause').hidden = true; q('dvResume').hidden = false; toast('已暂停（进行中的会继续到完成）', 'error'); });
  q('dvResume').addEventListener('click', async () => { await window.api.dvResume(); q('dvResume').hidden = true; q('dvPause').hidden = false; toast('已继续', 'success'); });

  window.api.onDvRenderStart(({ index }) => {
    const real = idxMap[index];
    const el = q('job-' + real);
    if (el) { el.className = 'result-item running'; el.querySelector('.ri-status').textContent = '▶'; el.querySelector('.ri-info').textContent = '0%'; }
    q('dvRenderItemWrap').hidden = false; q('dvRenderItemFill').style.width = '0%'; q('dvRenderItemText').textContent = '0%';
  });
  window.api.onDvRenderProgress(({ index, pct }) => {
    const real = idxMap[index];
    const el = q('job-' + real);
    if (el) { const info = el.querySelector('.ri-info'); if (info) info.textContent = pct + '%'; }
    q('dvRenderItemFill').style.width = pct + '%'; q('dvRenderItemText').textContent = pct + '%';
  });
  window.api.onDvRenderDone(({ index, ok, error, note }) => {
    const real = idxMap[index];
    const el = q('job-' + real);
    if (el) {
      el.className = 'result-item ' + (ok ? 'ok' : 'fail');
      el.querySelector('.ri-status').textContent = ok ? '✔' : '✘';
      const info = el.querySelector('.ri-info');
      if (ok) {
        info.textContent = note || '完成';
      } else {
        const reason = (error || '未知错误').split('\n').map((s) => s.trim()).filter(Boolean).pop() || '未知错误';
        renderErrors[real] = error || '未知错误';
        info.innerHTML = `<span class="ri-open">✗ ${reason.slice(0, 38)}（点击看详情）</span>`;
        el.title = error || '';
        const link = info.querySelector('.ri-open');
        link.style.color = 'var(--danger)';
        link.addEventListener('click', () => {
          const box = q('dvRenderErr');
          box.hidden = false;
          box.textContent = `【${dv.jobs[real] ? dv.jobs[real].outputFileName : '任务' + (real + 1)}】渲染失败完整日志：\n\n` + renderErrors[real];
          box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      }
    }
    renderDone++;
    q('dvRenderFill').style.width = Math.round((renderDone / renderTotal) * 100) + '%';
    q('dvRenderText').textContent = `${renderDone} / ${renderTotal}`;
  });

  /* ============ 步骤7 质检 ============ */
  q('dvQuality').addEventListener('click', async () => {
    if (!ensureWs()) return;
    const success = dv.jobs.filter((j) => j.status === 'success');
    if (!success.length) return toast('没有可质检的成片', 'error');
    const deep = q('dvDeepCheck').checked;
    const items = success.map((j) => ({ jobId: j.id, filePath: j.outputPath, expectW: j.width, expectH: j.height, targetDuration: j.estDuration, deep }));
    q('dvQcWrap').hidden = false; q('dvQcFill').style.width = '0%'; q('dvQcText').textContent = `0 / ${items.length}`;
    q('dvQcList').innerHTML = '';

    const res = await window.api.dvQuality(items);
    dv.qc = res;
    dv.data.quality = res;
    await persist('quality');
    const pass = res.filter((r) => r.passed).length;
    q('dvQualitySummary').textContent = `通过 ${pass} / ${res.length}`;
    q('dvExport').disabled = pass === 0;
    markDone(5);
    toast(`质检完成：通过 ${pass} / ${res.length}`, 'success');
  });

  window.api.onDvQualityProgress(({ index, total, result }) => {
    q('dvQcFill').style.width = Math.round(((index + 1) / total) * 100) + '%';
    q('dvQcText').textContent = `${index + 1} / ${total}`;
    const el = document.createElement('div');
    el.className = 'result-item ' + (result.passed ? 'ok' : 'fail');
    el.innerHTML = `<span class="ri-status">${result.passed ? '✔' : '✘'}</span>` +
      `<span class="ri-name">${dbase(result.filePath)}.mp4</span>` +
      `<span class="ri-info">${result.passed ? (result.resolution + ' · ' + fmtDur(result.duration)) : result.reasons.join('; ')}</span>`;
    q('dvQcList').appendChild(el);
  });

  /* ============ 步骤8 交付 ============ */
  q('dvExport').addEventListener('click', async () => {
    if (!ensureWs()) return;
    const qcByJob = {};
    dv.qc.forEach((r) => (qcByJob[r.jobId] = r));
    const items = dv.jobs.filter((j) => j.status === 'success').map((j) => ({ job: j, qc: qcByJob[j.id] }));
    const success = dv.jobs.filter((j) => j.status === 'success').length;
    const payload = {
      workspace: dv.ws, batchId: dv.batchId || 'batch001', items,
      stats: {
        assetCount: dv.data.assets.length, templateCount: dv.data.templates.length,
        planned: dv.jobs.length, success, failed: dv.jobs.length - success,
      },
    };
    q('dvExport').disabled = true; q('dvExport').textContent = '导出中…';
    q('dvExportWrap').hidden = false; q('dvExportFill').style.width = '0%'; q('dvExportText').textContent = '0%';
    try {
      const res = await window.api.dvExport(payload);
      dv.lastBatchDir = res.batchDir;
      dv.data.delivery = res.manifestItems;
      await persist('delivery');
      q('dvExportStats').hidden = false;
      q('dvExportStats').innerHTML = [
        ['交付数量', res.deliveredCount], ['批次', dv.batchId || '-'],
        ['通过率', dv.qc.length ? Math.round(dv.qc.filter((r) => r.passed).length / dv.qc.length * 100) + '%' : '-'],
        ['原片', dv.data.assets.length],
      ].map(([k, v]) => `<div class="ws-stat"><label>${k}</label><span>${v}</span></div>`).join('');
      q('dvOpenBatch').hidden = false;
      markDone(5);
      toast(`交付包已生成：${res.deliveredCount} 条`, 'success');
    } catch (e) {
      toast('导出失败：' + e.message, 'error');
    } finally {
      q('dvExport').disabled = false; q('dvExport').textContent = '导出交付包';
    }
  });
  window.api.onDvExportProgress(({ pct }) => { q('dvExportFill').style.width = pct + '%'; q('dvExportText').textContent = pct + '%'; });
  q('dvOpenBatch').addEventListener('click', () => { if (dv.lastBatchDir) window.api.openPath(dv.lastBatchDir); });
})();
