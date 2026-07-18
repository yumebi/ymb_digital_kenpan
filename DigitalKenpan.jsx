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
var KENPAN_VERSION = "1.6.0";

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
            if (ctx.tick) ctx.tick("画像カラーモード判定中: " + truncateForProgress(safe(function () { return file.displayName; }, ""), 40));
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
            if (ctx.tick) ctx.tick("実効解像度算出中: " + truncateForProgress(safe(function () { return file.displayName; }, ""), 40));
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

    var settingsPanel = screens.add("panel", undefined, "事前設定");
    settingsPanel.orientation = "column";
    settingsPanel.alignChildren = ["fill", "top"];
    settingsPanel.margins = 12;
    settingsPanel.spacing = 6;

    var resultPanel = screens.add("panel", undefined, "検査結果");
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
    settingsBtnGroup.alignment = "right";
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
    settingsContent.spacing = 6;
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
    settingsScrollbar.visible = false;

    // ---- スクロール/リサイズのジオメトリ管理 ----
    // 【方針】設定画面のリサイズは layout.resize() に任せず、初回レイアウト確定時に記録した
    // 「初期確定値(baseline)+ ウィンドウサイズ差分」から毎回計算する。
    // 前回のリサイズ結果を一切参照しないため、リサイズ繰り返しによる余白の累積が構造的に起きない。
    var settingsBaseline = null;       // 初回レイアウト確定時のジオメトリ記録
    var settingsContentNaturalH = 0;   // 設定コンテンツの自然高(初回実測で固定)

    // 【Mac対策】win.onShow直後はCocoa側のネイティブレイアウトが未確定で、
    // サイズ実測(.size)が不正確な場合がある(0や暫定値のまま)。
    // このタイミングでコンテンツ高を誤って固定してしまうと、後から正しい値で
    // 再測定しようとしても maximumSize の制約に阻まれて自然高を測れなくなる
    // (固定値の"自己ポイズニング")。そのため毎回の測定前に制約を一旦解除し、
    // 明示的に layout.layout(true) を呼んでから実測する(冪等・再呼び出し安全)。
    function captureSettingsBaseline() {
        try {
            settingsContent.minimumSize = [0, 0];
            settingsContent.maximumSize = [100000, 100000];
            win.layout.layout(true);
            // コンテンツの自然高を実測して固定し、以後のlayout処理で縮まないようにする
            // (layout.resize()がcolumn内でコンテンツをビューポート高に縮めてしまうと、
            //  実高=可視高になりスクロール不要と誤判定されるため)
            settingsContentNaturalH = settingsContent.size[1];
            if (!settingsContentNaturalH || settingsContentNaturalH < 10) {
                // 実測が不正(未確定)な場合はpreferredSizeにフォールバック
                settingsContentNaturalH = settingsContent.preferredSize ? settingsContent.preferredSize[1] : 0;
            }
            settingsContent.minimumSize.height = settingsContentNaturalH;
            settingsContent.maximumSize.height = settingsContentNaturalH;
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
        } catch (eCap) {}
    }

    // 設定画面のジオメトリを「baseline + ウィンドウサイズ差分」で機械的に再配置する。
    // layout.resize() を使わないため余白の自己増殖(累積)が起きない。
    function applySettingsResize() {
        if (!settingsBaseline) return;
        try {
            var dw = win.size[0] - settingsBaseline.winW;
            var dh = win.size[1] - settingsBaseline.winH;
            screens.size = [Math.max(120, settingsBaseline.screensW + dw), Math.max(60, settingsBaseline.screensH + dh)];
            settingsPanel.size = [Math.max(120, settingsBaseline.panelW + dw), Math.max(60, settingsBaseline.panelH + dh)];
            settingsViewportRow.size = [Math.max(100, settingsBaseline.rowW + dw), Math.max(40, settingsBaseline.rowH + dh)];
            settingsViewport.size = [Math.max(80, settingsBaseline.vpW + dw), Math.max(40, settingsBaseline.vpH + dh)];
            settingsScrollbar.size = [settingsScrollbar.size[0], Math.max(40, settingsBaseline.sbH + dh)];
            settingsScrollbar.location = [settingsBaseline.sbX + dw, settingsBaseline.sbY];
            // 【v6】ボタン列は settingsPanel の最初の子(画面最上部)に固定配置しており、
            // サイズも位置も window リサイズの影響を受けない(常にネイティブlayoutのtop寄せ)ため、
            // ここでの再配置は不要になった。
        } catch (eRsz) {}
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
    function updateSettingsScrollRange() {
        try {
            if (settingsBaseline) {
                var viewportH = settingsViewport.size ? settingsViewport.size[1] : 0;
                var maxScroll = settingsContentNaturalH - viewportH;
                if (maxScroll < 0) maxScroll = 0;
                settingsScrollbar.maxvalue = maxScroll;
                if (maxScroll <= 0) {
                    settingsScrollbar.value = 0;
                    settingsContent.location = [0, 0];
                    settingsScrollbar.enabled = false;
                    settingsScrollbar.visible = false;
                } else {
                    settingsScrollbar.enabled = true;
                    settingsScrollbar.visible = true;
                    if (settingsScrollbar.value > maxScroll) settingsScrollbar.value = maxScroll;
                    settingsContent.location = [0, -settingsScrollbar.value];
                }
            }
        } catch (eScroll) {}
        // baseline計算の成否によらず、ボタン列の可視性は必ずこの後で保証する
        ensureSettingsButtonsVisible();
    }
    settingsScrollbar.onChanging = function () {
        settingsContent.location = [0, -this.value];
    };
    settingsScrollbar.onChange = settingsScrollbar.onChanging;

    // --- 仕上がりサイズ ---
    var sizeGroup = settingsContent.add("panel", undefined, "仕上がりサイズ");
    sizeGroup.orientation = "row";
    sizeGroup.alignChildren = ["left", "center"];
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
    var progressAbortRow = progressGroup.add("group");
    var abortBtn = progressAbortRow.add("button", undefined, "中断");
    var abortNote = progressAbortRow.add("statictext", undefined, "※ ボタンが反応しない場合は ESC キーを押し続けてください(ESCキーで確実に中断できます)");
    // 注意: ExtendScriptの同期実行中はボタンのクリックイベントが処理されないことがあるため、
    // 主手段は ESC キーのポーリング(throwIfAborted)。ボタンは補助手段。
    abortBtn.onClick = function () { ABORT_FLAG.on = true; };
    progressGroup.visible = false;

    var resultBody = resultPanel.add("group");
    resultBody.orientation = "row";
    resultBody.alignChildren = ["fill", "fill"];
    resultBody.alignment = ["fill", "fill"]; // ウィンドウリサイズ時に伸縮する主領域

    var treeContainer = resultBody.add("panel", undefined, "項目一覧");
    treeContainer.alignChildren = ["fill", "fill"];
    treeContainer.alignment = ["fill", "fill"];
    var tree = treeContainer.add("treeview", undefined);
    tree.preferredSize = [340, 240]; // 初期は控えめ。リサイズで拡大可能
    tree.alignment = ["fill", "fill"];

    var listContainer = resultBody.add("panel", undefined, "検出オブジェクト一覧");
    listContainer.orientation = "column";
    listContainer.alignChildren = ["fill", "top"];
    listContainer.alignment = ["fill", "fill"];
    var detailList = listContainer.add("listbox", undefined, [], { multiselect: true });
    detailList.preferredSize = [340, 150]; // 初期は控えめ。リサイズで拡大可能
    detailList.alignment = ["fill", "fill"];
    var noteText = listContainer.add("statictext", undefined, "", { multiline: true });
    noteText.preferredSize = [340, 56];
    var selectBtnGroup = listContainer.add("group");
    var selectBtn = selectBtnGroup.add("button", undefined, "選択してズーム");
    selectBtnGroup.add("statictext", undefined, "(行のダブルクリックでもジャンプします)");
    var selStatusText = listContainer.add("statictext", undefined, "", { multiline: true });
    selStatusText.preferredSize = [340, 42];

    var resultBtnGroup = resultPanel.add("group");
    resultBtnGroup.alignment = "right";
    var backBtn = resultBtnGroup.add("button", undefined, "設定に戻る");
    var saveHtmlBtn = resultBtnGroup.add("button", undefined, "レポート保存(HTML)");
    var saveCsvBtn = resultBtnGroup.add("button", undefined, "レポート保存(CSV)");
    var closeBtn = resultBtnGroup.add("button", undefined, "閉じる"); // nameは付けない(設定側キャンセルとESC割当が競合するため)

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
        noteText.text = joinArr(noteParts, "\n");
        for (var i = 0; i < r.details.length; i++) {
            var li = detailList.add("item", r.details[i].text);
            li.itemRef = r.details[i].item;
        }
    };

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
            selStatusText.text = "この行にはオブジェクト参照がありません(ドキュメント全体に関する指摘です)。";
            if (!silent) alert("選択した項目にはオブジェクト参照がありません(ドキュメント全体に関する指摘です)。");
            return;
        }
        var rep = selectAndZoom(doc, arr);
        var statusMsg = rep.count > 0 ? (rep.count + "件を選択しました。") : "選択できませんでした。";
        if (rep.message) statusMsg += "\n" + rep.message;
        selStatusText.text = statusMsg;
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
        win.layout.layout(true);
    }

    backBtn.onClick = function () {
        resultPanel.visible = false;
        settingsPanel.visible = true;
        selStatusText.text = "";
        win.text = TITLE_SETTINGS;
        win.layout.layout(true);
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
        win.layout.layout(true);

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
                }
                win.update();
                // 【Mac対策・追加】win.update() だけでは同期実行中の再描画が反映されないケースに
                // 備え、アプリ側の再描画とイベントループへの処理譲渡を試みる(効果が無くても無害)。
                safe(function () { app.refresh(); return null; }, null);
                safe(function () { $.sleep(1); return null; }, null);
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
            win.layout.layout(true);
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
    win.onResize = function () {
        if (resultPanel.visible) {
            this.layout.resize();
        } else {
            applySettingsResize();
        }
        updateSettingsScrollRange();
    };
    // ダイアログ表示直後: 初回レイアウト確定値を記録し、初期スクロール範囲を計算する。
    // 【Mac対策】Cocoa側では onShow 発火時点でもネイティブレイアウトが未確定な場合があるため、
    // 即時実行に加えて app.scheduleTask() で少し遅延させた再計測・再補正も行う
    // (Windowsでは既に確定済みの値を再測定するだけなので実害はない=冪等)。
    KENPAN_DEFERRED_SETTINGS_INIT = function () {
        captureSettingsBaseline();
        updateSettingsScrollRange(); // 内部で ensureSettingsButtonsVisible() も呼ばれる
    };
    win.onShow = function () {
        KENPAN_DEFERRED_SETTINGS_INIT();
        safe(function () {
            app.scheduleTask("KENPAN_DEFERRED_SETTINGS_INIT();", 80, false);
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
    win.layout.layout(true);
    if (win.maximumSize && win.size) {
        var clampW = win.size[0] > win.maximumSize[0] ? win.maximumSize[0] : win.size[0];
        var clampH = win.size[1] > win.maximumSize[1] ? win.maximumSize[1] : win.size[1];
        if (clampW !== win.size[0] || clampH !== win.size[1]) {
            win.size = [clampW, clampH];
            win.layout.layout(true);
        }
    }
    win.center();
    win.show();
}

// -----------------------------------------------------------------------------
// 14. エントリーポイント
// -----------------------------------------------------------------------------

function main() {
    if (app.documents.length === 0) {
        alert("開いているドキュメントがありません。\nIllustratorでドキュメントを開いてから実行してください。");
        return;
    }
    try {
        buildAndShowDialog();
    } catch (e) {
        alert("デジタル検版ツールの実行中にエラーが発生しました。\n" + e.toString() + (e.line ? ("\n(行: " + e.line + ")") : ""));
    }
}

main();

})();
