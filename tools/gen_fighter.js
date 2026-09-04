"use strict";
/*
 * gen_fighter.js -- civ:fighter のモデル一式ジェネレータ
 *
 * 生成物:
 *   models/entity/fighter.geo.json   ... 形状 + per-face UV
 *   textures/entity/fighter.png      ... 上記UVに合わせて手続き的に描いたアトラス
 *
 * 使い方:  node tools/gen_fighter.js      (このリソースパックのルートから)
 *
 * 設計方針(gen_tank.js / gen_airship.js と同じ):
 *   - 形状はこのファイル内の cube 定義がソース。Blockbench で開ける普通の geo を吐くが、
 *     UV はここが正なので、形をいじったら必ず再生成すること。
 *   - UV は box UV ではなく per-face UV。面ごとに 1テクセル=1モデル単位。
 *   - 見えない面(主翼の付け根・パイロンの内側など)は flat 指定で単色パッチを共有する。
 *   - 塗りはモデル空間の座標を受け取る関数。パネルライン・国籍マーク・排気の煤が
 *     面をまたいで繋がるように、左右対称(|x| 依存)の模様だけを使う。
 *
 * 座標系: 16単位 = 1ブロック。機首は -Z 方向(scripts/unitModels.js の yawTowards が
 *   yaw=0 で -Z を向く前提)。全長 z=-58..53(約7ブロック)、翼幅 x=±39(約4.9ブロック)、
 *   垂直尾翼の頂点 y=37。飛行体なので接地面は無く、y=12 前後が胴体の中心線。
 *   💡 戦車と違い下面も常に見えるので、底面を flat にしないこと。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const RP = path.resolve(__dirname, "..");

/* ============================ パレット ============================ */
const C = {
    grayTop:    [0x6B, 0x74, 0x7E], // 上面の制空迷彩(濃いグレー)
    grayTopDk:  [0x53, 0x5B, 0x65],
    grayBot:    [0x9C, 0xA5, 0xAF], // 下面(カウンターシェーディングで明るい)
    grayLight:  [0xBA, 0xC2, 0xCA],
    grayDark:   [0x3A, 0x40, 0x48],
    radome:     [0x44, 0x48, 0x4E], // レドームは誘電体なので機体色より暗い
    radomeDark: [0x2C, 0x30, 0x35],
    steel:      [0x4B, 0x50, 0x56],
    steelDark:  [0x26, 0x29, 0x2D],
    steelLight: [0x76, 0x7D, 0x85],
    black:      [0x1C, 0x1E, 0x21],
    white:      [0xD8, 0xD4, 0xCB],
    red:        [0xA8, 0x32, 0x26],
    redDark:    [0x74, 0x20, 0x17],
    glass:      [0x22, 0x35, 0x4C], // キャノピーの濃紺
    glassLite:  [0x74, 0x9B, 0xC6],
    glassGold:  [0x7C, 0x6A, 0x3A], // 金コーティングの映り
    helmet:     [0xC6, 0xC2, 0xB6],
    visor:      [0x2A, 0x2C, 0x30],
    heat:       [0x7A, 0x6A, 0x60], // ノズルの焼け
    heatBlue:   [0x4E, 0x53, 0x6E],
    heatGold:   [0x8C, 0x74, 0x48],
    flameCore:  [0xFF, 0xF3, 0xC8],
    flameHot:   [0xFF, 0xB8, 0x4C],
    flameBlue:  [0x8C, 0xB4, 0xFF],
    olive:      [0x5E, 0x63, 0x44], // ミサイル本体
    oliveDark:  [0x40, 0x45, 0x30],
    tank:       [0x8E, 0x96, 0xA0], // 増槽
    soot:       [0x33, 0x31, 0x2F],
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

/* 面ローカル座標での縁の暗さ(パネルの合わせ目) */
function edge(c, q, amt) {
    const { u, v, fw, fh } = q;
    if (u === 0 || v === 0 || u === fw - 1 || v === fh - 1) return mix(c, C.grayDark, amt);
    return c;
}

/* 面の向きによる明暗。上面は明るく、下面と後面は暗く。 */
function faceShade(c, f) {
    if (f === "up") return mix(c, C.white, 0.08);
    if (f === "down") return mix(c, C.black, 0.10);
    if (f === "south") return mix(c, C.black, 0.12);
    return c;
}

/* ============================ 塗りの部品 ============================ */

/* 制空迷彩(2トーンのグレー)。上面は濃く下面は明るいカウンターシェーディング。 */
function camo(p, f) {
    const n = vnoise(Math.abs(p.x) * 0.9, p.y * 0.7, p.z * 0.75, 17);
    const c = mix(C.grayTop, C.grayTopDk, n > 0.53 ? 0.9 : 0.05);
    // 胴体の高さと面の向きの両方から「どれだけ下向きの面か」を出す
    let under = clamp((13 - p.y) / 12, 0, 1) * 0.55;
    if (f === "down") under = Math.max(under, 0.78);
    if (f === "up") under *= 0.25;
    return mix(c, C.grayBot, under);
}

/* モデル空間でのパネルライン。面をまたいで一本に繋がる。 */
function panels(c, p, f) {
    const z = Math.round(p.z), x = Math.round(Math.abs(p.x)), y = Math.round(p.y);
    if (((z % 13) + 13) % 13 === 0) c = mix(c, C.grayDark, 0.30);
    if ((f === "up" || f === "down") && x % 11 === 0) c = mix(c, C.grayDark, 0.22);
    if ((f === "east" || f === "west") && ((y % 7) + 7) % 7 === 0) c = mix(c, C.grayDark, 0.18);
    // アクセスパネルの留めネジ
    if (((z % 13) + 13) % 13 === 6 && x % 11 === 5) c = mix(c, C.steelLight, 0.30);
    return c;
}

/* 国籍マーク(戦車・飛行船と同じ赤/白の同心円)。dist はマーク中心からの距離。 */
function roundelAt(c, dist) {
    if (dist < 2.1) return C.red;
    if (dist < 3.4) return C.white;
    if (dist < 4.7) return C.red;
    if (dist < 5.3) return mix(c, C.redDark, 0.5);
    return c;
}

/* 排気の煤。後方ほど濃い。 */
function soot(c, p) {
    const t = clamp((p.z - 24) / 22, 0, 1);
    if (t <= 0) return c;
    const n = vnoise(Math.abs(p.x), p.y, p.z, 7);
    return mix(c, C.soot, clamp(t * t * 0.55 * (0.5 + n), 0, 0.6));
}

/* 気流に沿って後ろへ流れた汚れ(縦ではなくZ方向に伸ばす) */
function streak(c, p) {
    const s = vnoise(Math.abs(p.x) * 4.5, p.y * 4.5, p.z * 0.35, 3);
    if (s > 0.68) return mix(c, C.grayDark, (s - 0.68) * 0.9);
    return c;
}

/* ============================ マテリアル ============================ */
/* (face, p={x,y,z}(モデル空間), q={u,v,fw,fh,cube}) -> [r,g,b] */

const MAT = {
    // 機体外板。迷彩 + パネルライン + 汚れ + 煤
    skin: (f, p, q) => {
        let c = camo(p, f);
        c = faceShade(c, f);
        c = panels(c, p, f);
        if (hash(p.x * 2.3, p.y * 1.7, p.z * 3.1) > 0.988) c = mix(c, C.steelLight, 0.40); // 塗装剥がれ
        c = streak(c, p);
        c = soot(c, p);
        return jit(edge(c, q, 0.22), (hash(p.x * 0.9, p.y * 1.1, p.z * 0.7) - 0.5) * 8);
    },

    // レドーム。誘電体なので機体色と別塗り。避雷ストリップを入れる
    radome: (f, p, q) => {
        let c = mix(C.radome, C.radomeDark, 0.35 * vnoise(p.x, p.y, p.z, 6));
        if ((f === "up" || f === "down") && Math.round(Math.abs(p.x)) === 2) c = mix(c, C.steelLight, 0.45);
        if (f === "north") c = mix(c, C.black, 0.25);
        c = faceShade(c, f);
        // 機首と胴体の境目でだんだん機体色へ
        if (p.z > -24) c = mix(c, C.grayBot, clamp((p.z + 24) / 3, 0, 1) * 0.8);
        return jit(edge(c, q, 0.25), (hash(p.x, p.y, p.z) - 0.5) * 7);
    },

    /*
     * キャノピー。金色コーティングの掛かった濃紺のガラスに、枠(前後の縁と下端の
     * レール)とパイロットの頭・射出座席を描き込む。
     */
    glass: (f, p, q) => {
        if (p.y < 18.2) return jit(faceShade(mix(C.grayBot, C.grayDark, 0.25), f), -3);      // キャノピーレール
        if (f === "north" || f === "south") return jit(faceShade(mix(C.grayBot, C.grayDark, 0.3), f), -3); // 風防の枠
        let c = mix(C.glass, C.glassLite, clamp((p.y - 18) / 6, 0, 1) * 0.35);
        c = mix(c, C.glassGold, 0.28 + 0.22 * clamp((p.z + 24) / 18, 0, 1));
        const g = p.z * 0.6 + p.y * 1.4;                      // 斜めの映り込み
        if (((Math.round(g) % 9) + 9) % 9 < 2) c = mix(c, C.glassLite, 0.45);
        if (f === "up") c = mix(c, C.glassLite, 0.12);   // 上から見て水色の板に見えないよう控えめに
        if (f === "east" || f === "west") {
            const r = Math.hypot(p.z + 15, (p.y - 20.5) * 1.15);    // パイロットのヘルメット
            if (r < 2.6) {
                c = mix(C.helmet, C.grayDark, 0.15);
                if (p.z < -15 && p.y < 21) c = C.visor;             // バイザー
                if (r > 2.0) c = mix(c, C.visor, 0.5);
            }
            if (Math.hypot(p.z + 9, (p.y - 20) * 0.9) < 2.2) c = mix(C.grayDark, C.black, 0.4); // 座席
        }
        return jit(edge(c, q, 0.30), (hash(p.x, p.y, p.z) - 0.5) * 6);
    },

    // 空気取入口。正面(north)だけ暗い吸込口、他は機体外板と同じ
    intake: (f, p, q) => {
        if (f !== "north") {
            let c = MAT.skin(f, p, q);
            // ダクト側面のバイパスドア
            if ((f === "east" || f === "west") && p.z > -6 && p.z < 4 && Math.round(p.y) % 5 === 0) {
                c = mix(c, C.grayDark, 0.3);
            }
            return c;
        }
        const inset = Math.min(q.u, q.v, q.fw - 1 - q.u, q.fh - 1 - q.v);
        if (inset === 0) return jit(mix(C.grayBot, C.grayDark, 0.35), -4);   // インレットリップ
        let c = mix(C.black, C.steelDark, clamp(inset / 3, 0, 1) * 0.55);
        if (inset === 1) c = mix(c, C.steelLight, 0.25);
        return jit(c, (hash(p.x, p.y, p.z) - 0.5) * 5);
    },

    // 主翼・尾翼。外板に加えて翼上下面の国籍マーク、垂直尾翼の部隊マーク
    wing: (f, p, q) => {
        let c = MAT.skin(f, p, q);
        if (f === "up" || f === "down") {
            c = roundelAt(c, Math.hypot(Math.abs(p.x) - 22, p.z - 14));
            // 付け根の歩行禁止帯。強く入れるとハシゴのように見えるので薄く
            if (Math.abs(p.x) < 15 && p.z > 2 && p.z < 14 && ((Math.round(p.z) % 4) + 4) % 4 === 0) {
                c = mix(c, C.redDark, 0.22);
            }
            if (q.v === 0 || q.u === 0) c = mix(c, C.steelLight, 0.18);   // 前縁は塗装が剥げやすい
        }
        // 垂直尾翼の外側面(y>18 に来るのは垂直尾翼だけ)。
        // 胴体側面のマークは増槽とミサイルで隠れてしまうので、識別はここに置く。
        if ((f === "east" || f === "west") && p.y > 18) {
            if (p.y > 35) c = mix(c, C.redDark, 0.5);                     // 尾翼頂部の部隊帯
            // 尾翼は主翼より小さいので、同じマークを 0.6 倍の直径で入れる
            else c = roundelAt(c, Math.hypot(p.z - 33, p.y - 24) * 1.65);
        }
        return c;
    },

    /*
     * 排気ノズル。側面は花弁(z方向の縞)と熱変色、後面(south)は同心のリングと
     * 暗い穴で「奥に燃焼室がある」ように見せる。
     */
    nozzle: (f, p, q) => {
        if (f === "south") {
            const cu = q.fw / 2 - 0.5, cv = q.fh / 2 - 0.5;
            const rr = Math.min(cu, cv);
            const r = Math.hypot(q.u - cu, q.v - cv);
            if (r > rr - 0.3) return jit(mix(C.heat, C.steelDark, 0.35), -4);
            if (r > rr - 1.6) return jit(mix(C.heatGold, C.heat, 0.3), 3);
            let c = mix(C.black, C.steelDark, 0.4);
            c = mix(c, C.flameHot, clamp((rr - 2.2 - r) / 3, 0, 1) * 0.85);   // 奥のアフターバーナー
            return jit(c, (hash(p.x, p.y, p.z) - 0.5) * 8);
        }
        const t = clamp((p.z - 34) / 10, 0, 1);                               // 後ろほど焼けている
        let c = mix(C.steel, C.heat, 0.35 + 0.45 * t);
        if (((Math.round(p.z) % 3) + 3) % 3 === 0) c = mix(c, C.steelDark, 0.35);  // 花弁の合わせ目
        const band = vnoise(Math.abs(p.x), p.y, p.z * 2.2, 4);
        c = mix(c, band > 0.55 ? C.heatGold : C.heatBlue, t * 0.45 * band);        // 熱による虹色
        c = faceShade(c, f);
        return jit(edge(c, q, 0.25), (hash(p.x, p.y, p.z) - 0.5) * 9);
    },

    // アフターバーナーの炎。根元は青、後ろへ行くほど橙に薄れる
    flame: (f, p, q) => {
        const t = clamp((p.z - 42) / 12, 0, 1);
        let c = mix(C.flameCore, C.flameHot, smooth(t));
        if (t < 0.3) c = mix(c, C.flameBlue, (0.3 - t) * 1.9);
        const n = hash(p.x * 3.3, p.y * 2.7, p.z * 1.9);
        if (n > 0.86) c = mix(c, C.flameCore, 0.5);       // ショックダイヤモンド風の明点
        return jit(c, (n - 0.5) * 22);
    },

    // パイロン・ランチャーレール
    steel: (f, p, q) => {
        let c = mix(C.steel, C.grayBot, 0.35);
        if (((Math.round(p.z) % 5) + 5) % 5 === 0) c = mix(c, C.steelDark, 0.3);
        return jit(faceShade(edge(c, q, 0.3), f), (hash(p.x, p.y, p.z) - 0.5) * 9);
    },

    // ミサイル本体。オリーブ + 弾頭の茶帯 + 白帯
    missile: (f, p, q) => {
        let c = mix(C.olive, C.oliveDark, 0.3 + 0.35 * vnoise(p.x, p.y, p.z, 5));
        const z = Math.round(p.z);
        if (z >= -4 && z <= -2) c = mix(C.redDark, C.olive, 0.15);
        if (z >= 0 && z <= 1) c = mix(c, C.white, 0.55);
        if (((z % 6) + 6) % 6 === 0) c = mix(c, C.oliveDark, 0.4);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.28), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    // シーカー(赤外線誘導のガラス頭)
    seeker: (f, p, q) => {
        let c = mix(C.glass, C.black, 0.35);
        if (f === "up") c = mix(c, C.glassLite, 0.35);
        if (f === "north") c = mix(c, C.glassLite, 0.20);
        if (p.z > -3) c = mix(C.steel, C.steelDark, 0.4);   // 付け根のリング
        return jit(edge(c, q, 0.3), (hash(p.x, p.y, p.z) - 0.5) * 7);
    },

    // 増槽(機体より少し明るい)
    droptank: (f, p, q) => {
        let c = mix(C.tank, C.grayDark, 0.18 + 0.2 * vnoise(p.x, p.y, p.z, 6));
        if (f === "down") c = mix(c, C.grayLight, 0.25);
        if (((Math.round(p.z) % 9) + 9) % 9 === 0) c = mix(c, C.grayDark, 0.32);
        c = faceShade(c, f);
        c = streak(c, p);
        return jit(edge(c, q, 0.25), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },
};

// flat 指定の面が参照する単色パッチ
const SWATCH = {
    skin: C.grayTopDk, radome: C.radomeDark, glass: C.glass, intake: C.grayTopDk,
    wing: C.grayTopDk, nozzle: C.steelDark, flame: C.flameHot, steel: C.steel,
    missile: C.oliveDark, seeker: C.steelDark, droptank: C.grayDark,
};

/* ============================ モデル定義 ============================ */
const cubes = [];

function B(bone, x0, y0, z0, x1, y1, z1, mat, opts) {
    cubes.push(Object.assign({ bone, x0, y0, z0, x1, y1, z1, mat }, opts || {}));
}
/** 左右で別ボーン(可動する尾翼など)に置く版。x>0 側を渡す。 */
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

/* ---- 機首: ピトー管 → レドーム(2段テーパー) ----
   💡 機首を伸ばしすぎると側面図で針のように見え、コックピットが胴体中央に
      寄って戦闘機に見えなくなる。全長の1/4以内に収めること。 */
B("body", -1, 11, -51, 1, 13, -46, "steel");
B("body", -3, 10, -46, 3, 14, -40, "radome");
B("body", -4,  9, -40, 4, 16, -32, "radome");
B("body", -5,  7, -32, 5, 17, -22, "skin");

/* ---- 胴体 ---- */
B("body", -6, 6, -22, 6, 18, -2, "skin");   // 前部
B("body", -7, 6,  -2, 7, 18, 26, "skin");   // 中央
B("body", -8, 7,  26, 8, 17, 38, "skin");   // 後部(エンジンベイ)
B("body", -5, 3,   0, 5,  7, 22, "skin");   // 腹部の膨らみ(兵装倉)

/* ---- コックピット ---- */
B("body", -4, 17, -26, 4, 21, -20, "glass"); // 風防
B("body", -4, 17, -20, 4, 23,  -8, "glass"); // キャノピー
B("body", -4, 17,  -8, 4, 22,   6, "skin");  // 後方フェアリング
B("body", -3, 18,   6, 3, 20,  26, "skin");  // 背骨(スパイン)
B("body", -4, 16,  26, 4, 18,  34, "skin");  // エアブレーキ板(胴体上面に1単位埋めて重ねる)

/* ---- ストレーキ(LERX)。機首から取入口へ繋ぐ細い翼 ---- */
BM("body", 5, 12, -30, 8, 15, -14, "skin", { flat: ["west"] });

/* ---- 空気取入口(正面が吸込口。内側の面は胴体に隠れる) ----
   💡 側面が 38x11 の一枚板になって間延びするので、前端に一段細いリップを足して
      段差を作る。リップの正面も intake マテリアルなので吸込口が二重の輪に見える。 */
BM("body", 6, 4, -16, 11, 15, 22, "intake", { flat: ["west"] });
BM("body", 7, 5, -20, 11, 14, -16, "intake", { flat: ["west"] });

/* ---- 左肩の機関砲フェアリング(正面が砲口。実機同様わざと左右非対称) ---- */
B("body", -9, 15, -20, -6, 18, -10, "intake");

/* ---- 主翼(後退角を4段で近似。付け根は取入口に埋まる)
   💡 内翼の後端(z=27)は水平尾翼の前端(z=28)と面が接しないよう1単位空ける。
      揃えると同一平面の面が重なって Z ファイティングを起こす。 ---- */
BM("body",  7, 11, -4, 15, 14, 27, "wing", { flat: ["west"] });
BM("body", 15, 11,  3, 23, 14, 27, "wing");
BM("body", 23, 11, 10, 31, 13, 26, "wing");
BM("body", 31, 11, 15, 37, 13, 24, "wing");

/* ---- 翼端のランチャーレール + 短距離ミサイル ----
   💡 ミサイルは翼端の前縁(z=15)を跨いで前後に出す。前へ出しすぎると
      上から見たときレールから浮いた別物に見える。 */
BM("body", 34, 14, 13, 37, 15, 24, "steel", { flat: ["down"] });
BM("body", 34, 15,  4, 37, 18, 22, "missile");
BM("body", 34, 15,  0, 37, 18,  4, "seeker");
BM("body", 32, 16, 18, 39, 17, 22, "missile");   // 尾翼(水平)
BM("body", 35, 13, 18, 36, 20, 22, "missile");   // 尾翼(垂直)

/* ---- 内側パイロン + 増槽 ---- */
BM("body", 12, 8,   2, 14, 12, 12, "steel", { flat: ["west"] });
BM("body", 10, 3,  -8, 16,  9, 14, "droptank");
BM("body", 11, 4, -12, 15,  8, -8, "droptank");
BM("body", 11, 4,  14, 15,  8, 18, "droptank");
BM("body", 12, 2,  12, 14, 10, 18, "droptank");  // 増槽の安定板

/* ---- 外側パイロン + 中距離ミサイル ---- */
BM("body", 22, 9,   6, 24, 12, 14, "steel", { flat: ["west"] });
BM("body", 21, 5,  -6, 25,  9, 12, "missile");
BM("body", 21, 5, -10, 25,  9, -6, "seeker");
BM("body", 19, 6,   8, 27,  8, 13, "missile");   // 尾翼(水平)
BM("body", 22, 3,   8, 24, 11, 13, "missile");   // 尾翼(垂直)

/* ---- 腹鰭(ベントラルフィン) ---- */
BM("body", 6, 2, 28, 7, 7, 38, "wing", { flat: ["west"] });

/* ---- 双発ノズル(間の隙間は埋め板で塞ぐ) ---- */
B("body", -2, 8, 35, 2, 15, 42, "skin");
BM("body", 1, 7, 36, 8, 16, 43, "nozzle", { flat: ["west"] });

/* ---- アフターバーナーの炎(scale アニメで脈動させる) ---- */
BM("flame", 2,  9, 42, 7, 14, 48, "flame");
BM("flame", 3, 10, 48, 6, 13, 53, "flame");

/* ---- 双垂直尾翼(ラダーとして左右別ボーン) ---- */
BB2("fin_r", "fin_l", 8, 17, 26, 10, 27, 39, "wing");
BB2("fin_r", "fin_l", 8, 27, 30, 10, 33, 39, "wing");
BB2("fin_r", "fin_l", 8, 33, 34, 10, 37, 39, "wing");

/* ---- 全遊動式水平尾翼(スタビレーター) ---- */
BB2("stab_r", "stab_l",  7, 10, 28, 16, 12, 41, "wing", { flat: ["west"] });
BB2("stab_r", "stab_l", 16, 10, 33, 23, 12, 40, "wing");

/* ボーン階層 (name, parent, pivot[, rotation])。動翼はここを軸に回す。 */
const BONES = [
    ["root", null, [0, 0, 0]],
    ["body", "root", [0, 12, 0]],
    ["fin_r", "body", [9, 17, 38]],     // ラダー(yaw)
    ["fin_l", "body", [-9, 17, 38]],
    ["stab_r", "body", [8, 11, 30]],    // スタビレーター(pitch)
    ["stab_l", "body", [-8, 11, 30]],
    ["flame", "body", [0, 11, 42]],     // アフターバーナー(scale)
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
            identifier: "geometry.civ.fighter",
            texture_width: TW,
            texture_height: TH,
            visible_bounds_width: 8,
            visible_bounds_height: 3,
            visible_bounds_offset: [0, 1.2, 0],
        },
        bones,
    }],
};

fs.writeFileSync(path.join(RP, "models/entity/fighter.geo.json"), JSON.stringify(geo, null, 2) + "\n");
fs.writeFileSync(path.join(RP, "textures/entity/fighter.png"), png);
console.log("cubes=" + cubes.length + " faces=" + rects.length + " atlas=" + TW + "x" + TH + " png=" + png.length + "B");
