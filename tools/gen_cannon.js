"use strict";
/*
 * gen_cannon.js -- civ:cannon(大砲)のモデル一式ジェネレータ
 *
 * 生成物:
 *   models/entity/cannon.geo.json  ... 形状 + per-face UV
 *   textures/entity/cannon.png     ... 上記UVに合わせて手続き的に描いたアトラス
 *
 * 使い方:  node tools/gen_cannon.js      (このリソースパックのルートから)
 *
 * 設計方針(gen_tank.js / gen_anti_air.js と同じ):
 *   - 形状はこのファイル内の cube 定義がソース。Blockbench で開ける普通の geo を吐くが、
 *     UV はここが正なので、形をいじったら必ず再生成すること。
 *   - UV は box UV ではなく per-face UV。面ごとに 1テクセル=1モデル単位。
 *   - 見えない面(接地面など)は flat 指定で単色パッチを共有する。
 *   - 塗りはモデル空間の座標を受け取る関数。左右対称(|x| 依存)か、
 *     車輪の中心からの距離のような「左右反転しても崩れない」模様だけを使う。
 *   - キューブは必ず整数座標(アトラスの矩形幅がテクセル数と一致する必要があるため)。
 *
 * 座標系: 16単位 = 1ブロック。砲口は -Z 方向(scripts/unitModels.js の yawTowards が
 *   yaw=0 で -Z を向く前提)。y=0 が接地面(車輪の下端と架尾が地面に着く)。
 *   前後は砲口 z=-36 〜 架尾の石突 z=42(78単位)で、1マス=5ブロック=80単位に収まる。
 *   左右は弾丸の山まで含めて x=-24〜24、全高は砲身の上端 y=36。
 *
 * 造形: 冶金術の時代の前装式野砲。木製の砲架(頬板)+ 鉄輪を嵌めた輻(や)車輪 +
 *   青銅の砲身。脇に砲弾の三角錐積みと弾薬箱、車軸には火薬桶を吊るしてある。
 *   カタパルト(石を投げる)との差が遠目でも分かるよう、長い砲身と大径の車輪で
 *   シルエットを作っている。
 *
 * 💡 【車輪は「同じ x 幅のキューブを (y,z) 平面で重ならないように敷き詰めた」もの】
 *   輪(felloe)もスポークも x 方向の幅が同じなので、(y,z) 平面で少しでも面積が重なると
 *   側面が同一平面で重なって z-fighting する。帯・スポークの矩形は必ず「辺で接するが
 *   面積は重ならない」ように取ること(WHEEL_BANDS / WHEEL_SPOKES のコメント参照)。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const RP = path.resolve(__dirname, "..");

/* ============================ パレット ============================ */
const C = {
    wood:        [0x7E, 0x5C, 0x35], // 砲架の樫材
    woodDark:    [0x4E, 0x38, 0x1F],
    woodLight:   [0xA1, 0x7C, 0x4C],
    iron:        [0x4A, 0x4C, 0x4E], // 鉄輪・帯金・車軸
    ironDark:    [0x26, 0x28, 0x2A],
    ironLight:   [0x7A, 0x80, 0x86],
    rust:        [0x6E, 0x46, 0x2B],
    bronze:      [0xB0, 0x86, 0x3B], // 砲身
    bronzeDark:  [0x6C, 0x4E, 0x1E],
    bronzeLight: [0xE0, 0xBC, 0x70],
    verdigris:   [0x4F, 0x8C, 0x74], // 緑青
    soot:        [0x2A, 0x26, 0x22], // 砲口の煤
    leather:     [0x5E, 0x40, 0x28], // 火薬桶の革帯
    leatherDark: [0x3C, 0x28, 0x18],
    rope:        [0x8E, 0x7A, 0x50],
    red:         [0xA8, 0x32, 0x26], // 国籍マーク(戦車・戦士と共通)
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
/** 格子サイズ s の値ノイズ。木目のムラ・鋳肌用。 */
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
/** 整数化した値の剰余(負数でも 0..m-1 に収める) */
const mod = (v, m) => ((Math.round(v) % m) + m) % m;

/** 面の外周を暗くしてパーツの輪郭を立たせる(細い面には掛けない)。 */
function edge(c, q, amt) {
    if (q.fw <= 2 || q.fh <= 2) return c;
    if (q.u === 0 || q.v === 0 || q.u === q.fw - 1 || q.v === q.fh - 1) return mix(c, C.black, amt);
    return c;
}

/** 面の向きによる明暗。上面は明るく、下面と背面は暗く。 */
function faceShade(c, f) {
    if (f === "up") return mix(c, C.white, 0.10);
    if (f === "down") return mix(c, C.black, 0.40);
    if (f === "south") return mix(c, C.black, 0.14);
    return c;
}

/* 面に沿った「横方向」の座標。木目や帯金を面をまたいで繋げるのに使う。 */
function alongOf(p, f) {
    return (f === "east" || f === "west") ? p.z : p.x;
}

/* 泥はね。地面に近いほど濃い。 */
function splash(c, p) {
    const t = clamp((9 - p.y) / 9, 0, 1);
    if (t <= 0) return c;
    const n = vnoise(p.x * 1.6, p.y * 3.0, p.z * 1.6, 4);
    if (n > 0.60) return mix(c, C.woodDark, (n - 0.60) * 1.5 * t);
    return c;
}

/* ============================ 素材の下地 ============================ */

/** 樫材。grainAlongZ なら長手(z)方向に、そうでなければ y 方向に木目が流れる。 */
function woodBase(p, grainAlongZ) {
    const along = grainAlongZ ? p.z : p.y;
    const across = grainAlongZ ? p.y : p.z;
    const g = vnoise(along * 0.25, across * 2.6, Math.abs(p.x) * 2.6, 4);
    let c = mix(C.wood, g > 0.5 ? C.woodLight : C.woodDark, Math.abs(g - 0.5) * 0.9);
    const h = hash(Math.floor(along / 7), Math.floor(across / 5), Math.floor(Math.abs(p.x) / 4));
    if (h > 0.955) c = mix(c, C.woodDark, 0.55);   // 節
    return c;
}

/** 錆の浮いた鍛鉄。 */
function ironBase(p) {
    const n = vnoise(p.x * 1.2, p.y * 1.2, p.z * 1.2, 5);
    let c = mix(C.iron, n > 0.5 ? C.ironLight : C.ironDark, Math.abs(n - 0.5) * 0.8);
    const h = hash(p.x * 2.9, p.y * 1.7, p.z * 3.3);
    if (h > 0.972) c = mix(c, C.rust, 0.55);
    return c;
}

/** 鋳造の青銅。緑青の点と磨き上がった面。 */
function bronzeBase(p) {
    const n = vnoise(Math.abs(p.x) * 1.4, p.y * 1.4, p.z * 1.4, 4);
    let c = mix(C.bronze, n > 0.5 ? C.bronzeLight : C.bronzeDark, Math.abs(n - 0.5) * 0.7);
    const h = hash(p.x * 3.1, p.y * 2.7, p.z * 1.9);
    if (h > 0.974) c = mix(c, C.verdigris, 0.5);
    else if (h > 0.960) c = mix(c, C.bronzeLight, 0.45);
    return c;
}

/* ============================ 車輪の寸法 ============================ */
/* 💡 材質関数(felloe/spoke/hub)がここを参照して「中心からの距離」で塗り分ける。
      車輪のキューブ位置を動かすときはこの3つも合わせること。 */
const WCY = 16, WCZ = 8, WR = 16;
const wheelR = (p) => Math.hypot(p.y - WCY, p.z - WCZ);

/* ============================ マテリアル ============================ */
/* (face, p={x,y,z}(モデル空間), q={u,v,fw,fh,cube}) -> [r,g,b] */

const MAT = {
    /*
     * 輪。踏面(上下前後を向く面)は鉄輪、側面は外周だけ鉄輪でその内側が木の輻(felloe)。
     * 💡 模様は車輪の中心からの距離だけで決めているので、左右の車輪で UV が反転しても崩れない。
     */
    felloe: (f, p, q) => {
        const r = wheelR(p);
        const tread = f !== "east" && f !== "west";
        let c;
        if (tread || r > WR - 2.5) {
            c = ironBase(p);
            // 鉄輪を留める鋲。円周に沿って等間隔に打つ。
            const ang = Math.atan2(p.y - WCY, p.z - WCZ) * (8 / Math.PI);
            if (mod(ang, 2) === 0) c = mix(c, C.ironLight, 0.45);
            if (tread && mod(alongOf(p, f), 4) === 0) c = mix(c, C.ironDark, 0.30);
        } else {
            c = woodBase(p, false);
            // 輻(木の輪)の継ぎ目。1/8周ごとに1枚。
            const ang = Math.atan2(p.y - WCY, p.z - WCZ) * (4 / Math.PI);
            if (mod(ang, 1) === 0) c = mix(c, C.woodDark, 0.55);
        }
        c = splash(c, p);
        return jit(faceShade(edge(c, q, 0.22), f), nz(p, 8));
    },

    /* スポーク。中心へ向かって暗くして、丸棒が奥へ潜っていくように見せる。 */
    spoke: (f, p, q) => {
        let c = woodBase(p, false);
        c = mix(c, C.woodDark, clamp((10 - wheelR(p)) / 10, 0, 1) * 0.35);
        if (f === "east" || f === "west") c = mix(c, C.woodLight, 0.12);
        c = splash(c, p);
        return jit(faceShade(edge(c, q, 0.26), f), nz(p, 9));
    },

    /*
     * 轂(こしき)。外側を向く面に戦車・戦士と同じ赤白の国籍マークを描く。
     * 💡 左右どちらの車輪でも「外側」が見えるので east/west の両方に同じ模様を描いている
     *    (内側を向く面は砲架に隠れて見えない)。
     */
    hub: (f, p, q) => {
        if (f === "east" || f === "west") {
            const r = wheelR(p);
            let c;
            if (r > 3.6) c = mix(ironBase(p), C.ironDark, 0.25);
            else if (r > 2.6) c = mix(C.redDark, C.black, 0.15);
            else if (r > 1.7) c = mix(C.white, C.red, 0.12);
            else c = C.red;
            return jit(edge(c, q, 0.20), nz(p, 7));
        }
        let c = mix(ironBase(p), C.ironDark, 0.20);
        if (mod(alongOf(p, f), 3) === 0) c = mix(c, C.ironLight, 0.25);
        return jit(faceShade(edge(c, q, 0.26), f), nz(p, 8));
    },

    /*
     * 砲架の頬板。長手方向の木目に、帯金とボルトを重ねる。
     * 💡 帯金は z 依存(左右対称)なので、面の UV が左右反転しても位置がずれない。
     */
    carriage: (f, p, q) => {
        let c = woodBase(p, true);
        if (mod(p.z, 12) === 0 || mod(p.z, 12) === 1) {
            c = mix(ironBase(p), C.ironDark, 0.15);                       // 帯金
            if (mod(p.y, 6) === 2) c = mix(c, C.ironLight, 0.40);         // 帯金のボルト
        } else if (mod(p.z, 6) === 3 && mod(p.y, 7) === 3) {
            c = mix(c, C.ironLight, 0.35);                                // 頬板を留めるボルト
        }
        if (f === "up") c = mix(c, C.woodLight, 0.14);
        c = splash(c, p);
        return jit(faceShade(edge(c, q, 0.24), f), nz(p, 9));
    },

    /* 平板の木材(横木・架尾の底板)。木目は z 方向。 */
    plank: (f, p, q) => {
        let c = woodBase(p, true);
        if (mod(p.x, 5) === 0) c = mix(c, C.woodDark, 0.50);              // 板の継ぎ目
        c = splash(c, p);
        return jit(faceShade(edge(c, q, 0.24), f), nz(p, 9));
    },

    /* 手木(てぎ。架尾に差した梃子)。先端は鉄鞘、握りは革巻き。 */
    handspike: (f, p, q) => {
        let c = woodBase(p, true);
        if (p.z > 32) c = mix(C.leather, C.leatherDark, mod(p.z, 2) ? 0.55 : 0.15);
        else if (p.z < 24) c = mix(ironBase(p), C.ironDark, 0.20);
        return jit(faceShade(edge(c, q, 0.28), f), nz(p, 8));
    },

    iron: (f, p, q) => {
        let c = ironBase(p);
        if (mod(alongOf(p, f), 5) === 0) c = mix(c, C.ironLight, 0.22);
        c = splash(c, p);
        return jit(faceShade(edge(c, q, 0.28), f), nz(p, 9));
    },

    /*
     * 青銅の砲身。z 方向に鋳出しの輪(astragal)が入り、砲口へ行くほど発砲の煤で汚れる。
     * 北面(=砲口)には同心の環と暗い砲腔を描いて「筒」に見せる。
     */
    bronze: (f, p, q) => {
        if (f === "north") {
            const cu = q.fw / 2 - 0.5, cv = q.fh / 2 - 0.5;
            const rr = Math.min(cu, cv);
            const r = Math.hypot(q.u - cu, q.v - cv);
            if (r > rr - 0.4) return jit(mix(C.bronzeDark, C.soot, 0.45), -4);
            if (r > rr - 2.0) return jit(mix(bronzeBase(p), C.soot, 0.35), 3);   // 砲口の面取り
            if (r > rr - 2.8) return jit(mix(C.bronzeLight, C.soot, 0.25), 2);   // 砲腔の縁
            return jit(mix(C.black, C.soot, 0.35), (hash(p.x, p.y, p.z) - 0.5) * 6);
        }
        let c = bronzeBase(p);
        // 鋳出しの輪。16単位ごとに1本(砲尾・第一補強・砲口の膨らみの境目に当たる)。
        if (mod(p.z, 16) === 0) c = mix(c, C.bronzeLight, 0.45);
        else if (mod(p.z, 16) === 1 || mod(p.z, 16) === 15) c = mix(c, C.bronzeDark, 0.40);
        c = mix(c, C.soot, clamp((-p.z - 20) / 18, 0, 1) * 0.45);         // 砲口寄りの煤
        if (f === "up") c = mix(c, C.bronzeLight, 0.10);
        return jit(faceShade(edge(c, q, 0.26), f), nz(p, 8));
    },

    /*
     * 砲弾(鋳鉄の球)。キューブは立方体なので、6面それぞれに「面の中心からの距離」で
     * 円い陰影を描いて球に見せる(砲口の穴と同じやり方)。
     * 💡 3次元の中心 cube.ctr からの距離で落とすと、上面がまるごと暗くなって
     *    平たい板に見えてしまう。ハイライトの位置決めにだけ ctr を使う。
     */
    ball: (f, p, q) => {
        const ctr = q.cube.ctr;
        const cu = q.fw / 2 - 0.5, cv = q.fh / 2 - 0.5;
        const r = Math.hypot(q.u - cu, q.v - cv) / Math.min(cu, cv);
        let c = mix(C.ironDark, C.iron, 0.35 + 0.55 * vnoise(p.x, p.y, p.z, 3));
        c = mix(c, C.black, clamp((r - 0.45) / 0.65, 0, 1) * 0.70);       // 縁を落として丸くする
        // 光の来る左上前(-x, +y, -z)側にハイライト
        const lit = clamp(((ctr[0] - p.x) + (p.y - ctr[1]) + (ctr[2] - p.z)) / 6, 0, 1);
        c = mix(c, C.ironLight, lit * 0.40 * clamp(1 - r, 0, 1));
        if (hash(p.x * 3.1, p.y * 2.3, p.z * 1.7) > 0.97) c = mix(c, C.rust, 0.45);
        return jit(faceShade(c, f), nz(p, 7));
    },

    /* 弾薬箱。板目・帯金・ステンシル。 */
    crate: (f, p, q) => {
        let c = woodBase(p, true);
        const along = alongOf(p, f);
        if (f === "up") {
            if (mod(p.z, 4) === 0) c = mix(c, C.woodDark, 0.45);
            if (mod(p.x, 9) === 0) c = mix(ironBase(p), C.ironDark, 0.25);
        } else if (f !== "down") {
            if (mod(p.y, 4) === 0) c = mix(c, C.woodDark, 0.45);
            if (mod(along, 9) === 0) c = mix(ironBase(p), C.ironDark, 0.25);
            else if (mod(p.y, 4) === 2 && mod(along, 9) > 2 && mod(along, 9) < 7) c = mix(c, C.white, 0.28);
        }
        c = splash(c, p);
        return jit(faceShade(edge(c, q, 0.26), f), nz(p, 9));
    },

    /* 火薬桶(木桶に鉄のたがと革帯)。 */
    bucket: (f, p, q) => {
        let c = woodBase(p, false);
        if (mod(p.y, 5) === 0) c = mix(ironBase(p), C.ironDark, 0.20);    // たが
        else if (mod(p.y, 5) === 2) c = mix(c, C.leather, 0.35);
        if (f === "up") c = mix(C.leather, C.leatherDark, 0.35);          // 蓋の革
        return jit(faceShade(edge(c, q, 0.26), f), nz(p, 8));
    },

    /* 桶を吊る縄。 */
    rope: (f, p, q) => {
        let c = mix(C.rope, C.woodDark, 0.20 + 0.35 * vnoise(p.x * 3, p.y * 3, p.z * 3, 2));
        if (mod(p.y, 2) === 0) c = mix(c, C.woodDark, 0.35);
        return jit(faceShade(c, f), nz(p, 8));
    },
};

// flat 指定の面が参照する単色パッチ(接地面など、絶対に見えない面)
const SWATCH = {
    felloe: C.ironDark, spoke: C.woodDark, hub: C.ironDark, carriage: C.woodDark,
    plank: C.woodDark, handspike: C.woodDark, iron: C.ironDark, bronze: C.bronzeDark,
    ball: C.ironDark, crate: C.woodDark, bucket: C.woodDark, rope: C.woodDark,
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
    if (o.ctr) o.ctr = [-o.ctr[0], o.ctr[1], o.ctr[2]];
    return o;
}
/** 同じボーン内で x>0 側を左右対称に2個置く。 */
function BM(bone, x0, y0, z0, x1, y1, z1, mat, opts) {
    B(bone, x0, y0, z0, x1, y1, z1, mat, opts);
    B(bone, -x1, y0, z0, -x0, y1, z1, mat, mirrorOpts(opts));
}
/** 左右で別ボーンに分かれる部品(車輪)。x>0 側の座標を渡す。 */
function LR(boneR, boneL, x0, y0, z0, x1, y1, z1, mat, opts) {
    B(boneR, x0, y0, z0, x1, y1, z1, mat, opts);
    B(boneL, -x1, y0, z0, -x0, y1, z1, mat, mirrorOpts(opts));
}
const D = ["down"];   // 接地面。どの角度からも見えない

/*
 * ---- 車輪 ----
 * 💡 輪は「z で切った縦帯」の集まり。帯どうしは辺で接するだけで面積が重ならないので、
 *    同じ x 幅でも側面が二重にならない。値は半径16・幅3の円環を帯の中央で近似したもの。
 *    [dz0, dz1, 外半径, 内半径](dz は車輪中心 WCZ からの相対)
 */
const WHEEL_BANDS = [
    [-3, 3, 16, 13],
    [3, 8, 15, 12], [-8, -3, 15, 12],
    [8, 13, 12, 8], [-13, -8, 12, 8],
];
/*
 * スポーク。[dz0, dz1, dy0, dy1]。上下前後の4本(まっすぐ)と、
 * 斜め4本(2個の階段で近似。角で接するだけなので輪までは繋がる)。
 */
const WHEEL_SPOKES = [
    [-1, 1, 6, 13], [-1, 1, -13, -6],        // 上下
    [-13, -6, -1, 1], [6, 13, -1, 1],        // 前後
    [4, 8, 8, 12], [8, 12, 4, 8],            // 後上(+z,+y)
    [4, 8, -12, -8], [8, 12, -8, -4],        // 後下
    [-8, -4, 8, 12], [-12, -8, 4, 8],        // 前上
    [-8, -4, -12, -8], [-12, -8, -8, -4],    // 前下
];

function wheel(boneR, boneL, x0, x1) {
    for (const [dz0, dz1, ro, ri] of WHEEL_BANDS) {
        LR(boneR, boneL, x0, WCY + ri, WCZ + dz0, x1, WCY + ro, WCZ + dz1, "felloe");
        LR(boneR, boneL, x0, WCY - ro, WCZ + dz0, x1, WCY - ri, WCZ + dz1, "felloe");
    }
    // 前後の端だけは輪の内側まで塞ぐ(ここで上下の帯が繋がる)
    LR(boneR, boneL, x0, WCY - 9, WCZ - 16, x1, WCY + 9, WCZ - 13, "felloe");
    LR(boneR, boneL, x0, WCY - 9, WCZ + 13, x1, WCY + 9, WCZ + 16, "felloe");
    for (const [dz0, dz1, dy0, dy1] of WHEEL_SPOKES) {
        LR(boneR, boneL, x0, WCY + dy0, WCZ + dz0, x1, WCY + dy1, WCZ + dz1, "spoke");
    }
    // 轂(外側へ張り出す。内側は砲架に隠れる)
    LR(boneR, boneL, x0 - 4, WCY - 4, WCZ - 4, x1 + 2, WCY + 4, WCZ + 4, "hub");
}
wheel("wheel_r", "wheel_l", 16, 19);

/* ---- 車軸(両輪を貫く鍛鉄の棒。頬板の間を通る) ---- */
B("carriage", -17, 13, 5, 17, 19, 11, "iron");

/*
 * ---- 砲架の頬板(左右2枚)。前が高く、後ろへ階段状に下がって架尾が接地する ----
 * 💡 同じボーン・同じ x 幅なので、隣り合う段は「z の面で接するが (y,z) では重ならない」
 *    ように取ってある(重ねると側面が同一平面で二重になり z-fighting する)。
 */
BM("carriage", 7, 18, -16, 11, 30, -2, "carriage");
BM("carriage", 7, 13, -2, 11, 24, 10, "carriage");
BM("carriage", 7, 8, 10, 11, 18, 22, "carriage");
BM("carriage", 7, 3, 22, 11, 12, 32, "carriage");
BM("carriage", 7, 0, 32, 11, 7, 40, "carriage", { flat: D });

/* ---- 頬板をつなぐ横木と、架尾の底板・石突 ---- */
B("carriage", -7, 20, -2, 7, 25, 2, "plank");
B("carriage", -7, 10, 12, 7, 15, 16, "plank");
B("carriage", -7, 0, 22, 7, 4, 40, "plank", { flat: D });
B("carriage", -7, 0, 40, 7, 4, 42, "iron", { flat: D });

/* ---- 砲耳を押さえる被せ金(砲身と一緒には動かないので carriage 側) ---- */
BM("carriage", 6, 32, -9, 12, 34, -3, "iron");

/* ---- 手木(架尾に差した梃子) ---- */
B("carriage", 2, 7, 20, 5, 11, 40, "handspike");

/* ---- 火薬桶(車軸から縄で吊るす。bucket ボーンで揺らす) ---- */
B("carriage", -1, 11, 7, 1, 13, 9, "rope");
B("bucket", -5, 4, 4, 5, 11, 12, "bucket");

/*
 * ---- 砲身(gun ボーン。砲耳 (0,30,-6) を軸に俯仰する) ----
 * 砲尾から砲口へ4段で細くしてある。砲口の丸い穴は bronze マテリアルが north 面に描く。
 */
B("gun", -3, 27, 16, 3, 33, 21, "bronze");        // 尾栓の球(cascabel)
B("gun", -6, 24, 0, 6, 36, 16, "bronze");         // 砲尾(いちばん太い)
B("gun", -5, 25, -14, 5, 35, 0, "bronze");        // 第一補強
B("gun", -4, 26, -30, 4, 34, -14, "bronze");      // 砲身中程
B("gun", -5, 25, -36, 5, 35, -30, "bronze");      // 砲口の膨らみ
BM("gun", 6, 28, -8, 12, 32, -4, "iron");         // 砲耳(頬板に載る)

/* ---- 砲弾の三角錐積み(右) ---- */
B("ball", 13, 0, 26, 18, 5, 31, "ball", { ctr: [15.5, 2.5, 28.5], br: 2.5, flat: D });
B("ball", 18, 0, 26, 23, 5, 31, "ball", { ctr: [20.5, 2.5, 28.5], br: 2.5, flat: D });
B("ball", 13, 0, 31, 18, 5, 36, "ball", { ctr: [15.5, 2.5, 33.5], br: 2.5, flat: D });
B("ball", 18, 0, 31, 23, 5, 36, "ball", { ctr: [20.5, 2.5, 33.5], br: 2.5, flat: D });
B("ball", 16, 5, 29, 21, 10, 34, "ball", { ctr: [18.5, 7.5, 31.5], br: 2.5 });

/* ---- 弾薬箱(左。2段に積む) ---- */
B("crate", -24, 0, 24, -13, 7, 34, "crate", { flat: D });
B("crate", -22, 7, 26, -15, 12, 33, "crate");

/*
 * ボーン階層 (name, parent, pivot[, rotation])。
 * 💡 gun の rotation で仰角を付けている(負 = 砲口(-Z)側が上を向く。gen_anti_air.js と同じ)。
 *    animations/cannon.animation.json の狙いの揺れはこの静止姿勢に加算される。
 */
const BONES = [
    ["root", null, [0, 0, 0]],
    ["carriage", "root", [0, 0, 0]],
    ["wheel_r", "carriage", [17, WCY, WCZ]],
    ["wheel_l", "carriage", [-17, WCY, WCZ]],
    ["gun", "carriage", [0, 30, -6], [-5, 0, 0]],
    ["bucket", "carriage", [0, 12, 8]],
    // 💡 弾丸の山と弾薬箱は地面に置いてあるだけなので、砲架(carriage)ではなく root の子。
    //    carriage を旋回させるアニメーションを付けても一緒に回らない。
    ["ball", "root", [0, 0, 0]],
    ["crate", "root", [0, 0, 0]],
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
            identifier: "geometry.civ.cannon",
            texture_width: TW,
            texture_height: TH,
            visible_bounds_width: 5,
            visible_bounds_height: 3,
            visible_bounds_offset: [0, 1.2, 0],
        },
        bones,
    }],
};

fs.writeFileSync(path.join(RP, "models/entity/cannon.geo.json"), JSON.stringify(geo, null, 2) + "\n");
fs.writeFileSync(path.join(RP, "textures/entity/cannon.png"), png);
console.log(`cubes=${cubes.length} faces=${rects.length} atlas=${TW}x${TH} png=${png.length}B`);
