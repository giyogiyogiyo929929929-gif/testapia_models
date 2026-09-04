"use strict";
/*
 * gen_dragon.js -- civ:dragon(ドラゴン)のモデル一式ジェネレータ
 *
 * 生成物:
 *   models/entity/dragon.geo.json  ... 形状 + per-face UV
 *   textures/entity/dragon.png     ... 上記UVに合わせて手続き的に描いたアトラス
 *
 * 使い方:  node tools/gen_dragon.js       (このリソースパックのルートから)
 *
 * 設計方針(gen_warrior.js / gen_goliath.js と同じ):
 *   - 形状はこのファイル内の cube 定義がソース。Blockbench で開ける普通の geo を吐くが、
 *     UV はここが正なので、形をいじったら必ず再生成すること。
 *   - UV は box UV ではなく per-face UV。面ごとに 1テクセル = 1モデル単位。
 *   - 塗りはモデル空間の座標を受け取る関数。鱗・腹甲・翼膜の血管が面をまたいで繋がるよう、
 *     左右対称(|x| 依存)か上下/前後方向にだけ依存する模様に留めてある。
 *
 * 座標系: 16単位 = 1ブロック。頭は -Z(scripts/unitModels.js の yawTowards が yaw=0 で
 *   -Z を向く前提)、上が +Y。
 *     全長  z = -106 .. 154(260単位 ≒ 16.3ブロック。鼻先から尾の刃の先まで)
 *     全幅  x = ±96 (翼端。胴体そのものは ±22)
 *     全高  y =    0 .. 131(足の裏から角の先まで。背中は y=64、頭は y=96..116)
 *
 * 💡 【y=0 が接地面。四つ足で立っている姿勢】
 *   飛行ユニットではなく地上に立たせる前提で組んである(前足 z=-36..-16 / 後足 z=12..34 の
 *   足裏が y=0)。翼は「広げて構えた」状態を geo に直接持たせてあり、アニメーションは
 *   そこへの加算。浮かせて飛ばしたいなら root を +Y に上げ、羽ばたきの振幅を増やすこと。
 *
 * 💡 【曲面はボーン回転ではなくキューブの階段で作ってある】
 *   首・尾・翼のしなりは tools/preview_model.js がボーン回転を無視する都合上、
 *   キューブ座標そのものを段違いに積んで表現している(gen_artillery.js の開脚と同じ)。
 *   ボーンの rotation はアニメーション用の余白として空けてあるので、静止ポーズを
 *   変えたいときはここのキューブ座標を直すこと。
 *
 * 💡 【同一平面に同じ向きの面を置かない】
 *   有機的な形を積み木で作ると、部品の側面が親の側面とぴったり重なって z-fighting しやすい。
 *   胴に生える部品(眉庇・頬角・脚・背びれ)は必ず「親より外へ 1 以上はみ出す」か
 *   「完全に内側へ埋める」かのどちらかにしてある。座標を触るときはここを崩さないこと。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const RP = path.resolve(__dirname, "..");

/* ============================ パレット ============================ */
const C = {
    scale:      [0x7E, 0x24, 0x1E], // 背側の鱗(緋)
    scaleDark:  [0x47, 0x12, 0x11],
    scaleLight: [0xB2, 0x43, 0x2E],
    scaleDeep:  [0x2C, 0x0C, 0x0D], // 鱗の谷・部品の縁
    belly:      [0xC6, 0x9E, 0x5C], // 腹甲(黄土)
    bellyDark:  [0x8B, 0x69, 0x36],
    bellyLight: [0xE0, 0xC0, 0x82],
    // 💡 翼膜は「鱗と同じ赤」にすると遠目で背中の板に見えてしまうので、
    //    わざと紫寄りの鈍い色に落として体色と分離してある。
    membrane:   [0x5E, 0x2C, 0x33], // 翼膜(付け根側は厚くて暗い)
    membraneLt: [0xC4, 0x7A, 0x5E], // 翼端側は光が透ける
    vein:       [0x33, 0x12, 0x16],
    horn:       [0xC2, 0xB2, 0x92], // 角・翼指(体色と喧嘩しないよう少し暖色に落としてある)
    hornDark:   [0x7A, 0x6C, 0x52],
    hornTip:    [0x4E, 0x42, 0x35],
    claw:       [0x2B, 0x27, 0x24], // 爪
    clawLight:  [0x55, 0x4E, 0x47],
    tooth:      [0xE8, 0xE0, 0xC8],
    eye:        [0xF2, 0xB2, 0x30], // 琥珀色の目(縦の瞳孔)
    eyeHot:     [0xFF, 0xE4, 0x8C],
    black:      [0x16, 0x14, 0x14],
    white:      [0xE4, 0xDE, 0xD0],
    soot:       [0x2A, 0x24, 0x20], // 口元・鼻孔の煤
    ember:      [0xE8, 0x6A, 0x22], // 腹甲の隙間から漏れる熾火
    emberHot:   [0xFF, 0xC4, 0x5A],
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const jit = (c, n) => [clamp(c[0] + n, 0, 255), clamp(c[1] + n, 0, 255), clamp(c[2] + n, 0, 255)];
function hash(x, y, z) {
    const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return h - Math.floor(h);
}
const smooth = (t) => t * t * (3 - 2 * t);
/** 格子サイズ s の値ノイズ。体色のむら用。 */
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
const nz = (p, a) => (hash(p.x * 0.9, p.y * 1.3, p.z * 0.7) - 0.5) * a;

/* 面ローカル座標での縁の暗さ(部品の輪郭) */
function edge(c, q, amt) {
    const { u, v, fw, fh } = q;
    if (u === 0 || v === 0 || u === fw - 1 || v === fh - 1) return mix(c, C.scaleDeep, amt);
    return c;
}

/* 面の向きによる明暗。上面は明るく、下面と後面は暗く。 */
function faceShade(c, f) {
    if (f === "up") return mix(c, C.white, 0.09);
    if (f === "down") return mix(c, C.black, 0.16);
    if (f === "south") return mix(c, C.black, 0.10);
    return c;
}

/* ============================ 塗りの部品 ============================ */

/*
 * 鱗の並び。面の向きで「鱗の列がどちらに走るか」を切り替える。
 *   側面   … 水平の列が縦に積む      (a=z,   b=y)
 *   上下面 … 体軸に直交する列        (a=|x|, b=z)
 *   前後面 … 水平の列                (a=|x|, b=y)
 * どれも左右対称な量しか使っていないので、面の UV が左右反転しても崩れない。
 */
function scaleCoords(p, f) {
    if (f === "up" || f === "down") return [Math.abs(p.x), p.z];
    if (f === "north" || f === "south") return [Math.abs(p.x), p.y];
    return [p.z, p.y];
}
function scales(c, p, f, sw, sh) {
    const [a, b] = scaleCoords(p, f);
    const SW = sw || 5, SH = sh || 3;
    const row = Math.floor(b / SH);
    const off = mod(row, 2) ? SW / 2 : 0;
    const la = ((a + off) % SW + SW) % SW;
    const lb = ((b % SH) + SH) % SH;
    if (lb < 1) c = mix(c, C.scaleDark, 0.42);              // 鱗の下端(重なりの影)
    else if (lb > SH - 1.2) c = mix(c, C.scaleLight, 0.16); // 鱗の上端(ハイライト)
    if (la < 1) c = mix(c, C.scaleDark, 0.24);              // 鱗どうしの合わせ目
    return c;
}

/* 体色のむら。背は暗く、脇腹へ向かって明るくする。 */
function hide(p) {
    const t = clamp((p.y - 24) / 46, 0, 1);
    let c = mix(C.scaleLight, C.scale, 0.35 + 0.55 * t);
    c = mix(c, C.scaleDark, 0.30 * vnoise(p.x * 0.7, p.y * 0.7, p.z * 0.5, 17));
    // 背中に走る暗い縞(体軸に直交)
    if (mod(p.z, 13) < 2 && p.y > 40) c = mix(c, C.scaleDark, 0.35);
    return c;
}

/*
 * 腹甲。体軸に直交する板が並ぶ。
 * 💡 喉〜胸の板の隙間だけ熾火が漏れているように光らせている(ブレスの伏線)。
 *    ここを消すと正面から見たときのシルエットが一気に地味になる。
 */
function plates(c, p) {
    const t = mod(p.z, 6);
    if (t === 0) {
        c = mix(c, C.bellyDark, 0.60);
        const glow = clamp((-20 - p.z) / 40, 0, 1);   // 前(喉側)ほど強い
        if (glow > 0) c = mix(c, mix(C.ember, C.emberHot, 0.35 * vnoise(p.x, p.y, p.z, 5)), glow * 0.75);
    } else if (t === 1) c = mix(c, C.bellyLight, 0.22);
    else if (t === 5) c = mix(c, C.bellyDark, 0.25);
    return c;
}

/*
 * 翼膜。付け根 (|x|=18, z=-14) から放射する血管と、翼端へ向かうほど薄くなる透け。
 * 面をまたいで繋がるよう、|x| と z だけで決めている(y には依存しない)。
 * 💡 lit は「光が透けて見える強さ」。翼を下から見上げたときだけ明るくしたいので
 *    呼び出し側が下面に大きい値を渡す。上面まで明るくすると体色と同化して
 *    背中に赤い板が乗っているようにしか見えなくなる。
 */
function veins(c, p, lit) {
    const dx = Math.max(1, Math.abs(p.x) - 18), dz = p.z + 14;
    const d = Math.hypot(dx, dz);
    const ang = Math.atan2(dz, dx);
    c = mix(c, C.membraneLt, clamp(d / 95, 0, 1) * lit);           // 薄い所は光が透ける
    const k = ((ang * 6.5) % 1 + 1) % 1;
    if (k < 0.11 && d > 8) c = mix(c, C.vein, 0.60);               // 主血管(放射)
    if (mod(d, 19) === 0 && d > 24) c = mix(c, C.vein, 0.25);      // 環状の細い枝
    if (hash(p.x * 2.1, 0, p.z * 1.7) > 0.985) c = mix(c, C.vein, 0.35); // 古傷の点
    return c;
}

/* ============================ マテリアル ============================ */
/* (face, p={x,y,z}(モデル空間), q={u,v,fw,fh,cube}) -> [r,g,b] */

const MAT = {
    /* 背側の鱗。胴・首・尾・脚。 */
    scale: (f, p, q) => {
        let c = scales(hide(p), p, f);
        if (f === "down") c = mix(c, C.belly, 0.30);   // 腹寄りは黄土に振る
        c = faceShade(c, f);
        return jit(edge(c, q, 0.22), nz(p, 8));
    },

    /* 腹甲。板の並びと熾火。 */
    belly: (f, p, q) => {
        let c = mix(C.belly, C.bellyDark, 0.25 + 0.40 * vnoise(p.x * 0.8, p.y, p.z * 0.6, 11));
        c = plates(c, p);
        if (f === "east" || f === "west") c = mix(c, C.scale, 0.35); // 脇は背側の色へ繋ぐ
        c = faceShade(c, f);
        return jit(edge(c, q, 0.20), nz(p, 7));
    },

    /* 頭。側面に琥珀色の目、鼻筋に鼻孔と煤。 */
    head: (f, p, q) => {
        let c = scales(hide(p), p, f, 4, 3);
        const side = (f === "east" || f === "west");

        // 目(|x|>=10 の頭蓋側面にだけ描く)
        if (side && Math.abs(p.x) > 9) {
            const r = Math.hypot((p.z + 78) / 3.2, (p.y - 105) / 2.2);
            if (r < 1.6) c = mix(c, C.black, clamp((1.6 - r) * 1.8, 0, 0.85));  // 眼窩の影
            if (r < 1.0) {
                c = mix(C.eye, C.eyeHot, clamp(1 - r, 0, 1) * 0.7);
                if (Math.abs(p.z + 78) < 0.8) c = mix(C.black, C.scaleDeep, 0.25); // 縦の瞳孔
                if (p.y > 106) c = mix(c, C.black, 0.35);                          // 上まぶたの影
            }
        }
        // 鼻孔(鼻先の上面と側面)
        const nd = Math.hypot(Math.abs(p.x) - 3, (p.z + 101) / 1.6);
        if (p.z < -97 && nd < 2.0) c = mix(c, C.soot, 0.85 - 0.2 * nd);
        // 歯並び。立体の牙は上下1対だけなので、残りは口の縁の切れ込みで見せる。
        if (side && p.z < -84 && p.z > -100 && p.y < 98) {
            if (mod(p.z, 3) === 0) c = mix(c, C.tooth, clamp((98 - p.y) / 2, 0, 1) * 0.75);
        }
        // 口の縁の煤
        if (p.z < -82 && p.y < 100) c = mix(c, C.soot, clamp((100 - p.y) / 6, 0, 1) * 0.35);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.24), nz(p, 8));
    },

    /* 下顎。上面(口の中)は熾火で赤く光らせる。 */
    jaw: (f, p, q) => {
        if (f === "up" && p.z < -84) {
            const g = mix(C.ember, C.emberHot, 0.30 + 0.45 * vnoise(p.x, p.y, p.z, 4));
            return jit(mix(g, C.soot, 0.25), nz(p, 12));
        }
        let c = scales(mix(hide(p), C.belly, 0.22), p, f, 4, 3);
        if (mod(p.z, 5) === 0) c = mix(c, C.bellyDark, 0.35);  // 顎下の板
        // 下側の歯並び(上顎とは z を1つずらして噛み合わせる)
        if ((f === "east" || f === "west") && p.y > 92.5 && p.z < -82) {
            if (mod(p.z, 3) === 1) c = mix(c, C.tooth, clamp((p.y - 92.5) / 2, 0, 1) * 0.75);
        }
        c = mix(c, C.soot, clamp((-90 - p.z) / 14, 0, 1) * 0.30);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.24), nz(p, 8));
    },

    /* 角・翼指・爪の付け根。長手方向に節が入り、先端ほど黒く焼ける。 */
    horn: (f, p, q) => {
        const t = clamp((p.y - 116) / 24, 0, 1) + clamp((Math.abs(p.x) - 66) / 34, 0, 1);
        let c = mix(C.horn, C.hornDark, 0.20 + 0.45 * vnoise(p.x, p.y * 0.5, p.z, 6));
        c = mix(c, C.hornTip, clamp(t, 0, 1) * 0.70);
        const ring = (f === "up" || f === "down") ? p.z : p.y;
        if (mod(ring, 3) === 0) c = mix(c, C.hornDark, 0.40);   // 成長の節
        if (mod(ring, 3) === 1) c = mix(c, C.horn, 0.25);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.28), nz(p, 9));
    },

    /*
     * 背びれと尾の刃。骨の条(ray)の間に翼膜と同じ膜が張った鰭として塗る。
     * 💡 角と同じ骨色にすると白いタブが背中に並んでいるようにしか見えなかったので、
     *    翼膜の色を共有させて「翼と同じ質感の鰭」に見えるようにしてある。
     */
    fin: (f, p, q) => {
        let c = mix(C.membrane, C.scale, 0.35 + 0.30 * vnoise(p.x, p.y * 0.6, p.z, 9));
        if (mod(p.z, 4) === 0) c = mix(c, C.hornDark, 0.45);          // 骨の条(縦に走る)
        else if (mod(p.z, 4) === 2) c = mix(c, C.vein, 0.30);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.26), nz(p, 8));
    },

    /* 尾の刃。背びれと同じ鰭だが、条が体軸(z)方向に走るので y で刻む。 */
    blade: (f, p, q) => {
        let c = mix(C.membrane, C.scale, 0.30 + 0.30 * vnoise(p.x, p.y, p.z * 0.6, 9));
        if (mod(p.y, 4) === 0) c = mix(c, C.hornDark, 0.50);
        else if (mod(p.y, 4) === 2) c = mix(c, C.vein, 0.30);
        c = mix(c, C.hornDark, clamp((p.z - 138) / 18, 0, 1) * 0.45);  // 先端は角質化
        c = faceShade(c, f);
        return jit(edge(c, q, 0.26), nz(p, 8));
    },

    /* 爪。付け根は角質、先は黒光り。 */
    claw: (f, p, q) => {
        const t = clamp((p.z < 0 ? (-34 - p.z) : (12 - p.z)) / 7, 0, 1);
        let c = mix(C.clawLight, C.claw, 0.35 + 0.55 * t);
        if (mod(p.z, 2) === 0) c = mix(c, C.claw, 0.25);
        c = faceShade(c, f);
        return jit(edge(c, q, 0.30), nz(p, 7));
    },

    /* 牙。 */
    tooth: (f, p, q) => {
        const c = mix(C.tooth, C.hornDark, 0.15 + 0.35 * vnoise(p.x, p.y, p.z, 3));
        return jit(faceShade(edge(c, q, 0.26), f), nz(p, 6));
    },

    /* 翼膜。上面(陽の当たる側)は暗く、下面は透けて明るい。 */
    membrane: (f, p, q) => {
        let c = mix(C.membrane, C.vein, 0.20 + 0.30 * vnoise(p.x * 0.5, 0, p.z * 0.5, 21));
        c = veins(c, p, f === "down" ? 0.60 : 0.34);
        if (f === "down") c = mix(c, C.membraneLt, 0.20);     // 逆光で透ける
        else if (f !== "up") c = mix(c, C.vein, 0.35);        // 薄い側面は縁として暗く
        return jit(edge(c, q, 0.18), nz(p, 6));
    },
};

// flat 指定の面が参照する単色パッチ(足の裏など、どの角度からも見えない面)
const SWATCH = {
    scale: C.scaleDark, belly: C.bellyDark, head: C.scaleDark, jaw: C.bellyDark,
    horn: C.hornDark, claw: C.claw, tooth: C.hornDark, membrane: C.vein,
    fin: C.vein, blade: C.vein,
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
/** 同じボーン内で x>0 側を左右対称に2個置く(角・背びれの左右など)。 */
function BM(bone, x0, y0, z0, x1, y1, z1, mat, opts) {
    B(bone, x0, y0, z0, x1, y1, z1, mat, opts);
    B(bone, -x1, y0, z0, -x0, y1, z1, mat, mirrorOpts(opts));
}
/** 左右で別ボーンに分かれる部品(翼・脚)。x>0 側の座標を渡す。 */
function LR(boneR, boneL, x0, y0, z0, x1, y1, z1, mat, opts) {
    B(boneR, x0, y0, z0, x1, y1, z1, mat, opts);
    B(boneL, -x1, y0, z0, -x0, y1, z1, mat, mirrorOpts(opts));
}
const D = ["down"];   // 接地面。どの角度からも見えない

/*
 * 胴・首・尾の一区画。断面を「腹甲 / 脇腹 / 背」の帯に割った八角形にする。
 * 幅が足りない尾の先だけは面取り無しの1キューブ。
 */
function SEG(bone, z0, z1, hw, yb, yt, opts) {
    const o = opts || {};
    const bodyMat = o.belly === false ? "scale" : "belly";
    if (hw < 8) {
        B(bone, -hw, yb, z0, hw, yt, z1, "scale");
        return;
    }
    const hi = hw - 5;
    const yMid = yb + Math.max(5, Math.round((yt - yb) * 0.42));
    B(bone, -hi, yb, z0, hi, yb + 4, z1, bodyMat, o.flatBottom ? { flat: D } : undefined); // 腹の面取り
    B(bone, -hw, yb + 4, z0, hw, yMid, z1, bodyMat);                                       // 下側の帯
    B(bone, -hw, yMid, z0, hw, yt - 4, z1, "scale");                                       // 脇腹〜背
    B(bone, -hi, yt - 4, z0, hi, yt, z1, "scale");                                         // 背の面取り
}

/* ---- 胴(胸 -> 腹 -> 腰) ---- */
SEG("body", -36, -6, 22, 26, 64);
SEG("body",  -6, 18, 21, 28, 62);
SEG("body",  18, 42, 19, 30, 58);

/*
 * ---- 首。胸から急な階段で持ち上げ、頭を胴より完全に上へ出す。
 *      💡 ここを寝かせると正面から頭が胴に隠れて「首の長いトカゲ」に見える。
 *         各段の底面が1つ下の段の上面より低いこと(=段が繋がっていること)を保つこと。 ----
 */
SEG("neck", -44, -32, 14, 50,  74);
SEG("neck", -52, -42, 12, 60,  84);
SEG("neck", -58, -50, 11, 70,  94);
SEG("neck", -64, -56, 10, 80, 102);
/*
 * 喉。下顎の後ろから首の前面へ渡す埋め木。
 * 💡 これが無いと下顎の付け根から首までが素通しになり、横から見て「頭が浮いている」。
 *    head ではなく neck の子なので、頭を振っても喉は首に付いたまま残る。
 */
B("neck", -8, 82, -76, 8, 96, -60, "belly");

/*
 * ---- 頭。頭蓋 -> 鼻筋 -> 鼻先 と 4 ずつ段を落として楔形にする。
 *      💡 上顎(head)の底面 y=96 と下顎(jaw)の上面 y=95 の 1 単位の隙間が口の線。
 *         ここを詰めると顎が溶接されたように見え、広げると常に口が開いて見える。 ----
 */
B("head", -11,  96,  -84, 11, 112, -60, "head");   // 頭蓋(後端で首に食い込ませる)
B("head", -10, 110,  -84, 10, 116, -70, "head");   // 頭頂〜眉間の盛り上がり
B("head",  -8,  96,  -96,  8, 108, -84, "head");   // 鼻筋
B("head",  -6,  95, -103,  6, 105, -96, "head");   // 鼻先(やや下向き)
B("head",  -4, 101, -106,  4, 106, -103, "head");  // 鼻の瘤
/*
 * 頬(顎の付け根から首へ繋ぐ壁)。
 * 💡 これが無いと下顎の後ろが素通しになり、横から見て「頭と顎が離れて浮いている」
 *    ように見える。下顎(z=-100..-80)の真後ろから始めて、開閉時にめり込まないこと。
 */
B("head", -10, 92, -80, 10, 100, -64, "head");
BM("head",  8, 108, -86, 13, 113, -74, "horn");   // 眼窩の上のひさし(頭蓋より外へ出す)
BM("head", 10,  96, -78, 14, 101, -66, "horn");   // 頬から後ろへ流れる角(2段でテーパー)
BM("head", 12,  97, -70, 15, 101, -60, "horn");

/*
 * ---- 角(後ろへ寝かせながら4段)。
 *      💡 段どうしを y で 4、z で 10 以上重ねること。突き合わせに近づけると
 *         横から見て「灰色の四角が階段状に浮いている」ようにしか見えない。
 *         y の段差より z の伸びを大きく取ると、階段ではなく後方へ流れる角に見える。 ----
 */
BM("head", 5, 110, -80, 11, 119, -62, "horn");
BM("head", 5, 116, -74, 10, 124, -50, "horn");
BM("head", 5, 121, -64,  9, 128, -40, "horn");
BM("head", 5, 125, -52,  8, 131, -30, "horn");

/*
 * ---- 牙。上下1対ずつだけ立体で作り、残りの歯並びは口の縁の塗りで表現する。
 *      💡 立体の牙を並べると横から見て柵にしか見えないので、|x|=8..10(顎 ±7 と
 *         鼻筋 ±8 の外側)に1本ずつ、上下で z をずらして噛み合わせている。 ----
 */
BM("head", 8, 91, -94, 10, 97, -91, "tooth");

/* ---- 下顎(jaw ボーンで開閉する) ---- */
B("jaw", -7, 87, -100, 7, 95, -80, "jaw");
B("jaw", -5, 88, -104, 5, 94, -100, "jaw");
BM("jaw",  4, 82,  -96, 7, 88, -90, "horn");   // 顎髭の棘
BM("jaw",  8, 95,  -87, 10, 100, -84, "tooth");

/*
 * ---- 背びれ。首から尾の先まで1列。根元を胴に埋め、上へ2段(下が幅広・上が細い)で
 *      突き出して三角に見せる。(z0, z1, y0, y1) は各区画の背の高さに合わせてある ----
 */
function FINBLADE(bone, z0, z1, y0, y1) {
    const yMid = y0 + Math.round((y1 - y0) * 0.55);
    B(bone, -3, y0, z0, 3, yMid, z1, "fin");
    B(bone, -2, yMid, z0 + 2, 2, y1, z1 - 2, "fin");
}
const FIN = [
    ["neck", -62, -56,  96, 113], ["neck", -55, -49,  86, 104],
    ["neck", -48, -42,  76,  94], ["neck", -41, -35,  66,  84],
    ["body", -34, -28,  60,  78], ["body", -26, -20,  60,  78],
    ["body", -18, -12,  60,  76], ["body", -10,  -4,  60,  76],
    ["body",  -2,   4,  58,  73], ["body",   6,  12,  58,  72],
    ["body",  14,  20,  56,  70], ["body",  22,  28,  54,  68],
    ["body",  30,  36,  52,  66],
    ["tail1", 44,  50,  50,  63], ["tail1", 54,  60,  48,  60],
    ["tail2", 80,  86,  41,  51], ["tail2", 90,  96,  38,  47],
    ["tail3", 114, 120, 32,  41],
];
for (const [bone, z0, z1, y0, y1] of FIN) FINBLADE(bone, z0, z1, y0, y1);

/* ---- 尾(付け根から6段で細らせ、先端は縦の刃) ---- */
SEG("tail1",  42,  62, 15, 32, 54);
SEG("tail1",  62,  78, 12, 32, 50);
SEG("tail2",  78,  96,  9, 31, 45);
SEG("tail2",  96, 112,  7, 30, 40);
SEG("tail3", 112, 126,  5, 29, 37);
SEG("tail3", 126, 138,  3, 29, 35);
/* 尾の刃。矢尻形に3段。1枚の大きな板にすると横から見て「板が刺さっている」ようにしか見えない。 */
B("tail3", -1, 27, 130, 1, 37, 138, "blade");
B("tail3", -2, 23, 136, 2, 41, 148, "blade");
B("tail3", -1, 26, 146, 1, 38, 154, "blade");

/*
 * ---- 翼。肩 -> 上腕 -> 肘 -> 前腕 -> 手首(wing_*)、その先の指(wingtip_*)。
 *      x が外へ行くほど y を上げてあるので、静止状態でも「広げて構えた」形に見える。 ----
 */
LR("wing_r", "wing_l", 16, 54, -26, 28, 70,  -4, "scale");   // 肩(胴に埋める)
LR("wing_r", "wing_l", 28, 62, -24, 40, 74, -10, "scale");   // 上腕
LR("wing_r", "wing_l", 40, 68, -22, 50, 80, -10, "scale");   // 肘
LR("wing_r", "wing_l", 50, 74, -20, 62, 86, -10, "scale");   // 前腕
LR("wing_r", "wing_l", 62, 80, -18, 70, 90, -10, "scale");   // 手首
LR("wing_r", "wing_l", 66, 89, -24, 71, 96, -16, "claw");    // 翼の鉤爪

LR("wingtip_r", "wingtip_l", 68, 84, -17, 78, 91, -9, "horn"); // 指(前縁)
LR("wingtip_r", "wingtip_l", 78, 88, -15, 88, 94, -9, "horn");
LR("wingtip_r", "wingtip_l", 88, 91, -13, 96, 96, -9, "horn");

/*
 * 翼膜。前縁の骨組みの下に張り、後縁は外へ行くほど短くして扇形にする。
 * 💡 隣り合う板は x でも y でも 1 以上重ねてあること。突き合わせにすると
 *    段差の所に隙間が空いて、正面から翼が透けて見える。
 */
LR("wing_r", "wing_l", 18, 62,  -6, 31, 66, 34, "membrane");
LR("wing_r", "wing_l", 30, 65, -11, 43, 69, 31, "membrane");
LR("wing_r", "wing_l", 42, 69, -11, 53, 74, 27, "membrane");
LR("wing_r", "wing_l", 52, 73, -11, 63, 79, 22, "membrane");
LR("wing_r", "wing_l", 62, 78, -11, 71, 85, 16, "membrane");
LR("wingtip_r", "wingtip_l", 66, 84, -10, 79, 89,  9, "membrane");
LR("wingtip_r", "wingtip_l", 78, 88, -10, 89, 93,  1, "membrane");
LR("wingtip_r", "wingtip_l", 88, 91, -10, 96, 96, -4, "membrane");

/* 翼膜を支える指(第2指・第3指)。膜に少し埋めて筋として見せる。 */
LR("wing_r", "wing_l", 40, 68, -10, 43, 73, 29, "horn");
LR("wing_r", "wing_l", 60, 78, -10, 63, 84, 18, "horn");

/* ---- 前脚(肩 -> 上腕 -> 前腕 -> 足 -> 爪) ---- */
LR("leg_fr", "leg_fl", 13, 24, -32, 26, 46, -12, "scale");
LR("leg_fr", "leg_fl", 15, 12, -30, 25, 28, -16, "scale");
LR("leg_fr", "leg_fl", 15,  2, -28, 24, 16, -18, "scale");
LR("leg_fr", "leg_fl", 13,  0, -36, 26,  6, -16, "scale", { flat: D });
LR("leg_fr", "leg_fl", 13,  0, -41, 17,  4, -35, "claw");
LR("leg_fr", "leg_fl", 18,  0, -42, 22,  4, -35, "claw");
LR("leg_fr", "leg_fl", 22,  0, -41, 26,  4, -35, "claw");

/* ---- 後脚(腿 -> 脛 -> 足 -> 爪)。腿を大きく取って踏ん張った形にする ---- */
LR("leg_hr", "leg_hl", 13, 18, 14, 28, 52, 44, "scale");
LR("leg_hr", "leg_hl", 16,  4, 22, 25, 24, 40, "scale");
LR("leg_hr", "leg_hl", 15,  0, 12, 27,  8, 34, "scale", { flat: D });
LR("leg_hr", "leg_hl", 15,  0,  5, 18,  4, 13, "claw");
LR("leg_hr", "leg_hl", 19,  0,  4, 23,  4, 13, "claw");
LR("leg_hr", "leg_hl", 24,  0,  5, 27,  4, 13, "claw");
LR("leg_hr", "leg_hl", 17,  2, 33, 22,  7, 40, "claw");   // 後ろ向きの蹴爪

/*
 * ボーン階層 (name, parent, pivot[, rotation])。
 * 💡 pivot は「その部品が実際に曲がる関節の位置」に置いてある。
 *    翼は肩(x=±17, y=62, z=-16)まわりに Z 軸で羽ばたかせる前提なので、
 *    ここを動かすと羽ばたきで翼が胴から抜ける。
 */
const BONES = [
    ["root", null, [0, 0, 0]],
    ["body", "root", [0, 42, 0]],
    ["neck", "body", [0, 52, -34]],
    ["head", "neck", [0, 100, -64]],
    ["jaw", "head", [0, 95, -80]],
    ["wing_r", "body", [17, 62, -16]],
    ["wing_l", "body", [-17, 62, -16]],
    ["wingtip_r", "wing_r", [68, 86, -13]],
    ["wingtip_l", "wing_l", [-68, 86, -13]],
    ["tail1", "body", [0, 42, 42]],
    ["tail2", "tail1", [0, 38, 78]],
    ["tail3", "tail2", [0, 33, 112]],
    ["leg_fr", "body", [18, 40, -24]],
    ["leg_fl", "body", [-18, 40, -24]],
    ["leg_hr", "body", [20, 46, 30]],
    ["leg_hl", "body", [-20, 46, 30]],
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
for (let i = 0; i < TW * TH; i++) { px[i * 4] = 26; px[i * 4 + 1] = 22; px[i * 4 + 2] = 24; px[i * 4 + 3] = 255; }
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
            identifier: "geometry.civ.dragon",
            texture_width: TW,
            texture_height: TH,
            visible_bounds_width: 18,
            visible_bounds_height: 9,
            visible_bounds_offset: [0, 4.1, 0],
        },
        bones,
    }],
};

fs.writeFileSync(path.join(RP, "models/entity/dragon.geo.json"), JSON.stringify(geo, null, 2) + "\n");
fs.writeFileSync(path.join(RP, "textures/entity/dragon.png"), png);
console.log("cubes=" + cubes.length + " faces=" + rects.length + " atlas=" + TW + "x" + TH + " png=" + png.length + "B");
