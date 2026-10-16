'use strict';
// v1.43.0 で追加した機能(除外レイヤー・前回との比較・プリセット名・一括検版)の、
// 純粋な補助関数のテスト。Illustrator のオブジェクトに触る部分は、実機で別途確認している。
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./loader');

const k = load({
  vars: ['CHECK_META', 'KENPAN_VERSION', 'SIZE_PRESET_KEYS', 'COLOR_MODE_KEYS'],
  functions: [
    'pad2', 'nowString', 'joinArr', 'escapeCsv', 'statusLabelOf',
    'parseNameList', 'isIgnoredName', 'sanitizePresetName',
    'detectionKeys', 'compareDetections', 'hashString', 'batchOverall', 'buildBatchCsv',
    'defaultConfig', 'serializeConfig', 'parseConfig', 'getCheckIdOrder',
  ],
});
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---- 除外レイヤー ----
test('parseNameList: カンマ・読点・改行で区切り、前後の空白と空要素を除く', () => {
  assert.deepEqual(plain(k.parseNameList('メモ, ガイド、 版下\r\n寸法線,,')), ['メモ', 'ガイド', '版下', '寸法線']);
  assert.deepEqual(plain(k.parseNameList('')), []);
  assert.deepEqual(plain(k.parseNameList(undefined)), []);
  assert.deepEqual(plain(k.parseNameList(' , ')), []);
});

test('isIgnoredName: 完全一致(大文字小文字は区別しない)。部分一致はしない', () => {
  const list = ['メモ', 'Guide'];
  assert.equal(k.isIgnoredName('メモ', list), true);
  assert.equal(k.isIgnoredName('guide', list), true);
  assert.equal(k.isIgnoredName('メモ2', list), false);
  assert.equal(k.isIgnoredName('', list), false);
  assert.equal(k.isIgnoredName('メモ', []), false);
  assert.equal(k.isIgnoredName('メモ', null), false);
});

test('設定: ignoreLayers は既定で空、保存して読み戻せる(改行はカンマになる)', () => {
  const d = k.defaultConfig();
  assert.equal(d.ignoreLayers, '');
  const c = k.defaultConfig();
  c.ignoreLayers = 'メモ\nガイド,寸法';
  const text = k.serializeConfig(c);
  const back = k.parseConfig(text, k.defaultConfig());
  assert.equal(back.ignoreLayers, 'メモ,ガイド,寸法');
  assert.deepEqual(plain(k.parseNameList(back.ignoreLayers)), ['メモ', 'ガイド', '寸法']);
});

test('設定: ignoreLayers が無い古い設定ファイルでも読める(空になる)', () => {
  const back = k.parseConfig('bleedMM=5\n', k.defaultConfig());
  assert.equal(back.bleedMM, 5);
  assert.equal(back.ignoreLayers, '');
});

// ---- プリセット名 ----
test('sanitizePresetName: ファイル名に使えない文字を置き換え、空・先頭ドットを防ぐ', () => {
  assert.equal(k.sanitizePresetName('○○印刷 オフセット'), '○○印刷 オフセット');
  assert.equal(k.sanitizePresetName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(k.sanitizePresetName('  .hidden  '), 'hidden');
  assert.equal(k.sanitizePresetName('   '), '');
  assert.equal(k.sanitizePresetName(null), '');
  assert.equal(k.sanitizePresetName('x'.repeat(100)).length, 60);
});

// ---- 前回との比較 ----
const res = (id, status, texts) => ({ id, status, details: texts.map((t) => ({ text: t })) });

test('detectionKeys: エラー・警告・情報だけを、検出1件ごとのキーにする', () => {
  const keys = plain(k.detectionKeys([
    res('a', 'NG', ['x', 'y']),
    res('b', 'OK', []),
    res('c', 'WARN', []),
    res('d', 'SKIP', ['z']),
    res('e', 'INFO', ['line1\nline2']),
  ]));
  assert.deepEqual(keys, ['a\tx', 'a\ty', 'c\t(WARN)', 'e\tline1 line2']);
});

test('compareDetections: 新規・解消・変わらずを数える', () => {
  const r = plain(k.compareDetections(['a\tx', 'a\ty', 'b\tz'], ['a\tx', 'b\tz', 'c\tnew']));
  assert.deepEqual(r.added, ['c\tnew']);
  assert.deepEqual(r.resolved, ['a\ty']);
  assert.equal(r.same, 2);
});

test('compareDetections: 空同士・全部入れ替わり', () => {
  assert.deepEqual(plain(k.compareDetections([], [])), { added: [], resolved: [], same: 0 });
  const r = plain(k.compareDetections(['a'], ['b']));
  assert.deepEqual(r.added, ['b']);
  assert.deepEqual(r.resolved, ['a']);
  assert.equal(r.same, 0);
});

test('hashString: 同じ入力は同じ値、違う入力は(通常)違う値', () => {
  assert.equal(k.hashString('C:\\a\\b.ai'), k.hashString('C:\\a\\b.ai'));
  assert.notEqual(k.hashString('C:\\a\\b.ai'), k.hashString('C:\\a\\c.ai'));
  assert.match(k.hashString('abc'), /^[0-9a-f]+$/);
});

// ---- 一括検版 ----
test('batchOverall: エラー > 警告 > OK の順に判定', () => {
  assert.equal(k.batchOverall({ ngCount: 1, warnCount: 5, infoCount: 0 }), 'エラーあり');
  assert.equal(k.batchOverall({ ngCount: 0, warnCount: 1, infoCount: 0 }), '警告あり');
  assert.equal(k.batchOverall({ ngCount: 0, warnCount: 0, infoCount: 9 }), 'OK');
});

test('buildBatchCsv: ファイルごとに1行、項目ごとの判定列、検版できなかった行', () => {
  const ids = k.getCheckIdOrder().slice(0, 2);
  const rows = [
    { name: 'a.ai', error: '', summary: { ngCount: 0, warnCount: 2, infoCount: 1 }, statuses: { [ids[0]]: 'OK', [ids[1]]: 'WARN' } },
    { name: 'b,c.ai', error: 'ファイルが壊れています', summary: null, statuses: {} },
  ];
  const csv = k.buildBatchCsv(rows, ids);
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 4); // メタ行 + 見出し + 2行
  assert.match(lines[0], /一括検版/);
  assert.ok(lines[1].startsWith('ファイル名,総合判定,エラー,警告,情報,'));
  assert.equal(lines[2], 'a.ai,警告あり,0,2,1,OK,警告');
  // カンマを含むファイル名は引用符で囲まれ、検版できなかった行は理由が入る
  assert.ok(lines[3].startsWith('"b,c.ai",検版できませんでした: ファイルが壊れています,'));
});
