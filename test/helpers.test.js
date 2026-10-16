'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./loader');

const k = load({
  vars: ['PT_PER_MM', 'SIZE_PRESET_MM', 'CHECK_META'],
  functions: [
    'mm2pt', 'pt2mm', 'fmt', 'pad2', 'joinArr', 'escapeHtml', 'escapeCsv',
    'defaultConfig', 'getCheckIdOrder', 'serializeConfig', 'parseConfig',
  ],
});

test('mm2pt / pt2mm: A4 の幅 210mm は 595.28pt で、往復しても戻る', () => {
  assert.ok(Math.abs(k.mm2pt(210) - 595.2756) < 0.001);
  assert.ok(Math.abs(k.pt2mm(k.mm2pt(123.4)) - 123.4) < 1e-9);
});

test('fmt: 未定義・NaN は "-"、桁数の既定は 2', () => {
  assert.equal(k.fmt(undefined), '-');
  assert.equal(k.fmt(null), '-');
  assert.equal(k.fmt(NaN), '-');
  assert.equal(k.fmt(1.005 * 100), '100.50');
  assert.equal(k.fmt(3.14159, 3), '3.142');
  assert.equal(k.fmt(7, 0), '7');
});

test('pad2: 2桁にそろえる', () => {
  assert.equal(k.pad2(5), '05');
  assert.equal(k.pad2(12), '12');
  assert.equal(k.pad2(9.9), '09');
});

test('joinArr: 区切りで連結する', () => {
  assert.equal(k.joinArr(['a', 'b', 'c'], ', '), 'a, b, c');
  assert.equal(k.joinArr([], ','), '');
});

test('escapeHtml: & < > " をエスケープする(先に & を処理して二重にしない)', () => {
  assert.equal(k.escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.equal(k.escapeHtml(undefined), '');
  assert.equal(k.escapeHtml(null), '');
  assert.equal(k.escapeHtml(0), '0');
});

test('escapeCsv: カンマ・引用符・改行を含むときだけ引用符で囲み、引用符を二重にする', () => {
  assert.equal(k.escapeCsv('plain'), 'plain');
  assert.equal(k.escapeCsv('a,b'), '"a,b"');
  assert.equal(k.escapeCsv('say "hi"'), '"say ""hi"""');
  assert.equal(k.escapeCsv('line1\nline2'), '"line1\nline2"');
  assert.equal(k.escapeCsv('a\rb'), '"a\rb"');
  assert.equal(k.escapeCsv(undefined), '');
});

test('escapeCsv: = + - @ やタブで始まる値は、数式として評価されないよう先頭に「\'」を付ける', () => {
  assert.equal(k.escapeCsv('=1+1'), "'=1+1");
  assert.equal(k.escapeCsv('+81-3'), "'+81-3");
  assert.equal(k.escapeCsv('-5'), "'-5");
  assert.equal(k.escapeCsv('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(k.escapeCsv('\tcmd'), "'\tcmd");
  // 先頭以外にあっても無害なので、そのまま
  assert.equal(k.escapeCsv('a=b'), 'a=b');
  // 無害化したうえで、カンマを含めば従来どおり引用符で囲む
  assert.equal(k.escapeCsv('=a,b'), "\"'=a,b\"");
});

test('チェック項目: 25件で、重複がなく、設定の既定値・解説(CHECK_META)と過不足なく対応する', () => {
  const ids = k.getCheckIdOrder();
  assert.equal(ids.length, 25);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(Object.keys(k.defaultConfig().checks).sort(), [...ids].sort());
  for (const id of ids) assert.ok(k.CHECK_META[id], `CHECK_META に ${id} がありません`);
  assert.deepEqual(Object.keys(k.CHECK_META).sort(), [...ids].sort());
});

test('サイズのプリセット: A4 は 210x297mm', () => {
  assert.deepEqual(Array.from(k.SIZE_PRESET_MM.A4), [210, 297]);
  assert.equal(k.SIZE_PRESET_MM.CUSTOM, null);
});

test('設定: シリアライズして読み戻すと元に戻る', () => {
  const cfg = k.defaultConfig();
  cfg.sizeKey = 'B5';
  cfg.bleedMM = 4.5;
  cfg.maxInkPercent = 350;
  cfg.expectedSpotCount = 2;
  cfg.checks.tombo = false;
  cfg.checks.overprint = false;

  const restored = k.parseConfig(k.serializeConfig(cfg), k.defaultConfig());
  assert.deepEqual(JSON.parse(JSON.stringify(restored)), JSON.parse(JSON.stringify(cfg)));
});

test('設定: 空行・不明なキー・=のない行は無視し、行頭末の空白は除いて読む(既定値を壊さない)', () => {
  const base = k.defaultConfig();
  const cfg = k.parseConfig('\n unknown=1\nnoequals\n  bleedMM=2 \n', base);
  assert.equal(cfg.bleedMM, 2);
  assert.equal(cfg.sizeKey, 'A4');
  assert.equal(cfg.checks.tombo, true);
});

test('設定: 保存形式は key=value を改行で連結する', () => {
  const text = k.serializeConfig(k.defaultConfig());
  assert.ok(text.startsWith('sizeKey=A4\n'));
  assert.match(text, /\nchecks=size_match:1,bleed:1,/);
});
