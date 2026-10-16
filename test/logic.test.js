'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./loader');

const k = load({
  vars: ['PT_PER_MM', 'SIZE_PRESET_MM', 'CHECK_META', 'KENPAN_VERSION'],
  functions: [
    'safe', 'mm2pt', 'pt2mm', 'pad2', 'nowString', 'joinArr', 'escapeCsv',
    'colorTypeName', 'isWhiteColor', 'cmykInkTotal',
    'getTargetSizeMM', 'rectWmm', 'rectHmm', 'sizeMatches', 'centerInside',
    'matrixScale', 'calcRasterEffectiveDPI', 'calcPlacedEffectiveDPI',
    'makeResult', 'statusLabelOf', 'detailItem', 'summarizeResults', 'buildCsvReport',
    'truncateForProgress', 'estimateTextBoxHeight',
  ],
});

// vm 内で作られたオブジェクトは Node 側と prototype が違い deepEqual が通らないので、JSON を経由して比べる
const plain = (v) => JSON.parse(JSON.stringify(v));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

const cmyk = (c, m, y, kk) => ({ typename: 'CMYKColor', cyan: c, magenta: m, yellow: y, black: kk });
const rgb = (r, g, b) => ({ typename: 'RGBColor', red: r, green: g, blue: b });
const gray = (g) => ({ typename: 'GrayColor', gray: g });
const spot = (alt, tint) => ({ typename: 'SpotColor', tint, spot: { color: alt } });

// ---- 色 ----

test('cmykInkTotal: CMYK は4色の合計', () => {
  assert.equal(k.cmykInkTotal(cmyk(100, 50, 30, 20)), 200);
  assert.equal(k.cmykInkTotal(cmyk(100, 100, 100, 100)), 400);
  assert.equal(k.cmykInkTotal(cmyk(0, 0, 0, 0)), 0);
});

test('cmykInkTotal: 特色は代替色 × 濃度で近似する', () => {
  assert.equal(k.cmykInkTotal(spot(cmyk(100, 100, 0, 0), 50)), 100);
  assert.equal(k.cmykInkTotal(spot(cmyk(100, 100, 0, 0), 100)), 200);
  assert.equal(k.cmykInkTotal(spot(cmyk(100, 100, 0, 0), 0)), 0);
});

test('cmykInkTotal: CMYK でも特色でもなければ null(RGB・グレー・なし・代替色が CMYK でない特色)', () => {
  assert.equal(k.cmykInkTotal(rgb(0, 0, 0)), null);
  assert.equal(k.cmykInkTotal(gray(50)), null);
  assert.equal(k.cmykInkTotal(null), null);
  assert.equal(k.cmykInkTotal(spot(rgb(1, 2, 3), 100)), null);
});

test('isWhiteColor: CMYK 全0・RGB 全255・グレー0 が白。それ以外は白でない', () => {
  assert.equal(k.isWhiteColor(cmyk(0, 0, 0, 0)), true);
  assert.equal(k.isWhiteColor(cmyk(0, 0, 0, 10)), false);
  assert.equal(k.isWhiteColor(rgb(255, 255, 255)), true);
  assert.equal(k.isWhiteColor(rgb(255, 255, 250)), false);
  assert.equal(k.isWhiteColor(gray(0)), true);
  assert.equal(k.isWhiteColor(gray(30)), false);
  assert.equal(k.isWhiteColor(spot(cmyk(0, 0, 0, 0), 100)), false);   // 特色は白とみなさない
  assert.equal(k.isWhiteColor(null), false);
});

// ---- サイズ・位置 ----

test('getTargetSizeMM: プリセット・カスタム・未知のキー', () => {
  assert.deepEqual(plain(k.getTargetSizeMM({ sizeKey: 'A4', customWidthMM: 1, customHeightMM: 2 })), [210, 297]);
  assert.deepEqual(plain(k.getTargetSizeMM({ sizeKey: 'CUSTOM', customWidthMM: 100, customHeightMM: 200 })), [100, 200]);
  assert.deepEqual(plain(k.getTargetSizeMM({ sizeKey: 'NOPE', customWidthMM: 7, customHeightMM: 8 })), [7, 8]);
});

test('矩形の寸法(mm): [左, 上, 右, 下] の pt から', () => {
  const a4 = [0, 841.8897637795276, 595.2755905511812, 0];
  near(k.rectWmm(a4), 210, 1e-6);
  near(k.rectHmm(a4), 297, 1e-6);
});

test('sizeMatches: 許容差の範囲内、縦横入れ替えも一致。範囲外は不一致', () => {
  assert.equal(k.sizeMatches(210, 297, 210, 297, 0.5), true);
  assert.equal(k.sizeMatches(210.4, 296.6, 210, 297, 0.5), true);
  assert.equal(k.sizeMatches(297, 210, 210, 297, 0.5), true);        // 横向き
  assert.equal(k.sizeMatches(210.6, 297, 210, 297, 0.5), false);
  assert.equal(k.sizeMatches(200, 297, 210, 297, 0.5), false);
});

test('centerInside: 中心が外側の矩形の中にあるか(境界を含む)', () => {
  const outer = [0, 100, 100, 0];
  assert.equal(k.centerInside([10, 90, 20, 80], outer), true);
  assert.equal(k.centerInside([90, 90, 130, 80], outer), false);     // 中心が右にはみ出す
  assert.equal(k.centerInside([-20, 50, 20, 10], outer), true);      // 中心(0,30)は境界上
  assert.equal(k.centerInside([200, 50, 220, 10], outer), false);
});

// ---- 実効解像度 ----

test('matrixScale: 拡大率(回転があっても長さは保たれる)', () => {
  assert.deepEqual(plain(k.matrixScale({ mValueA: 2, mValueB: 0, mValueC: 0, mValueD: 3 })), [2, 3]);
  const r = plain(k.matrixScale({ mValueA: 0, mValueB: 1, mValueC: -1, mValueD: 0 }));   // 90度回転
  near(r[0], 1); near(r[1], 1);
});

const identity = { mValueA: 1, mValueB: 0, mValueC: 0, mValueD: 1 };

test('calcPlacedEffectiveDPI: 72pt = 1インチに 300px なら 300dpi。拡大縮小に応じて変わる', () => {
  assert.equal(k.calcPlacedEffectiveDPI({ width: 72, height: 72, matrix: identity }, 300, 300), 300);
  assert.equal(k.calcPlacedEffectiveDPI({ width: 72, height: 72, matrix: { ...identity, mValueA: 0.5, mValueD: 0.5 } }, 300, 300), 600);
  assert.equal(k.calcPlacedEffectiveDPI({ width: 72, height: 72, matrix: { ...identity, mValueA: 2, mValueD: 2 } }, 300, 300), 150);
});

test('calcPlacedEffectiveDPI: 縦横で違うときは低いほう(厳しい側)を返す', () => {
  assert.equal(k.calcPlacedEffectiveDPI({ width: 72, height: 144, matrix: identity }, 300, 300), 150);
});

test('calcPlacedEffectiveDPI: 行列が無ければ等倍。大きさが 0 以下や異常なら null', () => {
  assert.equal(k.calcPlacedEffectiveDPI({ width: 72, height: 72 }, 300, 300), 300);
  assert.equal(k.calcPlacedEffectiveDPI({ width: 0, height: 72, matrix: identity }, 300, 300), null);
  assert.equal(k.calcPlacedEffectiveDPI(null, 300, 300), null);
});

test('calcRasterEffectiveDPI: 元のピクセル数が取れないので判定不能(誤ったOK/NGを出さない)', () => {
  assert.equal(k.calcRasterEffectiveDPI({}), null);
});

// ---- 結果とレポート ----

test('statusLabelOf: 判定の表示名', () => {
  assert.equal(k.statusLabelOf('OK'), 'OK');
  assert.equal(k.statusLabelOf('NG'), 'エラー');
  assert.equal(k.statusLabelOf('WARN'), '警告');
  assert.equal(k.statusLabelOf('INFO'), '情報');
  assert.equal(k.statusLabelOf('???'), '-');
});

test('makeResult: 項目の定義(カテゴリ・名前・解説)を引き継ぐ', () => {
  const r = plain(k.makeResult('size_match', 'NG', '概要', [k.detailItem('詳細', null)], '備考'));
  assert.equal(r.id, 'size_match');
  assert.equal(r.status, 'NG');
  assert.ok(r.category && r.name && r.advice);
  assert.deepEqual(r.details, [{ text: '詳細', item: null }]);
  assert.equal(r.note, '備考');
  assert.deepEqual(plain(k.makeResult('size_match', 'OK', 's')).details, []);
});

test('summarizeResults: 詳細の件数を数える(詳細が無い判定は1件)。エラーも警告も無ければ allOk', () => {
  const ok = k.makeResult('bleed', 'OK', 's');
  const ng = k.makeResult('size_match', 'NG', 's', [k.detailItem('a'), k.detailItem('b')]);
  const warn = k.makeResult('tombo', 'WARN', 's');
  const info = k.makeResult('overprint', 'INFO', 's', [k.detailItem('c')]);
  assert.deepEqual(plain(k.summarizeResults([ok, ng, warn, info])), { ngCount: 2, warnCount: 1, infoCount: 1, allOk: false });
  assert.deepEqual(plain(k.summarizeResults([ok, info])), { ngCount: 0, warnCount: 0, infoCount: 1, allOk: true });
  assert.deepEqual(plain(k.summarizeResults([])), { ngCount: 0, warnCount: 0, infoCount: 0, allOk: true });
});

test('buildCsvReport: 先頭にツール情報、見出し、1検出1行。CRLF 区切り', () => {
  const ng = k.makeResult('size_match', 'NG', '概要,カンマ', [k.detailItem('検出1', null), k.detailItem('検出2', null)], '');
  const ok = k.makeResult('bleed', 'OK', '問題なし');
  const csv = k.buildCsvReport({ name: 'a,b.ai' }, {}, [ng, ok]);
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 2 + 2 + 1);                       // メタ + 見出し + 検出2行 + OKの1行
  assert.ok(lines[0].startsWith('"# DigitalKenpan v' + k.KENPAN_VERSION));
  assert.ok(lines[0].includes('a,b.ai'));
  assert.ok(lines[1].startsWith('カテゴリ,項目,判定,概要,検出内容,原因と対応,備考'));
  assert.ok(lines[2].includes('エラー') && lines[2].includes('"概要,カンマ"') && lines[2].includes('検出1'));
  assert.ok(lines[3].includes('検出2'));
  assert.ok(lines[4].includes(',OK,') && lines[4].includes('問題なし'));
});

test('buildCsvReport: 検出内容が数式に見える文字で始まっても、数式として評価されない', () => {
  const r = k.makeResult('size_match', 'NG', 's', [k.detailItem('=HYPERLINK("http://evil")', null)]);
  const csv = k.buildCsvReport({ name: 'x.ai' }, {}, [r]);
  assert.ok(csv.includes('"\'=HYPERLINK(""http://evil"")"'), csv);
});

// ---- 表示まわりの補助 ----

test('truncateForProgress: 長いときだけ「先頭…末尾」に縮める(拡張子側を残す)', () => {
  assert.equal(k.truncateForProgress('short.ai', 40), 'short.ai');
  const long = 'とても長いファイル名の入稿データ_最終版_修正済み_コピー.ai';
  const out = k.truncateForProgress(long, 20);
  assert.equal(out.length, 20);
  assert.ok(out.includes('…') && out.endsWith(long.slice(-12)));
  assert.equal(k.truncateForProgress(undefined), '');
  assert.equal(k.truncateForProgress(null), '');
});

test('estimateTextBoxHeight: 文章が長いほど高くなり、最小・最大の行数で頭打ちになる', () => {
  const h = (text) => k.estimateTextBoxHeight(text, 340, 24, 2, 10);
  assert.ok(h('') >= h('') && h('あ'.repeat(200)) > h('あ'.repeat(20)));
  assert.equal(h(''), h('短い'));                                   // 最小行数(2行)で頭打ち
  assert.equal(h('あ'.repeat(5000)), h('あ'.repeat(50000)));        // 最大行数(10行)で頭打ち
  assert.equal(h('1行目\n2行目\n3行目') > h('1行目'), true);        // 明示的な改行も数える
  assert.ok(Number.isInteger(h('テキスト')));
});

test('estimateTextBoxHeight: 不正な引数でも落ちず、安全な既定値で見積もる', () => {
  assert.ok(k.estimateTextBoxHeight(undefined, undefined, undefined, undefined, undefined) > 0);
  assert.ok(k.estimateTextBoxHeight(null, 0, 0, 0, 0, -5, 0.5) > 0);
});
