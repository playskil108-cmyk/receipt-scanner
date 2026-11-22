/* 영수증 스캐너 — 이미지 처리 코어 (원근 보정 · 자동 감지 · 명암 보정). 전역 S 상태를 사용합니다. */
// ---------- geometry ----------
function solve(A, b) {
  const n = b.length;
  for (let i = 0; i < n; i++) A[i] = A[i].concat([b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const piv = A[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / piv;
      if (!f) continue;
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[n] / (row[i] || 1e-12));
}
function homography(dst, src) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = dst[i], [x, y] = src[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  return solve(A, b);
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function outSize() {
  const c = S.corners;
  const ow = Math.max(dist(c[0], c[1]), dist(c[3], c[2]));
  const oh = Math.max(dist(c[0], c[3]), dist(c[1], c[2]));
  return { ow: Math.max(8, ow), oh: Math.max(8, oh) };
}
function warp(dw, dh) {
  const h = homography([[0, 0], [dw, 0], [dw, dh], [0, dh]], S.corners);
  const out = new ImageData(dw, dh), od = out.data, sd = S.srcData.data, W = S.W, H = S.H;
  let o = 0;
  for (let y = 0; y < dh; y++) {
    const v = y + 0.5;
    for (let x = 0; x < dw; x++) {
      const u = x + 0.5;
      const den = h[6] * u + h[7] * v + 1;
      let sx = (h[0] * u + h[1] * v + h[2]) / den - 0.5;
      let sy = (h[3] * u + h[4] * v + h[5]) / den - 0.5;
      if (sx < 0) sx = 0; else if (sx > W - 1.001) sx = W - 1.001;
      if (sy < 0) sy = 0; else if (sy > H - 1.001) sy = H - 1.001;
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * W + x0) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4;
      for (let k = 0; k < 3; k++) {
        const a = sd[i00 + k] + (sd[i10 + k] - sd[i00 + k]) * fx;
        const b = sd[i01 + k] + (sd[i11 + k] - sd[i01 + k]) * fx;
        od[o + k] = a + (b - a) * fy;
      }
      od[o + 3] = 255;
      o += 4;
    }
  }
  return out;
}

// ---------- auto detect ----------
function fullCorners() { return [[0, 0], [S.W, 0], [S.W, S.H], [0, S.H]]; }
function detect() {
  // clear paper-vs-surface contrast (dark desk): the bright-blob outline is exact
  const blob = detectBlob();
  if (blob) return blob;
  // white paper on a light desk: find the text block, then the paper edges around it
  try { const r = detectText(S.src, S.W, S.H); if (r && r.corners.every(p => isFinite(p[0]) && isFinite(p[1]))) return r.corners; } catch (e) {}
  return null;
}
function detectText(src, W, H) {
  const s = 360 / Math.max(W, H);
  const w = Math.max(8, Math.round(W * s)), h = Math.max(8, Math.round(H * s)), N = w * h;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(N);
  for (let i = 0; i < N; i++) g[i] = d[i*4] * 0.299 + d[i*4+1] * 0.587 + d[i*4+2] * 0.114;
  const boxBlur = (a, r) => {
    const t = new Float32Array(N), o = new Float32Array(N);
    for (let y = 0; y < h; y++) { let acc = 0, cnt = 0; const row = y * w;
      for (let x = -r; x < w; x++) {
        if (x + r < w) { acc += a[row + x + r]; cnt++; }
        if (x - r - 1 >= 0) { acc -= a[row + x - r - 1]; cnt--; }
        if (x >= 0) t[row + x] = acc / cnt; } }
    for (let x = 0; x < w; x++) { let acc = 0, cnt = 0;
      for (let y = -r; y < h; y++) {
        if (y + r < h) { acc += t[(y + r) * w + x]; cnt++; }
        if (y - r - 1 >= 0) { acc -= t[(y - r - 1) * w + x]; cnt--; }
        if (y >= 0) o[y * w + x] = acc / cnt; } }
    return o; };
  const gs = boxBlur(g, 1);
  // --- 1. text pixels and clusters
  const lm = boxBlur(g, 7), text = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (g[i] < lm[i] * 0.86 && lm[i] - g[i] > 12) text[i] = 1;
  const dil = new Uint8Array(N), R = 3;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (text[y*w+x])
    for (let yy = Math.max(0, y-R); yy <= Math.min(h-1, y+R); yy++) for (let xx = Math.max(0, x-R); xx <= Math.min(w-1, x+R); xx++) dil[yy*w+xx] = 1;
  const lab = new Int32Array(N), st = new Int32Array(N), comps = [];
  for (let i = 0, id = 0; i < N; i++) {
    if (!dil[i] || lab[i]) continue;
    id++; let sp = 0, txt = 0, x0 = w, y0 = h, x1 = 0, y1 = 0, sx = 0, sy = 0, cnt = 0; st[sp++] = i; lab[i] = id;
    while (sp) { const p = st[--sp]; const x = p % w, y = (p / w) | 0; txt += text[p]; cnt++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && dil[p-1] && !lab[p-1]) { lab[p-1] = id; st[sp++] = p-1; }
      if (x < w-1 && dil[p+1] && !lab[p+1]) { lab[p+1] = id; st[sp++] = p+1; }
      if (y > 0 && dil[p-w] && !lab[p-w]) { lab[p-w] = id; st[sp++] = p-w; }
      if (y < h-1 && dil[p+w] && !lab[p+w]) { lab[p+w] = id; st[sp++] = p+w; } }
    if (txt < 12) continue;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (Math.max(bw / bh, bh / bw) > 6 && Math.min(bw, bh) < 14) continue; // thin line: paper edge or shadow
    const cx = sx / cnt / w - 0.5, cy = sy / cnt / h - 0.5;
    comps.push({ x0, y0, x1, y1, txt, score: txt * (1 - Math.min(0.9, Math.hypot(cx, cy) * 1.4)) });
  }
  if (!comps.length) return null;
  comps.sort((a, b) => b.score - a.score);
  const tall = (comps[0].y1 - comps[0].y0) >= (comps[0].x1 - comps[0].x0);
  const box = { ...comps[0] }, used = new Set([0]), gap = Math.max(w, h) * 0.045;
  for (let changed = true; changed;) { changed = false;
    comps.forEach((k, i) => { if (used.has(i)) return;
      const dx = Math.max(0, k.x0 - box.x1, box.x0 - k.x1), dy = Math.max(0, k.y0 - box.y1, box.y0 - k.y1);
      // receipts stack lines along their long axis: candidate must overlap the main block across it
      const ov = tall ? (Math.min(k.x1, box.x1) - Math.max(k.x0, box.x0)) / (k.x1 - k.x0 + 1)
                      : (Math.min(k.y1, box.y1) - Math.max(k.y0, box.y0)) / (k.y1 - k.y0 + 1);
      if (dx <= gap && dy <= gap && ov >= 0.6) { used.add(i); changed = true;
        box.x0 = Math.min(box.x0, k.x0); box.y0 = Math.min(box.y0, k.y0); box.x1 = Math.max(box.x1, k.x1); box.y1 = Math.max(box.y1, k.y1); } }); }
  // --- 2. paper edges: oriented edge pixels near each side of the text box, Hough vote for a near-axis line
  const Gx = new Float32Array(N), Gy = new Float32Array(N);
  for (let y = 1; y < h-1; y++) for (let x = 1; x < w-1; x++) { const i = y*w+x;
    Gx[i] = gs[i-w+1] + 2*gs[i+1] + gs[i+w+1] - gs[i-w-1] - 2*gs[i-1] - gs[i+w-1];
    Gy[i] = gs[i+w-1] + 2*gs[i+w] + gs[i+w+1] - gs[i-w-1] - 2*gs[i-w] - gs[i-w+1]; }
  const bw0 = box.x1 - box.x0, bh0 = box.y1 - box.y0;
  const band = Math.round(Math.max(w, h) * 0.25), GMIN = 12;
  const lines = {}, info = {};
  for (const side of ['L', 'R', 'T', 'B']) {
    const vert = side === 'L' || side === 'R';
    const out = (side === 'L' || side === 'T') ? -1 : 1;           // outward direction along the normal axis
    const edge = side === 'L' ? box.x0 : side === 'R' ? box.x1 : side === 'T' ? box.y0 : box.y1;
    const inset = 1;
    const a0 = (vert ? box.y0 : box.x0) - (vert ? bh0 : bw0) * 0.05, a1 = (vert ? box.y1 : box.x1) + (vert ? bh0 : bw0) * 0.05;
    const ac = (a0 + a1) / 2, span = a1 - a0;
    const sideBand = Math.max(6, Math.round((vert ? bw0 : bh0) * (vert ? 0.18 : 0.12)));
    const t0 = edge - out * inset, t1 = edge + out * sideBand;          // normal-axis search range
    const lo = Math.max(1, Math.min(t0, t1)), hi = Math.min((vert ? w : h) - 2, Math.max(t0, t1));
    const A0 = Math.max(1, Math.floor(a0)), A1 = Math.min((vert ? h : w) - 2, Math.ceil(a1)), NA = A1 - A0 + 1;
    const NB = hi - lo + 1, E = new Uint8Array(NA * NB);
    let edges = 0;
    for (let a = A0; a <= A1; a++) for (let t = lo; t <= hi; t++) {
      const i = vert ? a * w + t : t * w + a;
      const gn = vert ? Gx[i] : Gy[i], ga = vert ? Gy[i] : Gx[i];
      if (Math.abs(gn) < GMIN || Math.abs(ga) > Math.abs(gn) * 0.7) continue;
      E[(a - A0) * NB + (t - lo)] = 1; edges++;
    }
    const density = edges / (NA * NB);
    const thr = Math.max(0.45, Math.min(0.8, density * 2 + 0.25));
    const SL = 25, MS = 0.25;
    const cov = new Float32Array(NB), covS = new Float32Array(NB);
    for (let si = 0; si < SL; si++) { const m = -MS + 2 * MS * si / (SL - 1);
      for (let b = 0; b < NB; b++) { let hit = 0;
        for (let a = 0; a < NA; a++) { const t = Math.round(b + m * (a + A0 - ac));
          if (t < 0 || t >= NB) continue; const r = a * NB;
          if (E[r + t] || (t > 0 && E[r + t - 1]) || (t < NB - 1 && E[r + t + 1])) hit++; }
        const c = hit / NA; if (c > cov[b]) { cov[b] = c; covS[b] = si; } } }
    let best = null;
    for (let b = 0; b < NB; b++) if (cov[b] >= thr && (!best || cov[b] > best.v + 0.02 || (cov[b] >= best.v - 0.02 && out * (b - best.bi) < 0))) {
      best = { v: cov[b], bi: b, m: -MS + 2 * MS * covS[b] / (SL - 1), b: b + lo }; }
    const need = thr;
    info[side] = (best ? best.v.toFixed(2) : 'none') + ' thr ' + thr.toFixed(2) + ' d ' + density.toFixed(3);
    if (best) {
      lines[side] = { m: best.m, b: best.b - best.m * ac };
    } else {
      const margin = Math.max(bw0, bh0) * 0.03;
      lines[side] = { m: 0, b: edge + out * margin, fallback: true };
    }
  }
  // intersect: vertical line x = mL*y + bL with horizontal y = mT*x + bT
  const meet = (V, Hh) => { const y = (Hh.m * V.b + Hh.b) / (1 - Hh.m * V.m); return [V.m * y + V.b, y]; };
  const q = [meet(lines.L, lines.T), meet(lines.R, lines.T), meet(lines.R, lines.B), meet(lines.L, lines.B)];
  const back = (p) => [Math.min(W, Math.max(0, p[0] / s)), Math.min(H, Math.max(0, p[1] / s))];
  return { corners: q.map(back), method: Object.entries(lines).map(([k, l]) => k + (l.fallback ? '-' : '+')).join(''), info };
}

function detectBlob() {
  const s = 240 / Math.max(S.W, S.H);
  const sw = Math.max(4, Math.round(S.W * s)), sh = Math.max(4, Math.round(S.H * s));
  const c = document.createElement('canvas'); c.width = sw; c.height = sh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(S.src, 0, 0, sw, sh);
  const d = ctx.getImageData(0, 0, sw, sh).data, N = sw * sh;
  const g = new Uint8Array(N), hist = new Array(256).fill(0);
  for (let i = 0; i < N; i++) { const v = (d[i*4] * 0.299 + d[i*4+1] * 0.587 + d[i*4+2] * 0.114) | 0; g[i] = v; hist[v]++; }
  // Otsu
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, t = 128, sep = 0;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = N - wB; if (!wF) break;
    sB += i * hist[i];
    const mB = sB / wB, mF = (sum - sB) / wF, between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; t = i; sep = mF - mB; }
  }
  if (sep < 55) return null;
  const lab = new Int32Array(N), stack = new Int32Array(N);
  let bestId = 0, bestArea = 0, id = 0;
  for (let i = 0; i < N; i++) {
    if (g[i] <= t || lab[i]) continue;
    id++; let sp = 0, area = 0; stack[sp++] = i; lab[i] = id;
    while (sp) {
      const p = stack[--sp]; area++;
      const x = p % sw, y = (p / sw) | 0;
      const nb = [x > 0 ? p - 1 : -1, x < sw - 1 ? p + 1 : -1, y > 0 ? p - sw : -1, y < sh - 1 ? p + sw : -1];
      for (const q of nb) if (q >= 0 && !lab[q] && g[q] > t) { lab[q] = id; stack[sp++] = q; }
    }
    if (area > bestArea) { bestArea = area; bestId = id; }
  }
  if (bestArea < N * 0.06 || bestArea > N * 0.95) return null;
  let tl, tr, br, bl, mTl = Infinity, mTr = -Infinity, mBr = -Infinity, mBl = Infinity;
  for (let i = 0; i < N; i++) {
    if (lab[i] !== bestId) continue;
    const x = i % sw + 0.5, y = ((i / sw) | 0) + 0.5;
    if (x + y < mTl) { mTl = x + y; tl = [x, y]; }
    if (x + y > mBr) { mBr = x + y; br = [x, y]; }
    if (x - y > mTr) { mTr = x - y; tr = [x, y]; }
    if (x - y < mBl) { mBl = x - y; bl = [x, y]; }
  }
  // trust it only when the blob is a clean quadrilateral away from the photo's borders
  let touch = 0;
  for (let x = 0; x < sw; x++) { if (lab[x] === bestId) { touch++; break; } }
  for (let x = 0; x < sw; x++) { if (lab[(sh - 1) * sw + x] === bestId) { touch++; break; } }
  for (let y = 0; y < sh; y++) { if (lab[y * sw] === bestId) { touch++; break; } }
  for (let y = 0; y < sh; y++) { if (lab[y * sw + sw - 1] === bestId) { touch++; break; } }
  const quad = [tl, tr, br, bl];
  let qa = 0; for (let i = 0; i < 4; i++) { const a = quad[i], b = quad[(i + 1) % 4]; qa += a[0] * b[1] - b[0] * a[1]; }
  qa = Math.abs(qa) / 2;
  if (touch > 0 || !qa || bestArea / qa < 0.85 || bestArea / qa > 1.15) return null;
  const back = (p) => [Math.min(S.W, Math.max(0, p[0] / s)), Math.min(S.H, Math.max(0, p[1] / s))];
  return [back(tl), back(tr), back(br), back(bl)];
}

// ---------- enhancement ----------
function enhance(img) {
  const { width: w, height: h, data: d } = img, n = w * h, o = S.opts;
  if (o.shadow) {
    const cs = Math.max(2, Math.round(Math.max(w, h) / 90));
    const gw = Math.ceil(w / cs), gh = Math.ceil(h / cs);
    let grid = new Float32Array(gw * gh);
    for (let y = 0; y < h; y++) {
      const gy = (y / cs) | 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const L = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
        const gi = gy * gw + ((x / cs) | 0);
        if (L > grid[gi]) grid[gi] = L;
      }
    }
    // dilate to cover text-heavy cells, then blur
    const tmp = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let m = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(gh - 1, y + 1); yy++)
        for (let xx = Math.max(0, x - 1); xx <= Math.min(gw - 1, x + 1); xx++) m = Math.max(m, grid[yy * gw + xx]);
      tmp[y * gw + x] = m;
    }
    grid = tmp;
    for (let pass = 0; pass < 2; pass++) {
      const t2 = new Float32Array(gw * gh), r = 2;
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        let s = 0, c = 0;
        for (let yy = Math.max(0, y - r); yy <= Math.min(gh - 1, y + r); yy++)
          for (let xx = Math.max(0, x - r); xx <= Math.min(gw - 1, x + r); xx++) { s += grid[yy * gw + xx]; c++; }
        t2[y * gw + x] = s / c;
      }
      grid = t2;
    }
    for (let y = 0; y < h; y++) {
      let gy = (y + 0.5) / cs - 0.5; if (gy < 0) gy = 0; if (gy > gh - 1) gy = gh - 1;
      const y0 = gy | 0, y1 = Math.min(gh - 1, y0 + 1), fy = gy - y0;
      for (let x = 0; x < w; x++) {
        let gx = (x + 0.5) / cs - 0.5; if (gx < 0) gx = 0; if (gx > gw - 1) gx = gw - 1;
        const x0 = gx | 0, x1 = Math.min(gw - 1, x0 + 1), fx = gx - x0;
        const a = grid[y0 * gw + x0] + (grid[y0 * gw + x1] - grid[y0 * gw + x0]) * fx;
        const b = grid[y1 * gw + x0] + (grid[y1 * gw + x1] - grid[y1 * gw + x0]) * fx;
        const bg = a + (b - a) * fy;
        const f = 250 / Math.max(bg, 40);
        const i = (y * w + x) * 4;
        d[i] = d[i] * f; d[i+1] = d[i+1] * f; d[i+2] = d[i+2] * f;
      }
    }
  }
  // brightness / contrast LUT
  const C = o.contrast * 2.55, cf = (259 * (C + 255)) / (255 * (259 - C)), B = o.bright * 1.28;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = (v - 128) * cf + 128 + B;
  const gray = o.mode !== 'color';
  for (let i = 0; i < n * 4; i += 4) {
    if (gray) {
      const v = lut[(d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114) | 0];
      d[i] = d[i+1] = d[i+2] = v;
    } else { d[i] = lut[d[i]]; d[i+1] = lut[d[i+1]]; d[i+2] = lut[d[i+2]]; }
  }
  if (o.sharpen && o.mode !== 'bw') {
    const c = new Uint8ClampedArray(d), amt = 0.55, row = w * 4;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) {
        const v = 5 * c[i+k] - c[i-4+k] - c[i+4+k] - c[i-row+k] - c[i+row+k];
        d[i+k] = c[i+k] + amt * (v - c[i+k]);
      }
    }
  }
  if (o.mode === 'bw') {
    const W1 = w + 1, I = new Float64Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let rs = 0;
      for (let x = 0; x < w; x++) { rs += d[(y * w + x) * 4]; I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + rs; }
    }
    const r = Math.max(6, Math.round(Math.max(w, h) / 60)), k = 1 - o.bwk / 100;
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const sum = I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0];
        const mean = sum / ((x1 - x0) * (y1 - y0));
        const i = (y * w + x) * 4, v = d[i];
        const out = (v < mean * k || v < 70) ? 0 : 255;
        d[i] = d[i+1] = d[i+2] = out;
      }
    }
  }
  return img;
}

