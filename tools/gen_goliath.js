"use strict";
/*
 * gen_goliath.js -- civ:goliath(空中戦艦「ゴリアテ」級)のモデル一式ジェネレータ
 *
 * 生成物:
 *   models/entity/goliath.geo.json  ... 形状 + per-face UV
 *   textures/entity/goliath.png     ... 上記UVに合わせて手続き的に描いたアトラス
 *
 * 使い方:  node tools/gen_goliath.js       (このリソースパックのルートから)
 *
 * 設計方針(gen_airship.js / gen_dreadnought.js と同じ):
 *   - 形状はこのファイル内の cube 定義がソース。Blockbench で開ける普通の geo を吐くが、
 *     UV はここが正なので、形をいじったら必ず再生成すること。
 *   - UV は box UV ではなく per-face UV。面ごとに 1テクセル = 1モデル単位。
 *   - 塗りはモデル空間の座標を受け取る関数。装甲帯・国籍マーク・舷窓列が面をまたいで
 *     繋がるように、左右対称(|x| 依存)・上下方向のみに依存する模様だけを使う。
 *
 * 座標系: 16単位 = 1ブロック。艦首は -Z(scripts/unitModels.js の yawTowards が yaw=0 で
 *   -Z を向く前提)、上が +Y。
 *     全長  z = -156 .. 176(332単位 ≒ 20.8ブロック)
 *     全幅  x = ±79(プロペラ端。艦体そのものは ±44)
 *     全高  y =    0 .. 164(艦底の球形銃座から旗の先端まで)
 *   艦体(気嚢兼装甲殻)の中心高さは YC。艦底の一番低い所が y=0 になるよう組んであるので、
 *   地面に置いても埋まらない(実際には巡航高度に浮かべる想定)。
 *
 * 💡 【既存の civ:airship との違い】
 *   airship は布張りの軟式飛行船(気嚢+木製ゴンドラ)。こちらは硬式の装甲艦で、
 *   - 断面が「上は丸く、腹は平たい」船型(BANDS_6)
 *   - 艦体全長に走る竜骨ゴンドラ(keel)と、その前端に張り出した司令橋(bridge)
 *   - 舷側に張り出したパイロン + 4基の巨大プロペラ
 *   - 背1対 / 腹1対の旋回砲塔と、舷側のケースメイト砲
 *   という構成にして、遠目のシルエットで別物と分かるようにしてある。
 *
 * 💡 【アトラス節約】
 *   艦体は断面を上下の帯に割った積み木で作ってあるため、帯どうしの合わせ目(上の帯の down 面、
 *   下の帯の up 面)はほとんど見えない。そこで「一番下の帯の down 面」と「一番上の帯の up 面」
 *   だけを描き、途中の合わせ目は flat(単色パッチ)にしている。ここを外すとアトラスが
 *   一気に 3 倍近くに膨らむので注意。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const RP = path.resolve(__dirname, "..");

/* ============================ パレット ============================ */
const C = {
    armor:      [0x70, 0x76, 0x60], // 艦体装甲(オリーブグレー)
    armorDark:  [0x51, 0x57, 0x45],
    armorLight: [0x8D, 0x93, 0x7A],
    belly:      [0x60, 0x66, 0x62], // 腹側は少し青灰に振る
    bellyDark:  [0x44, 0x49, 0x47],
    belt:       [0x38, 0x3B, 0x30], // 装甲帯・外周フレーム
    steel:      [0x4A, 0x4F, 0x53],
    steelDark:  [0x2A, 0x2E, 0x31],
    steelLight: [0x79, 0x80, 0x87],
    gunmetal:   [0x3A, 0x3E, 0x42],
    soot:       [0x25, 0x23, 0x20],
    rust:       [0x8A, 0x5A, 0x36],
    black:      [0x18, 0x1A, 0x1C],
    white:      [0xD6, 0xD2, 0xC4],
    red:        [0xA8, 0x32, 0x26],
    redDark:    [0x70, 0x1E, 0x16],
    brass:      [0xB0, 0x8A, 0x44],
    glass:      [0x22, 0x36, 0x4C], // 司令橋の窓
    glassLite:  [0x66, 0x96, 0xC0],
    lamp:       [0xF2, 0xE4, 0xAE], // 探照灯のレンズ
    hazard:     [0xC6, 0xA1, 0x2E], // 格納庫扉の警戒色
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
    if (f === "up") return mix(c, C.white, 0.10);
    if (f === "down") return mix(c, C.black, 0.14);
    if (f === "south") return mix(c, C.black, 0.09);
    return c;
}

/* 艦体の中心高さ。塗り分け(腹側/舷側/背)も国籍マークもこれを基準にする。 */
const YC = 78;

/* ============================ 塗りの部品 ============================ */

/* 外板の継ぎ目。舷側は縦通材(水平の条)+突き合わせ継手、上下面は縦横の格子。 */
function plating(c, p, f) {
    const y = Math.round(p.y), z = Math.round(p.z), x = Math.round(Math.abs(p.x));
    if (f === "east" || f === "west") {
        if (mod(y, 8) === 0) c = mix(c, C.belt, 0.30);                            // 縦通材
        if (mod(z, 16) === 0) c = mix(c, C.belt, 0.22);                           // 突き合わせ継手
        if (mod(y, 8) === 1 && mod(z, 4) === 0) c = mix(c, C.armorLight, 0.20);   // 鋲列
    } else {
        if (mod(z, 16) === 0) c = mix(c, C.belt, 0.22);
        if (mod(x, 8) === 0) c = mix(c, C.belt, 0.18);
        if (mod(x, 8) === 1 && mod(z, 4) === 0) c = mix(c, C.armorLight, 0.16);
    }
    return c;
}

/* 舷窓(真鍮枠の丸窓)。舷側の一列だけに開ける。 */
function portholes(c, p, f) {
    if (f !== "east" && f !== "west") return c;
    if (Math.round(p.y) !== YC - 24) return c;
    if (p.z < -108 || p.z > 108) return c;
    if (mod(p.z, 13) !== 0) return c;
    return mix(C.black, C.brass, 0.40);
}

/* 舷窓の下に垂れる錆。 */
function rustStreak(c, p, f) {
    if (f !== "east" && f !== "west") return c;
    if (p.y > YC - 24 || p.y < YC - 40) return c;
    const n = vnoise(p.z * 3.4, p.y * 0.28, 0, 4);
    if (n > 0.72) return mix(c, C.rust, (n - 0.72) * 1.6);
    return c;
}

/*
 * 舷側中央の国籍マーク(同心円のラウンデル)。
 * 断面を帯に割ってあるので、一番幅広の帯だけに描くと縦に切れてしまう。
 * そこで「半幅 34 以上の帯すべて」に描き、段差をまたいで模様が繋がるようにしている
 * (艦体の幅を変えたらこの閾値も見直すこと)。
 * 💡 中心 z=-10 は前後のエンジンナセル(z=-82..-34 と 14..62)の間の空きに合わせてある。
 *    ナセルの位置を動かすとマークが隠れるので、そのときはここも動かすこと。
 */
function roundel(c, p, f) {
    if (f !== "east" && f !== "west") return c;
    if (Math.abs(p.x) < 34) return c;
    const r = Math.hypot(p.z + 10, p.y - YC);
    if (r > 16.5) return c;
    if (r < 5) return C.red;
    if (r < 8.5) return C.white;
    if (r < 12.5) return C.red;
    if (r < 14.5) return mix(C.white, C.armorDark, 0.15);
    return mix(c, C.black, 0.45);
}

/* ============================ マテリアル ============================ */
/* (face, p={x,y,z}(モデル空間), q={u,v,fw,fh,cube}) -> [r,g,b] */

const MAT = {
    /*
     * 艦体の装甲殻。高さで3段に塗り分ける。
     *   y < YC-26   : 腹側(青灰。下から見上げられる面)
     *   YC-2..YC+3  : 舷側を全長にわたって走る暗い装甲帯
     *   それ以外    : オリーブグレーの装甲
     */
    hull: (f, p, q) => {
        const t = clamp((p.y - (YC - 39)) / 78, 0, 1);
        let c = mix(C.armorDark, C.armor, 0.25 + 0.75 * t);
        c = mix(c, C.armorLight, 0.18 * vnoise(p.x * 0.7, p.y * 0.5, p.z * 0.6, 17));
        if (p.y < YC - 26) c = mix(c, C.belly, clamp((YC - 26 - p.y) / 10, 0, 1) * 0.75);
        if (p.y >= YC - 2 && p.y <= YC + 3) c = mix(c, C.belt, 0.62);      // 装甲帯
        c = plating(c, p, f);
        c = portholes(c, p, f);
        c = rustStreak(c, p, f);
        c = roundel(c, p, f);
        if (hash(p.x * 2.1, p.y * 1.9, p.z * 3.3) > 0.992) c = mix(c, C.armorLight, 0.30); // 塗装剥がれ
        c = faceShade(c, f);
        return jit(edge(c, q, 0.18), (hash(p.x * 0.9, p.y * 1.1, p.z * 0.7) - 0.5) * 8);
    },

    /* 艦首・艦尾の絞り込み部。同じ装甲だがマークを描かず、艦首側は少し暗くして締める。 */
    hullEnd: (f, p, q) => {
        const t = clamp((p.y - (YC - 39)) / 78, 0, 1);
        let c = mix(C.armorDark, C.armor, 0.20 + 0.70 * t);
        if (p.y < YC - 20) c = mix(c, C.belly, 0.55);
        if (p.y >= YC - 2 && p.y <= YC + 3) c = mix(c, C.belt, 0.62);
        c = plating(c, p, f);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.20), (hash(p.x, p.y * 1.1, p.z) - 0.5) * 8);
    },

    /* 艦体を締める外周フレーム(中身は艦体に埋まり、1単位はみ出した縁だけが見える) */
    frame: (f, p, q) => {
        let c = mix(C.belt, C.steel, 0.30 + 0.25 * vnoise(p.x, p.y, p.z, 6));
        if (mod(p.y, 4) === 0) c = mix(c, C.steelLight, 0.14);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.30), (hash(p.x, p.y, p.z) - 0.5) * 7);
    },

    /*
     * 竜骨ゴンドラ(艦体の下を全長に走る居住区)。舷側に角窓の帯が並ぶ。
     * 窓の高さ(y 28..33)はキューブ配置と対応しているので、ゴンドラの高さを変えたらここも直す。
     */
    keel: (f, p, q) => {
        let c = mix(C.belly, C.bellyDark, 0.18 + 0.32 * vnoise(p.x, p.y * 0.8, p.z, 12));
        if (f === "east" || f === "west") {
            if (p.y >= 28 && p.y <= 33) {
                c = mod(p.z, 4) === 0 ? mix(C.bellyDark, C.black, 0.45) : mix(C.glass, C.glassLite, 0.20);
            }
            if (mod(p.y, 7) === 0) c = mix(c, C.belt, 0.24);
            if (mod(p.z, 12) === 0) c = mix(c, C.belt, 0.20);
        } else if (f === "down") {
            if (mod(p.z, 12) === 0) c = mix(c, C.belt, 0.24);
            if (mod(Math.abs(p.x), 6) === 0) c = mix(c, C.belt, 0.18);
        }
        c = faceShade(c, f);
        return jit(edge(c, q, 0.24), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    /* 司令橋。窓帯の下は装甲、上は艦体に埋まる。 */
    bridge: (f, p, q) => {
        let c = mix(C.armor, C.armorDark, 0.20 + 0.28 * vnoise(p.x, p.y * 0.7, p.z, 9));
        if (f !== "up" && f !== "down") {
            if (mod(p.y, 6) === 0) c = mix(c, C.belt, 0.22);
            const along = (f === "north" || f === "south") ? p.x : p.z;
            if (mod(along, 9) === 0) c = mix(c, C.belt, 0.16);
        }
        c = faceShade(c, f);
        return jit(edge(c, q, 0.24), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    /* 砲塔・バーベット・司令塔の重装甲。天蓋に上空識別帯を入れる。 */
    turret: (f, p, q) => {
        let c = mix(C.armorDark, C.armor, 0.30 + 0.25 * vnoise(p.x, p.y, p.z, 8));
        c = mix(c, C.belt, 0.22);
        if (f === "up") {
            c = mix(c, C.armorLight, 0.10);
            if (mod(p.z, 7) === 0) c = mix(c, C.redDark, 0.45);
            if (mod(p.z, 7) === 3) c = mix(c, C.white, 0.20);
        } else {
            if (mod(p.y, 4) === 0) c = mix(c, C.black, 0.22);                          // 装甲板の継ぎ目
            if (mod(p.y, 4) === 1 && mod(p.z, 3) === 0) c = mix(c, C.armorLight, 0.16); // 鋲
        }
        c = faceShade(c, f);
        return jit(edge(c, q, 0.26), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    /* 主砲身(前後方向)。北面・南面が砲口。 */
    gun: (f, p, q) => bore(f, p, q, f === "north" || f === "south"),
    /* 舷側砲(ケースメイト。左右方向)。東面・西面が砲口。 */
    gunx: (f, p, q) => bore(f, p, q, f === "east" || f === "west"),

    /*
     * エンジンナセル。長軸が Z なので、冷却ルーバーは Z 方向に等間隔の筋になる。
     * 後半分は排気で煤ける。
     */
    nacelle: (f, p, q) => {
        let c = mix(C.armor, C.steelLight, 0.28 + 0.22 * vnoise(p.x, p.y, p.z, 7));
        if (mod(p.z, 4) === 0) c = mix(c, C.armorDark, 0.22);       // 冷却ルーバー
        if (mod(p.z, 12) === 0) c = mix(c, C.steelLight, 0.22);     // 補強リング
        if (mod(p.y, 9) === 0) c = mix(c, C.belt, 0.18);            // カウルの分割線
        // 煤けるのは排気口のある後端だけ(全体に掛けると黒い塊に見えてしまう)
        const t = clamp((p.z - (q.cube.z1 - 14)) / 14, 0, 1);
        c = mix(c, C.soot, t * t * 0.40);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.22), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    /* パイロン(艦体とナセルを繋ぐ支柱)・小物の鋼材。 */
    steel: (f, p, q) => {
        let c = mix(C.steel, C.steelDark, 0.25 + 0.30 * vnoise(p.x, p.y, p.z, 5));
        if (mod(p.y, 4) === 0) c = mix(c, C.steelLight, 0.16);
        if (mod(p.z, 9) === 0) c = mix(c, C.steelDark, 0.18);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.30), (hash(p.x, p.y, p.z) - 0.5) * 9);
    },

    /* 背の通路(グレーチング)。 */
    deck: (f, p, q) => {
        let c = mix(C.steel, C.steelLight, 0.22);
        if (f === "up" && (mod(Math.abs(p.x), 3) === 0 || mod(p.z, 6) === 0)) c = mix(c, C.steelDark, 0.55);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.26), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    /*
     * 尾翼。オリーブ地に骨組み(小骨)の筋が浮き、前縁だけ金属で補強されている。
     * 前縁は面の向きではなくキューブの z0(=前縁側)からの距離で判定するので、
     * 東面・西面で左右が入れ替わってもズレない。
     */
    fin: (f, p, q) => {
        let c = mix(C.armor, C.armorDark, 0.28 + 0.25 * vnoise(p.x, p.y * 0.6, p.z * 0.6, 13));
        if (mod(p.z, 10) === 0) c = mix(c, C.belt, 0.30);                   // 小骨
        if (mod(p.z, 30) === 0) c = mix(c, C.belt, 0.20);                   // 桁
        if (p.z - q.cube.z0 < 2) c = mix(c, C.steel, 0.55);                 // 前縁の補強
        if (p.z > q.cube.z1 - 2) c = mix(c, C.armorDark, 0.35);             // 後縁
        c = faceShade(c, f);
        return jit(edge(c, q, 0.22), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    /* プロペラ。ハブ中心からの距離で先端に警戒色を入れる。 */
    blade: (f, p, q) => {
        const hub = q.cube.hub || [0, 0];
        const r = Math.hypot(p.x - hub[0], p.y - hub[1]);
        let c = mix(C.steel, C.steelLight, 0.30);
        if (f === "north" || f === "south") c = mix(c, C.steelLight, 0.40);
        if (r > 20) c = mix(C.brass, C.white, 0.25);                         // 翼端の警戒色
        else if (mod(r, 6) === 0) c = mix(c, C.steelDark, 0.20);
        c = faceShade(c, f);
        return jit(c, (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    /* 司令橋の窓。枠 + 斜めのハイライト。 */
    glass: (f, p, q) => {
        const { u, v, fw, fh } = q;
        if (u < 1 || v < 1 || u > fw - 2 || v > fh - 2) return MAT.bridge(f, p, q);
        if (mod(u, 7) === 0) return mix(C.steelDark, C.steel, 0.40);
        let c = C.glass;
        if ((u - v + 128) % 15 < 3) c = mix(c, C.glassLite, 0.55);
        if (v <= 1) c = mix(c, C.glassLite, 0.25);
        return jit(c, (hash(p.x, p.y, p.z) - 0.5) * 6);
    },

    /* 腹の格納庫扉(飛行機械の発艦口)。中央から左右に開く2枚扉 + 警戒色の縁。 */
    hangar: (f, p, q) => {
        if (f === "down") {
            const x = Math.abs(p.x);
            if (x < 1) return jit(mix(C.black, C.steelDark, 0.30), -3);              // 扉の合わせ目
            if (x > q.cube.x1 - 2) return jit(mix(C.hazard, C.black, mod(p.z, 4) < 2 ? 0.55 : 0.05), -3);
            let c = mix(C.steelDark, C.steel, 0.30 + 0.25 * vnoise(p.x, p.y, p.z, 6));
            if (mod(p.z, 9) === 0) c = mix(c, C.black, 0.35);                        // 扉の桁
            if (mod(x, 5) === 0) c = mix(c, C.steelLight, 0.12);
            return jit(edge(c, q, 0.30), (hash(p.x, p.y, p.z) - 0.5) * 7);
        }
        let c = mix(C.bellyDark, C.steelDark, 0.35);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.28), (hash(p.x, p.y, p.z) - 0.5) * 7);
    },

    /*
     * 探照灯。北面(前向き)がレンズ。同心円で反射鏡を描き、それ以外は鋼のケース。
     * 明るさをテクスチャで表現しているだけで、実際に光るわけではない。
     */
    lamp: (f, p, q) => {
        if (f === "north") {
            const cu = q.fw / 2 - 0.5, cv = q.fh / 2 - 0.5;
            const rr = Math.min(cu, cv);
            const r = Math.hypot(q.u - cu, q.v - cv);
            if (r > rr - 0.4) return jit(mix(C.steel, C.steelDark, 0.4), -4);
            if (r > rr - 1.6) return jit(C.brass, 2);
            return jit(mix(C.lamp, C.white, 0.25 * (r / Math.max(0.5, rr))), -2);
        }
        let c = mix(C.steel, C.steelDark, 0.30);
        if (mod(p.y, 3) === 0) c = mix(c, C.steelLight, 0.18);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.30), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },

    red: (f, p, q) => {
        let c = mix(C.red, C.redDark, 0.20 + 0.35 * vnoise(p.x * 2, p.y * 2, p.z, 4));
        c = faceShade(c, f);
        return jit(edge(c, q, 0.28), (hash(p.x, p.y, p.z) - 0.5) * 8);
    },
};

/**
 * 砲身の共通塗り。muzzle が true の面には同心の砲口を描き、それ以外は
 * 先端ほど焼けて暗い鋼として塗る。
 */
function bore(f, p, q, muzzle) {
    if (muzzle) {
        const cu = q.fw / 2 - 0.5, cv = q.fh / 2 - 0.5;
        const rr = Math.min(cu, cv);
        const r = Math.hypot(q.u - cu, q.v - cv);
        if (r > rr - 0.3) return jit(mix(C.gunmetal, C.steelDark, 0.4), -4);
        if (r > rr - 1.2) return jit(mix(C.steelLight, C.steel, 0.4), 2);
        return jit(mix(C.black, C.steelDark, 0.25), (hash(p.x, p.y, p.z) - 0.5) * 6);
    }
    let c = mix(C.gunmetal, C.steelDark, 0.25 + 0.25 * vnoise(p.x, p.y, p.z, 6));
    if (mod(p.z, 8) === 0 || mod(p.x, 8) === 0) c = mix(c, C.steelLight, 0.16);  // 砲身の環
    c = faceShade(c, f);
    return jit(edge(c, q, 0.30), (hash(p.x, p.y, p.z) - 0.5) * 8);
}

// flat 指定の面が参照する単色パッチ(見えない面。帯どうしの合わせ目など)
const SWATCH = {
    hull: C.armorDark, hullEnd: C.armorDark, frame: C.belt, keel: C.bellyDark,
    bridge: C.armorDark, turret: C.armorDark, gun: C.steelDark, gunx: C.steelDark,
    nacelle: C.steelDark, steel: C.steelDark, deck: C.steel, fin: C.armorDark,
    blade: C.steel, glass: C.steelDark, hangar: C.steelDark, lamp: C.steelDark,
    red: C.redDark,
};

/* ============================ モデル定義 ============================ */
const cubes = [];

function B(bone, x0, y0, z0, x1, y1, z1, mat, opts) {
    cubes.push(Object.assign({ bone, x0, y0, z0, x1, y1, z1, mat }, opts || {}));
}
/** x>0 側を渡すと同じボーンに左右対称で2個置く。flat の east/west と hub は反転する。 */
function BM(bone, x0, y0, z0, x1, y1, z1, mat, opts) {
    B(bone, x0, y0, z0, x1, y1, z1, mat, opts);
    const o = Object.assign({}, opts || {});
    if (o.flat) o.flat = o.flat.map((f) => (f === "east" ? "west" : f === "west" ? "east" : f));
    if (o.hub) o.hub = [-o.hub[0], o.hub[1]];
    B(bone, -x1, y0, z0, -x0, y1, z1, mat, o);
}

/* ---- 艦体: 艦首(-Z)から艦尾(+Z)へ、幅と高さを段階的に変える13セグメント。
       各セグメントは高さ方向の帯に分割し、上下ほど細くして断面を多角形に近づける。 ---- */
const SEG = [
    [-150, -142, 20, 20, "hullEnd"],
    [-142, -130, 36, 34, "hullEnd"],
    [-130, -114, 52, 48, "hullEnd"],
    [-114,  -94, 66, 60, "hull"],
    [ -94,  -66, 78, 70, "hull"],
    [ -66,  -20, 86, 76, "hull"],
    [ -20,   26, 88, 78, "hull"],   // 最大断面
    [  26,   62, 84, 74, "hull"],
    [  62,   94, 76, 66, "hull"],
    [  94,  118, 62, 54, "hull"],
    [ 118,  138, 46, 40, "hullEnd"],
    [ 138,  150, 28, 26, "hullEnd"],
    [ 150,  158, 14, 14, "hullEnd"],
];

/*
 * 断面の帯: [下端の高さ割合, 上端の高さ割合, 半幅の割合]。
 * 上を丸く、腹を平たく(下の帯の幅を残す)して「空を行く軍艦」の断面にしてある。
 */
const BANDS_6 = [[0, 0.12, 0.84], [0.12, 0.30, 0.96], [0.30, 0.60, 1.00], [0.60, 0.76, 0.94], [0.76, 0.90, 0.78], [0.90, 1, 0.50]];
const BANDS_4 = [[0, 0.16, 0.78], [0.16, 0.58, 1.00], [0.58, 0.82, 0.88], [0.82, 1, 0.56]];
const BANDS_2 = [[0, 0.62, 1.00], [0.62, 1, 0.70]];
const BANDS_1 = [[0, 1, 1.00]];
const bandsFor = (h) => (h >= 50 ? BANDS_6 : h >= 26 ? BANDS_4 : h >= 14 ? BANDS_2 : BANDS_1);

/** 断面 (w,h) を帯に割り、[半幅, y下端, y上端] の配列(下から上の順)にする。grow は外周フレーム用の膨らみ。 */
function section(w, h, grow) {
    const y0 = YC - h / 2;
    const out = [];
    for (const [a, b, f] of bandsFor(h)) {
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
    const sec = section(w, h, 0);
    sec.forEach(([hx, ya, yb], bi) => {
        const flat = [];
        if (covered(SEG[i - 1], hx, ya, yb)) flat.push("north");
        if (covered(SEG[i + 1], hx, ya, yb)) flat.push("south");
        // 帯どうしの合わせ目は見えない(冒頭の「アトラス節約」の注記を参照)
        if (bi > 0) flat.push("down");
        if (bi < sec.length - 1) flat.push("up");
        B("hull", -hx, ya, z0, hx, yb, z1, mat, { flat });
    });
});

/* ---- 艦体を締める外周フレーム(中身は艦体に埋まり、1単位はみ出した縁だけが見える) ---- */
[[-104, 3], [-72, 4], [-40, 5], [4, 6], [44, 7], [80, 8], [110, 9]].forEach(([z, si]) => {
    const s = SEG[si];
    const sec = section(s[2], s[3], 1);
    sec.forEach(([hx, ya, yb], bi) => {
        const flat = ["north", "south"];
        if (bi > 0) flat.push("down");
        if (bi < sec.length - 1) flat.push("up");
        B("hull", -hx, ya, z, hx, yb, z + 3, "frame", { flat });
    });
});

/* ---- 艦首の係留金具(艦首材の先端) ---- */
B("hull", -4, YC - 4, -156, 4, YC + 4, -150, "steel");

/* ---- 背の通路。砲塔の間を繋ぐグレーチングで、艦体上部にわずかに埋まっている ---- */
B("hull", -11, 108, -70, 11, 116, -60, "deck");
B("hull", -11, 108, -32, 11, 116,  32, "deck");
B("hull", -11, 108,  60, 11, 116,  86, "deck");

/* ---- 前檣(見張所・空中線の支柱) ---- */
B("hull", -5, 112, -17, 5, 128, -5, "steel");
B("hull", -3, 128, -14, 3, 146, -8, "steel");
B("hull", -7, 146, -18, 7, 152, -4, "deck");                       // 見張所
BM("hull", 3, 148, -13, 15, 150, -9, "steel");                     // 檣桁(ヤード)
/* 空中線(前檣の頂点から上部尾翼へ渡した1本の線) */
B("hull", -1, 149, -4, 1, 151, 132, "steel");

/*
 * ---- 背の連装砲塔 2基 / 腹の球形銃座 2基 ----
 * それぞれ自分のボーンに入れて旋回できるようにしてある。バーベットは艦体の上面より
 * 数単位下から始めて埋め、甲板と底面が同一平面で重なる(Zファイティング)のを避けている。
 */
/* 背1番砲塔(前) */
B("turret_t1", -15, 106, -60, 15, 120, -32, "turret", { flat: ["down"] });
B("turret_t1", -14, 120, -59, 14, 132, -33, "turret");
BM("turret_t1", 14, 122, -50, 18, 128, -42, "turret");             // 測距儀の腕
BM("turret_t1",  4, 123, -80,  8, 129, -58, "gun");                // 連装の砲身

/* 背2番砲塔(後) */
B("turret_t2", -15, 105, 32, 15, 119, 60, "turret", { flat: ["down"] });
B("turret_t2", -14, 119, 33, 14, 131, 59, "turret");
BM("turret_t2", 14, 121, 42, 18, 127, 50, "turret");
BM("turret_t2",  4, 122,  8,  8, 128, 34, "gun");

/* 腹1番銃座(前)。竜骨ゴンドラの下に吊る球形銃座 */
B("turret_b1", -12, 6, -92, 12, 16, -68, "turret", { flat: ["up"] });
B("turret_b1", -11, 0, -90, 11,  7, -70, "turret");
BM("turret_b1", 3, 1, -104, 7, 6, -88, "gun");

/* 腹2番銃座(後) */
B("turret_b2", -12, 6, 32, 12, 17, 56, "turret", { flat: ["up"] });
B("turret_b2", -11, 0, 34, 11,  7, 54, "turret");
BM("turret_b2", 3, 1, 54, 7, 6, 70, "gun");

/*
 * ---- 竜骨ゴンドラ(艦体の下を走る居住区) ----
 * 艦体の腹は艦首・艦尾へ行くほど持ち上がるので、上端(y1)を区画ごとに上げて
 * 艦体に食い込ませ、隙間が空かないようにしている。上面は艦体の中なので flat。
 */
B("keel", -14, 14, -116, 14, 52, -92, "keel", { flat: ["up", "north"] });
B("keel", -15, 13,  -92, 15, 46, -60, "keel", { flat: ["up", "north", "south"] });
B("keel", -17, 12,  -60, 17, 42,  12, "keel", { flat: ["up", "north", "south"] });
B("keel", -14, 14,   12, 14, 46,  76, "keel", { flat: ["up", "north"] });

/* ---- 腹の格納庫扉(飛行機械の発艦口) ---- */
B("keel", -15, 8, -22, 15, 12, 26, "hangar", { flat: ["up"] });

/* ---- ゴンドラ側面の救命艇ダビットと通風筒 ---- */
BM("keel", 15, 30, -50, 19, 38, -30, "steel", { flat: ["west"] });
BM("keel", 15, 30,  40, 19, 38,  60, "steel", { flat: ["west"] });

/*
 * ---- 司令橋(竜骨ゴンドラの前端。艦首の下に張り出す) ----
 * 上端 y=64 は艦首の腹(z=-138 で y=61)より高く取ってあり、艦体に食い込んで隙間が出ない。
 */
B("bridge", -20, 14, -138, 20, 64, -112, "bridge", { flat: ["up", "south"] });
B("bridge", -21, 34, -139, 21, 48, -113, "glass");                 // 窓帯(全周)
B("bridge", -13,  6, -132, 13, 14, -116, "turret", { flat: ["up"] }); // 装甲されたあご
BM("bridge",  4,  8, -146,  8, 12, -132, "gun");                   // 前向きの砲
BM("bridge", 15, 18, -144, 23, 28, -136, "lamp", { flat: ["south", "west"] }); // 探照灯

/*
 * ---- 舷側のケースメイト砲(前後2対) ----
 * 艦体に食い込ませてあるので、内側(x0 側)の面は見えない = flat。
 */
[[-84, -58], [26, 52]].forEach(([cz0, cz1]) => {
    BM("hull", 38, YC - 20, cz0, 52, YC - 2, cz1, "turret", { flat: ["west"] });
    BM("hull", 50, YC - 15, cz0 + 4, 60, YC - 7, cz0 + 12, "gunx");
});

/*
 * ---- エンジン: 舷側に張り出したパイロン + ナセル(前対は牽引式、後対は推進式) ----
 * ナセルの前後端はプロペラ面の基準になるので、動かしたら PROPS の zh も合わせること。
 */
[[-58, -1], [38, 1]].forEach(([zc, dir]) => {
    const nz0 = zc - 24, nz1 = zc + 24;
    const rz = dir < 0 ? [nz0, nz0 + 5] : [nz1 - 5, nz1];   // プロペラ側の端(カウルリング)
    BM("hull", 34, YC -  8, zc - 15, 50, YC +  8, zc + 15, "steel", { flat: ["west"] });   // パイロン
    BM("hull", 46, YC - 13, nz0, 64, YC + 13, nz1, "nacelle");                             // ナセル本体
    BM("hull", 44, YC - 16, zc - 7, 66, YC + 16, zc + 7, "nacelle");                       // 冷却フィンの膨らみ
    BM("hull", 44, YC - 15, rz[0], 66, YC + 15, rz[1], "steel");                           // カウルリング
    BM("hull", 52, YC + 13, zc - 18, 58, YC + 20, zc - 10, "steel");                       // 排気管
});

/*
 * ---- 4基の巨大プロペラ ----
 * 機軸(Z)まわりに回るので、羽根は X と Y に伸ばす。左右で回転方向を逆にするため
 * ボーンは1基につき1本(prop1〜4)。hub はテクスチャで翼端の警戒色を出すための中心。
 */
const PROPS = [
    ["prop1",  1, -82, -1],   // 右前(牽引式)
    ["prop2", -1, -82, -1],   // 左前
    ["prop3",  1,  62,  1],   // 右後(推進式)
    ["prop4", -1,  62,  1],   // 左後
];
PROPS.forEach(([bone, sx, zh, dir]) => {
    const hubZ   = dir < 0 ? [zh - 7, zh] : [zh, zh + 7];        // スピナー(ナセル側)
    const bladeZ = dir < 0 ? [zh - 12, zh - 7] : [zh + 7, zh + 12]; // 羽根の円板
    const X = (a, b) => (sx > 0 ? [a, b] : [-b, -a]);
    const hub = [sx * 55, YC];
    let [x0, x1] = X(47, 63); B(bone, x0, YC - 8, hubZ[0], x1, YC + 8, hubZ[1], "steel");
    [x0, x1] = X(51, 59);     B(bone, x0, YC - 24, bladeZ[0], x1, YC + 24, bladeZ[1], "blade", { hub });
    [x0, x1] = X(31, 79);     B(bone, x0, YC -  4, bladeZ[0], x1, YC +  4, bladeZ[1], "blade", { hub });
});

/*
 * ---- 尾翼(十字配置) ----
 * 前縁が段階的に後退するよう、根元側から3枚の板を継いでいる。
 * 根元は艦体に食い込ませてあり、後端(z=158)から先は可動面(rudder / elev_*)。
 */
/* 上部垂直尾翼 */
B("hull", -3, 88, 130, 3, 152, 158, "fin");
B("hull", -3, 88, 112, 3, 134, 130, "fin");
B("hull", -3, 88, 100, 3, 116, 112, "fin");
/* 下部垂直尾翼 */
B("hull", -3,  4, 130, 3, 68, 158, "fin");
B("hull", -3, 22, 112, 3, 68, 130, "fin");
B("hull", -3, 40, 100, 3, 68, 112, "fin");
/* 水平尾翼 */
BM("hull", 14, YC - 4, 130, 58, YC + 4, 158, "fin");
BM("hull", 14, YC - 4, 112, 44, YC + 4, 130, "fin");
BM("hull", 14, YC - 4, 100, 30, YC + 4, 112, "fin");

/* ---- 可動する操縦翼面 ---- */
B("rudder", -3, 88, 158, 3, 152, 176, "fin");
B("rudder", -3,  4, 158, 3,  68, 176, "fin");
B("elev_r",  14, YC - 4, 158, 58, YC + 4, 174, "fin");
B("elev_l", -58, YC - 4, 158, -14, YC + 4, 174, "fin");

/* ---- 軍艦旗(上部垂直尾翼の頂点) ---- */
B("flag", -1, 152, 152, 1, 166, 154, "steel");
B("flag",  0, 154, 154, 1, 164, 172, "red");

/*
 * ボーン階層 (name, parent, pivot)。
 * 砲塔・銃座・操縦翼面はここを軸に animations/goliath.animation.json で動かす。
 */
const BONES = [
    ["root", null, [0, 0, 0]],
    ["hull", "root", [0, YC, 0]],
    ["keel", "hull", [0, 30, 0]],
    ["bridge", "keel", [0, 40, -125]],
    ["turret_t1", "hull", [0, 120, -46]],
    ["turret_t2", "hull", [0, 119, 46]],
    ["turret_b1", "keel", [0, 10, -80]],
    ["turret_b2", "keel", [0, 10, 44]],
    ["rudder", "hull", [0, YC, 158]],
    ["elev_r", "hull", [16, YC, 158]],
    ["elev_l", "hull", [-16, YC, 158]],
    ["flag", "hull", [0, 153, 154]],
    ["prop1", "hull", [55, YC, -82]],
    ["prop2", "hull", [-55, YC, -82]],
    ["prop3", "hull", [55, YC, 62]],
    ["prop4", "hull", [-55, YC, 62]],
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
for (const W of [128, 256, 512, 1024]) {
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
            identifier: "geometry.civ.goliath",
            texture_width: TW,
            texture_height: TH,
            // 全長 20.8ブロック・全高 10.3ブロックの巨体なので、既定のバウンディングでは
            // 画面端で消えてしまう。実寸より少し大きめに取ってある。
            visible_bounds_width: 25,
            visible_bounds_height: 12,
            visible_bounds_offset: [0, 5.2, 0.6],
        },
        bones,
    }],
};

fs.writeFileSync(path.join(RP, "models/entity/goliath.geo.json"), JSON.stringify(geo, null, 2) + "\n");
fs.writeFileSync(path.join(RP, "textures/entity/goliath.png"), png);
console.log("cubes=" + cubes.length + " faces=" + rects.length + " atlas=" + TW + "x" + TH + " png=" + png.length + "B");
