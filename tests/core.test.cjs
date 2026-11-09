/* 折手账（booklet-impose）· 核心测试（node --test tests/core.test.cjs）
 * 覆盖：输入解析与非法值、拼版闭式公式与结构不变量、**独立实现的物理折纸-套叠阅读模型**（含负向自检
 *       与「翻面方式用错」的对照）、分帖划分 DP 与暴力枚举对拍、爬移线性模型、装订方式对照、
 *       尺寸换算、输出契约、确定性与不修改入参。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../core.js');

/* ═══ 独立实现：物理折纸 + 逐张套叠的阅读模型 ═══════════════════════════════
 * 与 core 的闭式公式完全不同的推导路径：
 *   1) 把拼版表还原成「纸的物理两面」：第 1 面是 A 面（左右同向），第 2 面是 B 面（左右对调后的视角）。
 *   2) 左半张折到右半张下面 → 单张的面序（上→下）= [A.col2, B.col2, B.col1, A.col1]。
 *   3) 套叠：外张在前、内张在后 → 前两面按「外→内」，后两面按「内→外」。
 * 读出的是帖内相对页码，必须正好是 1…N。
 * flipMode = 'lr' 为说明书要求的翻面方式（左右对调）；'tb' 是「上下翻转」的错误方式，用于负向对照。
 */
function oracleReadOrder(rows, flipMode) {
  const mode = flipMode || 'lr';
  const stacks = rows.map((r) => {
    const A = { c1: r.face1.left, c2: r.face1.right };
    const B = mode === 'lr'
      ? { c1: r.face2.right, c2: r.face2.left }
      : { c1: r.face2.left, c2: r.face2.right };
    return [A.c2, B.c2, B.c1, A.c1];
  });
  const order = [];
  const m = stacks.length;
  for (let i = 0; i < m; i++) order.push(stacks[i][0], stacks[i][1]);
  for (let i = m - 1; i >= 0; i--) order.push(stacks[i][2], stacks[i][3]);
  const val = (c) => (typeof c === 'number' ? c : (c && c.rel !== undefined && c.rel !== null ? c.rel : null));
  return order.map(val);
}

const seq = (n) => { const a = []; for (let i = 1; i <= n; i++) a.push(i); return a; };
const cfgOf = (input) => {
  const n = C.normalize(Object.assign({}, C.defaults, input || {}));
  assert.ok(n.ok, '输入应有效：' + JSON.stringify(input) + ' → ' + n.errors.join('；'));
  return n.cfg;
};
const resOf = (input) => C.analyze(cfgOf(input));

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ═══ G1 输入解析与校验 ═══════════════════════════════════════════════ */

test('G1-1 默认配置合法，关键数字锚点与需求简报一致', () => {
  const r = resOf({});
  assert.strictEqual(r.padded, 20);
  assert.strictEqual(r.blanks, 0);
  assert.strictEqual(r.sheetCount, 5);
  assert.strictEqual(r.signatureCount, 1);
  assert.strictEqual(r.creep.L, 0.2);
  assert.strictEqual(r.maxShiftAll, 0.8);
  assert.strictEqual(r.trimAll, 0.8);
  assert.strictEqual(r.spine, 1);
  assert.strictEqual(r.cost, 2.5);
  assert.deepStrictEqual({ w: r.finish.w, h: r.finish.h }, { w: 148.5, h: 210 });
});

test('G1-2 数字写法：全角、千分位、前后空格都能解析', () => {
  const n = C.normalize({ pages: '２０', thickness: '０.１０', sheetPrice: '1,000' });
  assert.ok(n.ok, n.errors.join('；'));
  assert.strictEqual(n.cfg.pages, 20);
  assert.strictEqual(n.cfg.thickness, 0.1);
  assert.strictEqual(n.cfg.sheetPrice, 1000);
  assert.strictEqual(C.parseNum(' 32 ', { int: true }).value, 32);
});

test('G1-3 非法与越界输入逐条给出明确错误（30 条）', () => {
  const bad = [
    [{ pages: '' }, '总页数'],
    [{ pages: '0' }, '总页数'],
    [{ pages: '-3' }, '总页数'],
    [{ pages: '2.5' }, '整数'],
    [{ pages: '401' }, '不能大于'],
    [{ pages: 'abc' }, '不是数字'],
    [{ pages: null }, '不能为空'],
    [{ thickness: '' }, '纸张厚度'],
    [{ thickness: '0' }, '不能小于'],
    [{ thickness: '0.01' }, '不能小于'],
    [{ thickness: '1.01' }, '不能大于'],
    [{ thickness: 'x' }, '不是数字'],
    [{ perSig: '6' }, '不能小于'],
    [{ perSig: '10' }, '4 的倍数'],
    [{ perSig: '4' }, '不能小于'],
    [{ perSig: '204' }, '不能大于'],
    [{ perSig: '32.5' }, '整数'],
    [{ layer: '3' }, '层厚系数'],
    [{ layer: '0' }, '不能小于'],
    [{ layer: '1.5' }, '整数'],
    [{ sheetPrice: '-1' }, '不能小于'],
    [{ sheetPrice: '1001' }, '不能大于'],
    [{ sheetPrice: 'abc' }, '不是数字'],
    [{ paper: 'A0' }, '纸张规格'],
    [{ paper: '' }, '纸张规格'],
    [{ binding: 'staple' }, '装订方式'],
    [{ binding: '' }, '装订方式'],
    [{ paper: 'custom', customW: '40' }, '自定义纸宽'],
    [{ paper: 'custom', customW: '210', customH: '1200' }, '自定义纸高'],
    [{ paper: 'custom', customW: '210', customH: '297' }, '横向使用']
  ];
  bad.forEach(([input, kw]) => {
    const n = C.normalize(Object.assign({}, C.defaults, input));
    assert.strictEqual(n.ok, false, '应判非法：' + JSON.stringify(input));
    assert.ok(n.errors.join('；').includes(kw),
      JSON.stringify(input) + ' 的错误里应包含「' + kw + '」，实际：' + n.errors.join('；'));
    assert.strictEqual(n.cfg, null);
  });
});

test('G1-4 自定义纸张合法时按填写的宽高计算成品尺寸', () => {
  const n = C.normalize({ paper: 'custom', customW: '300', customH: '200' });
  assert.ok(n.ok, n.errors.join('；'));
  const r = C.analyze(n.cfg);
  assert.deepStrictEqual({ w: r.paper.w, h: r.paper.h }, { w: 300, h: 200 });
  assert.deepStrictEqual({ w: r.finish.w, h: r.finish.h }, { w: 150, h: 200 });
});

test('G1-5 边界合法值（最小/最大）不被误判', () => {
  const ok = [
    { pages: '1' }, { pages: '400' }, { thickness: '0.02' }, { thickness: '1' },
    { perSig: '8' }, { perSig: '200' }, { layer: 1 }, { sheetPrice: '0' }, { sheetPrice: '1000' },
    { paper: 'custom', customW: '50', customH: '50' }
  ];
  ok.forEach((input) => {
    const n = C.normalize(Object.assign({}, C.defaults, input));
    assert.ok(n.ok, JSON.stringify(input) + ' 应合法，实际：' + n.errors.join('；'));
  });
});

/* ═══ G2 拼版闭式公式与结构不变量 ═════════════════════════════════════ */

test('G2-1 4 页 → [4|1] / [2|3]（单张经典拼版）', () => {
  const r = C.imposeSignature(4);
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual(r[0].face1, { left: 4, right: 1 });
  assert.deepStrictEqual(r[0].face2, { left: 2, right: 3 });
});

test('G2-2 8 页 → 两张纸的经典拼版', () => {
  const r = C.imposeSignature(8);
  assert.deepStrictEqual(r[0].face1, { left: 8, right: 1 });
  assert.deepStrictEqual(r[0].face2, { left: 2, right: 7 });
  assert.deepStrictEqual(r[1].face1, { left: 6, right: 3 });
  assert.deepStrictEqual(r[1].face2, { left: 4, right: 5 });
});

test('G2-3 每张纸的 4 个面恰好是 {2k−1, 2k, N−2k+1, N−2k+2}，且全部张无重不漏覆盖 1…N（4…200 页）', () => {
  for (let N = 4; N <= 200; N += 4) {
    const rows = C.imposeSignature(N);
    assert.strictEqual(rows.length, N / 4, 'N=' + N + ' 张数');
    const all = [];
    rows.forEach((r) => {
      const got = [r.face1.left, r.face1.right, r.face2.left, r.face2.right].slice().sort((a, b) => a - b);
      const want = [2 * r.k - 1, 2 * r.k, N - 2 * r.k + 1, N - 2 * r.k + 2].sort((a, b) => a - b);
      assert.deepStrictEqual(got, want, 'N=' + N + ' 第 ' + r.k + ' 张');
      all.push(...got);
    });
    assert.deepStrictEqual(all.slice().sort((a, b) => a - b), seq(N), 'N=' + N + ' 覆盖');
  }
});

test('G2-4 每一面的「左 + 右 = N + 1」恒成立（翻面后视角的必然结果）', () => {
  for (let N = 4; N <= 120; N += 4) {
    C.imposeSignature(N).forEach((r) => {
      assert.strictEqual(r.face1.left + r.face1.right, N + 1, 'N=' + N + ' k=' + r.k + ' 第 1 面');
      assert.strictEqual(r.face2.left + r.face2.right, N + 1, 'N=' + N + ' k=' + r.k + ' 第 2 面');
    });
  }
});

test('G2-5 同一半张的两面是连续页对（奇数在前的叶子性质）', () => {
  for (let N = 4; N <= 120; N += 4) {
    C.imposeSignature(N).forEach((r) => {
      assert.strictEqual(Math.abs(r.face1.right - r.face2.left), 1, 'N=' + N + ' k=' + r.k + ' 右半张');
      assert.strictEqual(Math.min(r.face1.right, r.face2.left) % 2, 1, 'N=' + N + ' k=' + r.k + ' 奇数在前');
      assert.strictEqual(Math.abs(r.face2.right - r.face1.left), 1, 'N=' + N + ' k=' + r.k + ' 左半张');
      assert.strictEqual(Math.min(r.face2.right, r.face1.left) % 2, 1, 'N=' + N + ' k=' + r.k + ' 奇数在前');
    });
  }
});

test('G2-6 独立物理折纸-套叠模型读出的页序正好是 1…N（4…120 页）', () => {
  for (let N = 4; N <= 120; N += 4) {
    const rows = C.imposeSignature(N);
    assert.deepStrictEqual(oracleReadOrder(rows, 'lr'), seq(N), 'N=' + N);
  }
});

test('G2-7 负向自检：把第 2 面左右互换后，物理模型读出乱序（证明模型有判别力）', () => {
  for (const N of [4, 8, 16, 32]) {
    const rows = C.imposeSignature(N).map((r) => ({
      k: r.k, m: r.m,
      face1: { left: { rel: r.face1.left }, right: { rel: r.face1.right } },
      face2: { left: { rel: r.face2.right }, right: { rel: r.face2.left } }   // 故意互换
    }));
    assert.notDeepStrictEqual(oracleReadOrder(rows, 'lr'), seq(N), 'N=' + N + ' 互换后应读出乱序');
  }
});

test('G2-8 负向自检：翻面方式用错（上下翻转）会让内页跨页左右颠倒', () => {
  const rows = C.imposeSignature(4).map((r) => ({
    k: r.k, m: r.m,
    face1: { left: { rel: r.face1.left }, right: { rel: r.face1.right } },
    face2: { left: { rel: r.face2.left }, right: { rel: r.face2.right } }
  }));
  assert.deepStrictEqual(oracleReadOrder(rows, 'lr'), [1, 2, 3, 4], '要求的翻面方式应正确');
  assert.deepStrictEqual(oracleReadOrder(rows, 'tb'), [1, 3, 2, 4], '上下翻转会让封面叶子变成 {1,3}、内页跨页左右颠倒');
});

test('G2-9 多帖时逐帖独立成立，且全局页码按帖首顺接', () => {
  const r = resOf({ pages: '100', perSig: '32' });
  assert.deepStrictEqual(r.signatures.map((s) => s.size), [28, 24, 24, 24]);
  let expectStart = 1;
  r.signatures.forEach((sig) => {
    assert.strictEqual(sig.start, expectStart, '帖 ' + sig.index + ' 起始页');
    assert.strictEqual(sig.end, expectStart + sig.size - 1, '帖 ' + sig.index + ' 结束页');
    assert.strictEqual(sig.size % 4, 0);
    assert.ok(sig.size <= 32, '帖 ' + sig.index + ' 不超上限');
    // 帖内相对页码物理模型自检
    const rows = sig.rows.map((x) => ({ k: x.k, m: x.m, face1: x.face1, face2: x.face2 }));
    assert.deepStrictEqual(oracleReadOrder(rows, 'lr'), seq(sig.size), '帖 ' + sig.index + ' 页序');
    expectStart = sig.end + 1;
  });
  assert.strictEqual(expectStart - 1, r.padded);
});

/* ═══ G3 分帖划分：与暴力枚举对拍 ═══════════════════════════════════ */

function bruteSplit(total, cap) {
  let best = null;
  const rec = (rest, acc) => {
    if (rest === 0) {
      if (C.partsBetter(acc, best)) best = acc.slice();
      return;
    }
    const lo = Math.max(1, rest - (Math.ceil(rest / cap) - 1) * cap);
    for (let p = lo; p <= Math.min(cap, rest); p++) { acc.push(p); rec(rest - p, acc); acc.pop(); }
  };
  rec(total, []);
  return best;
}

test('G3-1 分帖划分与暴力枚举对拍（张数 1…12、上限 1…6，共 72 组）', () => {
  for (let total = 1; total <= 12; total++) {
    for (let cap = 1; cap <= 6; cap++) {
      const got = C.splitSignatures(total, cap);
      const want = bruteSplit(total, cap);
      assert.deepStrictEqual(got, want, 'total=' + total + ' cap=' + cap);
    }
  }
});

test('G3-2 分帖结果的三条性质：帖数最少、每帖不超上限、和相等且从大到小', () => {
  const rnd = mulberry32(20261110);
  for (let i = 0; i < 300; i++) {
    const total = 1 + Math.floor(rnd() * 60);
    const cap = 1 + Math.floor(rnd() * 12);
    const parts = C.splitSignatures(total, cap);
    assert.strictEqual(parts.reduce((a, b) => a + b, 0), total, 'total=' + total + ' cap=' + cap + ' 求和');
    assert.strictEqual(parts.length, Math.ceil(total / cap), 'total=' + total + ' cap=' + cap + ' 帖数最少');
    parts.forEach((p) => {
      assert.ok(p >= 1 && p <= cap, '每帖 1…cap：' + p);
    });
    for (let j = 1; j < parts.length; j++) assert.ok(parts[j - 1] >= parts[j], '应从大到小：' + parts.join('/'));
    assert.ok(Math.max(...parts) - Math.min(...parts) <= 1, '摊得最平：' + parts.join('/'));
  }
});

test('G3-3 页数不超过上限时只有一帖', () => {
  assert.deepStrictEqual(C.splitSignatures(5, 8), [5]);
  assert.deepStrictEqual(C.splitSignatures(1, 1), [1]);
  assert.deepStrictEqual(C.splitSignatures(0, 8), []);
});

test('G3-4 每帖上限取到极值时仍可用（8 页上限 / 200 页上限）', () => {
  const r1 = resOf({ pages: '100', perSig: '8' });
  assert.strictEqual(r1.signatureCount, 13, '25 张纸按每帖 2 张切 = 13 帖');
  assert.deepStrictEqual(r1.signatures.map((s) => s.size), [8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 4]);
  r1.signatures.forEach((s) => assert.ok(s.size <= 8 && s.size % 4 === 0));
  const r2 = resOf({ pages: '100', perSig: '200' });
  assert.strictEqual(r2.signatureCount, 1);
  assert.strictEqual(r2.signatures[0].size, 100);
});

/* ═══ G4 空白页与补齐 ═══════════════════════════════════════════════ */

test('G4-1 骑马钉补齐到 4 的倍数：19→20、21→24、400→400', () => {
  assert.strictEqual(resOf({ pages: '19' }).padded, 20);
  assert.strictEqual(resOf({ pages: '19' }).blanks, 1);
  assert.strictEqual(resOf({ pages: '21' }).padded, 24);
  assert.strictEqual(resOf({ pages: '21' }).blanks, 3);
  assert.strictEqual(resOf({ pages: '400' }).padded, 400);
  assert.strictEqual(resOf({ pages: '400' }).blanks, 0);
});

test('G4-2 空白页落在页码末尾，且拼版表里恰好出现 blanks 次', () => {
  for (const P of [5, 17, 19, 30, 97]) {
    const r = resOf({ pages: String(P) });
    assert.deepStrictEqual(r.blankPages, seq(r.padded).slice(P), 'P=' + P + ' 空白页清单');
    const cells = r.sheets.flatMap((s) => [s.face1.left, s.face1.right, s.face2.left, s.face2.right]);
    const blanks = cells.filter((c) => c.blank);
    assert.strictEqual(blanks.length, r.blanks, 'P=' + P + ' 空白格数');
    blanks.forEach((c) => assert.ok(c.g > P && c.g <= r.padded, '空白格的全局页码应在 P+1…P′：' + c.g));
  }
});

test('G4-3 有空白页时物理模型仍读出连续页序 1…N（空白占位不错位）', () => {
  for (const P of [5, 17, 19, 30]) {
    const r = resOf({ pages: String(P) });
    r.signatures.forEach((sig) => {
      const rows = sig.rows.map((x) => ({ k: x.k, m: x.m, face1: x.face1, face2: x.face2 }));
      assert.deepStrictEqual(oracleReadOrder(rows, 'lr'), seq(sig.size), 'P=' + P + ' 帖 ' + sig.index);
    });
  }
});

/* ═══ G5 爬移线性模型 ═══════════════════════════════════════════════ */

test('G5-1 爬移：最外一张 0、最内一张 (m−1)L、逐张单调不减', () => {
  const r = resOf({ pages: '60', thickness: '0.20', perSig: '64' });
  const m = r.sheetCount;
  assert.strictEqual(m, 15);
  assert.strictEqual(r.creep.L, 0.4);
  assert.strictEqual(r.sheets[0].shift, 0);
  assert.strictEqual(r.sheets[m - 1].shift, Math.round((m - 1) * 0.4 * 1000) / 1000);
  for (let i = 1; i < m; i++) assert.ok(r.sheets[i].shift >= r.sheets[i - 1].shift, '第 ' + (i + 1) + ' 张内移不应变小');
  assert.strictEqual(r.trimAll, r.sheets[m - 1].shift);
});

test('G5-2 对纸张厚度线性：厚度翻倍 → 内移与裁切量翻倍', () => {
  const a = resOf({ pages: '40', thickness: '0.10', perSig: '64' });
  const b = resOf({ pages: '40', thickness: '0.20', perSig: '64' });
  assert.strictEqual(b.creep.L, a.creep.L * 2);
  assert.strictEqual(b.maxShiftAll, a.maxShiftAll * 2);
  assert.strictEqual(b.trimAll, a.trimAll * 2);
});

test('G5-3 层厚系数 1 / 2 与关闭补偿', () => {
  const one = resOf({ pages: '40', thickness: '0.10', layer: 1, perSig: '64' });
  const two = resOf({ pages: '40', thickness: '0.10', layer: 2, perSig: '64' });
  assert.strictEqual(one.creep.L, 0.1);
  assert.strictEqual(two.creep.L, 0.2);
  assert.strictEqual(two.maxShiftAll, one.maxShiftAll * 2);
  const off = resOf({ pages: '40', thickness: '0.10', layer: 2, creep: false, perSig: '64' });
  assert.ok(off.sheets.every((s) => s.shift === 0), '关闭补偿后所有内移为 0');
  assert.strictEqual(off.maxShiftAll, 0);
  // 关闭补偿只是不挪内容；前口突出量与需要的裁切量是物理后果，仍应如实报出
  assert.strictEqual(off.trimAll, two.maxShiftAll, '不补偿时仍要报告裁切量');
  assert.strictEqual(off.creep.protrude, two.maxShiftAll, '仍应报告不补偿时的突出量');
});

test('G5-4 书脊厚度 = 张数 × 层厚；单张纸时裁切量为 0', () => {
  const r = resOf({ pages: '20', thickness: '0.10', perSig: '32' });
  assert.strictEqual(r.creep.spine, 5 * 0.2);
  assert.strictEqual(r.spine, 1);
  const one = resOf({ pages: '4' });
  assert.strictEqual(one.sheetCount, 1);
  assert.strictEqual(one.trimAll, 0);
  assert.strictEqual(one.creep.spine, 0.2);
});

test('G5-5 逐帖各自算爬移：越往前（页数多的帖）内移越大', () => {
  const r = resOf({ pages: '100', perSig: '32' });
  const perSig = r.signatures.map((s) => s.creep.maxShift);
  assert.deepStrictEqual(perSig, [6 * 0.2, 5 * 0.2, 5 * 0.2, 5 * 0.2].map((v) => Math.round(v * 1000) / 1000));
  assert.strictEqual(r.maxShiftAll, 1.2, '整体按最厚一帖（7 张）算：6×0.2');
});

/* ═══ G6 装订方式对照与顺序拼版 ═════════════════════════════════════ */

test('G6-1 三种装订方式的页数步长、张数、书脊与能否平摊', () => {
  const r = resOf({ pages: '21' });
  const byKey = {};
  r.bindingRows.forEach((b) => { byKey[b.key] = b; });
  assert.strictEqual(byKey.saddle.padded, 24, '骑马钉补齐到 24');
  assert.strictEqual(byKey.saddle.sheets, 6);
  assert.strictEqual(byKey.perfect.padded, 22, '胶装补齐到偶数');
  assert.strictEqual(byKey.perfect.sheets, 11);
  assert.strictEqual(byKey.coil.padded, 22);
  assert.strictEqual(byKey.saddle.flat, true);
  assert.strictEqual(byKey.perfect.flat, false);
  assert.strictEqual(byKey.coil.flat, true);
  assert.strictEqual(byKey.saddle.foldable, true);
  assert.strictEqual(byKey.perfect.foldable, false);
  assert.strictEqual(byKey.saddle.current, true);
  assert.strictEqual(byKey.perfect.current, false);
});

test('G6-2 胶装 / 圈装：每面 1 页、顺序双面，读出页序正好是 1…P′', () => {
  for (const b of ['perfect', 'coil']) {
    for (const P of [7, 21, 50, 99]) {
      const r = resOf({ pages: String(P), binding: b });
      const got = r.sheets.map((s) => s.face1.left.rel).concat([]);
      const pairs = r.sheets.map((s) => [s.face1.left.rel, s.face2.left.rel]);
      const flat = [];
      pairs.forEach((p) => flat.push(p[0], p[1]));
      assert.deepStrictEqual(flat, seq(r.padded), b + ' P=' + P + ' 顺序');
      assert.strictEqual(got.length, r.sheetCount, b + ' 张数');
    }
  }
});

test('G6-3 胶装书脊 = 张数 × 纸厚；骑马钉书脊 = 张数 × 层厚', () => {
  const p = resOf({ pages: '50', binding: 'perfect', thickness: '0.10' });
  assert.strictEqual(p.sheetCount, 25);
  assert.strictEqual(p.spine, 2.5);
  assert.strictEqual(p.creep, null, '胶装没有折手，不存在爬移');
  const s = resOf({ pages: '52', binding: 'saddle', thickness: '0.10', layer: 2, perSig: '64' });
  assert.strictEqual(s.sheetCount, 13);
  assert.strictEqual(s.spine, 2.6);
});

test('G6-4 需求简报里的内置场景锚点全部复算一致', () => {
  const expect = {
    s1: { sheets: 5, sigs: 1, blanks: 0, maxShift: 0.8, trim: 0.8, cost: 2.5 },
    s2: { sheets: 5, sigs: 1, blanks: 1, maxShift: 0.8, trim: 0.8, cost: 2.5 },
    s3: { sheets: 25, sigs: 4, blanks: 0, maxShift: 1.2, trim: 1.2, cost: 12.5 },
    s4: { sheets: 15, sigs: 1, blanks: 0, maxShift: 5.6, trim: 5.6, cost: 7.5 },
    s5: { sheets: 8, sigs: 1, blanks: 0, maxShift: 1.68, trim: 1.68, cost: 9.6 },
    s6: { sheets: 25, sigs: 1, blanks: 0, maxShift: 0, trim: 0, cost: 12.5 }
  };
  C.scenarios.forEach((sc) => {
    const r = resOf(sc.input);
    const e = expect[sc.key];
    assert.ok(e, '场景应有锚点：' + sc.key);
    assert.strictEqual(r.sheetCount, e.sheets, sc.key + ' 张数');
    assert.strictEqual(r.signatureCount, e.sigs, sc.key + ' 帖数');
    assert.strictEqual(r.blanks, e.blanks, sc.key + ' 空白页');
    assert.strictEqual(r.maxShiftAll, e.maxShift, sc.key + ' 最内内移');
    assert.strictEqual(r.trimAll, e.trim, sc.key + ' 裁切量');
    assert.strictEqual(r.cost, e.cost, sc.key + ' 成本');
    assert.ok(C.verify(r).allOk, sc.key + ' 结构自检');
  });
});

/* ═══ G7 尺寸与成本 ═════════════════════════════════════════════════ */

test('G7-1 纸张规格与成品尺寸（对折后 = 宽的一半 × 原高）', () => {
  const cases = [['A4', 148.5, 210], ['A3', 210, 297], ['B5', 125, 176], ['Letter', 139.7, 215.9]];
  cases.forEach(([key, w, h]) => {
    const r = resOf({ paper: key, pages: '20' });
    assert.deepStrictEqual({ w: r.finish.w, h: r.finish.h }, { w: w, h: h }, key);
  });
});

test('G7-2 成本 = 张数 × 单价，保留 2 位；单价 0 时为 0', () => {
  assert.strictEqual(resOf({ pages: '100', sheetPrice: '0.35' }).cost, 8.75);
  assert.strictEqual(resOf({ pages: '100', sheetPrice: '0' }).cost, 0);
  assert.strictEqual(resOf({ pages: '19', sheetPrice: '1.2' }).cost, 6);
});

/* ═══ G8 输出契约、自检与敏感性 ═════════════════════════════════════ */

function scanBad(obj, path, bad) {
  if (obj === null || obj === undefined) { if (obj === undefined) bad.push(path + ' = undefined'); return; }
  if (typeof obj === 'number') {
    if (!Number.isFinite(obj)) bad.push(path + ' = ' + obj);
    return;
  }
  if (typeof obj === 'function') return;
  if (typeof obj === 'object') {
    Object.keys(obj).forEach((k) => scanBad(obj[k], path + '.' + k, bad));
  }
}

test('G8-1 输出对象递归无 undefined / NaN / Infinity（各场景与各装订方式）', () => {
  const inputs = C.scenarios.map((s) => s.input).concat([
    { pages: '1' }, { pages: '400', perSig: '8' }, { pages: '97', binding: 'coil' },
    { pages: '3', binding: 'perfect' }, { pages: '1', paper: 'custom', customW: '50', customH: '50' }
  ]);
  inputs.forEach((input) => {
    const r = resOf(input);
    const bad = [];
    scanBad(r, 'res', bad);
    assert.deepStrictEqual(bad, [], JSON.stringify(input) + ' 输出不干净：' + bad.slice(0, 5).join('；'));
  });
});

test('G8-2 确定性：同输入两次分析逐字节一致，且不修改入参', () => {
  const input = { pages: '57', paper: 'A3', thickness: '0.13', perSig: '24', binding: 'saddle', creep: true, layer: 2, sheetPrice: '0.8' };
  const snapshot = JSON.stringify(input);
  const a = C.analyze(cfgOf(input));
  const b = C.analyze(cfgOf(input));
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  assert.strictEqual(JSON.stringify(input), snapshot, 'analyze 不应修改传入对象');
});

test('G8-3 verify() 的结构自检在 4…200 页、三种装订下全部通过', () => {
  for (let P = 4; P <= 200; P += 7) {
    for (const binding of ['saddle', 'perfect', 'coil']) {
      const r = resOf({ pages: String(P), binding: binding, perSig: '32' });
      const v = C.verify(r);
      assert.ok(v.allOk, 'P=' + P + ' ' + binding + ' 未通过：' +
        v.checks.filter((c) => !c.ok).map((c) => c.name + '(' + c.detail + ')').join('；'));
    }
  }
});

test('G8-4 打印清单与建议随情形变化，且建议里的数字能从结果复算', () => {
  const r = resOf({ pages: '100', perSig: '32' });
  assert.ok(r.checklist.length >= 4, '清单条数');
  assert.ok(r.checklist.some((t) => t.includes('对折')), '应有对折自检条目');
  const adviceText = r.advice.map((a) => a.text).join(' ');
  assert.ok(adviceText.includes('4 帖'), '应提示分帖，实际：' + adviceText);
  assert.ok(adviceText.includes('28 / 24 / 24 / 24'), '应写出各帖页数');
  const r19 = resOf({ pages: '19' });
  assert.ok(r19.advice.some((a) => a.text.includes('1 页是空白')), '应提示空白页');
  const rBig = resOf({ pages: '60', thickness: '0.20', perSig: '64' });
  assert.ok(rBig.advice.some((a) => a.text.includes('5.60')), '厚纸应提示内移量');
});

test('G8-5 敏感性：行数与内容可复算（厚纸 → 内移更大；换装订 → 无爬移）', () => {
  const rows = C.sensitivity({ pages: '60', thickness: '0.10', perSig: '32', binding: 'saddle' });
  assert.ok(rows.length >= 6, '敏感性行数：' + rows.length);
  rows.forEach((r) => assert.ok(r.value && r.value.length > 0, '每行都要有值：' + r.label));
  const base = rows.find((r) => r.label === '当前设置');
  const thick = rows.find((r) => r.label.includes('+20%'));
  const thin = rows.find((r) => r.label.includes('−20%'));
  assert.ok(base && thick && thin);
  assert.ok(thick.res.maxShiftAll > base.res.maxShiftAll, '厚纸内移应更大');
  assert.ok(thin.res.maxShiftAll < base.res.maxShiftAll, '薄纸内移应更小');
  const perfect = rows.find((r) => r.label.includes('胶装'));
  assert.strictEqual(perfect.res.creep, null, '胶装不该有爬移');
  assert.ok(perfect.value.includes('张'), '胶装行应给出张数');
});

test('G8-6 敏感性遇到非法派生输入时给出「不适用」而不是抛错', () => {
  const rows = C.sensitivity({ pages: '400', perSig: '8', binding: 'saddle' });
  rows.forEach((r) => assert.ok(typeof r.value === 'string' && r.value.length > 0));
  const rows2 = C.sensitivity({ pages: '1', thickness: '0.02', binding: 'perfect' });
  assert.ok(rows2.length >= 4);
  assert.ok(rows2.some((r) => r.label.includes('骑马钉')), '应能对照骑马钉');
});
