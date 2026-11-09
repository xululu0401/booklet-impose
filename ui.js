/* 折手账（booklet-impose）· 界面层
 * 输入表单 → AppCore.normalize/analyze/verify → 渲染结论、拼版表、纸面示意、装订对照、
 * 打印清单、结构自检、敏感性；四种导出（CSV/MD/JSON/PNG）+ 打印视图 + 本机保存。
 * 不联网、不上传、不打印调试日志（控制台保持干净）。
 */
'use strict';
(function () {
  const C = window.AppCore;
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = 'booklet-impose-v1';

  const state = {
    input: Object.assign({}, C.defaults),
    res: null,
    cfg: null,
    sel: { sig: 1, k: 1 },
    lastGood: null
  };

  /* ── 表单读写 ───────────────────────────────────────── */

  function readInput() {
    const binding = (document.querySelector('input[name=binding]:checked') || {}).value || 'saddle';
    return {
      pages: $('pages').value,
      paper: $('paper').value,
      customW: $('customW').value,
      customH: $('customH').value,
      thickness: $('thickness').value,
      perSig: $('perSig').value,
      binding: binding,
      creep: $('creep').checked,
      layer: $('layer').value,
      sheetPrice: $('sheetPrice').value
    };
  }

  function writeInput(obj) {
    const v = Object.assign({}, C.defaults, obj || {});
    $('pages').value = v.pages;
    $('paper').value = v.paper;
    $('customW').value = v.customW;
    $('customH').value = v.customH;
    $('thickness').value = v.thickness;
    $('perSig').value = v.perSig;
    $('layer').value = String(v.layer);
    $('sheetPrice').value = v.sheetPrice;
    $('creep').checked = v.creep === true || v.creep === 'true';
    const r = document.querySelector('input[name=binding][value="' + v.binding + '"]');
    if (r) r.checked = true;
    syncConditional();
    syncSegments();
    state.input = v;
  }

  function syncConditional() {
    $('customRow').hidden = $('paper').value !== 'custom';
    const isSaddle = (document.querySelector('input[name=binding]:checked') || {}).value === 'saddle';
    $('saddleOnly').hidden = !isSaddle;
  }

  function syncSegments() {
    document.querySelectorAll('#bindingSeg label').forEach((lab) => {
      const inp = lab.querySelector('input');
      lab.classList.toggle('on', !!(inp && inp.checked));
    });
    document.querySelectorAll('#creepSeg label').forEach((lab) => {
      const inp = lab.querySelector('input');
      lab.classList.toggle('on', !!(inp && inp.checked));
    });
  }

  function markBad(errors) {
    ['pages', 'customW', 'customH', 'thickness', 'perSig', 'layer', 'sheetPrice'].forEach((id) => $(id).classList.remove('bad'));
    errors.forEach((e) => {
      const map = [['总页数', 'pages'], ['自定义纸宽', 'customW'], ['自定义纸高', 'customH'], ['纸张厚度', 'thickness'], ['每帖上限', 'perSig'], ['层厚系数', 'layer'], ['每张纸单价', 'sheetPrice']];
      map.forEach(([kw, id]) => { if (e.indexOf(kw) >= 0) $(id).classList.add('bad'); });
    });
  }

  /* ── 渲染 ───────────────────────────────────────────── */

  function render(keepSelection) {
    const input = readInput();
    state.input = input;
    const norm = C.normalize(input);
    const errBox = $('errors');
    if (!norm.ok) {
      markBad(norm.errors);
      errBox.className = 'on';
      errBox.innerHTML = '<b>这几项还不能算：</b><ul>' + norm.errors.map((e) => '<li>' + esc(e) + '</li>').join('') + '</ul>' +
        '<div style="margin-top:6px">下面的结果还是上一次能算出来的那一份。</div>';
      return;
    }
    errBox.className = '';
    errBox.innerHTML = '';
    markBad([]);

    const cfg = norm.cfg;
    const res = C.analyze(cfg);
    const ver = C.verify(res, cfg);
    const sens = C.sensitivity(input);
    state.cfg = cfg;
    state.res = res;
    state.verify = ver;
    state.sensitivity = sens;
    state.lastGood = { input: Object.assign({}, input), at: new Date().toISOString() };

    if (!keepSelection || !res.sheets.some((s) => s.sig === state.sel.sig && s.k === state.sel.k)) {
      state.sel = { sig: 1, k: 1 };
    }

    renderHeadline(res, cfg);
    renderSheets(res, cfg);
    renderDiagram(res, cfg);
    renderBinding(res, cfg);
    renderChecklist(res, cfg);
    renderAdvice(res, cfg);
    renderChecks(res, ver, cfg);
    renderSensitivity(sens);
    renderLimits(res, cfg);
    renderPrint(res, cfg);
    $('saveState').textContent = '上一次成功计算：' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '（本机保存只存在这个浏览器里）。';
  }

  function renderHeadline(res, cfg) {
    $('headline').innerHTML = esc(res.headline).replace(/[0-9][0-9,.]*\s?(mm|张|帖|页)?/g, (m) => '<b>' + m + '</b>');
    $('bindingTag').textContent = res.bindingName + ' · ' + C.BINDINGS[res.binding].short;
    const kpis = [];
    kpis.push({ k: '用纸张数', v: C.fmt(res.sheetCount, 0), u: ' 张', hi: true });
    if (C.BINDINGS[res.binding].foldable) {
      kpis.push({ k: '分帖', v: C.fmt(res.signatureCount, 0), u: ' 帖', hi: false });
      kpis.push({ k: res.creepOn ? '最内一张内容内移' : '前口突出（未补偿）', v: C.fmt(res.creepOn ? res.maxShiftAll : (res.creep ? res.creep.protrude : 0), 2), u: ' mm', hi: res.creepOn });
      kpis.push({ k: '按外张切齐裁切量', v: C.fmt(res.trimAll, 2), u: ' mm', hi: false });
      kpis.push({ k: '空白页', v: C.fmt(res.blanks, 0), u: ' 页', hi: false });
    } else {
      kpis.push({ k: '空白页', v: C.fmt(res.blanks, 0), u: ' 页', hi: false });
      kpis.push({ k: '书脊厚度', v: C.fmt(res.spine, 2), u: ' mm', hi: true });
      kpis.push({ k: '印面数', v: C.fmt(res.faces, 0), u: ' 面', hi: false });
    }
    kpis.push({ k: '纸张成本', v: '¥' + C.fmt(res.cost, 2), u: '', hi: false });
    $('kpis').innerHTML = kpis.map((x) => '<div class="kpi' + (x.hi ? ' hi' : '') + '"><div class="k">' + x.k + '</div><div class="v">' + x.v + '<span class="u">' + x.u + '</span></div></div>').join('');
    const fin = (res.finish.w && res.finish.h) ? (res.finish.w + ' × ' + res.finish.h + ' mm') : '—';
    $('sizeNote').textContent = '纸张 ' + (res.paper.w ? res.paper.w + '×' + res.paper.h + ' mm（' + res.paper.name + '，横向）' : '—') +
      ' → 对折后成品 ' + fin + '；页数 ' + res.pages + (res.blanks ? '（+ ' + res.blanks + ' 页空白 → ' + res.padded + ' 页）' : '') +
      '；纸厚 ' + C.fmt(res.thickness, 3) + ' mm × 层厚系数 ' + res.layer + ' → 每层 ' + (res.creep ? C.fmt(res.creep.L, 3) : '—') + ' mm；书脊 ' + C.fmt(res.spine, 2) + ' mm。';
  }

  function cellHTML(c) {
    if (!c) return '<div class="cell"></div>';
    if (c.none) return '<div class="cell bl"><span class="n">—</span><span class="t">本面不印</span></div>';
    if (c.blank) return '<div class="cell bl"><span class="n">空白</span><span class="t">留白</span></div>';
    return '<div class="cell"><span class="n">' + c.label + '</span><span class="t">' + (c.page === 1 ? '封面' : '') + '</span></div>';
  }

  function renderSheets(res, cfg) {
    const foldable = C.BINDINGS[res.binding].foldable;
    $('sheetTag').textContent = foldable ? '每面 2 页 · 第 2 面是翻面后的视角' : '每面 1 页 · 顺序双面';
    $('sheetHint').textContent = foldable
      ? '第 k 张的第 1 面先印：左 ' + 'N−2(k−1)' + '、右 ' + '2k−1' + '；翻面后印第 2 面：左 ' + '2k' + '、右 ' + 'N−2k+1' + '（N = 本帖页数）。内移量是这一张内容朝书脊方向要挪的毫米数。'
      : '每面 1 页顺序印：第 k 张正面 ' + '2k−1' + '、反面 ' + '2k' + '。胶装/圈装不需要折手拼版，按顺序叠齐即可。';
    let html = '<thead><tr><th>帖</th><th class="num">张</th><th class="num">第 1 面左</th><th class="num">第 1 面右</th><th class="num">第 2 面左</th><th class="num">第 2 面右</th>' + (foldable ? '<th class="num">内移 mm</th>' : '') + '</tr></thead><tbody>';
    res.signatures.forEach((sig) => {
      if (res.signatureCount > 1) {
        html += '<tr class="sighead"><td colspan="' + (foldable ? 7 : 6) + '">第 ' + sig.index + ' 帖 · 全局第 ' + sig.start + '–' + sig.end + ' 页 · ' + sig.sheets + ' 张</td></tr>';
      }
      sig.rows.forEach((r) => {
        const cells = [r.face1.left, r.face1.right, r.face2.left, r.face2.right];
        html += '<tr><td>' + sig.index + '</td><td class="num">' + r.k + ' / ' + r.m + '</td>' +
          cells.map((c) => '<td class="num' + (c.blank ? ' blank' : '') + '"><span>' + esc(c.label) + '</span></td>').join('') +
          (foldable ? '<td class="num">' + C.fmt(r.shift, 2) + '</td>' : '') + '</tr>';
      });
    });
    html += '</tbody>';
    $('sheetTable').innerHTML = html;
    $('sheetLegend').textContent = (foldable
      ? '「空白」是页数不是 4 的倍数补齐出来的位置；内移量按这一帖的层厚 ' + (res.creep ? C.fmt(res.creep.L, 3) : '—') + ' mm 算，越往里越大。'
      : '「空白」是最后一张剩下的位置。') + ' 窄屏下表格可左右滑动看全列。';
  }

  function renderDiagram(res, cfg) {
    const list = res.sheets.filter((s) => s.sig === state.sel.sig);
    if (!list.length) { $('diagram').innerHTML = ''; return; }
    const m = list.length;
    let sel = list.find((s) => s.k === state.sel.k);
    if (!sel) { sel = list[0]; state.sel.k = sel.k; }
    const foldable = C.BINDINGS[res.binding].foldable;
    const opts = list.map((s) => '<option value="' + s.k + '"' + (s.k === sel.k ? ' selected' : '') + '>第 ' + s.k + ' 张 / 共 ' + m + ' 张</option>').join('');
    let html = '';
    if (res.signatureCount > 1) {
      const sigOpts = res.signatures.map((sg) => '<option value="' + sg.index + '"' + (sg.index === state.sel.sig ? ' selected' : '') + '>第 ' + sg.index + ' 帖（' + sg.start + '–' + sg.end + ' 页）</option>').join('');
      html += '<div class="field" style="flex:1 1 100%"><label>看哪一帖</label><select id="sigPick">' + sigOpts + '</select></div>';
    }
    html += '<div class="field" style="flex:1 1 100%"><label>看哪一张</label><select id="kPick">' + opts + '</select></div>';
    html += '<div class="sheet"><h4>第 1 面（先印）</h4><div class="paper">' + cellHTML(sel.face1.left) + cellHTML(sel.face1.right) + (foldable ? '<div class="fold"></div>' : '') + '</div>' +
      '<p class="facecap">' + (foldable ? '沿虚线对折 · ' : '') + '左 ' + esc(sel.face1.left.label) + ' / 右 ' + esc(sel.face1.right.label) + '</p></div>';
    html += '<div class="sheet"><h4>第 2 面（翻面后印）</h4><div class="paper">' + cellHTML(sel.face2.left) + cellHTML(sel.face2.right) + (foldable ? '<div class="fold"></div>' : '') + '</div>' +
      '<p class="facecap">翻面：左右对调、上下不变 · 左 ' + esc(sel.face2.left.label) + ' / 右 ' + esc(sel.face2.right.label) + '</p></div>';
    if (foldable) {
      html += '<div class="sheet"><h4>这一张要挪多少</h4><div style="font-size:22px;font-weight:700;color:var(--accent)">' + C.fmt(sel.shift, 2) + ' mm</div>' +
        '<p class="facecap" style="text-align:left">从外数第 ' + sel.k + ' 张，朝书脊方向内移 ' + C.fmt(sel.shift, 2) + ' mm（最外一张 0，最内一张 ' + C.fmt(res.trimAll, 2) + ' mm）。</p></div>';
    }
    $('diagram').innerHTML = html;
    $('diagramNote').textContent = foldable
      ? '对折后第 ' + sel.k + ' 张展开应是「左 ' + (2 * sel.k - 1) + ' | 右 ' + (2 * sel.k) + '」对上「左 ' + (sel.m * 4 - 2 * sel.k + 1) + ' | 右 ' + (sel.m * 4 - 2 * sel.k + 2) + '」（帖内页码）。'
      : '按这张的顺序印完再叠下一张即可。';
    const kp = $('kPick');
    if (kp) kp.addEventListener('change', () => { state.sel.k = Number(kp.value); render(true); });
    const sp = $('sigPick');
    if (sp) sp.addEventListener('change', () => { state.sel.sig = Number(sp.value); state.sel.k = 1; render(false); });
  }

  function renderBinding(res, cfg) {
    let html = '<thead><tr><th>装订方式</th><th>拼版</th><th class="num">补齐到</th><th class="num">空白</th><th class="num">用纸</th><th class="num">书脊 mm</th><th>能平摊</th><th>说明</th></tr></thead><tbody>';
    res.bindingRows.forEach((b) => {
      html += '<tr' + (b.current ? ' style="background:var(--accent-soft)"' : '') + '><td>' + b.name + (b.current ? ' <span class="pill">当前</span>' : '') + '</td><td class="pose">' + esc(b.pose) + '</td>' +
        '<td class="num">' + b.padded + ' 页</td><td class="num">' + b.blanks + '</td><td class="num">' + b.sheets + ' 张</td><td class="num">' + C.fmt(b.spine, 2) + '</td>' +
        '<td class="pose">' + (b.flat ? '能' : '不能') + '</td><td class="note">' + esc(b.note) + '</td></tr>';
    });
    html += '</tbody>';
    $('bindingTable').innerHTML = html;
  }

  function renderChecklist(res, cfg) {
    $('checklist').innerHTML = res.checklist.map((t) => '<li>' + esc(t) + '</li>').join('');
  }

  function renderAdvice(res, cfg) {
    $('advice').innerHTML = res.advice.length
      ? res.advice.map((a) => '<li>' + esc(a.text) + '</li>').join('')
      : '<li>当前设置没有需要特别提醒的地方：单张纸、不用分帖、页数正好。</li>';
  }

  function renderChecks(res, ver, cfg) {
    $('checks').innerHTML = ver.checks.map((c) => '<div class="check ' + (c.ok ? 'ok' : 'no') + '"><span class="dot">' + (c.ok ? '✓' : '✗') + '</span><span>' + esc(c.name) + (c.detail ? '<span style="color:var(--muted)"> · ' + esc(c.detail) + '</span>' : '') + '</span></div>').join('');
    $('checkNote').textContent = ver.allOk
      ? '自检全部通过：页序无重不漏、每张纸 4 个面正好是 {2k−1, 2k, N−2k+1, N−2k+2}、每个半张的两面是连续页对（这是能被装订成册的结构条件）。'
      : '有自检未通过，请不要照这份表打印。';
  }

  function renderSensitivity(rows) {
    let html = '<thead><tr><th>条件</th><th>结果</th></tr></thead><tbody>';
    rows.forEach((r) => {
      html += '<tr><td style="white-space:normal">' + esc(r.label) + '</td><td style="white-space:normal">' + esc(r.value) + '</td></tr>';
    });
    html += '</tbody>';
    $('sensTable').innerHTML = html;
  }

  function renderLimits(res, cfg) {
    const items = [
      '只支持<b>对折一次</b>（每面 2 页、每张纸 4 页）；每面 4 页（A3 折两次）的折序与转向组合多，本页不做。',
      '爬移是<b>线性模型</b>：每层厚 = 层厚系数 × 纸张厚度，第 k 张内移 (k−1) × 每层厚。真实推挤曲线与纸张纹向、湿度有关，本页不测纸、不给经验值。',
      '纸张厚度、单价、页数全部由你填写；本页<b>不联网</b>、不查打印店价格、不检查打印机是否支持双面。',
      '不做出血、裁切线、色彩管理、双面套准偏差、覆膜与勒口；不处理跨骑缝的跨页图。',
      '分帖只是把页数切成若干整帖，不处理不同帖用不同纸张或不同装订的组合。',
      '判定性文字（如「厚到会鼓」「爬移明显」）只是<b>显示分组</b>，不是印刷行业标准或质量结论。',
      '默认样例与 6 个内置场景都是<b>虚构示例</b>，不是真实印制记录。'
    ];
    $('limits').innerHTML = items.map((t) => '<li>' + t + '</li>').join('');
  }

  function renderPrint(res, cfg) {
    const foldable = C.BINDINGS[res.binding].foldable;
    const withBack = $('printFaces').checked;
    const parts = [];
    res.sheets.forEach((r) => {
      const faces = withBack ? [['第 1 面', r.face1], ['第 2 面', r.face2]] : [['第 1 面', r.face1]];
      faces.forEach(([name, f]) => {
        const cells = foldable ? [f.left, f.right] : [f.left];
        parts.push('<div class="pcard"><div class="ptitle">第 ' + r.sig + ' 帖 · 第 ' + r.k + ' / ' + r.m + ' 张 · ' + name + '（' +
          cells.map((c) => esc(c.label)).join(' | ') + '）</div><div class="psheet"' + (foldable ? '' : ' style="grid-template-columns:1fr"') + '>' +
          cells.map((c) => '<div>' + esc(c.label) + '</div>').join('') + '</div></div>');
      });
    });
    $('printArea').innerHTML = parts.join('');
    const ps = $('printStyle');
    if (ps && res.paper.w) {
      ps.textContent = '@media print{@page{size:' + res.paper.w + 'mm ' + res.paper.h + 'mm;margin:0}' +
        '.psheet{width:' + res.paper.w + 'mm;height:calc(100% - 8mm)}}';
    }
  }

  /* ── 导出 ───────────────────────────────────────────── */

  function download(name, text, type) {
    try {
      const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      toast('已导出 ' + name);
    } catch (e) {
      toast('导出失败：' + e.message);
    }
  }

  function csvText(res, cfg) {
    const L = [];
    L.push('# 折手账 · 小册子拼版与装订对账');
    L.push('# 生成时间,' + new Date().toLocaleString('zh-CN'));
    L.push('');
    L.push('【汇总】');
    L.push('项目,值');
    const rows = [
      ['成品总页数', res.pages], ['补齐后页数', res.padded], ['空白页数', res.blanks],
      ['装订方式', res.bindingName], ['用纸张数', res.sheetCount], ['分帖数', res.signatureCount],
      ['帖页数', res.signatures.map((s) => s.size).join(' / ')], ['纸张', res.paper.name],
      ['纸张尺寸 mm', res.paper.w ? res.paper.w + '×' + res.paper.h : '—'],
      ['成品尺寸 mm', res.finish.w ? res.finish.w + '×' + res.finish.h : '—'],
      ['纸张厚度 mm', res.thickness], ['层厚系数', res.layer],
      ['每层厚度 mm', res.creep ? res.creep.L : '不适用'],
      ['最内一张内移 mm', res.creepOn ? res.maxShiftAll : 0],
      ['前口突出 mm', res.creep ? res.creep.protrude : '不适用'],
      ['按外张切齐裁切量 mm', res.trimAll], ['书脊厚度 mm', res.spine],
      ['印面数', res.faces], ['纸张成本 元', res.cost]
    ];
    rows.forEach((r) => L.push(r[0] + ',' + r[1]));
    L.push('');
    L.push('【拼版表】');
    L.push(C.BINDINGS[res.binding].foldable
      ? '帖,张,第1面左,第1面右,第2面左,第2面右,内移mm'
      : '张,第1面,第2面');
    res.signatures.forEach((sig) => {
      sig.rows.forEach((r) => {
        if (C.BINDINGS[res.binding].foldable) {
          L.push([sig.index, r.k + '/' + r.m, r.face1.left.label, r.face1.right.label, r.face2.left.label, r.face2.right.label, C.fmt(r.shift, 2)].join(','));
        } else {
          L.push([r.k + '/' + r.m, r.face1.left.label, r.face2.left.label].join(','));
        }
      });
    });
    L.push('');
    L.push('【装订方式对照】');
    L.push('装订方式,拼版,补齐到页,空白页,用纸张数,书脊mm,能否平摊,当前');
    res.bindingRows.forEach((b) => L.push([b.name, b.pose, b.padded, b.blanks, b.sheets, C.fmt(b.spine, 2), b.flat ? '能' : '不能', b.current ? '是' : ''].join(',')));
    L.push('');
    L.push('【敏感性】');
    L.push('条件,结果');
    (state.sensitivity || []).forEach((s) => L.push([s.label, String(s.value).replace(/,/g, '，')].join(',')));
    L.push('');
    L.push('# 默认样例与内置场景均为虚构示例；爬移为线性模型，不是印刷机实测曲线。');
    return '\ufeff' + L.join('\n');
  }

  function mdText(res, cfg) {
    const L = [];
    L.push('# 折手账 · ' + res.bindingName + '（' + res.pages + ' 页）');
    L.push('');
    L.push('> ' + res.headline);
    L.push('');
    L.push('| 项目 | 值 |');
    L.push('|---|---|');
    [['纸张', res.paper.name + (res.paper.w ? ' ' + res.paper.w + '×' + res.paper.h + ' mm' : '')],
     ['成品尺寸', res.finish.w ? res.finish.w + '×' + res.finish.h + ' mm' : '—'],
     ['页数 / 补齐 / 空白', res.pages + ' / ' + res.padded + ' / ' + res.blanks],
     ['用纸张数 / 分帖', res.sheetCount + ' 张 / ' + res.signatureCount + ' 帖'],
     ['帖页数', res.signatures.map((s) => s.size).join(' / ')],
     ['每层厚度', (res.creep ? C.fmt(res.creep.L, 3) : '—') + ' mm'],
     ['最内一张内移', C.fmt(res.creepOn ? res.maxShiftAll : 0, 2) + ' mm'],
     ['前口裁切量', C.fmt(res.trimAll, 2) + ' mm'],
     ['书脊厚度', C.fmt(res.spine, 2) + ' mm'],
     ['纸张成本', '¥' + C.fmt(res.cost, 2)]].forEach((r) => L.push('| ' + r[0] + ' | ' + r[1] + ' |'));
    L.push('');
    L.push('## 拼版表');
    L.push('');
    if (C.BINDINGS[res.binding].foldable) {
      L.push('| 帖 | 张 | 第 1 面左 | 第 1 面右 | 第 2 面左 | 第 2 面右 | 内移 mm |');
      L.push('|---|---|---|---|---|---|---|');
      res.signatures.forEach((sig) => sig.rows.forEach((r) => {
        L.push('| ' + sig.index + ' | ' + r.k + '/' + r.m + ' | ' + r.face1.left.label + ' | ' + r.face1.right.label + ' | ' + r.face2.left.label + ' | ' + r.face2.right.label + ' | ' + C.fmt(r.shift, 2) + ' |');
      }));
    } else {
      L.push('| 张 | 第 1 面 | 第 2 面 |');
      L.push('|---|---|---|');
      res.sheets.forEach((r) => L.push('| ' + r.k + '/' + r.m + ' | ' + r.face1.left.label + ' | ' + r.face2.left.label + ' |'));
    }
    L.push('');
    L.push('## 打印与装订清单');
    L.push('');
    res.checklist.forEach((t) => L.push('- ' + t));
    L.push('');
    L.push('## 结构自检');
    L.push('');
    (state.verify ? state.verify.checks : []).forEach((c) => L.push('- ' + (c.ok ? '✓' : '✗') + ' ' + c.name + (c.detail ? '（' + c.detail + '）' : '')));
    L.push('');
    L.push('## 该注意什么');
    L.push('');
    res.advice.forEach((a) => L.push('- ' + a.text));
    L.push('');
    L.push('## 边界');
    L.push('');
    L.push('- 只支持对折一次（每面 2 页）；爬移为线性模型；不联网、不查打印店价格；默认样例为虚构示例。');
    return L.join('\n');
  }

  function jsonBackup(res, cfg) {
    return JSON.stringify({
      app: 'booklet-impose', version: '1.0.0', savedAt: new Date().toISOString(),
      input: state.input,
      summary: {
        pages: res.pages, padded: res.padded, blanks: res.blanks, binding: res.binding,
        sheetCount: res.sheetCount, signatureCount: res.signatureCount,
        signatureSizes: res.signatures.map((s) => s.size),
        paper: res.paper, finish: res.finish, thickness: res.thickness, layer: res.layer,
        layerMm: res.creep ? res.creep.L : null, maxShift: res.maxShiftAll, trim: res.trimAll,
        spine: res.spine, faces: res.faces, cost: res.cost
      }
    }, null, 2);
  }

  /* 结果卡 PNG 1080×1350 */
  function pngCard() {
    const res = state.res;
    if (!res) { toast('还没有可导出的结果'); return; }
    const W = 1080, H = 1350;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#b4442c'; g.fillRect(0, 0, W, 16);
    let y = 96;
    g.fillStyle = '#1b2733'; g.font = '700 56px -apple-system,"PingFang SC",sans-serif';
    g.fillText('折手账 · 小册子拼版', 64, y);
    y += 46;
    g.fillStyle = '#5c6b7a'; g.font = '400 30px -apple-system,"PingFang SC",sans-serif';
    g.fillText(res.bindingName + ' · ' + res.pages + ' 页 · ' + res.paper.name + ' 横向对折', 64, y);
    y += 56;

    const kpis = [
      ['用纸', res.sheetCount + ' 张'],
      ['分帖', res.signatureCount + ' 帖'],
      ['空白页', res.blanks + ' 页'],
      [res.creepOn ? '最内内移' : '前口突出', C.fmt(res.creepOn ? res.maxShiftAll : (res.creep ? res.creep.protrude : 0), 2) + ' mm']
    ];
    const bw = (W - 128 - 3 * 20) / 4;
    kpis.forEach((k, i) => {
      const x = 64 + i * (bw + 20);
      g.fillStyle = i === 3 ? '#fbeeea' : '#eef3f7';
      roundRect(g, x, y, bw, 132, 14); g.fill();
      g.fillStyle = '#5c6b7a'; g.font = '400 24px -apple-system,"PingFang SC",sans-serif';
      g.fillText(k[0], x + 18, y + 44);
      g.fillStyle = i === 3 ? '#b4442c' : '#1b2733'; g.font = '700 38px -apple-system,"PingFang SC",sans-serif';
      g.fillText(k[1], x + 18, y + 100);
    });
    y += 176;

    g.fillStyle = '#1b2733'; g.font = '700 30px -apple-system,"PingFang SC",sans-serif';
    g.fillText('第 1 张怎么排', 64, y);
    y += 20;
    const first = res.sheets[0];
    const foldable = C.BINDINGS[res.binding].foldable;
    const pw = W - 128, ph = 150;
    const cells = foldable ? [first.face1.left, first.face1.right] : [first.face1.left];
    const cw = pw / cells.length;
    [['第 1 面（先印）', 0], ['第 2 面（翻面后印）', 1]].forEach(([cap, idx]) => {
      const yy = y + 34 + idx * (ph + 62);
      g.fillStyle = '#5c6b7a'; g.font = '400 24px -apple-system,"PingFang SC",sans-serif';
      g.fillText(cap, 64, yy - 10);
      g.strokeStyle = '#b9c6d1'; g.lineWidth = 2;
      g.strokeRect(64, yy, pw, ph);
      const face = idx === 0 ? first.face1 : first.face2;
      const cs = foldable ? [face.left, face.right] : [face.left];
      cs.forEach((c, i) => {
        const cx = 64 + i * cw;
        if (i > 0) { g.beginPath(); g.moveTo(cx, yy); g.lineTo(cx, yy + ph); g.stroke(); }
        g.fillStyle = c.blank ? '#9aa7b4' : '#1b2733';
        g.font = (c.blank ? '600 34px' : '700 52px') + ' -apple-system,"PingFang SC",sans-serif';
        const t = c.label;
        const tw = g.measureText(t).width;
        g.fillText(t, cx + (cw - tw) / 2, yy + ph / 2 + 16);
      });
    });
    y += 34 + 2 * (ph + 62) + 10;

    // 全部张的拼版一览（张数多时只列首尾，避免把卡塞满）
    g.fillStyle = '#1b2733'; g.font = '700 30px -apple-system,"PingFang SC",sans-serif';
    g.fillText(res.sheetCount <= 1 ? '这一张的四个面' : '全部 ' + res.sheetCount + ' 张（第 1 面 | 第 2 面）', 64, y);
    y += 6;
    const rowsToShow = res.sheets.length <= 8
      ? res.sheets
      : res.sheets.slice(0, 4).concat([null]).concat(res.sheets.slice(-1));
    rowsToShow.forEach((r) => {
      y += 39;
      if (!r) {
        g.fillStyle = '#8b98a4'; g.font = '400 24px -apple-system,"PingFang SC",sans-serif';
        g.fillText('…… 其余 ' + (res.sheetCount - 5) + ' 张见页面拼版表与 CSV 导出', 64, y);
        return;
      }
      g.font = '400 25px -apple-system,"PingFang SC",sans-serif';
      g.fillStyle = '#5c6b7a';
      g.fillText((res.signatureCount > 1 ? '帖' + r.sig + ' ' : '') + '第 ' + r.k + ' 张', 64, y);
      g.fillStyle = '#1b2733';
      if (foldable) {
        g.fillText(r.face1.left.label + ' | ' + r.face1.right.label, 250, y);
        g.fillText(r.face2.left.label + ' | ' + r.face2.right.label, 430, y);
        g.fillStyle = r.shift > 0 ? '#b4442c' : '#8b98a4';
        g.fillText('内移 ' + C.fmt(r.shift, 2) + ' mm', 640, y);
      } else {
        g.fillText('第 1 面 ' + r.face1.left.label, 250, y);
        g.fillText('第 2 面 ' + r.face2.left.label, 470, y);
      }
    });
    y += 56;

    if (y < 1170) {
      g.fillStyle = '#1b2733'; g.font = '700 30px -apple-system,"PingFang SC",sans-serif';
      g.fillText('要记住的', 64, y);
      y += 34;
    const bullets = res.advice.slice(0, 2).map((a) => a.text);
    if (!bullets.length) bullets.push('单张纸、不用分帖、页数正好：按表拼版即可。');
    g.font = '400 26px -apple-system,"PingFang SC",sans-serif';
    bullets.forEach((b) => {
      if (y > 1250) return;
      g.fillStyle = '#b4442c'; g.fillText('·', 64, y);
      g.fillStyle = '#1b2733';
      const lines = wrapText(g, b, W - 200);
      lines.slice(0, 2).forEach((ln) => { g.fillText(ln, 92, y); y += 36; });
      y += 4;
    });
    }

    g.fillStyle = '#8b98a4'; g.font = '400 22px -apple-system,"PingFang SC",sans-serif';
    const foot = '数字由同一套已验算的计算导出；爬移为线性模型，不是印刷机实测曲线。示例场景均为虚构。';
    wrapText(g, foot, W - 128).forEach((ln) => { g.fillText(ln, 64, H - 66); });
    g.fillStyle = '#b4442c'; g.fillRect(0, H - 16, W, 16);

    cv.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '折手账-结果卡-' + res.paper.key + '-' + res.pages + '页.png';
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      toast('已导出结果卡 PNG');
    }, 'image/png');
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  // 换行：不在数字中间断行、不让收尾标点落在行首
  function wrapText(g, text, maxWidth) {
    const CLOSERS = '，。、；：！？）》」』】%…';
    const tokens = [];
    // 逐字符扫描，把「数字+单位」当一个整体，避免数字被拆行
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (/[0-9]/.test(ch)) {
        let j = i;
        while (j < text.length && /[0-9,.]/.test(text[j])) j++;
        if (text.slice(j, j + 1) === ' ') j++;
        const unit = /^(mm|kg|%|页|张|帖|元|cm)/.exec(text.slice(j));
        if (unit) j += unit[0].length;
        tokens.push(text.slice(i, j));
        i = j;
      } else if (/\s/.test(ch)) {
        tokens.push(' ');
        i++;
      } else {
        tokens.push(ch);
        i++;
      }
    }
    const lines = [];
    let cur = '';
    tokens.forEach((tk) => {
      if (tk === ' ') {
        if (cur && !/\s$/.test(cur)) cur += ' ';
        return;
      }
      const test = cur + tk;
      if (g.measureText(test).width > maxWidth && cur.trim()) {
        if (CLOSERS.indexOf(tk) >= 0 && g.measureText(cur + tk).width <= maxWidth * 1.12) {
          cur += tk;
          return;
        }
        lines.push(cur.replace(/\s+$/, ''));
        cur = tk;
      } else {
        cur = test;
      }
    });
    if (cur.trim()) lines.push(cur.replace(/\s+$/, ''));
    return lines;
  }

  /* ── 本机保存 / 读取 ────────────────────────────────── */

  function saveLocal() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ input: readInput(), at: new Date().toISOString() }));
      toast('已保存到本机（只在这个浏览器里）');
    } catch (e) { toast('保存失败：' + e.message); }
  }

  function loadLocal(silent) {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) { if (!silent) toast('本机还没有保存过'); return false; }
      const obj = JSON.parse(raw);
      if (!obj || !obj.input) { if (!silent) toast('本机保存的内容不完整'); return false; }
      writeInput(obj.input);
      render(false);
      if (!silent) toast('已读取 ' + new Date(obj.at).toLocaleString('zh-CN'));
      return true;
    } catch (e) { if (!silent) toast('读取失败：' + e.message); return false; }
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'on';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, 2200);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* ── 事件 ───────────────────────────────────────────── */

  function bind() {
    const inputs = ['pages', 'paper', 'customW', 'customH', 'thickness', 'perSig', 'layer', 'sheetPrice'];
    inputs.forEach((id) => {
      const el = $(id);
      el.addEventListener('input', () => { syncConditional(); render(true); });
      el.addEventListener('change', () => { syncConditional(); syncSegments(); render(true); });
    });
    document.querySelectorAll('input[name=binding]').forEach((el) => {
      el.addEventListener('change', () => { syncConditional(); syncSegments(); render(false); });
    });
    $('creep').addEventListener('change', () => { syncSegments(); render(true); });
    $('printFaces').addEventListener('change', () => { if (state.res) renderPrint(state.res, state.cfg); });

    $('btnReset').addEventListener('click', () => { writeInput(C.defaults); render(false); toast('已恢复默认样例'); });
    $('btnSave').addEventListener('click', saveLocal);
    $('btnLoad').addEventListener('click', () => loadLocal(false));
    $('btnCsv').addEventListener('click', () => { if (state.res) download('折手账-拼版-' + state.res.pages + '页.csv', csvText(state.res, state.cfg), 'text/csv;charset=utf-8'); });
    $('btnMd').addEventListener('click', () => { if (state.res) download('折手账-拼版-' + state.res.pages + '页.md', mdText(state.res, state.cfg), 'text/markdown;charset=utf-8'); });
    $('btnJson').addEventListener('click', () => { if (state.res) download('折手账-备份.json', jsonBackup(state.res, state.cfg), 'application/json'); });
    $('btnPng').addEventListener('click', pngCard);
    $('btnPrint').addEventListener('click', () => {
      if (!state.res) return;
      renderPrint(state.res, state.cfg);
      toast('已生成拼版页：按 Ctrl/⌘ + P，纸张选横向、缩放 100%');
      setTimeout(() => { window.print(); }, 300);
    });

    const sel = $('scenario');
    C.scenarios.forEach((s) => {
      const o = document.createElement('option');
      o.value = s.key; o.textContent = s.name;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      const sc = C.scenarios.find((x) => x.key === sel.value);
      if (!sc) return;
      writeInput(sc.input);
      render(false);
      toast('已载入场景：' + sc.name);
    });

    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveLocal(); }
    });
  }

  /* ── 启动 ───────────────────────────────────────────── */

  function boot() {
    bind();
    const loaded = loadLocal(true);
    if (!loaded) { writeInput(C.defaults); }
    render(false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
