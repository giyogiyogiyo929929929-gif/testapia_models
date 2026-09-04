"use strict";
/*
 * gen_missile.js -- civ:missile(ミサイル)のモデル一式ジェネレータ
 *
 * 生成物:
 *   models/entity/missile.geo.json  ... 形状 + per-face UV
 *   textures/entity/missile.png     ... 上記UVに合わせて手続き的に描いたアトラス
 *
 * 使い方:  node tools/gen_missile.js      (このリソースパックのルートから)
 *
 * 設計方針(gen_fighter.js / gen_tank.js と同じ):
 *   - 形状はこのファイル内の cube 定義がソース。Blockbench で開ける普通の geo を吐くが、
 *     UV はここが正なので、形をいじったら必ず再生成すること。
 *   - UV は box UV ではなく per-face UV。面ごとに 1テクセル=1モデル単位。
 *   - 塗りはモデル空間の座標を受け取る関数。ロール基準の白黒模様・警戒帯が面をまたいで
 *     繋がるように、Z(機軸)方向にだけ依存する模様を使う。
 *
 * 座標系: 16単位 = 1ブロック。弾頭は -Z 方向(scripts/unitModels.js の yawTowards が
 *   yaw=0 で -Z を向く前提)。全長 z=-34..30(4ブロック)、胴の断面は x±5・y±6 の
 *   八角形(直径 0.75ブロック)、尾翼を含む最大幅 x=±14。
 *
 * 💡 【接地しない。y=8 が機軸(胴体の中心線)】
 *   飛翔体なので底面 y=0 という決まりが無い。root からの相対で y=8 が機軸になっており、
 *   ロール(Z軸回転)や仰角を付けたいときは body/root ボーンをこの高さの pivot で回す。
 *   垂直に立てて発射台に置きたい場合は root を X 軸まわりに -90 度回せばよい
 *   (Bedrock のボーン回転は「X が正 = -Z 側が下がる」ので、上を向かせるのは負の値)。
 *
 * 💡 【炎(flame ボーン)は飛翔中の見た目】
 *   都市の在庫として静止表示する用途に使うなら、flame ボーンを scale 0 にするか
 *   animations/missile.animation.json の burn を外して使うこと。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const RP = path.resolve(__dirname, "..");

/* ============================ パレット ============================ */
const C = {
    white:      [0xD9, 0xD6, 0xCE], // 弾体の白
    whiteDark:  [0xAE, 0xAC, 0xA5],
    gray:       [0x8E, 0x92, 0x97],
    grayDark:   [0x4A, 0x4E, 0x53],
    black:      [0x24, 0x25, 0x28], // ロール基準の黒
    blackSoft:  [0x3A, 0x3C, 0x40],
    red:        [0xB0, 0x33, 0x26], // 警戒帯
    redDark:    [0x76, 0x21, 0x18],
    steel:      [0x4B, 0x50, 0x56],
    steelDark:  [0x26, 0x29, 0x2D],
    steelLight: [0x7A, 0x81, 0x89],
    ablative:   [0x3E, 0x35, 0x31], // 弾頭先端の耐熱材
    ablativeLt: [0x5C, 0x50, 0x49],
    heat:       [0x7A, 0x6A, 0x60], // ノズルの焼け
    heatGold:   [0x8C, 0x74, 0x48],
    heatBlue:   [0x4E, 0x53, 0x6E],
    soot:       [0x33, 0x31, 0x2F],
    flameCore:  [0xFF, 0xF3, 0xC8],
    flameHot:   [0xFF, 0xB8, 0x4C],
    flameBlue:  [0x8C, 0xB4, 0xFF],
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const jit = (c, n) => [clamp(c[0] + n, 0, 255), clamp(c[1] + n, 0, 255), clamp(c[2] + n, 0, 255)];
function hash(x, y, z) {
    const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return h - Math.floor(h);
}
const smooth = (t) => t * t * (3 - 2 * t);
/** 格子サイズ s の値ノイズ。塗装のむら用。 */
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
/** 整数化した値の剰余(負数でも 0..m-1 に収める) */
const mod = (v, m) => ((Math.round(v) % m) + m) % m;

/* 面ローカル座標での縁の暗さ(外板の合わせ目) */
function edge(c, q, amt) {
    const { u, v, fw, fh } = q;
    if (u === 0 || v === 0 || u === fw - 1 || v === fh - 1) return mix(c, C.grayDark, amt);
    return c;
}

/* 面の向きによる明暗。上面は明るく、下面と後面は暗く。 */
function faceShade(c, f) {
    if (f === "up") return mix(c, C.white, 0.07);
    if (f === "down") return mix(c, C.black, 0.14);
    if (f === "south") return mix(c, C.black, 0.12);
    return c;
}

/* ============================ 塗りの部品 ============================ */

/*
 * ロール基準の白黒模様。弾頭部(z <= -19)にだけ入れる。
 * 💡 「4分割を1区画ずつ交互に塗る」実物の模様を、面の向き(上下面か左右面か)で
 *    再現している。Z にしか依存しないので、面の UV が左右反転しても崩れない。
 */
function rollPattern(c, p, f) {
    if (p.z > -19) return c;
    const seg = Math.floor((p.z + 34) / 5);
    const vertical = (f === "up" || f === "down");
    const dark = (seg % 2 === 0) === vertical;
    return dark ? mix(C.black, C.blackSoft, 0.35 + 0.3 * vnoise(p.x, p.y, p.z, 4)) : c;
}

/* 段の警戒帯・区画の境目。弾頭と推進部の継ぎ目に入る。 */
function bands(c, p) {
    const z = Math.round(p.z);
    if (z >= -18 && z <= -16) return mix(C.red, C.redDark, 0.25);   // 弾頭の警戒帯
    if (z >= 16 && z <= 18) return mix(C.red, C.redDark, 0.25);     // 推進薬の警戒帯
    if (z === -19 || z === -15 || z === 15 || z === 19) return mix(c, C.grayDark, 0.55); // 帯の縁
    if (z === -14 || z === 22) return mix(c, C.grayDark, 0.45);     // 段の継ぎ目
    return c;
}

/* 外板のパネルラインと点検口。 */
function panels(c, p, f) {
    if (mod(p.z, 11) === 0) c = mix(c, C.grayDark, 0.28);
    if (mod(p.z, 11) === 5 && mod(Math.abs(p.x) + p.y, 5) === 0) c = mix(c, C.gray, 0.35); // 留め具
    if ((f === "east" || f === "west") && mod(p.y, 6) === 0) c = mix(c, C.grayDark, 0.14);
    return c;
}

/* 排煙の煤。後方(ノズル寄り)ほど濃い。 */
function soot(c, p) {
    const t = clamp((p.z - 14) / 14, 0, 1);
    if (t <= 0) return c;
    const n = vnoise(Math.abs(p.x), p.y, p.z, 6);
    return mix(c, C.soot, clamp(t * t * 0.60 * (0.5 + n), 0, 0.65));
}

/* ============================ マテリアル ============================ */
/* (face, p={x,y,z}(モデル空間), q={u,v,fw,fh,cube}) -> [r,g,b] */

const MAT = {
    /* 弾体の外板(白)。警戒帯・パネルライン・煤。 */
    skin: (f, p, q) => {
        let c = mix(C.white, C.whiteDark, 0.10 + 0.35 * vnoise(p.x * 0.8, p.y * 0.8, p.z * 0.6, 13));
        c = bands(c, p);
        c = panels(c, p, f);
        if (hash(p.x * 2.3, p.y * 1.7, p.z * 3.1) > 0.991) c = mix(c, C.gray, 0.40);  // 塗装の擦れ
        c = soot(c, p);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.22), (hash(p.x * 0.9, p.y * 1.1, p.z * 0.7) - 0.5) * 8);
    },

    /* 弾頭部。外板と同じ塗りに、ロール基準の白黒模様を重ねる。 */
    nose: (f, p, q) => {
        let c = mix(C.white, C.whiteDark, 0.10 + 0.30 * vnoise(p.x * 0.8, p.y * 0.8, p.z * 0.6, 11));
        c = rollPattern(c, p, f);
        c = bands(c, p);
        c = panels(c, p, f);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.24), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    /* 先端の耐熱材(アブレータ)。焼けて艶が無い。 */
    nosetip: (f, p, q) => {
        let c = mix(C.ablative, C.ablativeLt, 0.20 + 0.45 * vnoise(p.x * 2, p.y * 2, p.z, 3));
        if (f === "north") c = mix(c, C.black, 0.30);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.26), (hash(p.x, p.y, p.z) - 0.5) * 9);
    },

    /* 尾翼・前部の安定翼。前縁(-Z 側)は赤、根元は白。 */
    fin: (f, p, q) => {
        let c = mix(C.white, C.whiteDark, 0.15 + 0.30 * vnoise(p.x, p.y, p.z * 0.7, 7));
        const span = Math.max(Math.abs(p.x), Math.abs(p.y - 8));       // 機軸からの距離
        if (span > 10) c = mix(c, C.red, 0.80);                         // 翼端の識別色
        if (mod(p.z, 9) === 0) c = mix(c, C.grayDark, 0.25);            // 桁の位置
        // 💡 翼は噴口より前に付いているので、胴体ほど煤けさせない(全体が茶色く濁る)。
        if (p.z > 20) c = mix(c, C.soot, clamp((p.z - 20) / 14, 0, 1) * 0.35);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.30), (hash(p.x, p.y, p.z) - 0.5) * 9);
    },

    /* 背中を走るケーブルダクト(レースウェイ)。 */
    raceway: (f, p, q) => {
        let c = mix(C.gray, C.grayDark, 0.30 + 0.25 * vnoise(p.x, p.y, p.z, 5));
        if (mod(p.z, 7) === 0) c = mix(c, C.steelLight, 0.30);          // 締結バンド
        c = soot(c, p);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.30), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    /*
     * 推進部の外殻とノズル。後ろほど焼けて虹色になり、南面(=噴口)には
     * 同心のリングと暗い穴を描いて「奥に燃焼室がある」ように見せる。
     */
    nozzle: (f, p, q) => {
        if (f === "south") {
            const cu = q.fw / 2 - 0.5, cv = q.fh / 2 - 0.5;
            const rr = Math.min(cu, cv);
            const r = Math.hypot(q.u - cu, q.v - cv);
            if (r > rr - 0.3) return jit(mix(C.heat, C.steelDark, 0.35), -4);
            if (r > rr - 1.4) return jit(mix(C.heatGold, C.heat, 0.3), 3);      // 噴口の環
            let c = mix(C.black, C.steelDark, 0.4);
            c = mix(c, C.flameHot, clamp((rr - 2.0 - r) / 3, 0, 1) * 0.85);     // 奥の燃焼
            return jit(c, (hash(p.x, p.y, p.z) - 0.5) * 8);
        }
        const t = clamp((p.z - 22) / 8, 0, 1);
        let c = mix(C.steel, C.heat, 0.30 + 0.45 * t);
        if (mod(p.z, 3) === 0) c = mix(c, C.steelDark, 0.30);                   // 補強リング
        const band = vnoise(Math.abs(p.x), p.y, p.z * 2.2, 4);
        c = mix(c, band > 0.55 ? C.heatGold : C.heatBlue, t * 0.45 * band);      // 熱による虹色
        c = faceShade(c, f);
        return jit(edge(c, q, 0.26), (hash(p.x, p.y, p.z) - 0.5) * 9);
    },

    /* 噴炎。根元は白熱、後ろへ行くほど橙に薄れる。 */
    flame: (f, p, q) => {
        const t = clamp((p.z - 30) / 20, 0, 1);
        let c = mix(C.flameCore, C.flameHot, smooth(t));
        if (t < 0.25) c = mix(c, C.flameBlue, (0.25 - t) * 2.0);
        const n = hash(p.x * 3.3, p.y * 2.7, p.z * 1.9);
        if (n > 0.86) c = mix(c, C.flameCore, 0.5);     // ショックダイヤモンド風の明点
        return jit(c, (n - 0.5) * 22);
    },
};

// flat 指定の面が参照する単色パッチ(このモデルは全周が見えるので今は未使用)
const SWATCH = {
    skin: C.whiteDark, nose: C.whiteDark, nosetip: C.ablative, fin: C.whiteDark,
    raceway: C.grayDark, nozzle: C.steelDark, flame: C.flameHot,
};

/* ============================ モデル定義 ============================ */
const cubes = [];

function B(bone, x0, y0, z0, x1, y1, z1, mat, opts) {
    cubes.push(Object.assign({ bone, x0, y0, z0, x1, y1, z1, mat }, opts || {}));
}
/** 左右で別ボーンに置く版。x>0 側を渡す。 */
function BB2(boneR, boneL, x0, y0, z0, x1, y1, z1, mat, opts) {
    B(boneR, x0, y0, z0, x1, y1, z1, mat, opts);
    const o = Object.assign({}, opts || {});
    // 左右で「内側/外側」が入れ替わるので、east/west の flat 指定も入れ替える
    if (o.flat) o.flat = o.flat.map((f) => (f === "east" ? "west" : f === "west" ? "east" : f));
    B(boneL, -x1, y0, z0, -x0, y1, z1, mat, o);
}
/** x>0 側を渡すと同じボーンに左右対称で2個置く。 */
function BM(bone, x0, y0, z0, x1, y1, z1, mat, opts) {
    BB2(bone, bone, x0, y0, z0, x1, y1, z1, mat, opts);
}

/* ---- 弾頭(先端から4段でテーパー) ---- */
B("body", -1, 7, -34, 1,  9, -31, "nosetip");
B("body", -2, 6, -31, 2, 10, -28, "nose");
B("body", -3, 5, -28, 3, 11, -24, "nose");
B("body", -4, 4, -24, 4, 12, -19, "nose");

/*
 * ---- 胴体。断面は2つのキューブを直交させた八角形(x±5・y±6)。
 *      💡 内側で重なる面は外側のキューブに隠れるので Z ファイティングは起きない。
 *         幅と高さを入れ替えた2枚を必ずセットで置くこと(片方だけだと角張って見える)。 ----
 */
B("body", -5, 3, -19, 5, 13, -14, "nose");
B("body", -4, 2, -19, 4, 14, -14, "nose");
B("body", -5, 3, -14, 5, 13,  22, "skin");
B("body", -4, 2, -14, 4, 14,  22, "skin");

/* ---- 推進部の絞りと噴口 ---- */
B("body", -4, 4, 22, 4, 12, 26, "nozzle");
B("body", -5, 3, 26, 5, 13, 30, "nozzle");

/* ---- 背中のケーブルダクト ---- */
B("body", -2, 14, -2, 2, 15, 13, "raceway");

/* ---- 前部の安定翼(小さい十字) ---- */
BM("body",  5,  7, -12,  9,  9, -4, "fin");
B("body",  -1, 14, -12,  1, 18, -4, "fin");
B("body",  -1, -2, -12,  1,  2, -4, "fin");

/* ---- 尾翼(後退角付きの十字。4枚とも同じ形) ---- */
BM("body",  5,  7, 14, 10,  9, 26, "fin");
BM("body", 10,  7, 20, 14,  9, 26, "fin");
B("body",  -1, 14, 14,  1, 19, 26, "fin");
B("body",  -1, 19, 20,  1, 23, 26, "fin");
B("body",  -1, -3, 14,  1,  2, 26, "fin");
B("body",  -1, -7, 20,  1, -3, 26, "fin");

/* ---- 噴炎(scale アニメで脈動させる) ---- */
B("flame", -4, 4, 30, 4, 12, 38, "flame");
B("flame", -3, 5, 38, 3, 11, 45, "flame");
B("flame", -2, 6, 45, 2, 10, 50, "flame");

/*
 * ボーン階層 (name, parent, pivot[, rotation])。
 * 💡 flame の pivot は噴口の出口(z=30)。rotation ではなく scale で脈動させるので、
 *    ここを動かすと炎がノズルから離れる(gen_fighter.js の flame と同じ約束)。
 */
const BONES = [
    ["root", null, [0, 0, 0]],
    ["body", "root", [0, 8, 0]],
    ["flame", "body", [0, 8, 30]],
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
const bones = BONES.map(([name, parent, pivot, rotation]) => {
    const b = { name, pivot };
    if (parent) b.parent = parent;
    if (rotation) b.rotation = rotation;
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
            identifier: "geometry.civ.missile",
            texture_width: TW,
            texture_height: TH,
            visible_bounds_width: 6,
            visible_bounds_height: 3,
            visible_bounds_offset: [0, 0.5, 0],
        },
        bones,
    }],
};

fs.writeFileSync(path.join(RP, "models/entity/missile.geo.json"), JSON.stringify(geo, null, 2) + "\n");
fs.writeFileSync(path.join(RP, "textures/entity/missile.png"), png);
console.log("cubes=" + cubes.length + " faces=" + rects.length + " atlas=" + TW + "x" + TH + " png=" + png.length + "B");
