/* Tag Card Scanner v2: live camera -> barcode lock (ZXing) -> OCR frames (Tesseract) -> check -> Sheet */
(function () {
'use strict';

var CFG = window.TAGSCAN_CONFIG || {};
var TESS_DIR = new URL('./', document.baseURI).href;   // engine files sit next to index.html (no sub-folders)
var OCR_MAX_SIDE = CFG.ocrMaxSide || 2400;       // long side of the frame sent to OCR
var VIDEO_W = CFG.videoWidth || 3840, VIDEO_H = CFG.videoHeight || 2160;   // asked from the camera, phone gives what it can
var MAX_FRAMES = CFG.maxFrames || 3;              // OCR attempts per tag when a main field is missing

var GROUPS = [
  { title: 'ข้อมูลหลัก', hint: 'ตรวจรูปแบบอัตโนมัติ', keys: [['prodNo', 'PROD.NO.'], ['prodDate', 'PROD.DATE'], ['sender', 'SENDER']] },
  { title: 'จากบาร์โค้ด', hint: 'ตรวจไขว้กับตัวอักษรบนแท็ก', keys: [['mat', 'MAT.NO.'], ['batch', 'BATCH NO.'], ['seq', 'SEQ (ใบที่)'], ['seqTotal', 'จากทั้งหมด (ใบ)'], ['qty', 'QTY']] }
];
var ALL_KEYS = ['prodNo', 'prodDate', 'sender', 'mat', 'batch', 'seq', 'seqTotal', 'qty'];
var CHIP_TXT = { ok: 'ผ่านตรวจ', warn: 'ตรวจสอบ', info: 'จาก OCR', edited: 'แก้ไขแล้ว' };

function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function fmt(k, v) {
  if (v === '' || v == null || (typeof v === 'number' && isNaN(v))) return '';
  if (k === 'qty') return Number(v).toFixed(2);
  return String(v);
}

var state = { engine: 'idle', worker: null, workerP: null, err: '' };
var progressCb = null;
var current = null;      // result on screen
var dupArmed = false;
var log = [];

/* ================= OCR engine ================= */
function setEngine(s) {
  state.engine = s;
  var el = $('engine');
  el.setAttribute('data-s', s);
  $('engineTxt').textContent = {
    loading: 'กำลังโหลดตัวอ่าน OCR…', ready: 'ตัวอ่าน OCR พร้อม', slow: 'ตัวอ่านโหลดนานกว่าปกติ', failed: 'ตัวอ่าน OCR ไม่พร้อม'
  }[s] || 'เตรียมตัวอ่าน OCR';
  el.title = s === 'failed' ? 'โหลดไฟล์ตัวอ่าน OCR ไม่สำเร็จ ' + state.err + ' (ยังสแกนบาร์โค้ดได้ แต่ต้องพิมพ์ PROD.NO / PROD.DATE / SENDER เอง)' : '';
}
function primeLang() {
  return fetch(TESS_DIR + 'eng.lang.wasm').then(function (r) {
    if (!r.ok) throw new Error('no lang file');
    return r.arrayBuffer();
  }).then(function (buf) {
    return new Promise(function (res, rej) {
      var rq = indexedDB.open('keyval-store');
      rq.onupgradeneeded = function () { rq.result.createObjectStore('keyval'); };
      rq.onerror = function () { rej(rq.error); };
      rq.onsuccess = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains('keyval')) { db.close(); rej(new Error('no store')); return; }
        var tx = db.transaction('keyval', 'readwrite');
        tx.objectStore('keyval').put(new Uint8Array(buf), './eng.traineddata');
        tx.oncomplete = function () { db.close(); res(); };
        tx.onerror = function () { db.close(); rej(tx.error); };
      };
    });
  }).catch(function () { /* fall back to eng.traineddata.gz */ });
}
function initEngine() {
  if (typeof Tesseract === 'undefined') { state.err = '(โหลด tesseract.min.js ไม่ได้)'; setEngine('failed'); showMsg(problemText()); diag(); return; }
  setEngine('loading'); diag();
  var slow = setTimeout(function () { if (state.engine === 'loading') setEngine('slow'); }, 20000);
  state.workerP = primeLang().then(function () {
    return Tesseract.createWorker('eng', 1, {
      workerPath: TESS_DIR + 'worker.min.js', corePath: TESS_DIR, langPath: TESS_DIR, workerBlobURL: false,
      logger: function (m) { if (progressCb) progressCb(m); }
    });
  });
  state.workerP.then(function (w) { state.worker = w; clearTimeout(slow); setEngine('ready'); diag(); })
    .catch(function (e) { clearTimeout(slow); state.err = '(' + String(e && (e.message || e)).slice(0, 100) + ')'; setEngine('failed'); showMsg(problemText()); diag(); });
}
function ocr(canvas) {
  if (state.engine === 'failed' || !state.workerP) return Promise.resolve('');
  var wait = state.engine === 'ready' ? Promise.resolve() : (setBusy('รอตัวอ่าน OCR โหลดเสร็จ…', 0),
    Promise.race([state.workerP, sleep(30000).then(function () { throw new Error('engine-timeout'); })]));
  return wait.then(function () {
    progressCb = function (m) { if (m.status === 'recognizing text') setBusy('กำลังอ่านตัวอักษร…', m.progress); };
    return state.worker.recognize(canvas);
  }).then(function (r) { return r.data.text; }).catch(function () { return ''; });
}

/* ================= barcode (ZXing) ================= */
var zx = null, smallCv = null;
function initZX() {
  try {
    var Z = window.ZXing, hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.ITF]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    zx = new Z.MultiFormatReader(); zx.setHints(hints);
  } catch (e) { zx = null; }
  if (!zx) showMsg(problemText());
}
function decodeCanvas(c) {
  if (!zx) return null;
  try {
    var Z = window.ZXing;
    var r = zx.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(c))));
    var d = String(r.getText()).replace(/\D/g, '');
    return d.length >= 32 && d.length <= 35 ? d : null;
  } catch (e) { return null; }
}
function scaled(src, sw, sh, maxSide) {
  var s = Math.min(1, maxSide / Math.max(sw, sh));
  var c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * s)); c.height = Math.max(1, Math.round(sh * s));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}
function decodeVideoFrame(v) {
  if (!smallCv) smallCv = document.createElement('canvas');
  var s = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
  smallCv.width = Math.round(v.videoWidth * s); smallCv.height = Math.round(v.videoHeight * s);
  smallCv.getContext('2d').drawImage(v, 0, 0, smallCv.width, smallCv.height);
  return decodeCanvas(smallCv);
}
function decodeAny(canvas) {
  return decodeCanvas(scaled(canvas, canvas.width, canvas.height, 1280)) || decodeCanvas(canvas);
}
function jpeg(canvas, side, q) {
  try { return scaled(canvas, canvas.width, canvas.height, side).toDataURL('image/jpeg', q); } catch (e) { return ''; }
}

/* ================= problems + diagnostics ================= */
function problemText() {
  var p = [];
  if (!zx) p.push('ตัวถอดบาร์โค้ดไม่พร้อม (ไม่พบไฟล์ zxing.js ตรวจว่าอัปโหลดไฟล์นี้ขึ้น GitHub แล้ว)');
  if (state.engine === 'failed') p.push('ตัวอ่าน OCR โหลดไม่สำเร็จ ' + state.err + ' (ตรวจว่าอัปโหลดไฟล์ tesseract.min.js, worker.min.js, tesseract-core-*.wasm.js, eng.lang.wasm ขึ้น GitHub ครบ)');
  return p.join(' · ');
}
function diag() {
  var v = $('video');
  $('diagTxt').textContent = 'ZXing: ' + (zx ? 'พร้อม' : 'ไม่พร้อม') + ' · OCR: ' + state.engine + (state.err ? ' ' + state.err : '') +
    ' · กล้อง: ' + (cam.running && v.videoWidth ? v.videoWidth + 'x' + v.videoHeight : 'ปิด') + ' · เฟรมอ่าน OCR สูงสุด ' + OCR_MAX_SIDE + ' px';
}

/* ================= UI helpers ================= */
function setBusy(text, pct) { $('busy').hidden = false; $('busyTxt').textContent = text; $('busyBar').style.width = Math.round((pct || 0) * 100) + '%'; }
function clearBusy() { $('busy').hidden = true; }
function showMsg(t) { var m = $('msg'); m.textContent = t; m.hidden = !t; }
var toastT = null;
function toast(t) { var el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { el.hidden = true; }, 2200); }
function setStat(t, s) { $('stat').textContent = t; $('stat').setAttribute('data-s', s || 'idle'); $('guide').setAttribute('data-s', s || 'idle'); $('stage').setAttribute('data-s', s || 'idle'); }

/* ================= camera + scan loop ================= */
var cam = { stream: null, track: null, running: false, timer: null, torch: false };
var phase = 'idle';      // idle | scan | read | result
var lock = { val: null, n: 0 }, absent = 0, lastDone = null, seenAbsent = true;

function camFail(msg) {
  stopCamera(true);
  showMsg(msg);
  $('ph').hidden = false;
  setStat('เปิดกล้องไม่ได้ ใช้ “ถ่ายรูป / เลือกรูป” แทนได้', 'idle');
}
function startCamera() {
  if (cam.running) return Promise.resolve();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { camFail('เบราว์เซอร์นี้เปิดกล้องสดไม่ได้ (ต้องเปิดผ่านลิงก์ https) ใช้ปุ่ม “ถ่ายรูป / เลือกรูป” แทนได้'); return Promise.resolve(); }
  showMsg(''); $('ph').hidden = true;
  return navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: VIDEO_W }, height: { ideal: VIDEO_H } } })
    .then(function (stream) {
      cam.stream = stream; cam.track = stream.getVideoTracks()[0]; cam.running = true;
      var v = $('video'); v.srcObject = stream;
      $('stage').classList.remove('photo'); $('stageImg').hidden = true;
      return v.play().catch(function () {}).then(function () {
        try {
          var caps = cam.track.getCapabilities ? cam.track.getCapabilities() : {};
          if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) cam.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
          $('torchBtn').hidden = !caps.torch;
        } catch (e) {}
        $('camBtn').textContent = 'ปิดกล้อง'; diag();
        if (phase !== 'result') { phase = 'scan'; setStat('เล็งบาร์โค้ดให้อยู่ในกรอบ', 'idle'); }
        scheduleTick(200);
      });
    })
    .catch(function (e) {
      var n = e && e.name;
      camFail(n === 'NotAllowedError' ? 'ยังไม่ได้อนุญาตให้ใช้กล้อง ไปที่ตั้งค่าเบราว์เซอร์ของเว็บนี้แล้วเลือก “อนุญาตกล้อง” หรือใช้ปุ่ม “ถ่ายรูป / เลือกรูป”'
        : 'เปิดกล้องไม่ได้ (' + (n || 'error') + ') ใช้ปุ่ม “ถ่ายรูป / เลือกรูป” แทนได้');
    });
}
function stopCamera(quiet) {
  clearTimeout(cam.timer); cam.running = false;
  if (cam.stream) cam.stream.getTracks().forEach(function (t) { t.stop(); });
  cam.stream = null; cam.track = null; cam.torch = false;
  $('video').srcObject = null; $('torchBtn').hidden = true; $('camBtn').textContent = 'เปิดกล้อง';
  if (!quiet) { phase = 'idle'; setStat('กล้องปิดอยู่', 'idle'); }
}
function scheduleTick(ms) { clearTimeout(cam.timer); cam.timer = setTimeout(tick, ms); }
function tick() {
  if (!cam.running) return;
  var v = $('video');
  if (phase !== 'scan' || !v.videoWidth || document.hidden) { scheduleTick(300); return; }
  var bc = decodeVideoFrame(v);
  if (bc) {
    absent = 0;
    if (bc === lastDone && !seenAbsent) { setStat('ใบนี้เพิ่งบันทึกไป เอาแท็กออกแล้วเล็งใบถัดไป', 'idle'); }
    else {
      if (bc === lock.val) lock.n++; else { lock.val = bc; lock.n = 1; }
      setStat('เจอบาร์โค้ดแล้ว ถือนิ่งไว้…', 'found');
      if (lock.n >= 2) { startRead(bc); return; }
    }
  } else {
    absent++; lock.val = null; lock.n = 0;
    if (absent >= 5) seenAbsent = true;
    setStat('เล็งบาร์โค้ดให้อยู่ในกรอบ', 'idle');
  }
  scheduleTick(180);
}
$('video').addEventListener('click', function () { if (cam.track && cam.track.getCapabilities && (cam.track.getCapabilities().focusMode || []).indexOf('single-shot') >= 0) cam.track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] }).catch(function () {}); });
document.addEventListener('visibilitychange', function () {
  if (!document.hidden && cam.running) { $('video').play().catch(function () {}); scheduleTick(200); }
});

/* ---- read: OCR 1..N frames of the locked tag ---- */
function startRead(bc) {
  phase = 'read';
  setStat('กำลังอ่านตัวอักษรบนแท็ก ถือนิ่งไว้…', 'read');
  var v = $('video'), t0 = performance.now(), results = [], photos = [];
  function attempt() {
    var canvas = scaled(v, v.videoWidth, v.videoHeight, OCR_MAX_SIDE);
    setBusy(results.length ? 'อ่านซ้ำอีกครั้ง…' : 'กำลังอ่านตัวอักษร…', 0);
    return ocr(canvas).then(function (text) {
      var res = parseTag(text, { barcodeValue: bc });
      results.push(res); photos.push(jpeg(canvas, 1200, 0.6));
      if (missingMain(res).length && results.length < MAX_FRAMES && state.engine === 'ready') return sleep(250).then(attempt);
    });
  }
  return attempt().then(function () {
    var best = pickBest(results);
    var idx = results.indexOf(best);
    clearBusy();
    render(best, { mode: 'live', ms: performance.now() - t0, rawText: best.rawText, photo: photos[idx] || '', frames: results.length, bcValue: bc });
  });
}

/* ---- photo / file path (fallback, also used by the sample button) ---- */
function loadImage(src) {
  return new Promise(function (res, rej) { var im = new Image(); im.onload = function () { res(im); }; im.onerror = rej; im.src = src; });
}
function runPhoto(src, mode) {
  if (phase === 'read') return Promise.resolve();
  var prev = phase; phase = 'read'; showMsg('');
  setBusy('เตรียมภาพ…', 0);
  var t0 = performance.now();
  return loadImage(src).then(function (im) {
    var canvas = scaled(im, im.naturalWidth, im.naturalHeight, OCR_MAX_SIDE);
    $('stage').classList.add('photo'); $('stageImg').src = jpeg(canvas, 1000, 0.8); $('stageImg').hidden = false; $('ph').hidden = true;
    var bc = decodeAny(canvas);
    return ocr(canvas).then(function (text) {
      if (!bc && !String(text).trim()) {
        clearBusy(); phase = 'idle'; backToScan('<b>อ่านไม่ได้</b>');
        showMsg(problemText() || 'ไม่พบบาร์โค้ดและอ่านตัวอักษรไม่ได้ ลองถ่ายให้ชัดและเห็นทั้งใบ');
        return;
      }
      var res = parseTag(text, { barcodeValue: bc });
      clearBusy();
      render(res, { mode: mode || 'photo', ms: performance.now() - t0, rawText: text, photo: jpeg(canvas, 1200, 0.6), frames: 1, bcValue: bc || '' });
    });
  }).catch(function () {
    clearBusy(); phase = prev === 'read' ? 'idle' : prev;
    showMsg('เปิดรูปนี้ไม่ได้ ลองถ่ายหรือเลือกรูปอีกครั้ง');
  });
}
$('pick').addEventListener('change', function (e) {
  var f = e.target.files && e.target.files[0]; e.target.value = '';
  if (!f) return;
  var url = URL.createObjectURL(f);
  runPhoto(url, 'photo').then(function () { setTimeout(function () { URL.revokeObjectURL(url); }, 5000); });
});

/* ================= render result ================= */
function renderRibbon(res) {
  var bc = res.barcode;
  if (!bc) { $('ribbonSrc').textContent = 'ไม่พบบาร์โค้ดในภาพ ให้ตรวจทุกช่องด้วยตา'; $('ribbon').innerHTML = ''; $('decoded').textContent = ''; return; }
  if (res.barcodeSource === 'camera') $('ribbonSrc').textContent = 'ถอดจากบาร์โค้ดโดยตรง (Code 128 ผ่านการตรวจ checksum ในตัวบาร์โค้ด)';
  else $('ribbonSrc').textContent = bc.checkOk ? 'อ่านจากเลขใต้บาร์โค้ดด้วย OCR · ตัวเลขตรวจสอบผ่าน ✓' : 'อ่านจากเลขใต้บาร์โค้ดด้วย OCR · ตัวเลขตรวจสอบไม่ผ่าน อาจอ่านผิดบางหลัก';
  var r = bc.raw;
  var segs = [['MAT.NO', r.slice(0, 8), 'a'], ['BATCH', r.slice(8, 18), 'b'], ['SEQ', r.slice(18, 24), 'a'], ['QTY', r.slice(24, 32), 'b'], ['CHK', bc.tail || bc.check, 'x']];
  $('ribbon').innerHTML = '<div class="ribbon" role="img" aria-label="เลข ' + r + '">' + segs.map(function (s) {
    return '<div class="seg ' + s[2] + '" style="flex:' + s[1].length + '"><small>' + s[0] + '</small><b>' + s[1] + '</b></div>';
  }).join('') + '</div>';
  $('decoded').textContent = 'SEQ ' + bc.seq + '/' + bc.seqTotal + '  ·  QTY ' + bc.qty.toFixed(2) + '  ·  ตัวเลขตรวจสอบ ' + (bc.tail || bc.check);
}
function fieldHtml(k, res) {
  var key = k[0], st = res.status[key];
  return '<div class="field" data-k="' + key + '" data-s="' + st + '">' +
    '<label class="lab" for="f-' + key + '"><span>' + esc(k[1]) + '</span><span class="chip" data-s="' + st + '">' + CHIP_TXT[st] + '</span></label>' +
    '<input id="f-' + key + '" value="' + esc(fmt(key, res.fields[key])) + '" autocomplete="off" inputmode="' + (key === 'prodDate' ? 'text' : 'numeric') + '">' +
    '<span class="note">' + esc(res.notes[key]) + '</span></div>';
}
function renderFields(res) {
  var html = '';
  GROUPS.forEach(function (g) {
    html += '<div><h2>' + esc(g.title) + '</h2><p class="h2sub">' + esc(g.hint) + '</p></div><div class="grid2">';
    g.keys.forEach(function (k) { html += fieldHtml(k, res); });
    html += '</div>';
  });
  $('fields').innerHTML = html;
  var inputs = document.querySelectorAll('#fields input');
  for (var i = 0; i < inputs.length; i++) inputs[i].addEventListener('input', onEdit);
}
function renderCompare(res) {
  var camera = res.barcodeSource === 'camera';
  var h = '<div class="cr hd"><span></span><span>' + (camera ? 'Barcode (สแกน)' : 'เลขใต้บาร์โค้ด') + '</span><span>ตัวอักษร (OCR)</span><span></span></div>';
  res.compare.forEach(function (c) {
    var sym = { match: '✓', diff: '≠', one: '·', none: '·' }[c.state];
    var lab = { match: 'ตรงกัน', diff: 'ไม่ตรงกัน', one: 'มีแหล่งเดียว', none: 'ไม่พบ' }[c.state];
    h += '<div class="cr" data-s="' + c.state + '"><span class="l">' + esc(c.label) + '</span><span class="v">' + esc(c.bc) + '</span><span class="v">' + esc(c.ocr) + '</span><span class="m" title="' + lab + '" aria-label="' + lab + '">' + sym + '</span></div>';
  });
  $('cmp').innerHTML = h;
}
function onEdit(e) {
  var f = e.target.closest('.field');
  f.setAttribute('data-s', 'edited');
  var chip = f.querySelector('.chip'); chip.setAttribute('data-s', 'edited'); chip.textContent = CHIP_TXT.edited;
  f.querySelector('.note').textContent = '';
  updateSummary(); resetDup(); renderMaster();
}
function updateSummary() {
  var f = $('fields').querySelectorAll('.field'), ok = 0, warn = 0;
  for (var i = 0; i < f.length; i++) { var s = f[i].getAttribute('data-s'); if (s === 'ok') ok++; else if (s === 'warn') warn++; }
  $('sum').innerHTML = 'ผ่านตรวจ <b>' + ok + '</b> ช่อง · ต้องดู <b>' + warn + '</b> ช่อง';
}
function resetDup() { dupArmed = false; $('dup').hidden = true; $('confirmBtn').textContent = 'ยืนยันและบันทึก'; }

/* ================= Master list (cached from the Sheet) ================= */
var MASTER = { mat: {}, sender: {}, at: 0 };
function masterTxt() {
  var nm = Object.keys(MASTER.mat).length, ns = Object.keys(MASTER.sender).length;
  $('masterTxt').textContent = MASTER.at
    ? 'Master ในเครื่อง: ' + nm + ' MAT.NO · ' + ns + ' SENDER · โหลดเมื่อ ' + new Date(MASTER.at).toLocaleString('th-TH')
    : 'ยังไม่ได้โหลด Master (ต้องตั้งลิงก์ Apps Script และมีสัญญาณ)';
}
function loadMasterLocal() {
  try { var j = JSON.parse(lsGet('tagscan-master') || 'null'); if (j && j.mat) MASTER = j; } catch (e) {}
  masterTxt();
}
function fetchMaster(manual) {
  var ep = endpoint();
  if (!ep || navigator.onLine === false) { if (manual) toast('ยังไม่ได้ตั้งลิงก์ หรือไม่มีสัญญาณ'); return Promise.resolve(); }
  return postJSON(ep, { token: CFG.token || '', action: 'master' }).then(function (j) {
    if (j && j.ok) { MASTER = j; lsSet('tagscan-master', JSON.stringify(j)); if (manual) toast('โหลด Master แล้ว'); }
    else if (manual) toast('โหลด Master ไม่สำเร็จ: ' + ((j && j.error) || ''));
    masterTxt(); renderMaster();
  }).catch(function () { if (manual) toast('โหลด Master ไม่สำเร็จ'); });
}
function renderMaster() {
  var box = $('masterBox');
  if (!current) { box.innerHTML = ''; return; }
  var mat = ($('f-mat') || {}).value || '', snd = ($('f-sender') || {}).value || '';
  var loaded = !!MASTER.at;
  var m = MASTER.mat[mat.trim()], s = MASTER.sender[snd.trim()];
  function row(l, v, miss) { return '<div class="mrow"><span class="l">' + l + '</span><span class="v' + (miss ? ' miss' : '') + '">' + esc(v) + '</span></div>'; }
  var h = '<div><h2>จาก Master list</h2><p class="h2sub">' + (loaded ? 'ค้นด้วย MAT.NO และ SENDER ไม่ต้อง OCR' : 'ยังไม่ได้โหลด Master') + '</p></div>';
  if (!loaded) h += row('', 'ต้องตั้งลิงก์ Apps Script แล้วโหลด Master ก่อน จึงจะแสดงชื่อชิ้นงาน', true);
  else {
    if (m) h += row('Customer', m.customer) + row('Model', m.model) + row('P/Name', m.pname) + row('P/No', m.pno);
    else h += row('MAT.NO.', mat ? 'ไม่พบ ' + mat + ' ใน Master (บันทึกได้ ให้ผู้ดูแลเพิ่มภายหลัง)' : 'ยังไม่มี MAT.NO.', true);
    h += s ? row('SENDER', snd + ' · ' + s.process) : row('SENDER', snd ? 'ไม่พบ ' + snd + ' ใน Master' : 'ยังไม่มี SENDER', true);
  }
  box.innerHTML = h;
}

function render(res, meta) {
  current = { res: res, meta: meta, orig: {} };
  resetDup();
  var label = meta.mode === 'live' ? 'สแกนอัตโนมัติ' : (meta.mode === 'sample' ? 'แท็กตัวอย่าง' : 'จากรูปที่เลือก');
  $('mode').innerHTML = '<b>' + label + '</b> ใช้เวลา ' + (meta.ms / 1000).toFixed(1) + ' วินาที' + (meta.frames > 1 ? ' (อ่าน ' + meta.frames + ' เฟรม)' : '') + ' ตรวจผลก่อนกดยืนยัน';
  renderRibbon(res); renderCompare(res); renderFields(res); updateSummary();
  ALL_KEYS.forEach(function (k) { current.orig[k] = fmt(k, res.fields[k]); });
  $('raw').textContent = meta.rawText || '';
  $('resWrap').hidden = false;
  renderMaster();
  phase = 'result';
  setStat('อ่านเสร็จแล้ว ดูผลและกดยืนยันด้านล่าง ↓', 'done');
  if (window.matchMedia('(max-width: 879px)').matches) $('mode').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function backToScan(msg) {
  $('resWrap').hidden = true;
  $('stage').classList.remove('photo'); $('stageImg').hidden = true;
  current = null;
  if (msg) $('mode').innerHTML = msg;
  window.scrollTo(0, 0);
  if (cam.running) { phase = 'scan'; lock = { val: null, n: 0 }; absent = 0; setStat('เล็งบาร์โค้ดให้อยู่ในกรอบ', 'idle'); scheduleTick(200); }
  else { phase = 'idle'; setStat('กล้องปิดอยู่ กด “เปิดกล้อง”', 'idle'); }
}

/* ================= local store (IndexedDB) ================= */
var idb = null;
function openDB() {
  return new Promise(function (res) {
    try {
      var rq = indexedDB.open('tagscan', 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore('scans', { keyPath: 'id' }); };
      rq.onsuccess = function () { idb = rq.result; res(); };
      rq.onerror = function () { res(); };
    } catch (e) { res(); }
  });
}
function dbDo(mode, fn) {
  return new Promise(function (res) {
    if (!idb) { res(); return; }
    try { var tx = idb.transaction('scans', mode); var out = fn(tx.objectStore('scans')); tx.oncomplete = function () { res(out && out.result); }; tx.onerror = function () { res(); }; } catch (e) { res(); }
  });
}
function dbPut(rec) { return dbDo('readwrite', function (st) { return st.put(rec); }); }
function dbDel(id) { return dbDo('readwrite', function (st) { return st.delete(id); }); }
function dbAll() { return dbDo('readonly', function (st) { return st.getAll(); }); }

/* ================= confirm / log ================= */
function pad(n) { return String(n).padStart(2, '0'); }
function stamp(d) { return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function endpoint() { var v = ($('endpoint').value || '').trim(); return (/^https?:\/\//.test(v) ? v : '') || CFG.endpoint || ''; }
function pendingCount() { return log.filter(function (r) { return r.status !== 'sent'; }).length; }
function getValues() { var v = {}; ALL_KEYS.forEach(function (k) { v[k] = $('f-' + k).value.trim(); }); return v; }

function onConfirm() {
  if (!current) return;
  var user = ($('user').value || '').trim();
  if (!user) { $('setup').open = true; $('user').focus(); toast('ใส่ชื่อผู้สแกนก่อนบันทึก'); return; }
  var v = getValues();
  if (!v.batch) { toast('ยังไม่มี BATCH NO.'); $('f-batch').focus(); return; }
  var key = v.batch + '-' + v.seq, dup = null;
  for (var i = 0; i < log.length; i++) { if (log[i].batch + '-' + log[i].seq === key) { dup = log[i]; break; } }
  if (dup && !dupArmed) {
    dupArmed = true;
    $('dup').textContent = 'แท็กใบนี้ (BATCH ' + v.batch + ' ใบที่ ' + v.seq + '/' + v.seqTotal + ') ถูกบันทึกไว้แล้วเมื่อ ' + dup.ts + ' ถ้าตั้งใจบันทึกซ้ำให้กดอีกครั้ง';
    $('dup').hidden = false; $('confirmBtn').textContent = 'บันทึกซ้ำอยู่ดี';
    return;
  }
  var now = new Date(), orig = current.orig, res = current.res;
  var edited = ALL_KEYS.filter(function (k) { return v[k] !== (orig[k] || ''); });
  var rec = {};
  ALL_KEYS.forEach(function (k) { rec[k] = v[k]; });
  rec.id = newId(); rec.ts = stamp(now); rec.ts_ms = now.getTime(); rec.ts_iso = now.toISOString();
  rec.user = user; rec.app = CFG.version || 'v2';
  rec.device = navigator.userAgent.slice(0, 140);
  rec.ms = Math.round(current.meta.ms || 0); rec.mode = current.meta.mode;
  rec.bc_source = res.barcodeSource || '';
  rec.barcode = res.barcode ? res.barcode.raw : '';
  rec.compare_ok = res.compare.filter(function (c) { return c.state === 'match'; }).length;
  rec.edited = edited.join(',');
  ALL_KEYS.forEach(function (k) { rec['ocr_' + k] = fmt(k, res.ocr[k]); });
  var incomplete = edited.length > 0 || MAIN_KEYS.some(function (k) { return res.status[k] !== 'ok'; }) || rec.compare_ok < 4;
  rec.raw_text = incomplete ? String(current.meta.rawText || '').slice(0, 1500) : '';
  var pm = $('photoMode').value;
  rec.photo = pm === 'always' || (pm === 'edit' && incomplete) ? (current.meta.photo || '') : '';
  rec.status = 'pending'; rec.dup = '';
  log.unshift(rec); dbPut(rec); renderLog(); updateNet();
  lastDone = current.meta.bcValue || rec.barcode || null; seenAbsent = false; absent = 0;
  toast('บันทึกแล้ว · ใบที่ ' + v.seq + '/' + v.seqTotal);
  backToScan('<b>บันทึกแล้ว</b> พร้อมสแกนใบถัดไป');
  syncPending();
}
function chipFor(r) {
  if (r.status === 'sent') return r.dup === 'Y' ? ['warn', 'ส่งแล้ว · ซ้ำ'] : ['ok', 'ส่งแล้ว'];
  if (r.status === 'error') return ['warn', 'ส่งไม่ได้'];
  return ['warn', r.err ? 'รอส่ง ⚠' : 'รอส่ง'];
}
function renderLog() {
  var pend = pendingCount();
  $('logCount').textContent = log.length ? log.length + ' รายการในเครื่องนี้' + (pend ? ' · รอส่ง ' + pend : '') : '';
  if (!log.length) $('logList').innerHTML = '<p class="empty">ยังไม่มีรายการ สแกนแท็ก ตรวจข้อมูล แล้วกด “ยืนยันและบันทึก” เพื่อบันทึกใบแรก</p>';
  else $('logList').innerHTML = log.slice(0, 30).map(function (r) {
    var c = chipFor(r), snd = MASTER.sender[r.sender];
    return '<div class="logrow"><span class="t">' + esc(r.ts.slice(11)) + '</span><span>' + esc(r.batch) + ' · ' + esc(r.seq) + '/' + esc(r.seqTotal) + '</span><span class="chip" data-s="' + c[0] + '">' + c[1] + '</span>' +
      '<span class="s">PROD.NO ' + esc(r.prodNo) + ' · ' + esc(r.prodDate) + ' · SENDER ' + esc(r.sender) + (snd ? ' (' + esc(snd.process) + ')' : '') + ' · QTY ' + esc(r.qty) + ' · ' + esc(r.user) + (r.edited ? ' · แก้ ' + esc(r.edited) : '') + (r.err ? ' · ' + esc(r.err) : '') + '</span></div>';
  }).join('');
  $('copyBtn').disabled = !log.length; $('clearBtn').disabled = !log.length; $('syncBtn').disabled = !pend;
}
function updateNet(txt) {
  var pend = pendingCount(), s, t;
  if (txt) { s = 'warn'; t = txt; }
  else if (!endpoint()) { s = 'warn'; t = 'ยังไม่ตั้งค่า Sheet' + (pend ? ' · ค้าง ' + pend : ''); }
  else if (navigator.onLine === false) { s = 'warn'; t = 'ออฟไลน์ · รอส่ง ' + pend; }
  else if (pend) { s = 'warn'; t = 'รอส่ง ' + pend + ' รายการ'; }
  else { s = 'ok'; t = 'ส่งครบแล้ว'; }
  $('net').setAttribute('data-s', s); $('netTxt').textContent = t;
}

/* ================= sync to Google Sheets (Apps Script) ================= */
var syncing = false;
var APP_VER = 'v2-0.5';
function postJSON(ep, obj) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost)[:\/]/.test(ep) && !/^https:\/\/script\.google(usercontent)?\.com\/macros\/s\/[^\/]+\/exec$/.test(ep)) {
    return Promise.reject(new Error('ลิงก์ Apps Script ไม่ถูกต้อง: "' + String(ep).slice(0, 60) + '" ต้องขึ้นต้น https://script.google.com/macros/s/ และลงท้าย /exec (ดูช่องลิงก์ใน ตั้งค่าและทดสอบ และ endpoint ใน config.js)'));
  }
  var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 45000);
  return fetch(ep, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(obj), signal: ctl.signal, redirect: 'follow' })
    .then(function (r) {
      clearTimeout(t);
      return r.text().then(function (txt) {
        try { return JSON.parse(txt); } catch (e) {
          var head = String(txt).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
          var er = new Error('เซิร์ฟเวอร์ไม่ตอบเป็น JSON (HTTP ' + r.status + ') ' + head +
            ' → ตรวจ Deploy: สิทธิ์เข้าถึง=ทุกคน, Deploy เวอร์ชันใหม่, รัน setup() แล้ว');
          er.http = true; throw er;
        }
      });
    }, function (e) {
      clearTimeout(t);
      var er = new Error(e && e.name === 'AbortError' ? 'หมดเวลา 45 วินาที ไม่มีคำตอบ' : 'ติดต่อเซิร์ฟเวอร์ไม่ได้ (' + ((e && e.message) || 'network') + ') → ตรวจลิงก์ /exec และสัญญาณ');
      er.net = true; throw er;
    });
}
function syncPending() {
  var ep = endpoint();
  if (syncing || !ep || navigator.onLine === false) { updateNet(); return Promise.resolve(); }
  var todo = log.filter(function (r) { return r.status !== 'sent'; }).reverse();
  if (!todo.length) { updateNet(); return Promise.resolve(); }
  syncing = true; updateNet('กำลังส่ง ' + todo.length + ' รายการ…');
  var chain = Promise.resolve();
  todo.forEach(function (rec) {
    chain = chain.then(function () {
      return postJSON(ep, { token: CFG.token || '', rec: rec }).then(function (r) {
        if (r && r.ok) { rec.status = 'sent'; rec.dup = r.dup ? 'Y' : ''; rec.row = r.row; rec.photo = ''; rec.err = ''; }
        else { rec.status = 'error'; rec.err = (r && r.error) || 'ไม่ทราบสาเหตุ'; }
        return dbPut(rec);
      }).catch(function (e) { rec.status = 'pending'; rec.err = (e && e.message) || 'ส่งไม่สำเร็จ'; return dbPut(rec); });
    });
  });
  return chain.then(function () { syncing = false; renderLog(); updateNet(); });
}
function onPing() {
  var ep = endpoint(), note = $('epNote');
  if (!ep) { note.textContent = 'ยังไม่ได้ใส่ลิงก์ (ตั้งใน config.js หรือกรอกช่องนี้)'; return; }
  note.textContent = 'กำลังทดสอบ…';
  postJSON(ep, { token: CFG.token || '', action: 'ping' }).then(function (j) {
    note.textContent = j.ok ? 'เชื่อมต่อได้ ชีต ' + j.sheet + ' มี ' + j.rows + ' แถว' : 'เชื่อมต่อได้แต่ถูกปฏิเสธ: ' + (j.error || '');
    if (j.ok) fetchMaster(false);
  }).catch(function (e) { note.textContent = 'เชื่อมต่อไม่ได้: ' + ((e && e.message) || ''); });
}

var LOG_COLS = ['ts', 'user', 'barcode', 'mat', 'batch', 'seq', 'seqTotal', 'qty', 'prodNo', 'prodDate', 'sender', 'edited', 'status'];
function onCopy() {
  var rows = [LOG_COLS.join('\t')];
  log.slice().reverse().forEach(function (r) { rows.push(LOG_COLS.map(function (c) { return String(r[c] == null ? '' : r[c]).replace(/[\t\n]/g, ' '); }).join('\t')); });
  var text = rows.join('\n'), box = $('tsvBox');
  function fallback() { box.value = text; box.hidden = false; box.focus(); box.select(); toast('เลือกข้อความแล้ว กดคัดลอกเอง'); }
  try { navigator.clipboard.writeText(text).then(function () { toast('คัดลอกแล้ว วางใน Google Sheets ได้เลย'); box.hidden = true; }).catch(fallback); } catch (e) { fallback(); }
}
var clearArmed = false, clearT = null;
function onClear() {
  if (!clearArmed) {
    clearArmed = true; $('clearBtn').textContent = 'กดอีกครั้งเพื่อล้าง';
    clearT = setTimeout(function () { clearArmed = false; $('clearBtn').textContent = 'ล้างที่ส่งแล้ว'; }, 3000);
    return;
  }
  clearTimeout(clearT); clearArmed = false; $('clearBtn').textContent = 'ล้างที่ส่งแล้ว';
  log.filter(function (r) { return r.status === 'sent'; }).forEach(function (r) { dbDel(r.id); });
  log = log.filter(function (r) { return r.status !== 'sent'; });
  renderLog(); updateNet();
  toast(log.length ? 'ล้างเฉพาะที่ส่งแล้ว ยังมี ' + log.length + ' รายการรอส่ง' : 'ล้างรายการแล้ว');
}

/* ================= boot ================= */
$('camBtn').addEventListener('click', function () { if (cam.running) { stopCamera(); } else { startCamera(); } });
$('torchBtn').addEventListener('click', function () {
  if (!cam.track) return;
  cam.torch = !cam.torch;
  cam.track.applyConstraints({ advanced: [{ torch: cam.torch }] }).catch(function () { cam.torch = false; });
  $('torchBtn').textContent = cam.torch ? 'ปิดไฟฉาย' : 'ไฟฉาย';
});
$('sampleBtn').addEventListener('click', function () { runPhoto(new URL('sample.jpg', document.baseURI).href, 'sample'); });
$('confirmBtn').addEventListener('click', onConfirm);
$('redoBtn').addEventListener('click', function () { lastDone = null; seenAbsent = true; backToScan('<b>อ่านใหม่</b> เล็งบาร์โค้ดอีกครั้ง'); });
$('copyBtn').addEventListener('click', onCopy);
$('clearBtn').addEventListener('click', onClear);
$('syncBtn').addEventListener('click', syncPending);
$('pingBtn').addEventListener('click', onPing);
$('masterBtn').addEventListener('click', function () { fetchMaster(true); });
$('user').value = lsGet('tagscan-user') || '';
$('endpoint').value = lsGet('tagscan-endpoint') || '';
$('photoMode').value = lsGet('tagscan-photomode') || 'edit';
$('user').addEventListener('input', function () { lsSet('tagscan-user', $('user').value.trim()); });
$('endpoint').addEventListener('input', function () { lsSet('tagscan-endpoint', $('endpoint').value.trim()); updateNet(); });
$('endpoint').addEventListener('change', function () { syncPending(); fetchMaster(false); });
$('photoMode').addEventListener('change', function () { lsSet('tagscan-photomode', $('photoMode').value); });
$('verTxt').textContent = 'เวอร์ชัน ' + APP_VER + ' · ลิงก์ที่ใช้: ' + (endpoint() || '(ว่าง)');
var vb = document.querySelector('h1 .beta'); if (vb) vb.textContent = APP_VER;
if (!$('user').value) $('setup').open = true;
window.addEventListener('online', function () { syncPending(); fetchMaster(false); });
window.addEventListener('offline', function () { updateNet(); });
setInterval(syncPending, 60000);
setInterval(function () { fetchMaster(false); }, 10 * 60000);

loadMasterLocal();
initZX(); diag();
renderLog(); updateNet();
openDB().then(dbAll).then(function (rows) {
  log = (rows || []).sort(function (a, b) { return b.ts_ms - a.ts_ms; });
  renderLog(); updateNet(); syncPending(); fetchMaster(false);
});
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  try { navigator.serviceWorker.register('sw.js').catch(function () {}); } catch (e) {}
}
setTimeout(initEngine, 300);
startCamera();
})();
