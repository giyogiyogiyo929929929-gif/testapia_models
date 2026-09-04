"use strict";
/*
 * gen_artillery.js -- civ:artillery(近代砲兵)のモデル一式ジェネレータ
 *
 * 生成物:
 *   models/entity/artillery.geo.json  ... 形状 + per-face UV
 *   textures/entity/artillery.png     ... 上記UVに合わせて手続き的に描いたアトラス
 *
 * 使い方:  node tools/gen_artillery.js      (このリソースパックのルートから)
 *
 * 設計方針(gen_tank.js / gen_anti_air.js と同じ):
 *   - 形状はこのファイル内の cube 定義がソース。UV はここが正なので、
 *     形をいじったら必ず再生成すること。
 *   - UV は box UV ではなく per-face UV。面ごとに 1テクセル=1モデル単位。
 *   - 見えない面(接地面など)は flat 指定で単色パッチを共有する。
 *   - 塗りはモデル空間の座標を受け取る関数。左右対称(|x| 依存)か、
 *     車輪の中心からの距離のような「左右反転しても崩れない」模様だけを使う。
 *   - キューブは必ず整数座標(アトラスの矩形幅がテクセル数と一致する必要があるため)。
 *
 * 座標系: 16単位 = 1ブロック。砲口は -Z 方向(scripts/unitModels.js の yawTowards が
 *   yaw=0 で -Z を向く前提)。y=0 が接地面(タイヤ・駐鋤(ちゅうじょ)・射撃ジャッキが着く)。
 *   前後は砲口制退器 z=-42 〜 駐鋤 z=38(80単位)でちょうど1マス(5ブロック)。
 *   左右は弾薬箱まで含めて x=-26〜26、全高は防盾の折り返しで y=43。
 *
 * 造形: 産業化の時代の開脚式(スプリットトレイル)牽引榴弾砲。ゴムタイヤ + 開いた2本の
 *   脚 + 防盾 + 砲口制退器付きの長砲身。大砲(gen_cannon.js。木の砲架に青銅砲身)から
 *   一目で世代が上がったと分かるよう、オリーブドラブの鋼と直線的な輪郭で作ってある。
 *
 * 💡 【砲身の俯仰と防盾の隙間】
 *   cradle(砲身)は mount(旋回架)の中で上下する。防盾は |x|>6 の左右2枚に分けてあり、
 *   中央 |x|<6 を空けてそこを砲身と駐退機が通る。防盾の上に横板を渡すと、仰角を付けた
 *   ときに駐退機が突き抜けるので渡していない。防盾を広げるときはこの隙間を潰さないこと。
 *
 * 💡 【脚(トレイル)は階段で開き角を作っている】
 *   ボーンの rotation で開くとプレビュー(tools/preview_model.js は回転を無視する)が
 *   嘘になるため、後ろへ行くほど外側へずれるキューブの階段で表現している。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const RP = path.resolve(__dirname, "..");

/* ============================ パレット ============================ */
/* 💡 陸戦装備は戦車(gen_tank.js)・対空砲(gen_anti_air.js)と同じオリーブドラブ系。 */
const C = {
    olive:      [0x4C, 0x55, 0x3A],
    oliveLight: [0x62, 0x6E, 0x4C],
    oliveDark:  [0x34, 0x3C, 0x28],
    steel:      [0x45, 0x49, 0x4C],
    steelDark:  [0x25, 0x28, 0x2A],
    steelLight: [0x6C, 0x72, 0x78],
    gunmetal:   [0x33, 0x36, 0x39], // 砲身の焼き入れ色
    heat:       [0x6E, 0x5C, 0x4C], // 砲口寄りの焼け
    rubber:     [0x2B, 0x2B, 0x2D], // タイヤ
    rubberLight:[0x45, 0x45, 0x48],
    brass:      [0xB0, 0x8A, 0x44], // 薬莢
    brassDark:  [0x76, 0x5B, 0x2B],
    wood:       [0x77, 0x5C, 0x39], // 弾薬箱
    woodDark:   [0x4F, 0x3C, 0x25],
    canvas:     [0x7C, 0x6D, 0x4E], // 砲手席の帆布
    canvasDark: [0x55, 0x4A, 0x36],
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
    if (f === "up") return mix(c, C.white, 0.09);
    if (f === "down") return mix(c, C.black, 0.38);
    if (f === "south") return mix(c, C.black, 0.12);
    return c;
}

/* 面に沿った「横方向」の座標。溶接線・鋲列を面をまたいで繋げるのに使う。 */
function alongOf(p, f) {
    return (f === "east" || f === "west") ? p.z : p.x;
}

/* 泥はね。地面に近いほど濃い。 */
function splash(c, p) {
    const t = clamp((10 - p.y) / 10, 0, 1);
    if (t <= 0) return c;
    const n = vnoise(p.x * 1.6, p.y * 3.0, p.z * 1.6, 4);
    if (n > 0.58) return mix(c, C.woodDark, (n - 0.58) * 1.4 * t);
    return c;
}

/** オリーブドラブの下地に鋲列・溶接線・塗装の剥がれを重ねる。 */
function oliveBase(p, f) {
    let c = mix(C.olive, C.oliveDark, 0.15 + 0.35 * vnoise(p.x * 0.9, p.y * 0.7, p.z * 0.8, 12));
    const along = Math.round(Math.abs(alongOf(p, f)));
    if (mod(p.y, 7) === 0 && mod(along, 4) === 0) c = mix(c, C.steelLight, 0.28);   // 鋲
    if (mod(p.y, 7) === 4) c = mix(c, C.oliveDark, 0.18);                           // 溶接線
    if (hash(p.x * 2.3, p.y * 1.7, p.z * 3.1) > 0.988) c = mix(c, C.steelLight, 0.35);
    return c;
}

/* ============================ 車輪の寸法 ============================ */
/* 💡 tire マテリアルがここを参照して「中心からの距離」で塗り分ける。
      車輪のキューブ位置を動かすときはこの3つも合わせること。 */
const WCY = 14, WCZ = 6, WR = 14;
const wheelR = (p) => Math.hypot(p.y - WCY, p.z - WCZ);

/* ============================ マテリアル ============================ */
/* (face, p={x,y,z}(モデル空間), q={u,v,fw,fh,cube}) -> [r,g,b] */

const MAT = {
    /* 砲架・脚・車軸箱の装甲鋼。 */
    armor: (f, p, q) => {
        let c = oliveBase(p, f);
        if (f === "up") c = mix(c, C.oliveLight, 0.12);
        c = splash(c, p);
        return jit(faceShade(edge(c, q, 0.24), f), nz(p, 8));
    },

    /*
     * 防盾。上端に白い識別帯、左右の板それぞれの中央に赤白の国籍マークを描く。
     * 💡 マークは |x| と板の中心からの距離だけで決めているので、面の UV が
     *    左右反転しても位置がずれない(README「触るときの注意」参照)。
     */
    shield: (f, p, q) => {
        let c = oliveBase(p, f);
        if (f === "north" && Math.abs(p.x) > 6) {
            const r = Math.hypot(Math.abs(p.x) - 14, p.y - 28);
            if (r < 5.2) {
                if (r > 4.2) c = mix(c, C.black, 0.35);
                else if (r > 3.0) c = mix(C.redDark, C.black, 0.15);
                else if (r > 1.9) c = mix(C.white, C.red, 0.12);
                else c = C.red;
            }
        }
        if (p.y > 38) c = mix(c, C.white, 0.22);                // 上端の識別帯
        else if (Math.round(p.y) === 38) c = mix(c, C.black, 0.30);
        if (f === "north") c = mix(c, C.steelLight, 0.08);      // 正面は擦れて明るい
        c = splash(c, p);
        return jit(faceShade(edge(c, q, 0.26), f), nz(p, 8));
    },

    /* 駐退復座機・旋回台・脚の金具などの鋼材。 */
    steel: (f, p, q) => {
        let c = mix(C.steel, C.steelDark, 0.25 + 0.30 * vnoise(p.x, p.y, p.z, 5));
        if (mod(alongOf(p, f), 4) === 0) c = mix(c, C.steelLight, 0.18);
        if (hash(p.x * 1.9, p.y * 2.7, p.z * 1.1) > 0.99) c = mix(c, C.rust, 0.45);
        c = splash(c, p);
        return jit(faceShade(edge(c, q, 0.30), f), nz(p, 9));
    },

    /*
     * 砲身。放熱の輪が入り、砲口へ行くほど焼けて色が変わる。
     * 砲口側の面は砲口制退器に塞がれるので、丸い砲腔は brake 側で描く。
     */
    gun: (f, p, q) => {
        const t = clamp((-p.z - 10) / 26, 0, 1);
        let c = mix(C.gunmetal, C.steel, 0.25 + 0.30 * vnoise(p.x, p.y, p.z, 6));
        if (mod(p.z, 6) === 0) c = mix(c, C.steelDark, 0.28);
        else if (mod(p.z, 6) === 1) c = mix(c, C.steelLight, 0.14);
        c = mix(c, C.heat, t * 0.40);
        if (f === "up") c = mix(c, C.steelLight, 0.10);
        return jit(faceShade(edge(c, q, 0.28), f), nz(p, 8));
    },

    /*
     * 砲口制退器。北面に同心の環と暗い砲腔を描き、側面には発射ガスを逃がす溝を刻む。
     */
    brake: (f, p, q) => {
        if (f === "north") {
            const cu = q.fw / 2 - 0.5, cv = q.fh / 2 - 0.5;
            const rr = Math.min(cu, cv);
            const r = Math.hypot(q.u - cu, q.v - cv);
            if (r > rr - 0.4) return jit(mix(C.gunmetal, C.steelDark, 0.35), -4);
            if (r > rr - 2.2) return jit(mix(C.steelLight, C.steel, 0.30), 3);   // 砲口の環
            return jit(mix(C.black, C.steelDark, 0.20), (hash(p.x, p.y, p.z) - 0.5) * 6);
        }
        let c = mix(C.gunmetal, C.steelDark, 0.20 + 0.30 * vnoise(p.x, p.y, p.z, 4));
        if (mod(p.z, 3) === 0) c = mix(c, C.black, 0.55);                       // 排気の溝
        else if (mod(p.z, 3) === 1) c = mix(c, C.steelLight, 0.20);
        c = mix(c, C.heat, 0.25);
        return jit(faceShade(edge(c, q, 0.26), f), nz(p, 8));
    },

    /*
     * 車輪。外周はゴムタイヤ(斜めのラグ)、内側は鋼のホイールディスク(6つの軽め穴とハブ)。
     * 💡 軽め穴は 60度おき=左右反転しても同じ配置になるので、左右の車輪で崩れない。
     */
    tire: (f, p, q) => {
        const r = wheelR(p);
        const side = f === "east" || f === "west";
        if (!side || r > 9.5) {
            let c = mix(C.rubber, C.rubberLight, 0.18 + 0.30 * vnoise(p.x, p.y * 1.4, p.z * 1.4, 3));
            const ang = Math.atan2(p.y - WCY, p.z - WCZ) * (18 / Math.PI);
            if (mod(ang, 2) === 0) c = mix(c, C.rubberLight, 0.30);            // トレッドのラグ
            if (side && r < 11) c = mix(c, C.black, 0.30);                     // タイヤの内輪
            c = splash(c, p);
            return jit(faceShade(edge(c, q, 0.20), f), nz(p, 6));
        }
        let c = mix(C.olive, C.oliveDark, 0.30 + 0.30 * vnoise(p.x, p.y, p.z, 6));
        const ang = Math.atan2(p.y - WCY, p.z - WCZ);
        const hx = Math.cos(Math.round(ang / (Math.PI / 3)) * (Math.PI / 3)) * 6;
        const hy = Math.sin(Math.round(ang / (Math.PI / 3)) * (Math.PI / 3)) * 6;
        if (Math.hypot(p.z - WCZ - hx, p.y - WCY - hy) < 2.4) c = mix(C.black, C.steelDark, 0.35); // 軽め穴
        if (r < 3.2) c = mix(C.steel, C.steelDark, 0.30);                      // ハブ
        if (r > 8.6) c = mix(c, C.steelDark, 0.35);                            // リムの縁
        c = splash(c, p);
        return jit(edge(c, q, 0.22), nz(p, 7));
    },

    /* 弾薬箱(木箱)。板目・帯金・ステンシル。 */
    crate: (f, p, q) => {
        let c = mix(C.wood, C.woodDark, 0.20 + 0.45 * vnoise(p.x * 2.2, p.y, p.z * 0.6, 5));
        const along = alongOf(p, f);
        if (f === "up") {
            if (mod(p.z, 4) === 0) c = mix(c, C.woodDark, 0.45);
            if (mod(p.x, 9) === 0) c = mix(c, C.steelDark, 0.35);
        } else if (f !== "down") {
            if (mod(p.y, 4) === 0) c = mix(c, C.woodDark, 0.45);
            if (mod(along, 9) === 0) c = mix(c, C.steelDark, 0.35);
            else if (mod(p.y, 4) === 2 && mod(along, 9) > 2 && mod(along, 9) < 7) c = mix(c, C.white, 0.28);
        }
        c = splash(c, p);
        return jit(faceShade(edge(c, q, 0.28), f), nz(p, 9));
    },

    /* 立てて並べた砲弾(真鍮の薬莢に炸薬部の色帯)。 */
    shell: (f, p, q) => {
        if (f === "up") {
            const cu = q.fw / 2 - 0.5, cv = q.fh / 2 - 0.5;
            const r = Math.hypot(q.u - cu, q.v - cv) / Math.max(1, Math.min(cu, cv));
            return jit(mix(C.brass, C.brassDark, clamp(r, 0, 1) * 0.8), 3);
        }
        let c = mix(C.brass, C.brassDark, 0.25 + 0.40 * vnoise(p.x, p.y * 0.6, p.z, 4));
        if (p.y > 9) c = mix(C.olive, C.oliveDark, 0.30);                      // 弾頭
        else if (Math.round(p.y) === 9) c = mix(c, C.red, 0.45);               // 弾帯の色標
        else if (mod(p.y, 6) === 0) c = mix(c, C.brassDark, 0.45);
        return jit(faceShade(edge(c, q, 0.26), f), nz(p, 8));
    },

    /* 砲手の座席(鋼の枠に帆布)。 */
    seat: (f, p, q) => {
        let c = mix(C.canvas, C.canvasDark, 0.25 + 0.35 * vnoise(p.x * 2, p.y, p.z * 2, 4));
        if (mod(p.y, 3) === 0) c = mix(c, C.canvasDark, 0.35);                 // 縫い目
        if (f === "down") c = mix(C.steel, C.steelDark, 0.35);                 // 枠
        return jit(faceShade(edge(c, q, 0.28), f), nz(p, 8));
    },
};

// flat 指定の面が参照する単色パッチ(接地面など、絶対に見えない面)
const SWATCH = {
    armor: C.oliveDark, shield: C.oliveDark, steel: C.steelDark, gun: C.steelDark,
    brake: C.steelDark, tire: C.black, crate: C.woodDark, shell: C.brassDark,
    seat: C.canvasDark,
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
 * ---- 車輪(中身の詰まった円板。z で切った縦帯を並べて丸くする) ----
 * 💡 帯どうしは z の面で接するだけで面積が重ならないので、同じ x 幅でも側面が二重にならない。
 *    [dz0, dz1, 半径](dz は車輪中心 WCZ からの相対)
 */
const WHEEL_BANDS = [
    [-4, 4, 14],
    [4, 9, 12], [-9, -4, 12],
    [9, 14, 8], [-14, -9, 8],
];
for (const [dz0, dz1, ro] of WHEEL_BANDS) {
    LR("wheel_r", "wheel_l", 15, WCY - ro, WCZ + dz0, 20, WCY + ro, WCZ + dz1, "tire", { flat: dz0 === -4 ? D : [] });
}
LR("wheel_r", "wheel_l", 20, WCY - 4, WCZ - 4, 22, WCY + 4, WCZ + 4, "steel");   // ハブキャップ

/* ---- 車軸箱と旋回台 ---- */
B("carriage", -15, 8, -9, 15, 18, 7, "armor");
B("carriage", -12, 17, -8, 12, 20, 6, "steel");
/* 射撃ジャッキ(発砲時に車軸の下を地面に着けて安定させる) */
B("carriage", -6, 0, -6, 6, 10, 6, "steel", { flat: D });

/*
 * ---- 開いた脚(スプリットトレイル) ----
 * 後ろへ行くほど外側へずれる階段。段どうしは z の面で背中合わせに接するだけにしてある。
 */
BM("carriage", 6, 6, 7, 12, 15, 17, "armor");
BM("carriage", 9, 4, 17, 15, 11, 25, "armor");
BM("carriage", 12, 2, 25, 18, 8, 32, "armor");
BM("carriage", 14, 0, 32, 21, 6, 38, "armor", { flat: D });   // 駐鋤(地面に食い込む鋤)
BM("carriage", 16, 6, 34, 19, 13, 37, "steel");               // 脚を担ぐ握り

/* ---- 砲手の座席(右側。車輪に触れないよう x=15 で止める) ---- */
B("carriage", 9, 14, 2, 15, 17, 10, "seat");
B("carriage", 10, 17, 8, 14, 23, 10, "seat");

/*
 * ---- 旋回架(mount ボーン。yaw で旋回する) ----
 * 防盾は |x|>6 の左右2枚 + 中央下段。中央上側は砲身と駐退機が通るので空けてある。
 */
BM("mount", 6, 20, -10, 12, 34, 8, "armor");                  // 耳軸を抱える頬板
B("mount", -6, 20, -10, 6, 26, 8, "armor");                   // 頬板をつなぐ底板
BM("mount", 6, 16, -14, 22, 40, -11, "shield");               // 防盾(左右)
B("mount", -6, 16, -14, 6, 27, -11, "shield");                // 防盾(中央下段)
BM("mount", 6, 40, -14, 22, 43, -10, "shield");               // 上端の折り返し
BM("mount", 20, 16, -11, 22, 40, -4, "shield");               // 側面の折り返し
B("mount", -14, 24, -4, -10, 32, 4, "steel");                 // 俯仰ハンドル(左寄せ)
B("mount", 10, 24, -4, 14, 32, 4, "steel");                   // 旋回ハンドル(右)

/*
 * ---- 砲身と駐退機(cradle ボーン。耳軸 (0,32,-6) を軸に俯仰する) ----
 * 💡 静止仰角は BONES の rotation で与えている(負 = 砲口(-Z)側が上を向く)。
 *    後座部(尾栓)が下がりすぎると mount の底板を突き抜けるので、角度を強めるときは
 *    尾栓後端 z=12 の沈み込み (18 * sin角) が 5 単位を超えないか確かめること。
 */
B("cradle", -7, 25, -8, 7, 39, 12, "steel");                  // 尾栓・閉鎖機
B("cradle", -5, 27, -36, 5, 37, -8, "gun");                   // 砲身
B("cradle", -7, 25, -42, 7, 39, -36, "brake");                // 砲口制退器
BM("cradle", 2, 37, -30, 6, 42, -4, "steel");                 // 駐退復座機(砲身の上)
BM("cradle", 6, 28, -10, 10, 34, -2, "steel");                // 耳軸(頬板に載る)
B("cradle", -4, 21, -4, 4, 25, 8, "steel");                   // 揺架の下の緩衝器

/* ---- 弾薬(左脚の外側。箱と立てた砲弾) ---- */
B("stow", -26, 0, 18, -16, 8, 30, "crate", { flat: D });
B("stow", -24, 8, 20, -18, 13, 28, "crate");
B("stow", -13, 0, 20, -9, 12, 24, "shell", { flat: D });
B("stow", -13, 0, 25, -9, 12, 29, "shell", { flat: D });

/*
 * ボーン階層 (name, parent, pivot[, rotation])。
 * 💡 cradle の rotation で仰角を付けている(負 = 砲口(-Z)側が上を向く。gen_anti_air.js と同じ)。
 *    animations/artillery.animation.json の照準はこの静止姿勢に加算される。
 */
const BONES = [
    ["root", null, [0, 0, 0]],
    ["carriage", "root", [0, 0, 0]],
    ["wheel_r", "carriage", [17, WCY, WCZ]],
    ["wheel_l", "carriage", [-17, WCY, WCZ]],
    ["stow", "carriage", [0, 0, 0]],
    ["mount", "carriage", [0, 20, 0]],
    ["cradle", "mount", [0, 32, -6], [-10, 0, 0]],
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
            identifier: "geometry.civ.artillery",
            texture_width: TW,
            texture_height: TH,
            visible_bounds_width: 5,
            visible_bounds_height: 3.5,
            visible_bounds_offset: [0, 1.4, 0],
        },
        bones,
    }],
};

fs.writeFileSync(path.join(RP, "models/entity/artillery.geo.json"), JSON.stringify(geo, null, 2) + "\n");
fs.writeFileSync(path.join(RP, "textures/entity/artillery.png"), png);
console.log(`cubes=${cubes.length} faces=${rects.length} atlas=${TW}x${TH} png=${png.length}B`);
