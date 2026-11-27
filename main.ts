import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

// ---------- CRC32 ----------
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// ---------- PNG decode to RGBA ----------
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
function channelsFor(colorType) {
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 3) return 1;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  throw new Error("unsupported color type " + colorType);
}
function decodePNG(buf) {
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error("not png");
  let off = 8;
  let width = 0, height = 0, bitDepth = 8, colorType = 6;
  let palette = null, trns = null;
  const idatParts = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (bitDepth !== 8) throw new Error("unsupported bit depth " + bitDepth);
      if (data[12] !== 0) throw new Error("interlaced unsupported");
    } else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "tRNS") trns = Buffer.from(data);
    else if (type === "IDAT") idatParts.push(Buffer.from(data));
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const ch = channelsFor(colorType);
  const stride = width * ch;
  const unfiltered = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[rowStart + x];
      const a = x >= ch ? unfiltered[outStart + x - ch] : 0;
      const b = y > 0 ? unfiltered[outStart - stride + x] : 0;
      const c = x >= ch && y > 0 ? unfiltered[outStart - stride + x - ch] : 0;
      let r;
      if (filter === 0) r = v;
      else if (filter === 1) r = (v + a) & 0xff;
      else if (filter === 2) r = (v + b) & 0xff;
      else if (filter === 3) r = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) r = (v + paeth(a, b, c)) & 0xff;
      else throw new Error("bad filter " + filter);
      unfiltered[outStart + x] = r;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4, s = i * ch;
    if (colorType === 0) {
      const g = unfiltered[s];
      let a = 255;
      if (trns && trns.length >= 2 && g === trns.readUInt16BE(0)) a = 0;
      rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = a;
    } else if (colorType === 2) {
      const r = unfiltered[s], g = unfiltered[s + 1], b = unfiltered[s + 2];
      let a = 255;
      if (trns && trns.length >= 6 && r === trns.readUInt16BE(0) && g === trns.readUInt16BE(2) && b === trns.readUInt16BE(4)) a = 0;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
    } else if (colorType === 3) {
      const idx = unfiltered[s];
      rgba[o] = palette[idx * 3]; rgba[o + 1] = palette[idx * 3 + 1]; rgba[o + 2] = palette[idx * 3 + 2];
      rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
    } else if (colorType === 4) {
      const g = unfiltered[s];
      rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = unfiltered[s + 1];
    } else {
      rgba[o] = unfiltered[s]; rgba[o + 1] = unfiltered[s + 1]; rgba[o + 2] = unfiltered[s + 2]; rgba[o + 3] = unfiltered[s + 3];
    }
  }
  return { width, height, rgba };
}

// ---------- filtering ----------
function filterRow(filter, row, prev, bpp, out) {
  for (let x = 0; x < row.length; x++) {
    const v = row[x];
    const a = x >= bpp ? row[x - bpp] : 0;
    const b = prev ? prev[x] : 0;
    const c = prev && x >= bpp ? prev[x - bpp] : 0;
    let r;
    if (filter === 0) r = v;
    else if (filter === 1) r = (v - a) & 0xff;
    else if (filter === 2) r = (v - b) & 0xff;
    else if (filter === 3) r = (v - ((a + b) >> 1)) & 0xff;
    else r = (v - paeth(a, b, c)) & 0xff;
    out[x] = r;
  }
}
function scoreRow(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) { const b = buf[i]; s += b < 128 ? b : 256 - b; }
  return s;
}
function buildFiltered(pixelData, width, height, ch, mode) {
  const stride = width * ch;
  const out = Buffer.alloc(height * (stride + 1));
  const tmp = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = pixelData.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixelData.subarray((y - 1) * stride, y * stride) : null;
    const outStart = y * (stride + 1);
    if (mode === "paeth") {
      out[outStart] = 4;
      filterRow(4, row, prev, ch, tmp);
      out.set(tmp, outStart + 1);
    } else {
      let bestFilter = 0, bestScore = Infinity;
      for (let f = 0; f < 5; f++) {
        filterRow(f, row, prev, ch, tmp);
        const sc = scoreRow(tmp);
        if (sc < bestScore) { bestScore = sc; bestFilter = f; best.set(tmp); }
      }
      out[outStart] = bestFilter;
      out.set(best, outStart + 1);
    }
  }
  return out;
}

// ---------- encode candidate ----------
function encodePNG(width, height, colorType, pixelData, palette, trns, mode, strategy, prefiltered) {
  const ch = channelsFor(colorType);
  const filtered = prefiltered || buildFiltered(pixelData, width, height, ch, mode);
  const compressed = zlib.deflateSync(filtered, { level: 9, memLevel: 9, strategy });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr)];
  if (palette) parts.push(chunk("PLTE", palette));
  if (trns) parts.push(chunk("tRNS", trns));
  parts.push(chunk("IDAT", compressed));
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}
function verify(candidate, width, height, rgba) {
  try {
    const d = decodePNG(candidate);
    if (d.width !== width || d.height !== height) return false;
    if (d.rgba.length !== rgba.length) return false;
    for (let i = 0; i < rgba.length; i++) if (d.rgba[i] !== rgba[i]) return false;
    return true;
  } catch { return false; }
}

// ---------- per-image squeeze ----------
function squeeze(inputBuf) {
  const { width, height, rgba } = decodePNG(inputBuf);
  const n = width * height;
  // analysis
  const colourMap = new Map();
  const firstOrder = [];
  let isGrey = true, alphaAll255 = true, alphaBinary = true;
  const transparentRGB = new Set();
  const opaqueRGB = new Set();
  for (let i = 0; i < n; i++) {
    const o = i * 4, r = rgba[o], g = rgba[o + 1], b = rgba[o + 2], a = rgba[o + 3];
    const key = (r * 256 + g) * 65536 + b * 256 + a;
    if (!colourMap.has(key)) { colourMap.set(key, firstOrder.length); firstOrder.push(key); }
    if (r !== g || g !== b) isGrey = false;
    if (a !== 255) alphaAll255 = false;
    if (a !== 0 && a !== 255) alphaBinary = false;
    const rgbKey = (r * 256 + g) * 256 + b;
    if (a === 0) transparentRGB.add(rgbKey); else opaqueRGB.add(rgbKey);
  }
  const distinct = firstOrder.length;
  let trnsRGB = null;
  if (alphaBinary && !alphaAll255 && transparentRGB.size === 1) {
    const only = [...transparentRGB][0];
    if (!opaqueRGB.has(only)) trnsRGB = only;
  }

  const reps = []; // {colorType, data, palette, trns}
  function makeData(ch, fill) {
    const data = new Uint8Array(n * ch);
    for (let i = 0; i < n; i++) fill(i, i * 4, data, i * ch);
    return data;
  }
  // palette candidates
  if (distinct <= 256) {
    const sorted = [...firstOrder].sort((x, y) => x - y);
    for (const order of [firstOrder, sorted]) {
      const indexOf = new Map();
      order.forEach((k, idx) => indexOf.set(k, idx));
      const pal = Buffer.alloc(order.length * 3);
      const alphas = new Uint8Array(order.length);
      order.forEach((k, idx) => {
        const a = k % 256, b = Math.floor(k / 256) % 256, g = Math.floor(k / 65536) % 256, r = Math.floor(k / 16777216);
        pal[idx * 3] = r; pal[idx * 3 + 1] = g; pal[idx * 3 + 2] = b; alphas[idx] = a;
      });
      let lastNon255 = -1;
      for (let i = 0; i < alphas.length; i++) if (alphas[i] !== 255) lastNon255 = i;
      const trns = lastNon255 >= 0 ? Buffer.from(alphas.subarray(0, lastNon255 + 1)) : null;
      const data = makeData(1, (i, o, d, s) => { d[s] = indexOf.get((rgba[o] * 256 + rgba[o + 1]) * 65536 + rgba[o + 2] * 256 + rgba[o + 3]); });
      reps.push({ colorType: 3, data, palette: pal, trns });
    }
  }
  if (isGrey && alphaAll255) {
    reps.push({ colorType: 0, data: makeData(1, (i, o, d, s) => { d[s] = rgba[o]; }), palette: null, trns: null });
  }
  if (isGrey && trnsRGB !== null) {
    const gval = Math.floor(trnsRGB / 65536);
    const trns = Buffer.alloc(2); trns.writeUInt16BE(gval, 0);
    reps.push({ colorType: 0, data: makeData(1, (i, o, d, s) => { d[s] = rgba[o]; }), palette: null, trns });
  }
  if (isGrey && !alphaAll255) {
    reps.push({ colorType: 4, data: makeData(2, (i, o, d, s) => { d[s] = rgba[o]; d[s + 1] = rgba[o + 3]; }), palette: null, trns: null });
  }
  if (alphaAll255) {
    reps.push({ colorType: 2, data: makeData(3, (i, o, d, s) => { d[s] = rgba[o]; d[s + 1] = rgba[o + 1]; d[s + 2] = rgba[o + 2]; }), palette: null, trns: null });
  }
  if (trnsRGB !== null) {
    const r = Math.floor(trnsRGB / 65536), g = Math.floor(trnsRGB / 256) % 256, b = trnsRGB % 256;
    const trns = Buffer.alloc(6);
    trns.writeUInt16BE(r, 0); trns.writeUInt16BE(g, 2); trns.writeUInt16BE(b, 4);
    reps.push({ colorType: 2, data: makeData(3, (i, o, d, s) => { d[s] = rgba[o]; d[s + 1] = rgba[o + 1]; d[s + 2] = rgba[o + 2]; }), palette: null, trns });
  }
  // RGBA always
  reps.push({ colorType: 6, data: new Uint8Array(rgba), palette: null, trns: null });

  let best = null;
  const variants = [
    { mode: "adaptive", strategy: zlib.constants.Z_DEFAULT_STRATEGY },
    { mode: "adaptive", strategy: zlib.constants.Z_FILTERED },
    { mode: "paeth", strategy: zlib.constants.Z_DEFAULT_STRATEGY },
  ];
  for (const rep of reps) {
    const filteredByMode = new Map();
    for (const v of variants) {
      if (!filteredByMode.has(v.mode)) filteredByMode.set(v.mode, buildFiltered(rep.data, width, height, channelsFor(rep.colorType), v.mode));
      const cand = encodePNG(width, height, rep.colorType, rep.data, rep.palette, rep.trns, v.mode, v.strategy, filteredByMode.get(v.mode));
      if (cand.length > 4 * 1024 * 1024) continue;
      if (best && cand.length >= best.length) continue;
      if (!verify(cand, width, height, rgba)) continue;
      best = cand;
    }
  }
  if (best) return best;
  // fallback: verified RGBA+Paeth
  const fb = encodePNG(width, height, 6, new Uint8Array(rgba), null, null, "paeth", zlib.constants.Z_DEFAULT_STRATEGY);
  if (verify(fb, width, height, rgba)) return fb;
  return inputBuf;
}

const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
for (let i = 1; i <= 8; i++) {
  const id = "i" + String(i).padStart(3, "0");
  const inPath = path.join(inputDir, id, "image.png");
  if (!fs.existsSync(inPath)) continue;
  const inputBuf = fs.readFileSync(inPath);
  let outBuf;
  try { outBuf = squeeze(inputBuf); } catch { outBuf = inputBuf; }
  const outDir = path.join(outputDir, id);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "image.png"), outBuf);
}
