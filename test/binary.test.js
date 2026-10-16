'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./loader');

const k = load({
  vars: ['HEADER_READ_BYTES', 'IMAGE_INFO_CACHE'],
  functions: [
    'safe', 'b16be', 'b32be', 'b16le', 'b32le',
    'readBinaryBytes', 'readImageInfo', 'getImageInfoCached', 'utf8BytesFromString',
  ],
});

/** ExtendScript の File に見立てた偽物。BINARY で読むと、1文字が1バイトの文字列を返す。 */
function fakeFile(bytes, name = 'x') {
  const content = Buffer.from(bytes).toString('latin1');
  return {
    exists: true,
    fsName: name,
    encoding: '',
    reads: 0,
    open() { return true; },
    read(n) { this.reads++; return content.slice(0, n); },
    close() {},
  };
}

const u16be = (n) => [(n >> 8) & 255, n & 255];
const u16le = (n) => [n & 255, (n >> 8) & 255];
const u32be = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u32le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const pad = (arr, len) => arr.concat(new Array(Math.max(0, len - arr.length)).fill(0));

function png(w, h, depth, colorType) {
  return pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    ...u32be(w), ...u32be(h), depth, colorType, 0, 0, 0], 40);
}
function gif(w, h) { return pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...u16le(w), ...u16le(h)], 20); }
function bmp(w, hRaw, bpp) {
  const b = pad([0x42, 0x4d], 40);
  b.splice(18, 4, ...u32le(w));
  b.splice(22, 4, ...u32le(hRaw >>> 0));   // 高さは符号つき32bit(負なら上下反転)
  b.splice(28, 2, ...u16le(bpp));
  return b;
}
function psd(w, h, depth, mode) {
  const b = pad([0x38, 0x42, 0x50, 0x53, 0, 1], 40);
  b.splice(14, 4, ...u32be(h));
  b.splice(18, 4, ...u32be(w));
  b.splice(22, 2, ...u16be(depth));
  b.splice(24, 2, ...u16be(mode));
  return b;
}
function jpeg(w, h, comps) {
  return [0xff, 0xd8,
    0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,        // APP0
    0xff, 0xc0, 0, 17, 8, ...u16be(h), ...u16be(w), comps, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, // SOF0
    0xff, 0xd9];
}
/** TIFF(リトルエンディアン)。entries は [tag, type, value]。 */
function tiff(entries, little = true) {
  const w16 = little ? u16le : u16be;
  const w32 = little ? u32le : u32be;
  const bytes = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...w16(42), ...w32(8), ...w16(entries.length)];
  for (const [tag, type, value] of entries) {
    bytes.push(...w16(tag), ...w16(type), ...w32(1), ...(type === 3 ? [...w16(value), 0, 0] : w32(value)));
  }
  bytes.push(0, 0, 0, 0);
  return pad(bytes, 64);
}
// vm 内で作られたオブジェクトは Node 側と prototype が違い deepEqual が通らないので、JSON を経由して比べる
const plain = (v) => JSON.parse(JSON.stringify(v));
const info = (bytes) => plain(k.readImageInfo(fakeFile(bytes)));

test('バイト列の読み取り: 16/32bit をリトル・ビッグエンディアンで読む(32bit は符号なし)', () => {
  assert.equal(k.b16be([0x12, 0x34], 0), 0x1234);
  assert.equal(k.b16le([0x12, 0x34], 0), 0x3412);
  assert.equal(k.b32be([0x12, 0x34, 0x56, 0x78], 0), 0x12345678);
  assert.equal(k.b32le([0x78, 0x56, 0x34, 0x12], 0), 0x12345678);
  assert.equal(k.b32be([0xff, 0xff, 0xff, 0xff], 0), 4294967295);
  assert.equal(k.b32le([0xff, 0xff, 0xff, 0xff], 0), 4294967295);
});

test('PNG: 寸法とカラーモード', () => {
  assert.deepEqual(info(png(800, 600, 8, 2)), { ok: true, format: 'PNG', width: 800, height: 600, colorMode: 'RGB', isBitmap: false });
  assert.equal(info(png(10, 10, 8, 6)).colorMode, 'RGB');      // RGBA
  assert.equal(info(png(10, 10, 8, 0)).colorMode, 'GRAY');
  assert.equal(info(png(10, 10, 8, 4)).colorMode, 'GRAY');     // グレー+アルファ
  assert.equal(info(png(10, 10, 8, 3)).colorMode, 'RGB');      // パレット
});

test('PNG: 1bit のグレーだけがモノクロ2値', () => {
  assert.equal(info(png(10, 10, 1, 0)).isBitmap, true);
  assert.equal(info(png(10, 10, 8, 0)).isBitmap, false);
  assert.equal(info(png(10, 10, 1, 3)).isBitmap, false);       // 1bit のパレットは2値とは扱わない
});

test('GIF: 寸法(リトルエンディアン)', () => {
  assert.deepEqual(info(gif(320, 200)), { ok: true, format: 'GIF', width: 320, height: 200, colorMode: 'RGB', isBitmap: false });
});

test('BMP: 寸法とビット数', () => {
  const r = info(bmp(640, 480, 24));
  assert.deepEqual([r.format, r.width, r.height, r.isBitmap], ['BMP', 640, 480, false]);
  assert.equal(info(bmp(640, 480, 1)).isBitmap, true);
});

test('BMP: 上下反転(高さが負)の画像でも、高さは絶対値で読む', () => {
  // biHeight が負のBMPは、上下反転で保存されている。高さが約43億になってはいけない
  const r = info(bmp(640, -480, 24));
  assert.equal(r.height, 480);
  assert.equal(r.width, 640);
});

test('PSD: 寸法・カラーモード・2値', () => {
  const rgb = info(psd(1000, 700, 8, 3));
  assert.deepEqual([rgb.format, rgb.width, rgb.height, rgb.colorMode, rgb.isBitmap], ['PSD', 1000, 700, 'RGB', false]);
  assert.equal(info(psd(10, 10, 8, 4)).colorMode, 'CMYK');
  assert.equal(info(psd(10, 10, 8, 1)).colorMode, 'GRAY');
  assert.equal(info(psd(10, 10, 8, 9)).colorMode, 'UNKNOWN');   // Lab 等
  assert.equal(info(psd(10, 10, 1, 0)).isBitmap, true);          // ビットマップモード
});

test('JPEG: 寸法とコンポーネント数からカラーモード', () => {
  assert.deepEqual(info(jpeg(1920, 1080, 3)), { ok: true, format: 'JPEG', width: 1920, height: 1080, colorMode: 'RGB', isBitmap: false });
  assert.equal(info(jpeg(10, 10, 4)).colorMode, 'CMYK');
  assert.equal(info(jpeg(10, 10, 1)).colorMode, 'GRAY');
  assert.equal(info(jpeg(10, 10, 2)).colorMode, 'UNKNOWN');
});

test('TIFF: 寸法・カラーモード(リトル/ビッグエンディアン)', () => {
  for (const little of [true, false]) {
    const r = info(tiff([[256, 3, 2000], [257, 3, 1500], [262, 3, 2], [277, 3, 3], [258, 3, 8]], little));
    assert.deepEqual([r.format, r.width, r.height, r.colorMode, r.isBitmap], ['TIFF', 2000, 1500, 'RGB', false], 'little=' + little);
  }
  assert.equal(info(tiff([[256, 3, 10], [257, 3, 10], [262, 3, 5], [277, 3, 4]])).colorMode, 'CMYK');
  assert.equal(info(tiff([[256, 4, 10], [257, 4, 10], [262, 3, 1]])).colorMode, 'GRAY');   // LONG 型の寸法
});

test('TIFF: 1bit の白黒だけがモノクロ2値', () => {
  assert.equal(info(tiff([[256, 3, 10], [257, 3, 10], [262, 3, 0], [277, 3, 1], [258, 3, 1]])).isBitmap, true);
  assert.equal(info(tiff([[256, 3, 10], [257, 3, 10], [262, 3, 1], [258, 3, 8]])).isBitmap, false);
});

test('TIFF: 寸法が無い・IFD が読み込み範囲外なら判定不能', () => {
  assert.deepEqual(info(tiff([[262, 3, 2]])), { ok: false });
  const far = tiff([[256, 3, 10], [257, 3, 10]]);
  far.splice(4, 4, ...u32le(100000));                      // IFD のオフセットが 64KB の外
  assert.deepEqual(info(far), { ok: false });
});

test('判定不能: 短すぎる・未対応形式・壊れたデータ', () => {
  assert.deepEqual(info([1, 2, 3]), { ok: false });
  assert.deepEqual(info(pad([0x25, 0x50, 0x44, 0x46], 64)), { ok: false });          // PDF
  assert.deepEqual(info(pad([0x52, 0x49, 0x46, 0x46], 64)), { ok: false });          // WEBP(RIFF)
  assert.deepEqual(info(pad([0xff, 0xd8, 0xff, 0xc0, 0, 1], 64)), { ok: false });    // JPEG の不正なセグメント長
  assert.deepEqual(info(pad([0xff, 0xd8, 0xff, 0xd9], 64)), { ok: false });          // SOF が無い
});

test('存在しないファイル・読み込み失敗は判定不能(例外を投げない)', () => {
  assert.deepEqual(plain(k.readImageInfo({ exists: false })), { ok: false });
  const broken = { exists: true, open() { return true; }, read() { throw new Error('io'); }, close() {} };
  assert.deepEqual(plain(k.readImageInfo(broken)), { ok: false });
});

test('先頭 64KB だけを読む(巨大ファイルでフリーズしない)', () => {
  const f = fakeFile(pad(png(10, 10, 8, 2), 200000));
  let requested = 0;
  const spy = { ...f, read(n) { requested = n; return f.read(n); } };
  k.readImageInfo(spy);
  assert.equal(requested, 65536);
  assert.equal(k.HEADER_READ_BYTES, 65536);
});

test('getImageInfoCached: 同じファイルは1回しか読まない', () => {
  const f = fakeFile(png(5, 5, 8, 2), 'same-file');
  const a = k.getImageInfoCached(f);
  const b = k.getImageInfoCached(f);
  assert.equal(f.reads, 1);
  assert.equal(a, b);
});

// ---- UTF-8 への変換(CSV/HTML レポートの文字化け対策の中核)----

const viaScript = (s) => Buffer.from(k.utf8BytesFromString(s), 'latin1');

test('utf8BytesFromString: Node の UTF-8 変換と一致する(ASCII・日本語・記号)', () => {
  for (const s of ['', 'abc', '検版レポート', 'ｱｲｳ 全角ＡＢＣ', '①②③ ㈱ ～ ―', 'a,b"c\n']) {
    assert.deepEqual(viaScript(s), Buffer.from(s, 'utf8'), JSON.stringify(s));
  }
});

test('utf8BytesFromString: サロゲートペア(絵文字など BMP 外)を4バイトに変換する', () => {
  for (const s of ['😀', '𠮷野家', 'a😀b']) {
    assert.deepEqual(viaScript(s), Buffer.from(s, 'utf8'), JSON.stringify(s));
  }
});

test('utf8BytesFromString: すべて 0〜255 の1文字=1バイトの文字列になる', () => {
  const out = k.utf8BytesFromString('日本語😀');
  assert.ok([...out].every((c) => c.charCodeAt(0) <= 255));
  assert.equal(out.length, Buffer.from('日本語😀', 'utf8').length);
});
