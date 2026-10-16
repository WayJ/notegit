// S21-T1（A4）：favicon.ico 生成器——品牌 spike-mark 形象（DESIGN.md §1 品牌标记：
// #1677ff→#53b6ff 145° 渐变方片 + 白色四辐星芒，与顶栏 brand-mark 同构）。
// 产出 32×32 RGBA PNG-in-ICO（现代浏览器通用形态），写入
// server/src/web/assets/favicon.ico（GET /favicon.ico 的静态来源，见 web/assets.ts）。
// 可复跑：node scripts/make-favicon.mjs（字节确定性——同输入同输出）。
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 32;               // 32×32（favicon 常规档）
const RADIUS = 9;              // 方片圆角（26px 原型 8px × 32/26 ≈ 9.8，取 9）
const GRAD_A = [22, 119, 255]; // #1677ff（渐变起——DESIGN.md §1 品牌渐变原值）
const GRAD_B = [83, 182, 255]; // #53b6ff（渐变止）
// CSS 145° 渐变方向单位向量：(sin145°, -cos145°)（x 右、y 下坐标系）
const GX = Math.sin((145 * Math.PI) / 180);
const GY = -Math.cos((145 * Math.PI) / 180);
// spike-mark 两辐（24 viewBox 原值 × 32/24 缩放；stroke-width 2.6×1.333≈3.47）
const S = 32 / 24;
const STROKE = 2.6 * S;
const SPokes = [
  [5.6 * S, 5.6 * S, 18.4 * S, 18.4 * S],
  [18.4 * S, 5.6 * S, 5.6 * S, 18.4 * S],
];

const clamp01 = (v) => Math.min(1, Math.max(0, v));
/** 1px 过渡带抗锯齿：coverage = smoothstep */
const aa = (dist, edge) => clamp01(Math.min(edge + 0.5 - dist, 1));

/** 点到线段距离（round cap 语义：端点不裁剪） */
function distToSeg(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp01(((px - x1) * dx + (py - y1) * dy) / len2);
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** 圆角方片带符号距离（外负内正；用于边缘抗锯齿） */
function roundedRectSDF(px, py, half, r) {
  const qx = Math.abs(px - half) - (half - r);
  const qy = Math.abs(py - half) - (half - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// ── 像素栅格（2× 超采样抗锯齿） ───────────────────────────────────────────────
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1)); // 每行前置 filter 字节 0
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // PNG filter: None
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const px = x + sx - 0.5;
      const py = y + sy - 0.5;
      const chip = aa(roundedRectSDF(px, py, SIZE / 2, RADIUS), 0);
      if (chip <= 0) continue;
      // 渐变轴投影：以方片中心为原点，t=0（#1677ff）在上游角、t=1（#53b6ff）在下游角
      const half = (SIZE - 1) / 2;
      const p = (px - half) * GX + (py - half) * GY;
      const halfRange = half * (GX + GY);
      const t = clamp01((p + halfRange) / (2 * halfRange));
      let [cr, cg, cb] = [
        GRAD_A[0] + (GRAD_B[0] - GRAD_A[0]) * t,
        GRAD_A[1] + (GRAD_B[1] - GRAD_A[1]) * t,
        GRAD_A[2] + (GRAD_B[2] - GRAD_A[2]) * t,
      ];
      // 白色星芒（覆盖渐变；描边距离半宽内）
      const spoke = Math.min(...SPokes.map((seg) => distToSeg(px, py, seg)));
      const w = aa(spoke, STROKE / 2);
      if (w > 0) {
        cr = cr + (255 - cr) * w;
        cg = cg + (255 - cg) * w;
        cb = cb + (255 - cb) * w;
      }
      r += cr * chip;
      g += cg * chip;
      b += cb * chip;
      a += 255 * chip;
    }
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    raw[o] = Math.round(r / 4);
    raw[o + 1] = Math.round(g / 4);
    raw[o + 2] = Math.round(b / 4);
    raw[o + 3] = Math.round(a / 4);
  }
}

// ── PNG 编码（IHDR/IDAT/IEND + CRC32） ───────────────────────────────────────
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = ~0;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

// ── ICO 容器（PNG-in-ICO：ICONDIR + ICONDIRENTRY + PNG） ─────────────────────
const ico = Buffer.alloc(22 + png.length);
ico.writeUInt16LE(0, 0);            // reserved
ico.writeUInt16LE(1, 2);            // type: icon
ico.writeUInt16LE(1, 4);            // count
ico[6] = SIZE;                      // width
ico[7] = SIZE;                      // height
ico[8] = 0;                         // palette
ico[9] = 0;                         // reserved
ico.writeUInt16LE(1, 10);           // color planes
ico.writeUInt16LE(32, 12);          // bits per pixel
ico.writeUInt32LE(png.length, 14);  // bytes in resource
ico.writeUInt32LE(22, 18);          // offset
png.copy(ico, 22);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'src', 'web', 'assets', 'favicon.ico');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, ico);
console.log(`favicon.ico written: ${out} (${ico.length} bytes; png ${png.length})`);
