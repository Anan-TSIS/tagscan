/* ตั้งค่าตรงนี้ 2 บรรทัดแรกเท่านั้น (ดู README-GITHUB.md ข้อ 3) */
window.TAGSCAN_CONFIG = {
  endpoint: 'https://script.google.com/macros/s/AKfycby4Mw--OSpVidCuaslY2rBoV70IfXf0p4OPjEdmeMO4Xy3qDxZl5-FaHPrlTLU_Or4/exec',    // วาง URL เว็บแอป Apps Script ที่ลงท้าย /exec ระหว่างเครื่องหมาย ' '
  token: '5760',       // รหัสเดียวกับ var TOKEN ใน Code.gs
  version: 'v2-0.1'
  // ปรับแต่งเพิ่มได้ (ไม่ต้องแก้ถ้าไม่จำเป็น):
  // videoWidth: 3840, videoHeight: 2160,   ความละเอียดกล้องที่ขอ (มือถือให้เท่าที่ทำได้)
  // ocrMaxSide: 2400,                      ด้านยาวของภาพที่ส่งให้ OCR ยิ่งมากยิ่งแม่นแต่ช้า
  // maxFrames: 3                           จำนวนเฟรมที่อ่านซ้ำเมื่อ PROD.NO / PROD.DATE / SENDER ไม่ครบ
};
