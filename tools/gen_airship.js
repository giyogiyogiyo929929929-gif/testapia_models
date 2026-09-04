"use strict";
/*
 * gen_airship.js -- civ:airship のモデル一式ジェネレータ
 *
 * 生成物:
 *   models/entity/airship.geo.json   ... 形状 + per-face UV
 *   textures/entity/airship.png      ... 上記UVに合わせて手続き的に描いたアトラス
 *
 * 使い方:  node tools/gen_airship.js       (このリソースパックのルートから)
 *
 * 設計方針:
 *   - 形状はこのファイル内の cube 定義がソース。Blockbench で開ける普通の geo を吐くが、
 *     UV はここが正なので、形をいじったら必ず再生成すること。
 *   - UV は box UV ではなく per-face UV(1.12.0+)。面ごとに 1テクセル=1モデル単位 で
 *     アトラスに詰めるので、テクスチャの解像度がモデル全体で一定になる。
 *   - 見えない面(セグメント同士の合わせ目など)や、はみ出した縁しか見えない面は
 *     flat 指定で 4x4 の単色パッチを共有し、アトラスを無駄遣いしない。
 *   - 塗りは「モデル空間の座標」を受け取って色を返す関数。船体の帯・国籍マークなどが
 *     面をまたいで繋がるように、左右対称・上下方向のみに依存する模様だけを使う
 *     (面のUV向きの取り違えで模様がズレないようにするため)。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const RP = path.resolve(__dirname, "..");

/* ============================ パレット ============================ */
const C = {
    fabric:     [0xC9, 0xB4, 0x8A], // 気嚢の外皮(ドープ塗装した布)
    fabricMid:  [0xB0, 0x9B, 0x74],
    fabricDark: [0x8E, 0x7B, 0x59],
    seam:       [0x76, 0x65, 0x47],
    olive:      [0x6E, 0x71, 0x45],
    oliveDark:  [0x4B, 0x4E, 0x2F],
    wood:       [0x6E, 0x4B, 0x30],
    woodDark:   [0x4F, 0x35, 0x21],
    woodLight:  [0x87, 0x5E, 0x3D],
    metal:      [0x4C, 0x51, 0x56],
    metalDark:  [0x2F, 0x33, 0x37],
    metalLight: [0x6B, 0x71, 0x78],
    steel:      [0x3A, 0x3D, 0x40],
    red:        [0xA8, 0x32, 0x26],
    redDark:    [0x74, 0x20, 0x17],
    glass:      [0x27, 0x46, 0x74],
    glassLite:  [0x50, 0x7C, 0xB4],
    brass:      [0xB0, 0x8A, 0x3C],
    white:      [0xD8, 0xD2, 0xC4],
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const jit = (c, n) => [clamp(c[0] + n, 0, 255), clamp(c[1] + n, 0, 255), clamp(c[2] + n, 0, 255)];
function hash(x, y, z) {
    const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return h - Math.floor(h);
}

/* 面ローカル座標でのパネル線・リベット・縁の暗さ */
function plate(c, q, period, lineAmt, rivet) {
    const { u, v, fw, fh } = q;
    if (u === 0 || v === 0 || u === fw - 1 || v === fh - 1) c = mix(c, C.metalDark, 0.30);
    if (period > 0) {
        if (u % period === 0 || v % period === 0) c = mix(c, C.metalDark, lineAmt);
        if (rivet && u % period === (period >> 1) && v % period === (period >> 1)) c = mix(c, C.metalLight, 0.55);
    }
    return c;
}

/* ============================ マテリアル ============================ */
/* (face, p={x,y,z}(モデル空間), q={u,v,fw,fh,cube}) -> [r,g,b] */

// 気嚢本体。上ほど明るく、下部にオリーブの帯、中央側面に国籍マーク。
function envelope(face, p, q, base) {
    const t = clamp((p.y - 20) / 38, 0, 1);
    let c = mix(base[1], base[0], 0.25 + 0.75 * t);
    if (face === "up") c = mix(c, C.white, 0.10);
    if (face === "down") c = mix(c, base[1], 0.40);
    // 下部の識別帯(側面・前後面のみ。上下面は y が一定なので自動的に外れる)
    if (p.y >= 25 && p.y < 26) c = mix(c, C.oliveDark, 0.55);
    else if (p.y >= 26 && p.y < 32) c = mix(c, C.olive, 0.85);
    else if (p.y >= 32 && p.y < 33) c = mix(c, C.oliveDark, 0.55);
    // 国籍マーク(胴中央の左右)。断面を帯に割った関係で一番幅広の帯にしか描けないので、
    // その帯(|x|>=19)の高さに収まる半径にしてある。
    if ((face === "east" || face === "west") && Math.abs(p.x) >= 19 && Math.abs(p.z) <= 9 && Math.abs(p.y - 39) <= 9) {
        const r = Math.hypot(p.z, p.y - 39);
        if (r < 2.8) c = C.red;
        else if (r < 4.7) c = C.white;
        else if (r < 6.8) c = C.red;
        else if (r < 7.6) c = mix(c, C.redDark, 0.6);
    }
    return jit(c, (hash(p.x * 0.7, p.y * 1.3, p.z * 0.9) - 0.5) * 9);
}

const MAT = {
    hull:      (f, p, q) => envelope(f, p, q, [C.fabric, C.fabricDark]),
    hullRed:   (f, p, q) => envelope(f, p, q, [C.red, C.redDark]),
    hullOlive: (f, p, q) => envelope(f, p, q, [C.olive, C.oliveDark]),

    // 気嚢を締める外周フレーム
    frame: (f, p, q) => jit(plate(mix(C.oliveDark, C.metal, 0.35), q, 4, 0.35, false), (hash(p.x, p.y, p.z) - 0.5) * 6),

    metal: (f, p, q) => {
        let c = C.metal;
        if (f === "up") c = mix(c, C.metalLight, 0.35);
        if (f === "down") c = mix(c, C.metalDark, 0.45);
        return jit(plate(c, q, 8, 0.45, true), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    // 上部甲板(グレーチング)
    deck: (f, p, q) => {
        let c = mix(C.metal, C.metalLight, 0.25);
        if (f === "up" && (q.u % 3 === 0 || q.v % 6 === 0)) c = mix(c, C.metalDark, 0.55);
        if (f === "down") c = mix(c, C.metalDark, 0.5);
        return jit(plate(c, q, 0, 0, false), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    steel: (f, p, q) => jit(plate(C.steel, q, 0, 0, false), (hash(p.x, p.y, p.z) - 0.5) * 7),

    // プロペラ。ハブ中心からの距離で先端に警戒色を入れる
    blade: (f, p, q) => {
        const hub = q.cube.hub || [0, 0];
        const r = Math.hypot(p.x - hub[0], p.y - hub[1]);
        let c = mix(C.metal, C.metalLight, 0.35);
        if (f === "north" || f === "south") c = mix(c, C.metalLight, 0.45);
        if (r > 11.5) c = mix(C.brass, C.white, 0.30);
        return jit(c, (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    // 木製ゴンドラ。板目は側面/前後面では横方向、上下面では前後方向に走らせる
    wood: (f, p, q) => {
        const line = (f === "up" || f === "down") ? q.u : q.v;
        const plank = Math.floor(line / 4);
        let c = mix(C.wood, hash(plank, 7, 3) > 0.5 ? C.woodLight : C.woodDark, 0.30 * hash(plank, 1, 9));
        if (line % 4 === 0) c = mix(c, C.woodDark, 0.65);
        if (f === "up") c = mix(c, C.woodLight, 0.20);
        if (f === "down") c = mix(c, C.woodDark, 0.35);
        return jit(plate(c, q, 0, 0, false), (hash(p.x, p.y, p.z) - 0.5) * 7);
    },

    glass: (f, p, q) => {
        const { u, v, fw, fh } = q;
        // 枠
        if (u < 1 || v < 1 || u > fw - 2 || v > fh - 2) return MAT.metal(f, p, q);
        if (u % 8 === 0) return mix(C.metalDark, C.metal, 0.4);
        let c = C.glass;
        if ((u - v + 64) % 14 < 3) c = mix(c, C.glassLite, 0.55); // 斜めのハイライト
        if (v <= 1) c = mix(c, C.glassLite, 0.25);
        return jit(c, (hash(p.x, p.y, p.z) - 0.5) * 6);
    },

    red:   (f, p, q) => jit(plate(C.red, q, 8, 0.35, true), (hash(p.x, p.y, p.z) - 0.5) * 8),
    brass: (f, p, q) => jit(plate(C.brass, q, 4, 0.30, false), (hash(p.x, p.y, p.z) - 0.5) * 8),

    // 尾翼。オリーブ地に前縁の金属補強
    fin: (f, p, q) => {
        let c = mix(C.olive, C.oliveDark, 0.25);
        if (f === "up") c = mix(c, C.white, 0.08);
        if (f === "down") c = mix(c, C.oliveDark, 0.35);
        if (q.u < 2) c = mix(c, C.metal, 0.55);
        return jit(plate(c, q, 6, 0.25, false), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },
};

// flat 指定の面が参照する 4x4 単色パッチの色
const SWATCH = {
    hull: C.fabricDark, hullRed: C.redDark, hullOlive: C.oliveDark,
    frame: mix(C.oliveDark, C.metal, 0.35), metal: C.metal, deck: C.metal,
    steel: C.steel, blade: C.steel, wood: C.woodDark, glass: C.metalDark,
    red: C.redDark, brass: C.brass, fin: C.oliveDark,
};

/* ============================ モデル定義 ============================ */
/*
 * 座標系: 16単位 = 1ブロック。機首は -Z、上が +Y。
 * 気嚢の中心高さ YC=39、全長 z=-92..88(約11.3ブロック)、翼端間 x=±49。
 * ゴンドラ底面が y=0 になるよう全体を持ち上げてあるので、地面に置いても埋まらない。
 */
const YC = 39;
const cubes = [];

function B(bone, x0, y0, z0, x1, y1, z1, mat, opts) {
    cubes.push(Object.assign({ bone, x0, y0, z0, x1, y1, z1, mat }, opts || {}));
}
/** x>0 側を渡すと左右対称に2個置く。hub など x を持つオプションも反転する。 */
function BM(bone, x0, y0, z0, x1, y1, z1, mat, opts) {
    B(bone, x0, y0, z0, x1, y1, z1, mat, opts);
    const o = Object.assign({}, opts || {});
    if (o.hub) o.hub = [-o.hub[0], o.hub[1]];
    B(bone, -x1, y0, z0, -x0, y1, z1, mat, o);
}

/* ---- 気嚢: 前後に絞り込んだ9セグメント。
       各セグメントは高さ方向に帯へ分割し、上下ほど細くして断面を八角形に近づける
       (真四角のままだと正面から見たときに「ただの箱」に見えてしまうため) ---- */
const SEG = [
    [-80, -72, 10, 10, "hullRed"],
    [-72, -60, 18, 18, "hullRed"],
    [-60, -44, 26, 26, "hull"],
    [-44, -24, 34, 32, "hull"],
    [-24,  24, 40, 38, "hull"],
    [ 24,  44, 34, 32, "hull"],
    [ 44,  60, 26, 26, "hull"],
    [ 60,  72, 18, 18, "hullOlive"],
    [ 72,  80, 10, 10, "hullOlive"],
];
// 断面の帯: [下端の高さ割合, 上端の高さ割合, 半幅の割合]
const BANDS_5 = [[0, 0.13, 0.50], [0.13, 0.30, 0.80], [0.30, 0.70, 1.00], [0.70, 0.87, 0.80], [0.87, 1, 0.50]];
const BANDS_3 = [[0, 0.24, 0.68], [0.24, 0.76, 1.00], [0.76, 1, 0.68]];
const BANDS_1 = [[0, 1, 1.00]];

/** 断面 (w,h) を帯に割り、[半幅, y下端, y上端] の配列にする。grow は外周フレーム用の膨らみ。 */
function section(w, h, grow) {
    const y0 = YC - h / 2;
    const bands = h >= 30 ? BANDS_5 : h >= 18 ? BANDS_3 : BANDS_1;
    const out = [];
    for (const [a, b, f] of bands) {
        const ya = Math.round(y0 + h * a) - (a === 0 ? grow : 0);
        const yb = Math.round(y0 + h * b) + (b === 1 ? grow : 0);
        if (yb > ya) out.push([Math.round((w / 2) * f) + grow, ya, yb]);
    }
    return out;
}

/** 隣のセグメントの断面が矩形 (±hx, ya..yb) を完全に覆うか(=その面が見えないか) */
function covered(seg, hx, ya, yb) {
    if (!seg) return false;
    const sec = section(seg[2], seg[3], 0);
    for (let y = ya; y < yb; y++) {
        let m = 0;
        for (const [h2, a2, b2] of sec) if (y + 0.5 >= a2 && y + 0.5 < b2 && h2 > m) m = h2;
        if (m < hx) return false;
    }
    return true;
}

SEG.forEach((s, i) => {
    const [z0, z1, w, h, mat] = s;
    for (const [hx, ya, yb] of section(w, h, 0)) {
        const flat = [];
        if (covered(SEG[i - 1], hx, ya, yb)) flat.push("north");
        if (covered(SEG[i + 1], hx, ya, yb)) flat.push("south");
        B("hull", -hx, ya, z0, hx, yb, z1, mat, { flat });
    }
});

/* ---- 気嚢を締める外周フレーム(中身は気嚢に埋まり、1単位はみ出した縁だけが見える) ---- */
[[-54, 2], [-38, 3], [-17, 4], [15, 4], [36, 5], [52, 6]].forEach(([z, si]) => {
    const s = SEG[si];
    for (const [hx, ya, yb] of section(s[2], s[3], 1)) {
        B("hull", -hx, ya, z, hx, yb, z + 2, "frame", { flat: ["north", "south"] });
    }
});

/* ---- 機首・係留マスト ---- */
B("hull", -3, 36, -86, 3, 42, -80, "red");
B("hull", -1, 38, -92, 1, 40, -86, "brass");

/* ---- 上部甲板と連装砲 ---- */
B("hull", -6, 58, -20, 6, 60, 20, "deck");
BM("hull", 5, 60, -20, 6, 63, 20, "metal");
B("hull", -5, 60, -15, 5, 66, -5, "metal");
B("hull", -2, 62, -23, 2, 65, -15, "steel");
B("hull", -5, 60, 5, 5, 66, 15, "metal");
B("hull", -2, 62, 15, 2, 65, 23, "steel");

/* ---- 竜骨と爆弾倉 ---- */
B("hull", -5, 18, -24, 5, 20, 24, "metal");
B("hull", -7, 16, -14, 7, 18, 14, "metal");

/* ---- 尾翼(十字配置。後端の可動面は別ボーン) ---- */
B("hull", -2, 48, 46, 2, 62, 66, "fin");
B("hull", -2, 44, 66, 2, 58, 78, "fin");
B("hull", -2, 16, 46, 2, 30, 66, "fin");
B("hull", -2, 20, 66, 2, 34, 78, "fin");
BM("hull", 8, 37, 46, 30, 41, 66, "fin");
BM("hull", 8, 37, 66, 26, 41, 78, "fin");

/* ---- エンジンナセル(前後2対) ---- */
[["fore", -34, -10, -40, -34, -24, -14, -10, -6],
 ["aft",    8,  32,  32,  38,  14,  24,   4,  8]].forEach(([, bz0, bz1, cz0, cz1, sz0, sz1, ez0, ez1]) => {
    BM("hull", 27, 32, bz0, 39, 44, bz1, "metal");  // 胴体
    BM("hull", 29, 34, cz0, 37, 42, cz1, "metal");  // 整形カウル
    BM("hull", 20, 36, sz0, 27, 42, sz1, "metal");  // 気嚢とを繋ぐ支柱
    BM("hull", 29, 33, ez0, 37, 41, ez1, "steel");  // 排気端
});


/* ---- 4基のプロペラ。前(prop1/2)は牽引式、後(prop3/4)は推進式 ---- */
const PROPS = [
    ["prop1",  1, -41, -1],
    ["prop2", -1, -41, -1],
    ["prop3",  1,  39,  1],
    ["prop4", -1,  39,  1],
];
PROPS.forEach(([bone, sx, zh, dir]) => {
    const hubZ  = dir < 0 ? [zh + 1, zh + 5] : [zh - 5, zh - 1];
    const spinZ = dir < 0 ? [zh - 4, zh - 1] : [zh + 1, zh + 4];
    const bl = zh - 1, bh = zh + 1;
    const X = (a, b) => (sx > 0 ? [a, b] : [-b, -a]);
    const hub = [sx * 33, 38];
    let [x0, x1] = X(30, 36); B(bone, x0, 35, hubZ[0], x1, 41, hubZ[1], "steel");
    [x0, x1] = X(31, 36 - 1); B(bone, x0, 36, spinZ[0], x1, 40, spinZ[1], "steel");
    [x0, x1] = X(31, 35);     B(bone, x0, 24, bl, x1, 52, bh, "blade", { hub });
    [x0, x1] = X(19, 47);     B(bone, x0, 36, bl, x1, 40, bh, "blade", { hub });
});

/* ---- ゴンドラ(操縦室)。気嚢から4本の支柱で吊り下げる ---- */
B("gondola", -9, 12, -30, 9, 14, 4, "metal");    // 屋根
B("gondola", -9, 8, -30, 9, 12, -28, "wood");    // 窓枠(前)
B("gondola", -9, 8, -28, 9, 12, 2, "glass");     // 側面窓
B("gondola", -9, 8, 2, 9, 12, 4, "wood");        // 窓枠(後)
B("gondola", -9, 2, -30, 9, 8, 4, "wood");       // 船体
B("gondola", -10, 0, -28, 10, 2, 2, "metal");    // 床
B("gondola", -6, 2, -36, 6, 10, -30, "wood");    // 艦首
B("gondola", -4, 4, -38, 4, 8, -36, "red");      // 艦首の当て板
B("gondola", -6, 4, 4, 6, 10, 10, "wood");       // 艦尾
BM("gondola", 9, 0, -24, 12, 2, -2, "metal");    // 着艦スキッド
BM("gondola", 9, 4, -16, 13, 8, -8, "metal");    // 舷側砲座
BM("gondola", 10, 5, -24, 12, 7, -16, "steel");  // 砲身
BM("gondola", 6, 14, -26, 8, 20, -24, "metal");  // 吊り支柱
BM("gondola", 6, 14, -2, 8, 20, 0, "metal");

/* ---- 可動する操縦翼面 ---- */
B("rudder", -2, 46, 78, 2, 58, 88, "fin");
B("rudder", -2, 20, 78, 2, 32, 88, "fin");
B("elev_r", 8, 37, 78, 26, 41, 86, "fin");
B("elev_l", -26, 37, 78, -8, 41, 86, "fin");

/* ---- 軍旗 ---- */
B("flag", -1, 60, 17, 1, 76, 19, "metal");
B("flag", 0, 64, 19, 1, 72, 30, "red");

/* ボーン階層 (name, parent, pivot) */
const BONES = [
    ["root", null, [0, 0, 0]],
    ["hull", "root", [0, YC, 0]],
    ["gondola", "hull", [0, 14, -14]],
    ["rudder", "hull", [0, YC, 78]],
    ["elev_r", "hull", [16, YC, 78]],
    ["elev_l", "hull", [-16, YC, 78]],
    ["flag", "hull", [0, 60, 18]],
    ["prop1", "hull", [33, 38, -41]],
    ["prop2", "hull", [-33, 38, -41]],
    ["prop3", "hull", [33, 38, 39]],
    ["prop4", "hull", [-33, 38, 39]],
];

/* ============================ 面の定義とUVパッキング ============================ */
/*
 * 各面について「テクスチャ上の画素(u,v) -> モデル空間の点」を返す関数を持たせる。
 * これがあるおかげで、船体の帯や国籍マークを面をまたいで連続させられる。
 */
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

// 詰めるべき矩形を集める
const rects = [];
const swatches = new Map(); // mat -> rect
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

/** 棚詰め。指定幅で詰めたときの高さを返す(rectに x,y を書き込む) */
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
for (const W of [128, 256, 512, 1024]) {
    const H = shelfPack(order, W, 1);
    if (!isFinite(H) || H > 1024) continue;
    // 面積優先。ただし極端な縦長は扱いづらいので正方形に近いものを少し優遇する
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
for (const [name] of BONES) if (!byBone.has(name) && name !== "root") { /* キューブ無しのボーンも許容 */ }
for (const bone of byBone.keys()) if (!BONES.some(([n]) => n === bone)) throw new Error("階層に無いボーン: " + bone);

const geo = {
    format_version: "1.16.0",
    "minecraft:geometry": [{
        description: {
            identifier: "geometry.civ.airship",
            texture_width: TW,
            texture_height: TH,
            visible_bounds_width: 12,
            visible_bounds_height: 5.5,
            visible_bounds_offset: [0, 2.5, 0],
        },
        bones,
    }],
};

fs.writeFileSync(path.join(RP, "models/entity/airship.geo.json"), JSON.stringify(geo, null, 2) + "\n");
fs.writeFileSync(path.join(RP, "textures/entity/airship.png"), png);
console.log(`cubes=${cubes.length} faces=${rects.length} atlas=${TW}x${TH} png=${png.length}B`);
