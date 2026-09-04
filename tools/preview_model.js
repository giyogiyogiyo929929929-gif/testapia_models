"use strict";
/*
 * preview_model.js -- 生成した geo + テクスチャを Node だけでオフラインレンダリングして
 * PNG に出す確認用ツール。Minecraft を起動しなくてもシルエットと塗りの当たりを確認できる。
 *
 *   node tools/preview_model.js tank            -> tools/preview/tank_*.png
 *   node tools/preview_model.js airship [出力先]
 *
 * ボーンの pivot / rotation は無視してモデル空間のまま描く(可動部は静止状態で見る)。
 * カメラの寄せと位置合わせはモデルのバウンディングボックスから自動で決める。
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const RP = path.resolve(__dirname, "..");
const NAME = process.argv[2] || "tank";
const OUT = process.argv[3] || path.join(RP, "tools/preview");

const geo = JSON.parse(fs.readFileSync(path.join(RP, `models/entity/${NAME}.geo.json`), "utf8"));
const g = geo["minecraft:geometry"][0];
const TW = g.description.texture_width, TH = g.description.texture_height;

/* --- PNG デコード(このリポジトリのジェネレータが吐く filter=0 の RGBA8 専用) --- */
function readPNG(file) {
    const buf = fs.readFileSync(file);
    let off = 8, idat = [];
    while (off < buf.length) {
        const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8);
        if (type === "IDAT") idat.push(buf.slice(off + 8, off + 8 + len));
        off += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const out = Buffer.alloc(TW * TH * 4);
    for (let y = 0; y < TH; y++) raw.copy(out, y * TW * 4, y * (1 + TW * 4) + 1, (y + 1) * (1 + TW * 4));
    return out;
}
const tex = readPNG(path.join(RP, `textures/entity/${NAME}.png`));

/* --- 面ごとの (原点, u方向ベクトル, v方向ベクトル, 法線)。
       各ジェネレータの faceInfo() と対で維持すること --- */
function faceQuad(o, s, face) {
    const [x0, y0, z0] = o, w = s[0], h = s[1], d = s[2];
    const x1 = x0 + w, y1 = y0 + h, z1 = z0 + d;
    switch (face) {
        case "north": return { O: [x1, y1, z0], U: [-w, 0, 0], V: [0, -h, 0], N: [0, 0, -1] };
        case "south": return { O: [x0, y1, z1], U: [w, 0, 0], V: [0, -h, 0], N: [0, 0, 1] };
        case "east":  return { O: [x1, y1, z1], U: [0, 0, -d], V: [0, -h, 0], N: [1, 0, 0] };
        case "west":  return { O: [x0, y1, z0], U: [0, 0, d], V: [0, -h, 0], N: [-1, 0, 0] };
        case "up":    return { O: [x0, y1, z0], U: [w, 0, 0], V: [0, 0, d], N: [0, 1, 0] };
        case "down":  return { O: [x0, y0, z1], U: [w, 0, 0], V: [0, 0, -d], N: [0, -1, 0] };
    }
}

/* モデル全体のバウンディングボックス(カメラの中心と倍率に使う) */
const BB = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
for (const bone of g.bones) for (const cube of bone.cubes || []) {
    for (let i = 0; i < 3; i++) {
        BB.min[i] = Math.min(BB.min[i], cube.origin[i]);
        BB.max[i] = Math.max(BB.max[i], cube.origin[i] + cube.size[i]);
    }
}
const CTR = [0, 1, 2].map((i) => (BB.min[i] + BB.max[i]) / 2);
const SIZE = [0, 1, 2].map((i) => BB.max[i] - BB.min[i]);

const LIGHT = (() => { const v = [-0.45, 0.78, -0.44]; const l = Math.hypot(...v); return v.map((c) => c / l); })();

/** yaw/pitch(度)で回した正射投影。fit は「画面短辺に対してモデルをどれだけ詰めるか」 */
function render(file, yawDeg, pitchDeg, W, H, fit) {
    const cy = Math.cos(yawDeg * Math.PI / 180), sy = Math.sin(yawDeg * Math.PI / 180);
    const cp = Math.cos(pitchDeg * Math.PI / 180), sp = Math.sin(pitchDeg * Math.PI / 180);
    // 回転後に必要な画面上の広がりから倍率を決める
    const spanX = Math.abs(SIZE[0] * cy) + Math.abs(SIZE[2] * sy);
    const spanY = Math.abs(SIZE[1] * cp) + Math.abs((Math.abs(SIZE[0] * sy) + Math.abs(SIZE[2] * cy)) * sp);
    const scale = fit * Math.min(W / Math.max(1, spanX), H / Math.max(1, spanY));

    const px = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) { px[i * 4] = 24; px[i * 4 + 1] = 26; px[i * 4 + 2] = 30; px[i * 4 + 3] = 255; }
    const zb = new Float64Array(W * H).fill(Infinity);
    const cx0 = W / 2, cy0 = H / 2;
    const step = 1 / (scale * 1.6);

    for (const bone of g.bones) {
        for (const cube of bone.cubes || []) {
            for (const face of ["north", "east", "south", "west", "up", "down"]) {
                const q = faceQuad(cube.origin, cube.size, face);
                const uvr = cube.uv[face];
                const fw = Math.hypot(...q.U), fh = Math.hypot(...q.V);
                // 背面カリング(法線を回転して z が手前を向く面だけ描く)
                const nz = (q.N[0] * sy + q.N[2] * cy) * cp + q.N[1] * sp;
                if (nz >= 0) continue;
                const lam = Math.max(0, q.N[0] * LIGHT[0] + q.N[1] * LIGHT[1] + q.N[2] * LIGHT[2]);
                const shade = 0.45 + 0.55 * lam;
                for (let v = 0; v <= fh; v += step) {
                    for (let u = 0; u <= fw; u += step) {
                        const tu = u / fw, tv = v / fh;
                        const X = q.O[0] + q.U[0] * tu + q.V[0] * tv - CTR[0];
                        const Y = q.O[1] + q.U[1] * tu + q.V[1] * tv - CTR[1];
                        const Z = q.O[2] + q.U[2] * tu + q.V[2] * tv - CTR[2];
                        const rx = X * cy - Z * sy, rz0 = X * sy + Z * cy;
                        const ry = Y * cp - rz0 * sp, rz = Y * sp + rz0 * cp;
                        const sx = Math.round(cx0 + rx * scale), sYy = Math.round(cy0 - ry * scale);
                        if (sx < 0 || sYy < 0 || sx >= W || sYy >= H) continue;
                        const idx = sYy * W + sx;
                        if (rz >= zb[idx]) continue;
                        zb[idx] = rz;
                        const txx = Math.min(TW - 1, uvr.uv[0] + Math.floor(u * uvr.uv_size[0] / fw));
                        const tyy = Math.min(TH - 1, uvr.uv[1] + Math.floor(v * uvr.uv_size[1] / fh));
                        const ti = (tyy * TW + txx) * 4;
                        px[idx * 4] = Math.min(255, tex[ti] * shade);
                        px[idx * 4 + 1] = Math.min(255, tex[ti + 1] * shade);
                        px[idx * 4 + 2] = Math.min(255, tex[ti + 2] * shade);
                        px[idx * 4 + 3] = 255;
                    }
                }
            }
        }
    }
    writePNG(path.join(OUT, file), W, H, px);
}

const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
function writePNG(file, W, H, px) {
    const raw = Buffer.alloc(H * (1 + W * 4));
    for (let y = 0; y < H; y++) { raw[y * (1 + W * 4)] = 0; px.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4); }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
    fs.writeFileSync(file, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0)),
    ]));
}

fs.mkdirSync(OUT, { recursive: true });
render(`${NAME}_side.png`, 90, 0, 800, 380, 0.92);
render(`${NAME}_three_quarter.png`, 55, -24, 800, 500, 0.90);
render(`${NAME}_top.png`, 90, -88, 800, 400, 0.92);
render(`${NAME}_front.png`, 0, -8, 520, 440, 0.90);
console.log(`preview (${NAME}) written to ${OUT}`);
