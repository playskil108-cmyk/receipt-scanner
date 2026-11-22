/* 영수증 스캐너 — 화면 흐름 (홈 → 영역 → 보정 → 저장) */
const $ = (id) => document.getElementById(id);
const DEFAULTS = { mode: 'gray', shadow: true, sharpen: true, bright: 0, contrast: 30, bwk: 12 };
const PREVIEW_MAX = 1000, EXPORT_MAX = 3000, SOURCE_MAX = 2600;
const S = {
  src: null, srcData: null, W: 0, H: 0, corners: null,
  step: 'home', prevWarp: null, prevDirty: true, comparing: false,
  opts: { ...DEFAULTS }, exportBlob: null, exportKey: '', exportSize: null
};
const store = {
  get(k, d) { try { const v = localStorage.getItem('rs.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('rs.' + k, JSON.stringify(v)); } catch (e) {} }
};
S.opts = { ...DEFAULTS, ...store.get('opts', {}) };

const app = $('app'), srcCv = $('srcCv'), outCv = $('outCv'), svg = $('overlay'), loupe = $('loupe'), stage = $('stage');

// ---------- 공통 UI ----------
let toastTimer = 0;
function toast(msg, err) {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('err', !!err); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, err ? 4000 : 2600);
}
function busy(on, text) { $('busy').hidden = !on; if (text) $('busyText').textContent = text; }
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
function hint(text) { $('stageHint').textContent = text || ''; }

// 사진 무대 높이에 맞춰 캔버스 크기 제한
new ResizeObserver(() => {
  const cs = getComputedStyle(stage);
  const h = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  app.style.setProperty('--stage-h', Math.max(120, h) + 'px');
  drawOverlay();
}).observe(stage);

// ---------- 화면 이동 (휴대폰 뒤로가기 버튼과 연동) ----------
const ORDER = ['home', 'crop', 'adjust', 'save'];
function show(step) {
  S.step = step;
  app.dataset.screen = step === 'home' ? 'home' : 'work';
  app.dataset.step = step;
  document.querySelectorAll('.steps li').forEach((li) => {
    const i = ORDER.indexOf(li.dataset.step), cur = ORDER.indexOf(step);
    li.classList.toggle('on', i === cur); li.classList.toggle('done', i < cur);
  });
  if (step === 'crop') { hint('모서리 점을 끌어 영수증 귀퉁이에 맞추세요'); requestAnimationFrame(drawOverlay); }
  if (step === 'adjust') { hint('사진을 누르고 있으면 보정 전 원본'); schedule(); }
  if (step === 'save') { hint(''); schedule(); prepareExport(); }
  if (step === 'home') hint('');
}
function go(step) {
  if (step === S.step) return;
  history.pushState({ step }, '');
  show(step);
}
window.addEventListener('popstate', (e) => {
  const step = (e.state && e.state.step) || 'home';
  if (step !== 'home' && !S.src) { show('home'); return; }
  show(step);
});
history.replaceState({ step: 'home' }, '');
$('btnBack').onclick = () => history.back();

// ---------- 사진 불러오기 ----------
function fromImage(img) {
  const w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, SOURCE_MAX / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}
function setSource(canvas, corners) {
  S.src = canvas; S.W = canvas.width; S.H = canvas.height;
  S.srcData = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, S.W, S.H);
  srcCv.width = S.W; srcCv.height = S.H; srcCv.getContext('2d').drawImage(canvas, 0, 0);
  S.corners = corners || detect() || fullCorners();
  S.prevDirty = true; S.exportKey = '';
  requestAnimationFrame(drawOverlay);
}
async function loadFile(f) {
  if (!f) return;
  if (f.type && !/^image\//.test(f.type)) { toast('이미지 파일을 골라 주세요.', true); return; }
  busy(true, '사진을 여는 중…');
  const url = URL.createObjectURL(f), img = new Image();
  try {
    img.src = url; await img.decode();
    await nextFrame();
    setSource(fromImage(img));
    $('fStore').value = ''; $('fAmount').value = ''; $('fDate').value = today(); updateName();
    go('crop');
  } catch (e) {
    toast('이 사진 형식은 열 수 없습니다. JPG나 PNG로 다시 골라 주세요.', true);
  } finally { URL.revokeObjectURL(url); busy(false); }
}
$('inCamera').onchange = (e) => { loadFile(e.target.files[0]); e.target.value = ''; };
$('inFile').onchange = (e) => { loadFile(e.target.files[0]); e.target.value = ''; };

// ---------- 영역 맞추기 ----------
let dragIdx = -1;
function drawOverlay() {
  if (!S.src || S.step !== 'crop') return;
  const r = srcCv.getBoundingClientRect(); if (!r.width) return;
  const sc = r.width / S.W, w = r.width, h = r.height;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const p = S.corners.map(([x, y]) => [x * sc, y * sc]);
  const quad = p.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join(' ') + 'Z';
  svg.innerHTML =
    `<path d="M0 0H${w}V${h}H0Z ${quad}" fill="rgba(0,0,0,0.5)" fill-rule="evenodd"/>` +
    `<path d="${quad}" fill="none" stroke="var(--handle)" stroke-width="2"/>` +
    p.map((q, i) => `<circle class="h${i === dragIdx ? ' on' : ''}" cx="${q[0]}" cy="${q[1]}" r="${i === dragIdx ? 20 : 15}"/>`).join('');
}
function toLocal(e) {
  const r = srcCv.getBoundingClientRect(), sc = r.width / S.W;
  return { x: (e.clientX - r.left) / sc, y: (e.clientY - r.top) / sc, sc };
}
function drawLoupe() {
  if (dragIdx < 0) { loupe.className = ''; return; }
  const [cx, cy] = S.corners[dragIdx];
  const r = srcCv.getBoundingClientRect(), sc = r.width / S.W;
  const span = 50 / sc;                                  // 원본에서 보여줄 범위 (화면 50px 상당)
  const L = loupe.getContext('2d'), n = loupe.width;
  L.fillStyle = '#000'; L.fillRect(0, 0, n, n);
  L.imageSmoothingEnabled = true;
  L.drawImage(S.src, cx - span / 2, cy - span / 2, span, span, 0, 0, n, n);
  L.strokeStyle = '#35D3C0'; L.lineWidth = 2;
  L.beginPath(); L.moveTo(n / 2, n / 2 - 22); L.lineTo(n / 2, n / 2 + 22); L.moveTo(n / 2 - 22, n / 2); L.lineTo(n / 2 + 22, n / 2); L.stroke();
  // 손가락 반대쪽에 확대경 표시
  loupe.className = cx < S.W / 2 ? 'right' : 'left';
}
let dragOff = [0, 0];
svg.addEventListener('pointerdown', (e) => {
  if (!S.src) return;
  const { x, y, sc } = toLocal(e);
  let best = -1, bd = Infinity;
  S.corners.forEach((c, i) => { const d = Math.hypot(c[0] - x, c[1] - y) * sc; if (d < bd) { bd = d; best = i; } });
  if (bd > 64) return;
  dragIdx = best; dragOff = [S.corners[best][0] - x, S.corners[best][1] - y];
  svg.setPointerCapture(e.pointerId); e.preventDefault();
  hint(''); drawOverlay(); drawLoupe();
});
svg.addEventListener('pointermove', (e) => {
  if (dragIdx < 0) return;
  const { x, y } = toLocal(e);
  S.corners[dragIdx] = [Math.min(S.W, Math.max(0, x + dragOff[0])), Math.min(S.H, Math.max(0, y + dragOff[1]))];
  S.prevDirty = true; S.exportKey = '';
  drawOverlay(); drawLoupe();
});
const endDrag = () => { if (dragIdx >= 0) { dragIdx = -1; drawOverlay(); drawLoupe(); } };
svg.addEventListener('pointerup', endDrag);
svg.addEventListener('pointercancel', endDrag);

$('btnDetect').onclick = () => {
  const c = detect();
  if (c) { S.corners = c; toast('영수증 영역을 다시 찾았습니다.'); }
  else toast('테두리를 찾지 못했습니다. 모서리 점을 직접 옮겨 주세요.', true);
  S.prevDirty = true; S.exportKey = ''; drawOverlay();
};
$('btnFull').onclick = () => { S.corners = fullCorners(); S.prevDirty = true; S.exportKey = ''; drawOverlay(); };
$('btnRotate').onclick = () => {
  if (!S.src) return;
  const c = document.createElement('canvas'); c.width = S.H; c.height = S.W;
  const ctx = c.getContext('2d');
  ctx.translate(S.H, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(S.src, 0, 0);
  const oldH = S.H, k = S.corners.map(([x, y]) => [oldH - y, x]);
  setSource(c, [k[3], k[0], k[1], k[2]]);
};
$('btnToAdjust').onclick = () => go('adjust');

// ---------- 보정 ----------
let raf = 0;
function schedule() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; if (S.step === 'adjust' || S.step === 'save') renderResult(); }); }
function renderResult() {
  if (!S.src) return;
  if (S.prevDirty || !S.prevWarp) {
    const { ow, oh } = outSize(), s = Math.min(1, PREVIEW_MAX / Math.max(ow, oh));
    S.prevWarp = warp(Math.max(1, Math.round(ow * s)), Math.max(1, Math.round(oh * s)));
    S.prevDirty = false;
  }
  const p = S.prevWarp, img = new ImageData(new Uint8ClampedArray(p.data), p.width, p.height);
  if (!S.comparing) enhance(img);
  outCv.width = p.width; outCv.height = p.height;
  outCv.getContext('2d').putImageData(img, 0, 0);
}
outCv.addEventListener('pointerdown', (e) => { if (S.step !== 'adjust') return; e.preventDefault(); S.comparing = true; renderResult(); hint('원본'); });
const cmpOff = () => { if (S.comparing) { S.comparing = false; renderResult(); hint('사진을 누르고 있으면 보정 전 원본'); } };
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => outCv.addEventListener(ev, cmpOff));
outCv.addEventListener('contextmenu', (e) => e.preventDefault());

function syncUI() {
  const o = S.opts;
  $({ color: 'mColor', gray: 'mGray', bw: 'mBw' }[o.mode]).checked = true;
  $('optShadow').checked = o.shadow; $('optSharpen').checked = o.sharpen;
  $('slBright').value = o.bright; $('slContrast').value = o.contrast; $('slBw').value = o.bwk;
  $('oBright').textContent = o.bright; $('oContrast').textContent = o.contrast; $('oBw').textContent = o.bwk;
  $('rowBw').hidden = o.mode !== 'bw';
  $('optSharpen').closest('label').hidden = o.mode === 'bw';
}
const touchOpts = () => { syncUI(); store.set('opts', S.opts); S.exportKey = ''; schedule(); };
document.querySelectorAll('input[name="mode"]').forEach((r) => r.onchange = () => { S.opts.mode = r.value; touchOpts(); });
$('optShadow').onchange = (e) => { S.opts.shadow = e.target.checked; touchOpts(); };
$('optSharpen').onchange = (e) => { S.opts.sharpen = e.target.checked; touchOpts(); };
$('slBright').oninput = (e) => { S.opts.bright = +e.target.value; touchOpts(); };
$('slContrast').oninput = (e) => { S.opts.contrast = +e.target.value; touchOpts(); };
$('slBw').oninput = (e) => { S.opts.bwk = +e.target.value; touchOpts(); };
$('btnReset').onclick = () => { S.opts = { ...DEFAULTS }; touchOpts(); };
$('btnToSave').onclick = () => go('save');

// ---------- 저장 ----------
const clean = (t) => t.replace(/[\\/:*?"<>|\n\r\t]/g, '').replace(/\s+/g, ' ').trim();
function today() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function fileName() {
  const date = $('fDate').value || today();
  const storeName = clean($('fStore').value) || '영수증';
  const digits = $('fAmount').value.replace(/[^\d]/g, '');
  const amount = digits ? '_' + Number(digits).toLocaleString('ko-KR') + '원' : '';
  return `${date}_${storeName}${amount}.${$('fFmt').value}`;
}
function updateName() { $('fname').textContent = fileName(); }
['fDate', 'fStore', 'fAmount'].forEach((id) => $(id).addEventListener('input', updateName));
$('fFmt').addEventListener('change', () => { store.set('fmt', $('fFmt').value); updateName(); prepareExport(); });
$('fFmt').value = store.get('fmt', 'jpg');

// 저장 화면에 들어오면 고해상도 이미지를 미리 만들어 둔다.
// (iOS는 버튼을 누른 직후에만 공유 창을 열 수 있어서, 누르는 순간엔 파일이 준비돼 있어야 함)
function currentKey() { return JSON.stringify([S.opts, S.corners, S.W, S.H, $('fFmt').value]); }
let exportJob = null;
async function prepareExport() {
  if (!S.src) return null;
  const key = currentKey();
  if (S.exportKey === key && S.exportBlob) return S.exportBlob;
  if (exportJob && exportJob.key === key) return exportJob.p;
  const p = (async () => {
    busy(true, '고해상도 이미지를 만드는 중…');
    await nextFrame();
    try {
      const { ow, oh } = outSize(), s = Math.min(1, EXPORT_MAX / Math.max(ow, oh));
      const img = enhance(warp(Math.round(ow * s), Math.round(oh * s)));
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      c.getContext('2d').putImageData(img, 0, 0);
      const png = $('fFmt').value === 'png';
      const blob = await new Promise((r) => c.toBlob(r, png ? 'image/png' : 'image/jpeg', 0.92));
      if (!blob) throw new Error('toBlob');
      if (currentKey() === key) { S.exportBlob = blob; S.exportKey = key; S.exportSize = [img.width, img.height]; }
      return blob;
    } finally { busy(false); }
  })();
  exportJob = { key, p };
  try { return await p; } catch (e) { toast('이미지를 만들지 못했습니다. 다시 시도해 주세요.', true); return null; }
}
function makeFile() {
  const name = fileName();
  return new File([S.exportBlob], name, { type: $('fFmt').value === 'png' ? 'image/png' : 'image/jpeg' });
}
function download(file) {
  const url = URL.createObjectURL(file), a = document.createElement('a');
  a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
$('btnShare').onclick = async () => {
  if (!S.exportBlob || S.exportKey !== currentKey()) { await prepareExport(); if (!S.exportBlob) return; toast('준비됐습니다. 한 번 더 눌러 주세요.'); return; }
  const file = makeFile();
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); toast('저장했습니다: ' + file.name); }
    catch (e) {
      if (e.name === 'AbortError') return;
      download(file); toast('공유 창을 열 수 없어 파일로 내려받았습니다.');
    }
  } else { download(file); toast('내려받았습니다: ' + file.name); }
};
$('btnDownload').onclick = async () => {
  const blob = await prepareExport(); if (!blob) return;
  download(makeFile()); toast('내려받았습니다: ' + fileName());
};
$('btnNew').onclick = () => {
  S.src = null; S.exportBlob = null; S.exportKey = '';
  history.go(-(ORDER.indexOf(S.step)));   // 홈까지 기록을 되돌림
};
$('fAmount').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('fStore').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('fAmount').focus(); });

// ---------- 시작 ----------
$('fDate').value = today();
syncUI(); updateName(); show('home');
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
