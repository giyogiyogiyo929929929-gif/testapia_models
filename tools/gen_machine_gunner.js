"use strict";
/*
 * gen_machine_gunner.js -- civ:machine_gunner(機関銃兵)のモデル一式ジェネレータ
 *
 * 生成物:
 *   models/entity/machine_gunner.geo.json  ... 形状 + per-face UV
 *   textures/entity/machine_gunner.png     ... 上記UVに合わせて手続き的に描いたアトラス
 *
 * 使い方:  node tools/gen_machine_gunner.js      (このリソースパックのルートから)
 *
 * 設計方針は gen_warrior.js(同じ「歩兵1体」のモデル)と同じ:
 *   - 形状はこのファイル内の cube 定義がソース。UV はここが正なので、
 *     形をいじったら必ず再生成すること。
 *   - UV は box UV ではなく per-face UV。面ごとに 1テクセル=1モデル単位。
 *   - 塗りはモデル空間の座標を受け取る関数。左右対称(|x| 依存)の模様だけを使う。
 *   - キューブは必ず整数座標(アトラスの矩形幅がテクセル数と一致する必要があるため)。
 *   - 同じ向きの面が同一平面で重なると z-fighting するので、重ねるパーツは必ずどこかの
 *     座標をずらす(接するだけの背中合わせは面同士が逆向きなので安全)。
 *
 * 座標系: 16単位 = 1ブロック。正面は -Z(scripts/unitModels.js の yawTowards が
 *   yaw=0 で -Z を向く前提)。y=0 が接地面。
 *   全高は鉄兜の天辺で 45、前後は銃口 z=-40 〜 背嚢 z=10、左右は弾薬箱まで含めて x=-12〜14。
 *
 * 造形: 電力の時代の機関銃手。鉄兜 + 野戦服 + ゲートル、水冷ジャケット付きの重機関銃を
 *   両手で構え、給弾ベルトが銃の右前から垂れて地面の弾薬箱へ繋がっている。
 *   戦士(gen_warrior.js。青銅の兜と槍)と並べたとき、鉄兜・オリーブドラブ・
 *   長い銃身のシルエットで時代差が分かるようにしてある。
 *
 * 💡 【給弾ベルトの取り回し】
 *   ベルトは「腕の手前(z=-24〜-19)を通して足元前方の弾薬箱へ落とす」経路にしてある。
 *   腕(forearm/glove)と同じ (x,y,z) 面を共有しないよう座標をずらしてあるので、
 *   経路を変えるときは腕のキューブと平面が重ならないか必ず確かめること。
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
    eye:         [0xE2, 0xDC, 0xCE],
    pupil:       [0x27, 0x1E, 0x18],
    stubble:     [0x3A, 0x2C, 0x22],
    olive:       [0x55, 0x5C, 0x3E], // 野戦服
    oliveDark:   [0x36, 0x3C, 0x28],
    oliveLight:  [0x6E, 0x77, 0x52],
    khaki:       [0x8A, 0x82, 0x5C], // ゲートル・背嚢の帆布
    khakiDark:   [0x5E, 0x58, 0x3C],
    steel:       [0x45, 0x49, 0x4C], // 鉄兜・銃架
    steelDark:   [0x25, 0x28, 0x2A],
    steelLight:  [0x6C, 0x72, 0x78],
    gunmetal:    [0x30, 0x33, 0x36], // 機関銃
    heat:        [0x6E, 0x5C, 0x4C],
    leather:     [0x4E, 0x35, 0x22], // 編上靴・負い革
    leatherDark: [0x30, 0x20, 0x14],
    leatherLight:[0x74, 0x53, 0x33],
    wood:        [0x77, 0x5C, 0x39], // 銃床
    woodDark:    [0x4F, 0x3C, 0x25],
    brass:       [0xB0, 0x8A, 0x44], // 給弾ベルトの薬莢
    brassDark:   [0x76, 0x5B, 0x2B],
    rust:        [0x6E, 0x46, 0x2B],
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
/** 格子サイズ s の値ノイズ。布のムラ・金属の肌用。 */
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
    let c = mix(base, dark, 0.32 * n);
    const fold = Math.sin(Math.abs(p.x) * 1.15 + p.z * 0.35);
    c = mix(c, dark, clamp(0.26 * (0.5 - fold * 0.5), 0, 0.26));
    return c;
}

/** 打ち出しの鋼(鉄兜・銃架)。 */
function steelBase(p) {
    const n = vnoise(Math.abs(p.x) * 1.4, p.y * 1.4, p.z * 1.4, 4);
    let c = mix(C.steel, n > 0.5 ? C.steelLight : C.steelDark, Math.abs(n - 0.5) * 0.7);
    if (hash(p.x * 2.9, p.y * 1.7, p.z * 3.3) > 0.98) c = mix(c, C.rust, 0.45);
    return c;
}

/* ============================ マテリアル ============================ */
/* (face, p={x,y,z}(モデル空間), q={u,v,fw,fh,cube}) -> [r,g,b] */

const MAT = {
    skin: (f, p, q) => jit(faceShade(edge(skinBase(p), q, 0.20), f), nz(p, 8)),

    /*
     * 頭部。正面(north)だけ顔を描く。
     * 💡 鉄兜のひさしが y=38〜40 を覆うので、顔の造作はその下(y=33〜38)に収めてある。
     *    ひさしの高さを変えたらここも合わせること(目が兜に隠れて表情が消える)。
     */
    head: (f, p, q) => {
        let c = skinBase(p);
        if (f === "north") {
            const ax = Math.abs(p.x);
            if (p.y > 37) c = mix(c, C.black, 0.40);                        // ひさしの影
            else if (p.y > 36) c = mix(c, C.stubble, 0.50);                 // 眉
            else if (p.y > 35) {                                            // 目(Steve と同じ 2px)
                if (ax > 3 && ax < 4) c = mix(C.eye, C.skinDark, 0.18);
                else if (ax > 2 && ax < 3) c = C.pupil;
                else c = mix(c, C.skinDark, 0.40);
            } else if (p.y > 34) c = mix(c, C.skinDark, ax < 2 ? 0.35 : 0.10); // 口
            else c = mix(c, C.stubble, 0.45 + 0.15 * vnoise(ax, p.y, p.z, 3)); // 無精髭
        } else if (f === "south" || f === "up") {
            c = mix(c, C.stubble, 0.70);                                    // 刈り上げた後頭部
        } else {
            c = mix(c, C.stubble, p.y > 37 ? 0.55 : 0.25);
        }
        return jit(faceShade(edge(c, q, 0.16), f), nz(p, 7));
    },

    /* 鉄兜。天辺ほど明るく、ひさしの縁を暗く落とす。側面に浅い打ち出しの筋。 */
    helmet: (f, p, q) => {
        let c = steelBase(p);
        c = mix(c, C.steelLight, clamp((p.y - 40) / 6, 0, 1) * 0.28);
        if (p.y < 41) c = mix(c, C.steelDark, 0.30);                        // ひさしの下は影
        if (f === "down") c = mix(c, C.black, 0.50);
        if (mod(p.y, 4) === 0) c = mix(c, C.steelDark, 0.12);               // 打ち出しの筋
        return jit(faceShade(edge(c, q, 0.30), f), nz(p, 8));
    },

    /* 顎紐(革)。 */
    strap: (f, p, q) => {
        let c = mix(C.leather, C.leatherDark, 0.25 + 0.30 * vnoise(p.x * 2, p.y * 2, p.z * 2, 3));
        if (mod(Math.abs(p.x), 3) === 0) c = mix(c, C.leatherLight, 0.25);
        return jit(faceShade(c, f), nz(p, 8));
    },

    uniform: (f, p, q) => jit(faceShade(edge(clothBase(p, C.olive, C.oliveDark), q, 0.20), f), nz(p, 9)),

    /*
     * 野戦服の上衣。胸に釦の列、袖口の折り返し、左肩に赤白の国籍章。
     * 💡 国籍章は |x| 基準(左右の肩の同じ位置)なので、UV が左右反転しても崩れない。
     */
    tunic: (f, p, q) => {
        let c = clothBase(p, C.olive, C.oliveDark);
        const ax = Math.abs(p.x);
        if (f === "north") {
            if (ax < 1 && mod(p.y, 4) === 1) c = mix(c, C.steelLight, 0.45); // 前立ての釦
            if (ax > 0.5 && ax < 1.5) c = mix(c, C.oliveDark, 0.35);         // 前立ての合わせ
        }
        if (f === "north" && p.y > 29 && ax > 4) {                           // 胸の国籍章(正面だけ)
            const r = Math.hypot(ax - 6, p.y - 30.5);
            if (r < 2.2) c = (r > 1.4) ? mix(C.redDark, C.black, 0.20) : (r > 0.7 ? C.white : C.red);
        }
        return jit(faceShade(edge(c, q, 0.20), f), nz(p, 9));
    },

    /* 上衣の裾。下端に縫い目と泥。 */
    hem: (f, p, q) => {
        let c = clothBase(p, C.olive, C.oliveDark);
        if (p.y < 13.2) c = mix(c, C.black, 0.30);
        else if (p.y < 14.2) c = mix(c, C.oliveDark, 0.45);                 // 裾の縫い目
        if (hash(p.x * 2.1, p.y * 3.3, p.z * 1.9) > 0.96) c = mix(c, C.leatherDark, 0.35); // 泥
        return jit(faceShade(edge(c, q, 0.20), f), nz(p, 9));
    },

    /* ゲートル(脛に巻いた帆布)。斜めではなく水平の巻きで表現する。 */
    puttee: (f, p, q) => {
        let c = mix(C.khaki, C.khakiDark, 0.25 + 0.35 * vnoise(Math.abs(p.x), p.y, p.z, 3));
        const r = mod(p.y, 2);
        if (r === 0) c = mix(c, C.khakiDark, 0.50);                         // 巻きの重なり
        else c = mix(c, C.khaki, 0.20);
        if (hash(p.x * 2.1, p.y * 3.3, p.z * 1.9) > 0.94) c = mix(c, C.leatherDark, 0.40); // 泥
        return jit(faceShade(edge(c, q, 0.24), f), nz(p, 8));
    },

    /* 編上靴。 */
    boot: (f, p, q) => {
        let c = mix(C.leather, C.leatherDark, 0.25 + 0.35 * vnoise(Math.abs(p.x) * 2, p.y * 2, p.z, 3));
        if (f === "up" && mod(p.z, 3) === 0) c = mix(c, C.leatherLight, 0.25); // 靴紐
        if (p.y < 1.6) c = mix(c, C.black, 0.45);                             // 靴底
        return jit(faceShade(edge(c, q, 0.26), f), nz(p, 8));
    },

    /* 負い革・帯革(革ベルトに真鍮の金具)。 */
    webbing: (f, p, q) => {
        let c = mix(C.leather, C.leatherDark, 0.30 + 0.25 * vnoise(p.x, p.y, p.z, 3));
        if (q.v === 0 || q.v === q.fh - 1) c = mix(c, C.leatherDark, 0.50);
        if (f === "north" && Math.abs(p.x) < 2.5 && mod(p.y, 3) === 1) c = mix(C.brass, C.brassDark, 0.30); // 尾錠
        return jit(faceShade(edge(c, q, 0.26), f), nz(p, 8));
    },

    /* 弾薬盒(帯革に下げた革のポーチ)。 */
    pouch: (f, p, q) => {
        let c = mix(C.leather, C.leatherDark, 0.20 + 0.30 * vnoise(p.x * 1.5, p.y, p.z, 3));
        if (f === "north" && mod(p.y, 5) === 2) c = mix(C.brass, C.brassDark, 0.35);  // 留め金
        if (f === "up") c = mix(c, C.leatherLight, 0.20);                             // 蓋
        return jit(faceShade(edge(c, q, 0.26), f), nz(p, 8));
    },

    /* 背嚢(帆布に革のベルト)。 */
    pack: (f, p, q) => {
        let c = mix(C.khaki, C.khakiDark, 0.25 + 0.35 * vnoise(Math.abs(p.x), p.y * 0.8, p.z, 5));
        if (mod(Math.abs(p.x), 7) === 0) c = mix(C.leather, C.leatherDark, 0.30);     // 締め革
        if (f === "up") c = mix(c, C.khaki, 0.25);
        if (mod(p.y, 9) === 0) c = mix(c, C.khakiDark, 0.40);                         // 折り目
        return jit(faceShade(edge(c, q, 0.24), f), nz(p, 9));
    },

    /* 手袋。 */
    glove: (f, p, q) => {
        let c = mix(C.leather, C.leatherDark, 0.35 + 0.25 * vnoise(p.x * 2, p.y * 2, p.z * 2, 3));
        if (f === "up" && mod(p.z, 2) === 0) c = mix(c, C.leatherLight, 0.20);        // 指の割れ
        return jit(faceShade(edge(c, q, 0.28), f), nz(p, 8));
    },

    /* 機関銃の機関部・銃口。北面には丸い銃腔を描く。 */
    gunmetal: (f, p, q) => {
        if (f === "north" && q.fw >= 6 && q.fh >= 5) {
            const cu = q.fw / 2 - 0.5, cv = q.fh / 2 - 0.5;
            const rr = Math.min(cu, cv);
            const r = Math.hypot(q.u - cu, q.v - cv);
            if (r > rr - 0.4) return jit(mix(C.gunmetal, C.steelDark, 0.30), -4);
            if (r > rr - 1.4) return jit(mix(C.steelLight, C.steel, 0.30), 3);
            return jit(mix(C.black, C.steelDark, 0.20), (hash(p.x, p.y, p.z) - 0.5) * 6);
        }
        let c = mix(C.gunmetal, C.steel, 0.20 + 0.30 * vnoise(p.x, p.y, p.z, 5));
        if (mod(p.z, 5) === 0) c = mix(c, C.steelDark, 0.25);
        else if (mod(p.z, 5) === 1) c = mix(c, C.steelLight, 0.14);
        c = mix(c, C.heat, clamp((-p.z - 26) / 14, 0, 1) * 0.35);                     // 銃口寄りの焼け
        return jit(faceShade(edge(c, q, 0.28), f), nz(p, 8));
    },

    /*
     * 水冷ジャケット(銃身を包む穴あきの筒)。丸い放熱孔を格子状に開けて見せる。
     * 💡 孔は z と「面に沿った横方向」で決めているので、左右の面が反転しても列は崩れない。
     */
    jacket: (f, p, q) => {
        let c = mix(C.gunmetal, C.steel, 0.30 + 0.25 * vnoise(p.x, p.y, p.z, 4));
        const across = (f === "up" || f === "down") ? p.x : p.y;
        const hz = mod(p.z, 5), ha = mod(across, 4);
        const d = Math.hypot(hz - 2, ha - 2);
        if (d < 1.3) c = mix(C.black, C.steelDark, 0.25);                             // 放熱孔
        else if (d < 2.0) c = mix(c, C.steelLight, 0.22);                             // 孔の縁
        if (mod(p.z, 20) === 0) c = mix(c, C.steelLight, 0.35);                       // 補強の輪
        return jit(faceShade(edge(c, q, 0.26), f), nz(p, 8));
    },

    steel: (f, p, q) => {
        let c = steelBase(p);
        if (mod(p.z, 4) === 0) c = mix(c, C.steelLight, 0.18);
        return jit(faceShade(edge(c, q, 0.30), f), nz(p, 9));
    },

    /* 銃床(木)。 */
    wood: (f, p, q) => {
        let c = mix(C.wood, C.woodDark, 0.25 + 0.45 * vnoise(p.z * 0.3, p.y * 2.4, Math.abs(p.x) * 2.4, 4));
        if (hash(Math.floor(p.z / 6), Math.floor(p.y / 4), 0) > 0.94) c = mix(c, C.woodDark, 0.50); // 節
        return jit(faceShade(edge(c, q, 0.28), f), nz(p, 8));
    },

    /*
     * 給弾ベルト(帆布のベルトに薬莢が並ぶ)。
     * 薬莢の並びは「垂れ下がる向き=y」と「面に沿った横方向」で刻む。
     */
    ammobelt: (f, p, q) => {
        const across = (f === "up" || f === "down") ? p.z : p.y;
        let c = mix(C.brass, C.brassDark, 0.25 + 0.35 * vnoise(p.x, p.y * 2, p.z, 3));
        if (mod(across, 3) === 0) c = mix(C.khakiDark, C.black, 0.30);                // 薬莢の隙間
        if (mod(across, 9) === 4) c = mix(C.khaki, C.khakiDark, 0.35);                // 帆布の帯
        return jit(faceShade(edge(c, q, 0.24), f), nz(p, 8));
    },

    /* 弾薬箱(鋼板の箱に把手とステンシル)。 */
    can: (f, p, q) => {
        let c = mix(C.olive, C.oliveDark, 0.25 + 0.30 * vnoise(p.x, p.y, p.z, 6));
        const along = (f === "east" || f === "west") ? p.z : p.x;
        if (f === "up") {
            if (mod(p.z, 9) === 4) c = mix(C.steel, C.steelDark, 0.30);               // 把手
        } else if (f !== "down") {
            if (mod(p.y, 7) === 0) c = mix(c, C.oliveDark, 0.40);                     // 補強のリブ
            if (mod(p.y, 7) === 3 && mod(along, 8) > 1 && mod(along, 8) < 6) c = mix(c, C.white, 0.30); // ステンシル
        }
        if (hash(p.x * 2.7, p.y * 1.9, p.z * 3.1) > 0.985) c = mix(c, C.rust, 0.45);
        return jit(faceShade(edge(c, q, 0.26), f), nz(p, 8));
    },
};

// flat 指定の面が参照する単色パッチ
const SWATCH = {
    skin: C.skinDark, head: C.skinDark, helmet: C.steelDark, strap: C.leatherDark,
    uniform: C.oliveDark, tunic: C.oliveDark, hem: C.oliveDark, puttee: C.khakiDark,
    boot: C.black, webbing: C.leatherDark, pouch: C.leatherDark, pack: C.khakiDark,
    glove: C.leatherDark, gunmetal: C.steelDark, jacket: C.steelDark, steel: C.steelDark,
    wood: C.woodDark, ammobelt: C.brassDark, can: C.oliveDark,
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
/** 左右で別ボーンに分かれる部品(腕・脚)。x>0 側の座標を渡す。 */
function LR(boneR, boneL, x0, y0, z0, x1, y1, z1, mat, opts) {
    B(boneR, x0, y0, z0, x1, y1, z1, mat, opts);
    B(boneL, -x1, y0, z0, -x0, y1, z1, mat, mirrorOpts(opts));
}
const D = ["down"];   // 接地面。どの角度からも見えない

/* ---- 脚(x=1..6)。編上靴 -> ゲートル -> ズボン ---- */
LR("leg_r", "leg_l", 1, 0, -6, 6, 4, 3, "boot", { flat: D });
LR("leg_r", "leg_l", 1, 4, -4, 6, 11, 3, "puttee");
LR("leg_r", "leg_l", 1, 11, -4, 6, 16, 3, "uniform");

/* ---- 胴。上衣の裾 -> 上衣 -> 帯革 -> 首 ---- */
B("body", -8, 12, -5, 8, 19, 5, "hem");
B("body", -7, 19, -4, 7, 31, 4, "tunic");
B("body", -8, 20, -5, 8, 23, 5, "webbing");            // 帯革(上衣の上に巻く)
BM("body", 1, 19, -7, 5, 24, -5, "pouch");             // 弾薬盒
BM("body", 2, 23, -5, 4, 31, -4, "webbing");           // 胸の負い革
B("body", -6, 24, 4, 6, 32, 10, "pack");               // 背嚢
B("body", -3, 30, -3, 3, 34, 3, "skin");               // 首

/* ---- 頭と鉄兜 ---- */
B("head", -5, 33, -5, 5, 42, 4, "head");
B("head", -7, 38, -7, 7, 40, 6, "helmet");             // ひさし(全周に張り出す)
B("head", -6, 40, -6, 6, 44, 5, "helmet");             // 兜の腰
B("head", -5, 44, -5, 5, 45, 4, "helmet");             // 天蓋(角を落として丸く見せる)
BM("head", 5, 34, -5, 6, 38, 2, "strap");              // 顎紐

/*
 * ---- 腕(両手で銃を構える) ----
 * 上腕は体側、前腕は前へ折って内側に寄せ、手袋が銃の脇に来る。
 */
LR("arm_r", "arm_l", 7, 23, -4, 12, 31, 3, "uniform");   // 上腕
LR("arm_r", "arm_l", 5, 20, -14, 11, 26, -4, "uniform"); // 前腕
LR("arm_r", "arm_l", 4, 20, -20, 9, 25, -14, "glove");   // 手袋

/*
 * ---- 機関銃(gun ボーン) ----
 * 銃床を胸に当て、水冷ジャケットの銃身が前へ伸びる。銃腔の穴は gunmetal マテリアルが
 * 銃口キューブの north 面に描く。
 */
B("gun", -3, 22, -10, 3, 27, -2, "wood");        // 銃床(胸に当てる)
B("gun", -2, 16, -14, 2, 22, -10, "wood");       // 握把
B("gun", -4, 22, -24, 4, 28, -10, "gunmetal");   // 機関部
B("gun", -1, 28, -18, 1, 31, -15, "steel");      // 照門
B("gun", -3, 23, -36, 3, 27, -24, "jacket");     // 水冷ジャケット
B("gun", -1, 27, -34, 1, 31, -32, "steel");      // 照星
B("gun", -4, 22, -40, 4, 28, -36, "gunmetal");   // 銃口
BM("gun", 1, 19, -34, 3, 23, -26, "steel");      // 折り畳んだ二脚
B("gun", 4, 21, -24, 7, 25, -20, "ammobelt");    // 給弾口から出たベルト

/* ---- 垂れ下がる給弾ベルトと足元の弾薬箱 ---- */
B("belt", 5, 12, -23, 8, 22, -21, "ammobelt");
B("belt", 6, 4, -22, 9, 14, -19, "ammobelt");
B("can", 7, 0, -24, 14, 6, -14, "can", { flat: D });

/*
 * ボーン階層 (name, parent, pivot)。
 * 💡 animations/machine_gunner.animation.json では head と belt しか動かしていない。
 *    gun は body の子なので、腕(arm_r/arm_l)を回すと銃と手が離れる。腕を動かすときは
 *    gun も同じ量だけ回すこと(gen_warrior.js の槍と同じ理由)。
 */
const BONES = [
    ["root", null, [0, 0, 0]],
    ["body", "root", [0, 15, 0]],
    ["head", "body", [0, 33, 0]],
    ["arm_r", "body", [9, 31, 0]],
    ["arm_l", "body", [-9, 31, 0]],
    ["gun", "body", [0, 25, -12]],
    ["belt", "body", [6, 22, -21]],
    ["can", "root", [10, 0, -19]],
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
            identifier: "geometry.civ.machine_gunner",
            texture_width: TW,
            texture_height: TH,
            visible_bounds_width: 4,
            visible_bounds_height: 3.5,
            visible_bounds_offset: [0, 1.5, 0],
        },
        bones,
    }],
};

fs.writeFileSync(path.join(RP, "models/entity/machine_gunner.geo.json"), JSON.stringify(geo, null, 2) + "\n");
fs.writeFileSync(path.join(RP, "textures/entity/machine_gunner.png"), png);
console.log(`cubes=${cubes.length} faces=${rects.length} atlas=${TW}x${TH} png=${png.length}B`);
