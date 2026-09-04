"use strict";
/*
 * gen_dreadnought.js -- civ:dreadnought(戦艦)のモデル一式ジェネレータ
 *
 * 生成物:
 *   models/entity/dreadnought.geo.json  ... 形状 + per-face UV
 *   textures/entity/dreadnought.png     ... 上記UVに合わせて手続き的に描いたアトラス
 *
 * 使い方:  node tools/gen_dreadnought.js      (このリソースパックのルートから)
 *
 * 設計方針(gen_tank.js / gen_airship.js / gen_fighter.js と同じ):
 *   - 形状はこのファイル内の cube 定義がソース。Blockbench で開ける普通の geo を吐くが、
 *     UV はここが正なので、形をいじったら必ず再生成すること。
 *   - UV は box UV ではなく per-face UV。面ごとに 1テクセル=1モデル単位。
 *   - 塗りはモデル空間の座標を受け取る関数。喫水線・外板の継ぎ目・舷窓が面をまたいで
 *     繋がるように、左右対称(|x| 依存)の模様だけを使う。
 *
 * 座標系: 16単位 = 1ブロック。艦首は -Z 方向(scripts/unitModels.js の yawTowards が
 *   yaw=0 で -Z を向く前提)。全長 z=-56..56(7ブロック)、最大幅 x=±13(1.6ブロック)、
 *   前檣楼の頂点 y=48。
 *
 * 💡 【y=0 が喫水線】
 *   海軍ユニットは水タイルに置かれ、unitModels.js の findGroundY が「最初の非空気ブロックの
 *   1つ上」を返すため、モデルの y=0 がちょうど水面の高さに来る。そこで
 *     y <  0 : 水中(防汚塗料の赤。実際には水ブロックに沈むので普段は見えない)
 *     y 0..2 : ブートトッピング(喫水線の黒帯)
 *     y >  2 : 乾舷(艦体グレー)
 *   という塗り分けにしてある。船体の底(y=-6)を上げ下げすると喫水が変わって見えるので、
 *   船体キューブの y0 を触るときはこの前提ごと見直すこと。
 *
 * 💡 【下面は塗らない】
 *   戦闘機と違い船底は常に水中なので、船体・甲板室の down 面は flat(単色パッチ)にして
 *   アトラスを節約している。逆に上面(甲板)は真上から見られるので作り込む。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const RP = path.resolve(__dirname, "..");

/* ============================ パレット ============================ */
const C = {
    hull:       [0x6E, 0x76, 0x7E], // 艦体グレー(乾舷)
    hullDark:   [0x54, 0x5B, 0x63],
    hullLight:  [0x8C, 0x95, 0x9E],
    superGray:  [0x7C, 0x84, 0x8D], // 甲板室は艦体より少し明るい
    superDark:  [0x5C, 0x63, 0x6B],
    armor:      [0x5A, 0x61, 0x69], // 砲塔の装甲(艦体より暗い)
    armorDark:  [0x3C, 0x42, 0x48],
    armorLight: [0x7A, 0x82, 0x8A],
    boot:       [0x24, 0x26, 0x2A], // 喫水線の黒帯(ブートトッピング)
    antifoul:   [0x7E, 0x35, 0x2C], // 船底の防汚塗料
    antifoulDk: [0x59, 0x23, 0x1C],
    teak:       [0xA9, 0x8C, 0x5F], // 木甲板
    teakDark:   [0x8B, 0x71, 0x49],
    teakSeam:   [0x5C, 0x4A, 0x2F],
    steel:      [0x50, 0x56, 0x5C],
    steelDark:  [0x2C, 0x30, 0x34],
    steelLight: [0x82, 0x8A, 0x92],
    rust:       [0x8A, 0x5A, 0x36],
    soot:       [0x2A, 0x28, 0x26],
    black:      [0x1B, 0x1D, 0x20],
    white:      [0xD6, 0xD2, 0xC8],
    red:        [0xA8, 0x32, 0x26],
    redDark:    [0x74, 0x20, 0x17],
    glass:      [0x1E, 0x2A, 0x38], // 艦橋の窓
    glassLite:  [0x5E, 0x84, 0xA6],
    brass:      [0xB0, 0x8A, 0x44], // 舷窓の真鍮枠
    canvas:     [0xC0, 0xB6, 0x9E], // 内火艇の帆布カバー
    canvasDk:   [0x8E, 0x86, 0x70],
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
    if (u === 0 || v === 0 || u === fw - 1 || v === fh - 1) return mix(c, C.steelDark, amt);
    return c;
}

/* 面の向きによる明暗。上面は明るく、下面と後面は暗く。 */
function faceShade(c, f) {
    if (f === "up") return mix(c, C.white, 0.09);
    if (f === "down") return mix(c, C.black, 0.12);
    if (f === "south") return mix(c, C.black, 0.10);
    return c;
}

/* ============================ 塗りの部品 ============================ */

/* 外板の継ぎ目。横方向の条(ストレーキ)と、Z方向の突き合わせ継手・鋲。 */
function plating(c, p, f) {
    const y = Math.round(p.y), z = Math.round(p.z), x = Math.round(Math.abs(p.x));
    if (f === "east" || f === "west") {
        if (mod(y, 4) === 0) c = mix(c, C.steelDark, 0.26);   // 条の重ね継ぎ
        if (mod(z, 13) === 0) c = mix(c, C.steelDark, 0.20);  // 突き合わせ継手
        if (mod(y, 4) === 1 && mod(z, 3) === 0) c = mix(c, C.steelLight, 0.16); // 鋲列
    } else {
        if (mod(z, 13) === 0) c = mix(c, C.steelDark, 0.20);
        if (mod(x, 5) === 0) c = mix(c, C.steelDark, 0.14);
    }
    return c;
}

/* 舷窓(真鍮枠の丸窓)。舷側の一列だけに入れる。 */
function portholes(c, p, f) {
    if (f !== "east" && f !== "west") return c;
    if (Math.round(p.y) !== 6) return c;
    if (p.z < -46 || p.z > 46) return c;                       // 艦首尾の細い所には開けない
    if (mod(p.z, 7) !== 0) return c;
    return mix(C.black, C.brass, 0.38);
}

/* 喫水標(艦首尾の舷側に入る白い目盛り)。赤い船底の上にも続く。 */
function draftMarks(c, p, f) {
    if (f !== "east" && f !== "west") return c;
    if (p.z > -50 && p.z < 50) return c;
    if (p.y < -2 || p.y > 8) return c;
    if (mod(p.y, 3) !== 0) return c;
    return mix(c, C.white, 0.42);
}

/* 舷側を垂れる錆。舷窓や錨のあたりから下へ流れる。 */
function rustStreak(c, p, f) {
    if (f !== "east" && f !== "west") return c;
    const n = vnoise(p.z * 3.2, p.y * 0.30, 0, 4);
    if (n > 0.70) return mix(c, C.rust, (n - 0.70) * 1.5);
    return c;
}

/* 木甲板。板は艦首尾方向(Z)に走り、2単位ごとに継ぎ目が入る。 */
function deckPlank(p, q) {
    const x = Math.round(Math.abs(p.x));
    let c = mix(C.teak, C.teakDark, 0.30 + 0.35 * vnoise(p.x * 3.0, p.y, p.z * 0.55, 6));
    if (mod(x, 2) === 0) c = mix(c, C.teakSeam, 0.50);          // 板の合わせ目
    if (mod(p.z, 19) === 0) c = mix(c, C.teakSeam, 0.30);       // 木口の継ぎ
    // 艦首の錨甲板と艦尾は鋼板張り(木を張らない)
    if (p.z < -42 || p.z > 50) c = mix(C.steel, C.steelDark, 0.25 + 0.3 * vnoise(p.x, p.y, p.z, 5));
    // 中心線の通路。摩耗して明るい
    if (x <= 1) c = mix(c, C.teakDark, 0.35);
    return jit(edge(c, q, 0.16), (hash(p.x * 1.3, p.y, p.z * 0.9) - 0.5) * 9);
}

/* ============================ マテリアル ============================ */
/* (face, p={x,y,z}(モデル空間), q={u,v,fw,fh,cube}) -> [r,g,b] */

const MAT = {
    /*
     * 船体。上面は木甲板、それ以外は喫水線で3段に塗り分ける。
     *   y<0 防汚塗料の赤 / y 0..2 黒帯 / y>2 艦体グレー
     */
    hull: (f, p, q) => {
        if (f === "up") return deckPlank(p, q);
        let c;
        if (p.y < 0) {
            c = mix(C.antifoul, C.antifoulDk, 0.25 + 0.45 * vnoise(p.x, p.y * 2, p.z, 7));
        } else if (p.y < 2) {
            c = mix(C.boot, C.black, 0.30 * vnoise(p.x, p.y, p.z, 4));
        } else {
            c = mix(C.hull, C.hullDark, 0.12 + 0.30 * vnoise(p.x * 0.8, p.y * 0.6, p.z * 0.7, 15));
            c = plating(c, p, f);
            c = portholes(c, p, f);
            c = rustStreak(c, p, f);
            if (hash(p.x * 2.1, p.y * 1.9, p.z * 3.3) > 0.991) c = mix(c, C.steelLight, 0.35); // 塗装剥がれ
        }
        c = draftMarks(c, p, f);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.20), (hash(p.x * 0.9, p.y * 1.1, p.z * 0.7) - 0.5) * 8);
    },

    /*
     * 甲板室・艦橋。舷窓ではなく角窓が帯状に並ぶ。
     * 窓の高さ帯(y 12..14 = 下段、y 18..21 = 艦橋)はキューブ配置と対応しているので、
     * 甲板室の高さを変えたらここも直すこと。
     */
    deckhouse: (f, p, q) => {
        let c = mix(C.superGray, C.superDark, 0.15 + 0.30 * vnoise(p.x, p.y * 0.7, p.z, 11));
        if (f === "up") {
            c = mix(c, C.steelLight, 0.12);
            if (mod(p.z, 3) === 0) c = mix(c, C.steelDark, 0.18);   // 滑り止めの縞鋼板
        } else if (f !== "down") {
            const along = (f === "north" || f === "south") ? p.x : p.z;
            const band = (p.y >= 12 && p.y <= 14) || (p.y >= 18 && p.y <= 21);
            if (band) {
                c = mod(along, 3) === 0 ? mix(C.superDark, C.black, 0.45) : mix(C.glass, C.glassLite, 0.18);
            }
            if (mod(p.y, 6) === 0) c = mix(c, C.steelDark, 0.20);    // 甲板の段
            if (mod(along, 9) === 0) c = mix(c, C.steelDark, 0.16);
            c = rustStreak(c, p, f);
        }
        c = faceShade(c, f);
        return jit(edge(c, q, 0.24), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    /* 煙突。上へ行くほど煤けて黒くなる。 */
    funnel: (f, p, q) => {
        let c = mix(C.superGray, C.superDark, 0.25 + 0.25 * vnoise(p.x, p.y, p.z, 8));
        if (mod(p.y, 5) === 0) c = mix(c, C.steelDark, 0.28);        // 補強リング
        if ((f === "east" || f === "west") && mod(p.z, 4) === 0) c = mix(c, C.steelDark, 0.16);
        const t = clamp((p.y - 14) / 14, 0, 1);                       // 上ほど煤
        c = mix(c, C.soot, t * t * 0.55);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.22), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    /*
     * 煙突の頂部(黒の帽子)と煙路の口。up 面は同心の縁と火の粉除けの格子を描いて
     * 「奥に穴が空いている」ように見せる(gen_fighter.js のノズルと同じ考え方)。
     */
    funnelcap: (f, p, q) => {
        if (f === "up") {
            const cu = q.fw / 2 - 0.5, cv = q.fh / 2 - 0.5;
            const rr = Math.min(cu, cv);
            const r = Math.hypot(q.u - cu, (q.v - cv) * (cu / Math.max(0.5, cv)));
            if (r > rr - 0.4) return jit(mix(C.black, C.steelDark, 0.45), -4);       // 口縁
            let c = mix(C.steelDark, C.black, 0.45);
            if ((q.u + q.v) % 2 === 0) c = mix(c, C.steelLight, 0.32);               // 火の粉除けの格子
            return jit(c, (hash(p.x, p.y, p.z) - 0.5) * 7);
        }
        let c = mix(C.black, C.steelDark, 0.30 + 0.25 * vnoise(p.x, p.y, p.z, 5));
        c = faceShade(c, f);
        return jit(edge(c, q, 0.25), (hash(p.x, p.y, p.z) - 0.5) * 7);
    },

    /* 砲塔・バーベット。装甲板の継ぎ目と鋲、天蓋の識別帯。 */
    turret: (f, p, q) => {
        let c = mix(C.armor, C.armorDark, 0.15 + 0.30 * vnoise(p.x, p.y, p.z, 9));
        if (f === "up") {
            c = mix(c, C.armorLight, 0.10);
            // 天蓋の識別帯(上空から見分けるための赤白)。艦首側の砲塔ほど前寄りに入る
            if (mod(p.z, 6) === 0) c = mix(c, C.redDark, 0.45);
            if (mod(p.z, 6) === 3) c = mix(c, C.white, 0.22);
        } else {
            if (mod(p.y, 3) === 0) c = mix(c, C.armorDark, 0.22);        // 装甲板の継ぎ目
            if (mod(p.y, 3) === 1 && mod(p.z, 2) === 0) c = mix(c, C.armorLight, 0.14); // 鋲
            c = rustStreak(c, p, f);
        }
        c = faceShade(c, f);
        return jit(edge(c, q, 0.26), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    /* 主砲身(前後方向)。北面・南面が砲口。 */
    gun: (f, p, q) => bore(f, p, q, f === "north" || f === "south"),
    /* 副砲(舷側のケースメイト。左右方向)。東面・西面が砲口。 */
    gunx: (f, p, q) => bore(f, p, q, f === "east" || f === "west"),

    /* 檣(マスト)・見張所。細い鋼材なので明るめ。 */
    mast: (f, p, q) => {
        let c = mix(C.steelLight, C.steel, 0.35 + 0.30 * vnoise(p.x, p.y, p.z, 6));
        if (mod(p.y, 4) === 0) c = mix(c, C.steelDark, 0.28);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.30), (hash(p.x, p.y, p.z) - 0.5) * 9);
    },

    /* 通風筒・錨など、艦体に付く小物の鋼材。 */
    steel: (f, p, q) => {
        let c = mix(C.steel, C.steelDark, 0.25 + 0.30 * vnoise(p.x, p.y, p.z, 5));
        if (mod(p.y, 3) === 0) c = mix(c, C.steelLight, 0.16);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.30), (hash(p.x, p.y, p.z) - 0.5) * 9);
    },

    /* 内火艇(帆布カバーを掛けた状態)。 */
    boat: (f, p, q) => {
        let c = mix(C.canvas, C.canvasDk, 0.25 + 0.35 * vnoise(p.x * 2, p.y, p.z, 4));
        if (f === "up" && mod(p.z, 3) === 0) c = mix(c, C.canvasDk, 0.35);  // カバーの畝
        if (p.y < 14) c = mix(C.steel, C.steelDark, 0.3);                    // 艇台
        c = faceShade(c, f);
        return jit(edge(c, q, 0.26), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },
};

/**
 * 砲身の共通塗り。muzzle が true の面には同心の砲口を描き、それ以外は
 * 先端(砲口側)ほど焼けて暗い鋼として塗る。
 */
function bore(f, p, q, muzzle) {
    if (muzzle) {
        const cu = q.fw / 2 - 0.5, cv = q.fh / 2 - 0.5;
        const rr = Math.min(cu, cv);
        const r = Math.hypot(q.u - cu, q.v - cv);
        if (r > rr - 0.3) return jit(mix(C.steel, C.steelDark, 0.4), -4);
        if (r > rr - 1.2) return jit(mix(C.steelLight, C.steel, 0.4), 2);   // 砲口の環
        return jit(mix(C.black, C.steelDark, 0.25), (hash(p.x, p.y, p.z) - 0.5) * 6);
    }
    let c = mix(C.steel, C.steelDark, 0.30 + 0.25 * vnoise(p.x, p.y, p.z, 6));
    // 砲身の中程に見える砲尾側の太い部分(尾栓覆い)
    if (mod(p.z, 9) === 0 || mod(p.x, 9) === 0) c = mix(c, C.steelLight, 0.18);
    c = faceShade(c, f);
    return jit(edge(c, q, 0.30), (hash(p.x, p.y, p.z) - 0.5) * 8);
}

// flat 指定の面が参照する単色パッチ(見えない面。船体・甲板室の下面など)
const SWATCH = {
    hull: C.antifoulDk, deckhouse: C.superDark, funnel: C.superDark, funnelcap: C.black,
    turret: C.armorDark, gun: C.steelDark, gunx: C.steelDark, mast: C.steel,
    steel: C.steelDark, boat: C.canvasDk,
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

/* ---- 船体。艦首(-Z)から艦尾(+Z)へ、幅と甲板の高さを段階的に変える。
       甲板の高さ(y1)が艦首で高く中央で低いのがシア(反り)。
       💡 段が付くのは承知の上(ブロック調のモデルなので、滑らかにするより
          段でシアを表現したほうが遠目のシルエットが締まる)。 ---- */
B("hull", -3, -3, -56,  3, 15, -50, "hull", { flat: ["down"] });  // 艦首材(ステム)
B("hull", -6, -4, -50,  6, 14, -42, "hull", { flat: ["down"] });
B("hull", -9, -5, -42,  9, 13, -32, "hull", { flat: ["down"] });
B("hull", -11, -6, -32, 11, 12, -18, "hull", { flat: ["down"] });
B("hull", -13, -6, -18, 13, 11,  14, "hull", { flat: ["down"] });  // 中央部(平行部)
B("hull", -12, -6,  14, 12, 11,  30, "hull", { flat: ["down"] });
B("hull", -10, -5,  30, 10, 11,  40, "hull", { flat: ["down"] });
B("hull",  -7, -4,  40,  7, 11,  49, "hull", { flat: ["down"] });
B("hull",  -4, -3,  49,  4, 11,  56, "hull", { flat: ["down"] });  // 艦尾

/* ---- 艦首の防波板(A砲塔の前に立てる波よけ) ---- */
B("hull", -9, 13, -36, 9, 15, -34, "hull", { flat: ["down"] });

/* ---- 錨(艦首の舷側に抱かせる) ---- */
BM("hull", 6, 6, -49, 7, 11, -45, "steel", { flat: ["west"] });

/* ---- 副砲(舷側の張り出し + 短い砲身) ---- */
BM("hull", 13, 4, -10, 15, 9, -4, "deckhouse", { flat: ["west"] });
BM("hull", 15, 6,  -8, 18, 8, -6, "gunx");
BM("hull", 13, 4,   0, 15, 9,  6, "deckhouse", { flat: ["west"] });
BM("hull", 15, 6,   2, 18, 8,  4, "gunx");
BM("hull", 12, 4,  16, 14, 9, 22, "deckhouse", { flat: ["west"] });
BM("hull", 14, 6,  18, 17, 8, 20, "gunx");

/* ---- 副砲塔(煙突の外側、上甲板上) ---- */
BM("hull",  8, 11,  6, 12, 14, 10, "turret");
BM("hull",  8, 11, 20, 12, 14, 24, "turret");

/* ---- 通風筒(甲板室の脇) ---- */
BM("hull", 6, 11, -2, 8, 15, 0, "steel");

/*
 * ---- 主砲塔 4基(A/B 前部背負い式、X/Y 後部背負い式) ----
 * 各砲塔は自分のボーンに入れて旋回できるようにしてある。
 * バーベットは甲板(y=11〜13)より2単位下から始めて船体に埋め、
 * 甲板の上面と底面が同一平面で重なる(Zファイティング)のを避けている。
 */
/* A砲塔(前部下段) */
B("turret_a", -7,  9, -32,  7, 15, -24, "turret", { flat: ["down"] });   // バーベット
B("turret_a", -8, 15, -33,  8, 21, -23, "turret");                       // 砲塔
BM("turret_a", 3, 21, -31,  6, 22, -27, "turret");                       // 照準用の張り出し
BM("turret_a", 1, 17, -45,  4, 19, -32, "gun");                          // 砲身

/* B砲塔(前部上段。A砲塔の上を越して撃つ) */
B("turret_b", -7,  9, -22,  7, 19, -14, "turret", { flat: ["down"] });
B("turret_b", -8, 19, -23,  8, 26, -13, "turret");
BM("turret_b", 3, 26, -21,  6, 27, -17, "turret");
BM("turret_b", 1, 22, -35,  4, 24, -22, "gun");

/* X砲塔(後部上段。Y砲塔の上を越して後方へ撃つ) */
B("turret_x", -7,  9, 32,  7, 18, 40, "turret", { flat: ["down"] });
B("turret_x", -8, 18, 31,  8, 25, 41, "turret");
BM("turret_x", 3, 25, 34,  6, 26, 38, "turret");
BM("turret_x", 1, 22, 40,  4, 24, 54, "gun");

/* Y砲塔(後部下段) */
B("turret_y", -6,  9, 43,  6, 15, 51, "turret", { flat: ["down"] });
B("turret_y", -7, 15, 42,  7, 21, 52, "turret");
BM("turret_y", 2, 21, 45,  5, 22, 49, "turret");
BM("turret_y", 1, 17, 51,  4, 19, 60, "gun");

/* ---- 前部甲板室 → 艦橋 → 司令塔 ---- */
B("super", -9,  9, -11, 9, 17,  3, "deckhouse", { flat: ["down"] });
B("super", -7, 17,  -9, 7, 23, -1, "deckhouse");                        // 艦橋
BM("super", 7, 20,  -9, 11, 22, -3, "deckhouse");                       // 張り出した艦橋ウイング
B("super", -5, 23,  -7, 5, 27, -3, "deckhouse");                        // 司令塔(装甲)

/* ---- 測距儀(方位盤)。ゆっくり旋回させるため専用ボーン ---- */
B("director", -4, 27, -8, 4, 31, -2, "steel");
BM("director", 4, 28, -6, 7, 30, -4, "steel");                          // 測距儀の腕

/* ---- 前檣(マスト)と見張所 ---- */
B("super", -2, 31, -6, 2, 44, -2, "mast");
B("super", -3, 44, -8, 3, 48, -2, "mast");                              // 頂上の見張所
B("super", -8, 45, -5, 8, 46, -3, "mast");                              // 檣桁(ヤード)

/* ---- 煙突2本(弩級戦艦らしい2本煙突) ---- */
B("super", -4,  9,  6, 4, 29, 12, "funnel", { flat: ["down"] });
B("super", -5, 29,  5, 5, 31, 13, "funnelcap");
B("super", -4,  9, 18, 4, 27, 24, "funnel", { flat: ["down"] });
B("super", -5, 27, 17, 5, 29, 25, "funnelcap");

/* ---- 煙突の間の艇甲板と内火艇 ---- */
B("super", -8, 9, 13, 8, 13, 17, "deckhouse", { flat: ["down"] });
BM("super", 3, 13, 13, 7, 16, 17, "boat");

/* ---- 後部甲板室・主檣 ---- */
B("super", -7,  9, 27, 7, 16, 33, "deckhouse", { flat: ["down"] });
B("super", -2, 16, 28, 2, 33, 32, "mast");
B("super", -3, 33, 27, 3, 36, 33, "mast");
B("super", -7, 33, 29, 7, 34, 31, "mast");                              // 後檣の檣桁

/* ボーン階層 (name, parent, pivot[, rotation])。砲塔・方位盤はここを軸に旋回する。 */
const BONES = [
    ["root", null, [0, 0, 0]],
    ["hull", "root", [0, 0, 0]],
    ["super", "hull", [0, 9, 0]],
    ["director", "super", [0, 27, -5]],
    ["turret_a", "hull", [0, 15, -28]],
    ["turret_b", "hull", [0, 19, -18]],
    ["turret_x", "hull", [0, 18, 36]],
    ["turret_y", "hull", [0, 15, 47]],
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
            identifier: "geometry.civ.dreadnought",
            texture_width: TW,
            texture_height: TH,
            visible_bounds_width: 8,
            visible_bounds_height: 4,
            visible_bounds_offset: [0, 1.3, 0],
        },
        bones,
    }],
};

fs.writeFileSync(path.join(RP, "models/entity/dreadnought.geo.json"), JSON.stringify(geo, null, 2) + "\n");
fs.writeFileSync(path.join(RP, "textures/entity/dreadnought.png"), png);
console.log("cubes=" + cubes.length + " faces=" + rects.length + " atlas=" + TW + "x" + TH + " png=" + png.length + "B");
