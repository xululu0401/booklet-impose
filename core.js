/* 折手账（booklet-impose）· 核心计算
 * 纯函数，无 DOM：拼版页序（闭式公式）、分帖划分（DP）、爬移补偿（线性模型）、
 * 装订方式对照、结构自检、敏感性与成本。
 * window.AppCore（浏览器）/ module.exports（Node 测试）
 */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AppCore = api;
})(typeof self !== 'undefined' ? self : this, function () {

  /* ── 常量 ────────────────────────────────────────────── */

  // 纸张尺寸 mm（横向使用的宽 × 高）
  const PAPERS = {
    A4: { key: 'A4', name: 'A4', w: 297, h: 210 },
    A3: { key: 'A3', name: 'A3', w: 420, h: 297 },
    B5: { key: 'B5', name: 'B5', w: 250, h: 176 },
    Letter: { key: 'Letter', name: 'Letter', w: 279.4, h: 215.9 },
    custom: { key: 'custom', name: '自定义', w: null, h: null }
  };

  const BINDINGS = {
    saddle: {
      key: 'saddle', name: '骑马钉', short: '折手 · 每面 2 页',
      foldable: true, flat: true, pagesStep: 4,
      note: '页数要 4 的倍数；内页会在前口拱出来（爬移）'
    },
    perfect: {
      key: 'perfect', name: '胶装', short: '顺序 · 每面 1 页',
      foldable: false, flat: false, pagesStep: 2,
      note: '页数任意；不能平摊（跨页会丢内容），三边要裁'
    },
    coil: {
      key: 'coil', name: '圈装', short: '顺序 · 每面 1 页',
      foldable: false, flat: true, pagesStep: 2,
      note: '页数任意；能平摊，要给打孔留边距'
    }
  };

  const LIMITS = {
    pages: { min: 1, max: 400, int: true },
    customW: { min: 50, max: 1000 },
    customH: { min: 50, max: 1000 },
    thickness: { min: 0.02, max: 1.0 },
    perSig: { min: 8, max: 200, int: true },
    sheetPrice: { min: 0, max: 1000 },
    layer: { min: 1, max: 2, int: true }
  };

  const defaults = {
    pages: '20',
    paper: 'A4',
    customW: '210',
    customH: '297',
    thickness: '0.10',
    perSig: '32',
    binding: 'saddle',
    creep: true,
    layer: 2,
    sheetPrice: '0.50'
  };

  /* ── 数字解析与校验 ──────────────────────────────────── */

  const FULLWIDTH = '０１２３４５６７８９．';

  function toHalfWidth(s) {
    return String(s).replace(/[０-９．]/g, (ch) => {
      const i = FULLWIDTH.indexOf(ch);
      if (i < 0) return ch;
      return i === 10 ? '.' : String(i);
    });
  }

  function parseNum(raw, opt) {
    const o = opt || {};
    const name = o.name || '数值';
    if (raw === undefined || raw === null) return { ok: false, error: name + '不能为空' };
    let s = toHalfWidth(String(raw)).trim().replace(/[,\s，]/g, '');
    if (s === '') return { ok: false, error: name + '不能为空' };
    if (!/^-?\d*(\.\d*)?$/.test(s)) return { ok: false, error: name + '不是数字：' + String(raw).slice(0, 20) };
    const v = Number(s);
    if (!Number.isFinite(v)) return { ok: false, error: name + '不是有限数字' };
    if (o.int && Math.abs(v - Math.round(v)) > 1e-9) return { ok: false, error: name + '必须是整数' };
    if (o.min !== undefined && v < o.min) return { ok: false, error: name + '不能小于 ' + o.min };
    if (o.max !== undefined && v > o.max) return { ok: false, error: name + '不能大于 ' + o.max };
    const dp = o.dp === undefined ? 6 : o.dp;
    const rounded = Math.round(v * Math.pow(10, dp)) / Math.pow(10, dp);
    return { ok: true, value: rounded };
  }

  function normalize(input) {
    const raw = Object.assign({}, defaults, input || {});
    const errors = [];
    const cfg = {};

    const p = parseNum(raw.pages, { name: '总页数', int: true, min: LIMITS.pages.min, max: LIMITS.pages.max });
    if (!p.ok) errors.push(p.error); else cfg.pages = p.value;

    if (!PAPERS[raw.paper]) errors.push('纸张规格不认识：' + String(raw.paper).slice(0, 12));
    else cfg.paperKey = raw.paper;

    if (!BINDINGS[raw.binding]) errors.push('装订方式不认识：' + String(raw.binding).slice(0, 12));
    else cfg.binding = raw.binding;

    if (cfg.paperKey === 'custom') {
      const w = parseNum(raw.customW, { name: '自定义纸宽', min: LIMITS.customW.min, max: LIMITS.customW.max, dp: 2 });
      const h = parseNum(raw.customH, { name: '自定义纸高', min: LIMITS.customH.min, max: LIMITS.customH.max, dp: 2 });
      if (!w.ok) errors.push(w.error);
      if (!h.ok) errors.push(h.error);
      if (w.ok && h.ok) {
        if (h.value > w.value) errors.push('自定义纸张要横向使用：纸高不能大于纸宽（当前 ' + h.value + ' > ' + w.value + '）');
        else cfg.paper = { key: 'custom', name: '自定义', w: w.value, h: h.value };
      } else cfg.paper = { key: 'custom', name: '自定义', w: null, h: null };
    } else if (cfg.paperKey) {
      cfg.paper = Object.assign({}, PAPERS[cfg.paperKey]);
    }

    const t = parseNum(raw.thickness, { name: '纸张厚度', min: LIMITS.thickness.min, max: LIMITS.thickness.max, dp: 3 });
    if (!t.ok) errors.push(t.error); else cfg.thickness = t.value;

    const s = parseNum(raw.perSig, { name: '每帖上限', int: true, min: LIMITS.perSig.min, max: LIMITS.perSig.max });
    if (!s.ok) errors.push(s.error);
    else if (s.value % 4 !== 0) errors.push('每帖上限必须是 4 的倍数（当前 ' + s.value + ' 页）');
    else cfg.perSig = s.value;

    const l = parseNum(raw.layer, { name: '层厚系数', int: true, min: LIMITS.layer.min, max: LIMITS.layer.max });
    if (!l.ok) errors.push(l.error);
    else if (l.value !== 1 && l.value !== 2) errors.push('层厚系数只能是 1（单层）或 2（对折后两层）');
    else cfg.layer = l.value;

    const price = parseNum(raw.sheetPrice, { name: '每张纸单价', min: LIMITS.sheetPrice.min, max: LIMITS.sheetPrice.max, dp: 4 });
    if (!price.ok) errors.push(price.error); else cfg.sheetPrice = price.value;

    cfg.creep = raw.creep === true || raw.creep === 'true' || raw.creep === 1 || raw.creep === '1';

    // 骑马钉必须 4 的倍数；胶装 / 圈装每面 1 页，补齐到偶数
    if (!errors.length) {
      const step = BINDINGS[cfg.binding].pagesStep;
      cfg.padded = Math.ceil(cfg.pages / step) * step;
      cfg.blanks = cfg.padded - cfg.pages;
    }
    return { ok: errors.length === 0, cfg: errors.length ? null : cfg, errors };
  }

  /* ── 分帖划分：DP 求「帖数最少 → 最大帖最小 → 摊得最平 → 厚的在前」 ── */

  function partsBetter(a, b) {
    if (!b) return true;
    const ma = Math.max.apply(null, a), mb = Math.max.apply(null, b);
    if (ma !== mb) return ma < mb;
    const sa = ma - Math.min.apply(null, a), sb = mb - Math.min.apply(null, b);
    if (sa !== sb) return sa < sb;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  }

  function splitSignatures(totalSheets, capSheets) {
    if (totalSheets <= 0) return [];
    const cap = Math.max(1, Math.floor(capSheets));
    const k = Math.ceil(totalSheets / cap);
    const memo = new Map();
    function best(rest, sigs) {
      if (sigs === 0) return rest === 0 ? [] : null;
      if (rest < sigs || rest > sigs * cap) return null;
      const key = rest + ':' + sigs;
      if (memo.has(key)) return memo.get(key);
      let out = null;
      const lo = Math.max(1, rest - (sigs - 1) * cap);
      const hi = Math.min(cap, rest - (sigs - 1));
      for (let part = lo; part <= hi; part++) {
        const tail = best(rest - part, sigs - 1);
        if (!tail) continue;
        const seq = [part].concat(tail);
        if (partsBetter(seq, out)) out = seq;
      }
      memo.set(key, out);
      return out;
    }
    return best(totalSheets, k) || [];
  }

  /* ── 拼版页序 ────────────────────────────────────────── */

  // 骑马钉：对折一次，每面 2 页。第 k 张（1 = 最外）
  //   第 1 面（先印）：左 N−2(k−1)，右 2k−1
  //   第 2 面（翻面后，左右对调视角）：左 2k，右 N−2k+1
  function imposeSignature(N) {
    const m = N / 4;
    const out = [];
    for (let k = 1; k <= m; k++) {
      out.push({
        k: k, m: m,
        face1: { left: N - 2 * (k - 1), right: 2 * k - 1 },
        face2: { left: 2 * k, right: N - 2 * k + 1 }
      });
    }
    return out;
  }

  // 胶装 / 圈装：不打折手，每面 1 页，双面顺序
  function sequentialPose(padded) {
    const m = Math.ceil(padded / 2);
    const out = [];
    for (let k = 1; k <= m; k++) {
      out.push({ k: k, m: m, face1: { left: 2 * k - 1, right: null }, face2: { left: 2 * k, right: null } });
    }
    return out;
  }

  /* ── 爬移（线性模型） ────────────────────────────────── */

  function creepModel(m, thickness, layer, creepOn) {
    const L = Math.round((layer * thickness) * 1000) / 1000;
    // 第 k 张（1 = 最外）内移 (k−1)·L：内张前口突出得多、被切掉得多，所以越往里越要朝书脊挪
    const shiftOf = (k) => (creepOn ? Math.round((k - 1) * L * 1000) / 1000 : 0);
    return {
      L: L,
      perLayerNote: layer === 2 ? '对折后前口两层' : '单层（保守取一层）',
      shiftOf: shiftOf,
      maxShift: shiftOn(m, L, creepOn),
      protrude: Math.round((m - 1) * L * 1000) / 1000,
      trim: Math.round((m - 1) * L * 1000) / 1000,
      spine: Math.round(m * L * 1000) / 1000
    };
  }
  function shiftOn(m, L, on) { return on ? Math.round((m - 1) * L * 1000) / 1000 : 0; }

  /* ── 主分析 ──────────────────────────────────────────── */

  function analyze(cfg) {
    const B = BINDINGS[cfg.binding];
    const padded = cfg.padded;
    const blankSet = new Set();
    for (let p = cfg.pages + 1; p <= padded; p++) blankSet.add(p);

    const sheets = [];      // 逐张明细
    const signatures = [];  // 分帖信息
    let sheetCount = 0;

    if (B.foldable) {
      const totalSheets = padded / 4;
      const parts = splitSignatures(totalSheets, cfg.perSig / 4);
      let cursor = 1;
      parts.forEach((sheetsInSig, idx) => {
        const size = sheetsInSig * 4;
        const start = cursor, end = cursor + size - 1;
        const local = imposeSignature(size);
        const creep = creepModel(sheetsInSig, cfg.thickness, cfg.layer, cfg.creep);
        const rows = local.map((row) => {
          const mk = (v) => {
            const g = start - 1 + v;
            const blank = g > cfg.pages;
            return { page: blank ? null : g, g: g, label: blank ? '空白' : String(g), blank: blank, rel: v };
          };
          return {
            sig: idx + 1, k: row.k, m: row.m,
            face1: { left: mk(row.face1.left), right: mk(row.face1.right) },
            face2: { left: mk(row.face2.left), right: mk(row.face2.right) },
            shift: creep.shiftOf(row.k)
          };
        });
        signatures.push({
          index: idx + 1, start: start, end: end, size: size,
          sheets: sheetsInSig, rows: rows, creep: creep
        });
        rows.forEach((r) => sheets.push(r));
        cursor = end + 1;
      });
      sheetCount = totalSheets;
    } else {
      const pose = sequentialPose(padded);
      pose.forEach((row) => {
        const mk = (v) => {
          if (v === null || v === undefined) return { page: null, g: null, label: '—', blank: false, none: true, rel: null };
          const blank = v > cfg.pages;
          return { page: blank ? null : v, g: v, label: blank ? '空白' : String(v), blank: blank, rel: v };
        };
        sheets.push({
          sig: 1, k: row.k, m: row.m,
          face1: { left: mk(row.face1.left), right: { page: null, label: '（本面只印 1 页）', blank: false, none: true } },
          face2: { left: mk(row.face2.left), right: { page: null, label: '（本面只印 1 页）', blank: false, none: true } },
          shift: 0
        });
      });
      signatures.push({
        index: 1, start: 1, end: padded, size: padded, sheets: sheetCount = pose.length,
        rows: sheets, creep: null
      });
    }

    const spine = B.foldable
      ? Math.round(sheetCount * cfg.layer * cfg.thickness * 1000) / 1000
      : Math.round(sheetCount * cfg.thickness * 1000) / 1000;

    const paper = cfg.paper || { w: null, h: null, name: '自定义' };
    const finish = (paper.w && paper.h)
      ? { w: Math.round((paper.w / 2) * 10) / 10, h: Math.round(paper.h * 10) / 10 }
      : { w: null, h: null };

    const res = {
      batchName: '折手账',
      binding: cfg.binding,
      bindingName: B.name,
      padded: padded,
      pages: cfg.pages,
      blanks: cfg.blanks,
      blankPages: Array.from(blankSet),
      sheetCount: sheetCount,
      signatureCount: signatures.length,
      signatures: signatures,
      sheets: sheets,
      faces: sheetCount * 2,
      cost: Math.round(sheetCount * cfg.sheetPrice * 100) / 100,
      spine: spine,
      paper: { key: paper.key, name: paper.name, w: paper.w, h: paper.h },
      finish: finish,
      thickness: cfg.thickness,
      layer: cfg.layer,
      perSig: cfg.perSig,
      creepOn: cfg.creep,
      creep: B.foldable && signatures[0] ? signatures[0].creep : null,
      headline: null,
      bindingRows: null,
      checklist: [],
      advice: []
    };

    // 跨帖（多帖）时以「最厚一帖」为爬移口径，逐帖各自的内移量已在 rows 里
    let maxShiftAll = 0, trimAll = 0;
    signatures.forEach((s) => {
      if (s.creep) { maxShiftAll = Math.max(maxShiftAll, s.creep.maxShift); trimAll = Math.max(trimAll, s.creep.trim); }
    });
    res.maxShiftAll = maxShiftAll;
    res.trimAll = trimAll;

    res.headline = buildHeadline(res, B);
    res.bindingRows = buildBindingRows(cfg);
    res.checklist = buildChecklist(res, B);
    res.advice = buildAdvice(res, B, cfg);
    res.sequence = B.foldable ? null : sheets.map((r) => ({ k: r.k, front: r.face1.left.label, back: r.face2.left.label }));
    return res;
  }

  function buildHeadline(res, B) {
    const parts = [];
    if (B.foldable) {
      parts.push('共 ' + res.sheetCount + ' 张纸' + (res.signatureCount > 1 ? '、' + res.signatureCount + ' 帖' : ''));
      parts.push(res.blanks > 0 ? '要留 ' + res.blanks + ' 页空白' : '不用留空白页');
      if (res.creep && res.creepOn && res.sheetCount > 1) {
        parts.push('最内一张内容要朝书脊内移 ' + fmt(res.maxShiftAll, 2) + ' mm（按外张切齐要裁 ' + fmt(res.trimAll, 2) + ' mm）');
      } else if (res.creep && res.sheetCount > 1) {
        parts.push('爬移补偿已关闭：内张前口会比外张突出 ' + fmt(res.creep.protrude, 2) + ' mm');
      }
    } else {
      parts.push('共 ' + res.sheetCount + ' 张纸（每面 1 页、双面顺序印）');
      parts.push(res.blanks > 0 ? '最后一页留空' : '不多不少正好印完');
      parts.push('书脊厚约 ' + fmt(res.spine, 2) + ' mm，' + (B.flat ? '可以平摊' : '不能平摊（跨页会丢内容）'));
    }
    return parts.join('；');
  }

  function buildBindingRows(cfg) {
    const paper = cfg.paper || {};
    const area = (paper.w && paper.h) ? paper.w * paper.h : null;
    const rows = [];
    Object.keys(BINDINGS).forEach((key) => {
      const b = BINDINGS[key];
      const padded = Math.ceil(cfg.pages / b.pagesStep) * b.pagesStep;
      const sheets = key === 'saddle' ? padded / 4 : Math.ceil(padded / 2);
      const spineMm = key === 'saddle'
        ? Math.round(sheets * cfg.layer * cfg.thickness * 1000) / 1000
        : Math.round(sheets * cfg.thickness * 1000) / 1000;
      rows.push({
        key: key, name: b.name, pose: b.short,
        padded: padded, blanks: padded - cfg.pages, sheets: sheets,
        spine: spineMm, flat: b.flat, foldable: b.foldable,
        current: key === cfg.binding,
        note: b.note
      });
    });
    return rows;
  }

  function buildChecklist(res, B) {
    const list = [];
    if (B.foldable) {
      list.push('打印：双面；翻面时保持上下方向不变、左右对调（有的驱动里叫「短边翻转」，命名各家不一，务必先试印一张自检）');
      list.push('缩放选「实际大小 / 100%」，不要选「适应页面」；纸张方向选横向');
      list.push('每面 1 页（本页已经排好拼版），不要再用驱动里的「小册子 / Booklet」功能，否则会排两次');
      list.push('印完先对折一张自检：第 1 张展开应看到「1 | 2」对上「3 | 4」');
      if (res.blanks > 0) list.push('末帖最后 ' + res.blanks + ' 页是空白，位置见拼版表里的「空白」');
      if (res.sheetCount > 1) list.push('装订前按外张前口切齐：裁掉约 ' + fmt(res.trimAll, 2) + ' mm（或按表里的内移量逐张移位后不裁）');
    } else {
      list.push('打印：双面（本页按顺序排好，正面 ' + '2k−1' + '、反面 ' + '2k' + '）');
      list.push('缩放选「实际大小 / 100%」；' + (B.flat ? '圈装要留打孔边距（约 8–12 mm）' : '胶装三边裁切后再上胶'));
      list.push('印完按顺序叠齐，先翻一遍确认没有跳页');
    }
    return list;
  }

  function buildAdvice(res, B, cfg) {
    const out = [];
    if (B.foldable && res.sheetCount > 1) {
      if (res.creepOn && res.trimAll >= 1) {
        out.push({ kind: 'trim', text: '前口要裁掉 ' + fmt(res.trimAll, 2) + ' mm 才齐，留边距时把这点算进去（别把正文放到最外 5 mm）。' });
      }
      if (res.maxShiftAll >= 2) {
        out.push({ kind: 'thin', text: '内移已经到 ' + fmt(res.maxShiftAll, 2) + ' mm（纸太厚或张数太多），换薄一点的纸会直接减小这个数。' });
      }
    }
    if (B.foldable && res.signatureCount > 1) {
      out.push({ kind: 'sig', text: '页数超过每帖上限，已拆成 ' + res.signatureCount + ' 帖（' + res.signatures.map((s) => s.size).join(' / ') + ' 页），每帖单独对折、按顺序叠放装订。' });
    }
    if (B.foldable && res.sheetCount > 1 && res.creepOn) {
      out.push({ kind: 'shift', text: '要么按表里的内移量逐张移位（不用裁），要么全部不补偿、装订后按外张前口一次切齐 ' + fmt(res.trimAll, 2) + ' mm。两条路选一条，别都不做。' });
    }
    if (!B.foldable && !B.flat) {
      out.push({ kind: 'flat', text: '胶装不能平摊：跨页的图或表会被书脊吃掉，跨页内容要留出装订边。' });
    }
    if (res.blanks > 0) {
      out.push({ kind: 'blank', text: '多出来的 ' + res.blanks + ' 页是空白，可以拿来做扉页、版权页或留言页，位置见拼版表。' });
    }
    if (B.foldable && res.sheetCount >= 21) {
      out.push({ kind: 'thick', text: '这一帖已有 ' + res.sheetCount + ' 张，骑马钉会鼓，建议把每帖上限调小一点分帖。' });
    }
    return out;
  }

  /* ── 结构自检（不重复实现公式，只查性质） ───────────── */

  function verify(res, cfg) {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail || '' });
    const labels = [];
    res.sheets.forEach((r) => {
      [r.face1.left, r.face1.right, r.face2.left, r.face2.right].forEach((c) => {
        if (c && !c.none) labels.push(c.page === null ? 'B' : c.page);
      });
    });

    if (BINDINGS[res.binding].foldable) {
      // 每张纸 4 个面必须是 {2k−1, 2k, N−2k+1, N−2k+2}（帖内相对页码）
      let setOk = true, leafOk = true, coverOk = true;
      const sigBad = [];
      res.signatures.forEach((sig) => {
        const N = sig.size;
        const seenRel = new Set();
        let dup = false;
        sig.rows.forEach((r) => {
          const cells = [r.face1.left, r.face1.right, r.face2.left, r.face2.right];
          const rel = cells.map((c) => (c.page === null ? c.rel : c.page - (sig.start - 1)));
          const want = [2 * r.k - 1, 2 * r.k, N - 2 * r.k + 1, N - 2 * r.k + 2];
          const got = rel.slice().sort((a, b) => a - b);
          if (got.join(',') !== want.slice().sort((a, b) => a - b).join(',')) setOk = false;
          rel.forEach((v) => { if (seenRel.has(v)) dup = true; seenRel.add(v); });
          // 叶子性质：同一半张的两面 = 连续页对（奇数在前）
          [[r.face1.right, r.face2.left], [r.face2.right, r.face1.left]].forEach((pp, i) => {
            const ra = pp[0].page === null ? pp[0].rel : pp[0].page - (sig.start - 1);
            const rb = pp[1].page === null ? pp[1].rel : pp[1].page - (sig.start - 1);
            if (Math.abs(ra - rb) !== 1) leafOk = false;
            if (i === 0 && pp[0].page !== null && (ra % 2) !== 1) leafOk = false;
          });
        });
        if (dup || seenRel.size !== N) sigBad.push('帖 ' + sig.index + '（' + seenRel.size + '/' + N + '）');
      });
      // 多帖时聚合成一条，避免 50 帖把自检区刷成几百行；异常时点名是哪几帖
      add('每帖帖内页码无重不漏', sigBad.length === 0,
        res.signatures.length + ' 帖' + (sigBad.length ? '；异常：' + sigBad.join('、') : ''));
      add('每张纸 4 面 = {2k−1, 2k, N−2k+1, N−2k+2}', setOk);
      add('同一半张两面是连续页对（能被装订成册）', leafOk);
      // 第一张第 1 面右边必须是第 1 页（封面在封面位）
      const first = res.sheets[0];
      coverOk = !!(first && first.face1.right && first.face1.right.page === 1);
      add('封面（第 1 页）落在第 1 张第 1 面右侧', coverOk);
    } else {
      const real = [];
      res.sheets.forEach((r) => { [r.face1.left, r.face2.left].forEach((c) => { if (c && !c.none) real.push(c.rel); }); });
      const want = [];
      for (let i = 1; i <= res.padded; i++) want.push(i);
      add('顺序拼版读出的页序正好是 1…' + res.padded + '（含空白占位）',
        real.join(',') === want.join(','), real.join(','));
    }

    const blankCount = labels.filter((x) => x === 'B').length;
    add('空白格数 = 补齐页数', blankCount === res.blanks, blankCount + ' / ' + res.blanks);

    const nums = res.sheets.flatMap((r) => [r.face1.left, r.face1.right, r.face2.left, r.face2.right])
      .filter((c) => c && !c.none && c.page !== null).map((c) => c.page);
    const uniq = new Set(nums);
    add('正文页码不重复', uniq.size === nums.length, nums.length + ' 格 / ' + uniq.size + ' 个页码');
    const expect = [];
    for (let i = 1; i <= res.pages; i++) expect.push(i);
    add('正文页码覆盖 1…' + res.pages, nums.slice().sort((a, b) => a - b).join(',') === expect.join(','));

    const bad = [];
    res.sheets.forEach((r) => { if (!(r.shift >= 0)) bad.push(r.k); });
    add('内移量非负', bad.length === 0);
    add('张数 = 所需纸张', res.sheetCount === (BINDINGS[res.binding].foldable ? res.padded / 4 : Math.ceil(res.padded / 2)));
    return { checks: checks, allOk: checks.every((c) => c.ok) };
  }

  /* ── 敏感性 ──────────────────────────────────────────── */

  function sensitivity(input) {
    const base = normalize(input);
    if (!base.ok) return [];
    const cfg = base.cfg;
    const rows = [];
    const push = (label, mutate, read) => {
      const nx = normalize(Object.assign({}, input, mutate));
      if (!nx.ok) { rows.push({ label: label, value: '不适用', detail: nx.errors.join('；') }); return; }
      const r = analyze(nx.cfg);
      rows.push({ label: label, value: read(r, nx.cfg), cfg: nx.cfg, res: r });
    };
    const native = analyze(cfg);
    rows.push({ label: '当前设置', value: readBase(native), cfg: cfg, res: native });
    push('纸张厚一点（+20%）', { thickness: String(Math.round(cfg.thickness * 1.2 * 1000) / 1000) }, (r) => r.creep ? '最内内移 ' + fmt(r.maxShiftAll, 2) + ' mm' : '不适用');
    push('纸张薄一点（−20%）', { thickness: String(Math.max(0.02, Math.round(cfg.thickness * 0.8 * 1000) / 1000)) }, (r) => r.creep ? '最内内移 ' + fmt(r.maxShiftAll, 2) + ' mm' : '不适用');
    if (BINDINGS[cfg.binding].foldable) {
      push('层厚系数改 1', { layer: 1 }, (r) => r.creep ? '最内内移 ' + fmt(r.maxShiftAll, 2) + ' mm' : '不适用');
      push('每帖上限调到 ' + Math.max(8, cfg.perSig - 8), { perSig: String(Math.max(8, cfg.perSig - 8)) }, (r) => r.signatureCount + ' 帖（' + r.signatures.map((s) => s.size).join('/') + '）');
      push('再多 2 页', { pages: String(Math.min(400, cfg.pages + 2)) }, (r) => r.sheetCount + ' 张 / 空白 ' + r.blanks);
    }
    ['saddle', 'perfect', 'coil'].forEach((k) => {
      if (k === cfg.binding) return;
      push('改用' + BINDINGS[k].name, { binding: k }, (r) => r.sheetCount + ' 张' + (r.creep ? '、内移 ' + fmt(r.maxShiftAll, 2) + ' mm' : '、无爬移') + '、书脊 ' + fmt(r.spine, 2) + ' mm');
    });
    return rows;
  }

  function readBase(r) {
    return r.sheetCount + ' 张' + (r.signatureCount > 1 ? ' / ' + r.signatureCount + ' 帖' : '') + (r.creep ? '、内移 ' + fmt(r.maxShiftAll, 2) + ' mm' : '') + '、书脊 ' + fmt(r.spine, 2) + ' mm';
  }

  /* ── 内置场景 ────────────────────────────────────────── */

  const scenarios = [
    { key: 's1', name: '默认：20 页骑马钉（A4 对折成 A5）', input: { pages: '20', paper: 'A4', thickness: '0.10', perSig: '32', binding: 'saddle', creep: true, layer: 2, sheetPrice: '0.50' } },
    { key: 's2', name: '空白补齐：19 页 → 多出 1 页空白', input: { pages: '19', paper: 'A4', thickness: '0.10', perSig: '32', binding: 'saddle', creep: true, layer: 2, sheetPrice: '0.50' } },
    { key: 's3', name: '分帖：100 页、每帖上限 32', input: { pages: '100', paper: 'A4', thickness: '0.10', perSig: '32', binding: 'saddle', creep: true, layer: 2, sheetPrice: '0.50' } },
    { key: 's4', name: '爬移明显：60 页 + 厚纸 0.20 mm', input: { pages: '60', paper: 'A4', thickness: '0.20', perSig: '64', binding: 'saddle', creep: true, layer: 2, sheetPrice: '0.50' } },
    { key: 's5', name: 'A3 对折成 A4：32 页', input: { pages: '32', paper: 'A3', thickness: '0.12', perSig: '32', binding: 'saddle', creep: true, layer: 2, sheetPrice: '1.20' } },
    { key: 's6', name: '胶装对照：50 页（每面 1 页顺序印）', input: { pages: '50', paper: 'A4', thickness: '0.10', perSig: '32', binding: 'perfect', creep: false, layer: 2, sheetPrice: '0.50' } }
  ];

  /* ── 工具 ────────────────────────────────────────────── */

  function fmt(v, dp) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const d = dp === undefined ? 2 : dp;
    const s = v.toFixed(d);
    const parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  return {
    PAPERS: PAPERS, BINDINGS: BINDINGS, LIMITS: LIMITS, defaults: defaults,
    scenarios: scenarios,
    parseNum: parseNum, normalize: normalize,
    splitSignatures: splitSignatures,
    imposeSignature: imposeSignature, sequentialPose: sequentialPose,
    creepModel: creepModel,
    analyze: analyze, verify: verify, sensitivity: sensitivity,
    fmt: fmt, partsBetter: partsBetter
  };
});
