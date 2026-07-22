#target illustrator
#targetengine "DigitalKenpanEngine"

// =============================================================================
// DigitalKenpan.jsx
// Adobe Illustrator 用 デジタル検版(プリフライトチェック)ツール
// -----------------------------------------------------------------------------
// ・アクティブドキュメントに対して各種プリフライト項目をチェックし、
//   OK / エラー(NG) / 警告(要確認) / 情報 を判定してレポート表示・保存する
//   「検査専用」ツールです。
// ・オブジェクトの自動修正機能は一切含みません(判定とレポートのみ)。
// ・ExtendScript(ES3相当)で記述しています。const/let/アロー関数/
//   Array.prototype.map 等の ES5+ 構文、JSON組み込みオブジェクトは使用していません。
// ・Windows / macOS 両対応。パス操作はすべて File / Folder オブジェクトで抽象化し、
//   OS依存コード(区切り文字のハードコード等)は使用していません。
// ・詳細は同フォルダの README.md を参照してください。
// =============================================================================

(function () {

// バージョン表示用。修正のたびにこの値を更新する運用とする。
// (タイトルバー・HTML/CSVレポートのメタ情報欄に表示される)
var KENPAN_VERSION = "1.23.0";

// 【v1.16.0・確定原因への対処】Windows実機ログで、win.onResizeが再入(reentrant)して
// 無限ループ・ウィンドウ幅の際限ない自動増加に陥ることが確定した。
// applySettingsWindowFit/applyResultWindowFit 自体やforceScrollbarReflow/
// forceResultScrollbarReflow内の win.layout.layout(true) 等が win.onResize を再度
// 発火させ、そのハンドラが同じフィット処理→再描画呼び出しを実行し…という再入ループになる。
// このフラグは「win.layout.layout(true)/win.layout.resize() 等、win.onResizeを
// 再度誘発し得る操作を実行している最中」であることを示す。win.onResizeハンドラの
// 先頭でこれをチェックし、trueなら(=自分自身の操作が引き金で再入した呼び出しなら)
// 何もせず即リターンすることで、再入ループを1回で断ち切る。
var FIT_IN_PROGRESS = false;

// FIT_IN_PROGRESSを立てた状態で target.layout.layout(true) を実行するヘルパー。
// try/finallyでラップしているため、内部で例外が起きてもFIT_IN_PROGRESSが
// trueのまま固まってwin.onResizeが永久に無効化される、という事態を防ぐ。
function safeWinLayout(target) {
    FIT_IN_PROGRESS = true;
    try {
        target.layout.layout(true);
        return true;
    } catch (eLayout) {
        return false;
    } finally {
        FIT_IN_PROGRESS = false;
    }
}

// -----------------------------------------------------------------------------
// 0z. 診断ログ機構(Mac不具合の実機調査用・一時的な仕込み)
//     Windows/Macで再現状況が異なる不具合(設定画面のスクロールバー非表示、
//     進捗ラベルのファイル名非表示)を推測ベースの修正では解決しきれなかったため、
//     実際の実行時状態をテキストファイルに書き出して確認する方式に切り替える。
//     調査が終わったら KENPAN_DEBUG_LOG = false にすればログ出力は完全に止まる
//     (dlog()自体は残しておいてよい。呼び出し箇所を消さなくても影響が無い設計)。
// -----------------------------------------------------------------------------

// 【v1.11.0】進捗ファイル名は v1.10.0 の修正で解決したが、スクロールバー非表示は
// settingsViewportRow.layout.layout(true) の追加だけでは直らなかったため、再度ログを
// 有効化し、複数の再描画手段を同時に試して「どれが効くか」を実機ログから見極める。
var KENPAN_DEBUG_LOG = true;

// デバッグログを1行追記する。KENPAN_DEBUG_LOG が false のときは何もしない。
// 書き込み失敗(権限が無い等)しても本体機能に一切影響しないよう、全体をsafe()相当の
// try/catchで保護する。Macでデスクトップへの書き込み権限が無い環境を考慮し、
// Folder.desktop への書き込みに失敗した場合は Folder.myDocuments へフォールバックする。
function dlog(tag, message) {
    if (!KENPAN_DEBUG_LOG) return;
    try {
        var line = "[" + nowString() + "] [" + tag + "] " + message;
        var wrote = false;
        try {
            var f1 = new File(Folder.desktop.fsName + "/DigitalKenpan_debug.log");
            f1.encoding = "UTF-8";
            if (f1.open("a")) {
                f1.writeln(line);
                f1.close();
                wrote = true;
            }
        } catch (eDesktop) {
            wrote = false;
        }
        if (!wrote) {
            try {
                var f2 = new File(Folder.myDocuments.fsName + "/DigitalKenpan_debug.log");
                f2.encoding = "UTF-8";
                if (f2.open("a")) {
                    f2.writeln(line);
                    f2.close();
                }
            } catch (eDocs) {
                // ここまで失敗したら諦める(本体機能への影響を避けるため例外を外に出さない)
            }
        }
    } catch (eOuter) {
        // dlog自体が本体機能を壊すことは絶対に避ける
    }
}

// デバッグログ用の整形ヘルパー(ES3にJSONが無いため手書き)。
// win.size / settingsViewport.size 等の [w,h] 配列を文字列化する。
function fmtArr(a) {
    if (a === null || a === undefined) return "(null)";
    try {
        var parts = [];
        for (var i = 0; i < a.length; i++) parts.push(String(a[i]));
        return "[" + parts.join(",") + "]";
    } catch (e) { return "(取得失敗:" + e.toString() + ")"; }
}

// $.screens[0] のようなleft/top/right/bottomプロパティを持つ矩形オブジェクトを文字列化する。
function fmtScreen(scr) {
    if (!scr) return "(null)";
    try {
        return "{left:" + scr.left + ",top:" + scr.top + ",right:" + scr.right + ",bottom:" + scr.bottom + "}";
    } catch (e) { return "(取得失敗:" + e.toString() + ")"; }
}

// 【v1.14.0】パネルの区切りを「枠線」ではなく「面(背景色)」で見せるためのヘルパー。
// ScriptUIのpanel枠線色は直接変更できず、ダークUIでは細い枠線の視認性が悪いため、
// 残したパネルには背景をわずかに明るいグレーにして面で区切る。
// Illustratorのダークパネル背景(約0.32グレー)より6%程度明るい値を使用。
// graphics APIがMac等で効かない環境でもsafe()が例外を吸収し、枠線表示のまま劣化なしで動く。
var PANEL_BACKDROP_GRAY = 0.38;
function applyPanelBackdrop(p) {
    safe(function () {
        p.graphics.backgroundColor = p.graphics.newBrush(
            p.graphics.BrushType.SOLID_COLOR, [PANEL_BACKDROP_GRAY, PANEL_BACKDROP_GRAY, PANEL_BACKDROP_GRAY], 1);
        return null;
    }, null);
}

// -----------------------------------------------------------------------------
// 0. 基本ユーティリティ
// -----------------------------------------------------------------------------

var PT_PER_MM = 2.834645669291339; // 72 / 25.4

function mm2pt(mm) { return mm * PT_PER_MM; }
function pt2mm(pt) { return pt / PT_PER_MM; }

// 進捗表示用にファイル名等を短縮する(長い場合は先頭+"…"+末尾)。
// Mac の ScriptUI は statictext の幅を超えたテキストが描画されないことがあるため、
// ラベル幅に収まる長さへ必ずカットして渡す。
function truncateForProgress(s, maxLen) {
    if (s === undefined || s === null) return "";
    s = String(s);
    if (maxLen === undefined) maxLen = 40;
    if (s.length <= maxLen) return s;
    // 末尾側(拡張子を含む)を残しつつ先頭+"…"+末尾で連結
    var tailLen = 12;
    if (tailLen > maxLen - 2) tailLen = Math.floor((maxLen - 1) / 2);
    var headLen = maxLen - 1 - tailLen;
    return s.substring(0, headLen) + "…" + s.substring(s.length - tailLen);
}

// 【v1.19.0】結果画面の noteText/selStatusText 等、multiline:true な statictext は
// 固定preferredSizeだと項目ごとの文章量の差(1文で終わるものもあれば、リッチブラック/
// 4Cブラックのように「原因と対応」+「判定基準」の2〜3文にわたるものもある)で
// どこかの項目が必ず見切れる問題があった。固定値の積み増しではなく、表示する
// テキスト量から必要な行数・高さをその都度見積もる方式に変える。
//
// 【v1.20.0】v1.19.0の係数(lineHeightPx=18, CHAR_WIDTH_PX=14, PADDING_PX=10, maxLines=8)
// でも実機(Windows)で最終行がわずかに欠ける不具合が再現した。「1行あたりの実際の
// 描画高さ」の見積もりが実際のフォント描画より小さく、行数が増えるほど誤差が蓄積して
// いたと考えられるため、安全マージンを大幅に増やす(精度より欠けないことを最優先)。
//
// text: 表示するテキスト(改行\nを含んでよい)
// boxWidthPx: テキストボックスの幅(px)
// lineHeightPx: 1行あたりの高さ(px、省略時24。v1.19.0の18から引き上げ)
// minLines/maxLines: 見積もり行数のクランプ範囲(省略時2〜10。v1.19.0の8から引き上げ。
//   maxLinesは暴走防止の上限で、それを超える長さのテキストでも resultViewport の
//   縦スクロールで最後まで読めるため致命的ではない)
//
// 文字幅は日本語(全角)を基準に、v1.19.0の14pxからさらに余裕を持たせた16px/文字を使う
// (1行あたりの折返し文字数を少なめに見積もることで、行数が多めに出るようにする)。
// 半角英数字が混じると実際より行数を多めに見積もることになるが、「精度より確実に
// 切れないこと」を優先する方針のため、多めに確保される分には実害が無いとみなす。
// 最終的な高さにはさらに+20%のバッファ(HEIGHT_BUFFER_RATIO)を掛ける。
function estimateTextBoxHeight(text, boxWidthPx, lineHeightPx, minLines, maxLines) {
    try {
        if (text === undefined || text === null) text = "";
        text = String(text);
        if (!boxWidthPx || boxWidthPx < 20) boxWidthPx = 340;
        if (!lineHeightPx || lineHeightPx < 8) lineHeightPx = 24;
        if (!minLines || minLines < 1) minLines = 2;
        if (!maxLines || maxLines < minLines) maxLines = 10;

        var CHAR_WIDTH_PX = 16; // 全角文字1文字あたりの概算幅(v1.19.0の14pxからさらに拡大)
        var usableWidthPx = boxWidthPx - 10; // 左右の余白ぶんを差し引く
        if (usableWidthPx < 40) usableWidthPx = 40;
        var charsPerLine = Math.floor(usableWidthPx / CHAR_WIDTH_PX);
        if (charsPerLine < 5) charsPerLine = 5;

        // 明示的な改行(\n、複数の文をjoinArrで連結している場合に入る)ごとに
        // 折り返し行数を積算する
        var rawLines = text.split("\n");
        var totalLines = 0;
        for (var i = 0; i < rawLines.length; i++) {
            var lineLen = rawLines[i].length;
            var wrapped = Math.ceil(lineLen / charsPerLine);
            if (wrapped < 1) wrapped = 1; // 空行でも1行ぶんは確保
            totalLines += wrapped;
        }
        if (totalLines < minLines) totalLines = minLines;
        if (totalLines > maxLines) totalLines = maxLines;

        var PADDING_PX = 24; // 上下の余白相当(v1.19.0の10pxから引き上げ)
        var HEIGHT_BUFFER_RATIO = 1.2; // 【v1.20.0】最終的な高さにさらに+20%のバッファを掛ける
        var rawHeight = totalLines * lineHeightPx + PADDING_PX;
        return Math.ceil(rawHeight * HEIGHT_BUFFER_RATIO);
    } catch (eEst) {
        // 見積もりに失敗しても本体機能を壊さないよう、安全側の既定値を返す
        return Math.ceil(((minLines ? minLines : 2) * (lineHeightPx ? lineHeightPx : 24) + 24) * 1.2);
    }
}

// 数値を指定桁数で丸めて文字列化(ES3セーフ。toFixedはExtendScriptでも利用可)
function fmt(num, digits) {
    if (digits === undefined) digits = 2;
    if (num === undefined || num === null || isNaN(num)) return "-";
    return num.toFixed(digits);
}

function pad2(n) {
    n = Math.floor(n);
    return (n < 10 ? "0" : "") + n;
}

function nowString() {
    var d = new Date();
    return d.getFullYear() + "/" + pad2(d.getMonth() + 1) + "/" + pad2(d.getDate()) +
        " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function nowFileStamp() {
    var d = new Date();
    return "" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "_" +
        pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

// 配列 join のES3セーフ実装(Array.prototype.joinは使えるがnull安全のため用意)
function joinArr(arr, sep) {
    var s = "";
    for (var i = 0; i < arr.length; i++) {
        if (i > 0) s += sep;
        s += arr[i];
    }
    return s;
}

// HTMLエスケープ
function escapeHtml(s) {
    if (s === undefined || s === null) return "";
    s = String(s);
    s = s.replace(/&/g, "&amp;");
    s = s.replace(/</g, "&lt;");
    s = s.replace(/>/g, "&gt;");
    s = s.replace(/"/g, "&quot;");
    return s;
}

// CSVフィールドエスケープ
function escapeCsv(s) {
    if (s === undefined || s === null) s = "";
    s = String(s);
    if (s.indexOf(",") >= 0 || s.indexOf("\"") >= 0 || s.indexOf("\n") >= 0 || s.indexOf("\r") >= 0) {
        s = "\"" + s.replace(/"/g, "\"\"") + "\"";
    }
    return s;
}

function safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
}

// -----------------------------------------------------------------------------
// 0b. 中断(アボート)機構
//     ExtendScriptは同期実行中にダイアログのボタンイベントを処理できないため、
//     ScriptUI.environment.keyboardState をポーリングして ESC キー押下を検出する。
//     走査ループ・各チェックの合間・画像ヘッダ解析1ファイルごとに必ず呼ぶこと。
// -----------------------------------------------------------------------------

var ABORT_MESSAGE = "__KENPAN_ABORT__";
var ABORT_FLAG = { on: false };

// 【Mac対策】app.scheduleTask()に渡す文字列はグローバルスコープで評価されるため、
// buildAndShowDialog()内のローカル関数をそこから呼び出せるよう、グローバル変数に
// 一時的に参照を格納しておく(クロージャ自体は元のローカルスコープを保持するので、
// 呼び出し元がグローバルであることは問題にならない)。
var KENPAN_DEFERRED_SETTINGS_INIT = null;

function abortKeyPressed() {
    return safe(function () {
        var ks = ScriptUI.environment.keyboardState;
        return ks !== null && ks !== undefined && (ks.keyName === "Escape" || ks.keyName === "Esc");
    }, false);
}

// 中断要求があれば専用エラーを投げる(呼び出し側の try/catch で isAbortError 判定)
function throwIfAborted() {
    if (ABORT_FLAG.on || abortKeyPressed()) {
        ABORT_FLAG.on = true;
        throw new Error(ABORT_MESSAGE);
    }
}

function isAbortError(e) {
    return e !== null && e !== undefined && String(e.message) === ABORT_MESSAGE;
}

// -----------------------------------------------------------------------------
// 1. 設定(仕上がりサイズ・カラー数・各種閾値・ON/OFF)
// -----------------------------------------------------------------------------

// 仕上がりサイズプリセット [幅mm, 高さmm](縦横は自動判定するため基準値のみ)
var SIZE_PRESET_KEYS = ["A3", "A4", "A5", "B4", "B5", "B6", "HAGAKI", "MEISHI", "CUSTOM"];
var SIZE_PRESET_LABELS = {
    A3: "A3 (297×420mm)",
    A4: "A4 (210×297mm)",
    A5: "A5 (148×210mm)",
    B4: "B4 (257×364mm)",
    B5: "B5 (182×257mm)",
    B6: "B6 (128×182mm)",
    HAGAKI: "ハガキ (100×148mm)",
    MEISHI: "名刺 (91×55mm)",
    CUSTOM: "カスタム"
};
var SIZE_PRESET_MM = {
    A3: [297, 420],
    A4: [210, 297],
    A5: [148, 210],
    B4: [257, 364],
    B5: [182, 257],
    B6: [128, 182],
    HAGAKI: [100, 148],
    MEISHI: [91, 55],
    CUSTOM: null
};

var COLOR_MODE_KEYS = ["MONO1", "CMYK4", "CMYK4SPOT", "SPOTONLY"];
var COLOR_MODE_LABELS = {
    MONO1: "1色モノクロ",
    CMYK4: "4色CMYK",
    CMYK4SPOT: "4色+特色",
    SPOTONLY: "特色のみ"
};

function defaultConfig() {
    return {
        sizeKey: "A4",
        customWidthMM: 210,
        customHeightMM: 297,
        sizeToleranceMM: 0.5,
        colorModeKey: "CMYK4",
        expectedSpotCount: 0, // 0 = チェックしない
        bleedMM: 3,
        textMarginMM: 5,
        minStrokePt: 0.25,
        minImageDPI: 300,
        maxImageDPI: 900,          // カラー/グレー画像の過剰解像度警告閾値(dpi)
        minBitmapDPI: 600,         // モノクロ2値(ビットマップ)画像の下限(dpi)
        maxBitmapDPI: 1200,        // モノクロ2値(ビットマップ)画像の過剰警告閾値(dpi)
        maxInkPercent: 300,
        minRasterEffectPPI: 300,
        maxObjectCount: 100000,    // ベクトルオブジェクト総数の警告閾値
        thinLinePt: 0.5,           // 細ケイ+薄アミ検出: 線幅閾値(pt)
        lightInkPercent: 20,       // 細ケイ+薄アミ検出: 濃度合計閾値(%)
        checks: {
            size_match: true,
            bleed: true,
            tombo: true,
            font_outline: true,
            text_margin: true,
            rgb_mix: true,
            spot_color: true,
            ink_total: true,
            rich_black: true,
            gray_usage: true,
            spot_quality: true,
            artboard_colors: true,
            blank_artboard: true,
            image_missing: true,
            image_colormode: true,
            image_resolution: true,
            transparency: true,
            gradient_mesh: true,
            pattern_usage: true,
            object_count: true,
            thin_light_line: true,
            overprint: true,
            hairline: true,
            raster_effect_res: true,
            unwanted: true
        }
    };
}

// -----------------------------------------------------------------------------
// 2. 設定の保存/読込(スクリプトと同じフォルダに設定txtを保存)
//    ES3には組み込みJSONが無いため、シンプルな key=value 形式で自前シリアライズする。
// -----------------------------------------------------------------------------

function getSettingsFile() {
    var scriptFile = new File($.fileName);
    return new File(scriptFile.parent.fsName + "/" + "DigitalKenpan_settings.txt");
}

function serializeConfig(cfg) {
    var lines = [];
    lines.push("sizeKey=" + cfg.sizeKey);
    lines.push("customWidthMM=" + cfg.customWidthMM);
    lines.push("customHeightMM=" + cfg.customHeightMM);
    lines.push("sizeToleranceMM=" + cfg.sizeToleranceMM);
    lines.push("colorModeKey=" + cfg.colorModeKey);
    lines.push("expectedSpotCount=" + cfg.expectedSpotCount);
    lines.push("bleedMM=" + cfg.bleedMM);
    lines.push("textMarginMM=" + cfg.textMarginMM);
    lines.push("minStrokePt=" + cfg.minStrokePt);
    lines.push("minImageDPI=" + cfg.minImageDPI);
    lines.push("maxImageDPI=" + cfg.maxImageDPI);
    lines.push("minBitmapDPI=" + cfg.minBitmapDPI);
    lines.push("maxBitmapDPI=" + cfg.maxBitmapDPI);
    lines.push("maxInkPercent=" + cfg.maxInkPercent);
    lines.push("minRasterEffectPPI=" + cfg.minRasterEffectPPI);
    lines.push("maxObjectCount=" + cfg.maxObjectCount);
    lines.push("thinLinePt=" + cfg.thinLinePt);
    lines.push("lightInkPercent=" + cfg.lightInkPercent);
    var checkIds = getCheckIdOrder();
    var checkStr = "";
    for (var i = 0; i < checkIds.length; i++) {
        if (i > 0) checkStr += ",";
        checkStr += checkIds[i] + ":" + (cfg.checks[checkIds[i]] ? "1" : "0");
    }
    lines.push("checks=" + checkStr);
    return joinArr(lines, "\n");
}

function parseConfig(text, base) {
    var cfg = base;
    var lines = text.split("\n");
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line) continue;
        line = line.replace(/^\s+|\s+$/g, "");
        if (line.length === 0) continue;
        var idx = line.indexOf("=");
        if (idx < 0) continue;
        var key = line.substring(0, idx);
        var val = line.substring(idx + 1);
        if (key === "sizeKey") cfg.sizeKey = val;
        else if (key === "customWidthMM") cfg.customWidthMM = parseFloat(val);
        else if (key === "customHeightMM") cfg.customHeightMM = parseFloat(val);
        else if (key === "sizeToleranceMM") cfg.sizeToleranceMM = parseFloat(val);
        else if (key === "colorModeKey") cfg.colorModeKey = val;
        else if (key === "expectedSpotCount") cfg.expectedSpotCount = parseInt(val, 10);
        else if (key === "bleedMM") cfg.bleedMM = parseFloat(val);
        else if (key === "textMarginMM") cfg.textMarginMM = parseFloat(val);
        else if (key === "minStrokePt") cfg.minStrokePt = parseFloat(val);
        else if (key === "minImageDPI") cfg.minImageDPI = parseFloat(val);
        else if (key === "maxImageDPI") cfg.maxImageDPI = parseFloat(val);
        else if (key === "minBitmapDPI") cfg.minBitmapDPI = parseFloat(val);
        else if (key === "maxBitmapDPI") cfg.maxBitmapDPI = parseFloat(val);
        else if (key === "maxInkPercent") cfg.maxInkPercent = parseFloat(val);
        else if (key === "minRasterEffectPPI") cfg.minRasterEffectPPI = parseFloat(val);
        else if (key === "maxObjectCount") cfg.maxObjectCount = parseFloat(val);
        else if (key === "thinLinePt") cfg.thinLinePt = parseFloat(val);
        else if (key === "lightInkPercent") cfg.lightInkPercent = parseFloat(val);
        else if (key === "checks") {
            var parts = val.split(",");
            for (var j = 0; j < parts.length; j++) {
                var kv = parts[j].split(":");
                if (kv.length === 2) {
                    cfg.checks[kv[0]] = (kv[1] === "1");
                }
            }
        }
    }
    return cfg;
}

function saveConfig(cfg) {
    try {
        var f = getSettingsFile();
        f.encoding = "UTF-8";
        f.open("w");
        f.write(serializeConfig(cfg));
        f.close();
        return true;
    } catch (e) {
        return false;
    }
}

function loadConfig() {
    var cfg = defaultConfig();
    try {
        var f = getSettingsFile();
        if (f.exists) {
            f.encoding = "UTF-8";
            f.open("r");
            var text = f.read();
            f.close();
            cfg = parseConfig(text, cfg);
        }
    } catch (e) {
        // 読込失敗時は既定値を使用
    }
    return cfg;
}

// -----------------------------------------------------------------------------
// 3. チェック項目定義(表示順・ID)
// -----------------------------------------------------------------------------

function getCheckIdOrder() {
    return [
        "size_match", "bleed", "tombo",
        "font_outline", "text_margin",
        "rgb_mix", "spot_color", "ink_total", "rich_black", "gray_usage", "spot_quality", "artboard_colors", "blank_artboard",
        "image_missing", "image_colormode", "image_resolution",
        "transparency", "gradient_mesh", "pattern_usage", "object_count", "thin_light_line",
        "overprint", "hairline", "raster_effect_res", "unwanted"
    ];
}

// advice: 「原因と対応」解説(教育用途。結果UI詳細欄とHTMLレポートに表示)
var CHECK_META = {
    size_match:        { category: "サイズとトンボ", name: "データサイズ照合",
        advice: "仕上がりサイズと異なると断裁位置がずれます。アートボードまたはトリム枠を仕上がりサイズに合わせてください。" },
    bleed:             { category: "サイズとトンボ", name: "塗り足し",
        advice: "塗り足しが足りないと断裁時に紙白(フチ)が出ます。断ち落とし要素は仕上がり線の外側3mmまで伸ばしてください。" },
    tombo:             { category: "サイズとトンボ", name: "トンボ有無",
        advice: "トンボが無いと印刷所で断裁位置を特定できません。トンボを作成するか、PDF書き出し時にトンボを付与する運用か確認してください。" },
    font_outline:      { category: "フォント",       name: "アウトライン化",
        advice: "アウトライン化されていないと出力環境にフォントが無い場合に文字化け・置換が起こります。入稿前に全テキストをアウトライン化してください。" },
    text_margin:       { category: "フォント",       name: "文字セーフマージン",
        advice: "仕上がり線に近い文字は断裁のブレで切れる恐れがあります。文字は仕上がりから5mm以上内側に配置してください。" },
    rgb_mix:           { category: "カラー",         name: "RGB混入",
        advice: "RGBのまま印刷すると意図しない色に変換されます(くすみ等)。オブジェクト・ドキュメントともCMYKに変換してください。" },
    spot_color:        { category: "カラー",         name: "特色",
        advice: "特色の使用有無・数は印刷仕様(カラー数)と一致している必要があります。不要な特色はプロセスカラーに変換してください。" },
    ink_total:         { category: "カラー",         name: "インキ総量",
        advice: "インキ総量が上限を超えると乾燥不良・裏移り・ブロッキングの原因になります。濃い部分の色値(特にリッチブラック)を調整してください。" },
    rich_black:        { category: "カラー",         name: "リッチブラック/4Cブラック",
        advice: "小さい文字や細線の4Cブラックは見当ズレで縁が滲みます。スミ文字・細線はK100単色にしてください。大面積のリッチブラックは意図的な場合があります。" },
    gray_usage:        { category: "カラー",         name: "グレースケールカラー使用",
        advice: "グレースケール(DeviceGray)カラーは出力設定によってK版以外に分解される場合があります。K単色(CMYKのK)への置き換えを検討してください。" },
    spot_quality:      { category: "カラー",         name: "特色の品質",
        advice: "特色名の機種依存文字や、同名で定義が異なる特色は、分版時の版ズレ・意図しない別版化の原因になります。特色名と定義を統一してください。" },
    artboard_colors:   { category: "カラー",         name: "アートボードごとの使用色数",
        advice: "使用している版数が印刷仕様と合わないと追加料金や刷り直しの原因になります。想定カラー数と一致させてください(画像内の色は未集計です)。" },
    blank_artboard:    { category: "カラー",         name: "白ページ(空アートボード)",
        advice: "空のアートボードは白ページのまま面付け・印刷される恐れがあります。不要であれば削除してください。" },
    image_missing:     { category: "画像",           name: "リンク切れ",
        advice: "リンク切れ画像は低解像度プレビューのまま出力される恐れがあります。リンクを再設定するか画像を埋め込んでください。" },
    image_colormode:   { category: "画像",           name: "画像カラーモード",
        advice: "RGB画像は出力時に色が変わります(くすみ等)。PhotoshopでCMYKに変換してから配置し直してください。" },
    image_resolution:  { category: "画像",           name: "実効解像度",
        advice: "解像度不足はぼやけ・ジャギーの原因、過剰解像度はデータ肥大・RIP負荷の原因になります。カラー/グレーは原寸300〜400dpi、モノクロ2値は600〜1200dpiを目安にしてください。" },
    transparency:      { category: "オブジェクト・効果", name: "透明効果",
        advice: "透明効果(不透明度・描画モード)は透明の分割・統合処理で予期しない結果になる場合があります。出力条件に応じて統合・ラスタライズを検討してください。" },
    gradient_mesh:     { category: "オブジェクト・効果", name: "グラデーションメッシュ",
        advice: "グラデーションメッシュは分版・RIP処理でトラブルになりやすい要素です。問題が出る場合はラスタライズ(画像化)を検討してください。" },
    pattern_usage:     { category: "オブジェクト・効果", name: "パターン使用",
        advice: "パターン塗りはRIP処理が重くなったり、環境によって再現が変わる場合があります。必要に応じて分割・拡張してください。" },
    object_count:      { category: "オブジェクト・効果", name: "オブジェクト総数",
        advice: "オブジェクト数が極端に多いとRIP処理に失敗する場合があります。不要パスの削減や複雑な部分の画像化を検討してください。" },
    thin_light_line:   { category: "オブジェクト・効果", name: "細ケイ+薄アミ",
        advice: "細い線に薄い色(低濃度アミ)を使うと印刷でかすれたり飛んだりします。線を太くするか濃度を上げてください。" },
    overprint:         { category: "その他",         name: "オーバープリント",
        advice: "意図しないオーバープリントは色の重なり事故になります。特に白のノセ(白オブジェクト+オーバープリント)は印刷で消えるため必ず解除してください。" },
    hairline:          { category: "その他",         name: "ヘアライン/極細線",
        advice: "0.25pt未満の線は印刷でかすれたり飛んだりします。0.3pt以上を目安に設定してください。" },
    raster_effect_res: { category: "その他",         name: "ラスタライズ効果解像度",
        advice: "ラスタライズ効果解像度が低いと、ドロップシャドウ・ぼかし等が粗く出力されます。[効果]>[ドキュメントのラスタライズ効果設定]で300ppi以上にしてください。" },
    unwanted:          { category: "その他",         name: "不要オブジェクト",
        advice: "非表示・アートボード外・孤立点などの不要オブジェクトは事故や誤出力の原因になります。入稿前に削除するか、意図的なものか確認してください。" }
};

var CATEGORY_ORDER = ["サイズとトンボ", "フォント", "カラー", "画像", "オブジェクト・効果", "その他"];

// -----------------------------------------------------------------------------
// 4. 色関連ユーティリティ
// -----------------------------------------------------------------------------

function colorTypeName(color) {
    if (!color) return "None";
    return safe(function () { return color.typename; }, "Unknown");
}

function isRegistrationSpot(spotColor) {
    return safe(function () {
        return spotColor.spot.colorType === ColorModel.REGISTRATION;
    }, false);
}

// 色が「白」相当かどうか(CMYK全0 / RGB全255 / Gray100 / 白のスポット系は対象外)
function isWhiteColor(color) {
    if (!color) return false;
    var t = colorTypeName(color);
    if (t === "CMYKColor") {
        return safe(function () {
            return color.cyan < 0.05 && color.magenta < 0.05 && color.yellow < 0.05 && color.black < 0.05;
        }, false);
    }
    if (t === "RGBColor") {
        return safe(function () {
            return color.red > 254.5 && color.green > 254.5 && color.blue > 254.5;
        }, false);
    }
    if (t === "GrayColor") {
        return safe(function () { return color.gray < 0.05; }, false); // Gray 0 = 白(ここでは0を白紙相当=塗りなしに近いとみなす)
    }
    return false;
}

// CMYK換算のインキ総量(%)を返す。CMYK以外はnullを返す(Spotは代替色から近似)
function cmykInkTotal(color) {
    if (!color) return null;
    var t = colorTypeName(color);
    if (t === "CMYKColor") {
        return safe(function () {
            return color.cyan + color.magenta + color.yellow + color.black;
        }, null);
    }
    if (t === "SpotColor") {
        // 代替カラー定義から近似計算(実際の特色インキ量とは異なる可能性がある旨をREADMEに明記)
        return safe(function () {
            var alt = color.spot.color;
            var tint = color.tint; // 0-100
            var base = cmykInkTotal(alt);
            if (base === null) return null;
            return base * (tint / 100);
        }, null);
    }
    return null; // RGB/Gray/Pattern/Gradient(呼び出し側でストップごとに処理)/None
}

function colorLabel(color) {
    if (!color) return "(なし)";
    var t = colorTypeName(color);
    if (t === "CMYKColor") {
        return safe(function () {
            return "C" + fmt(color.cyan, 1) + " M" + fmt(color.magenta, 1) + " Y" + fmt(color.yellow, 1) + " K" + fmt(color.black, 1);
        }, "CMYK");
    }
    if (t === "RGBColor") {
        return safe(function () {
            return "R" + Math.round(color.red) + " G" + Math.round(color.green) + " B" + Math.round(color.blue);
        }, "RGB");
    }
    if (t === "GrayColor") {
        return safe(function () { return "Gray" + fmt(color.gray, 1); }, "Gray");
    }
    if (t === "SpotColor") {
        return safe(function () { return "特色[" + color.spot.name + "] tint" + fmt(color.tint, 0) + "%"; }, "Spot");
    }
    if (t === "GradientColor") {
        return "グラデーション";
    }
    if (t === "PatternColor") {
        return "パターン";
    }
    if (t === "NoColor") {
        return "(塗り/線なし)";
    }
    return t;
}

// -----------------------------------------------------------------------------
// 5. 画像ファイルヘッダ解析(リンク画像のピクセルサイズ・カラーモード判定)
//    JPEG / PNG / TIFF / PSD / BMP / GIF に対応。それ以外は判定不能として要確認。
// -----------------------------------------------------------------------------

// ヘッダ解析で読み込む最大バイト数。
// 【重要】以前は1MB読み+全バイトのループ配列化を画像ごとに行っており、
// ExtendScriptでは1ファイルあたり100万回ループとなってフリーズの原因になっていた。
// ヘッダ判定に必要なのは先頭数百バイト〜数十KBのため、64KBに制限する。
// この範囲外を指すオフセット(TIFFのIFD等)は「判定不能→警告」で即打ち切る。
var HEADER_READ_BYTES = 65536;

// バイナリファイルの先頭を固定長(maxBytes)だけ1回で読み込み、
// バイト配列(0-255の数値配列)として返す。失敗時はnull。
function readBinaryBytes(file, maxBytes) {
    try {
        if (!file.exists) return null;
        file.encoding = "BINARY"; // BINARY必須(テキストエンコーディングだと激遅+値化け)
        var opened = file.open("r");
        if (!opened) return null;
        var raw = file.read(maxBytes);
        file.close();
        var n = raw.length;
        if (n > maxBytes) n = maxBytes; // 念のための上限ガード
        var bytes = new Array(n);
        for (var i = 0; i < n; i++) {
            bytes[i] = raw.charCodeAt(i) & 0xFF;
        }
        return bytes;
    } catch (e) {
        try { file.close(); } catch (e2) {}
        return null;
    }
}

function b16be(bytes, i) { return (bytes[i] << 8) | bytes[i + 1]; }
function b32be(bytes, i) { return ((bytes[i] * 16777216) + (bytes[i + 1] << 16) + (bytes[i + 2] << 8) + bytes[i + 3]); }
function b16le(bytes, i) { return (bytes[i + 1] << 8) | bytes[i]; }
function b32le(bytes, i) { return ((bytes[i + 3] * 16777216) + (bytes[i + 2] << 16) + (bytes[i + 1] << 8) + bytes[i]); }

// 同一ファイルを image_colormode / image_resolution で二重に読まないためのキャッシュ。
// runPreflight 実行のたびにリセットする。
var IMAGE_INFO_CACHE = {};

function getImageInfoCached(file) {
    var key = safe(function () { return file.fsName; }, null);
    if (key === null) return { ok: false };
    if (IMAGE_INFO_CACHE[key] !== undefined) return IMAGE_INFO_CACHE[key];
    var info;
    try {
        info = readImageInfo(file);
    } catch (e) {
        // 1ファイルの失敗で全体を止めない(判定不能=警告扱い)
        info = { ok: false };
    }
    IMAGE_INFO_CACHE[key] = info;
    return info;
}

// 戻り値: { ok:true, format, width, height, colorMode:"RGB"|"CMYK"|"GRAY"|"UNKNOWN", isBitmap:bool }
// または { ok:false }。isBitmap はモノクロ2値(1bit)画像と判定できた場合のみ true。
// 先頭 HEADER_READ_BYTES(64KB)のみで解析し、範囲外オフセットは判定不能として打ち切る。
function readImageInfo(file) {
    var bytes = readBinaryBytes(file, HEADER_READ_BYTES);
    if (!bytes || bytes.length < 16) return { ok: false };

    // --- PNG ---
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        if (bytes.length >= 26) {
            var w = b32be(bytes, 16);
            var h = b32be(bytes, 20);
            var bitDepth = bytes[24];
            var colorType = bytes[25];
            var mode = "RGB";
            if (colorType === 0 || colorType === 4) mode = "GRAY";
            else if (colorType === 2 || colorType === 6) mode = "RGB";
            else if (colorType === 3) mode = "RGB"; // インデックスカラー(パレットはRGB相当として扱う)
            var pngBitmap = (colorType === 0 && bitDepth === 1);
            return { ok: true, format: "PNG", width: w, height: h, colorMode: mode, isBitmap: pngBitmap };
        }
        return { ok: false };
    }

    // --- GIF ---
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
        if (bytes.length >= 10) {
            var gw = b16le(bytes, 6);
            var gh = b16le(bytes, 8);
            return { ok: true, format: "GIF", width: gw, height: gh, colorMode: "RGB", isBitmap: false };
        }
        return { ok: false };
    }

    // --- BMP ---
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
        if (bytes.length >= 26) {
            var bw = b32le(bytes, 18);
            var bh = b32le(bytes, 22);
            if (bh < 0) bh = -bh;
            var bmpBpp = (bytes.length >= 30) ? b16le(bytes, 28) : 24;
            return { ok: true, format: "BMP", width: bw, height: bh, colorMode: "RGB", isBitmap: (bmpBpp === 1) };
        }
        return { ok: false };
    }

    // --- PSD ---
    if (bytes[0] === 0x38 && bytes[1] === 0x42 && bytes[2] === 0x50 && bytes[3] === 0x53) {
        if (bytes.length >= 26) {
            var ph = b32be(bytes, 14);
            var pw = b32be(bytes, 18);
            var pdepth = bytes[22] * 256 + bytes[23];
            var pmode = bytes[24] * 256 + bytes[25];
            var pcm = "UNKNOWN";
            if (pmode === 0) pcm = "GRAY"; // Bitmapモード
            else if (pmode === 1 || pmode === 8) pcm = "GRAY";
            else if (pmode === 3) pcm = "RGB";
            else if (pmode === 4) pcm = "CMYK";
            return { ok: true, format: "PSD", width: pw, height: ph, colorMode: pcm, isBitmap: (pmode === 0 || pdepth === 1) };
        }
        return { ok: false };
    }

    // --- TIFF ---
    if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4D && bytes[1] === 0x4D)) {
        var little = (bytes[0] === 0x49);
        var r16 = little ? b16le : b16be;
        var r32 = little ? b32le : b32be;
        try {
            var magic = r16(bytes, 2);
            if (magic === 42) {
                var ifdOffset = r32(bytes, 4);
                // IFDが読み込み範囲(64KB)外を指す場合は判定不能として即打ち切り
                if (ifdOffset >= 0 && ifdOffset + 2 <= bytes.length) {
                    var numEntries = r16(bytes, ifdOffset);
                    if (numEntries > 512) numEntries = 512; // 壊れたヘッダ対策の反復上限
                    var tw = null, th = null, photometric = null, samples = null, bitsPerSample = null;
                    for (var e = 0; e < numEntries; e++) {
                        var entryOffset = ifdOffset + 2 + e * 12;
                        if (entryOffset + 12 > bytes.length) break;
                        var tag = r16(bytes, entryOffset);
                        var typ = r16(bytes, entryOffset + 2);
                        var valOff = entryOffset + 8;
                        var val;
                        if (typ === 3) { val = r16(bytes, valOff); } // SHORT
                        else { val = r32(bytes, valOff); } // LONG等
                        if (tag === 256) tw = val;
                        else if (tag === 257) th = val;
                        else if (tag === 262) photometric = val;
                        else if (tag === 277) samples = val;
                        else if (tag === 258) bitsPerSample = val; // 複数サンプル時はオフセット値になるが、1サンプル(2値)判定には十分
                    }
                    var tcm = "UNKNOWN";
                    if (photometric === 0 || photometric === 1) tcm = "GRAY";
                    else if (photometric === 2) tcm = "RGB";
                    else if (photometric === 5) tcm = "CMYK";
                    else if (samples === 4) tcm = "CMYK";
                    else if (samples === 3) tcm = "RGB";
                    else if (samples === 1) tcm = "GRAY";
                    var tiffBitmap = ((photometric === 0 || photometric === 1) && (samples === 1 || samples === null) && bitsPerSample === 1);
                    if (tw !== null && th !== null) {
                        return { ok: true, format: "TIFF", width: tw, height: th, colorMode: tcm, isBitmap: tiffBitmap };
                    }
                }
            }
        } catch (eTiff) {}
        return { ok: false };
    }

    // --- JPEG ---
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
        var pos = 2;
        var iterGuard = 0;
        try {
            while (pos < bytes.length - 4) {
                if (++iterGuard > 5000) break; // 壊れたデータでの走査上限(無限ループ防止)
                if (bytes[pos] !== 0xFF) { pos++; continue; }
                var marker = bytes[pos + 1];
                if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
                    pos += 2;
                    continue;
                }
                if (marker === 0xD9) break; // EOI
                var segLen = b16be(bytes, pos + 2);
                if (segLen < 2) break; // 不正なセグメント長は打ち切り(判定不能)
                var isSOF = (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC);
                if (isSOF) {
                    var jh = b16be(bytes, pos + 5);
                    var jw = b16be(bytes, pos + 7);
                    var comps = bytes[pos + 9];
                    var jcm = "UNKNOWN";
                    if (comps === 1) jcm = "GRAY";
                    else if (comps === 3) jcm = "RGB";
                    else if (comps === 4) jcm = "CMYK";
                    return { ok: true, format: "JPEG", width: jw, height: jh, colorMode: jcm, isBitmap: false };
                }
                pos += 2 + segLen;
            }
        } catch (eJpg) {}
        return { ok: false };
    }

    return { ok: false }; // AI/EPS/PDF/WEBP等、未対応形式
}

// -----------------------------------------------------------------------------
// 6. ドキュメント全体スキャン(再帰は1回のみ・各チェックはこの結果を共有する)
// -----------------------------------------------------------------------------

function scanDocument(doc, progressCb) {
    var items = [];
    var scanCount = { n: 0 };

    function pushRecord(item, layerName, hiddenInherited, lockedInherited) {
        var rec = {
            item: item,
            typename: safe(function () { return item.typename; }, "Unknown"),
            layerName: layerName,
            hiddenSelf: safe(function () { return item.hidden; }, false),
            hiddenInherited: hiddenInherited,
            lockedSelf: safe(function () { return item.locked; }, false),
            lockedInherited: lockedInherited,
            geometricBounds: safe(function () { return item.geometricBounds; }, null),
            visibleBounds: safe(function () { return item.visibleBounds; }, null)
        };
        items.push(rec);
        scanCount.n++;
        if (scanCount.n % 25 === 0) {
            throwIfAborted(); // 25件ごとに中断(ESC)を確認
            if (progressCb) progressCb(scanCount.n);
        }
        return rec;
    }

    function walkItem(item, layerName, hiddenInherited, lockedInherited) {
        var selfHidden = safe(function () { return item.hidden; }, false);
        var selfLocked = safe(function () { return item.locked; }, false);
        var nowHidden = hiddenInherited || selfHidden;
        var nowLocked = lockedInherited || selfLocked;
        pushRecord(item, layerName, nowHidden, nowLocked);

        var tn = safe(function () { return item.typename; }, "");
        if (tn === "GroupItem") {
            var kids = safe(function () { return item.pageItems; }, null);
            if (kids) {
                for (var i = 0; i < kids.length; i++) {
                    walkItem(kids[i], layerName, nowHidden, nowLocked);
                }
            }
        }
    }

    function walkLayer(layer, hiddenInherited, lockedInherited) {
        var lHidden = hiddenInherited || !layer.visible;
        var lLocked = lockedInherited || layer.locked;
        var kids = safe(function () { return layer.pageItems; }, null);
        if (kids) {
            for (var i = 0; i < kids.length; i++) {
                walkItem(kids[i], layer.name, lHidden, lLocked);
            }
        }
        var subLayers = safe(function () { return layer.layers; }, null);
        if (subLayers) {
            for (var j = 0; j < subLayers.length; j++) {
                walkLayer(subLayers[j], lHidden, lLocked);
            }
        }
    }

    for (var li = 0; li < doc.layers.length; li++) {
        walkLayer(doc.layers[li], false, false);
    }

    return items;
}

// -----------------------------------------------------------------------------
// 7. アートボード・トリム枠(仕上がり枠)関連ヘルパー
// -----------------------------------------------------------------------------

function getTargetSizeMM(cfg) {
    if (cfg.sizeKey === "CUSTOM") {
        return [cfg.customWidthMM, cfg.customHeightMM];
    }
    var p = SIZE_PRESET_MM[cfg.sizeKey];
    return p ? [p[0], p[1]] : [cfg.customWidthMM, cfg.customHeightMM];
}

function rectWmm(rect) { return pt2mm(rect[2] - rect[0]); }
function rectHmm(rect) { return pt2mm(rect[1] - rect[3]); }

// 縦横入替を許容してサイズが一致するか判定
function sizeMatches(wMM, hMM, targetW, targetH, tol) {
    var direct = (Math.abs(wMM - targetW) <= tol && Math.abs(hMM - targetH) <= tol);
    var swapped = (Math.abs(wMM - targetH) <= tol && Math.abs(hMM - targetW) <= tol);
    return direct || swapped;
}

// 矩形の中心が別矩形内にあるか
function centerInside(inner, outer) {
    var cx = (inner[0] + inner[2]) / 2;
    var cy = (inner[1] + inner[3]) / 2;
    return (cx >= outer[0] && cx <= outer[2] && cy <= outer[1] && cy >= outer[3]);
}

// パスが軸並行の矩形(4点、直線のみ)かどうかを簡易判定
function isAxisAlignedRectPath(item) {
    if (safe(function () { return item.typename; }, "") !== "PathItem") return false;
    var pts = safe(function () { return item.pathPoints; }, null);
    if (!pts || pts.length !== 4) return false;
    for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        var anchor = p.anchor;
        var lin = safe(function () { return p.leftDirection[0] === anchor[0] && p.leftDirection[1] === anchor[1] &&
            p.rightDirection[0] === anchor[0] && p.rightDirection[1] === anchor[1]; }, true);
        if (!lin) return false;
    }
    return true;
}

// アートボードのトリム枠(仕上がり枠)を検出する
// 戻り値: { matched:bool, source:string, trimRect:[l,t,r,b], sizeMM:[w,h], note:string }
function detectTrimBox(doc, ab, allItems, cfg) {
    var abRect = ab.artboardRect;
    var abW = rectWmm(abRect);
    var abH = rectHmm(abRect);
    var target = getTargetSizeMM(cfg);
    var tol = cfg.sizeToleranceMM;

    // 1) アートボード=仕上がりサイズそのもの
    if (sizeMatches(abW, abH, target[0], target[1], tol)) {
        return { matched: true, source: "artboard", trimRect: abRect, sizeMM: [abW, abH], note: "アートボードのサイズが仕上がりサイズと一致" };
    }

    // 2) アートボード内にある、仕上がりサイズと一致する矩形パス(トンボ運用時のガイド枠)を探す
    var best = null;
    for (var i = 0; i < allItems.length; i++) {
        var rec = allItems[i];
        if (rec.hiddenInherited) continue;
        if (!isAxisAlignedRectPath(rec.item)) continue;
        var gb = rec.geometricBounds;
        if (!gb) continue;
        var w = rectWmm(gb);
        var h = rectHmm(gb);
        if (sizeMatches(w, h, target[0], target[1], tol)) {
            if (centerInside(gb, abRect)) {
                best = gb;
                break;
            }
        }
    }
    if (best) {
        return { matched: true, source: "guide", trimRect: best, sizeMM: [rectWmm(best), rectHmm(best)], note: "アートボード内の矩形パス(仕上がりサイズ相当)を検出" };
    }

    // 3) アートボード = 仕上がり + 塗り足し(全周)と仮定して縮小してみる
    var bleedPt = mm2pt(cfg.bleedMM);
    var shrunk = [abRect[0] + bleedPt, abRect[1] - bleedPt, abRect[2] - bleedPt, abRect[3] + bleedPt];
    var sw = rectWmm(shrunk);
    var sh = rectHmm(shrunk);
    if (sw > 0 && sh > 0 && sizeMatches(sw, sh, target[0], target[1], tol)) {
        return { matched: true, source: "artboard-bleed", trimRect: shrunk, sizeMM: [sw, sh], note: "アートボードから塗り足し分を差し引いたサイズが一致(トンボなし・塗り足し込みアートボード運用と推定)" };
    }

    // 4) 判定不能
    return { matched: false, source: "unknown", trimRect: abRect, sizeMM: [abW, abH], note: "仕上がりサイズと一致する枠を自動検出できませんでした" };
}

// -----------------------------------------------------------------------------
// 8. 検査結果ヘルパー
// -----------------------------------------------------------------------------

// status: "OK" | "NG"(エラー) | "WARN"(警告/要確認) | "INFO"(情報) | "SKIP"(対象外)
function makeResult(id, status, summary, details, note) {
    var meta = CHECK_META[id];
    return {
        id: id,
        category: meta.category,
        name: meta.name,
        status: status,
        summary: summary,
        details: details || [], // [{ text:string, item:pageItemOrNull }]
        note: note || "",
        advice: meta.advice || ""
    };
}

function statusLabelOf(status) {
    if (status === "OK") return "OK";
    if (status === "NG") return "エラー";
    if (status === "WARN") return "警告";
    if (status === "INFO") return "情報";
    return "-";
}

function detailItem(text, item) {
    return { text: text, item: item || null };
}

// -----------------------------------------------------------------------------
// 9. 各チェック関数
//    シグネチャ: function(doc, cfg, ctx) -> result
//    ctx = { items: scanResult, artboardTrims: [...], primaryTrim: {...} }
// -----------------------------------------------------------------------------

var CHECKS = {};

// --- 9.1 データサイズ照合 ---
CHECKS.size_match = function (doc, cfg, ctx) {
    var target = getTargetSizeMM(cfg);
    var details = [];
    var ngCount = 0, warnCount = 0;
    for (var i = 0; i < ctx.artboardTrims.length; i++) {
        var t = ctx.artboardTrims[i];
        var label = "アートボード" + (i + 1) + "(" + doc.artboards[i].name + ")";
        if (t.matched) {
            if (t.source === "artboard") {
                details.push(detailItem(label + ": 一致 " + fmt(t.sizeMM[0], 1) + "×" + fmt(t.sizeMM[1], 1) + "mm", null));
            } else {
                details.push(detailItem(label + ": " + t.note + " -> " + fmt(t.sizeMM[0], 1) + "×" + fmt(t.sizeMM[1], 1) + "mm", null));
                warnCount++;
            }
        } else {
            details.push(detailItem(label + ": 仕上がりサイズ(" + target[0] + "×" + target[1] + "mm ±" + cfg.sizeToleranceMM + "mm)と一致しません。検出アートボードサイズ " + fmt(t.sizeMM[0], 1) + "×" + fmt(t.sizeMM[1], 1) + "mm", null));
            warnCount++;
        }
    }
    var status = (warnCount === 0) ? "OK" : "WARN";
    var summary = (warnCount === 0) ? "全アートボードが仕上がりサイズと一致" : (warnCount + "件 要確認");
    return makeResult("size_match", status, summary, details, "トンボ運用等でアートボードと仕上がりサイズが異なる場合は自動検出結果を目視確認してください。");
};

// --- 9.2 塗り足し ---
CHECKS.bleed = function (doc, cfg, ctx) {
    var bleedPt = mm2pt(cfg.bleedMM);
    var details = [];
    var ngCount = 0;
    for (var a = 0; a < ctx.artboardTrims.length; a++) {
        var trim = ctx.artboardTrims[a].trimRect;
        var outerBleed = [trim[0] - bleedPt, trim[1] + bleedPt, trim[2] + bleedPt, trim[3] - bleedPt];
        for (var i = 0; i < ctx.items.length; i++) {
            var rec = ctx.items[i];
            if (rec.hiddenInherited) continue;
            if (rec.typename === "GroupItem") continue; // グループ自体は子要素で判定
            var gb = rec.visibleBounds || rec.geometricBounds;
            if (!gb) continue;
            // 仕上がり線をまたぐ(=trim境界の内外にオブジェクトが跨っている)かどうか
            var crossesTrim =
                (gb[0] < trim[0] || gb[2] > trim[2] || gb[1] > trim[1] || gb[3] < trim[3]) &&
                (gb[0] < trim[2] && gb[2] > trim[0] && gb[1] > trim[3] && gb[3] < trim[1]);
            if (!crossesTrim) continue;
            // 塗り足し線まで届いているか(4辺それぞれ判定し、はみ出している側だけ確認)
            var insufficientSides = [];
            if (gb[0] > trim[0] && gb[0] > outerBleed[0]) { /* 左辺はトリム内側=断ち落としでない */ }
            if (gb[0] < trim[0] && gb[0] > outerBleed[0]) insufficientSides.push("左");
            if (gb[2] > trim[2] && gb[2] < outerBleed[2]) insufficientSides.push("右");
            if (gb[1] > trim[1] && gb[1] < outerBleed[1]) insufficientSides.push("上");
            if (gb[3] < trim[3] && gb[3] > outerBleed[3]) insufficientSides.push("下");
            if (insufficientSides.length > 0) {
                ngCount++;
                details.push(detailItem("塗り足し不足(" + joinArr(insufficientSides, "・") + "辺): " + describeItem(rec, doc), rec.item));
            }
        }
    }
    var status = ngCount > 0 ? "NG" : "OK";
    var summary = ngCount > 0 ? (ngCount + "件 塗り足し不足") : "断ち落とし要素はすべて塗り足し確保済み";
    return makeResult("bleed", status, summary, details, "仕上がり線をまたぐオブジェクトのみを対象にしています。");
};

// --- 9.3 トンボ有無 ---
CHECKS.tombo = function (doc, cfg, ctx) {
    var found = 0;
    var details = [];
    for (var a = 0; a < ctx.artboardTrims.length; a++) {
        var trim = ctx.artboardTrims[a].trimRect;
        var searchOuter = [trim[0] - mm2pt(15), trim[1] + mm2pt(15), trim[2] + mm2pt(15), trim[3] - mm2pt(15)];
        var cnt = 0;
        for (var i = 0; i < ctx.items.length; i++) {
            var rec = ctx.items[i];
            if (rec.typename !== "PathItem") continue;
            if (rec.hiddenInherited) continue;
            var item = rec.item;
            var isLine = safe(function () { return item.pathPoints.length === 2 && !item.closed; }, false);
            if (!isLine) continue;
            var sw = safe(function () { return item.strokeWidth; }, 0);
            if (!(sw > 0 && sw <= 1.2)) continue;
            var gb = rec.geometricBounds;
            if (!gb) continue;
            // アートボード内(仕上がり枠の内側)にはみ出さず、探索範囲内にあるか
            var withinSearch = (gb[0] >= searchOuter[0] && gb[2] <= searchOuter[2] && gb[1] <= searchOuter[1] && gb[3] >= searchOuter[3]);
            var outsideTrim = (gb[0] < trim[0] - 0.2 || gb[2] > trim[2] + 0.2 || gb[1] > trim[1] + 0.2 || gb[3] < trim[3] - 0.2);
            if (withinSearch && outsideTrim) {
                cnt++;
            }
        }
        found += cnt;
        if (cnt > 0) {
            details.push(detailItem("アートボード" + (a + 1) + ": トンボらしき細線パスを" + cnt + "本検出", null));
        }
    }
    var status = found >= 4 ? "OK" : "WARN";
    var summary = found >= 4 ? "トンボを検出(" + found + "本)" : "トンボを検出できませんでした(" + found + "本)";
    return makeResult("tombo", status, summary, details, "PDF書き出し時にトンボを自動付与する運用もあるため、未検出でもNGにはしていません。目視確認してください。");
};

function findContainingArtboard(doc, gb) {
    if (!gb) return null;
    var cx = (gb[0] + gb[2]) / 2;
    var cy = (gb[1] + gb[3]) / 2;
    for (var i = 0; i < doc.artboards.length; i++) {
        var r = doc.artboards[i].artboardRect;
        if (cx >= r[0] && cx <= r[2] && cy <= r[1] && cy >= r[3]) {
            return i;
        }
    }
    return null;
}

function describeItem(rec, doc) {
    var gb = rec.geometricBounds;
    var posText = "";
    if (gb) {
        var abIdx = findContainingArtboard(doc, gb);
        if (abIdx !== null) {
            posText = "アートボード" + (abIdx + 1);
        } else {
            posText = "座標(" + fmt(pt2mm(gb[0]), 1) + "," + fmt(pt2mm(gb[1]), 1) + ")mm";
        }
    }
    var nameText = safe(function () { return rec.item.name; }, "");
    return rec.typename + (nameText ? "[" + nameText + "]" : "") + (posText ? " / " + posText : "") + " / レイヤー:" + rec.layerName;
}

// --- 9.4 アウトライン化 ---
CHECKS.font_outline = function (doc, cfg, ctx) {
    var texts = [];
    for (var i = 0; i < ctx.items.length; i++) {
        if (ctx.items[i].typename === "TextFrame") texts.push(ctx.items[i]);
    }
    var details = [];
    for (var j = 0; j < texts.length; j++) {
        var rec = texts[j];
        var item = rec.item;
        var content = safe(function () { return item.contents; }, "");
        var head = content ? content.substring(0, 20) : "(空)";
        var fontName = safe(function () { return item.textRange.characterAttributes.textFont.name; }, "取得不可");
        details.push(detailItem("「" + head + (content && content.length > 20 ? "…" : "") + "」 / フォント:" + fontName + " / " + describeItem(rec, doc), item));
    }
    var status = texts.length > 0 ? "NG" : "OK";
    var summary = texts.length > 0 ? (texts.length + "件 未アウトライン") : "テキストフレームなし(アウトライン化済み)";
    return makeResult("font_outline", status, summary, details, "シンボル内部やグラフ内のテキストは検出できない場合があります。別途目視確認してください。");
};

// --- 9.5 文字セーフマージン ---
CHECKS.text_margin = function (doc, cfg, ctx) {
    var texts = [];
    for (var i = 0; i < ctx.items.length; i++) {
        if (ctx.items[i].typename === "TextFrame" && !ctx.items[i].hiddenInherited) texts.push(ctx.items[i]);
    }
    if (texts.length === 0) {
        return makeResult("text_margin", "SKIP", "-(テキストなし)", [], "全テキストがアウトライン化済み、またはテキストが存在しないためスキップしました。");
    }
    var marginPt = mm2pt(cfg.textMarginMM);
    var details = [];
    var ngCount = 0;
    for (var a = 0; a < ctx.artboardTrims.length; a++) {
        var trim = ctx.artboardTrims[a].trimRect;
        var safeRect = [trim[0] + marginPt, trim[1] - marginPt, trim[2] - marginPt, trim[3] + marginPt];
        for (var j = 0; j < texts.length; j++) {
            var rec = texts[j];
            var gb = rec.geometricBounds;
            if (!gb) continue;
            var abIdx = findContainingArtboard(doc, gb);
            if (abIdx !== a) continue;
            if (gb[0] < safeRect[0] || gb[2] > safeRect[2] || gb[1] > safeRect[1] || gb[3] < safeRect[3]) {
                ngCount++;
                details.push(detailItem("セーフマージン外: " + describeItem(rec, doc), rec.item));
            }
        }
    }
    var status = ngCount > 0 ? "NG" : "OK";
    var summary = ngCount > 0 ? (ngCount + "件 マージン外") : "全テキストがセーフマージン内";
    return makeResult("text_margin", status, summary, details, "");
};

// --- 9.6 RGB混入 ---
CHECKS.rgb_mix = function (doc, cfg, ctx) {
    var details = [];
    var ngCount = 0;
    var docIsRGB = safe(function () { return doc.documentColorSpace === DocumentColorSpace.RGB; }, false);
    if (docIsRGB) {
        ngCount++;
        details.push(detailItem("ドキュメントのカラーモード自体がRGBです(CMYKに変換してください)", null));
    }
    for (var i = 0; i < ctx.items.length; i++) {
        var rec = ctx.items[i];
        var item = rec.item;
        var fillColor = safe(function () { return item.fillColor; }, null);
        var strokeColor = safe(function () { return item.strokeColor; }, null);
        if (colorTypeName(fillColor) === "RGBColor") {
            ngCount++;
            details.push(detailItem("塗りがRGB: " + describeItem(rec, doc), item));
        }
        if (colorTypeName(strokeColor) === "RGBColor") {
            ngCount++;
            details.push(detailItem("線がRGB: " + describeItem(rec, doc), item));
        }
        // グラデーションストップ
        checkGradientColors(fillColor, rec, doc, function (stopColor) {
            if (colorTypeName(stopColor) === "RGBColor") {
                ngCount++;
                details.push(detailItem("グラデーション(塗り)にRGBストップ: " + describeItem(rec, doc), item));
            }
        });
        checkGradientColors(strokeColor, rec, doc, function (stopColor) {
            if (colorTypeName(stopColor) === "RGBColor") {
                ngCount++;
                details.push(detailItem("グラデーション(線)にRGBストップ: " + describeItem(rec, doc), item));
            }
        });
    }
    var status = ngCount > 0 ? "NG" : "OK";
    var summary = ngCount > 0 ? (ngCount + "件 RGB使用") : "RGB混入なし";
    return makeResult("rgb_mix", status, summary, details, "");
};

function checkGradientColors(color, rec, doc, cb) {
    if (colorTypeName(color) !== "GradientColor") return;
    safe(function () {
        var stops = color.gradient.gradientStops;
        for (var i = 0; i < stops.length; i++) {
            cb(stops[i].color);
        }
    }, null);
}

// --- 9.7 特色 ---
CHECKS.spot_color = function (doc, cfg, ctx) {
    var details = [];
    var status = "OK";
    var spotUsage = {}; // name -> count
    var registrationMisuse = 0;
    var processUsedWhenMono = 0;
    var processUsedWhenSpotOnly = 0;
    var spotUsedWhenCmyk4 = 0;

    function registerSpot(spotColor) {
        var name = safe(function () { return spotColor.spot.name; }, "(不明)");
        if (!spotUsage[name]) spotUsage[name] = 0;
        spotUsage[name]++;
    }

    function isNonWhiteProcessColor(color) {
        var t = colorTypeName(color);
        if (t === "CMYKColor") {
            return safe(function () { return (color.cyan > 0.05 || color.magenta > 0.05 || color.yellow > 0.05 || color.black > 0.05); }, false);
        }
        if (t === "RGBColor") return true;
        if (t === "GrayColor") return safe(function () { return color.gray < 99.95; }, false);
        return false;
    }

    function isNonBlackProcessColor(color) {
        // K以外の成分(C/M/Y)、またはRGBを使用しているか
        var t = colorTypeName(color);
        if (t === "CMYKColor") {
            return safe(function () { return (color.cyan > 0.05 || color.magenta > 0.05 || color.yellow > 0.05); }, false);
        }
        if (t === "RGBColor") return true;
        return false;
    }

    for (var i = 0; i < ctx.items.length; i++) {
        var rec = ctx.items[i];
        var item = rec.item;
        var fillColor = safe(function () { return item.fillColor; }, null);
        var strokeColor = safe(function () { return item.strokeColor; }, null);
        var colorsToCheck = [];
        if (fillColor) colorsToCheck.push({ c: fillColor, label: "塗り" });
        if (strokeColor) colorsToCheck.push({ c: strokeColor, label: "線" });

        for (var c = 0; c < colorsToCheck.length; c++) {
            var col = colorsToCheck[c].c;
            var label = colorsToCheck[c].label;
            var t = colorTypeName(col);
            if (t === "SpotColor") {
                if (isRegistrationSpot(col)) {
                    // トンボ想定範囲(アートボード近傍)以外での使用はNG
                    var gb = rec.geometricBounds;
                    var nearTombo = false;
                    if (gb) {
                        for (var a = 0; a < ctx.artboardTrims.length; a++) {
                            var trim = ctx.artboardTrims[a].trimRect;
                            var outer = [trim[0] - mm2pt(15), trim[1] + mm2pt(15), trim[2] + mm2pt(15), trim[3] - mm2pt(15)];
                            if (gb[0] >= outer[0] && gb[2] <= outer[2] && gb[1] <= outer[1] && gb[3] >= outer[3]) {
                                var outsideTrim2 = (gb[0] < trim[0] - 0.2 || gb[2] > trim[2] + 0.2 || gb[1] > trim[1] + 0.2 || gb[3] < trim[3] - 0.2);
                                if (outsideTrim2) { nearTombo = true; break; }
                            }
                        }
                    }
                    if (!nearTombo) {
                        registrationMisuse++;
                        details.push(detailItem("レジストレーションカラーの誤用(" + label + "): " + describeItem(rec, doc), item));
                    }
                } else {
                    registerSpot(col);
                    if (cfg.colorModeKey === "CMYK4") {
                        spotUsedWhenCmyk4++;
                        details.push(detailItem("特色使用(" + label + " " + colorLabel(col) + "): " + describeItem(rec, doc), item));
                    } else if (cfg.colorModeKey === "MONO1") {
                        processUsedWhenMono++;
                        details.push(detailItem("モノクロ指定なのに特色使用(" + label + " " + colorLabel(col) + "): " + describeItem(rec, doc), item));
                    }
                }
            } else if (cfg.colorModeKey === "MONO1" && isNonBlackProcessColor(col)) {
                processUsedWhenMono++;
                details.push(detailItem("モノクロ指定なのにK以外の色を使用(" + label + " " + colorLabel(col) + "): " + describeItem(rec, doc), item));
            } else if (cfg.colorModeKey === "SPOTONLY" && isNonBlackProcessColor(col)) {
                processUsedWhenSpotOnly++;
                details.push(detailItem("特色のみ指定なのにプロセスカラーを使用(" + label + " " + colorLabel(col) + "): " + describeItem(rec, doc), item));
            }
        }
    }

    var spotNames = [];
    for (var name in spotUsage) { if (spotUsage.hasOwnProperty(name)) spotNames.push(name + "(" + spotUsage[name] + "件)"); }

    var ngCount = registrationMisuse + spotUsedWhenCmyk4 + processUsedWhenMono + processUsedWhenSpotOnly;
    var note = "";
    if (cfg.colorModeKey === "CMYK4SPOT" || cfg.colorModeKey === "SPOTONLY") {
        details.push(detailItem("使用特色一覧: " + (spotNames.length ? joinArr(spotNames, ", ") : "(特色未使用)"), null));
        if (cfg.expectedSpotCount > 0) {
            var actualCount = 0;
            for (var nm in spotUsage) { if (spotUsage.hasOwnProperty(nm)) actualCount++; }
            if (actualCount !== cfg.expectedSpotCount) {
                note = "想定特色数(" + cfg.expectedSpotCount + ")と実使用数(" + actualCount + ")が一致しません。要確認。";
            }
        }
    }

    var status2 = ngCount > 0 ? "NG" : (note ? "WARN" : "OK");
    var summary = ngCount > 0 ? (ngCount + "件 NG") : (note ? "要確認あり" : "印刷カラー数設定と整合");
    return makeResult("spot_color", status2, summary, details, note);
};

// --- 9.8 インキ総量 ---
CHECKS.ink_total = function (doc, cfg, ctx) {
    var details = [];
    var ngCount = 0;

    // ES3では関数宣言をループ内に置けないため、対象情報を引数で受け取るヘルパーを外に定義
    var checkInkColor = function (col, label, rec, item) {
        var total = cmykInkTotal(col);
        if (total !== null && total > cfg.maxInkPercent) {
            ngCount++;
            details.push(detailItem("インキ総量超過(" + fmt(total, 0) + "%) " + label + " " + colorLabel(col) + ": " + describeItem(rec, doc), item));
        }
    };

    for (var i = 0; i < ctx.items.length; i++) {
        var rec = ctx.items[i];
        var item = rec.item;
        if (rec.typename === "RasterItem" || rec.typename === "PlacedItem") continue; // 画像内部は対象外
        var fillColor = safe(function () { return item.fillColor; }, null);
        var strokeColor = safe(function () { return item.strokeColor; }, null);

        checkInkColor(fillColor, "塗り", rec, item);
        checkInkColor(strokeColor, "線", rec, item);

        (function (rec2, item2) {
            checkGradientColors(fillColor, rec2, doc, function (stopColor) { checkInkColor(stopColor, "グラデーション(塗り)ストップ", rec2, item2); });
            checkGradientColors(strokeColor, rec2, doc, function (stopColor) { checkInkColor(stopColor, "グラデーション(線)ストップ", rec2, item2); });
        })(rec, item);
    }
    var status = ngCount > 0 ? "NG" : "OK";
    var summary = ngCount > 0 ? (ngCount + "件 総量超過(上限" + cfg.maxInkPercent + "%)") : "インキ総量は上限内";
    return makeResult("ink_total", status, summary, details, "画像内部のインキ総量は対象外です(要確認・別途RIP等でご確認ください)。特色のインキ量は代替カラー定義からの近似値です。");
};

// --- 9.8b リッチブラック/4Cブラック検出 ---
// K高濃度(70%以上)かつCMY成分が乗っている塗り/線を検出。
// 小さい文字・細線(見当ズレ事故のもと)はNG、大面積はINFO(情報)として列挙する。
CHECKS.rich_black = function (doc, cfg, ctx) {
    var details = [];
    var ngCount = 0, infoCount = 0;

    var isRichBlack = function (col) {
        if (colorTypeName(col) !== "CMYKColor") return false;
        return safe(function () {
            return col.black >= 70 && (col.cyan > 5 || col.magenta > 5 || col.yellow > 5);
        }, false);
    };

    for (var i = 0; i < ctx.items.length; i++) {
        var rec = ctx.items[i];
        var item = rec.item;
        var tn = rec.typename;
        var fillColor = safe(function () { return item.fillColor; }, null);
        var strokeColor = safe(function () { return item.strokeColor; }, null);
        // テキストフレームは textRange 側から色を取る
        if (tn === "TextFrame") {
            fillColor = safe(function () { return item.textRange.characterAttributes.fillColor; }, null);
            strokeColor = safe(function () { return item.textRange.characterAttributes.strokeColor; }, null);
        }

        var fillRich = isRichBlack(fillColor);
        var strokeRich = isRichBlack(strokeColor);
        if (!fillRich && !strokeRich) continue;

        // 「小さい/細い」判定: テキスト、細線、または面積が小さいオブジェクト
        var isSmall = false;
        if (tn === "TextFrame") {
            isSmall = true;
        } else if (strokeRich) {
            var sw = safe(function () { return item.strokeWidth; }, 999);
            if (sw <= 2) isSmall = true;
        }
        if (!isSmall && fillRich) {
            var gb = rec.geometricBounds;
            if (gb) {
                var areaMM2 = pt2mm(gb[2] - gb[0]) * pt2mm(gb[1] - gb[3]);
                if (areaMM2 < 1000) isSmall = true; // 約31.6mm四方未満は小サイズ扱い
            }
        }

        var colDesc = fillRich ? ("塗り " + colorLabel(fillColor)) : ("線 " + colorLabel(strokeColor));
        if (isSmall) {
            ngCount++;
            details.push(detailItem("小サイズの4Cブラック/リッチブラック(" + colDesc + "): " + describeItem(rec, doc), item));
        } else {
            infoCount++;
            details.push(detailItem("[情報] 大面積のリッチブラック(" + colDesc + "): " + describeItem(rec, doc), item));
        }
    }
    var status = ngCount > 0 ? "NG" : (infoCount > 0 ? "INFO" : "OK");
    var summary = ngCount > 0 ? (ngCount + "件 小サイズ4Cブラック(情報" + infoCount + "件)") :
        (infoCount > 0 ? (infoCount + "件 大面積リッチブラック(情報)") : "リッチブラック/4Cブラックなし");
    return makeResult("rich_black", status, summary, details, "判定基準: K70%以上かつC/M/Yいずれか5%超。テキスト・2pt以下の線・約1000mm²未満の塗りを「小サイズ」としています。");
};

// --- 9.8c グレースケールカラー(DeviceGray)使用検出 ---
CHECKS.gray_usage = function (doc, cfg, ctx) {
    var details = [];
    var count = 0;
    for (var i = 0; i < ctx.items.length; i++) {
        var rec = ctx.items[i];
        var item = rec.item;
        var fillColor = safe(function () { return item.fillColor; }, null);
        var strokeColor = safe(function () { return item.strokeColor; }, null);
        if (colorTypeName(fillColor) === "GrayColor") {
            count++;
            details.push(detailItem("塗りがグレースケール(" + colorLabel(fillColor) + "): " + describeItem(rec, doc), item));
        }
        if (colorTypeName(strokeColor) === "GrayColor") {
            count++;
            details.push(detailItem("線がグレースケール(" + colorLabel(strokeColor) + "): " + describeItem(rec, doc), item));
        }
    }
    if (cfg.colorModeKey === "MONO1") {
        // 1色モノクロ設定時はグレースケール使用は問題なし
        var st = count > 0 ? "INFO" : "OK";
        return makeResult("gray_usage", st, count > 0 ? (count + "件 使用(モノクロ設定のためOK扱い)") : "グレースケールカラー未使用", details, "1色モノクロ設定のため、グレースケールカラーの使用は情報表示のみです。");
    }
    var status = count > 0 ? "WARN" : "OK";
    var summary = count > 0 ? (count + "件 使用(要確認)") : "グレースケールカラー未使用";
    return makeResult("gray_usage", status, summary, details, "");
};

// --- 9.8d 特色の品質チェック ---
CHECKS.spot_quality = function (doc, cfg, ctx) {
    var details = [];
    var warnCount = 0, infoCount = 0;
    var spots = safe(function () { return doc.spots; }, null);
    if (!spots) {
        return makeResult("spot_quality", "WARN", "特色情報を取得できませんでした", [], "要確認としています。");
    }
    var nameDefs = {}; // 特色名(小文字) -> [定義文字列, 元の名前]
    for (var i = 0; i < spots.length; i++) {
        var sp = spots[i];
        var name = safe(function () { return sp.name; }, "(不明)");
        if (safe(function () { return sp.colorType === ColorModel.REGISTRATION; }, false)) continue;

        // 禁止/機種依存文字チェック(ASCII英数字・スペース・ハイフン・アンダースコア以外を警告)
        if (/[&<>\"\'\/\\%#;:]/.test(name)) {
            warnCount++;
            details.push(detailItem("特色名に禁止/機種依存になりやすい文字が含まれています: 「" + name + "」", null));
        }

        // 代替色定義の色空間を表示
        var altColor = safe(function () { return sp.color; }, null);
        var altType = colorTypeName(altColor);
        var spaceLabel = "不明";
        if (altType === "LabColor") spaceLabel = "Lab";
        else if (altType === "CMYKColor") spaceLabel = "CMYK(" + colorLabel(altColor) + ")";
        else if (altType === "RGBColor") spaceLabel = "RGB(" + colorLabel(altColor) + ")";
        else spaceLabel = altType;
        infoCount++;
        details.push(detailItem("[情報] 特色「" + name + "」の代替色定義: " + spaceLabel, null));

        // 同名(大文字小文字違い等)で定義の異なる特色チェック
        var lower = name.toLowerCase().replace(/\s+/g, "");
        var defStr = altType + ":" + colorLabel(altColor);
        if (nameDefs[lower] !== undefined) {
            if (nameDefs[lower][0] !== defStr) {
                warnCount++;
                details.push(detailItem("同名(または名前ゆれ)で定義の異なる特色: 「" + nameDefs[lower][1] + "」と「" + name + "」", null));
            }
        } else {
            nameDefs[lower] = [defStr, name];
        }
    }
    var status = warnCount > 0 ? "WARN" : (infoCount > 0 ? "INFO" : "OK");
    var summary = warnCount > 0 ? (warnCount + "件 警告") : (infoCount > 0 ? "特色定義を確認してください(情報)" : "特色未定義");
    return makeResult("spot_quality", status, summary, details, "特色名はRIPでの分版名に使われるため、ASCII英数字での命名を推奨します。");
};

// --- 9.8e アートボードごとの使用色数(版数)判定 ---
CHECKS.artboard_colors = function (doc, cfg, ctx) {
    var details = [];
    var ngCount = 0, warnCount = 0;

    // 色から版名の配列を返す
    var platesOfColor = function (col) {
        var plates = [];
        var t = colorTypeName(col);
        if (t === "CMYKColor") {
            safe(function () {
                if (col.cyan > 0.05) plates.push("C");
                if (col.magenta > 0.05) plates.push("M");
                if (col.yellow > 0.05) plates.push("Y");
                if (col.black > 0.05) plates.push("K");
                return null;
            }, null);
        } else if (t === "GrayColor") {
            safe(function () { if (col.gray > 0.05) plates.push("K"); return null; }, null);
        } else if (t === "RGBColor") {
            plates.push("RGB(要変換)");
        } else if (t === "SpotColor") {
            if (isRegistrationSpot(col)) {
                // レジストレーションは全版のため集計から除外(トンボ用)
            } else {
                plates.push("特色:" + safe(function () { return col.spot.name; }, "(不明)"));
            }
        } else if (t === "GradientColor") {
            safe(function () {
                var stops = col.gradient.gradientStops;
                for (var s = 0; s < stops.length; s++) {
                    var sub = platesOfColor(stops[s].color);
                    for (var u = 0; u < sub.length; u++) plates.push(sub[u]);
                }
                return null;
            }, null);
        }
        return plates;
    };

    for (var a = 0; a < doc.artboards.length; a++) {
        var abRect = doc.artboards[a].artboardRect;
        var plateSet = {};
        var hasImage = false;
        for (var i = 0; i < ctx.items.length; i++) {
            var rec = ctx.items[i];
            if (rec.hiddenInherited) continue;
            var gb = rec.geometricBounds;
            if (!gb) continue;
            if (!centerInside(gb, abRect)) continue;
            if (rec.typename === "RasterItem" || rec.typename === "PlacedItem") {
                hasImage = true;
                continue;
            }
            if (rec.typename === "GroupItem") continue;
            var item = rec.item;
            var fillColor = safe(function () { return item.fillColor; }, null);
            var strokeColor = safe(function () { return item.strokeColor; }, null);
            if (rec.typename === "TextFrame") {
                fillColor = safe(function () { return item.textRange.characterAttributes.fillColor; }, fillColor);
                strokeColor = safe(function () { return item.textRange.characterAttributes.strokeColor; }, strokeColor);
            }
            var pl = platesOfColor(fillColor);
            var pl2 = platesOfColor(strokeColor);
            for (var p = 0; p < pl.length; p++) plateSet[pl[p]] = true;
            for (var q = 0; q < pl2.length; q++) plateSet[pl2[q]] = true;
        }

        var plateNames = [];
        var spotPlateCount = 0, processPlateCount = 0, hasRGB = false;
        for (var pn in plateSet) {
            if (!plateSet.hasOwnProperty(pn)) continue;
            plateNames.push(pn);
            if (pn.indexOf("特色:") === 0) spotPlateCount++;
            else if (pn === "RGB(要変換)") hasRGB = true;
            else processPlateCount++;
        }
        var totalPlates = spotPlateCount + processPlateCount;
        var cLabel = totalPlates >= 5 ? "5C以上" : (totalPlates + "C");

        // 印刷カラー数設定との整合判定
        var mismatch = false;
        if (hasRGB) mismatch = true;
        else if (cfg.colorModeKey === "MONO1") {
            if (spotPlateCount > 0 || processPlateCount > 1 || (processPlateCount === 1 && !plateSet["K"])) mismatch = true;
        } else if (cfg.colorModeKey === "CMYK4") {
            if (spotPlateCount > 0) mismatch = true;
        } else if (cfg.colorModeKey === "SPOTONLY") {
            if (processPlateCount > 0) mismatch = true;
        }
        // CMYK4SPOT はCMYK+特色を許容(特色数の照合は「特色」チェック側)

        var lineText = "アートボード" + (a + 1) + "(" + doc.artboards[a].name + "): " + cLabel +
            (plateNames.length > 0 ? " [" + joinArr(plateNames, ", ") + "]" : " [使用版なし]") +
            (hasImage ? " ※画像あり(画像内の色は未集計)" : "");
        if (mismatch) {
            ngCount++;
            details.push(detailItem("設定(" + COLOR_MODE_LABELS[cfg.colorModeKey] + ")と不一致: " + lineText, null));
        } else if (hasImage) {
            warnCount++;
            details.push(detailItem("要確認: " + lineText, null));
        } else {
            details.push(detailItem("[情報] " + lineText, null));
        }
    }
    var status = ngCount > 0 ? "NG" : (warnCount > 0 ? "WARN" : "INFO");
    var summary = ngCount > 0 ? (ngCount + "面 カラー数不一致") : (warnCount > 0 ? "画像を含むため要確認" : "全アートボードが設定と整合");
    return makeResult("artboard_colors", status, summary, details, "ベクトルオブジェクトの塗り/線/グラデーションから版を集計しています。画像内部の色・効果由来の色は集計対象外です。");
};

// --- 9.8f 白ページ(空アートボード)検出 ---
CHECKS.blank_artboard = function (doc, cfg, ctx) {
    var details = [];
    var warnCount = 0;
    for (var a = 0; a < doc.artboards.length; a++) {
        var abRect = doc.artboards[a].artboardRect;
        var found = false;
        for (var i = 0; i < ctx.items.length; i++) {
            var rec = ctx.items[i];
            if (rec.hiddenInherited) continue;
            if (rec.typename === "GroupItem") continue;
            var gb = rec.geometricBounds;
            if (!gb) continue;
            // アートボードと少しでも重なる描画オブジェクトがあれば白ページではない
            if (gb[0] < abRect[2] && gb[2] > abRect[0] && gb[1] > abRect[3] && gb[3] < abRect[1]) {
                found = true;
                break;
            }
        }
        if (!found) {
            warnCount++;
            details.push(detailItem("空アートボード(白ページ): アートボード" + (a + 1) + "(" + doc.artboards[a].name + ")", null));
        }
    }
    var status = warnCount > 0 ? "WARN" : "OK";
    var summary = warnCount > 0 ? (warnCount + "面 空アートボード") : "空アートボードなし";
    return makeResult("blank_artboard", status, summary, details, "");
};

// --- 9.9 リンク切れ ---
CHECKS.image_missing = function (doc, cfg, ctx) {
    var details = [];
    var ngCount = 0;
    for (var i = 0; i < ctx.items.length; i++) {
        var rec = ctx.items[i];
        if (rec.typename !== "PlacedItem") continue;
        var item = rec.item;
        var ok = safe(function () {
            var f = item.file;
            return f && f.exists;
        }, null);
        if (ok === null) {
            ngCount++;
            details.push(detailItem("リンク切れ(参照エラー): " + describeItem(rec, doc), item));
        } else if (ok === false) {
            ngCount++;
            details.push(detailItem("リンク切れ: " + describeItem(rec, doc), item));
        }
    }
    var status = ngCount > 0 ? "NG" : "OK";
    var summary = ngCount > 0 ? (ngCount + "件 リンク切れ") : "リンク切れなし";
    return makeResult("image_missing", status, summary, details, "");
};

// --- 9.10 画像カラーモード ---
CHECKS.image_colormode = function (doc, cfg, ctx) {
    var details = [];
    var ngCount = 0, warnCount = 0;
    for (var i = 0; i < ctx.items.length; i++) {
        var rec = ctx.items[i];
        var item = rec.item;
        if (rec.typename === "RasterItem") {
            var csp = safe(function () { return item.imageColorSpace; }, null);
            if (csp === ImageColorSpace.RGB) {
                ngCount++;
                details.push(detailItem("埋め込み画像がRGB: " + describeItem(rec, doc), item));
            }
        } else if (rec.typename === "PlacedItem") {
            throwIfAborted(); // 画像1ファイルごとに中断(ESC)を確認
            var file = safe(function () { return item.file; }, null);
            if (!file || !file.exists) continue; // リンク切れは別チェックで報告
            (function () {
                // 【Mac確定原因・診断ログで実証済み】file.displayNameがMacで空文字列を
                // 返すことがあった(ScriptUI表示側の問題ではなくデータ取得の問題だった)。
                // displayNameが空ならFile標準プロパティのnameへ、それも空ならfsName
                // (フルパス)へ、と段階的にフォールバックする。
                var rawName = safe(function () { return file.displayName; }, "");
                // 【v1.12.0】file.name はExtendScript仕様でURIエンコードされた名前を返す
                // (日本語ファイル名だと %E3%81%82... のような%表記=「文字化けのよう」に
                // 見えていた正体)。decodeURIで復号する(不正シーケンスで例外の場合はsafeが吸収)。
                if (!rawName) rawName = safe(function () { return decodeURI(file.name); }, "");
                if (!rawName) rawName = safe(function () { return file.fsName; }, "");
                var shortName = truncateForProgress(rawName, 40);
                dlog("PROGRESS", "カラーモード判定中 短縮前=[" + rawName + "] 短縮後=[" + shortName + "]");
                if (ctx.tick) ctx.tick("画像カラーモード判定中: " + shortName);
            })();
            var info = getImageInfoCached(file);
            if (!info.ok || info.colorMode === "UNKNOWN") {
                warnCount++;
                details.push(detailItem("カラーモード判定不能(要確認): " + describeItem(rec, doc) + " / ファイル:" + file.name, item));
            } else if (info.colorMode === "RGB") {
                ngCount++;
                details.push(detailItem("リンク画像がRGB(" + info.format + "): " + describeItem(rec, doc) + " / ファイル:" + file.name, item));
            }
        }
    }
    var status = ngCount > 0 ? "NG" : (warnCount > 0 ? "WARN" : "OK");
    var summary = ngCount > 0 ? (ngCount + "件 RGB画像") : (warnCount > 0 ? (warnCount + "件 要確認") : "RGB画像なし");
    return makeResult("image_colormode", status, summary, details, "リンク画像はファイルヘッダ(JPEG/PNG/TIFF/PSD/BMP/GIF)から判定しています。対応外形式は要確認としています。");
};

// --- 9.11 実効解像度 ---
// 画像種別ごとに閾値を変える:
//   カラー/グレースケール: 下限 minImageDPI(既定300) / 過剰 maxImageDPI 超(既定900)は警告
//   モノクロ2値(ビットマップ): 下限 minBitmapDPI(既定600) / 過剰 maxBitmapDPI 超(既定1200)は警告
CHECKS.image_resolution = function (doc, cfg, ctx) {
    var details = [];
    var ngCount = 0, warnCount = 0;
    for (var i = 0; i < ctx.items.length; i++) {
        var rec = ctx.items[i];
        var item = rec.item;
        if (rec.typename === "RasterItem") {
            var dpi = calcRasterEffectiveDPI(item);
            if (dpi === null) {
                warnCount++;
                details.push(detailItem("実効解像度 判定不能(埋め込み画像のためピクセル情報を取得できません): " + describeItem(rec, doc), item));
            }
        } else if (rec.typename === "PlacedItem") {
            throwIfAborted(); // 画像1ファイルごとに中断(ESC)を確認
            var file = safe(function () { return item.file; }, null);
            if (!file || !file.exists) continue;
            (function () {
                // 【Mac確定原因】上のカラーモード判定中と同様、displayName -> name -> fsName の
                // 順でフォールバックする(displayNameがMacで空文字列を返すことがあったため)。
                var rawName2 = safe(function () { return file.displayName; }, "");
                // 【v1.12.0】file.nameのURIエンコード対策(上のカラーモード判定中と同じ)
                if (!rawName2) rawName2 = safe(function () { return decodeURI(file.name); }, "");
                if (!rawName2) rawName2 = safe(function () { return file.fsName; }, "");
                var shortName2 = truncateForProgress(rawName2, 40);
                dlog("PROGRESS", "実効解像度算出中 短縮前=[" + rawName2 + "] 短縮後=[" + shortName2 + "]");
                if (ctx.tick) ctx.tick("実効解像度算出中: " + shortName2);
            })();
            var info = getImageInfoCached(file);
            if (!info.ok) {
                warnCount++;
                details.push(detailItem("実効解像度 判定不能(ファイルヘッダからピクセル数を取得できません): " + describeItem(rec, doc) + " / ファイル:" + file.name, item));
                continue;
            }
            var pdpi = calcPlacedEffectiveDPI(item, info.width, info.height);
            if (pdpi === null) {
                warnCount++;
                details.push(detailItem("実効解像度 判定不能: " + describeItem(rec, doc), item));
                continue;
            }
            var isBitmap = (info.isBitmap === true);
            var typeLabel = isBitmap ? "モノクロ2値" : (info.colorMode === "GRAY" ? "グレースケール" : "カラー");
            var minDPI = isBitmap ? cfg.minBitmapDPI : cfg.minImageDPI;
            var maxDPI = isBitmap ? cfg.maxBitmapDPI : cfg.maxImageDPI;
            if (pdpi < minDPI) {
                ngCount++;
                details.push(detailItem("実効解像度不足[" + typeLabel + "](" + fmt(pdpi, 0) + "dpi < " + minDPI + "dpi) / ファイル:" + file.name + ": " + describeItem(rec, doc), item));
            } else if (maxDPI > 0 && pdpi > maxDPI) {
                warnCount++;
                details.push(detailItem("過剰解像度[" + typeLabel + "](" + fmt(pdpi, 0) + "dpi > " + maxDPI + "dpi、データ容量の無駄) / ファイル:" + file.name + ": " + describeItem(rec, doc), item));
            }
        }
    }
    var status = ngCount > 0 ? "NG" : (warnCount > 0 ? "WARN" : "OK");
    var summary = ngCount > 0 ? (ngCount + "件 解像度不足(警告" + warnCount + "件)") : (warnCount > 0 ? (warnCount + "件 警告") : "実効解像度は基準を満たしています");
    return makeResult("image_resolution", status, summary, details, "配置サイズは配置マトリクス(拡大縮小率)を考慮して算出しています。モノクロ2値かどうかはファイルヘッダ(TIFF/PNG/PSD/BMP)から判定し、判定できない形式はカラー/グレー扱いです。");
};

function matrixScale(m) {
    // Matrixオブジェクトから x/y 方向の拡大率を抽出
    var sx = Math.sqrt(m.mValueA * m.mValueA + m.mValueB * m.mValueB);
    var sy = Math.sqrt(m.mValueC * m.mValueC + m.mValueD * m.mValueD);
    return [sx, sy];
}

function calcRasterEffectiveDPI(rasterItem) {
    // XMP/埋め込みメタデータからのピクセル数取得はライブラリ依存のため行わず、
    // RasterItemのwidth/height(変形前サイズ)と配置後のvisibleBoundsの比から実寸を算出する簡易手法を用いる。
    // ただし「元ピクセル数」自体はExtendScriptのRasterItemオブジェクトから直接取得できないため、
    // ここでは判定不能として要確認を返す(誤ったOK/NG判定を避けるため)。
    return null;
}

function calcPlacedEffectiveDPI(placedItem, pxW, pxH) {
    try {
        var baseW = placedItem.width;  // 変形前サイズ(pt)
        var baseH = placedItem.height;
        var scale = [1, 1];
        var m = safe(function () { return placedItem.matrix; }, null);
        if (m) scale = matrixScale(m);
        var dispWpt = baseW * scale[0];
        var dispHpt = baseH * scale[1];
        if (dispWpt <= 0 || dispHpt <= 0) return null;
        var dispWin = dispWpt / 72;
        var dispHin = dispHpt / 72;
        var dpiW = pxW / dispWin;
        var dpiH = pxH / dispHin;
        return Math.min(dpiW, dpiH);
    } catch (e) {
        return null;
    }
}

// --- 9.11b 透明効果検出 ---
CHECKS.transparency = function (doc, cfg, ctx) {
    var details = [];
    var warnCount = 0, infoCount = 0;
    for (var i = 0; i < ctx.items.length; i++) {
        var rec = ctx.items[i];
        var item = rec.item;
        var opacity = safe(function () { return item.opacity; }, 100);
        var blend = safe(function () { return item.blendingMode; }, null);
        var isNormalBlend = (blend === null) || (blend === BlendModes.NORMAL);
        if (opacity >= 100 && isNormalBlend) continue;

        var blendName = safe(function () { return String(blend); }, "不明");
        var descParts = [];
        if (!isNormalBlend) descParts.push("描画モード:" + blendName);
        if (opacity < 100) descParts.push("不透明度:" + fmt(opacity, 0) + "%");

        // 乗算ブラック + オーバープリント併用は分版事故になりやすいため警告
        var isMultiply = safe(function () { return blend === BlendModes.MULTIPLY; }, false);
        var fillOP = safe(function () { return item.fillOverprint; }, false);
        var strokeOP = safe(function () { return item.strokeOverprint; }, false);
        var fillColor = safe(function () { return item.fillColor; }, null);
        var isBlackish = safe(function () {
            var t = colorTypeName(fillColor);
            if (t === "CMYKColor") return fillColor.black >= 90;
            if (t === "GrayColor") return fillColor.gray >= 90;
            return false;
        }, false);

        if (isMultiply && isBlackish && (fillOP || strokeOP)) {
            warnCount++;
            details.push(detailItem("乗算ブラック+オーバープリント併用(" + joinArr(descParts, " / ") + "): " + describeItem(rec, doc), item));
        } else {
            infoCount++;
            details.push(detailItem("[情報] 透明効果(" + joinArr(descParts, " / ") + "): " + describeItem(rec, doc), item));
        }
    }
    var status = warnCount > 0 ? "WARN" : (infoCount > 0 ? "INFO" : "OK");
    var summary = warnCount > 0 ? (warnCount + "件 警告(情報" + infoCount + "件)") : (infoCount > 0 ? (infoCount + "件 透明効果使用(情報)") : "透明効果なし");
    return makeResult("transparency", status, summary, details, "アピアランス効果(ドロップシャドウ等)内部の透明は検出できません。透明の分割・統合プレビューでも確認してください。");
};

// --- 9.11c グラデーションメッシュ検出 ---
CHECKS.gradient_mesh = function (doc, cfg, ctx) {
    var details = [];
    var count = 0;
    for (var i = 0; i < ctx.items.length; i++) {
        var rec = ctx.items[i];
        if (rec.typename !== "MeshItem") continue;
        count++;
        details.push(detailItem("グラデーションメッシュ: " + describeItem(rec, doc), rec.item));
    }
    var status = count > 0 ? "WARN" : "OK";
    var summary = count > 0 ? (count + "件 使用(要確認)") : "グラデーションメッシュなし";
    return makeResult("gradient_mesh", status, summary, details, "");
};

// --- 9.11d パターン使用検出 ---
CHECKS.pattern_usage = function (doc, cfg, ctx) {
    var details = [];
    var count = 0;
    for (var i = 0; i < ctx.items.length; i++) {
        var rec = ctx.items[i];
        var item = rec.item;
        var fillColor = safe(function () { return item.fillColor; }, null);
        var strokeColor = safe(function () { return item.strokeColor; }, null);
        if (colorTypeName(fillColor) === "PatternColor") {
            count++;
            details.push(detailItem("塗りがパターン: " + describeItem(rec, doc), item));
        }
        if (colorTypeName(strokeColor) === "PatternColor") {
            count++;
            details.push(detailItem("線がパターン: " + describeItem(rec, doc), item));
        }
    }
    var status = count > 0 ? "INFO" : "OK";
    var summary = count > 0 ? (count + "件 使用(情報)") : "パターン未使用";
    return makeResult("pattern_usage", status, summary, details, "パターン内部のオブジェクト(色・線幅)は走査対象外です。");
};

// --- 9.11e ベクトルオブジェクト総数警告 ---
CHECKS.object_count = function (doc, cfg, ctx) {
    var total = ctx.items.length;
    var details = [detailItem("走査したオブジェクト総数: " + total + "件(閾値 " + cfg.maxObjectCount + "件)", null)];
    if (total >= cfg.maxObjectCount) {
        return makeResult("object_count", "WARN", total + "件(閾値" + cfg.maxObjectCount + "件以上・RIP負荷に注意)", details, "");
    }
    return makeResult("object_count", "INFO", total + "件(閾値内)", details, "");
};

// --- 9.11f 細ケイ+薄アミ検出 ---
// 細線(既定0.5pt以下)かつ低濃度(インキ総量が既定20%以下)の線 → 飛び・カスレ要因として警告
CHECKS.thin_light_line = function (doc, cfg, ctx) {
    var details = [];
    var warnCount = 0;
    for (var i = 0; i < ctx.items.length; i++) {
        var rec = ctx.items[i];
        var item = rec.item;
        var stroked = safe(function () { return item.stroked; }, false);
        if (!stroked) continue;
        var sw = safe(function () { return item.strokeWidth; }, null);
        if (sw === null || sw <= 0 || sw > cfg.thinLinePt) continue;
        var strokeColor = safe(function () { return item.strokeColor; }, null);
        var total = cmykInkTotal(strokeColor);
        var isLightGray = safe(function () {
            return colorTypeName(strokeColor) === "GrayColor" && strokeColor.gray <= cfg.lightInkPercent && strokeColor.gray > 0.05;
        }, false);
        if ((total !== null && total > 0.05 && total <= cfg.lightInkPercent) || isLightGray) {
            warnCount++;
            var densText = (total !== null) ? fmt(total, 0) + "%" : "低濃度";
            details.push(detailItem("細ケイ+薄アミ(線幅" + fmt(sw, 2) + "pt / 濃度計" + densText + " / " + colorLabel(strokeColor) + "): " + describeItem(rec, doc), item));
        }
    }
    var status = warnCount > 0 ? "WARN" : "OK";
    var summary = warnCount > 0 ? (warnCount + "件 警告") : "細ケイ+薄アミなし";
    return makeResult("thin_light_line", status, summary, details, "判定基準: 線幅" + cfg.thinLinePt + "pt以下かつインキ総量" + cfg.lightInkPercent + "%以下。ヘアラインチェック(0.25pt以下)とは別に判定しています。");
};

// --- 9.12 オーバープリント ---
CHECKS.overprint = function (doc, cfg, ctx) {
    var details = [];
    var ngCount = 0, warnCount = 0;
    for (var i = 0; i < ctx.items.length; i++) {
        var rec = ctx.items[i];
        var item = rec.item;
        var fillOP = safe(function () { return item.fillOverprint; }, false);
        var strokeOP = safe(function () { return item.strokeOverprint; }, false);
        if (!fillOP && !strokeOP) continue;
        var fillColor = safe(function () { return item.fillColor; }, null);
        if (fillOP && isWhiteColor(fillColor)) {
            ngCount++;
            details.push(detailItem("白オブジェクトにオーバープリント(白ノセ): " + describeItem(rec, doc), item));
        } else {
            warnCount++;
            details.push(detailItem("オーバープリント設定あり(意図的か要確認): " + describeItem(rec, doc), item));
        }
    }
    var status = ngCount > 0 ? "NG" : (warnCount > 0 ? "WARN" : "OK");
    var summary = ngCount > 0 ? (ngCount + "件 白ノセ") : (warnCount > 0 ? (warnCount + "件 要確認") : "オーバープリント設定なし");
    return makeResult("overprint", status, summary, details, "");
};

// --- 9.13 ヘアライン/極細線 ---
CHECKS.hairline = function (doc, cfg, ctx) {
    var details = [];
    var ngCount = 0;
    for (var i = 0; i < ctx.items.length; i++) {
        var rec = ctx.items[i];
        var item = rec.item;
        var stroked = safe(function () { return item.stroked; }, false);
        if (!stroked) continue;
        var sw = safe(function () { return item.strokeWidth; }, null);
        if (sw === null) continue;
        if (sw === 0) {
            ngCount++;
            details.push(detailItem("ヘアライン(0pt): " + describeItem(rec, doc), item));
        } else if (sw > 0 && sw <= cfg.minStrokePt) {
            ngCount++;
            details.push(detailItem("極細線(" + fmt(sw, 2) + "pt <= " + cfg.minStrokePt + "pt): " + describeItem(rec, doc), item));
        }
    }
    var status = ngCount > 0 ? "NG" : "OK";
    var summary = ngCount > 0 ? (ngCount + "件 極細線/ヘアライン") : "極細線なし";
    return makeResult("hairline", status, summary, details, "");
};

// --- 9.14 ラスタライズ効果解像度 ---
CHECKS.raster_effect_res = function (doc, cfg, ctx) {
    var res = safe(function () { return doc.rasterEffectSettings.resolution; }, null);
    if (res === null) {
        return makeResult("raster_effect_res", "WARN", "取得不可", [], "ドキュメントのラスタライズ効果設定を取得できませんでした。");
    }
    var status = res < cfg.minRasterEffectPPI ? "NG" : "OK";
    var summary = "現在の設定: " + fmt(res, 0) + "ppi(下限" + cfg.minRasterEffectPPI + "ppi)";
    var details = [detailItem(summary, null)];
    return makeResult("raster_effect_res", status, summary, details, "");
};

// --- 9.15 不要オブジェクト ---
CHECKS.unwanted = function (doc, cfg, ctx) {
    var details = [];
    var count = 0;
    var bleedPt = mm2pt(cfg.bleedMM);

    for (var i = 0; i < ctx.items.length; i++) {
        var rec = ctx.items[i];
        var item = rec.item;
        var tn = rec.typename;

        if (rec.hiddenSelf) {
            count++; details.push(detailItem("非表示オブジェクト: " + describeItem(rec, doc), item));
        } else if (rec.hiddenInherited) {
            count++; details.push(detailItem("非表示レイヤー/グループ内のオブジェクト: " + describeItem(rec, doc), item));
        }
        if (rec.lockedInherited && rec.hiddenInherited) {
            count++; details.push(detailItem("ロック済みかつ非表示: " + describeItem(rec, doc), item));
        }
        if (tn === "TextFrame") {
            var content = safe(function () { return item.contents; }, null);
            if (content !== null && content.replace(/^\s+|\s+$/g, "") === "") {
                count++; details.push(detailItem("空テキストフレーム: " + describeItem(rec, doc), item));
            }
        }
        if (tn === "PathItem") {
            var pts = safe(function () { return item.pathPoints.length; }, -1);
            if (pts === 1) {
                count++; details.push(detailItem("孤立点(ストレイポイント): " + describeItem(rec, doc), item));
            }
        }
        var gb = rec.geometricBounds;
        if (gb && tn !== "GroupItem") {
            var insideAny = false;
            for (var a = 0; a < doc.artboards.length; a++) {
                var r = doc.artboards[a].artboardRect;
                var expanded = [r[0] - bleedPt, r[1] + bleedPt, r[2] + bleedPt, r[3] - bleedPt];
                if (gb[0] < expanded[2] && gb[2] > expanded[0] && gb[1] > expanded[3] && gb[3] < expanded[1]) {
                    insideAny = true; break;
                }
            }
            if (!insideAny) {
                count++; details.push(detailItem("アートボード(塗り足し範囲)外のオブジェクト: " + describeItem(rec, doc), item));
            }
        }
    }

    var status = count > 0 ? "WARN" : "OK";
    var summary = count > 0 ? (count + "件 要確認") : "不要オブジェクトは検出されませんでした";
    return makeResult("unwanted", status, summary, details, "意図的な配置(作業用メモ等)の場合もあるため、すべて「要確認」扱いとしています。");
};

// -----------------------------------------------------------------------------
// 10. 検査実行本体
// -----------------------------------------------------------------------------

function runPreflight(doc, cfg, progressCb) {
    IMAGE_INFO_CACHE = {}; // 画像ヘッダキャッシュを実行ごとにリセット
    if (progressCb) progressCb(0, "ドキュメントを走査中...");
    var items = scanDocument(doc, function (n) {
        if (progressCb) progressCb(Math.min(40, n / 20), "オブジェクトを走査中... (" + n + "件)");
    });

    var artboardTrims = [];
    for (var i = 0; i < doc.artboards.length; i++) {
        artboardTrims.push(detectTrimBox(doc, doc.artboards[i], items, cfg));
    }

    var ctx = {
        items: items,
        artboardTrims: artboardTrims,
        primaryTrim: artboardTrims[0],
        // 時間のかかる処理(画像ヘッダ解析等)の合間に進捗ラベルだけ更新する
        // (pct=null でプログレスバー値は維持)
        tick: function (label) { if (progressCb) progressCb(null, label); }
    };

    var order = getCheckIdOrder();
    var results = [];
    for (var k = 0; k < order.length; k++) {
        var id = order[k];
        throwIfAborted(); // 各チェックの合間に中断(ESC)を確認
        if (progressCb) progressCb(40 + Math.floor((k / order.length) * 60), "チェック中: " + CHECK_META[id].name);
        if (!cfg.checks[id]) {
            results.push(makeResult(id, "SKIP", "-(OFF)", [], "設定でこの項目は無効化されています。"));
            continue;
        }
        try {
            results.push(CHECKS[id](doc, cfg, ctx));
        } catch (e) {
            if (isAbortError(e)) throw e; // 中断は上位に伝播(警告扱いにしない)
            results.push(makeResult(id, "WARN", "チェック実行中にエラーが発生しました", [detailItem("エラー内容: " + e.toString(), null)], "要確認としています。"));
        }
    }
    if (progressCb) progressCb(100, "完了");

    // 検出した仕上がりサイズ(左右×天地)の表示用テキストを結果に付与
    var pt = artboardTrims[0];
    if (pt && pt.sizeMM) {
        results.finishSizeText = "左右 " + fmt(pt.sizeMM[0], 1) + " × 天地 " + fmt(pt.sizeMM[1], 1) + " mm" +
            (pt.matched ? "" : "(自動検出できず・アートボード実寸)");
    } else {
        results.finishSizeText = "";
    }
    return results;
}

function summarizeResults(results) {
    var ngCount = 0, warnCount = 0, infoCount = 0;
    for (var i = 0; i < results.length; i++) {
        var r = results[i];
        var n = r.details.length > 0 ? r.details.length : 1;
        if (r.status === "NG") ngCount += n;
        else if (r.status === "WARN") warnCount += n;
        else if (r.status === "INFO") infoCount += n;
    }
    return { ngCount: ngCount, warnCount: warnCount, infoCount: infoCount, allOk: (ngCount === 0 && warnCount === 0) };
}

// -----------------------------------------------------------------------------
// 11. レポート生成(HTML / CSV)
// -----------------------------------------------------------------------------

function buildHtmlReport(doc, cfg, results, summary) {
    var html = "";
    html += "<!DOCTYPE html>\n<html lang=\"ja\"><head><meta charset=\"UTF-8\">\n";
    html += "<title>デジタル検版レポート - " + escapeHtml(doc.name) + "</title>\n";
    html += "<style>\n";
    html += "body{font-family:'Hiragino Kaku Gothic ProN','Meiryo',sans-serif;margin:24px;color:#222;}\n";
    html += "h1{font-size:20px;} h2{font-size:16px;border-bottom:2px solid #444;padding-bottom:4px;margin-top:28px;}\n";
    html += "table{border-collapse:collapse;width:100%;margin-top:8px;} th,td{border:1px solid #ccc;padding:6px 8px;font-size:12px;text-align:left;vertical-align:top;}\n";
    html += "th{background:#eee;} .ok{color:#0a7d2c;font-weight:bold;} .ng{color:#c0392b;font-weight:bold;} .warn{color:#d18a00;font-weight:bold;} .info{color:#1c6bb0;font-weight:bold;} .skip{color:#888;}\n";
    html += ".advice{color:#444;font-size:11px;margin-top:4px;padding:4px 6px;background:#f4f7fa;border-left:3px solid #9bb8d0;}\n";
    html += ".summary{font-size:22px;padding:12px;border-radius:6px;margin-bottom:16px;}\n";
    html += ".summary.ok{background:#e6f6ea;} .summary.ng{background:#fbe9e7;}\n";
    html += "ul{margin:4px 0;padding-left:20px;} li{font-size:12px;margin-bottom:2px;}\n";
    html += "</style></head><body>\n";
    html += "<h1>デジタル検版レポート</h1>\n";
    html += "<p>ファイル名: " + escapeHtml(doc.name) + " / 出力日時: " + nowString() + " / ツールバージョン: v" + escapeHtml(KENPAN_VERSION) + "</p>\n";

    var overallClass = summary.allOk ? "ok" : "ng";
    var overallText = summary.allOk ?
        ("&#10004; 全項目OK" + (summary.infoCount > 0 ? "(情報 " + summary.infoCount + "件)" : "")) :
        ("&#10008; エラー " + summary.ngCount + "件・警告 " + summary.warnCount + "件・情報 " + summary.infoCount + "件");
    html += "<div class=\"summary " + overallClass + "\">総合判定: " + overallText + "</div>\n";
    if (results.finishSizeText) {
        html += "<p>検出した仕上がりサイズ: <b>" + escapeHtml(results.finishSizeText) + "</b></p>\n";
    }

    html += "<h2>設定値</h2>\n<table>\n";
    html += "<tr><th>仕上がりサイズ</th><td>" + escapeHtml(SIZE_PRESET_LABELS[cfg.sizeKey]) + (cfg.sizeKey === "CUSTOM" ? " (" + cfg.customWidthMM + "×" + cfg.customHeightMM + "mm)" : "") + " ±" + cfg.sizeToleranceMM + "mm</td></tr>\n";
    html += "<tr><th>印刷カラー数</th><td>" + escapeHtml(COLOR_MODE_LABELS[cfg.colorModeKey]) + "</td></tr>\n";
    html += "<tr><th>塗り足し幅</th><td>" + cfg.bleedMM + "mm</td></tr>\n";
    html += "<tr><th>文字セーフマージン</th><td>" + cfg.textMarginMM + "mm</td></tr>\n";
    html += "<tr><th>最小線幅</th><td>" + cfg.minStrokePt + "pt</td></tr>\n";
    html += "<tr><th>画像解像度(カラー/グレー)</th><td>下限 " + cfg.minImageDPI + "dpi / 過剰警告 " + cfg.maxImageDPI + "dpi超</td></tr>\n";
    html += "<tr><th>画像解像度(モノクロ2値)</th><td>下限 " + cfg.minBitmapDPI + "dpi / 過剰警告 " + cfg.maxBitmapDPI + "dpi超</td></tr>\n";
    html += "<tr><th>インキ総量上限</th><td>" + cfg.maxInkPercent + "%</td></tr>\n";
    html += "<tr><th>ラスタライズ効果解像度下限</th><td>" + cfg.minRasterEffectPPI + "ppi</td></tr>\n";
    html += "<tr><th>オブジェクト総数警告閾値</th><td>" + cfg.maxObjectCount + "件</td></tr>\n";
    html += "<tr><th>細ケイ+薄アミ閾値</th><td>線幅" + cfg.thinLinePt + "pt以下かつ濃度" + cfg.lightInkPercent + "%以下</td></tr>\n";
    html += "</table>\n";

    for (var c = 0; c < CATEGORY_ORDER.length; c++) {
        var cat = CATEGORY_ORDER[c];
        html += "<h2>" + escapeHtml(cat) + "</h2>\n<table><tr><th>項目</th><th>判定</th><th>概要</th><th>検出内容</th></tr>\n";
        for (var i = 0; i < results.length; i++) {
            var r = results[i];
            if (r.category !== cat) continue;
            var cls = r.status === "OK" ? "ok" : (r.status === "NG" ? "ng" : (r.status === "WARN" ? "warn" : (r.status === "INFO" ? "info" : "skip")));
            var statusLabel = statusLabelOf(r.status);
            html += "<tr><td>" + escapeHtml(r.name) + "</td><td class=\"" + cls + "\">" + statusLabel + "</td><td>" + escapeHtml(r.summary) + "</td><td>";
            if (r.details.length > 0) {
                html += "<ul>";
                for (var d = 0; d < r.details.length; d++) {
                    html += "<li>" + escapeHtml(r.details[d].text) + "</li>";
                }
                html += "</ul>";
            }
            if (r.note) html += "<div style=\"color:#666;font-size:11px;margin-top:4px;\">" + escapeHtml(r.note) + "</div>";
            if (r.advice && r.status !== "OK" && r.status !== "SKIP") {
                html += "<div class=\"advice\">原因と対応: " + escapeHtml(r.advice) + "</div>";
            }
            html += "</td></tr>\n";
        }
        html += "</table>\n";
    }

    html += "<h2>備考</h2>\n";
    html += "<p style=\"font-size:12px;color:#555;\">本レポートはIllustratorドキュメント上での検査結果です。PDF固有の項目(PDFバージョン、出力インテント、フォント埋め込み、圧縮設定等)は、PDF書き出し後にAcrobatのプリフライトで別途確認してください。</p>\n";
    html += "</body></html>";
    return html;
}

function buildCsvReport(doc, cfg, results) {
    var lines = [];
    // ファイル冒頭のメタ情報欄(ツールバージョン等)。1列のみの行として先頭に付与する。
    lines.push(escapeCsv("# DigitalKenpan v" + KENPAN_VERSION + " / ファイル名: " + doc.name + " / 出力日時: " + nowString()));
    lines.push(joinArr([escapeCsv("カテゴリ"), escapeCsv("項目"), escapeCsv("判定"), escapeCsv("概要"), escapeCsv("検出内容"), escapeCsv("原因と対応"), escapeCsv("備考")], ","));
    for (var i = 0; i < results.length; i++) {
        var r = results[i];
        var statusLabel = statusLabelOf(r.status);
        if (r.details.length === 0) {
            lines.push(joinArr([escapeCsv(r.category), escapeCsv(r.name), escapeCsv(statusLabel), escapeCsv(r.summary), escapeCsv(""), escapeCsv(r.advice), escapeCsv(r.note)], ","));
        } else {
            for (var d = 0; d < r.details.length; d++) {
                lines.push(joinArr([escapeCsv(r.category), escapeCsv(r.name), escapeCsv(statusLabel), escapeCsv(r.summary), escapeCsv(r.details[d].text), escapeCsv(r.advice), escapeCsv(r.note)], ","));
            }
        }
    }
    return joinArr(lines, "\r\n");
}

function writeTextFileUTF8BOM(file, text) {
    file.encoding = "UTF-8";
    file.open("w");
    // ExtendScriptのFile#write(UTF-8指定)はBOMを付与しないため明示的に付与する
    file.write("﻿" + text);
    file.close();
}

// -----------------------------------------------------------------------------
// 12. 選択+ズーム
// -----------------------------------------------------------------------------

// 選択を妨げるロック/非表示(アイテム自身・親グループ・レイヤー階層)を解除する。
// Illustratorはロック済み/非表示のアイテム、ロック/非表示レイヤー上のアイテムを
// selection に入れても無視するため、解除しないと「選択が反応しない」状態になる。
// 解除した内容の説明文を配列で返す(元に戻すと選択が見えなくなるため、戻さない)。
function unlockAncestorsForSelection(item, msgSet, msgs) {
    function addMsg(m) {
        if (!msgSet[m]) { msgSet[m] = true; msgs.push(m); }
    }
    // アイテム自身
    if (safe(function () { return item.locked; }, false)) {
        if (safe(function () { item.locked = false; return true; }, false)) {
            addMsg("オブジェクトのロックを解除しました(解除したままにしています)");
        }
    }
    if (safe(function () { return item.hidden; }, false)) {
        if (safe(function () { item.hidden = false; return true; }, false)) {
            addMsg("非表示オブジェクトを表示に変更しました");
        }
    }
    // 親階層(グループ/レイヤー)を上限50階層までたどる
    var p = safe(function () { return item.parent; }, null);
    var guard = 0;
    while (p !== null && p !== undefined && guard < 50) {
        guard++;
        var tn = safe(function () { return p.typename; }, "");
        if (tn === "Document" || tn === "") break;
        var pname = safe(function () { return p.name; }, "(名称不明)");
        if (tn === "Layer") {
            if (safe(function () { return p.locked; }, false)) {
                if (safe(function () { p.locked = false; return true; }, false)) {
                    addMsg("レイヤー「" + pname + "」のロックを解除しました(解除したままにしています)");
                }
            }
            if (safe(function () { return p.visible; }, true) === false) {
                if (safe(function () { p.visible = true; return true; }, false)) {
                    addMsg("レイヤー「" + pname + "」を表示に変更しました");
                }
            }
        } else { // GroupItem / CompoundPathItem 等
            if (safe(function () { return p.locked; }, false)) {
                if (safe(function () { p.locked = false; return true; }, false)) {
                    addMsg("グループ「" + pname + "」のロックを解除しました(解除したままにしています)");
                }
            }
            if (safe(function () { return p.hidden; }, false)) {
                if (safe(function () { p.hidden = false; return true; }, false)) {
                    addMsg("グループ「" + pname + "」を表示に変更しました");
                }
            }
        }
        p = safe(function () { return p.parent; }, null);
    }
}

// ---- 選択ズームの倍率設定(必要に応じて変更可能) ----
var ZOOM_MIN = 0.5;          // ズーム下限(50%。これ未満には縮小しない)
var ZOOM_MAX = 4.0;          // ズーム上限(400%。これを超えて拡大しない)
var ZOOM_TARGET_RATIO = 0.4; // 対象の外接矩形が表示領域に占める割合(40%)
var ZOOM_MIN_OBJ_MM = 5;     // 極小オブジェクト対策: boundsに敷く最低サイズ(mm)

// 戻り値: { count: 実際に選択できた件数, message: 解除内容や選択不能理由の説明文 }
function selectAndZoom(doc, itemsArr) {
    var report = { count: 0, message: "" };
    if (!itemsArr || itemsArr.length === 0) return report;
    var msgs = [];
    var msgSet = {};
    try {
        doc.selection = null;
        var validItems = [];
        var minL = null, minT = null, maxR = null, maxB = null;
        for (var i = 0; i < itemsArr.length; i++) {
            var it = itemsArr[i];
            if (!it) continue;
            var gb = safe(function () { return it.geometricBounds; }, null);
            if (!gb) continue;
            // ロック/非表示があると選択が無視されるため先に解除
            unlockAncestorsForSelection(it, msgSet, msgs);
            if (safe(function () { return it.guides; }, false)) {
                if (!msgSet["__guide"]) { msgSet["__guide"] = true; msgs.push("ガイドオブジェクトを含みます(ガイドは選択が反映されない場合があります)"); }
            }
            validItems.push(it);
            if (minL === null || gb[0] < minL) minL = gb[0];
            if (maxR === null || gb[2] > maxR) maxR = gb[2];
            if (minT === null || gb[1] > minT) minT = gb[1];
            if (maxB === null || gb[3] < maxB) maxB = gb[3];
        }
        if (validItems.length === 0) {
            report.message = "選択可能なオブジェクトがありませんでした(削除済みの可能性があります)。";
            return report;
        }
        doc.selection = validItems;
        // 実際に選択が通ったか確認(ロック解除後もガイド等で選択不能な場合がある)
        report.count = safe(function () { return doc.selection.length; }, 0);
        if (report.count === 0) {
            msgs.push("選択が反映されませんでした。ガイド・特殊オブジェクト、または編集モード制限の可能性があります。オブジェクトの位置までズームします。");
        }

        var view = doc.views[0];
        var cx = (minL + maxR) / 2;
        var cy = (minT + maxB) / 2;
        view.centerPoint = [cx, cy];
        var w = maxR - minL, h = minT - maxB;
        // 極小オブジェクト(孤立点など bounds がほぼゼロ)はゼロ除算・極大倍率になるため、
        // boundsに最低サイズ(ZOOM_MIN_OBJ_MM)を敷いてから計算する
        var minObjPt = mm2pt(ZOOM_MIN_OBJ_MM);
        if (w < minObjPt) w = minObjPt;
        if (h < minObjPt) h = minObjPt;
        var viewBounds = safe(function () { return view.bounds; }, null);
        var vw = viewBounds ? (viewBounds[2] - viewBounds[0]) : 800;
        var vh = viewBounds ? (viewBounds[1] - viewBounds[3]) : 600;
        // 対象の外接矩形が表示領域の ZOOM_TARGET_RATIO(40%)になる倍率を算出
        var zoomW = (vw * ZOOM_TARGET_RATIO) / w;
        var zoomH = (vh * ZOOM_TARGET_RATIO) / h;
        var z = Math.min(zoomW, zoomH);
        if (z > 0 && isFinite(z)) {
            // 100%前後(80〜120%)は見やすさ優先で100%に丸める
            if (z >= 0.8 && z <= 1.2) z = 1.0;
            // 上限・下限でクランプ(極端な533%/7.79%等を防ぐ)
            if (z > ZOOM_MAX) z = ZOOM_MAX;
            if (z < ZOOM_MIN) z = ZOOM_MIN;
            view.zoom = z;
        }
        // クランプで倍率が変わっても中心は対象に合わせる
        view.centerPoint = [cx, cy];
        safe(function () { app.redraw(); return null; }, null);
    } catch (e) {
        msgs.push("選択/ズーム中にエラーが発生しました: " + e.toString());
    }
    report.message = joinArr(msgs, "\n");
    return report;
}

// -----------------------------------------------------------------------------
// 13. ScriptUI ダイアログ
// -----------------------------------------------------------------------------

function buildAndShowDialog() {
    var doc = null;
    try {
        doc = app.activeDocument;
    } catch (e) {
        alert("開いているドキュメントがありません。\nIllustratorでドキュメントを開いてから実行してください。");
        return;
    }

    var cfg = loadConfig();

    // タイトルバー表示文字列(バージョン番号を含む)
    var TITLE_SETTINGS = "デジタル検版ツール - DigitalKenpan (v" + KENPAN_VERSION + ")";
    var TITLE_RESULT_PREFIX = "デジタル検版ツール - 検査結果 (v" + KENPAN_VERSION + ") - ";

    // リサイズ可能なダイアログとして生成
    var win = new Window("dialog", TITLE_SETTINGS, undefined, { resizeable: true });
    win.orientation = "column";
    win.alignChildren = ["fill", "top"];
    win.preferredSize.width = 760;
    win.spacing = 8;

    // ---- タイトル/ドキュメント名 ----
    var headerGroup = win.add("group");
    headerGroup.add("statictext", undefined, "対象ドキュメント: " + doc.name);

    // ---- 画面切替コンテナ ----
    // 【レイアウト修正】設定/結果パネルを縦に積むと、非表示側のパネルが
    // レイアウト上のスペースを占有し続けて巨大な余白になるため、
    // stack(重ね)配置にして表示中のパネルだけが領域を使うようにする。
    var screens = win.add("group");
    screens.orientation = "stack";
    screens.alignChildren = ["fill", "fill"];
    screens.alignment = ["fill", "fill"]; // ウィンドウリサイズ時に伸縮

    // 【v1.14.0・枠線の視認性改善】最外周の「事前設定」「検査結果」はpanel(枠付き)から
    // group(枠なし)に変更。ダークUIでは細い枠線が二重三重に重なると区切りが判別しにくく
    // なるため、外周の枠を取り除いて枠線の本数自体を減らし、内側のカテゴリパネル
    // (仕上がりサイズ/印刷カラー数/各種数値設定/チェック項目/項目一覧/検出オブジェクト一覧)
    // だけに枠+背景色(面での区切り)を残す。タイトル文言はウィンドウのタイトルバーで
    // 判別できるため情報の損失はない。構造・コントロールの位置関係は変更していない。
    var settingsPanel = screens.add("group");
    settingsPanel.orientation = "column";
    settingsPanel.alignChildren = ["fill", "top"];
    settingsPanel.margins = 12;
    settingsPanel.spacing = 6;

    var resultPanel = screens.add("group");
    resultPanel.orientation = "column";
    resultPanel.alignChildren = ["fill", "top"];
    resultPanel.margins = 12;
    resultPanel.spacing = 6;
    resultPanel.visible = false;

    // ============================= 設定パネル =============================

    // ---- 設定 保存/読込ボタン(画面最上部に固定配置) ----
    // 【v6】Mac実機でウィンドウ最下部のボタン列・スクロールバーが表示されない問題が
    // v5の対策後も再発したため、方針を転換。ボタン列を「対象ドキュメント名のすぐ下・
    // 事前設定パネル群より上」に移動する。settingsPanelの一番最初の子として
    // (native top寄せで)配置することで、レイアウト計算がどうズレてもウィンドウの
    // 一番上にあるボタンだけは常に画面内に入ることを構造的に保証する。
    // スクロール領域(settingsViewportRow)の外に置く点は従来どおり。
    var settingsBtnGroup = settingsPanel.add("group");
    // 【v1.15.0】右寄せ→左寄せに変更(ユーザー指示)。ヘッダーのドキュメント名表示と同じ
    // 左端基準になる。"left"は自然幅ベースの計算に依存しないため、applySettingsWindowFit側の
    // 右寄せ用の手動再配置(btnX計算)は不要になり削除した。
    settingsBtnGroup.alignment = "left";
    var loadBtn = settingsBtnGroup.add("button", undefined, "設定を読込");
    var saveBtn = settingsBtnGroup.add("button", undefined, "設定を保存");
    var cancelBtn = settingsBtnGroup.add("button", undefined, "キャンセル", { name: "cancel" });
    var runBtn = settingsBtnGroup.add("button", undefined, "検版実行", { name: "ok" });
    // ESC=キャンセル / Enter=検版実行
    win.cancelElement = cancelBtn;
    win.defaultElement = runBtn;
    cancelBtn.onClick = function () {
        // 何もせず終了(設定も保存しない)
        win.close();
    };

    // ---- スクロール用ビューポート ----
    // ウィンドウを縮小すると設定項目が隠れて操作不能になる問題への対処。
    // ScriptUIにはネイティブのスクロールコンテナが無いため、定番の手法(固定/fill枠でクリッピングし、
    // 内側コンテンツの location.y をスクロールバーでシフトする)で実現する。
    // ボタン列(settingsBtnGroup)は上で既に配置済み(このビューポートの外・画面最上部)。
    var settingsViewportRow = settingsPanel.add("group");
    settingsViewportRow.orientation = "row";
    settingsViewportRow.alignChildren = ["fill", "fill"];
    settingsViewportRow.alignment = ["fill", "fill"];
    settingsViewportRow.spacing = 4;
    settingsViewportRow.margins = 0;

    // クリッピングされる外枠(alignment fillでウィンドウより小さくなり得る)
    var settingsViewport = settingsViewportRow.add("group");
    settingsViewport.orientation = "column";
    settingsViewport.alignChildren = ["fill", "top"];
    settingsViewport.alignment = ["fill", "fill"];
    settingsViewport.spacing = 0;
    settingsViewport.margins = 0;
    // コンテンツの自然高(minimumSize固定)が親のminimumSizeに伝播して
    // ビューポートが縮まなくなるのを防ぐため、小さい最小サイズを明示する
    settingsViewport.minimumSize = [200, 100];

    // 実コンテンツ(top寄せ・非fillのため自然な高さを保持し、ビューポートより大きい分ははみ出してクリップされる)
    var settingsContent = settingsViewport.add("group");
    settingsContent.orientation = "column";
    settingsContent.alignChildren = ["fill", "top"];
    // 【v1.15.0・横スクロール対応で重要】settingsViewport.alignChildren=["fill","top"]の
    // 既定を継承すると、settingsContent自身が横方向は常に"fill"(ビューポート幅に強制的に
    // 一致)されてしまい、captureSettingsBaseline内のwin.layout.layout(true)実行時に
    // 自然幅(settingsContentNaturalW)がビューポート幅と同値に測定されてしまい、横スクロールが
    // 常に不要と誤判定される。縦(top=非fill)と同様、横も明示的に非fill("left")にする。
    settingsContent.alignment = ["left", "top"];
    // 【v1.14.0】カテゴリパネル間のspacingを6→10に拡大し、視覚的な区切りを強調
    settingsContent.spacing = 10;
    settingsContent.margins = 0;

    // 【Mac対策】boundsをundefinedのまま生成すると、生成時点の暫定サイズ(幅≒高さに近い正方形)から
    // 縦/横どちらの向きのスクロールバーかが確定してしまい、後からのリサイズで縦長にしても
    // 向きが追随しないことがある。生成時点で明確に縦長のboundsを与えて縦スクロールバーに確定させる。
    var settingsScrollbar = settingsViewportRow.add("scrollbar", [0, 0, 16, 200], 0, 0, 0);
    settingsScrollbar.preferredSize.width = 16;
    settingsScrollbar.alignment = ["right", "fill"];
    settingsScrollbar.minvalue = 0;
    settingsScrollbar.stepdelta = 24;
    settingsScrollbar.jumpdelta = 120;
    settingsScrollbar.enabled = false;
    // 【v1.15.0・常時表示化】ユーザー提案の根本解決: .visible を必要な時だけ true/false で
    // トグルするのをやめ、常に true 固定にする(スクロール不要時は .enabled=false による
    // グレーアウトのみ)。これにより「Macでvisible切替のたびに再レイアウトが必要」という
    // 確定原因そのものが構造的に発生しなくなり、ウィンドウ右側やボタンのガタつきが解消される
    // (visibleが変化しないので forceScrollbarReflow の再レイアウト実行契機も無くなる)。
    settingsScrollbar.visible = true;

    // 【v1.15.0】横スクロールバー行(縦スクロールバーの下に配置)。
    // 仕組みは縦と同じ「常時表示、enabledのみ切替」方式で統一する。
    var settingsHScrollRow = settingsPanel.add("group");
    settingsHScrollRow.orientation = "row";
    settingsHScrollRow.alignChildren = ["fill", "fill"];
    settingsHScrollRow.alignment = ["fill", "top"];
    settingsHScrollRow.spacing = 4;
    settingsHScrollRow.margins = 0;
    // 生成時のboundsを横長にして、確実に horizontal スクロールバーとして確定させる
    // (縦スクロールバーが [0,0,16,200] で縦長boundsを使うのと対の措置)。
    var settingsHScrollbar = settingsHScrollRow.add("scrollbar", [0, 0, 200, 16], 0, 0, 0);
    settingsHScrollbar.preferredSize.height = 16;
    settingsHScrollbar.alignment = ["fill", "fill"];
    settingsHScrollbar.minvalue = 0;
    settingsHScrollbar.stepdelta = 24;
    settingsHScrollbar.jumpdelta = 120;
    settingsHScrollbar.enabled = false;
    settingsHScrollbar.visible = true; // 常時表示(縦と同方式)
    // 縦スクロールバーの真下に来る位置を軽く埋めるコーナースペーサー(見た目の整合用)
    var settingsHScrollCorner = settingsHScrollRow.add("group");
    settingsHScrollCorner.preferredSize.width = 16;
    settingsHScrollCorner.minimumSize.width = 16;
    settingsHScrollCorner.maximumSize.width = 16;

    // 【Mac確定原因・診断ログで実証済み】updateSettingsScrollRange()の内部計算(maxScroll等)は
    // 正しく行われ、settingsScrollbar.visible/enabled も正しい値に設定されているのに、
    // macOS(Cocoa)では画面に反映されないことがあった。原因は、可視性プロパティを実行時に
    // 切り替えた後に親コンテナへ明示的な再レイアウトを一切呼んでいなかったこと
    // (Windowsはプロパティ変更だけで自動再描画されるが、Cocoaはそうならないことがある)。
    // 【v1.15.0】visibleは常時trueで変化しなくなったため、代わりに enabled の変化を追跡する
    // (縦・横それぞれ独立に追跡)。初回は必ず一致しない値にしておき、初回も確実に反映させる。
    var settingsScrollbarLastEnabled = null;
    var settingsHScrollbarLastEnabled = null;

    // ---- スクロール/リサイズのジオメトリ管理 ----
    // 【方針】設定画面のリサイズは layout.resize() に任せず、初回レイアウト確定時に記録した
    // 「初期確定値(baseline)+ ウィンドウサイズ差分」から毎回計算する。
    // 前回のリサイズ結果を一切参照しないため、リサイズ繰り返しによる余白の累積が構造的に起きない。
    var settingsBaseline = null;       // 初回レイアウト確定時のジオメトリ記録
    var settingsContentNaturalH = 0;   // 設定コンテンツの自然高(初回実測で固定)
    var settingsContentNaturalW = 0;   // 【v1.15.0】設定コンテンツの自然幅(横スクロール用、初回実測で固定)

    // 【Mac対策】win.onShow直後はCocoa側のネイティブレイアウトが未確定で、
    // サイズ実測(.size)が不正確な場合がある(0や暫定値のまま)。
    // このタイミングでコンテンツ高を誤って固定してしまうと、後から正しい値で
    // 再測定しようとしても maximumSize の制約に阻まれて自然高を測れなくなる
    // (固定値の"自己ポイズニング")。そのため毎回の測定前に制約を一旦解除し、
    // 明示的に layout.layout(true) を呼んでから実測する(冪等・再呼び出し安全)。
    // sourceTag: どの呼び出し経路から来たかログで区別するための文字列
    // ("onShow-immediate" / "onShow-deferred80ms" 等)。省略時は "(不明)"。
    function captureSettingsBaseline(sourceTag) {
        var tag = sourceTag ? sourceTag : "(不明)";
        try {
            dlog("SCROLL", "captureSettingsBaseline[" + tag + "] 開始: win.size=" + fmtArr(win.size) +
                " settingsViewport.size(制約解除前)=" + fmtArr(safe(function () { return settingsViewport.size; }, null)) +
                " settingsContent.size(制約解除前)=" + fmtArr(safe(function () { return settingsContent.size; }, null)) +
                " screens[0]=" + fmtScreen(safe(function () { return $.screens[0]; }, null)));
            settingsContent.minimumSize = [0, 0];
            settingsContent.maximumSize = [100000, 100000];
            // 【v1.16.0・再入防止→v1.17.0・確定原因により対象を変更】
            // win全体を対象にlayout.layout(true)すると、Windows実機でwin.size自体が
            // +25px前後増加する副作用が確認された。自然サイズの測定にはsettingsContent自身の
            // layoutで十分(子要素から自然サイズがボトムアップで再計算されるため)なので、
            // winではなくsettingsContentを対象にする(ウィンドウサイズへの副作用を回避)。
            safeWinLayout(settingsContent);
            // コンテンツの自然高・自然幅を実測して固定し、以後のlayout処理で縮まないようにする
            // (layout.resize()がcolumn内でコンテンツをビューポート高/幅に縮めてしまうと、
            //  実高/実幅=可視高/可視幅になりスクロール不要と誤判定されるため)
            settingsContentNaturalH = settingsContent.size[1];
            settingsContentNaturalW = settingsContent.size[0];
            var usedFallback = false;
            if (!settingsContentNaturalH || settingsContentNaturalH < 10) {
                // 実測が不正(未確定)な場合はpreferredSizeにフォールバック
                settingsContentNaturalH = settingsContent.preferredSize ? settingsContent.preferredSize[1] : 0;
                usedFallback = true;
            }
            if (!settingsContentNaturalW || settingsContentNaturalW < 10) {
                settingsContentNaturalW = settingsContent.preferredSize ? settingsContent.preferredSize[0] : 0;
                usedFallback = true;
            }
            settingsContent.minimumSize.height = settingsContentNaturalH;
            settingsContent.maximumSize.height = settingsContentNaturalH;
            settingsContent.minimumSize.width = settingsContentNaturalW;
            settingsContent.maximumSize.width = settingsContentNaturalW;
            settingsBaseline = {
                winW: win.size[0], winH: win.size[1],
                screensW: screens.size[0], screensH: screens.size[1],
                panelW: settingsPanel.size[0], panelH: settingsPanel.size[1],
                rowW: settingsViewportRow.size[0], rowH: settingsViewportRow.size[1],
                vpW: settingsViewport.size[0], vpH: settingsViewport.size[1],
                sbX: settingsScrollbar.location[0], sbY: settingsScrollbar.location[1],
                sbH: settingsScrollbar.size[1]
                // 【v6】ボタン列は画面最上部に固定配置に変更したため、
                // baselineでの位置記録・差分再配置の対象から外した(常にネイティブlayoutの
                // top寄せに任せる。詳細はensureSettingsButtonsVisible()を参照)。
            };
            dlog("SCROLL", "captureSettingsBaseline[" + tag + "] 完了: settingsContentNaturalH=" + settingsContentNaturalH +
                " settingsContentNaturalW=" + settingsContentNaturalW +
                " (preferredSizeへのフォールバック使用=" + usedFallback + ")" +
                " settingsContent.size(制約後)=" + fmtArr(safe(function () { return settingsContent.size; }, null)) +
                " settingsViewport.size=" + fmtArr(settingsViewport.size) +
                " win.size=" + fmtArr(win.size) +
                " screens[0]=" + fmtScreen(safe(function () { return $.screens[0]; }, null)));
            // 【v1.12.0】直前の layout.layout(true) は内部コンテナを自然幅(ウィンドウより
            // 広いことがある)に戻してしまうため、必ず直後にウィンドウ実サイズへの
            // フィットを適用する。画面が小さいMacで「最初からはみ出している」ケースへの
            // 補正はここが最重要(onShow即時・80ms遅延の両経路から到達する)。
            applySettingsWindowFit(tag);
        } catch (eCap) {
            dlog("SCROLL", "captureSettingsBaseline[" + tag + "] 例外発生: " + eCap.toString());
        }
    }

    // 【v1.12.0・確定原因への対処】Macの実機ログで、スクロールバーは正常に存在・可視・
    // 正常サイズ(16x500等)であるにもかかわらず bounds.x(820等)がウィンドウ実幅
    // (win.size=[820,485])の右端以遠=画面外に配置されていることが確定した。
    // 原因: 画面が小さいMacではウィンドウは縮小されて開くが、内部のviewportRow/viewport/
    // contentは自然幅(969px等)のまま縮まず、その右端に置かれたスクロールバーが
    // ウィンドウ外にはみ出していた(Windowsは画面が大きく自然幅で開けたため無症状)。
    // 過去の「ボタンが見えない」問題も同根(コンテンツがウィンドウより大きい)の可能性が高い。
    //
    // 対処: 従来の「baseline+差分」ではなく、横・縦とも「現在のウィンドウ実サイズ」から
    // 絶対値で計算し直す。前回状態もbaselineも参照しないため、累積バグも構造的に起きない。
    // 各コンテナのウィンドウ内オフセット(マージン)は実測値(location)から取得する。
    function applySettingsWindowFit(sourceTag) {
        var tag = sourceTag ? sourceTag : "(不明)";
        try {
            if (!win.size) { dlog("SCROLL", "applySettingsWindowFit[" + tag + "] win.size未確定のためスキップ"); return; }
            var winW = win.size[0], winH = win.size[1];
            // screens(win直下)の左上オフセット=ウィンドウのマージン(左右対称と仮定)
            var scrX = screens.location ? screens.location[0] : 8;
            var scrY = screens.location ? screens.location[1] : 8;
            // 【v1.14.0】スクロールバーをウィンドウ右端に密着させるため、右マージンは
            // SB_EDGE_GAP(2px)だけ残して使い切る(従来は左右対称マージンで、
            // scrX+rowX ≈ 20px以上の隙間がスクロールバー右に生じていた)。
            var SB_EDGE_GAP = 2;
            var availW = winW - scrX - SB_EDGE_GAP; // 左=scrX / 右=2px のみ
            // 【v1.18.0】横スクロールバーをウィンドウ下端に密着させるため、下マージンも
            // SB_EDGE_GAP(2px)だけ残して使い切る(従来はscrX(≒8px)相当+後段の
            // 「パネル下マージン12px」控除の合計20px前後の隙間が下端に生じていた)。
            var availH = winH - scrY - SB_EDGE_GAP;
            if (availW < 200) availW = 200;
            if (availH < 150) availH = 150;
            screens.size = [availW, availH];
            settingsPanel.size = [availW, availH]; // stack内の子はscreensと同位置・同寸
            // settingsViewportRow は settingsPanel 内(x=パネルmargins、y=ボタン行の下)
            var panelX = settingsPanel.location ? settingsPanel.location[0] : 0; // stack内で通常0
            var rowX = settingsViewportRow.location ? settingsViewportRow.location[0] : 12;
            var rowY = settingsViewportRow.location ? settingsViewportRow.location[1] : 40;
            // 行の右端をウィンドウクライアント右端-2pxまで届かせる
            // (行のウィンドウ内絶対x = scrX + panelX + rowX。ローカル座標系の親オフセットを
            //  差し引いて逆算する)
            var rowAbsX = scrX + panelX + rowX;
            var rowW = winW - rowAbsX - SB_EDGE_GAP;
            // 【v1.15.0→v1.18.0】横スクロールバー行(settingsHScrollRow)の高さ+spacing(6px想定)を
            // 縦方向の可用高から先に差し引いておく(縦スクロール可視領域rowHの計算に反映)。
            // 旧「パネル下マージン12px」の控除は、availH側で既にSB_EDGE_GAPまで使い切る計算に
            // 変更したため廃止(横スクロールバー下端がウィンドウ下端-2pxに一致するようになる)。
            var hScrollH = 16;
            var hScrollGap = 6;
            var rowH = availH - rowY - hScrollH - hScrollGap;
            if (rowW < 120) rowW = 120;
            if (rowH < 80) rowH = 80;
            settingsViewportRow.size = [rowW, rowH];
            // スクロールバーは行の右端「内側」に絶対配置。行の右端自体がウィンドウ右端-2pxに
            // 一致するため、スクロールバー右端はウィンドウ右端にほぼ密着する。
            var sbW = 16;
            settingsScrollbar.size = [sbW, rowH];
            settingsScrollbar.location = [rowW - sbW, 0];
            // ビューポートは残り幅(スクロールバー幅+spacing 4 を除く)
            var vpW = rowW - sbW - 4;
            if (vpW < 100) vpW = 100;
            settingsViewport.size = [vpW, rowH];
            settingsViewport.location = [0, 0];

            // 【v1.15.0】横スクロールバー行をviewportRowの直下、同じ左端・同じ幅で配置
            safe(function () {
                settingsHScrollRow.location = [rowX, rowY + rowH + hScrollGap];
                settingsHScrollRow.size = [rowW, hScrollH];
                // 縦スクロールバーの真下にコーナースペーサーが来るよう、横スクロールバー自体は
                // 幅 vpW(縦スクロールバー分を除いた幅)に収める
                settingsHScrollbar.size = [vpW, hScrollH];
                return null;
            }, null);

            // 【v1.15.0・横スクロール対応】コンテンツは自然幅(settingsContentNaturalW)のまま保持し、
            // ビューポート幅より広い場合は右側がクリップされ、横スクロールバーで見えるようにする
            // (従来のようにコンテンツ幅をビューポート幅へ強制的に縮めることはしない)。
            safe(function () {
                var ch = (settingsContentNaturalH > 0) ? settingsContentNaturalH : settingsContent.size[1];
                var cw = (settingsContentNaturalW > 0) ? settingsContentNaturalW : settingsContent.size[0];
                settingsContent.size = [cw, ch];
                return null;
            }, null);
            // 【v1.15.0】ボタン列は左寄せに変更したため、右端合わせの手動再配置は不要になった
            // (alignment="left"は自然幅ベースの計算に依存せず、常にウィンドウ内に収まる)。
            dlog("SCROLL", "applySettingsWindowFit[" + tag + "] 完了: win=" + fmtArr(win.size) +
                " availW=" + availW + " availH=" + availH +
                " rowW=" + rowW + " rowH=" + rowH +
                " scrollbar.location=" + fmtArr(safe(function () { return settingsScrollbar.location; }, null)) +
                " scrollbar.bounds=" + fmtArr(safe(function () { return settingsScrollbar.bounds; }, null)) +
                " hScrollbar.bounds=" + fmtArr(safe(function () { return settingsHScrollbar.bounds; }, null)) +
                " viewport.size=" + fmtArr(safe(function () { return settingsViewport.size; }, null)) +
                " settingsBtnGroup.location=" + fmtArr(safe(function () { return settingsBtnGroup.location; }, null)));
        } catch (eFit) {
            dlog("SCROLL", "applySettingsWindowFit[" + tag + "] 例外発生: " + eFit.toString());
        }
    }

    // ウィンドウリサイズ確定時の再配置。v1.12.0からは「baseline+差分」ではなく
    // ウィンドウ実サイズからの絶対計算(applySettingsWindowFit)に一本化した。
    function applySettingsResize() {
        applySettingsWindowFit("onResize");
    }

    // 【v6・最終防衛策】ボタン列は settingsPanel の一番最初の子として配置しているため、
    // 通常はネイティブレイアウトにより常にパネル最上部(location.y ≈ 0)に固定表示される
    // ―― ウィンドウの一番上は縮小・リサイズ計算がどうズレても必ず画面内に入るため、
    // 「下部に置く限り消えるリスクが残る」問題を構造的に解消できる。
    // 万一(何らかの理由で)この前提が崩れて上端からずれた場合に備え、強制的に引き戻す保険を残す。
    function ensureSettingsButtonsVisible() {
        try {
            if (!settingsBtnGroup.location) return;
            var btnTop = settingsBtnGroup.location[1];
            if (btnTop === undefined || btnTop === null || isNaN(btnTop) || btnTop < 0 || btnTop > 4) {
                settingsBtnGroup.location = [settingsBtnGroup.location[0], 0];
            }
            if (settingsBtnGroup.visible === false) settingsBtnGroup.visible = true;
            if (settingsBtnGroup.enabled === false) settingsBtnGroup.enabled = true;
        } catch (eEnsure) {}
    }

    // スクロール範囲の再計算。判定は「固定したコンテンツ自然高 vs ビューポート可視高(リサイズ後)」。
    // ウィンドウ高がコンテンツ高より小さい場合: viewportH < settingsContentNaturalH となり
    // maxScroll > 0 → else分岐で scrollbar.visible = true / enabled = true になる。
    // 【v1.11.0】settingsViewportRow.layout.layout(true) の追加だけではMacで直らなかったため、
    // 複数の再描画手段を「多層防御」として同時に試し、それぞれの成否をログに残す
    // (1つに賭けるのではなく、次のログで「どれが効いたか」を後から判別できるようにする)。
    // 効果が不明な手段でも実害が無いものはすべて残す方針。
    // 【v1.15.0】方針転換: .visible は常時true固定にしたため、旧・手段4(visibleトグル)は
    // 廃止し、代わりに enabled のトグルに差し替えた(関数自体はログ確認のため温存)。
    // reason: どの状況で呼ばれたかログで区別するための文字列。
    // 【v1.16.0・再入防止】この関数自体は丸ごとガードしない(呼び出し元のupdateSettingsScrollRange
    // 経由での正常な呼び出しを妨げないため)。ただし手段1・2はwin.onResizeを誘発し得る
    // 危険な操作(win.layout.layout(true)系)なので、実行直前だけFIT_IN_PROGRESS=trueにして、
    // その最中に同期的に発火するかもしれないwin.onResizeを確実に無視させる(呼び出し直後に
    // false へ戻す狭い区間ガード。関数全体を覆うと、この関数末尾で正規に呼ぶ
    // applySettingsWindowFit の実行まで妨げてしまうため、危険な操作だけを個別に囲む)。
    function forceScrollbarReflow(reason) {
        var tagR = reason ? reason : "(不明)";
        // 手段1: scrollbarを含む親コンテナ(settingsViewportRow)の再レイアウト
        var ok1 = safeWinLayout(settingsViewportRow);
        dlog("SCROLL", "再レイアウト手段1(settingsViewportRow.layout.layout)[" + tagR + "]: 成功=" + ok1);

        // 【v1.17.0・確定原因により削除】旧・手段2(win.layout.layout(true))は、
        // Windows実機ログで「呼ぶたびにwin.size自体が+25px前後増加する」という
        // OSレベルの副作用が実証されたため完全に削除した。この関数はスクロールバーの
        // enabled切替のたびに呼ばれる高頻度パスであり、リサイズを繰り返すたびに
        // ウィンドウが際限なく伸びる「体感」の直接原因だった。手段1(個別コンテナの
        // layout.layout)はウィンドウサイズへの副作用が無いと考えられるため残す。

        // 手段3: ScriptUIの notify() による明示的な再描画通知(存在すれば)。
        // "onDraw" はScriptUIの標準イベント名として文書化されていないため効果は未知数だが、
        // 存在しない/無効でも例外はsafe()で吸収されるだけで実害は無いため試す。
        var ok3 = safe(function () {
            if (settingsScrollbar.notify) { settingsScrollbar.notify("onDraw"); return true; }
            return false;
        }, false);
        dlog("SCROLL", "再レイアウト手段3(settingsScrollbar.notify('onDraw'))[" + tagR + "]: 成功=" + ok3);

        // 【v1.15.0】旧手段4は visible を false→trueへトグルしていたが、常時表示化により
        // visible自体は動かさない方針にしたため廃止。代わりに enabled を一瞬トグルして
        // 同種の「変更を描画エンジンに気づかせる」効果を狙う(実害が無いため残す。
        // 効果不明でもログで判別できるようにする)。
        var ok4 = safe(function () {
            var curV = settingsScrollbar.enabled, curH = settingsHScrollbar.enabled;
            settingsScrollbar.enabled = !curV; settingsScrollbar.enabled = curV;
            settingsHScrollbar.enabled = !curH; settingsHScrollbar.enabled = curH;
            return true;
        }, false);
        dlog("SCROLL", "再レイアウト手段4(enabledトグルによる再描画ナッジ)[" + tagR + "]: 成功=" + ok4);

        // 【v1.12.0・重要】手段1・2のlayout.layout(true)は内部コンテナを自然幅
        // (ウィンドウより広いことがある)へ戻してしまい、スクロールバーが再び
        // ウィンドウ外へはみ出す(=確定原因の再発)。そのためリフロー後は必ず
        // ウィンドウ実サイズへのフィットを再適用して整合させる。
        applySettingsWindowFit("afterReflow-" + tagR);
    }

    function updateSettingsScrollRange() {
        try {
            if (settingsBaseline) {
                var viewportH = settingsViewport.size ? settingsViewport.size[1] : 0;
                var viewportW = settingsViewport.size ? settingsViewport.size[0] : 0;
                var maxScrollV = settingsContentNaturalH - viewportH;
                var maxScrollH = settingsContentNaturalW - viewportW;
                if (maxScrollV < 0) maxScrollV = 0;
                if (maxScrollH < 0) maxScrollH = 0;
                settingsScrollbar.maxvalue = maxScrollV;
                settingsHScrollbar.maxvalue = maxScrollH;

                // 【v1.15.0・常時表示化】.visible は常時true固定(ここでは一切変更しない)。
                // スクロール不要時は .enabled=false によるグレーアウトのみで表現する。
                var vEnabled = maxScrollV > 0;
                var hEnabled = maxScrollH > 0;
                settingsScrollbar.enabled = vEnabled;
                settingsHScrollbar.enabled = hEnabled;
                if (settingsScrollbar.value > maxScrollV) settingsScrollbar.value = maxScrollV;
                if (settingsHScrollbar.value > maxScrollH) settingsHScrollbar.value = maxScrollH;
                if (!vEnabled) settingsScrollbar.value = 0;
                if (!hEnabled) settingsHScrollbar.value = 0;
                settingsContent.location = [-settingsHScrollbar.value, -settingsScrollbar.value];

                dlog("SCROLL", "updateSettingsScrollRange: naturalH=" + settingsContentNaturalH +
                    " viewportH=" + viewportH + " maxScrollV=" + maxScrollV +
                    " / naturalW=" + settingsContentNaturalW + " viewportW=" + viewportW + " maxScrollH=" + maxScrollH +
                    " -> v.enabled=" + vEnabled + " h.enabled=" + hEnabled + " (visibleは常時true固定のため変化なし)");

                // 【Mac対策】enabled状態が変化した時だけ多層の再描画手段を試す(縦・横を独立追跡)。
                if (settingsScrollbarLastEnabled !== vEnabled) {
                    forceScrollbarReflow("v-enabled->" + vEnabled);
                    settingsScrollbarLastEnabled = vEnabled;
                }
                if (settingsHScrollbarLastEnabled !== hEnabled) {
                    forceScrollbarReflow("h-enabled->" + hEnabled);
                    settingsHScrollbarLastEnabled = hEnabled;
                }

                // 【検証ログ】実際に画面へ反映されたはずの状態を再取得して記録する。
                dlog("SCROLL", "検証: 設定直後の再取得 v.visible=" +
                    safe(function () { return settingsScrollbar.visible; }, "(取得失敗)") +
                    " v.enabled=" + safe(function () { return settingsScrollbar.enabled; }, "(取得失敗)") +
                    " v.bounds=" + fmtArr(safe(function () { return settingsScrollbar.bounds; }, null)) +
                    " h.visible=" + safe(function () { return settingsHScrollbar.visible; }, "(取得失敗)") +
                    " h.enabled=" + safe(function () { return settingsHScrollbar.enabled; }, "(取得失敗)") +
                    " h.bounds=" + fmtArr(safe(function () { return settingsHScrollbar.bounds; }, null)));
            } else {
                dlog("SCROLL", "updateSettingsScrollRange: settingsBaselineが未確定のためスキップ");
            }
        } catch (eScroll) {
            dlog("SCROLL", "updateSettingsScrollRange: 例外発生 " + eScroll.toString());
        }
        // baseline計算の成否によらず、ボタン列の可視性は必ずこの後で保証する
        ensureSettingsButtonsVisible();
    }
    // 縦・横どちらのスクロールバーが動いても settingsContent の位置は両方の値を反映する
    function applySettingsContentScrollLocation() {
        settingsContent.location = [-settingsHScrollbar.value, -settingsScrollbar.value];
    }
    settingsScrollbar.onChanging = applySettingsContentScrollLocation;
    settingsScrollbar.onChange = applySettingsContentScrollLocation;
    settingsHScrollbar.onChanging = applySettingsContentScrollLocation;
    settingsHScrollbar.onChange = applySettingsContentScrollLocation;

    // --- 仕上がりサイズ ---
    var sizeGroup = settingsContent.add("panel", undefined, "仕上がりサイズ");
    sizeGroup.orientation = "row";
    sizeGroup.alignChildren = ["left", "center"];
    applyPanelBackdrop(sizeGroup); // 【v1.14.0】面での区切り(背景をわずかに明るく)
    sizeGroup.add("statictext", undefined, "サイズ:");
    var sizeDropdown = sizeGroup.add("dropdownlist", undefined, []);
    for (var si = 0; si < SIZE_PRESET_KEYS.length; si++) {
        sizeDropdown.add("item", SIZE_PRESET_LABELS[SIZE_PRESET_KEYS[si]]);
    }
    var sizeKeyIndex = 0;
    for (var sk = 0; sk < SIZE_PRESET_KEYS.length; sk++) { if (SIZE_PRESET_KEYS[sk] === cfg.sizeKey) sizeKeyIndex = sk; }
    sizeDropdown.selection = sizeKeyIndex;

    sizeGroup.add("statictext", undefined, "幅(mm):");
    var customWField = sizeGroup.add("edittext", undefined, String(cfg.customWidthMM));
    customWField.characters = 6;
    sizeGroup.add("statictext", undefined, "高さ(mm):");
    var customHField = sizeGroup.add("edittext", undefined, String(cfg.customHeightMM));
    customHField.characters = 6;
    sizeGroup.add("statictext", undefined, "許容誤差(mm):");
    var tolField = sizeGroup.add("edittext", undefined, String(cfg.sizeToleranceMM));
    tolField.characters = 5;

    function updateCustomEnabled() {
        var isCustom = (SIZE_PRESET_KEYS[sizeDropdown.selection.index] === "CUSTOM");
        customWField.enabled = isCustom;
        customHField.enabled = isCustom;
    }
    sizeDropdown.onChange = updateCustomEnabled;
    updateCustomEnabled();

    // --- 印刷カラー数 ---
    var colorGroup = settingsContent.add("panel", undefined, "印刷カラー数");
    colorGroup.orientation = "row";
    applyPanelBackdrop(colorGroup); // 【v1.14.0】面での区切り
    colorGroup.add("statictext", undefined, "カラー数:");
    var colorDropdown = colorGroup.add("dropdownlist", undefined, []);
    for (var ci = 0; ci < COLOR_MODE_KEYS.length; ci++) {
        colorDropdown.add("item", COLOR_MODE_LABELS[COLOR_MODE_KEYS[ci]]);
    }
    var colorKeyIndex = 0;
    for (var ck = 0; ck < COLOR_MODE_KEYS.length; ck++) { if (COLOR_MODE_KEYS[ck] === cfg.colorModeKey) colorKeyIndex = ck; }
    colorDropdown.selection = colorKeyIndex;
    colorGroup.add("statictext", undefined, "想定特色数(0=チェックしない):");
    var expectedSpotField = colorGroup.add("edittext", undefined, String(cfg.expectedSpotCount));
    expectedSpotField.characters = 4;

    // --- 数値設定 ---
    var numGroup = settingsContent.add("panel", undefined, "各種数値設定");
    numGroup.orientation = "column";
    numGroup.alignChildren = ["left", "top"];
    applyPanelBackdrop(numGroup); // 【v1.14.0】面での区切り
    var numRow1 = numGroup.add("group");
    numRow1.add("statictext", undefined, "塗り足し幅(mm):");
    var bleedField = numRow1.add("edittext", undefined, String(cfg.bleedMM)); bleedField.characters = 5;
    numRow1.add("statictext", undefined, "文字セーフマージン(mm):");
    var marginField = numRow1.add("edittext", undefined, String(cfg.textMarginMM)); marginField.characters = 5;
    numRow1.add("statictext", undefined, "最小線幅(pt):");
    var strokeField = numRow1.add("edittext", undefined, String(cfg.minStrokePt)); strokeField.characters = 5;

    var numRow2 = numGroup.add("group");
    numRow2.add("statictext", undefined, "画像解像度 カラー/グレー 下限(dpi):");
    var dpiField = numRow2.add("edittext", undefined, String(cfg.minImageDPI)); dpiField.characters = 5;
    numRow2.add("statictext", undefined, "過剰警告(dpi):");
    var dpiMaxField = numRow2.add("edittext", undefined, String(cfg.maxImageDPI)); dpiMaxField.characters = 5;
    numRow2.add("statictext", undefined, "モノクロ2値 下限(dpi):");
    var bmpDpiField = numRow2.add("edittext", undefined, String(cfg.minBitmapDPI)); bmpDpiField.characters = 5;
    numRow2.add("statictext", undefined, "過剰警告(dpi):");
    var bmpDpiMaxField = numRow2.add("edittext", undefined, String(cfg.maxBitmapDPI)); bmpDpiMaxField.characters = 5;

    var numRow3 = numGroup.add("group");
    numRow3.add("statictext", undefined, "インキ総量上限(%):");
    var inkField = numRow3.add("edittext", undefined, String(cfg.maxInkPercent)); inkField.characters = 5;
    var inkPresetDropdown = numRow3.add("dropdownlist", undefined, ["プリセット選択", "標準 300%", "油性 350%", "UV 380%"]);
    inkPresetDropdown.selection = 0;
    inkPresetDropdown.onChange = function () {
        if (!inkPresetDropdown.selection) return;
        var idx = inkPresetDropdown.selection.index;
        if (idx === 1) inkField.text = "300";
        else if (idx === 2) inkField.text = "350";
        else if (idx === 3) inkField.text = "380";
    };
    numRow3.add("statictext", undefined, "ラスタライズ効果解像度下限(ppi):");
    var rasterField = numRow3.add("edittext", undefined, String(cfg.minRasterEffectPPI)); rasterField.characters = 5;

    var numRow4 = numGroup.add("group");
    numRow4.add("statictext", undefined, "オブジェクト総数警告閾値:");
    var objCountField = numRow4.add("edittext", undefined, String(cfg.maxObjectCount)); objCountField.characters = 8;
    numRow4.add("statictext", undefined, "細ケイ閾値(pt):");
    var thinLineField = numRow4.add("edittext", undefined, String(cfg.thinLinePt)); thinLineField.characters = 5;
    numRow4.add("statictext", undefined, "薄アミ濃度閾値(%):");
    var lightInkField = numRow4.add("edittext", undefined, String(cfg.lightInkPercent)); lightInkField.characters = 5;

    // --- チェック項目ON/OFF ---
    var checkPanel = settingsContent.add("panel", undefined, "チェック項目");
    checkPanel.orientation = "row";
    checkPanel.alignChildren = ["left", "top"];
    applyPanelBackdrop(checkPanel); // 【v1.14.0】面での区切り
    var checkColGroups = [];
    for (var cc = 0; cc < CATEGORY_ORDER.length; cc++) {
        var colG = checkPanel.add("group");
        colG.orientation = "column";
        colG.alignChildren = ["left", "top"];
        colG.add("statictext", undefined, CATEGORY_ORDER[cc] + ":").graphics.font = ScriptUI.newFont("dialog", "Bold", 11);
        checkColGroups.push(colG);
    }
    var checkBoxes = {};
    var idOrder = getCheckIdOrder();
    for (var io = 0; io < idOrder.length; io++) {
        var id = idOrder[io];
        var meta = CHECK_META[id];
        var colIndex = 0;
        for (var cix = 0; cix < CATEGORY_ORDER.length; cix++) { if (CATEGORY_ORDER[cix] === meta.category) colIndex = cix; }
        var cb = checkColGroups[colIndex].add("checkbox", undefined, meta.name);
        cb.value = cfg.checks[id];
        checkBoxes[id] = cb;
    }

    // 【v6】設定 保存/読込ボタン(settingsBtnGroup等)は設定画面の一番上に移動済み。
    // 生成・onClick割当は buildAndShowDialog冒頭(settingsPanel直後)を参照。

    function collectConfigFromUI() {
        var c = defaultConfig();
        c.sizeKey = SIZE_PRESET_KEYS[sizeDropdown.selection.index];
        c.customWidthMM = parseFloat(customWField.text) || c.customWidthMM;
        c.customHeightMM = parseFloat(customHField.text) || c.customHeightMM;
        c.sizeToleranceMM = parseFloat(tolField.text);
        if (isNaN(c.sizeToleranceMM)) c.sizeToleranceMM = 0.5;
        c.colorModeKey = COLOR_MODE_KEYS[colorDropdown.selection.index];
        c.expectedSpotCount = parseInt(expectedSpotField.text, 10);
        if (isNaN(c.expectedSpotCount)) c.expectedSpotCount = 0;
        c.bleedMM = parseFloat(bleedField.text); if (isNaN(c.bleedMM)) c.bleedMM = 3;
        c.textMarginMM = parseFloat(marginField.text); if (isNaN(c.textMarginMM)) c.textMarginMM = 5;
        c.minStrokePt = parseFloat(strokeField.text); if (isNaN(c.minStrokePt)) c.minStrokePt = 0.25;
        c.minImageDPI = parseFloat(dpiField.text); if (isNaN(c.minImageDPI)) c.minImageDPI = 300;
        c.maxImageDPI = parseFloat(dpiMaxField.text); if (isNaN(c.maxImageDPI)) c.maxImageDPI = 900;
        c.minBitmapDPI = parseFloat(bmpDpiField.text); if (isNaN(c.minBitmapDPI)) c.minBitmapDPI = 600;
        c.maxBitmapDPI = parseFloat(bmpDpiMaxField.text); if (isNaN(c.maxBitmapDPI)) c.maxBitmapDPI = 1200;
        c.maxInkPercent = parseFloat(inkField.text); if (isNaN(c.maxInkPercent)) c.maxInkPercent = 300;
        c.minRasterEffectPPI = parseFloat(rasterField.text); if (isNaN(c.minRasterEffectPPI)) c.minRasterEffectPPI = 300;
        c.maxObjectCount = parseFloat(objCountField.text); if (isNaN(c.maxObjectCount)) c.maxObjectCount = 100000;
        c.thinLinePt = parseFloat(thinLineField.text); if (isNaN(c.thinLinePt)) c.thinLinePt = 0.5;
        c.lightInkPercent = parseFloat(lightInkField.text); if (isNaN(c.lightInkPercent)) c.lightInkPercent = 20;
        for (var id2 in checkBoxes) { if (checkBoxes.hasOwnProperty(id2)) c.checks[id2] = checkBoxes[id2].value; }
        return c;
    }

    function applyConfigToUI(c) {
        for (var sk2 = 0; sk2 < SIZE_PRESET_KEYS.length; sk2++) { if (SIZE_PRESET_KEYS[sk2] === c.sizeKey) sizeDropdown.selection = sk2; }
        customWField.text = String(c.customWidthMM);
        customHField.text = String(c.customHeightMM);
        tolField.text = String(c.sizeToleranceMM);
        for (var ck2 = 0; ck2 < COLOR_MODE_KEYS.length; ck2++) { if (COLOR_MODE_KEYS[ck2] === c.colorModeKey) colorDropdown.selection = ck2; }
        expectedSpotField.text = String(c.expectedSpotCount);
        bleedField.text = String(c.bleedMM);
        marginField.text = String(c.textMarginMM);
        strokeField.text = String(c.minStrokePt);
        dpiField.text = String(c.minImageDPI);
        dpiMaxField.text = String(c.maxImageDPI);
        bmpDpiField.text = String(c.minBitmapDPI);
        bmpDpiMaxField.text = String(c.maxBitmapDPI);
        inkField.text = String(c.maxInkPercent);
        rasterField.text = String(c.minRasterEffectPPI);
        objCountField.text = String(c.maxObjectCount);
        thinLineField.text = String(c.thinLinePt);
        lightInkField.text = String(c.lightInkPercent);
        for (var id3 in checkBoxes) { if (checkBoxes.hasOwnProperty(id3)) checkBoxes[id3].value = c.checks[id3]; }
        updateCustomEnabled();
    }

    saveBtn.onClick = function () {
        var c = collectConfigFromUI();
        if (saveConfig(c)) {
            alert("設定を保存しました。\n" + getSettingsFile().fsName);
        } else {
            alert("設定の保存に失敗しました。");
        }
    };
    loadBtn.onClick = function () {
        var c = loadConfig();
        applyConfigToUI(c);
    };

    // ============================= 結果パネル =============================

    // ---- 結果画面のボタン列(画面最上部に固定配置) ----
    // 【v7】設定画面(v6)で「ボタン列を画面最上部に固定配置することで、レイアウト計算の
    // ズレに関わらずボタンが必ず画面内に入る」ようにした対策と同じ理由・同じ構造を
    // 結果画面にも適用する。resultPanelの一番最初の子として(native top寄せで)配置。
    var resultBtnGroup = resultPanel.add("group");
    // 【v1.15.0】右寄せ→左寄せに変更(ユーザー指示。設定画面と統一)。
    resultBtnGroup.alignment = "left";
    var backBtn = resultBtnGroup.add("button", undefined, "設定に戻る");
    var saveHtmlBtn = resultBtnGroup.add("button", undefined, "レポート保存(HTML)");
    var saveCsvBtn = resultBtnGroup.add("button", undefined, "レポート保存(CSV)");
    var closeBtn = resultBtnGroup.add("button", undefined, "閉じる"); // nameは付けない(設定側キャンセルとESC割当が競合するため)

    var summaryText = resultPanel.add("statictext", undefined, "");
    summaryText.graphics.font = ScriptUI.newFont("dialog", "Bold", 18);
    var finishSizeText = resultPanel.add("statictext", undefined, "");
    finishSizeText.graphics.font = ScriptUI.newFont("dialog", "Bold", 12);

    var progressGroup = resultPanel.add("group");
    progressGroup.orientation = "column";
    progressGroup.alignChildren = ["fill", "top"];
    var progressBar = progressGroup.add("progressbar", undefined, 0, 100);
    progressBar.preferredSize.height = 12;
    progressBar.alignment = ["fill", "top"]; // 幅はウィンドウに追随
    // 【Mac対策・再修正】v4では statictext + characters=60 で幅確保を試みたが、
    // "characters" は本来 edittext 用のプロパティであり statictext には正式サポートが無く、
    // Mac(Cocoa)側で無視されて幅確保が効いていなかった可能性が高い。
    // 全プラットフォーム共通でサポートされる preferredSize.width をピクセル値で直接指定する方式に変更し、
    // さらに、動的テキスト更新がstatictextより確実とされる readonly edittext に置き換える
    // (Mac の ScriptUI では動作中の statictext 差し替えが描画に反映されない既知の癖があるため)。
    var progressLabel = progressGroup.add("edittext", undefined, "", { readonly: true });
    progressLabel.preferredSize.width = 620;
    progressLabel.alignment = ["fill", "top"];
    dlog("PROGRESS", "progressLabel生成直後: type=" + safe(function () { return progressLabel.type; }, "(不明)") +
        " preferredSize=" + fmtArr(safe(function () { return progressLabel.preferredSize; }, null)) +
        " size=" + fmtArr(safe(function () { return progressLabel.size; }, null)));
    var progressAbortRow = progressGroup.add("group");
    var abortBtn = progressAbortRow.add("button", undefined, "中断");
    var abortNote = progressAbortRow.add("statictext", undefined, "※ ボタンが反応しない場合は ESC キーを押し続けてください(ESCキーで確実に中断できます)");
    // 注意: ExtendScriptの同期実行中はボタンのクリックイベントが処理されないことがあるため、
    // 主手段は ESC キーのポーリング(throwIfAborted)。ボタンは補助手段。
    abortBtn.onClick = function () { ABORT_FLAG.on = true; };
    progressGroup.visible = false;

    // 【v8→v9→v1.22.0】項目一覧(ツリー)と検出オブジェクト一覧の境界幅について、
    // v8〜v1.21.0ではドラッグ式splitter(splitterBar)を試みてきたが、実機で一切反応せず
    // v1.22.0でドラッグ機能自体を削除した(詳細は splitterBar 定義箇所のコメント参照)。
    // SPLIT_MIN_TREE_W/SPLIT_MIN_LIST_W は各コンテナの minimumSize として引き続き使用する。
    var SPLIT_MIN_TREE_W = 150;
    var SPLIT_MIN_LIST_W = 200;

    // 【v1.15.0・方式転換】従来はウィンドウサイズに合わせてresultBody(ツリー+スプリッター+
    // 右ペイン)を都度伸縮させていたが、「ウィンドウに勝手に追従して伸縮する」ことそのものが
    // 不評だったため、設定画面と同じ「固定サイズのコンテンツ+スクロールバーで表示範囲を移動」
    // 方式に作り替える。resultBody自体は固定の自然サイズを持つブロックとして扱い、
    // これを新設のresultViewport(クリップ枠)に入れ、右に縦・下に横のスクロールバーを設置する
    // (常時表示・enabled切替のみの方式は設定画面と統一)。
    var resultViewportRow = resultPanel.add("group");
    resultViewportRow.orientation = "row";
    resultViewportRow.alignChildren = ["fill", "fill"];
    resultViewportRow.alignment = ["fill", "fill"];
    resultViewportRow.spacing = 4;
    resultViewportRow.margins = 0;

    var resultViewport = resultViewportRow.add("group");
    resultViewport.orientation = "column";
    resultViewport.alignChildren = ["fill", "top"];
    resultViewport.alignment = ["fill", "fill"];
    resultViewport.spacing = 0;
    resultViewport.margins = 0;
    resultViewport.minimumSize = [200, 100];

    var resultVScrollbar = resultViewportRow.add("scrollbar", [0, 0, 16, 200], 0, 0, 0);
    resultVScrollbar.preferredSize.width = 16;
    resultVScrollbar.alignment = ["right", "fill"];
    resultVScrollbar.minvalue = 0;
    resultVScrollbar.stepdelta = 24;
    resultVScrollbar.jumpdelta = 120;
    resultVScrollbar.enabled = false;
    resultVScrollbar.visible = true; // 設定画面と同じ「常時表示・enabledのみ切替」方式

    var resultHScrollRow = resultPanel.add("group");
    resultHScrollRow.orientation = "row";
    resultHScrollRow.alignChildren = ["fill", "fill"];
    resultHScrollRow.alignment = ["fill", "top"];
    resultHScrollRow.spacing = 4;
    resultHScrollRow.margins = 0;
    var resultHScrollbar = resultHScrollRow.add("scrollbar", [0, 0, 200, 16], 0, 0, 0);
    resultHScrollbar.preferredSize.height = 16;
    resultHScrollbar.alignment = ["fill", "fill"];
    resultHScrollbar.minvalue = 0;
    resultHScrollbar.stepdelta = 24;
    resultHScrollbar.jumpdelta = 120;
    resultHScrollbar.enabled = false;
    resultHScrollbar.visible = true;
    var resultHScrollCorner = resultHScrollRow.add("group");
    resultHScrollCorner.preferredSize.width = 16;
    resultHScrollCorner.minimumSize.width = 16;
    resultHScrollCorner.maximumSize.width = 16;

    var resultScrollbarLastEnabled = null;   // 縦スクロールバーのenabled変化追跡(設定画面と同じ手法)
    var resultHScrollbarLastEnabled = null;  // 横スクロールバーのenabled変化追跡
    var resultBodyNaturalW = 0;              // resultBodyの自然幅(初回実測・splitterドラッグ後に再測定)
    var resultBodyNaturalH = 0;              // resultBodyの自然高
    // 【v1.23.0・確定原因への対処】noteText/selStatusTextへの直接.size代入(v1.21.0)は
    // 個別コントロール自身の描画には反映されるが、ScriptUIレイアウトエンジンの
    // 「親(resultBody)の必要サイズ計算」には反映されないという既知の癖があり、
    // captureResultBodyNatural()が測る resultBody.size[1] が常に初期値(noteText=80px,
    // selStatusText=90px時点の値)のまま固定されてしまっていた。そこで、直近に
    // 実際に適用した高さを記録しておき、初期値との差分をresultBody.size[1]に
    // 自前で加算することで補正する(レイアウトエンジンの集計に頼らない)。
    var lastAppliedNoteH = 80;   // noteTextの初期preferredSize高さ(3284行付近)と同じ値
    var lastAppliedStatusH = 90; // selStatusTextの初期preferredSize高さ(3305行付近)と同じ値

    var resultBody = resultViewport.add("group");
    resultBody.orientation = "row";
    resultBody.alignChildren = ["fill", "fill"];
    // 【v1.15.0】ウィンドウに追従して伸縮させない(固定の自然サイズ)。非fillにして
    // ビューポートより大きければはみ出してクリップされ、スクロールバーで見る方式にする。
    resultBody.alignment = ["left", "top"];
    resultBody.spacing = 2;

    var treeContainer = resultBody.add("panel", undefined, "項目一覧");
    treeContainer.alignChildren = ["fill", "fill"];
    applyPanelBackdrop(treeContainer); // 【v1.14.0】面での区切り
    // 【v1.22.0】スプリッタードラッグ機能を削除したため、横方向は常に固定のpreferredSize.width
    // に従う(可変にはならない)。resultBodyは「自然サイズ(=子要素の固定幅の合計)」で
    // 扱われる設計(v1.15.0以降)のため、ここの数値がそのまま最終的な項目一覧の幅になる。
    // 【v1.21.0で200pxに縮小→v1.22.0で260pxに戻す】200pxは狭すぎるとの報告があったため、
    // 「項目一覧は狭すぎず、かつ検出オブジェクト一覧側にも十分な幅を残す」バランスで260pxにした。
    treeContainer.alignment = ["left", "fill"];
    treeContainer.preferredSize.width = 260;
    treeContainer.minimumSize.width = SPLIT_MIN_TREE_W;
    var tree = treeContainer.add("treeview", undefined);
    tree.preferredSize = [260, 240]; // 初期は控えめ。リサイズで拡大可能
    tree.alignment = ["fill", "fill"];

    // ---- 境界線(v1.22.0でドラッグ機能は削除、静的な区切り線として残す) ----
    var splitterBar = resultBody.add("group");
    splitterBar.orientation = "column";
    splitterBar.alignChildren = ["fill", "fill"];
    splitterBar.alignment = ["left", "fill"];
    splitterBar.preferredSize.width = 8;
    splitterBar.minimumSize.width = 8;
    splitterBar.maximumSize.width = 8;
    splitterBar.margins = 0;
    // 【v1.22.0】以前は「掴める場所」とわかるよう明るめにしていたが、ドラッグ不可の
    // 静的な区切り線になったため、単なる視覚的な区切り(グレーの縦線)として描画する。
    // (プロパティが無視される環境でも例外にならないようsafe()で保護)
    safe(function () {
        splitterBar.graphics.backgroundColor = splitterBar.graphics.newBrush(
            splitterBar.graphics.BrushType.SOLID_COLOR, [0.55, 0.55, 0.55], 1);
        return null;
    }, null);

    var listContainer = resultBody.add("panel", undefined, "検出オブジェクト一覧");
    listContainer.orientation = "column";
    applyPanelBackdrop(listContainer); // 【v1.14.0】面での区切り
    // 【v8修正】各子要素の alignment を明示指定(継承任せにしない)。
    // 【v1.15.0】方式転換: detailListも含め全要素を高さ固定にする(ウィンドウに合わせて
    // 伸縮させない)。listContainer自体もresultBody内で非fillの自然サイズになる。
    listContainer.alignChildren = ["fill", "top"];
    listContainer.alignment = ["fill", "top"];
    listContainer.spacing = 6; // 間隔を固定値にして曖昧な継承由来のズレを排除
    listContainer.minimumSize.width = SPLIT_MIN_LIST_W;
    // 【v7→v8→v1.15.0→v1.22.0】検出オブジェクト一覧: v8時点の固定サイズ方式のまま、
    // 幅を380→540pxへ拡大(「検出オブジェクト一覧の幅が変わらない/狭い」との報告への対応。
    // v1.15.0以降resultBodyは自然サイズ=子要素の固定幅の合計で扱われるため、この数値が
    // そのまま最終的な一覧の幅になる)。
    var detailList = listContainer.add("listbox", undefined, [], { multiselect: true });
    detailList.preferredSize = [540, 340];
    detailList.minimumSize = [280, 200];
    // 【v1.15.0】固定高さに変更(伸縮させない)。他の要素(ボタン/説明欄/ステータス欄)と
    // 同じ非fill(top)にする。ウィンドウに追従して伸びる仕組みそのものを廃止し、
    // 溢れた分はresultViewportの外付けスクロールバーで見る方式に統一する。
    detailList.alignment = ["fill", "top"];

    // 【v7】表示順を「検出オブジェクト一覧 → 選択してズームボタン → 説明欄」に変更。
    // (旧: 一覧 → 説明欄 → ボタン。ボタンが一覧のすぐ下に来るよう並べ替え)
    // 【v8】ボタン・説明欄は高さ固定・fillなしで一覧のすぐ下に密着させる。
    var selectBtnGroup = listContainer.add("group");
    selectBtnGroup.alignment = ["fill", "top"];
    var selectBtn = selectBtnGroup.add("button", undefined, "選択してズーム");
    selectBtnGroup.add("statictext", undefined, "(行のダブルクリックでもジャンプします)");

    var noteText = listContainer.add("statictext", undefined, "", { multiline: true });
    // 【v1.18.0】長い「原因と対応」の説明文が高さ不足で途中から見切れることがあったため、
    // 従来の56pxから80pxへ拡大(multiline:trueは効いているが、非fillの固定高さのため、
    // 実際の折り返し行数より箱が低いと下側が単純にクリップされていた)。
    // 【v1.22.0】幅も detailList と揃えて 340→540 に拡大。
    noteText.preferredSize = [540, 80];
    noteText.alignment = ["fill", "top"];
    // 【v8】「原因と対応」の説明文の視認性向上。Illustratorパネルの暗い背景に対してコントラストの
    // 高い暖色系(アンバー寄り、0〜1スケール)を明示指定し、太字にする。
    safe(function () {
        noteText.graphics.foregroundColor = noteText.graphics.newPen(
            noteText.graphics.PenType.SOLID_COLOR, [1.0, 0.78, 0.35], 1);
        noteText.graphics.font = ScriptUI.newFont("dialog", "Bold", 12);
        return null;
    }, null);
    var selStatusText = listContainer.add("statictext", undefined, "", { multiline: true });
    // 【v1.18.0確定原因】選択操作の状況メッセージ(例:「1件を選択しました。」+ロック解除の
    // 説明文が改行連結されたもの)が3〜5行になることがあるのに対し、従来の高さ42px(約2行分)
    // では足りず、multiline:true自体は効いていても非fillの固定高さのため文中で単純にクリップ
    // されていた。90px(約4〜5行分)へ拡大する。全文が入りきらない場合でも、resultViewportの
    // 縦スクロールバー(v1.15.0で導入済み)でスクロールして続きを読める。
    // 【v1.22.0】幅も detailList と揃えて 340→540 に拡大。
    selStatusText.preferredSize = [540, 90];
    selStatusText.alignment = ["fill", "top"];

    // 【v1.15.0・方式転換】結果画面も設定画面と同じ「固定サイズのコンテンツ+スクロールバーで
    // 表示範囲を移動」方式に作り替えた。resultBody自体は自然サイズのまま保持し(ウィンドウに
    // 合わせて伸縮させない)、resultViewportがクリップ枠として機能する。
    // 前回状態を参照しない絶対計算のため、余白累積も構造的に起きない。

    // resultBodyの自然サイズを実測して固定する(設定画面のcaptureSettingsBaselineと同じ手法:
    // 制約を一旦解除してから測り直すことで、以前の固定値による自己ポイズニングを防ぐ)。
    // 初回表示時・スプリッタードラッグ後(ツリー幅が変わり自然幅も変わるため)に呼ぶ。
    function captureResultBodyNatural(sourceTag) {
        var tag = sourceTag ? sourceTag : "(不明)";
        try {
            resultBody.minimumSize = [0, 0];
            resultBody.maximumSize = [100000, 100000];
            // 【v1.16.0・再入防止→v1.17.0・確定原因により対象を変更】
            // win全体のlayoutはWindows実機でwin.size自体を+25px前後増加させる副作用が
            // 確認された。自然サイズの測定にはresultBody自身のlayoutで十分なので、
            // winではなくresultBodyを対象にする。
            safeWinLayout(resultBody);
            resultBodyNaturalW = resultBody.size[0];
            resultBodyNaturalH = resultBody.size[1];
            if (!resultBodyNaturalW || resultBodyNaturalW < 10) {
                resultBodyNaturalW = resultBody.preferredSize ? resultBody.preferredSize[0] : 0;
            }
            if (!resultBodyNaturalH || resultBodyNaturalH < 10) {
                resultBodyNaturalH = resultBody.preferredSize ? resultBody.preferredSize[1] : 0;
            }
            // 【v1.23.0・確定原因への対処】noteText/selStatusTextへの直接.size代入(v1.21.0)は
            // 個別コントロール自身の描画には反映されるが、上のsafeWinLayout(resultBody)による
            // 「親の必要サイズ計算」には反映されない(ScriptUIレイアウトエンジンの既知の癖)。
            // そのため resultBodyNaturalH は常に construction時の初期値(noteText=80px,
            // selStatusText=90px)ベースの値のまま固定されていた。直近に実際へ適用した高さ
            // (lastAppliedNoteH/lastAppliedStatusH)と初期値との差分を自前で加算して補正する。
            // baseとなるresultBody.size[1]自体はレイアウトエンジンの構成時計算(不変)なので、
            // 差分は毎回ゼロから計算し直しており、繰り返し呼んでも積み上がらない(冪等)。
            var noteDelta = lastAppliedNoteH - 80;
            var statusDelta = lastAppliedStatusH - 90;
            if (noteDelta < 0) noteDelta = 0;   // 縮小方向の補正はしない(安全側)
            if (statusDelta < 0) statusDelta = 0;
            var RESULT_BODY_SAFETY_MARGIN_PX = 10; // 念のための安全マージン
            resultBodyNaturalH += noteDelta + statusDelta + RESULT_BODY_SAFETY_MARGIN_PX;
            resultBody.minimumSize = [resultBodyNaturalW, resultBodyNaturalH];
            resultBody.maximumSize = [resultBodyNaturalW, resultBodyNaturalH];
            dlog("RESULT-FIT", "captureResultBodyNatural[" + tag + "] naturalW=" + resultBodyNaturalW +
                " naturalH=" + resultBodyNaturalH +
                " (noteDelta=" + noteDelta + " statusDelta=" + statusDelta +
                " lastAppliedNoteH=" + lastAppliedNoteH + " lastAppliedStatusH=" + lastAppliedStatusH + ")" +
                " win.size=" + fmtArr(win.size));
        } catch (eCapR) {
            dlog("RESULT-FIT", "captureResultBodyNatural[" + tag + "] 例外発生: " + eCapR.toString());
        }
    }

    // ウィンドウ実サイズからビューポート・スクロールバーのジオメトリを絶対計算する
    // (設定画面のapplySettingsWindowFitと同じ方針)。resultBody自体のサイズは変更しない
    // (自然サイズに固定済み)。
    function applyResultWindowFit(sourceTag) {
        var tag = sourceTag ? sourceTag : "(不明)";
        try {
            if (!win.size) { dlog("RESULT-FIT", "applyResultWindowFit[" + tag + "] win.size未確定のためスキップ"); return; }
            if (!resultBody.visible) { dlog("RESULT-FIT", "applyResultWindowFit[" + tag + "] resultBody非表示(検版実行中等)のためスキップ"); return; }
            var winW = win.size[0], winH = win.size[1];
            var scrX = screens.location ? screens.location[0] : 8;
            var scrY = screens.location ? screens.location[1] : 8;
            var SB_EDGE_GAP = 2;
            var availW = winW - scrX - SB_EDGE_GAP;
            // 【v1.18.0】設定画面と同様、下マージンもSB_EDGE_GAP(2px)まで使い切り、
            // 横スクロールバーをウィンドウ下端に密着させる。
            var availH = winH - scrY - SB_EDGE_GAP;
            if (availW < 300) availW = 300;
            if (availH < 200) availH = 200;
            screens.size = [availW, availH];
            resultPanel.size = [availW, availH]; // stack内の子はscreensと同位置・同寸

            var panelX = resultPanel.location ? resultPanel.location[0] : 0;
            var rowX = resultViewportRow.location ? resultViewportRow.location[0] : 12;
            var rowY = resultViewportRow.location ? resultViewportRow.location[1] : 100;
            var rowAbsX = scrX + panelX + rowX;
            var rowW = winW - rowAbsX - SB_EDGE_GAP;
            var hScrollH = 16, hScrollGap = 6;
            // 【v1.18.0】旧「パネル下マージン12px」控除を廃止(availH側で既にSB_EDGE_GAPまで
            // 使い切る計算に変更したため)。横スクロールバー下端がウィンドウ下端-2pxに一致する。
            var rowH = availH - rowY - hScrollH - hScrollGap;
            if (rowW < 250) rowW = 250;
            if (rowH < 150) rowH = 150;
            resultViewportRow.size = [rowW, rowH];

            var sbW = 16;
            resultVScrollbar.size = [sbW, rowH];
            resultVScrollbar.location = [rowW - sbW, 0];
            var vpW = rowW - sbW - 4;
            if (vpW < 100) vpW = 100;
            resultViewport.size = [vpW, rowH];
            resultViewport.location = [0, 0];

            safe(function () {
                resultHScrollRow.location = [rowX, rowY + rowH + hScrollGap];
                resultHScrollRow.size = [rowW, hScrollH];
                resultHScrollbar.size = [vpW, hScrollH];
                return null;
            }, null);

            // resultBodyは自然サイズのまま保持(ビューポートより大きい分ははみ出してクリップされる)
            safe(function () {
                var bw = (resultBodyNaturalW > 0) ? resultBodyNaturalW : resultBody.size[0];
                var bh = (resultBodyNaturalH > 0) ? resultBodyNaturalH : resultBody.size[1];
                resultBody.size = [bw, bh];
                return null;
            }, null);

            dlog("RESULT-FIT", "applyResultWindowFit[" + tag + "] 完了: win=" + fmtArr(win.size) +
                " availW=" + availW + " availH=" + availH +
                " rowW=" + rowW + " rowH=" + rowH + " vpW=" + vpW +
                " resultBodyNaturalW=" + resultBodyNaturalW + " resultBodyNaturalH=" + resultBodyNaturalH +
                " vScrollbar.bounds=" + fmtArr(safe(function () { return resultVScrollbar.bounds; }, null)) +
                " hScrollbar.bounds=" + fmtArr(safe(function () { return resultHScrollbar.bounds; }, null)));
        } catch (eRFit) {
            dlog("RESULT-FIT", "applyResultWindowFit[" + tag + "] 例外発生: " + eRFit.toString());
        }
    }

    // 【v1.15.0】設定画面と同じ「常時表示・enabledのみ切替」方式のスクロール範囲再計算。
    function updateResultScrollRange() {
        try {
            var viewportH = resultViewport.size ? resultViewport.size[1] : 0;
            var viewportW = resultViewport.size ? resultViewport.size[0] : 0;
            var maxScrollV = resultBodyNaturalH - viewportH;
            var maxScrollH = resultBodyNaturalW - viewportW;
            if (maxScrollV < 0) maxScrollV = 0;
            if (maxScrollH < 0) maxScrollH = 0;
            resultVScrollbar.maxvalue = maxScrollV;
            resultHScrollbar.maxvalue = maxScrollH;

            var vEnabled = maxScrollV > 0;
            var hEnabled = maxScrollH > 0;
            resultVScrollbar.enabled = vEnabled;
            resultHScrollbar.enabled = hEnabled;
            if (resultVScrollbar.value > maxScrollV) resultVScrollbar.value = maxScrollV;
            if (resultHScrollbar.value > maxScrollH) resultHScrollbar.value = maxScrollH;
            if (!vEnabled) resultVScrollbar.value = 0;
            if (!hEnabled) resultHScrollbar.value = 0;
            resultBody.location = [-resultHScrollbar.value, -resultVScrollbar.value];

            dlog("RESULT-FIT", "updateResultScrollRange: naturalH=" + resultBodyNaturalH + " viewportH=" + viewportH +
                " maxScrollV=" + maxScrollV + " / naturalW=" + resultBodyNaturalW + " viewportW=" + viewportW +
                " maxScrollH=" + maxScrollH + " -> v.enabled=" + vEnabled + " h.enabled=" + hEnabled);

            if (resultScrollbarLastEnabled !== vEnabled) {
                forceResultScrollbarReflow("v-enabled->" + vEnabled);
                resultScrollbarLastEnabled = vEnabled;
            }
            if (resultHScrollbarLastEnabled !== hEnabled) {
                forceResultScrollbarReflow("h-enabled->" + hEnabled);
                resultHScrollbarLastEnabled = hEnabled;
            }
        } catch (eURS) {
            dlog("RESULT-FIT", "updateResultScrollRange: 例外発生 " + eURS.toString());
        }
    }

    // 設定画面のforceScrollbarReflowと同じ多層防御(ログ確認用に温存)。
    // 【v1.16.0・再入防止】設定画面側と同じ理由で、関数全体は覆わず手段1のみ個別に囲む
    // (末尾の applyResultWindowFit の正常実行を妨げないため)。
    // 【v1.17.0・確定原因により手段2を削除】win.layout.layout(true)はWindows実機ログで
    // win.size自体を+25px前後増加させる副作用が確認された。この関数はスクロールバーの
    // enabled切替のたびに呼ばれる高頻度パスのため、リサイズを繰り返すたびにウィンドウが
    // 際限なく伸びる直接原因だった。設定画面側と同じ理由で完全に削除する。
    function forceResultScrollbarReflow(reason) {
        var tagR = reason ? reason : "(不明)";
        var ok1 = safeWinLayout(resultViewportRow);
        dlog("RESULT-FIT", "再レイアウト手段1(resultViewportRow.layout.layout)[" + tagR + "]: 成功=" + ok1);
        var ok3 = safe(function () {
            if (resultVScrollbar.notify) { resultVScrollbar.notify("onDraw"); return true; }
            return false;
        }, false);
        dlog("RESULT-FIT", "再レイアウト手段3(resultVScrollbar.notify('onDraw'))[" + tagR + "]: 成功=" + ok3);
        var ok4 = safe(function () {
            var curV = resultVScrollbar.enabled, curH = resultHScrollbar.enabled;
            resultVScrollbar.enabled = !curV; resultVScrollbar.enabled = curV;
            resultHScrollbar.enabled = !curH; resultHScrollbar.enabled = curH;
            return true;
        }, false);
        dlog("RESULT-FIT", "再レイアウト手段4(enabledトグルによる再描画ナッジ)[" + tagR + "]: 成功=" + ok4);
        applyResultWindowFit("afterReflow-" + tagR);
    }

    // 縦・横どちらのスクロールバーが動いても resultBody の位置は両方の値を反映する
    function applyResultBodyScrollLocation() {
        resultBody.location = [-resultHScrollbar.value, -resultVScrollbar.value];
    }
    resultVScrollbar.onChanging = applyResultBodyScrollLocation;
    resultVScrollbar.onChange = applyResultBodyScrollLocation;
    resultHScrollbar.onChanging = applyResultBodyScrollLocation;
    resultHScrollbar.onChange = applyResultBodyScrollLocation;

    // ---- splitter: 機能削除(v1.22.0) ----
    // 【v1.22.0・機能削除】項目一覧と検出オブジェクト一覧の境界をドラッグで調整する機能を
    // v8以降試みてきたが、mousedownをsplitterBarに、mousemove/mouseupをresultBody→win
    // と付け替えるなど複数の方式を試しても実機(Windows)で一切反応しないままだった。
    // ScriptUIのイベントサポートが不十分(Group/Panel/Windowいずれでもドラッグ追跡が
    // 実用的に機能しない)と判断し、ユーザーの明示指示によりドラッグ機能自体を削除した。
    // splitterBar(境界線)自体は静的な区切り線としてそのまま残す(グレー背景の8px幅の帯、
    // 見た目の境界としては有用)。幅変更ロジック(applySplitTreeWidth)・ドラッグ状態管理
    // (splitDragState/splitDragMove)・イベント登録は全て削除済み。
    // 以後、項目一覧/検出オブジェクト一覧の幅比率は起動時の固定値のみで決まる
    // (treeContainer.preferredSize.width 等、v1.22.0で調整済み)。

    // 【v7】結果画面ボタン列(resultBtnGroup等)は画面最上部に移動済み。
    // 生成・配置はこのブロックの先頭(resultPanel直後)を参照。

    var currentResults = null;
    var currentSummary = null;
    var nodeToResult = {};

    function populateTree(results) {
        tree.removeAll();
        nodeToResult = {};
        for (var c = 0; c < CATEGORY_ORDER.length; c++) {
            var cat = CATEGORY_ORDER[c];
            var catResults = [];
            for (var i = 0; i < results.length; i++) { if (results[i].category === cat) catResults.push(results[i]); }
            if (catResults.length === 0) continue;
            var catNG = 0, catWarn = 0, catInfo = 0;
            for (var j = 0; j < catResults.length; j++) {
                if (catResults[j].status === "NG") catNG++;
                if (catResults[j].status === "WARN") catWarn++;
                if (catResults[j].status === "INFO") catInfo++;
            }
            var catLabelPrefix = catNG > 0 ? "[エラー] " : (catWarn > 0 ? "[警告] " : (catInfo > 0 ? "[情報] " : "[OK] "));
            var catNode = tree.add("node", catLabelPrefix + cat);
            catNode.expanded = true;
            for (var k = 0; k < catResults.length; k++) {
                var r = catResults[k];
                var statusLabel = statusLabelOf(r.status);
                var cnt = r.details.length;
                var itemLabel = "[" + statusLabel + "] " + r.name + (cnt > 0 ? " (" + cnt + "件)" : "");
                var itemNode = catNode.add("item", itemLabel);
                itemNode.resultRef = r;
            }
        }
    }

    tree.onChange = function () {
        detailList.removeAll();
        noteText.text = "";
        var sel = tree.selection;
        if (!sel) return;
        var r = sel.resultRef;
        if (!r) return;
        var noteParts = [];
        if (r.advice && r.status !== "OK" && r.status !== "SKIP") noteParts.push("【原因と対応】" + r.advice);
        if (r.note) noteParts.push(r.note);
        var noteFullText = joinArr(noteParts, "\n");
        noteText.text = noteFullText;
        // 【v1.19.0→v1.20.0】固定高さでは項目ごとの文章量の差で必ずどこかが見切れるため、
        // 表示するテキスト量から必要な高さを都度見積もって設定する
        // (lineHeightPx=24, minLines=2, maxLines=10。v1.20.0で安全マージンを拡大)。
        // 【v1.22.0】幅を340→540へ拡大(detailList等と統一)。boxWidthPxも540に合わせて
        // 渡すことで、実際のボックス幅に応じた折り返し行数の見積もりになる。
        var noteEstimatedH = estimateTextBoxHeight(noteFullText, 540, 24, 2, 10);
        noteText.preferredSize = [540, noteEstimatedH];
        // 【v1.21.0・確定原因により追加】実機ログで、preferredSizeを設定し直しても
        // noteText.sizeが常に[380,80]固定のままだったことが判明した。既に一度レイアウト済みの
        // リーフコントロールは、親コンテナへのlayout.layout(true)だけでは既存の.sizeが
        // 更新されないというScriptUIの既知の癖のため。preferredSizeと同時に.sizeも
        // 直接明示的に上書きする。
        noteText.size = [540, noteEstimatedH];
        // 【v1.23.0】captureResultBodyNatural()側でresultBodyの必要高さを差分補正するために、
        // 直近に実際へ適用した高さを記録しておく(親コンテナの必要サイズ計算にはこの.size代入
        // 自体が反映されないため、自前の差分計算で補う)。
        lastAppliedNoteH = noteEstimatedH;
        // 高さが変わった分、listContainer/resultBodyの自然サイズも変わるため、
        // 再測定(captureResultBodyNatural)→再フィット→スクロール範囲再計算の順で反映する。
        captureResultBodyNatural("noteTextResize");
        applyResultWindowFit("noteTextResize");
        updateResultScrollRange();
        // 【v1.20.0】次回の係数校正のため、見積もり値と実際に描画された.sizeをログに残す。
        // これでも欠ける場合、次のログで「見積もり vs 実際」の乖離を正確に把握できる。
        dlog("NOTE-SIZE", "tree.onChange: 見積もり高さ=" + noteEstimatedH +
            " 実際のnoteText.size=" + fmtArr(safe(function () { return noteText.size; }, null)) +
            " 実際のnoteText.bounds=" + fmtArr(safe(function () { return noteText.bounds; }, null)) +
            " テキスト長=" + noteFullText.length + "文字" +
            " テキスト内容(先頭50文字)=" + noteFullText.substring(0, 50) + "...");
        for (var i = 0; i < r.details.length; i++) {
            var li = detailList.add("item", r.details[i].text);
            li.itemRef = r.details[i].item;
        }
    };

    // 【v1.19.0→v1.20.0】selStatusTextも選択結果メッセージの長さが可変(ロック解除の説明文等が
    // 連結されて長くなることがある)なため、noteTextと同じ動的サイズ見積もりを適用する
    // (係数はnoteTextと統一: lineHeightPx=24, minLines=2, maxLines=10)。
    function setSelStatusText(msg) {
        selStatusText.text = msg;
        // 【v1.22.0】幅を340→540へ拡大(noteText/detailList等と統一)。
        var statusEstimatedH = estimateTextBoxHeight(msg, 540, 24, 2, 10);
        selStatusText.preferredSize = [540, statusEstimatedH];
        // 【v1.21.0・確定原因により追加】noteTextと同じ理由でpreferredSizeだけでは
        // 既存の.sizeが更新されないため、.sizeも直接明示的に上書きする。
        selStatusText.size = [540, statusEstimatedH];
        // 【v1.23.0】noteTextと同様、resultBody側の差分補正用に直近適用高さを記録する。
        lastAppliedStatusH = statusEstimatedH;
        captureResultBodyNatural("selStatusResize");
        applyResultWindowFit("selStatusResize");
        updateResultScrollRange();
        // 【v1.20.0】次回の係数校正のため、見積もり値と実際に描画された.sizeをログに残す。
        dlog("NOTE-SIZE", "setSelStatusText: 見積もり高さ=" + statusEstimatedH +
            " 実際のselStatusText.size=" + fmtArr(safe(function () { return selStatusText.size; }, null)) +
            " 実際のselStatusText.bounds=" + fmtArr(safe(function () { return selStatusText.bounds; }, null)) +
            " テキスト長=" + String(msg).length + "文字" +
            " テキスト内容(先頭50文字)=" + String(msg).substring(0, 50) + "...");
    }

    function jumpToSelectedDetails(silent) {
        var sels = detailList.selection;
        if (!sels) { if (!silent) alert("検出オブジェクト一覧から項目を選択してください。"); return; }
        var arr = [];
        if (sels.length !== undefined) {
            for (var i = 0; i < sels.length; i++) { if (sels[i].itemRef) arr.push(sels[i].itemRef); }
        } else {
            if (sels.itemRef) arr.push(sels.itemRef);
        }
        if (arr.length === 0) {
            setSelStatusText("この行にはオブジェクト参照がありません(ドキュメント全体に関する指摘です)。");
            if (!silent) alert("選択した項目にはオブジェクト参照がありません(ドキュメント全体に関する指摘です)。");
            return;
        }
        var rep = selectAndZoom(doc, arr);
        var statusMsg = rep.count > 0 ? (rep.count + "件を選択しました。") : "選択できませんでした。";
        if (rep.message) statusMsg += "\n" + rep.message;
        setSelStatusText(statusMsg);
    }

    selectBtn.onClick = function () { jumpToSelectedDetails(false); };
    // 行ダブルクリックでもジャンプ(参照が無い行では何もしない)
    detailList.onDoubleClick = function () { jumpToSelectedDetails(true); };

    function showResultsScreen(results) {
        currentResults = results;
        currentSummary = summarizeResults(results);
        settingsPanel.visible = false;
        resultPanel.visible = true;
        progressGroup.visible = false;
        summaryText.text = currentSummary.allOk ?
            ("✔ 全項目OK" + (currentSummary.infoCount > 0 ? "(情報 " + currentSummary.infoCount + "件)" : "")) :
            ("✖ エラー " + currentSummary.ngCount + "件・警告 " + currentSummary.warnCount + "件・情報 " + currentSummary.infoCount + "件");
        summaryText.graphics.foregroundColor = summaryText.graphics.newPen(
            summaryText.graphics.PenType.SOLID_COLOR,
            currentSummary.allOk ? [0.0, 0.45, 0.15] : [0.75, 0.15, 0.1],
            1
        );
        finishSizeText.text = results.finishSizeText ? ("検出した仕上がりサイズ: " + results.finishSizeText) : "";
        populateTree(results);
        win.text = TITLE_RESULT_PREFIX + doc.name;
        // 【v1.17.0・監査済み】ここは画面切替(設定→結果)の1回限りのタイミングであり、
        // 高頻度パス(リサイズ/スクロールバー再描画)ではないため win 対象のlayoutを許容する。
        safeWinLayout(win);
        // 【v1.15.0】表示直後にresultBodyの自然サイズを実測・固定してからフィット+スクロール範囲を計算する
        // (小さい画面のMacで結果画面の下部が切れて操作不能になる問題への対処。設定画面と同じ手順)
        captureResultBodyNatural("showResults");
        applyResultWindowFit("showResults");
        updateResultScrollRange();
    }

    backBtn.onClick = function () {
        resultPanel.visible = false;
        settingsPanel.visible = true;
        selStatusText.text = "";
        win.text = TITLE_SETTINGS;
        // 【v1.17.0・監査済み】画面切替(結果→設定)の1回限りのタイミングのため win 対象を許容。
        safeWinLayout(win);
        applySettingsResize();      // layoutが乱したジオメトリをbaseline+差分で上書き
        updateSettingsScrollRange();
    };

    saveHtmlBtn.onClick = function () {
        if (!currentResults) return;
        var folder = Folder.selectDialog("レポートの保存先フォルダを選択してください");
        if (!folder) return;
        var baseName = doc.name.replace(/\.[^\.]+$/, "");
        var f = new File(folder.fsName + "/" + baseName + "_kenpan_" + nowFileStamp() + ".html");
        var html = buildHtmlReport(doc, collectConfigFromUI(), currentResults, currentSummary);
        writeTextFileUTF8BOM(f, html);
        alert("HTMLレポートを保存しました。\n" + f.fsName);
    };

    saveCsvBtn.onClick = function () {
        if (!currentResults) return;
        var folder2 = Folder.selectDialog("レポートの保存先フォルダを選択してください");
        if (!folder2) return;
        var baseName2 = doc.name.replace(/\.[^\.]+$/, "");
        var f2 = new File(folder2.fsName + "/" + baseName2 + "_kenpan_" + nowFileStamp() + ".csv");
        var csv = buildCsvReport(doc, collectConfigFromUI(), currentResults);
        writeTextFileUTF8BOM(f2, csv);
        alert("CSVレポートを保存しました。\n" + f2.fsName);
    };

    closeBtn.onClick = function () { win.close(); };

    runBtn.onClick = function () {
        var c = collectConfigFromUI();
        saveConfig(c);
        ABORT_FLAG.on = false; // 中断フラグをリセット
        settingsPanel.visible = false;
        resultPanel.visible = true;
        progressGroup.visible = true;
        summaryText.text = "検査中...(ESCキーで中断できます)";
        finishSizeText.text = "";
        selStatusText.text = "";
        resultBody.visible = false;
        resultBtnGroup.visible = false;
        // 【v1.21.0・確定原因により修正】v1.17.0で「1回限りだから許容」と誤ってマークしていたが、
        // win.layout.layout(true)はWindowsでwin.size自体を変化させる副作用があり(v1.17.0で確定)、
        // ここを通るとユーザーがリサイズ済みのウィンドウが検版実行のたびにリセットされていた。
        // ここで本当に必要なのは resultPanel/progressGroup 等の可視性トグルを内部的に
        // 反映させることだけで、win全体のサイズを再計算する必要は無いため、対象を
        // resultPanel に変更する(winを一切触らない)。
        safeWinLayout(resultPanel);

        var results = null;
        var wasAborted = false;
        var runError = null;
        try {
            results = runPreflight(doc, c, function (pct, label) {
                if (pct !== null && pct !== undefined) progressBar.value = pct;
                if (label !== null && label !== undefined) {
                    // Mac対策: 同期実行中のテキスト差し替えが反映されないことがあるため、
                    // 一度空にしてから代入する(既知のワークアラウンド。Winでは無害)
                    progressLabel.text = "";
                    progressLabel.text = label;
                    // 【診断ログ】代入直後に読み戻して一致するか確認する。
                    // ここで readBack が label と食い違っていれば、代入自体は成功しているのに
                    // 「描画」だけが反映されていない(Mac特有の再描画不良)ことの裏付けになる。
                    // 逆に readBack が空/別の値なら、代入そのものが失敗している可能性を示す。
                    var readBack = safe(function () { return progressLabel.text; }, "(読み戻し失敗)");
                    dlog("PROGRESS", "progressLabel更新: 設定した値=[" + label + "] 読み戻した値=[" + readBack + "] 一致=" + (readBack === label));
                }
                var updateErr = null, refreshErr = null, sleepErr = null;
                try { win.update(); } catch (eUpd) { updateErr = eUpd; }
                // 【Mac対策・追加】win.update() だけでは同期実行中の再描画が反映されないケースに
                // 備え、アプリ側の再描画とイベントループへの処理譲渡を試みる(効果が無くても無害)。
                try { app.refresh(); } catch (eRef) { refreshErr = eRef; }
                try { $.sleep(1); } catch (eSlp) { sleepErr = eSlp; }
                if (updateErr || refreshErr || sleepErr) {
                    dlog("PROGRESS", "再描画呼び出しで例外: win.update()=" + (updateErr ? updateErr.toString() : "OK") +
                        " app.refresh()=" + (refreshErr ? refreshErr.toString() : "OK") +
                        " $.sleep(1)=" + (sleepErr ? sleepErr.toString() : "OK"));
                }
            });
        } catch (e) {
            if (isAbortError(e)) wasAborted = true;
            else runError = e;
        }

        // finally相当の後始末: どのルートでも必ずUI状態を復元する
        progressGroup.visible = false;
        progressBar.value = 0;
        progressLabel.text = "";

        if (results) {
            resultBody.visible = true;
            resultBtnGroup.visible = true;
            showResultsScreen(results);
        } else {
            // 中断/エラー時は途中結果を破棄して設定画面へ安全に戻る
            resultPanel.visible = false;
            settingsPanel.visible = true;
            summaryText.text = "";
            win.text = TITLE_SETTINGS;
            // 【v1.17.0・監査済み】検版の中断/エラー時、設定画面へ戻る1回限りのタイミング
            safeWinLayout(win);
            applySettingsResize();      // layoutが乱したジオメトリをbaseline+差分で上書き
            updateSettingsScrollRange();
            if (wasAborted) {
                alert("検版を中断しました。途中結果は破棄されました。");
            } else if (runError) {
                alert("検版実行中にエラーが発生しました。\n" + runError.toString());
            }
        }
    };

    // ---- ウィンドウサイズ調整 ----
    // 【引っかかり対策】以前は onResizing(ドラッグ中の毎イベント)でも win.layout.resize() を
    // 実行しており、設定画面はコントロール数が多いため毎回の全体再レイアウトが重く、
    // ドラッグ操作が引っかかっていた。ドラッグ中(onResizing)は何もせず、
    // サイズ確定時(onResize)のみ処理する。
    // 【余白累積対策】設定画面では layout.resize() を呼ばない。ScriptUIの再レイアウトは
    // リサイズを繰り返すと余白が累積することがあるため、設定画面は baseline+差分の
    // 自前ジオメトリ計算(applySettingsResize)で追随させる。結果画面はツリー/リストの
    // 伸縮に自動レイアウトが必要なため従来通り layout.resize() を使う。
    win.onResizing = function () {};
    // 【v1.16.0・再入防止】確定原因: このハンドラ内で行うフィット処理
    // (applySettingsResize/applyResultWindowFit や、その中の forceScrollbarReflow 等)が
    // win.layout.layout(true)/win.layout.resize() を呼び、それがwin.onResizeを再度
    // 同期的に発火させてしまい、ハンドラが自分自身を再入呼び出しして無限ループになっていた
    // (Windows実機ログでwin.sizeが際限なく増加→最終的に秒間十数回のフリーズループを確認)。
    // FIT_IN_PROGRESSが立っている間に発火したonResizeは「自分自身の操作が引き金の再入」と
    // みなし、何もせず即リターンする。ハンドラの処理本体(nested呼び出しをすべて含む)が
    // 完了するまでフラグを立てたままにすることで、どの階層で再入が起きても確実に止まる。
    win.onResize = function () {
        if (FIT_IN_PROGRESS) {
            dlog("SCROLL", "win.onResize: 再入検出のため無視(FIT_IN_PROGRESS=true, win.size=" + fmtArr(win.size) + ")");
            return;
        }
        FIT_IN_PROGRESS = true;
        try {
            dlog("SCROLL", "win.onResize発火: 新しいwin.size=" + fmtArr(win.size) + " resultPanel.visible=" + resultPanel.visible);
            if (resultPanel.visible) {
                this.layout.resize();
                // 【v1.13.0→v1.15.0】layout.resize()は内部コンテンツを自然サイズへ戻し得るため、
                // 直後に必ずウィンドウ実サイズへのフィット+スクロール範囲の再計算を行う
                // (resultBody自体のサイズはcaptureResultBodyNaturalで固定済みなので再測定はしない)。
                applyResultWindowFit("onResize");
                updateResultScrollRange();
            } else {
                applySettingsResize();
                updateSettingsScrollRange();
            }
        } finally {
            FIT_IN_PROGRESS = false;
        }
    };
    // ダイアログ表示直後: 初回レイアウト確定値を記録し、初期スクロール範囲を計算する。
    // 【Mac対策】Cocoa側では onShow 発火時点でもネイティブレイアウトが未確定な場合があるため、
    // 即時実行に加えて app.scheduleTask() で少し遅延させた再計測・再補正も行う
    // (Windowsでは既に確定済みの値を再測定するだけなので実害はない=冪等)。
    // 【診断ログ】app.scheduleTask()の文字列はグローバルスコープで評価されるため、
    // このKENPAN_DEFERRED_SETTINGS_INIT(グローバル変数に格納した参照)経由の呼び出しが
    // 実際に80ms後に発火しているかどうかも、sourceTagの有無で判別できるようにしている
    // (もし「onShow-immediate」のログしか出ず「onShow-deferred80ms」が一度も出ない場合、
    //  scheduleTaskからの呼び出し自体が失敗している=Mac不具合の有力な手がかりになる)。
    KENPAN_DEFERRED_SETTINGS_INIT = function (sourceTag) {
        captureSettingsBaseline(sourceTag);
        updateSettingsScrollRange(); // 内部で ensureSettingsButtonsVisible() も呼ばれる
    };
    win.onShow = function () {
        dlog("SCROLL", "win.onShow発火(即時): win.size=" + fmtArr(win.size) + " screens[0]=" + fmtScreen(safe(function () { return $.screens[0]; }, null)));
        KENPAN_DEFERRED_SETTINGS_INIT("onShow-immediate");
        safe(function () {
            app.scheduleTask("KENPAN_DEFERRED_SETTINGS_INIT('onShow-deferred80ms');", 80, false);
            return null;
        }, null);
    };
    // 初期高さが画面からはみ出さないよう、画面高の90%を上限にする(Win/Mac共通)
    var scr = safe(function () { return $.screens[0]; }, null);
    if (scr) {
        var maxH = Math.floor((scr.bottom - scr.top) * 0.9);
        var maxW = Math.floor((scr.right - scr.left) * 0.95);
        if (maxH > 300 && maxW > 400) {
            win.maximumSize = [maxW, maxH];
        }
    }
    // 【Mac対策】win.maximumSize は基本的に「ユーザーがドラッグで拡大できる上限」であり、
    // ウィンドウの初期自動サイズがそれを超えていても自動的には縮められないことがある
    // (特にMacで顕著。自然サイズのまま画面より大きいウィンドウが生成され、
    // 画面外にはみ出た下端のボタン列やスクロールバーが見えなくなる、という今回の症状と一致する)。
    // 表示前に明示的にレイアウトを確定させ、上限を超えていれば強制的に縮めてから表示する。
    // 【v1.17.0・監査済み】win.show()前の起動時1回限りの処理のため win 対象を許容。
    safeWinLayout(win);
    if (win.maximumSize && win.size) {
        var clampW = win.size[0] > win.maximumSize[0] ? win.maximumSize[0] : win.size[0];
        var clampH = win.size[1] > win.maximumSize[1] ? win.maximumSize[1] : win.size[1];
        if (clampW !== win.size[0] || clampH !== win.size[1]) {
            win.size = [clampW, clampH];
            safeWinLayout(win);
        }
    }
    win.center();
    win.show();
}

// -----------------------------------------------------------------------------
// 14. エントリーポイント
// -----------------------------------------------------------------------------

function main() {
    dlog("BOOT", "DigitalKenpan起動 OS=" + safe(function () { return $.os; }, "(不明)") +
        " version=" + KENPAN_VERSION +
        " ScriptUIバージョン=" + safe(function () { return ScriptUI.version; }, "(不明)") +
        " appVersion=" + safe(function () { return app.version; }, "(不明)"));
    if (app.documents.length === 0) {
        alert("開いているドキュメントがありません。\nIllustratorでドキュメントを開いてから実行してください。");
        return;
    }
    try {
        buildAndShowDialog();
    } catch (e) {
        dlog("FATAL", "buildAndShowDialogで例外: " + e.toString() + (e.line ? (" 行:" + e.line) : ""));
        alert("デジタル検版ツールの実行中にエラーが発生しました。\n" + e.toString() + (e.line ? ("\n(行: " + e.line + ")") : ""));
    }
}

main();

})();
