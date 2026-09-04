"use strict";
/*
 * gen_warrior.js -- civ:warrior のモデル一式ジェネレータ
 *
 * 生成物:
 *   models/entity/warrior.geo.json   ... 形状 + per-face UV
 *   textures/entity/warrior.png      ... 上記UVに合わせて手続き的に描いたアトラス
 *
 * 使い方:  node tools/gen_warrior.js      (このリソースパックのルートから)
 *
 * 設計方針は gen_tank.js / gen_airship.js と同じ:
 *   - 形状はこのファイル内の cube 定義がソース。Blockbench で開ける普通の geo を吐くが、
 *     UV はここが正なので、形をいじったら必ず再生成すること。
 *   - UV は box UV ではなく per-face UV。面ごとに 1テクセル=1モデル単位。
 *   - 塗りはモデル空間の座標を受け取る関数。左右対称(|x| 依存)の模様だけを使う。
 *   - キューブは必ず整数座標(アトラスの矩形幅がテクセル数と一致する必要があるため)。
 *   - 同じ向きの面が同一平面で重なると z-fighting するので、重ねるパーツは必ずどこかの
 *     座標をずらす(接するだけの背中合わせは面同士が逆向きなので安全)。
 *
 * 座標系: 16単位 = 1ブロック。正面は -Z(scripts/unitModels.js の yawTowards が
 *   yaw=0 で -Z を向く前提)。y=0 が接地面。
 *   全高: 冠毛の先で 51(約3.2ブロック)、槍の穂先で 50。左右は盾の縁 x=-16 〜 槍 x=13。
 *
 * 造形: 青銅器時代の重装歩兵。冠毛付きの兜 + 鱗革の胸甲 + 赤い上衣 + 脛当て、
 *   右手に石突きを地面へ突いた長槍、左腕に円盾(正面に戦車・飛行船と同じ赤白の国籍マーク)。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const RP = path.resolve(__dirname, "..");

/* ============================ パレット ============================ */
const C = {
    skin:        [0xA6, 0x74, 0x4E],
    skinDark:    [0x74, 0x4D, 0x33],
    skinLight:   [0xC2, 0x91, 0x66],
    hair:        [0x33, 0x22, 0x18],
    eye:         [0xE2, 0xDC, 0xCE],
    pupil:       [0x27, 0x1E, 0x18],
    tunic:       [0x9A, 0x33, 0x2C], // 上衣の赤
    tunicDark:   [0x64, 0x1E, 0x1B],
    tunicLight:  [0xBE, 0x50, 0x42],
    leather:     [0x60, 0x40, 0x27],
    leatherDark: [0x43, 0x2D, 0x1B],
    leatherLight:[0x91, 0x69, 0x42],
    bronze:      [0xBE, 0x8B, 0x3E],
    bronzeDark:  [0x74, 0x51, 0x20],
    bronzeLight: [0xE8, 0xC7, 0x7B],
    verdigris:   [0x4F, 0x8C, 0x74], // 緑青
    wood:        [0x8A, 0x69, 0x41],
    woodDark:    [0x59, 0x42, 0x28],
    crest:       [0x93, 0x24, 0x20], // 冠毛(染めた馬毛)
    crestDark:   [0x48, 0x11, 0x10],
    red:         [0xA8, 0x32, 0x26], // 国籍マーク(戦車・飛行船と共通)
    redDark:     [0x74, 0x20, 0x17],
    white:       [0xD6, 0xD0, 0xC2],
    black:       [0x1E, 0x1C, 0x1A],
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const jit = (c, n) => [clamp(c[0] + n, 0, 255), clamp(c[1] + n, 0, 255), clamp(c[2] + n, 0, 255)];
function hash(x, y, z) {
    const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return h - Math.floor(h);
}
const smooth = (t) => t * t * (3 - 2 * t);
/** 格子サイズ s の値ノイズ。布のムラ・金属の打ち出し痕用。 */
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
const nz = (p, k) => (hash(p.x * 1.7, p.y * 2.3, p.z * 1.1) - 0.5) * k;

/** 面の外周を暗くしてパーツの輪郭を立たせる(細い面には掛けない)。 */
function edge(c, q, amt) {
    if (q.fw <= 2 || q.fh <= 2) return c;
    if (q.u === 0 || q.v === 0 || q.u === q.fw - 1 || q.v === q.fh - 1) return mix(c, C.black, amt);
    return c;
}

/** 面の向きによる明暗。上面は明るく、下面と背面は暗く。 */
function faceShade(c, f) {
    if (f === "up") return mix(c, C.white, 0.10);
    if (f === "down") return mix(c, C.black, 0.45);
    if (f === "south") return mix(c, C.black, 0.16);
    if (f === "north") return mix(c, C.white, 0.04);
    return c;
}

/* ============================ 素材の下地 ============================ */
function skinBase(p) {
    const n = vnoise(Math.abs(p.x) * 1.3, p.y * 1.3, p.z * 1.3, 5);
    return mix(C.skin, n > 0.5 ? C.skinLight : C.skinDark, Math.abs(n - 0.5) * 0.55);
}

/** 布地。ノイズのムラ + |x| 基準の縦皺(左右対称に繋がる)。 */
function clothBase(p, base, dark) {
    const n = vnoise(Math.abs(p.x) * 1.2, p.y * 0.9, p.z * 1.2, 4);
    let c = mix(base, dark, 0.30 * n);
    const fold = Math.sin(Math.abs(p.x) * 1.15 + p.z * 0.35);
    c = mix(c, dark, clamp(0.28 * (0.5 - fold * 0.5), 0, 0.28));
    return c;
}

/** 打ち出しの青銅。緑青の点と磨き上がった面を散らす。 */
function bronzeBase(p) {
    const n = vnoise(Math.abs(p.x) * 1.4, p.y * 1.4, p.z * 1.4, 4);
    let c = mix(C.bronze, n > 0.5 ? C.bronzeLight : C.bronzeDark, Math.abs(n - 0.5) * 0.7);
    const h = hash(p.x * 3.1, p.y * 2.7, p.z * 1.9);
    if (h > 0.972) c = mix(c, C.verdigris, 0.55);
    else if (h > 0.958) c = mix(c, C.bronzeLight, 0.5);
    return c;
}

/* ============================ マテリアル ============================ */
/* (face, p={x,y,z}(モデル空間), q={u,v,fw,fh,cube}) -> [r,g,b] */

const MAT = {
    skin: (f, p, q) => jit(faceShade(edge(skinBase(p), q, 0.20), f), nz(p, 8)),

    /*
     * 頭部。正面(north)だけ顔を描く。兜のドーム(y>=39)・頬当て(|x|>=4)・鼻当て(|x|<1)に
     * 隠れない帯 y=33.5〜38.5 / |x|=1.5〜3.5 に眉・目・髭が収まるよう配置している。
     */
    head: (f, p, q) => {
        let c = skinBase(p);
        if (f === "north") {
            const ax = Math.abs(p.x);
            if (p.y > 38) c = mix(c, C.black, 0.42);                        // 兜のひさしの影
            else if (p.y > 37) c = mix(c, C.hair, 0.55);                    // 眉
            else if (p.y > 36) {                                            // 目(Steve と同じ 2px。外が白目、内が瞳)
                if (ax > 3 && ax < 4) c = mix(C.eye, C.skinDark, 0.18);
                else if (ax > 2 && ax < 3) c = C.pupil;
                else c = mix(c, C.skinDark, 0.45);
            } else if (p.y > 35) c = mix(c, C.hair, ax < 3 ? 0.55 : 0.30);  // 口髭
            else c = mix(c, C.hair, 0.72 + 0.12 * vnoise(ax, p.y, p.z, 3)); // 顎髭
        } else if (f === "south" || f === "up") {
            c = mix(c, C.hair, 0.80);                                       // 後頭部は髪
        } else {
            c = mix(c, C.hair, p.y > 36 ? 0.62 : 0.30);                     // 側頭は髪と頬の境
        }
        return jit(faceShade(edge(c, q, 0.16), f), nz(p, 7));
    },

    bronze: (f, p, q) => jit(faceShade(edge(bronzeBase(p), q, 0.34), f), nz(p, 8)),

    /* 兜のドーム。上ほど明るく、ひさしの縁は暗く落とす。 */
    helmet: (f, p, q) => {
        let c = bronzeBase(p);
        c = mix(c, C.bronzeLight, clamp((p.y - 39) / 6, 0, 1) * 0.30);
        if (f === "down") c = mix(c, C.black, 0.50);
        if (p.y < 40) c = mix(c, C.bronzeDark, 0.35);
        return jit(faceShade(edge(c, q, 0.30), f), nz(p, 8));
    },

    /* 冠毛。前後(z)方向に房が並ぶので z を刻んで縞にする。 */
    crest: (f, p, q) => {
        const s = hash(Math.floor(p.z * 2), 3, Math.floor(p.x * 2));
        let c = mix(C.crestDark, C.crest, 0.30 + 0.70 * s);
        if (((Math.floor(p.z) % 2) + 2) % 2 === 0) c = mix(c, C.black, 0.22);
        c = mix(c, C.black, clamp((46.5 - p.y) / 3, 0, 0.45));              // 根本は暗い
        if (f === "up") c = mix(c, C.crest, 0.35);
        return jit(edge(c, q, 0.18), nz(p, 10));
    },

    tunic: (f, p, q) => jit(faceShade(edge(clothBase(p, C.tunic, C.tunicDark), q, 0.20), f), nz(p, 9)),

    /* 上衣の裾。下端に白の縁取りと青銅の飾り帯、いちばん下は房飾り。 */
    tunicHem: (f, p, q) => {
        let c = clothBase(p, C.tunic, C.tunicDark);
        if (p.y < 14.2) {
            c = (q.u % 2 === 0) ? mix(C.tunicDark, C.black, 0.35) : mix(c, C.tunicLight, 0.25);
        } else if (p.y < 15.2) c = mix(C.white, C.tunicDark, 0.20);
        else if (p.y < 16.2) c = mix(c, C.bronze, 0.55);
        return jit(faceShade(edge(c, q, 0.18), f), nz(p, 9));
    },

    /*
     * 鱗革の胸甲。3段 x 4列で鱗を敷き詰め、上端を光らせ下端に影を落とす。
     * 段ごとに半列ずらして互い違いにするのは実物の綴じ方と同じ。
     */
    cuirass: (f, p, q) => {
        const rowH = 3, colW = 4;
        const row = Math.floor((41 - p.y) / rowH);
        const yy = ((41 - p.y) % rowH + rowH) % rowH;
        const cu = ((q.u + ((((row % 2) + 2) % 2) ? colW / 2 : 0)) % colW + colW) % colW;
        let c = mix(C.leather, C.leatherDark, 0.20 + 0.35 * vnoise(Math.abs(p.x), p.y, p.z, 4));
        if (yy < 1) c = mix(c, C.leatherLight, 0.38);                       // 鱗の上端(光)
        if (yy > rowH - 1.2) c = mix(c, C.black, 0.34);                     // 鱗の下端(影)
        if (cu === 0) c = mix(c, C.black, 0.26);                            // 鱗の継ぎ目
        if (yy > 1 && yy < 2 && cu === 2) c = mix(c, C.bronze, 0.70);       // 綴じの鋲
        return jit(faceShade(edge(c, q, 0.24), f), nz(p, 8));
    },

    /* 帯。縫い目の線と、正面中央の青銅の留め金。 */
    belt: (f, p, q) => {
        let c = mix(C.leather, C.leatherDark, 0.35 + 0.25 * vnoise(p.x, p.y, p.z, 3));
        if (q.v === 0 || q.v === q.fh - 1) c = mix(c, C.leatherDark, 0.55);
        if (q.u % 3 === 0 && q.v > 0 && q.v < q.fh - 1) c = mix(c, C.leatherLight, 0.30);
        if (f === "north" && Math.abs(p.x) < 2.5 && p.y > 21.4 && p.y < 23.6) {
            c = (Math.abs(p.x) < 1.5 && p.y > 22 && p.y < 23) ? mix(C.bronzeDark, C.black, 0.40) : bronzeBase(p);
        }
        return jit(faceShade(edge(c, q, 0.26), f), nz(p, 8));
    },

    leather: (f, p, q) => {
        let c = mix(C.leather, C.leatherDark, 0.28 + 0.30 * vnoise(Math.abs(p.x) + 2, p.y, p.z, 3));
        if (q.u % 4 === 0) c = mix(c, C.leatherLight, 0.22);                // 巻き革の重なり
        return jit(faceShade(edge(c, q, 0.28), f), nz(p, 9));
    },

    /* 槍の柄。木目 + 握りの革巻き + 青銅の補強帯。 */
    wood: (f, p, q) => {
        let c = mix(C.wood, C.woodDark, 0.25 + 0.45 * vnoise(Math.abs(p.x) * 3, p.y * 0.35, p.z * 3, 3));
        if (p.y > 12 && p.y < 19) {
            c = mix(C.leather, C.leatherDark, (((Math.floor(p.y) % 2) + 2) % 2) ? 0.55 : 0.15);
        } else if (Math.abs(p.y - 20.5) < 1 || Math.abs(p.y - 10.5) < 1) {
            c = bronzeBase(p);
        }
        return jit(faceShade(edge(c, q, 0.30), f), nz(p, 8));
    },

    /* 穂先。中央に稜線を通し、外側の刃を明るく研ぎ出す。 */
    blade: (f, p, q) => {
        let c = bronzeBase(p);
        const ridge = Math.abs(p.x - 9.5);
        c = mix(c, C.bronzeLight, clamp((1.6 - ridge) / 1.6, 0, 1) * 0.45);
        c = mix(c, C.white, clamp((ridge - 2.2) / 1.5, 0, 1) * 0.35);
        if (f === "north" || f === "south") c = mix(c, C.bronzeDark, 0.10);
        return jit(faceShade(edge(c, q, 0.30), f), nz(p, 7));
    },

    /*
     * 円盾。正面(north)は中心 (-9, 24) からの半径で塗り分け、外周に青銅の縁と鋲、
     * 内側に戦車・飛行船と同じ赤白の国籍マークを描く。裏面は板を張った木地。
     */
    shield: (f, p, q) => {
        const dx = p.x + 9, dy = p.y - 24;
        const r = Math.hypot(dx, dy);
        let c;
        if (f === "north") {
            if (r > 6.2) {
                c = bronzeBase(p);
                const a = Math.atan2(dy, dx);
                if (Math.cos(a * 8) > 0.86) c = mix(c, C.bronzeLight, 0.55); // 縁の鋲
                c = mix(c, C.bronzeDark, clamp((r - 7.5) / 2, 0, 0.5));
            } else if (r > 5.2) c = mix(C.redDark, C.black, 0.20);
            else if (r > 4.0) c = mix(C.red, C.redDark, 0.15);
            else if (r > 2.8) c = mix(C.white, C.red, 0.10);
            else c = C.red;
            if (r <= 6.2) {
                c = mix(c, C.woodDark, 0.10 * vnoise(Math.abs(p.x), p.y, 0, 3));
                if (((Math.floor(p.x) % 5) + 5) % 5 === 0) c = mix(c, C.black, 0.14); // 板の継ぎ目
            }
        } else if (f === "south") {
            c = mix(C.wood, C.woodDark, 0.35 + 0.35 * vnoise(p.x, p.y * 0.4, p.z, 3));
            if (((Math.floor(p.x) % 5) + 5) % 5 === 0) c = mix(c, C.woodDark, 0.55);
            c = mix(c, C.black, 0.20);
        } else {
            c = mix(bronzeBase(p), C.bronzeDark, 0.25);                     // 縁金
        }
        return jit(faceShade(edge(c, q, 0.26), f), nz(p, 8));
    },
};

// flat 指定の面が参照する単色パッチ
const SWATCH = {
    skin: C.skinDark, head: C.skinDark, bronze: C.bronzeDark, helmet: C.bronzeDark,
    crest: C.crestDark, tunic: C.tunicDark, tunicHem: C.tunicDark, cuirass: C.leatherDark,
    belt: C.leatherDark, leather: C.leatherDark, wood: C.woodDark, blade: C.bronzeDark,
    shield: C.woodDark,
};

/* ============================ モデル定義 ============================ */
const cubes = [];

function B(bone, x0, y0, z0, x1, y1, z1, mat, opts) {
    cubes.push(Object.assign({ bone, x0, y0, z0, x1, y1, z1, mat }, opts || {}));
}
function mirrorOpts(opts) {
    const o = Object.assign({}, opts || {});
    // 左右で「内側/外側」が入れ替わるので、east/west の flat 指定も入れ替える
    if (o.flat) o.flat = o.flat.map((f) => (f === "east" ? "west" : f === "west" ? "east" : f));
    return o;
}
/** 同じボーン内で x>0 側を左右対称に2個置く(胴に付く肩当てなど)。 */
function BM(bone, x0, y0, z0, x1, y1, z1, mat, opts) {
    B(bone, x0, y0, z0, x1, y1, z1, mat, opts);
    B(bone, -x1, y0, z0, -x0, y1, z1, mat, mirrorOpts(opts));
}
/** 左右で別ボーンに分かれる部品(腕・脚)。x>0 側の座標を渡す。 */
function LR(boneR, boneL, x0, y0, z0, x1, y1, z1, mat, opts) {
    B(boneR, x0, y0, z0, x1, y1, z1, mat, opts);
    B(boneL, -x1, y0, z0, -x0, y1, z1, mat, mirrorOpts(opts));
}
const D = ["down"];   // 接地面。どの角度からも見えない

/* ---- 脚(x=1..6)。爪先が前(-Z)に出る草鞋、脛当ては前へ少し張り出す ---- */
LR("leg_r", "leg_l", 1,  0, -5,  6,  2,  3, "leather", { flat: D });  // 草鞋
LR("leg_r", "leg_l", 1,  2, -3,  6,  6,  3, "skin");                  // 足首
LR("leg_r", "leg_l", 1,  6, -4,  6, 11,  3, "bronze");                // 脛当て
LR("leg_r", "leg_l", 1, 11, -3,  6, 15,  3, "skin");                  // 腿

/* ---- 胴。裾 -> 腰 -> 帯 -> 胸甲 -> 首 の順に積む ---- */
B("body", -8, 12, -5, 8, 19, 5, "tunicHem");
B("body", -7, 19, -4, 7, 23, 4, "tunic");
B("body", -8, 21, -5, 8, 24, 5, "belt");
B("body", -7, 23, -4, 7, 31, 4, "cuirass");
BM("body", 6, 27, -5, 10, 32, 5, "bronze");   // 肩当て
B("body", -3, 30, -3, 3, 34, 3, "skin");      // 首

/* ---- 頭と兜 ---- */
B("head", -5, 33, -5, 5, 42, 4, "head");
B("head", -6, 39, -6, 6, 44, 5, "helmet");          // 兜のドーム
B("head", -5, 34,  4, 5, 40, 6, "helmet");          // 錣(後ろ首の垂れ)
LR("head", "head", 4, 34, -6, 6, 39, 1, "helmet");  // 頬当て
B("head", -1, 36, -7, 1, 41, -4, "helmet");         // 鼻当て
B("head", -2, 43, -5, 2, 45, 4, "bronze");          // 冠毛の台座
B("crest", -2, 45, -4, 2, 48, 3, "crest");          // 冠毛(前後に長い房)
B("crest", -2, 48, -2, 2, 51, 1, "crest");          // 中央だけ高く盛り上げる

/* ---- 腕(x=7..12)。袖 -> 前腕 -> 篭手 -> 拳 ---- */
LR("arm_r", "arm_l", 7, 25, -3, 12, 31, 3, "tunic");
LR("arm_r", "arm_l", 7, 20, -3, 12, 25, 3, "skin");
LR("arm_r", "arm_l", 7, 16, -4, 13, 20, 4, "leather");   // 篭手(外側にだけ張り出す)
LR("arm_r", "arm_l", 7, 13, -4, 12, 16, 3, "skin");      // 拳

/* ---- 槍(右手。石突きを地面に突いて立てている) ---- */
B("spear",  8,  0, -6, 11,  2, -3, "bronze", { flat: D });  // 石突き
B("spear",  8,  2, -6, 11, 34, -3, "wood");                 // 柄
B("spear",  7, 34, -7, 12, 37, -2, "bronze");               // 袋部
B("spear",  6, 37, -6, 13, 41, -3, "blade");                // 穂先(いちばん広い所)
B("spear",  7, 41, -6, 12, 45, -3, "blade");
B("spear",  8, 45, -5, 11, 48, -4, "blade");
B("spear",  9, 48, -5, 10, 50, -4, "blade");

/* ---- 円盾(左腕の前)。段を積んで丸みを出す ---- */
B("shield", -13, 15,  -8,  -5, 18, -5, "shield");
B("shield", -15, 18,  -8,  -3, 21, -5, "shield");
B("shield", -16, 21,  -8,  -2, 27, -5, "shield");
B("shield", -15, 27,  -8,  -3, 30, -5, "shield");
B("shield", -13, 30,  -8,  -5, 33, -5, "shield");
B("shield", -12, 21, -10,  -6, 27, -8, "bronze");           // 盾の臍(うず)
B("shield", -11, 22,  -6,  -7, 26, -3, "leather");          // 握り

/* ボーン階層 (name, parent, pivot)。アニメーションはこの軸で回す。 */
const BONES = [
    ["root", null, [0, 0, 0]],
    ["body", "root", [0, 15, 0]],
    ["head", "body", [0, 33, 0]],
    ["crest", "head", [0, 44, 0]],
    ["arm_r", "body", [9, 31, 0]],
    ["arm_l", "body", [-9, 31, 0]],
    ["spear", "arm_r", [9, 15, -4]],
    ["shield", "arm_l", [-9, 24, -6]],
    ["leg_r", "root", [3, 15, 0]],
    ["leg_l", "root", [-3, 15, 0]],
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
    for (const k of ["x0", "y0", "z0", "x1", "y1", "z1"]) {
        if (!Number.isInteger(cb[k])) throw new Error("整数でない座標: " + JSON.stringify(cb));
    }
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
            identifier: "geometry.civ.warrior",
            texture_width: TW,
            texture_height: TH,
            visible_bounds_width: 3,
            visible_bounds_height: 3.8,
            visible_bounds_offset: [0, 1.7, 0],
        },
        bones,
    }],
};

fs.writeFileSync(path.join(RP, "models/entity/warrior.geo.json"), JSON.stringify(geo, null, 2) + "\n");
fs.writeFileSync(path.join(RP, "textures/entity/warrior.png"), png);
console.log(`cubes=${cubes.length} faces=${rects.length} atlas=${TW}x${TH} png=${png.length}B`);
