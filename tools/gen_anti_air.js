"use strict";
/*
 * gen_anti_air.js -- civ:anti_air(対空砲)のモデル一式ジェネレータ
 *
 * 生成物:
 *   models/entity/anti_air.geo.json  ... 形状 + per-face UV
 *   textures/entity/anti_air.png     ... 上記UVに合わせて手続き的に描いたアトラス
 *
 * 使い方:  node tools/gen_anti_air.js      (このリソースパックのルートから)
 *
 * 設計方針(gen_tank.js / gen_dreadnought.js と同じ):
 *   - 形状はこのファイル内の cube 定義がソース。Blockbench で開ける普通の geo を吐くが、
 *     UV はここが正なので、形をいじったら必ず再生成すること。
 *   - UV は box UV ではなく per-face UV。面ごとに 1テクセル=1モデル単位。
 *   - 見えない面(コンクリート台座の底など)は flat 指定で単色パッチを共有する。
 *   - 塗りはモデル空間の座標を受け取る関数。土嚢の段・装甲の鋲列が面をまたいで
 *     繋がるように、左右対称(|x| 依存)の模様だけを使う。
 *
 * 座標系: 16単位 = 1ブロック。砲口は -Z 方向(scripts/unitModels.js の yawTowards が
 *   yaw=0 で -Z を向く前提)。底面 y=0 が接地面。陣地の外周 x,z=±26(3.25ブロック四方)、
 *   レーダーの頂点 y=48(3ブロック)。1マス=5ブロックなので隣のマスへはみ出さない。
 *
 * 💡 【これは「陣地」であって車両ではない】
 *   対空砲は production.js では category:"building"(都市の建物)で、移動しない。
 *   そのため土嚢の胸墻・弾薬箱・捜索レーダーまで含めた一区画をモデル化してある。
 *   走り回ることは無いので、砲(mount/cradle)とレーダーだけがゆっくり空を掃く。
 *
 * 💡 【砲身の仰角はボーンの静止回転で付けている】
 *   cradle ボーンの rotation で仰角を与えている。Bedrock のボーン回転は
 *   「X が正 = -Z 側が下がる」ので、上を向かせるには負の値を入れる。もし実機で砲身が
 *   地面へ突き刺さって見えたら、BONES の cradle の符号を反転させれば直る
 *   (tools/preview_model.js はボーンの回転を無視するので、プレビューでは水平に見える)。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const RP = path.resolve(__dirname, "..");

/* ============================ パレット ============================ */
/* 💡 陸戦装備は戦車(gen_tank.js)と同じオリーブドラブ系で揃えてある。 */
const C = {
    olive:      [0x4C, 0x55, 0x3A], // 装甲・砲架の基調(オリーブドラブ)
    oliveLight: [0x60, 0x6C, 0x4A],
    oliveDark:  [0x36, 0x3E, 0x2A],
    steel:      [0x45, 0x49, 0x4C],
    steelDark:  [0x25, 0x28, 0x2A],
    steelLight: [0x6C, 0x72, 0x78],
    gunmetal:   [0x33, 0x36, 0x39], // 砲身の青黒い焼き入れ色
    heat:       [0x6E, 0x5C, 0x4C], // 砲口寄りの焼け
    concrete:   [0x8A, 0x88, 0x80], // 砲床のコンクリート
    concreteDk: [0x5C, 0x5B, 0x55],
    sand:       [0x9A, 0x8B, 0x63], // 土嚢
    sandDark:   [0x6C, 0x60, 0x43],
    sandLight:  [0xB4, 0xA6, 0x7E],
    wood:       [0x77, 0x5C, 0x39], // 弾薬箱
    woodDark:   [0x4F, 0x3C, 0x25],
    brass:      [0xB0, 0x8A, 0x44], // 装弾クリップの薬莢
    brassDark:  [0x76, 0x5B, 0x2B],
    canvas:     [0x7C, 0x6D, 0x4E], // 座席の帆布
    canvasDark: [0x55, 0x4A, 0x36],
    mesh:       [0x8E, 0x94, 0x9A], // レーダーの金網
    meshDark:   [0x35, 0x39, 0x3D],
    rust:       [0x6E, 0x46, 0x2B],
    black:      [0x1F, 0x21, 0x23],
    white:      [0xD6, 0xD0, 0xC2],
    red:        [0xA8, 0x32, 0x26],
    redDark:    [0x74, 0x20, 0x17],
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const jit = (c, n) => [clamp(c[0] + n, 0, 255), clamp(c[1] + n, 0, 255), clamp(c[2] + n, 0, 255)];
function hash(x, y, z) {
    const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return h - Math.floor(h);
}
const smooth = (t) => t * t * (3 - 2 * t);
/** 格子サイズ s の値ノイズ。塗装や土嚢のむら用。 */
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

/* 面ローカル座標での縁の暗さ(部材の合わせ目) */
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

/* 面に沿った「横方向」の座標。土嚢や板の縞を面をまたいで繋げるのに使う。 */
function alongOf(p, f) {
    return (f === "east" || f === "west") ? p.z : p.x;
}

/* ============================ 塗りの部品 ============================ */

/* 泥はね。地面に近いほど濃い(陣地の下半分に掛ける)。 */
function splash(c, p) {
    const t = clamp((10 - p.y) / 10, 0, 1);
    if (t <= 0) return c;
    const n = vnoise(p.x * 1.6, p.y * 3.0, p.z * 1.6, 4);
    if (n > 0.58) return mix(c, C.woodDark, (n - 0.58) * 1.4 * t);
    return c;
}

/* 装甲板の鋲列・板の合わせ目・塗装の剥がれ。 */
function rivets(c, p, f) {
    const along = Math.round(Math.abs(alongOf(p, f)));
    if (mod(p.y, 6) === 0 && mod(along, 4) === 0) c = mix(c, C.steelLight, 0.30);
    if (mod(p.y, 6) === 3) c = mix(c, C.oliveDark, 0.20);
    if (hash(p.x * 2.3, p.y * 1.7, p.z * 3.1) > 0.988) c = mix(c, C.steelLight, 0.35);
    return c;
}

/* ============================ マテリアル ============================ */
/* (face, p={x,y,z}(モデル空間), q={u,v,fw,fh,cube}) -> [r,g,b] */

const MAT = {
    /* 砲床のコンクリート。上面は箒目、側面は型枠の跡と欠け。 */
    concrete: (f, p, q) => {
        let c = mix(C.concrete, C.concreteDk, 0.20 + 0.45 * vnoise(p.x, p.y * 2, p.z, 9));
        if (f === "up") {
            if (mod(p.x, 13) === 0 || mod(p.z, 13) === 0) c = mix(c, C.concreteDk, 0.45);  // 目地
            if (mod(p.z, 2) === 0) c = mix(c, C.concreteDk, 0.10);                         // 箒目
            // 砲の周りは踏み固められて黒ずむ
            const r = Math.hypot(p.x, p.z);
            if (r < 16) c = mix(c, C.steelDark, (1 - r / 16) * 0.30);
        } else {
            if (mod(p.y, 3) === 0) c = mix(c, C.concreteDk, 0.22);                         // 型枠の跡
        }
        if (hash(p.x * 3.7, p.y * 2.9, p.z * 1.3) > 0.985) c = mix(c, C.concreteDk, 0.55); // 骨材の欠け
        c = splash(c, p);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.20), (hash(p.x, p.y, p.z) - 0.5) * 10);
    },

    /*
     * 土嚢の胸墻。高さ3単位ごとに1段、長さ5単位ごとに1袋。段ごとに半個ずらして積む。
     * 上面は袋の腹が並んで見えるよう、縦横どちらにも継ぎ目を入れる。
     */
    sandbag: (f, p, q) => {
        let c = mix(C.sand, C.sandDark, 0.15 + 0.35 * vnoise(p.x * 1.4, p.y * 1.4, p.z * 1.4, 4));
        if (f === "up") {
            if (mod(p.x, 5) === 0 || mod(p.z, 5) === 0) c = mix(c, C.sandDark, 0.55);
            else c = mix(c, C.sandLight, 0.18);
        } else if (f !== "down") {
            const row = Math.floor((p.y - 3) / 3);
            const t = mod(alongOf(p, f) + (row % 2 ? 2.5 : 0), 5);
            const yr = mod(p.y - 3, 3);
            if (yr === 0) c = mix(c, C.sandDark, 0.60);                // 段の目地
            else if (yr === 2) c = mix(c, C.sandLight, 0.28);          // 袋の腹のハイライト
            if (t === 0) c = mix(c, C.sandDark, 0.60);                 // 袋と袋の合わせ目
            else if (t === 2) c = mix(c, C.sandLight, 0.14);
        }
        c = splash(c, p);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.18), (hash(p.x * 1.1, p.y * 0.9, p.z * 1.3) - 0.5) * 9);
    },

    /* 砲架・旋回台の装甲(オリーブドラブ)。 */
    armor: (f, p, q) => {
        let c = mix(C.olive, C.oliveDark, 0.15 + 0.35 * vnoise(p.x * 0.9, p.y * 0.7, p.z * 0.8, 13));
        if (f === "up") c = mix(c, C.oliveLight, 0.12);
        c = rivets(c, p, f);
        c = splash(c, p);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.24), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    /*
     * 防盾。装甲と同じ塗りに、上縁の危険色帯と識別の白線を足す。
     * 💡 帯は y 依存(左右対称)なので、面の UV が左右反転しても崩れない。
     */
    shield: (f, p, q) => {
        let c = mix(C.olive, C.oliveDark, 0.12 + 0.30 * vnoise(p.x * 0.9, p.y * 0.7, p.z * 0.8, 11));
        if (p.y >= 24) c = mix(c, C.redDark, 0.45);                    // 上縁の危険色
        else if (Math.round(p.y) === 23) c = mix(c, C.white, 0.30);
        c = rivets(c, p, f);
        if (f === "north") c = mix(c, C.steelLight, 0.10);             // 正面は擦れて明るい
        c = splash(c, p);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.26), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    /*
     * 砲身。放熱ジャケットのリングが入り、砲口へ行くほど焼けて色が変わる。
     * 北面(=砲口側)には同心の輪と暗い穴を描いて「筒」に見せる。
     */
    gun: (f, p, q) => {
        if (f === "north") {
            const cu = q.fw / 2 - 0.5, cv = q.fh / 2 - 0.5;
            const rr = Math.min(cu, cv);
            const r = Math.hypot(q.u - cu, q.v - cv);
            if (r > rr - 0.3) return jit(mix(C.gunmetal, C.steelDark, 0.35), -4);
            if (r > rr - 1.2) return jit(mix(C.steelLight, C.steel, 0.35), 3);   // 砲口の環
            return jit(mix(C.black, C.steelDark, 0.20), (hash(p.x, p.y, p.z) - 0.5) * 6);
        }
        const t = clamp((-p.z - 24) / 16, 0, 1);                        // 砲口寄りほど焼ける
        let c = mix(C.gunmetal, C.steel, 0.25 + 0.30 * vnoise(p.x, p.y, p.z, 6));
        if (mod(p.z, 4) === 0) c = mix(c, C.steelDark, 0.30);           // 放熱ジャケットのリング
        if (mod(p.z, 4) === 1) c = mix(c, C.steelLight, 0.14);
        c = mix(c, C.heat, t * 0.45);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.28), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    /* 駐退機・照準器・レーダー柱などの鋼材。 */
    steel: (f, p, q) => {
        let c = mix(C.steel, C.steelDark, 0.25 + 0.30 * vnoise(p.x, p.y, p.z, 5));
        if (mod(p.y, 4) === 0) c = mix(c, C.steelLight, 0.18);
        if (hash(p.x * 1.9, p.y * 2.7, p.z * 1.1) > 0.99) c = mix(c, C.rust, 0.45);
        c = splash(c, p);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.30), (hash(p.x, p.y, p.z) - 0.5) * 9);
    },

    /* 装弾クリップ(縦に並んだ薬莢)。 */
    ammo: (f, p, q) => {
        let c = mix(C.olive, C.oliveDark, 0.35);
        if (f === "up") {
            // 上から見ると薬莢の頭が並んでいる
            c = (mod(p.x, 3) === 0 || mod(p.z, 3) === 0) ? mix(C.brassDark, C.black, 0.35) : C.brass;
        } else if (f !== "down") {
            const along = alongOf(p, f);
            if (mod(along, 3) === 0) c = mix(C.brassDark, C.black, 0.30);   // 薬莢の隙間
            else c = mix(C.brass, C.brassDark, 0.25 + 0.35 * vnoise(p.x, p.y * 2, p.z, 4));
            if (mod(p.y, 7) === 0) c = mix(c, C.oliveDark, 0.55);           // クリップの帯
        }
        c = faceShade(c, f);
        return jit(edge(c, q, 0.26), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    /* 弾薬箱(木箱)。板目・帯金・ステンシル。 */
    crate: (f, p, q) => {
        let c = mix(C.wood, C.woodDark, 0.20 + 0.45 * vnoise(p.x * 2.2, p.y, p.z * 0.6, 5));
        const along = alongOf(p, f);
        if (f === "up") {
            if (mod(p.z, 4) === 0) c = mix(c, C.woodDark, 0.45);            // 蓋の板の隙間
            if (mod(p.x, 11) === 0) c = mix(c, C.steelDark, 0.35);          // 帯金
        } else if (f !== "down") {
            if (mod(p.y, 4) === 0) c = mix(c, C.woodDark, 0.45);            // 板の隙間
            if (mod(along, 11) === 0) c = mix(c, C.steelDark, 0.35);        // 帯金
            if (mod(p.y, 4) === 2 && mod(along, 11) > 2 && mod(along, 11) < 8) {
                c = mix(c, C.white, 0.30);                                  // ステンシル
            }
        }
        c = splash(c, p);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.28), (hash(p.x, p.y, p.z) - 0.5) * 9);
    },

    /* 砲手の座席(鋼の枠に帆布)。 */
    seat: (f, p, q) => {
        let c = mix(C.canvas, C.canvasDark, 0.25 + 0.35 * vnoise(p.x * 2, p.y, p.z * 2, 4));
        if (mod(p.y, 3) === 0) c = mix(c, C.canvasDark, 0.35);              // 縫い目
        if (f === "down" || p.y < 11) c = mix(C.steel, C.steelDark, 0.35);  // 枠
        c = faceShade(c, f);
        return jit(edge(c, q, 0.28), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    /*
     * 捜索レーダーの反射鏡。北面(凹面側)は金網の格子、南面は補強リブ。
     * 💡 模様は反射鏡の中心 (DX, DY) からの距離で決めている。中心はキューブの
     *    x 中央でもあるので、面の UV が左右反転しても模様は崩れない
     *    (3枚のキューブに分けて八角形の輪郭にしても、格子と縁が繋がる)。
     */
    radar: (f, p, q) => {
        const DX = 18, DY = 41;   // 反射鏡の中心(モデル空間)
        if (f === "north") {
            const r = Math.hypot((p.x - DX) / 9, (p.y - DY) / 8);
            let c = mix(C.mesh, C.meshDark, 0.12 + 0.40 * r);                 // 中心ほど明るい
            if (mod(p.x, 2) === 0 || mod(p.y, 2) === 0) c = mix(c, C.meshDark, 0.35); // 金網の格子
            if (r > 0.80) c = mix(c, C.steelLight, 0.35);                     // 反射鏡の縁
            return jit(c, (hash(p.x, p.y, p.z) - 0.5) * 8);
        }
        if (f === "south") {
            let c = mix(C.steel, C.steelDark, 0.35 + 0.25 * vnoise(p.x, p.y, p.z, 5));
            // 放射状の補強リブ(中心から外へ伸びる)
            const dx = p.x - DX, dy = p.y - DY;
            const ang = Math.atan2(dy, dx) * (4 / Math.PI);
            if (mod(ang, 1) === 0) c = mix(c, C.steelLight, 0.28);
            if (Math.hypot(dx / 9, dy / 8) > 0.80) c = mix(c, C.steelLight, 0.20);
            return jit(faceShade(edge(c, q, 0.30), f), (hash(p.x, p.y, p.z) - 0.5) * 8);
        }
        const c = mix(C.steel, C.steelDark, 0.40);
        return jit(faceShade(edge(c, q, 0.30), f), (hash(p.x, p.y, p.z) - 0.5) * 7);
    },
};

// flat 指定の面が参照する単色パッチ(接地面など、絶対に見えない面)
const SWATCH = {
    concrete: C.concreteDk, sandbag: C.sandDark, armor: C.oliveDark, shield: C.oliveDark,
    gun: C.steelDark, steel: C.steelDark, ammo: C.brassDark, crate: C.woodDark,
    seat: C.canvasDark, radar: C.steelDark,
};

/* ============================ モデル定義 ============================ */
const cubes = [];
const D = ["down"];

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

/* ---- 砲床(コンクリート) ---- */
B("base", -26, 0, -26, 26, 3, 26, "concrete", { flat: D });

/* ---- 土嚢の胸墻。前(-Z)は射界を空けるため中央だけ低い ---- */
B("base", -26, 3,  19, 26, 13,  26, "sandbag", { flat: D });   // 後壁
BM("base", 19, 3, -19, 26, 12,  19, "sandbag", { flat: D });   // 側壁
BM("base",  8, 3, -26, 26, 10, -19, "sandbag", { flat: D });   // 前壁(左右)
B("base",  -8, 3, -26,  8,  7, -19, "sandbag", { flat: D });   // 前壁(中央=射界)

/* ---- 弾薬箱(後方左の隅に積む) ---- */
B("base", -18, 3,  8, -11,  9, 17, "crate", { flat: D });
B("base", -17, 9,  9, -12, 14, 16, "crate", { flat: D });
/* ---- 予備弾の平積み(後方右の隅) ---- */
B("base",  11, 3, 10,  18,  8, 18, "crate", { flat: D });

/* ---- 捜索レーダーの柱(後壁の上に立てる) ---- */
B("base", 15, 13, 20, 21, 34, 25, "steel", { flat: D });

/* ---- 捜索レーダーの反射鏡(radar ボーンでゆっくり回す)
       💡 3枚に分けて八角形の輪郭にしている。塗りは中心 (18, 41) からの距離で
          決めているので、3枚に割っても金網と縁は繋がって見える。 ---- */
B("radar", 12, 34, 18, 24, 37, 21, "radar");
B("radar", 10, 37, 18, 26, 45, 21, "radar");
B("radar", 12, 45, 18, 24, 48, 21, "radar");
B("radar", 16, 39, 14, 20, 43, 18, "steel");   // 給電部(反射鏡の前に張り出す)
B("radar", 16, 38, 21, 20, 42, 25, "steel");   // 背面の支持腕(柱の上に載る)

/* ---- 旋回台と砲架(mount ボーン。yaw で空を掃く) ---- */
B("mount", -11, 3, -11, 11,  6, 11, "steel", { flat: D });   // 旋回台
B("mount",  -8, 6,  -8,  8, 13,  8, "armor", { flat: D });   // 砲架の柱
BM("mount",  5, 13,  -3,  8, 25,  3, "armor");               // 耳軸の腕
BM("mount",  8,  9,   2, 13, 12,  9, "seat", { flat: D });   // 砲手の座席
BM("mount",  9, 12,   7, 12, 18,  9, "seat");                // 背もたれ
BM("mount",  8,  8,  -8, 12, 14, -2, "ammo", { flat: D });   // 即用弾のラック

/* ---- 防盾。中央は砲身が抜けるので下半分だけ ---- */
BM("mount",  7, 10, -13, 17, 26, -11, "shield");
B("mount",  -7, 10, -13,  7, 18, -11, "shield");
BM("mount", 15, 10, -11, 17, 24,  -5, "shield");   // 側面の折り返し

/*
 * ---- 揺架と連装砲身(cradle ボーン。pitch で仰角を付ける) ----
 * 💡 耳軸(pivot y=22)を砲架の柱の天面(y=13)より 9 単位高く取ってあるのは、
 *    仰角を付けたときに尾栓覆いの後端が柱へめり込まないようにするため。
 *    尾栓覆いを後ろへ伸ばす・耳軸を下げるときは
 *      (尾栓の下面から耳軸までの高さ)*cos + (耳軸から尾栓後端までの長さ)*sin < 9
 *    を満たすか確かめること(現状 42 度で 7.6)。
 */
B("cradle",  -5, 19,  -2,  5, 27,   8, "armor");   // 尾栓覆い
BM("cradle",  2, 20, -38,  5, 24,  -2, "gun");     // 砲身
BM("cradle",  1, 19, -44,  6, 25, -38, "gun");     // 砲口制退器
BM("cradle",  2, 24, -30,  5, 26,  -8, "steel");   // 駐退復座機
BM("cradle",  1, 27,   0,  5, 36,   8, "ammo");    // 装弾クリップ
B("cradle",  -6, 25, -10, -2, 30,  -2, "steel");   // 照準器(実物同様に左寄せ)

/*
 * ボーン階層 (name, parent, pivot[, rotation])。
 * 💡 cradle の rotation で仰角を付けている(負 = 砲口(-Z)側が上を向く)。
 *    animations/anti_air.animation.json の掃射はこの静止姿勢に加算される。
 */
const BONES = [
    ["root", null, [0, 0, 0]],
    ["base", "root", [0, 0, 0]],
    ["radar", "base", [18, 41, 22]],
    ["mount", "base", [0, 6, 0]],
    ["cradle", "mount", [0, 22, 0], [-42, 0, 0]],
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
            identifier: "geometry.civ.anti_air",
            texture_width: TW,
            texture_height: TH,
            visible_bounds_width: 5,
            visible_bounds_height: 4,
            visible_bounds_offset: [0, 1.6, 0],
        },
        bones,
    }],
};

fs.writeFileSync(path.join(RP, "models/entity/anti_air.geo.json"), JSON.stringify(geo, null, 2) + "\n");
fs.writeFileSync(path.join(RP, "textures/entity/anti_air.png"), png);
console.log("cubes=" + cubes.length + " faces=" + rects.length + " atlas=" + TW + "x" + TH + " png=" + png.length + "B");
