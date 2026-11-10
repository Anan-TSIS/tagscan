/* Tag card parser v2: raw OCR text (+ optional decoded barcode) -> checked record.
   Barcode = Code 128 (set C), 32 digits: MAT(8) BATCH(10) SEQ(3) SEQTOTAL(3) QTY(8, /100).
   The line printed under it has 2 extra digits (3 if the value is 100-102): the Code 128 check value. */
var MAIN_KEYS = ['prodNo', 'prodDate', 'sender'];
var SENDER_PREFIX = '15';

function fixDigits(s) {
  return String(s || '')
    .replace(/[Oo]/g, '0').replace(/[Il|]/g, '1')
    .replace(/S/g, '5').replace(/B/g, '8').replace(/Z/g, '2');
}
function has(v) { return v !== '' && v != null && !(typeof v === 'number' && isNaN(v)); }

function check128C(d32) {
  var sum = 105;
  for (var i = 0; i < 16; i++) sum += (i + 1) * parseInt(d32.slice(i * 2, i * 2 + 2), 10);
  var c = sum % 103;
  return (c < 10 ? '0' : '') + c;
}

function decodeBarcode(code) {
  var c = String(code || '').replace(/\D/g, '');
  if (c.length < 32 || c.length > 35) return null;
  var d = c.slice(0, 32), tail = c.slice(32), chk = check128C(d);
  return {
    raw: d,
    mat: d.slice(0, 8),
    batch: d.slice(8, 18),
    seq: parseInt(d.slice(18, 21), 10),
    seqTotal: parseInt(d.slice(21, 24), 10),
    qty: parseInt(d.slice(24, 32), 10) / 100,
    tail: tail,
    check: chk,
    checkOk: tail ? tail === chk : null
  };
}

function validDate(s, now) {
  var m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s || '');
  if (!m) return false;
  var d = +m[1], mo = +m[2], y = +m[3];
  var dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return false;
  var lim = (now || new Date()).getTime() + 86400000;
  return dt.getTime() <= lim && y >= 2015;
}

var LABEL_ONLY = /^(P\s*\/?\s*NO|PNO|PO|P\s*\/?\s*NAME|MODEL|CUSTOMER|RECEIVER|SENDER|MAT\.?\s*NO|PLANT|QUANTITY)[.:]*$/i;

function parseTag(text, opts) {
  opts = opts || {};
  var prefix = opts.senderPrefix || SENDER_PREFIX;
  var lines = String(text || '').replace(/\r/g, '').split('\n');
  var digitsLine = null, rest = [];
  lines.forEach(function (ln) {
    var s = ln.replace(/[\s.,]/g, '');
    if (!digitsLine && /^[0-9OoIlS]{32,35}$/.test(s) && (s.match(/\d/g) || []).length >= 26) digitsLine = fixDigits(s);
    else rest.push(ln);
  });
  var t = rest.join('\n');

  function g(re, fix) {
    var m = re.exec(t);
    if (!m) return '';
    var v = (m[1] || '').trim();
    if (LABEL_ONLY.test(v)) return '';
    return fix ? fixDigits(v) : v;
  }

  var ocr = {};
  ocr.mat = g(/MAT\.?\s*NO[.:\s]*([0-9OoIlS]{8})(?![0-9])/i, true);
  ocr.batch = g(/BATCH\s*NO[.:\s]*([0-9OoIlS]{10})/i, true) || g(/\b(00\d{8})\b/);
  var sm = /SEQ[:\s]*([0-9OoIlS]{1,3})\s*[\/|]\s*([0-9OoIlS]{1,3})/i.exec(t);
  ocr.seq = sm ? parseInt(fixDigits(sm[1]), 10) : NaN;
  ocr.seqTotal = sm ? parseInt(fixDigits(sm[2]), 10) : NaN;

  // PROD.DATE: by label first, otherwise the first valid dd.mm.yyyy anywhere (the other date on the tag has no dots)
  var dm = /PROD\.?\s*DATE[:\s]*([0-9OoIlS]{1,2}\s*[.\-\/]\s*[0-9OoIlS]{1,2}\s*[.\-\/]\s*[0-9OoIlS]{4})/i.exec(t);
  ocr.prodDate = dm ? fixDigits(dm[1].replace(/\s/g, '').replace(/[\-\/]/g, '.')) : '';
  if (!validDate(ocr.prodDate, opts.now)) {
    var re = /([0-9OoIlS]{2})\s*[.\-\/]\s*([0-9OoIlS]{2})\s*[.\-\/]\s*([0-9OoIlS]{4})/g, m, found = '';
    while ((m = re.exec(t))) {
      var cand = fixDigits(m[1]) + '.' + fixDigits(m[2]) + '.' + fixDigits(m[3]);
      if (validDate(cand, opts.now)) { found = cand; break; }
    }
    if (found) ocr.prodDate = found;
  }

  // PROD.NO: any 11 digits
  ocr.prodNo = g(/PROD\.?\s*NO[.:\s]*([0-9OoIlS]{11})(?![0-9])/i, true) || g(/\b(\d{11})\b/);

  // SENDER: 8 digits starting with the prefix. Labels appear twice on the tag (one is only a heading), so also scan all tokens.
  ocr.sender = '';
  var sl = /SENDER[:\s]*([0-9OoIlSB]{8})(?![0-9A-Za-z])/i.exec(t);
  if (sl && fixDigits(sl[1]).indexOf(prefix) === 0) ocr.sender = fixDigits(sl[1]);
  if (!ocr.sender) {
    var toks = t.split(/[^0-9A-Za-z]+/);
    for (var i = 0; i < toks.length; i++) {
      var tk = toks[i];
      if (tk.length !== 8 || !/^[0-9OoIlSB]{8}$/.test(tk) || (tk.match(/\d/g) || []).length < 5) continue;
      var f = fixDigits(tk);
      if (f.indexOf(prefix) !== 0 || f === ocr.mat) continue;
      ocr.sender = f; break;
    }
  }
  if (!ocr.sender) {
    var any = /SENDER[:\s]*([0-9OoIlSB]{8})(?![0-9A-Za-z])/i.exec(t);
    if (any) ocr.sender = fixDigits(any[1]);       // 8 digits but another prefix: keep, flagged below
  }

  // secondary values (kept only as an extra reading; Master list is the source of truth)
  ocr.plant = g(/PLANT[:\s]*([0-9OoIlS]{4})/i, true);
  ocr.customer = g(/CUSTOMER[.:\s]*([A-Z][A-Z .&\-]*?)(?=\s+MODEL|\s*$)/im);
  var qm = /(?:^|\s)(\d{1,6}\.\d{2})(?=\s|$)/m.exec(t);
  ocr.qty = qm ? parseFloat(qm[1]) : NaN;

  var bcValue = opts.barcodeValue ? String(opts.barcodeValue).replace(/\D/g, '') : null;
  var bcSource = null, bc = null;
  if (bcValue && bcValue.length >= 32 && bcValue.length <= 35) { bc = decodeBarcode(bcValue); bcSource = 'camera'; }
  else if (digitsLine) { bc = decodeBarcode(digitsLine); bcSource = 'digits-line'; }

  var F = {}, S = {}, N = {};
  function setField(k, v, st, note) { F[k] = v; S[k] = st; N[k] = note || ''; }
  var bcTrusted = bc && (bcSource === 'camera' || bc.checkOk === true);
  var bcNote = bcSource === 'camera' ? 'จากบาร์โค้ด' : 'จากเลขใต้บาร์โค้ด (ผ่านตัวเลขตรวจสอบ)';
  function same(k, a, b) {
    var hasA = has(a), hasB = has(b);
    if (hasA && hasB) {
      if (a === b) setField(k, a, 'ok', 'ตรงกัน 2 จุด');
      else setField(k, a, 'warn', 'ไม่ตรงกัน: บาร์โค้ด ' + a + ' / ตัวอักษร ' + b);
    } else if (hasA) {
      if (bcTrusted) setField(k, a, 'ok', bcNote);
      else setField(k, a, 'warn', 'ตัวเลขตรวจสอบไม่ผ่าน อาจอ่านผิดบางหลัก');
    } else if (hasB) setField(k, b, 'warn', 'ไม่มีบาร์โค้ดให้ตรวจไขว้');
    else setField(k, '', 'warn', 'อ่านไม่พบ');
  }
  same('mat', bc ? bc.mat : '', ocr.mat);
  same('batch', bc ? bc.batch : '', ocr.batch);
  same('seq', bc ? bc.seq : NaN, ocr.seq);
  same('seqTotal', bc ? bc.seqTotal : NaN, ocr.seqTotal);
  same('qty', bc ? bc.qty : NaN, ocr.qty);

  if (!ocr.prodNo) setField('prodNo', '', 'warn', 'อ่านไม่พบ');
  else if (/^\d{11}$/.test(ocr.prodNo)) setField('prodNo', ocr.prodNo, 'ok', '11 หลัก');
  else setField('prodNo', ocr.prodNo, 'warn', 'ต้องเป็นตัวเลข 11 หลัก');

  if (!ocr.prodDate) setField('prodDate', '', 'warn', 'อ่านไม่พบ');
  else if (validDate(ocr.prodDate, opts.now)) setField('prodDate', ocr.prodDate, 'ok', 'วันที่ถูกต้อง');
  else setField('prodDate', ocr.prodDate, 'warn', 'วันที่ไม่สมเหตุสมผล');

  if (!ocr.sender) setField('sender', '', 'warn', 'อ่านไม่พบ');
  else if (new RegExp('^' + prefix + '\\d{6}$').test(ocr.sender)) setField('sender', ocr.sender, 'ok', '8 หลัก ขึ้นต้น ' + prefix);
  else setField('sender', ocr.sender, 'warn', 'ต้องเป็นเลข 8 หลัก ขึ้นต้น ' + prefix);

  function cmpRow(label, bcv, ocrv) {
    var st = has(bcv) && has(ocrv) ? (bcv === ocrv ? 'match' : 'diff') : (has(bcv) || has(ocrv) ? 'one' : 'none');
    return { label: label, bc: has(bcv) ? String(bcv) : '-', ocr: has(ocrv) ? String(ocrv) : '-', state: st };
  }
  var seqB = bc ? bc.seq + '/' + bc.seqTotal : '';
  var seqO = !isNaN(ocr.seq) && !isNaN(ocr.seqTotal) ? ocr.seq + '/' + ocr.seqTotal : '';
  var compare = [
    cmpRow('MAT.NO.', bc ? bc.mat : '', ocr.mat),
    cmpRow('BATCH NO.', bc ? bc.batch : '', ocr.batch),
    cmpRow('SEQ', seqB, seqO),
    cmpRow('QUANTITY', bc ? bc.qty.toFixed(2) : '', isNaN(ocr.qty) ? '' : ocr.qty.toFixed(2))
  ];

  return { fields: F, status: S, notes: N, ocr: ocr, barcode: bc, barcodeSource: bcSource, compare: compare, rawText: String(text || '') };
}

function mainScore(res) {
  var n = 0;
  MAIN_KEYS.forEach(function (k) { if (res.status[k] === 'ok') n++; });
  return n;
}
function missingMain(res) {
  return MAIN_KEYS.filter(function (k) { return res.status[k] !== 'ok'; });
}
/* Several frames of the same tag: keep the best one and borrow a main field another frame read correctly. */
function pickBest(list) {
  var best = null;
  list.forEach(function (r) { if (!best || mainScore(r) > mainScore(best)) best = r; });
  if (!best) return null;
  MAIN_KEYS.forEach(function (k) {
    if (best.status[k] === 'ok') return;
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (o !== best && o.status[k] === 'ok') {
        best.fields[k] = o.fields[k]; best.status[k] = 'ok'; best.notes[k] = o.notes[k] + ' (จากภาพอีกเฟรม)'; best.ocr[k] = o.ocr[k];
        break;
      }
    }
  });
  return best;
}

if (typeof module !== 'undefined') module.exports = { parseTag: parseTag, decodeBarcode: decodeBarcode, check128C: check128C, fixDigits: fixDigits, validDate: validDate, mainScore: mainScore, missingMain: missingMain, pickBest: pickBest };
