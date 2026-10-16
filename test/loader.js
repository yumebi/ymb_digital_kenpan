'use strict';
// DigitalKenpan.jsx から、名前を指定した関数・変数の定義だけを取り出して Node で評価する。
//
// 本体は Illustrator の ExtendScript で動く単一ファイルで、そのまま Node では読み込めない
// (先頭から ScriptUI や app を使うため)。本体を分割・改変せずに、実際に配布されるコードの
// 一部をそのままテストするために、ソースから定義を切り出す方式にしている。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, '..', 'DigitalKenpan.jsx');

// 正規表現リテラルが始まりうる直前の文字(これ以外の直前の '/' は割り算とみなす)
const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '']);

/**
 * start から、最初に現れる開き括弧に対応する閉じ括弧までのインデックス(閉じ括弧の位置)を返す。
 * 文字列・正規表現・コメントの中の括弧は数えない。
 */
function findMatching(src, start, open, close) {
  let depth = 0;
  let prevSignificant = '';
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === '"' || c === "'") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      prevSignificant = c;
      continue;
    }
    if (c === '/' && REGEX_PREV.has(prevSignificant)) {
      let inClass = false;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
      }
      prevSignificant = '/';
      continue;
    }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i; }
    if (!/\s/.test(c)) prevSignificant = c;
  }
  throw new Error('対応する括弧が見つかりません');
}

function extractFunction(src, name) {
  const m = new RegExp('^function\\s+' + name + '\\s*\\(', 'm').exec(src);
  if (!m) throw new Error('関数が見つかりません: ' + name);
  const bodyStart = src.indexOf('{', src.indexOf(')', m.index));
  const end = findMatching(src, bodyStart, '{', '}');
  return src.slice(m.index, end + 1);
}

function extractVar(src, name) {
  const m = new RegExp('^var\\s+' + name + '\\s*=', 'm').exec(src);
  if (!m) throw new Error('変数が見つかりません: ' + name);
  // 値が { } や [ ] で始まる場合は、その括弧の閉じまでを定義とみなす
  const valueStart = m.index + m[0].length;
  const rest = src.slice(valueStart).match(/^\s*([{\[])/);
  let end;
  if (rest) {
    const open = rest[1];
    const openPos = src.indexOf(open, valueStart);
    end = findMatching(src, openPos, open, open === '{' ? '}' : ']');
  } else {
    end = src.indexOf(';', valueStart) - 1;
  }
  return src.slice(m.index, end + 1) + ';';
}

/**
 * @param {{functions?: string[], vars?: string[]}} names 取り出す定義の名前
 * @returns 取り出した関数・変数を持つオブジェクト
 */
function load(names) {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const parts = [];
  for (const v of names.vars || []) parts.push(extractVar(src, v));
  for (const f of names.functions || []) parts.push(extractFunction(src, f));
  const exportNames = [...(names.vars || []), ...(names.functions || [])];
  const code = parts.join('\n') + '\nthis.__exports = {' + exportNames.join(', ') + '};';
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.__exports;
}

module.exports = { load };
