'use strict';
// v1.42.0 で追加した検版項目の、判定の核(純粋な関数)と、登録の整合のテスト。
// DOM(Illustrator のオブジェクト)に触る部分は、実機の Illustrator で別途確認している。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { load } = require('./loader');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'DigitalKenpan.jsx'), 'utf8');

const k = load({
  vars: ['PT_PER_MM', 'CHECK_META'],
  functions: [
    'mm2pt', 'pt2mm', 'sizeMatches',
    'scaleDistortion', 'matrixSkew', 'linkNameIssues', 'linkLocationIssue', 'isPureBlackCMYK', 'sizeOutliers',
    'defaultConfig', 'getCheckIdOrder',
  ],
});
// vm 内で作られたオブジェクトは Node 側と prototype が違い deepEqual が通らないので、JSON を経由して比べる
const plain = (v) => JSON.parse(JSON.stringify(v));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

// ---- 画像の縦横比(歪み)----

test('scaleDistortion: 同じ倍率なら 0。差は大きいほうに対する割合', () => {
  assert.equal(k.scaleDistortion(1, 1), 0);
  assert.equal(k.scaleDistortion(0.5, 0.5), 0);
  near(k.scaleDistortion(1, 0.8), 0.2);
  near(k.scaleDistortion(0.8, 1), 0.2);     // 縦横を入れ替えても同じ
  near(k.scaleDistortion(0.3, 0.15), 0.5);
  assert.equal(k.scaleDistortion(0, 0), 0);  // 0 除算にならない
});

test('scaleDistortion: 1% 未満の差(丸め誤差)は許容の範囲', () => {
  assert.ok(k.scaleDistortion(1, 0.995) < 0.01);
  assert.ok(k.scaleDistortion(1, 0.98) > 0.01);
});

const m = (a, b, c, d) => ({ mValueA: a, mValueB: b, mValueC: c, mValueD: d });

test('matrixSkew: 回転・拡大縮小だけなら 0。斜めに引き伸ばすと 0 でなくなる', () => {
  assert.equal(k.matrixSkew(m(1, 0, 0, 1)), 0);
  assert.equal(k.matrixSkew(m(2, 0, 0, 3)), 0);
  const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
  near(k.matrixSkew(m(c30, s30, -s30, c30)), 0, 1e-12);      // 30度回転
  assert.ok(k.matrixSkew(m(1, 0, 0.5, 1)) > 0.3);            // せん断
  assert.equal(k.matrixSkew(m(0, 0, 0, 0)), 0);
});

// ---- リンク画像のファイル名・場所 ----

test('linkNameIssues: 半角英数字・ハイフン・アンダースコア・ドットは問題なし', () => {
  assert.deepEqual(plain(k.linkNameIssues('photo_01-final.v2.png')), []);
  assert.deepEqual(plain(k.linkNameIssues('')), []);
  assert.deepEqual(plain(k.linkNameIssues(undefined)), []);
});

test('linkNameIssues: 空白・全角・記号・先頭ドットをそれぞれ指摘する', () => {
  assert.deepEqual(plain(k.linkNameIssues('my photo.png')), ['空白を含む']);
  assert.deepEqual(plain(k.linkNameIssues('写真.png')), ['全角・日本語などASCII以外の文字を含む']);
  assert.equal(k.linkNameIssues('a&b.png').length, 1);
  assert.equal(k.linkNameIssues('50%off.png').length, 1);
  assert.deepEqual(plain(k.linkNameIssues('.hidden.png')), ['先頭がドット']);
  // 複数の問題は全部挙げる
  assert.equal(k.linkNameIssues('写真 #1.png').length, 3);
});

test('linkNameIssues: 全角の空白・全角の英数字も指摘する', () => {
  assert.equal(k.linkNameIssues('ａｂｃ.png').length, 1);
  assert.ok(k.linkNameIssues('a　b.png').length >= 1);
});

test('linkLocationIssue: 一時フォルダ・ダウンロード・デスクトップ・クラウド・ネットワーク・外付けを検出', () => {
  assert.equal(k.linkLocationIssue('C:\\Users\\a\\AppData\\Local\\Temp\\x\\p.png'), '一時フォルダ');
  assert.equal(k.linkLocationIssue('/tmp/p.png'), '一時フォルダ');
  assert.equal(k.linkLocationIssue('/private/var/folders/ab/cd/T/p.png'), '一時フォルダ');
  assert.equal(k.linkLocationIssue('C:\\Users\\a\\Downloads\\p.png'), 'ダウンロードフォルダ');
  assert.equal(k.linkLocationIssue('C:\\Users\\a\\Desktop\\p.png'), 'デスクトップ');
  assert.equal(k.linkLocationIssue('/Users/a/Desktop/p.png'), 'デスクトップ');
  assert.equal(k.linkLocationIssue('\\\\server\\share\\p.png'), 'ネットワーク上(共有フォルダ)');
  assert.equal(k.linkLocationIssue('/Volumes/USB/p.png'), '外付けドライブ(別ボリューム)');
  assert.equal(k.linkLocationIssue('C:\\Users\\a\\OneDrive\\Pictures\\p.png'), 'クラウド同期フォルダ');
  assert.equal(k.linkLocationIssue('/Users/a/Dropbox/job/p.png'), 'クラウド同期フォルダ');
});

test('linkLocationIssue: クラウド同期フォルダ内のデスクトップは、クラウドとして報告する', () => {
  assert.equal(k.linkLocationIssue('C:\\Users\\a\\OneDrive\\Desktop\\p.png'), 'クラウド同期フォルダ');
});

test('linkLocationIssue: 普通の置き場所は問題なし', () => {
  assert.equal(k.linkLocationIssue('C:\\Users\\Public\\jobs\\p.png'), '');
  assert.equal(k.linkLocationIssue('E:\\work\\入稿\\links\\p.png'), '');
  assert.equal(k.linkLocationIssue('/Users/a/Documents/job/p.png'), '');
  assert.equal(k.linkLocationIssue(''), '');
  assert.equal(k.linkLocationIssue(undefined), '');
});

// ---- スミ(K100)----

test('isPureBlackCMYK: K がほぼ100で C/M/Y がほぼ0のものだけ', () => {
  assert.equal(k.isPureBlackCMYK(0, 0, 0, 100), true);
  assert.equal(k.isPureBlackCMYK(0, 0, 0, 95), true);
  assert.equal(k.isPureBlackCMYK(2, 2, 2, 100), true);
  assert.equal(k.isPureBlackCMYK(0, 0, 0, 90), false);      // K90 はスミベタとは言えない
  assert.equal(k.isPureBlackCMYK(30, 0, 0, 100), false);    // リッチブラックは別の項目で見る
  assert.equal(k.isPureBlackCMYK(0, 0, 0, 0), false);
});

// ---- アートボードサイズの統一 ----

test('sizeOutliers: 多数派と違うアートボードを返す', () => {
  const r = plain(k.sizeOutliers([[210, 297], [210, 297], [148, 210]], 0.5));
  assert.deepEqual(r, { base: [210, 297], mismatches: [2] });
});

test('sizeOutliers: 縦横の入れ替えと許容差は同じサイズとみなす', () => {
  assert.deepEqual(plain(k.sizeOutliers([[210, 297], [297, 210], [210.3, 296.8]], 0.5)).mismatches, []);
  assert.deepEqual(plain(k.sizeOutliers([[210, 297], [211, 297]], 0.5)).mismatches.length, 1);
});

test('sizeOutliers: 多数派が先頭でなくても、先頭を基準にしない', () => {
  const r = plain(k.sizeOutliers([[148, 210], [210, 297], [210, 297], [210, 297]], 0.5));
  assert.deepEqual(r, { base: [210, 297], mismatches: [0] });
});

test('sizeOutliers: 同数のときは先に出たサイズが基準。アートボードが無ければ基準なし', () => {
  assert.deepEqual(plain(k.sizeOutliers([[210, 297], [148, 210]], 0.5)), { base: [210, 297], mismatches: [1] });
  assert.deepEqual(plain(k.sizeOutliers([], 0.5)), { base: null, mismatches: [] });
});

// ---- 登録の整合(新しい項目の登録忘れを防ぐ)----

const NEW_IDS = ['artboard_size_consistency', 'black_overprint', 'unused_spot', 'link_filename', 'image_aspect', 'empty_object'];

test('新しい6項目が、実行順・既定の設定・定義・チェック関数のすべてに登録されている', () => {
  const ids = plain(k.getCheckIdOrder());
  const cfg = plain(k.defaultConfig());
  for (const id of NEW_IDS) {
    assert.ok(ids.includes(id), `${id}: getCheckIdOrder にない`);
    assert.equal(cfg.checks[id], true, `${id}: 既定の設定にない(または無効)`);
    assert.ok(k.CHECK_META[id], `${id}: CHECK_META にない`);
    assert.ok(new RegExp('^CHECKS\\.' + id + ' = function', 'm').test(SOURCE), `${id}: CHECKS.${id} の定義がない`);
  }
});

test('すべての項目に、チェック関数の定義と、カテゴリ・名前・解説がある(登録漏れがない)', () => {
  const order = plain(k.getCheckIdOrder());
  const categories = ['サイズとトンボ', 'フォント', 'カラー', '画像', 'オブジェクト・効果', 'その他'];
  for (const id of order) {
    assert.ok(new RegExp('^CHECKS\\.' + id + ' = function', 'm').test(SOURCE), `${id}: CHECKS.${id} の定義がない`);
    const meta = k.CHECK_META[id];
    assert.ok(meta.name && meta.advice, `${id}: 名前か解説がない`);
    assert.ok(categories.includes(meta.category), `${id}: 未知のカテゴリ ${meta.category}`);
  }
  // 定義されているチェック関数が、実行順から漏れていない
  const defined = [...SOURCE.matchAll(/^CHECKS\.(\w+) = function/gm)].map((x) => x[1]);
  assert.deepEqual([...defined].sort(), [...order].sort());
});

test('スクリプト全体が、構文として読める(1文字の誤りで全機能が止まるのを防ぐ)', () => {
  const body = SOURCE.replace(/^\uFEFF/, '').replace(/^#target[^\r\n]*/gm, '//');
  assert.doesNotThrow(() => new vm.Script(body));
});

test('ES3 でない構文(const / let / アロー関数 / テンプレート文字列)を使っていない', () => {
  // ExtendScript(ES3相当)では、これらがあるとスクリプト全体が読み込めない。コメントと文字列の中は除いて調べる
  const stripped = SOURCE
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  assert.ok(!/(^|[^\w.$])(const|let)\s+[\w$]/m.test(stripped), 'const / let が使われている');
  assert.ok(!/=>/.test(stripped), 'アロー関数が使われている');
  assert.ok(!/`/.test(stripped), 'テンプレート文字列が使われている');
});
