"use strict";
/*
 * gen_tank.js -- civ:tank のモデル一式ジェネレータ
 *
 * 生成物:
 *   models/entity/tank.geo.json   ... 形状 + per-face UV
 *   textures/entity/tank.png      ... 上記UVに合わせて手続き的に描いたアトラス
 *
 * 使い方:  node tools/gen_tank.js       (このリソースパックのルートから)
 *
 * 設計方針(gen_airship.js と同じ):
 *   - 形状はこのファイル内の cube 定義がソース。Blockbench で開ける普通の geo を吐くが、
 *     UV はここが正なので、形をいじったら必ず再生成すること。
 *   - UV は box UV ではなく per-face UV。面ごとに 1テクセル=1モデル単位。
 *   - 見えない面(履帯の内側・車体底面など)は flat 指定で単色パッチを共有する。
 *   - 塗りはモデル空間の座標を受け取る関数。迷彩・国籍マーク・泥汚れが面をまたいで
 *     繋がるように、左右対称(|x| 依存)の模様だけを使う。
 *
 * 座標系: 16単位 = 1ブロック。砲身は -Z 方向(scripts/unitModels.js の yawTowards が
 *   yaw=0 で -Z を向く前提)。底面 y=0 が接地面。全長 z=-40..29(約4.3ブロック)、
 *   車幅 x=±16(2ブロック)、アンテナ込み高さ 44(約2.8ブロック)。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const RP = path.resolve(__dirname, "..");

/* ============================ パレット ============================ */
const C = {
    green:      [0x4C, 0x55, 0x3A], // 迷彩の基調(オリーブドラブ)
    greenLight: [0x60, 0x6C, 0x4A],
    greenDark:  [0x36, 0x3E, 0x2A],
    brown:      [0x5B, 0x47, 0x2E], // 迷彩の茶
    brownDark:  [0x42, 0x33, 0x21],
    black:      [0x2B, 0x2D, 0x29], // 迷彩の黒帯
    steel:      [0x45, 0x49, 0x4C],
    steelDark:  [0x25, 0x28, 0x2A],
    steelLight: [0x6C, 0x72, 0x78],
    rubber:     [0x1D, 0x1E, 0x20],
    mud:        [0x5D, 0x4C, 0x35],
    rust:       [0x6E, 0x46, 0x2B],
    canvas:     [0x7C, 0x6D, 0x4E],
    canvasDark: [0x57, 0x4B, 0x35],
    red:        [0xA8, 0x32, 0x26],
    redDark:    [0x74, 0x20, 0x17],
    white:      [0xD6, 0xD0, 0xC2],
    lamp:       [0xD8, 0xCE, 0x9A],
    lampDark:   [0x8A, 0x82, 0x5C],
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const jit = (c, n) => [clamp(c[0] + n, 0, 255), clamp(c[1] + n, 0, 255), clamp(c[2] + n, 0, 255)];
function hash(x, y, z) {
    const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return h - Math.floor(h);
}
const smooth = (t) => t * t * (3 - 2 * t);
/** 格子サイズ s の値ノイズ。迷彩のまだら模様用。 */
function vnoise(x, y, z, s) {
    const fx = x / s, fy = y / s, fz = z / s;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    const tx = smooth(fx - ix), ty = smooth(fy - iy), tz = smooth(fz - iz);
    let v = 0;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
        v += (i ? tx : 1 - tx) * (j ? ty : 1 - ty) * (k ? tz : 1 - tz) * hash(ix + i, iy + j, iz + k);
    }
    return v;
}

/* 面ローカル座標での縁の暗さ(溶接ビード)・パネル線・リベット */
function plate(c, q, period, lineAmt, rivet) {
    const { u, v, fw, fh } = q;
    if (u === 0 || v === 0 || u === fw - 1 || v === fh - 1) c = mix(c, C.steelDark, 0.32);
    if (period > 0) {
        if (u % period === 0 || v % period === 0) c = mix(c, C.steelDark, lineAmt);
        if (rivet && u % period === (period >> 1) && v % period === (period >> 1)) c = mix(c, C.steelLight, 0.5);
    }
    return c;
}

/* 面の向きによる明暗。上面は明るく、下面と前後面は暗く。 */
function faceShade(c, f) {
    if (f === "up") return mix(c, C.white, 0.10);
    if (f === "down") return mix(c, C.black, 0.45);
    if (f === "north" || f === "south") return mix(c, C.black, 0.10);
    return c;
}

/* 車体下部に付く泥汚れ。地面に近いほど濃い。 */
function dirt(c, p) {
    const t = clamp((14 - p.y) / 14, 0, 1);
    if (t <= 0) return c;
    const n = vnoise(Math.abs(p.x) + 5, p.y * 1.6, p.z, 6);
    return mix(c, C.mud, clamp(t * t * 0.55 * (0.4 + n), 0, 0.6));
}

/* ============================ マテリアル ============================ */
/* (face, p={x,y,z}(モデル空間), q={u,v,fw,fh,cube}) -> [r,g,b] */

/* NATO 3色迷彩。|x| を使うので左右対称に繋がる。 */
function camo(p) {
    const n1 = vnoise(Math.abs(p.x), p.y * 0.85, p.z, 14);
    const n2 = vnoise(Math.abs(p.x) + 41, p.y * 0.85 + 17, p.z + 63, 9);
    let c = C.green;
    if (n1 > 0.555) c = C.brown;
    if (n2 > 0.635) c = C.black;
    return c;
}

/* 砲塔側面の国籍マーク(飛行船と同じ赤/白の同心円)。 */
function roundel(c, f, p) {
    if (f !== "east" && f !== "west") return c;
    if (Math.abs(p.x) < 9 || p.z < -14 || p.z > 12) return c;
    const r = Math.hypot(p.z + 1, p.y - 26.5);
    if (r < 1.9) return C.red;
    if (r < 3.1) return C.white;
    if (r < 4.3) return C.red;
    if (r < 4.9) return mix(c, C.redDark, 0.55);
    return c;
}

const MAT = {
    // 装甲。迷彩 + 溶接ビード + 引っかき傷 + 泥
    armor: (f, p, q) => {
        let c = camo(p);
        c = faceShade(c, f);
        c = roundel(c, f, p);
        const s = hash(p.x * 2.3, p.y * 1.7, p.z * 3.1);
        if (s > 0.982) c = mix(c, C.steelLight, 0.45);       // 塗装剥がれ
        else if (s > 0.965) c = mix(c, C.brownDark, 0.35);   // 錆の点
        c = plate(c, q, 0, 0, false);
        c = dirt(c, p);
        return jit(c, (hash(p.x * 0.9, p.y * 1.1, p.z * 0.7) - 0.5) * 10);
    },

    /*
     * 履帯。側面は実車と同じ「上下に履板の走行部、その間に転輪が覗く」構成に塗り分ける。
     * 一枚のキューブで済ませるかわりに、帯ごとに模様を変えて奥行きを出している。
     */
    track: (f, p, q) => {
        // 履板(連結ピッチの線)
        const link = () => {
            let c = mix(C.steelDark, C.steel, 0.35);
            const zi = ((Math.floor(p.z) % 4) + 4) % 4;
            if (zi === 0) c = mix(c, C.black, 0.6);
            if (zi === 2) c = mix(c, C.steelLight, 0.18);
            if (f === "up") c = mix(c, C.steelLight, 0.18);
            return c;
        };
        let c;
        if ((f === "east" || f === "west") && p.y > 2.5 && p.y < 11 && p.z > -22 && p.z < 22) {
            c = mix(C.black, C.steelDark, 0.30);            // 履帯の内側(影)
            for (const wz of [-17.5, -10.5, -3.5, 3.5, 10.5, 17.5]) {
                const r = Math.hypot(p.z - wz, p.y - 6.75);
                if (r >= 3.4) continue;
                c = mix(C.rubber, C.steelDark, 0.25);       // ゴムのタイヤ
                if (r < 2.6) c = mix(C.steel, C.steelLight, 0.30);  // リム
                if (r < 1.7) c = mix(C.green, C.steelDark, 0.35);   // 転輪の皿(車体色)
                if (r < 0.8) c = C.steelDark;               // ハブ
                break;
            }
        } else if ((f === "east" || f === "west") && (p.z < -22 || p.z > 22)) {
            // 起動輪 / 誘導輪。歯の分だけ明暗を刻む
            c = mix(C.black, C.steelDark, 0.30);
            const wz = p.z < 0 ? -25 : 25;
            const r = Math.hypot(p.z - wz, p.y - 9);
            if (r < 5.4) {
                const a = Math.atan2(p.y - 9, p.z - wz);
                c = mix(C.steel, C.steelDark, 0.25);
                if (r > 4.0) c = mix(c, Math.cos(a * 8) > 0 ? C.steelLight : C.black, 0.5); // 歯
                if (r < 3.0) c = mix(C.green, C.steelDark, 0.35);
                if (r < 1.1) c = C.steelDark;
            } else c = link();
        } else c = link();
        c = mix(c, C.mud, clamp((9 - p.y) / 20, 0, 0.4));
        return jit(plate(c, q, 0, 0, false), (hash(p.x, p.y, p.z) - 0.5) * 12);
    },

    // 砲身・防盾。滑らかな鋼。防熱ジャケットのバンドを入れる
    gun: (f, p, q) => {
        let c = mix(C.steel, C.greenDark, 0.45);
        const d = Math.hypot(p.x, p.y - 26.5);
        c = mix(c, C.steelLight, clamp((3.2 - d) / 6, 0, 0.28));
        if (f === "up") c = mix(c, C.white, 0.06);
        if (f === "down") c = mix(c, C.black, 0.4);
        if (((Math.floor(p.z) % 8) + 8) % 8 === 0) c = mix(c, C.steelDark, 0.4);
        if (p.z < -35) c = mix(c, C.steelDark, 0.35);  // 砲口制退器は焼けて黒い
        return jit(plate(c, q, 0, 0, false), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    steel: (f, p, q) => jit(faceShade(plate(C.steel, q, 6, 0.35, true), f), (hash(p.x, p.y, p.z) - 0.5) * 9),

    // 機関室のグリル(上面から見えるので細かく)
    grille: (f, p, q) => {
        let c = mix(C.steelDark, C.green, 0.30);
        if (f === "up") {
            if (q.v % 2 === 0) c = mix(c, C.black, 0.55);
            else c = mix(c, C.steelLight, 0.20);
            if (q.u % 12 === 0) c = mix(C.green, C.steelDark, 0.4);
        } else c = faceShade(mix(C.green, C.steelDark, 0.35), f);
        return jit(plate(c, q, 0, 0, false), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    // ハッチ(周囲にヒンジ、中央にペリスコープ)
    hatch: (f, p, q) => {
        let c = camo(p);
        c = faceShade(c, f);
        if (f === "up") {
            const cu = q.fw / 2 - 0.5, cv = q.fh / 2 - 0.5;
            const r = Math.hypot(q.u - cu, q.v - cv);
            if (r < Math.min(cu, cv) - 0.5) c = mix(c, C.steelDark, 0.30);
            if (r < 1.6) c = mix(C.steel, C.steelLight, 0.35);
        }
        c = plate(c, q, 0, 0, false);
        return jit(dirt(c, p), (hash(p.x, p.y, p.z) - 0.5) * 9);
    },

    // 発煙弾発射機(3連装の筒)
    smoke: (f, p, q) => {
        let c = mix(C.green, C.steelDark, 0.45);
        if ((f === "east" || f === "west") && ((Math.floor(p.z) % 3) + 3) % 3 === 1) c = mix(c, C.steelLight, 0.25);
        if (f === "north") c = C.steelDark;   // 筒の口
        return jit(plate(c, q, 0, 0, false), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    // 予備部品箱・車外装備品箱
    stow: (f, p, q) => {
        let c = faceShade(mix(camo(p), C.greenDark, 0.25), f);
        if ((f === "east" || f === "west" || f === "up") && ((Math.floor(p.z) % 6) + 6) % 6 === 0) c = mix(c, C.steelDark, 0.35);
        return jit(dirt(plate(c, q, 0, 0, false), p), (hash(p.x, p.y, p.z) - 0.5) * 9);
    },

    // 砲塔後部のラック(格子)
    rack: (f, p, q) => {
        let c = mix(C.steel, C.greenDark, 0.4);
        const open = (q.u % 4 !== 0) && (q.v % 4 !== 0) && q.u > 0 && q.v > 0 && q.u < q.fw - 1 && q.v < q.fh - 1;
        if (open && (f === "east" || f === "west" || f === "south")) c = mix(c, C.black, 0.55);
        return jit(plate(c, q, 0, 0, false), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    // 天幕 / 背嚢を縛り付けた荷物
    canvas: (f, p, q) => {
        const line = (f === "up" || f === "down") ? q.v : q.u;
        let c = mix(C.canvas, C.canvasDark, 0.35 + 0.3 * vnoise(p.x, p.y, p.z, 4));
        if (((Math.floor(line) % 7) + 7) % 7 === 0) c = mix(c, C.brownDark, 0.55); // 締め紐
        c = faceShade(c, f);
        return jit(plate(c, q, 0, 0, false), (hash(p.x, p.y, p.z) - 0.5) * 10);
    },

    // 排気管(錆と煤)
    rust: (f, p, q) => {
        let c = mix(C.rust, C.steelDark, 0.35 + 0.4 * vnoise(p.x + 3, p.y, p.z, 5));
        if (p.z > 26) c = mix(c, C.black, 0.45);
        return jit(faceShade(plate(c, q, 0, 0, false), f), (hash(p.x, p.y, p.z) - 0.5) * 12);
    },

    // 前照灯(前面だけレンズ、他は装甲ガード)
    lamp: (f, p, q) => {
        if (f !== "north") return MAT.armor(f, p, q);
        const cu = q.fw / 2 - 0.5, cv = q.fh / 2 - 0.5;
        const r = Math.hypot(q.u - cu, q.v - cv);
        if (r > Math.min(cu, cv) - 0.2) return jit(mix(C.steel, C.greenDark, 0.4), -4);
        let c = mix(C.lamp, C.lampDark, clamp(r / 3, 0, 1));
        if (q.u - q.v > 0 && r < 1.4) c = mix(c, C.white, 0.5);
        return jit(c, (hash(p.x, p.y, p.z) - 0.5) * 6);
    },
};

// flat 指定の面が参照する単色パッチ
const SWATCH = {
    armor: C.greenDark, track: C.steelDark, gun: C.steelDark, steel: C.steel,
    grille: C.steelDark, hatch: C.greenDark, smoke: C.steelDark, stow: C.greenDark,
    rack: C.steelDark, canvas: C.canvasDark, rust: C.steelDark, lamp: C.steelDark,
};

/* ============================ モデル定義 ============================ */
const cubes = [];

function B(bone, x0, y0, z0, x1, y1, z1, mat, opts) {
    cubes.push(Object.assign({ bone, x0, y0, z0, x1, y1, z1, mat }, opts || {}));
}
/** x>0 側を渡すと左右対称に2個置く。 */
function BM(bone, x0, y0, z0, x1, y1, z1, mat, opts) {
    B(bone, x0, y0, z0, x1, y1, z1, mat, opts);
    const o = Object.assign({}, opts || {});
    // 左右で「内側/外側」が入れ替わるので、east/west の flat 指定も入れ替える
    if (o.flat) o.flat = o.flat.map((f) => (f === "east" ? "west" : f === "west" ? "east" : f));
    B(bone, -x1, y0, z0, -x0, y1, z1, mat, o);
}
const D = ["down"];   // 接地しているので底面はどの角度からも見えない

/* ---- 履帯(x=9..15)。前後端は誘導輪 / 起動輪ぶん高く張り出させる ---- */
BM("hull",  9,  0, -22, 15, 13,  22, "track", { flat: ["down", "west"] });
BM("hull",  9,  2, -28, 15, 16, -22, "track", { flat: ["down", "south", "west"] });
BM("hull",  9,  2,  22, 15, 16,  28, "track", { flat: ["down", "north", "west"] });

/* ---- 車体下部(履帯の間)。側面は履帯で隠れる ---- */
B("hull", -9, 3, -22, 9, 16, 22, "armor", { flat: ["down", "east", "west"] });

/* ---- 車体上部(フェンダー。履帯の上に張り出す) ---- */
B("hull", -16, 16, -25, 16, 20, 25, "armor", { flat: D });

/* ---- サイドスカート。転輪が見えるよう、フェンダーから下へ少しだけ垂らす ---- */
BM("hull", 15, 11, -22, 16, 16, 22, "armor", { flat: ["down", "west"] });

/* ---- 前面(避弾経始を段差で近似した傾斜装甲) ---- */
B("hull", -15, 16, -28, 15, 20, -25, "armor", { flat: D });
B("hull", -15, 13, -30, 15, 17, -28, "armor", { flat: D });
B("hull", -14, 10, -31, 14, 14, -30, "armor", { flat: D });
BM("hull", 10, 10, -32, 13, 13, -31, "steel", { flat: D });    // 牽引フック

/* ---- 前照灯(フェンダー前端) ---- */
BM("hull", 10, 20, -28, 14, 23, -25, "lamp", { flat: D });

/* ---- 後面と排気管 ---- */
B("hull", -15, 14, 25, 15, 20, 27, "armor", { flat: D });
BM("hull", 9, 15, 25, 15, 19, 29, "rust", { flat: ["down", "west"] });

/* ---- 機関室上面のグリルと各ハッチ ---- */
B("hull", -13, 20, 8, 13, 21, 22, "grille", { flat: D });
B("hull", -8, 20, -24, -1, 21, -18, "hatch", { flat: D });      // 操縦手ハッチ
B("hull", 2, 20, -24, 9, 21, -19, "grille", { flat: D });       // 前方吸気口

/* ---- フェンダー上の装備品箱 ---- */
BM("hull", 10, 20, 0, 15, 24, 14, "stow", { flat: D });
BM("hull", 10, 20, -18, 15, 23, -8, "stow", { flat: D });

/* ---- 砲塔リング ---- */
B("hull", -9, 20, -8, 9, 22, 10, "steel", { flat: ["down", "up"] });

/* ---- 砲塔 ---- */
B("turret", -11, 22, -14, 11, 26, 12, "armor", { flat: D });
B("turret", -11, 26, -12, 11, 31, 10, "armor", { flat: D });
B("turret", -11, 23, -17, 11, 29, -14, "armor", { flat: D });   // 前面の張り出し
B("turret", -9, 24, -19, 9, 28, -17, "armor", { flat: D });
B("turret", -9, 24, 12, 9, 30, 19, "armor", { flat: D });       // 後部バスル
B("turret", -9, 25, 19, 9, 30, 22, "rack", { flat: D });        // 後部ラック
B("turret", -6, 30, 14, 6, 32, 20, "canvas", { flat: D });      // 括り付けた天幕
BM("turret", 11, 26, -12, 13, 29, -6, "smoke", { flat: ["down", "west"] });
B("turret", -9, 31, -2, -2, 32, 5, "hatch", { flat: D });       // 装填手ハッチ
B("turret", -9, 31, 6, -8, 44, 7, "steel", { flat: ["down", "up"] });  // アンテナ

/* ---- 車長キューポラと車載機銃 ---- */
B("turret", 2, 31, -4, 9, 35, 4, "armor", { flat: D });
B("turret", 2, 35, -4, 9, 36, 4, "hatch", { flat: D });
B("mg", 4, 36, -2, 7, 37, 2, "steel", { flat: D });
B("mg", 4, 37, -5, 7, 39, 1, "steel", { flat: D });
B("mg", 5, 37, -12, 6, 38, -5, "gun", { flat: D });

/* ---- 主砲(防盾 + 砲身 + 防熱ジャケット + 砲口制退器) ---- */
B("gun", -5, 23, -21, 5, 30, -17, "steel", { flat: ["down", "south"] });
B("gun", -2, 25, -37, 2, 29, -21, "gun", { flat: ["down", "south"] });
B("gun", -3, 24, -30, 3, 30, -22, "gun", { flat: D });
B("gun", -3, 24, -40, 3, 30, -36, "gun", { flat: ["down", "south"] });

/* ボーン階層 (name, parent, pivot)。旋回・俯仰させたくなったらここを軸に回す。 */
const BONES = [
    ["root", null, [0, 0, 0]],
    ["hull", "root", [0, 0, 0]],
    ["turret", "hull", [0, 20, -1]],   // 砲塔旋回軸
    ["gun", "turret", [0, 26, -18]],   // 砲の俯仰軸
    ["mg", "turret", [5.5, 37, -2]],
];

/* ============================ 面の定義とUVパッキング ============================ */
const FACES = ["north", "east", "south", "west", "up", "down"];

function faceInfo(cb, face) {
    const { x0, y0, z0, x1, y1, z1 } = cb;
    const w = x1 - x0, h = y1 - y0, d = z1 - z0;
    switch (face) {
        case "north": return { fw: w, fh: h, at: (u, v) => ({ x: x1 - u - 0.5, y: y1 - v - 0.5, z: z0 + 0.5 }) };
        case "south": return { fw: w, fh: h, at: (u, v) => ({ x: x0 + u + 0.5, y: y1 - v - 0.5, z: z1 - 0.5 }) };
        case "east":  return { fw: d, fh: h, at: (u, v) => ({ x: x1 - 0.5, y: y1 - v - 0.5, z: z1 - u - 0.5 }) };
        case "west":  return { fw: d, fh: h, at: (u, v) => ({ x: x0 + 0.5, y: y1 - v - 0.5, z: z0 + u + 0.5 }) };
        case "up":    return { fw: w, fh: d, at: (u, v) => ({ x: x0 + u + 0.5, y: y1 - 0.5, z: z0 + v + 0.5 }) };
        case "down":  return { fw: w, fh: d, at: (u, v) => ({ x: x0 + u + 0.5, y: y0 + 0.5, z: z1 - v - 0.5 }) };
    }
}

const rects = [];
const swatches = new Map();
for (const cb of cubes) {
    if (cb.x1 <= cb.x0 || cb.y1 <= cb.y0 || cb.z1 <= cb.z0) throw new Error("空のキューブ: " + JSON.stringify(cb));
    cb.uv = {};
    const flat = new Set(cb.flat || []);
    for (const face of FACES) {
        if (flat.has(face)) {
            if (!swatches.has(cb.mat)) {
                const r = { w: 8, h: 8, swatch: cb.mat };
                swatches.set(cb.mat, r);
                rects.push(r);
            }
            cb.uv[face] = { swatchOf: cb.mat };
            continue;
        }
        const fi = faceInfo(cb, face);
        const r = { w: fi.fw, h: fi.fh, cube: cb, face, fi };
        rects.push(r);
        cb.uv[face] = r;
    }
}

/** 棚詰め。指定幅で詰めたときの高さを返す(rect に x,y を書き込む) */
function shelfPack(list, W, pad) {
    let x = pad, y = pad, rowH = 0;
    for (const r of list) {
        if (x + r.w + pad > W) { x = pad; y += rowH + pad; rowH = 0; }
        if (r.w + pad * 2 > W) return Infinity;
        r.x = x; r.y = y;
        x += r.w + pad;
        if (r.h > rowH) rowH = r.h;
    }
    return y + rowH + pad;
}

const order = rects.slice().sort((a, b) => b.h - a.h || b.w - a.w);
let TW = 0, TH = 0, best = Infinity;
for (const W of [64, 128, 256, 512]) {
    const H = shelfPack(order, W, 1);
    if (!isFinite(H) || H > 1024) continue;
    const score = W * H * (1 + 0.12 * Math.abs(Math.log2(W / Math.max(1, H))));
    if (score < best) { best = score; TW = W; TH = H; }
}
if (!TW) throw new Error("アトラスに収まらない");
shelfPack(order, TW, 1);
TH = Math.ceil(TH / 16) * 16;

/* ============================ 描画 ============================ */
const px = Buffer.alloc(TW * TH * 4);
for (let i = 0; i < TW * TH; i++) { px[i * 4] = 26; px[i * 4 + 1] = 27; px[i * 4 + 2] = 30; px[i * 4 + 3] = 255; }
function put(x, y, c) {
    if (x < 0 || y < 0 || x >= TW || y >= TH) return;
    const i = (y * TW + x) * 4;
    px[i] = Math.round(c[0]); px[i + 1] = Math.round(c[1]); px[i + 2] = Math.round(c[2]); px[i + 3] = 255;
}
for (const r of rects) {
    if (r.swatch) {
        const c = SWATCH[r.swatch];
        if (!c) throw new Error("SWATCH 未定義: " + r.swatch);
        for (let v = 0; v < r.h; v++) for (let u = 0; u < r.w; u++) put(r.x + u, r.y + v, c);
        continue;
    }
    const fn = MAT[r.cube.mat];
    if (!fn) throw new Error("未定義のマテリアル: " + r.cube.mat);
    for (let v = 0; v < r.h; v++) {
        for (let u = 0; u < r.w; u++) {
            const p = r.fi.at(u, v);
            put(r.x + u, r.y + v, fn(r.face, p, { u, v, fw: r.w, fh: r.h, cube: r.cube }));
        }
    }
}

/* ============================ PNG 書き出し ============================ */
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc(TH * (1 + TW * 4));
for (let y = 0; y < TH; y++) {
    raw[y * (1 + TW * 4)] = 0;
    px.copy(raw, y * (1 + TW * 4) + 1, y * TW * 4, (y + 1) * TW * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(TW, 0); ihdr.writeUInt32BE(TH, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
]);

/* ============================ geo 書き出し ============================ */
const byBone = new Map();
for (const cb of cubes) {
    if (!byBone.has(cb.bone)) byBone.set(cb.bone, []);
    byBone.get(cb.bone).push(cb);
}
const bones = BONES.map(([name, parent, pivot]) => {
    const b = { name, pivot };
    if (parent) b.parent = parent;
    const list = byBone.get(name);
    if (list) {
        b.cubes = list.map((cb) => {
            const uv = {};
            for (const face of FACES) {
                const r = cb.uv[face];
                if (r.swatchOf) {
                    const s = swatches.get(r.swatchOf);
                    uv[face] = { uv: [s.x + 2, s.y + 2], uv_size: [4, 4] };
                } else {
                    uv[face] = { uv: [r.x, r.y], uv_size: [r.w, r.h] };
                }
            }
            return { origin: [cb.x0, cb.y0, cb.z0], size: [cb.x1 - cb.x0, cb.y1 - cb.y0, cb.z1 - cb.z0], uv };
        });
    }
    return b;
});
for (const bone of byBone.keys()) if (!BONES.some(([n]) => n === bone)) throw new Error("階層に無いボーン: " + bone);

const geo = {
    format_version: "1.16.0",
    "minecraft:geometry": [{
        description: {
            identifier: "geometry.civ.tank",
            texture_width: TW,
            texture_height: TH,
            visible_bounds_width: 5,
            visible_bounds_height: 3.5,
            visible_bounds_offset: [0, 1.5, 0],
        },
        bones,
    }],
};

fs.writeFileSync(path.join(RP, "models/entity/tank.geo.json"), JSON.stringify(geo, null, 2) + "\n");
fs.writeFileSync(path.join(RP, "textures/entity/tank.png"), png);
console.log(`cubes=${cubes.length} faces=${rects.length} atlas=${TW}x${TH} png=${png.length}B`);
