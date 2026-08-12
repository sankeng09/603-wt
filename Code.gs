/**
 * ระบบหลังบ้านเว็บแอปห้องเรียน — Google Apps Script + Google Sheets (v2)
 * ------------------------------------------------------------------
 * v2: เพิ่มระบบ "ตารางเรียน" (Schedule) — ชีตใหม่จะถูกสร้างอัตโนมัติ ไม่ต้องตั้งค่าเอง
 *
 * วิธีอัปเดตจากเวอร์ชันเดิม:
 *  1) เปิด Google Sheet เดิม → ส่วนขยาย (Extensions) → Apps Script
 *  2) เลือกโค้ดเดิมทั้งหมด (Ctrl+A) ลบ แล้ววางไฟล์นี้ทับ
 *  3) กด ปรับใช้ (Deploy) → Manage deployments → ไอคอนดินสอ → Version: New version → Deploy
 *     (ลิงก์ Web app URL เดิมยังใช้ได้ ไม่ต้องแก้ index.html ใหม่)
 *
 * ติดตั้งใหม่ตั้งแต่ต้น: ดู README-setup.md
 */

/* ค่าการแจ้งเตือน Firebase ต้องกำหนดผ่าน Script Properties เท่านั้น ห้ามเก็บข้อมูลรับรองใน GitHub */
var FCM_PROJECT_ID   = PropertiesService.getScriptProperties().getProperty("FCM_PROJECT_ID") || "";
var FCM_CLIENT_EMAIL = PropertiesService.getScriptProperties().getProperty("FCM_CLIENT_EMAIL") || "";
var FCM_PRIVATE_KEY  = PropertiesService.getScriptProperties().getProperty("FCM_PRIVATE_KEY") || "";
var ADMIN_DEFAULT_USER = PropertiesService.getScriptProperties().getProperty("ADMIN_DEFAULT_USER") || "";
var ADMIN_DEFAULT_PASS = PropertiesService.getScriptProperties().getProperty("ADMIN_DEFAULT_PASS") || "";
var TIME_LETTER_AUTHOR_SECRET = PropertiesService.getScriptProperties().getProperty("TIME_LETTER_AUTHOR_SECRET") || "";

var SHEETS = {
  ACCOUNTS:      { name:"Accounts",      cols:["username","passHash","salt","role","displayName","deviceId","active","createdAt"] },
  ANNOUNCEMENTS: { name:"Announcements", cols:["id","title","body","pinned","createdAt","createdBy"] },
  POLLS:         { name:"Polls",         cols:["id","question","options","closed","createdAt","createdBy"] },
  VOTES:         { name:"Votes",         cols:["id","pollId","username","optionIndex","votedAt"] },
  POSTS:         { name:"Posts",         cols:["id","title","body","createdAt","createdBy"] },
  SCHEDULE:      { name:"Schedule",      cols:["id","data","updatedAt","updatedBy"] },
  PUSHTOKENS:    { name:"PushTokens",    cols:["username","token","updatedAt"] },
  COINS:         { name:"Coins",         cols:["username","displayName","coins","monthKey","lastClaim","lastRob"] },
  TIMELETTERS:   { name:"TimeLetters",   cols:["id","authorToken","title","body","unlockAt","createdAt"] },
  COUNTDOWNS:    { name:"Countdowns",    cols:["id","title","targetAt","createdAt","createdBy","updatedAt"] },
  MEMORIES:      { name:"Memories",       cols:["id","fileId","uploaderUsername","uploaderName","caption","eventName","status","createdAt","updatedAt","approvedAt","approvedBy","reviewNote"] }
};

function ss_(){ return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(key){
  var def = SHEETS[key];
  var sh = ss_().getSheetByName(def.name);
  if(!sh){
    sh = ss_().insertSheet(def.name);
    sh.appendRow(def.cols);
    sh.setFrozenRows(1);
  }
  // ป้องกัน Google Sheets ตีความ text บางคอลัมน์ (เช่น "2026-08" หรือ ISO timestamp) เป็นวันที่โดยอัตโนมัติ
  // ซึ่งจะทำให้การเทียบค่าแบบ string (===) พังเงียบ ๆ (คอยน์หายเวลารีเฟรช) — บังคับให้เป็น Plain text เสมอ
  // ทำทุกครั้งที่เรียก (ไม่ใช่แค่ตอนสร้างใหม่) เผื่อชีตเก่าที่เคยติดตั้งไปแล้วก่อนแก้บั๊กนี้
  if(key==="COINS" && sh.getMaxRows()>1){
    sh.getRange(2, 4, sh.getMaxRows()-1, 3).setNumberFormat("@"); // monthKey, lastClaim, lastRob
  }
  if((key==="TIMELETTERS" || key==="COUNTDOWNS" || key==="MEMORIES") && sh.getMaxRows()>1){
    sh.getRange(2, 1, sh.getMaxRows()-1, def.cols.length).setNumberFormat("@");
  }
  return sh;
}

function ensureSeed_(){
  var sh = sheet_("ACCOUNTS");
  if(sh.getLastRow() < 2){
    if(!ADMIN_DEFAULT_USER || !ADMIN_DEFAULT_PASS){
      throw new Error("ยังไม่มีบัญชีผู้ดูแลเริ่มต้น: กรุณาตั้งค่า ADMIN_DEFAULT_USER และ ADMIN_DEFAULT_PASS ใน Script Properties ก่อนใช้งานครั้งแรก");
    }
    var salt = randomToken_(8);
    sh.appendRow([ADMIN_DEFAULT_USER, hashPass_(ADMIN_DEFAULT_PASS, salt), salt, "admin", "ผู้ดูแลระบบ", "", true, nowIso_()]);
  }
}

function nowIso_(){ return new Date().toISOString(); }
function randomToken_(bytes){
  var s = "", chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  for(var i=0;i<bytes*2;i++) s += chars.charAt(Math.floor(Math.random()*chars.length));
  return s;
}
function hashPass_(pass, salt){
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pass)+"|"+String(salt));
  return raw.map(function(b){ var v=(b<0?b+256:b).toString(16); return v.length<2?"0"+v:v; }).join("");
}

function readAll_(key){
  var sh = sheet_(key);
  var vals = sh.getDataRange().getValues();
  var head = vals.shift();
  return vals.map(function(row,i){
    var o = {}; head.forEach(function(h,ci){ o[h]=row[ci]; }); o._row = i+2; return o;
  });
}
function findRow_(key, matchFn){
  var sh = sheet_(key);
  var vals = sh.getDataRange().getValues();
  var head = vals[0];
  for(var i=1;i<vals.length;i++){
    var o = {}; head.forEach(function(h,ci){ o[h]=vals[i][ci]; });
    if(matchFn(o)) return { obj:o, row:i+1, sheet:sh, head:head };
  }
  return null;
}
function writeCell_(sheet, row, head, col, val){ sheet.getRange(row, head.indexOf(col)+1).setValue(val); }

/* ── กำแพงความทรงจำ ──
   รูปที่เพิ่งอัปโหลดจะเป็น private ใน Drive และขึ้นสถานะ pending
   จะเปิดแบบ anyone-with-link เฉพาะเมื่อแอดมินอนุมัติเท่านั้น เพื่อไม่ให้รูปที่ยังไม่ได้ตรวจหลุดสู่แกลเลอรี */
var MEMORY_FOLDER_PROPERTY = "MEMORY_DRIVE_FOLDER_ID";
var MEMORY_MAX_BYTES = 2 * 1024 * 1024;
var MEMORY_ALLOWED_TYPES = {"image/jpeg":"jpg", "image/png":"png", "image/webp":"webp"};

function memoryFolder_(){
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty(MEMORY_FOLDER_PROPERTY);
  if(folderId){
    try{ return DriveApp.getFolderById(folderId); }
    catch(e){ throw new Error("ไม่พบโฟลเดอร์ความทรงจำใน Google Drive กรุณาตรวจสอบ MEMORY_DRIVE_FOLDER_ID"); }
  }
  var folder = DriveApp.createFolder("ความทรงจำ ห้อง ม.6/3");
  props.setProperty(MEMORY_FOLDER_PROPERTY, folder.getId());
  return folder;
}

/* รันด้วยตนเองจาก Apps Script Editor เพียงครั้งแรกโดยเจ้าของโปรเจกต์
   เพื่อให้ Google แสดงหน้าขอสิทธิ์ Drive และสร้างโฟลเดอร์เก็บรูปไว้ล่วงหน้า */
function setupMemoryDrive(){
  ensureSeed_();
  var folder = memoryFolder_();
  Logger.log("ตั้งค่าโฟลเดอร์ความทรงจำเรียบร้อย: "+folder.getUrl());
  return {ok:true, folderId:folder.getId(), folderUrl:folder.getUrl()};
}

function memoryText_(value, field, maxLength, required){
  var text = String(value || "").trim();
  if(required && !text) throw new Error("กรุณากรอก"+field);
  if(text.length > maxLength) throw new Error(field+"ยาวเกิน "+maxLength+" ตัวอักษร");
  return text;
}
function memoryImageUrl_(fileId, size){
  return "https://drive.google.com/thumbnail?id="+encodeURIComponent(String(fileId))+"&sz=w"+(size||1200);
}
function memoryView_(item, mode){
  var view = {
    id:String(item.id),
    caption:String(item.caption || ""),
    eventName:String(item.eventName || ""),
    status:String(item.status || "pending"),
    createdAt:timeIso_(item.createdAt),
    updatedAt:timeIso_(item.updatedAt),
    imageUrl:memoryImageUrl_(item.fileId, 1200),
    thumbnailUrl:memoryImageUrl_(item.fileId, 720)
  };
  if(mode==="owner" || mode==="admin"){
    view.reviewNote = String(item.reviewNote || "");
    view.approvedAt = item.approvedAt ? timeIso_(item.approvedAt) : "";
  }
  if(mode==="admin"){
    view.uploaderUsername = String(item.uploaderUsername || "");
    view.uploaderName = String(item.uploaderName || "");
    view.approvedBy = String(item.approvedBy || "");
    view.fileId = String(item.fileId || "");
  }
  return view;
}
function trashMemoryFile_(fileId){
  if(!fileId) return;
  try{ DriveApp.getFileById(String(fileId)).setTrashed(true); }catch(e){}
}

/* ── auth ── */
function findAccount_(username){
  return findRow_("ACCOUNTS", function(o){ return String(o.username).toLowerCase()===String(username||"").toLowerCase(); });
}
function verifySession_(body){
  if(!body.username || !body.device) throw new Error("ขาดข้อมูลเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่");
  var f = findAccount_(body.username);
  if(!f) throw new Error("ไม่พบบัญชีนี้");
  if(f.obj.active===false) throw new Error("บัญชีถูกระงับการใช้งาน");
  if(!f.obj.deviceId || String(f.obj.deviceId)!==String(body.device)) throw new Error("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
  return f;
}
function requireAdmin_(body){
  var f = verifySession_(body);
  if(f.obj.role!=="admin") throw new Error("ต้องเป็นแอดมินเท่านั้น");
  return f;
}

/* ── Push Notification (Firebase Cloud Messaging) ──
   ขอ access token ผ่าน service account (JWT → OAuth2) แล้วยิงไปที่ FCM HTTP v1 API
   ทุกอย่างห่อด้วย try/catch ที่จุดเรียกใช้เสมอ — push ล้มเหลวต้องไม่ทำให้การสร้างประกาศ/โหวต/โพสต์ล้มไปด้วย */
function fcmReady_(){
  return !!FCM_PROJECT_ID && !!FCM_CLIENT_EMAIL && !!FCM_PRIVATE_KEY;
}
function getFcmAccessToken_(){
  var cache = CacheService.getScriptCache();
  var cached = cache.get("fcm_access_token");
  if(cached) return cached;
  function b64url(input){
    var s = typeof input==="string" ? input : JSON.stringify(input);
    return Utilities.base64EncodeWebSafe(s).replace(/=+$/,"");
  }
  var now = Math.floor(Date.now()/1000);
  var header = { alg:"RS256", typ:"JWT" };
  var claim = {
    iss: FCM_CLIENT_EMAIL, scope:"https://www.googleapis.com/auth/firebase.messaging",
    aud:"https://oauth2.googleapis.com/token", iat:now, exp: now+3600
  };
  var toSign = b64url(header)+"."+b64url(claim);
  var sigBytes = Utilities.computeRsaSha256Signature(toSign, FCM_PRIVATE_KEY);
  var jwt = toSign+"."+Utilities.base64EncodeWebSafe(sigBytes).replace(/=+$/,"");
  var res = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method:"post",
    payload:{ grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt },
    muteHttpExceptions:true
  });
  var data = JSON.parse(res.getContentText());
  if(!data.access_token) throw new Error("ขอ access token ไม่สำเร็จ: "+res.getContentText());
  cache.put("fcm_access_token", data.access_token, 3300);
  return data.access_token;
}
/* ส่ง push ให้ทุกบัญชีที่ลงทะเบียนไว้ (ยกเว้นคนที่สั่งสร้างเอง) — เงียบไว้ถ้ายังไม่ตั้งค่า FCM หรือส่งไม่สำเร็จ */
function sendPushToAll_(title, body, excludeUsername){
  if(!fcmReady_()) return;
  var tokens = readAll_("PUSHTOKENS");
  if(!tokens.length) return;
  var accessToken;
  try{ accessToken = getFcmAccessToken_(); }catch(e){ return; }
  var url = "https://fcm.googleapis.com/v1/projects/"+FCM_PROJECT_ID+"/messages:send";
  tokens.forEach(function(t){
    if(!t.token) return;
    if(excludeUsername && String(t.username).toLowerCase()===String(excludeUsername).toLowerCase()) return;
    try{
      var res = UrlFetchApp.fetch(url, {
        method:"post", contentType:"application/json",
        headers:{ Authorization:"Bearer "+accessToken },
        payload: JSON.stringify({ message:{ token:t.token, notification:{ title:title, body:body },
          webpush:{ fcm_options:{ link:"/" } } } }),
        muteHttpExceptions:true
      });
      var code = res.getResponseCode();
      if(code>=400){
        var txt = res.getContentText();
        if(txt.indexOf("UNREGISTERED")>=0 || txt.indexOf("NOT_FOUND")>=0 || txt.indexOf("INVALID_ARGUMENT")>=0){
          var f = findRow_("PUSHTOKENS", function(o){ return o.token===t.token; });
          if(f) f.sheet.deleteRow(f.row);
        }
      }
    }catch(e){}
  });
}

/* ── ACTIONS ── */
var ACTIONS = {};

ACTIONS.ping = function(){ ensureSeed_(); return {ok:true, msg:"พร้อมใช้งาน"}; };

ACTIONS.login = function(body){
  ensureSeed_();
  var f = findAccount_(body.username||"");
  if(!f) return {ok:false, reason:"notfound"};
  if(f.obj.active===false) return {ok:false, reason:"disabled"};
  var hash = hashPass_(body.password||"", f.obj.salt);
  if(hash !== f.obj.passHash) return {ok:false, reason:"wrongpass"};
  var dev = String(body.device||"");
  if(!dev) return {ok:false, reason:"nodevice"};
  if(f.obj.deviceId && String(f.obj.deviceId)!==dev) return {ok:false, reason:"deviceused"};
  if(!f.obj.deviceId) writeCell_(f.sheet, f.row, f.head, "deviceId", dev);
  return {ok:true, username:f.obj.username, role:f.obj.role, displayName:f.obj.displayName};
};

ACTIONS.changePassword = function(body){
  var f = verifySession_(body);
  var pass = String(body.newPassword||"");
  if(pass.length<4) throw new Error("รหัสผ่านใหม่สั้นเกินไป (อย่างน้อย 4 ตัว)");
  var salt = randomToken_(8);
  writeCell_(f.sheet, f.row, f.head, "salt", salt);
  writeCell_(f.sheet, f.row, f.head, "passHash", hashPass_(pass, salt));
  return {ok:true};
};

/* บัญชีผู้ใช้ (แอดมินเท่านั้น) */
ACTIONS.listAccounts = function(body){
  requireAdmin_(body);
  var rows = readAll_("ACCOUNTS");
  rows.sort(function(a,b){ return a.createdAt<b.createdAt?1:-1; });
  return {ok:true, items: rows.map(function(o){
    return { username:o.username, role:o.role, displayName:o.displayName,
             active: o.active!==false, hasDevice: !!o.deviceId, createdAt:o.createdAt };
  })};
};
ACTIONS.createAccount = function(body){
  requireAdmin_(body);
  var u = String(body.newUsername||"").trim();
  if(!/^[a-zA-Z0-9._-]{3,20}$/.test(u)) throw new Error("ชื่อผู้ใช้ต้องเป็น a-z, 0-9, . _ - ความยาว 3-20 ตัว");
  if(findAccount_(u)) throw new Error("มีชื่อผู้ใช้นี้อยู่แล้ว");
  var pass = String(body.password||"");
  if(pass.length<4) throw new Error("รหัสผ่านสั้นเกินไป (อย่างน้อย 4 ตัว)");
  var salt = randomToken_(8);
  sheet_("ACCOUNTS").appendRow([u, hashPass_(pass,salt), salt, body.role==="admin"?"admin":"user",
    String(body.displayName||u).trim()||u, "", true, nowIso_()]);
  return {ok:true};
};
ACTIONS.deleteAccount = function(body){
  requireAdmin_(body);
  var f = findAccount_(body.target);
  if(!f) throw new Error("ไม่พบบัญชี");
  if(f.obj.role==="admin") throw new Error("ลบบัญชีแอดมินจากที่นี่ไม่ได้");
  f.sheet.deleteRow(f.row);
  return {ok:true};
};
ACTIONS.resetDevice = function(body){
  requireAdmin_(body);
  var f = findAccount_(body.target);
  if(!f) throw new Error("ไม่พบบัญชี");
  writeCell_(f.sheet, f.row, f.head, "deviceId", "");
  return {ok:true};
};
ACTIONS.setActive = function(body){
  requireAdmin_(body);
  var f = findAccount_(body.target);
  if(!f) throw new Error("ไม่พบบัญชี");
  writeCell_(f.sheet, f.row, f.head, "active", !!body.active);
  return {ok:true};
};
ACTIONS.resetPassword = function(body){
  requireAdmin_(body);
  var f = findAccount_(body.target);
  if(!f) throw new Error("ไม่พบบัญชี");
  var pass = String(body.newPassword||"");
  if(pass.length<4) throw new Error("รหัสผ่านสั้นเกินไป (อย่างน้อย 4 ตัว)");
  var salt = randomToken_(8);
  writeCell_(f.sheet, f.row, f.head, "salt", salt);
  writeCell_(f.sheet, f.row, f.head, "passHash", hashPass_(pass, salt));
  return {ok:true};
};

/* ประกาศ */
ACTIONS.listAnnouncements = function(body){
  verifySession_(body);
  var rows = readAll_("ANNOUNCEMENTS");
  rows.sort(function(a,b){
    if(!!a.pinned!==!!b.pinned) return a.pinned? -1:1;
    return a.createdAt<b.createdAt?1:-1;
  });
  return {ok:true, items: rows};
};
ACTIONS.createAnnouncement = function(body){
  var f = requireAdmin_(body);
  if(!String(body.title||"").trim()) throw new Error("ใส่หัวข้อประกาศก่อน");
  var id = "a"+Date.now();
  sheet_("ANNOUNCEMENTS").appendRow([id, body.title, body.body||"", !!body.pinned, nowIso_(), f.obj.username]);
  try{ sendPushToAll_("📌 ประกาศใหม่", body.title, f.obj.username); }catch(e){}
  return {ok:true, id:id};
};
ACTIONS.togglePinAnnouncement = function(body){
  requireAdmin_(body);
  var f = findRow_("ANNOUNCEMENTS", function(o){ return o.id===body.id; });
  if(!f) throw new Error("ไม่พบประกาศ");
  writeCell_(f.sheet, f.row, f.head, "pinned", !f.obj.pinned);
  return {ok:true};
};
ACTIONS.deleteAnnouncement = function(body){
  requireAdmin_(body);
  var f = findRow_("ANNOUNCEMENTS", function(o){ return o.id===body.id; });
  if(!f) throw new Error("ไม่พบประกาศ");
  f.sheet.deleteRow(f.row);
  return {ok:true};
};

/* โหวต */
ACTIONS.listPolls = function(body){
  var f = verifySession_(body);
  var polls = readAll_("POLLS");
  var votes = readAll_("VOTES");
  polls.sort(function(a,b){ return a.createdAt<b.createdAt?1:-1; });
  var items = polls.map(function(p){
    var opts = JSON.parse(p.options||"[]");
    var counts = opts.map(function(){ return 0; });
    var mine = null, total = 0;
    votes.forEach(function(v){
      if(v.pollId!==p.id) return;
      total++;
      if(counts[v.optionIndex]!=null) counts[v.optionIndex]++;
      if(String(v.username).toLowerCase()===String(f.obj.username).toLowerCase()) mine=v.optionIndex;
    });
    return { id:p.id, question:p.question, options:opts, closed:!!p.closed, createdAt:p.createdAt,
             counts:counts, total:total, mine:mine };
  });
  return {ok:true, items:items};
};
ACTIONS.createPoll = function(body){
  var f = requireAdmin_(body);
  var q = String(body.question||"").trim();
  var opts = (body.options||[]).map(function(x){ return String(x||"").trim(); }).filter(Boolean);
  if(!q) throw new Error("ใส่คำถามก่อน");
  if(opts.length<2) throw new Error("ต้องมีตัวเลือกอย่างน้อย 2 ข้อ");
  var id = "p"+Date.now();
  sheet_("POLLS").appendRow([id, q, JSON.stringify(opts), false, nowIso_(), f.obj.username]);
  try{ sendPushToAll_("🗳️ มีโหวตใหม่", q, f.obj.username); }catch(e){}
  return {ok:true, id:id};
};
ACTIONS.closePoll = function(body){
  requireAdmin_(body);
  var f = findRow_("POLLS", function(o){ return o.id===body.id; });
  if(!f) throw new Error("ไม่พบโหวต");
  writeCell_(f.sheet, f.row, f.head, "closed", !f.obj.closed);
  return {ok:true};
};
ACTIONS.deletePoll = function(body){
  requireAdmin_(body);
  var f = findRow_("POLLS", function(o){ return o.id===body.id; });
  if(!f) throw new Error("ไม่พบโหวต");
  f.sheet.deleteRow(f.row);
  var sh = sheet_("VOTES");
  var vals = sh.getDataRange().getValues();
  for(var i=vals.length-1;i>=1;i--){ if(vals[i][1]===body.id) sh.deleteRow(i+1); }
  return {ok:true};
};
ACTIONS.vote = function(body){
  var f = verifySession_(body);
  var poll = findRow_("POLLS", function(o){ return o.id===body.pollId; });
  if(!poll) throw new Error("ไม่พบโหวตนี้");
  if(poll.obj.closed) throw new Error("โหวตนี้ปิดรับคำตอบแล้ว");
  var opts = JSON.parse(poll.obj.options||"[]");
  var idx = parseInt(body.optionIndex,10);
  if(isNaN(idx) || idx<0 || idx>=opts.length) throw new Error("ตัวเลือกไม่ถูกต้อง");
  var existing = findRow_("VOTES", function(o){
    return o.pollId===body.pollId && String(o.username).toLowerCase()===String(f.obj.username).toLowerCase();
  });
  if(existing){
    writeCell_(existing.sheet, existing.row, existing.head, "optionIndex", idx);
    writeCell_(existing.sheet, existing.row, existing.head, "votedAt", nowIso_());
  } else {
    sheet_("VOTES").appendRow(["v"+Date.now(), body.pollId, f.obj.username, idx, nowIso_()]);
  }
  return {ok:true};
};

/* ฟีดโพสต์ */
ACTIONS.listPosts = function(body){
  verifySession_(body);
  var rows = readAll_("POSTS");
  rows.sort(function(a,b){ return a.createdAt<b.createdAt?1:-1; });
  return {ok:true, items:rows};
};
ACTIONS.createPost = function(body){
  var f = requireAdmin_(body);
  if(!String(body.body||"").trim()) throw new Error("ใส่เนื้อหาโพสต์ก่อน");
  var id = "post"+Date.now();
  sheet_("POSTS").appendRow([id, body.title||"", body.body, nowIso_(), f.obj.username]);
  try{ sendPushToAll_("📰 โพสต์ใหม่ในฟีด", body.title||String(body.body).slice(0,80), f.obj.username); }catch(e){}
  return {ok:true, id:id};
};
ACTIONS.deletePost = function(body){
  requireAdmin_(body);
  var f = findRow_("POSTS", function(o){ return o.id===body.id; });
  if(!f) throw new Error("ไม่พบโพสต์");
  f.sheet.deleteRow(f.row);
  return {ok:true};
};

/* ตารางเรียน — เก็บเป็นเอกสาร JSON เดียว (แถวเดียว id="main") */
ACTIONS.getSchedule = function(body){
  verifySession_(body);
  var f = findRow_("SCHEDULE", function(o){ return o.id==="main"; });
  if(!f) return {ok:true, data:null};
  var data=null;
  try{ data=JSON.parse(f.obj.data||"null"); }catch(e){ data=null; }
  return {ok:true, data:data, updatedAt:f.obj.updatedAt};
};
ACTIONS.saveSchedule = function(body){
  var f = requireAdmin_(body);
  var raw = body.data;
  try{ JSON.parse(raw); }catch(e){ throw new Error("ข้อมูลตารางไม่ถูกต้อง"); }
  var existing = findRow_("SCHEDULE", function(o){ return o.id==="main"; });
  if(existing){
    writeCell_(existing.sheet, existing.row, existing.head, "data", raw);
    writeCell_(existing.sheet, existing.row, existing.head, "updatedAt", nowIso_());
    writeCell_(existing.sheet, existing.row, existing.head, "updatedBy", f.obj.username);
  } else {
    sheet_("SCHEDULE").appendRow(["main", raw, nowIso_(), f.obj.username]);
  }
  return {ok:true};
};

/* รวมทุกอย่างในคำขอเดียว — ใช้สำหรับ auto-sync เป็นระยะ ลดจำนวนคำขอจาก 5 เหลือ 1 ต่อรอบ */
ACTIONS.syncAll = function(body){
  var f = verifySession_(body);
  var out = { ok:true };
  out.announcements = ACTIONS.listAnnouncements(body).items;
  out.polls = ACTIONS.listPolls(body).items;
  out.posts = ACTIONS.listPosts(body).items;
  out.schedule = ACTIONS.getSchedule(body).data;
  if(f.obj.role==="admin") out.accounts = ACTIONS.listAccounts(body).items;
  return out;
};

/* โทเคนแจ้งเตือน (แต่ละบัญชีมี 1 token ตามกติกา 1 บัญชี 1 เครื่อง) */
ACTIONS.registerPushToken = function(body){
  var f = verifySession_(body);
  var token = String(body.token||"").trim();
  if(!token) throw new Error("token ว่างเปล่า");
  var existing = findRow_("PUSHTOKENS", function(o){ return String(o.username).toLowerCase()===String(f.obj.username).toLowerCase(); });
  if(existing){
    writeCell_(existing.sheet, existing.row, existing.head, "token", token);
    writeCell_(existing.sheet, existing.row, existing.head, "updatedAt", nowIso_());
  } else {
    sheet_("PUSHTOKENS").appendRow([f.obj.username, token, nowIso_()]);
  }
  return {ok:true};
};
ACTIONS.unregisterPushToken = function(body){
  var f = verifySession_(body);
  var existing = findRow_("PUSHTOKENS", function(o){ return String(o.username).toLowerCase()===String(f.obj.username).toLowerCase(); });
  if(existing) existing.sheet.deleteRow(existing.row);
  return {ok:true};
};

/* ── ระบบคอยน์ (ล็อกอินรายวัน / ปล้นคอยน์ / อันดับ) ── */
function monthKey_(){ var d=new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0"); }
/* ทำให้ค่า monthKey ที่อ่านจากชีตเป็น string "YYYY-MM" เสมอ ไม่ว่า Google Sheets จะแอบตีความเซลล์เป็น Date
   object ให้เองหรือไม่ (เคยเป็นสาเหตุให้คอยน์รีเซ็ตเป็น 0 ทุกครั้งที่มีการอ่าน/รีเฟรช เพราะเทียบ string กับ Date
   ด้วย === แล้วไม่เท่ากันเสมอ ทั้งที่จริงเป็นเดือนเดียวกัน) */
function normMonthKey_(v){
  if(v instanceof Date) return v.getFullYear()+"-"+String(v.getMonth()+1).padStart(2,"0");
  return String(v||"");
}
/* หาแถวคอยน์ของบัญชี ถ้าไม่มีให้สร้างใหม่ และล้างยอดอัตโนมัติถ้าข้ามเดือนแล้ว (รีเซ็ตรายเดือนแบบ lazy ไม่ต้องมี trigger แยก) */
function coinRow_(acc){
  var row = findRow_("COINS", function(o){ return String(o.username).toLowerCase()===String(acc.obj.username).toLowerCase(); });
  if(!row){
    sheet_("COINS").appendRow([acc.obj.username, acc.obj.displayName, 0, monthKey_(), "", ""]);
    row = findRow_("COINS", function(o){ return String(o.username).toLowerCase()===String(acc.obj.username).toLowerCase(); });
  }
  if(normMonthKey_(row.obj.monthKey) !== monthKey_()){
    writeCell_(row.sheet, row.row, row.head, "coins", 0);
    writeCell_(row.sheet, row.row, row.head, "monthKey", monthKey_());
    row.obj.coins = 0; row.obj.monthKey = monthKey_();
  }
  if(row.obj.displayName !== acc.obj.displayName){
    writeCell_(row.sheet, row.row, row.head, "displayName", acc.obj.displayName);
    row.obj.displayName = acc.obj.displayName;
  }
  return row;
}

var COIN_COOLDOWN_MS = 24*60*60*1000; // คูลดาวน์จริง 24 ชม. นับจากครั้งล่าสุด ไม่ใช่ตามเที่ยงคืน

ACTIONS.claimDaily = function(body){
  var f = verifySession_(body);
  var row = coinRow_(f);
  var last = row.obj.lastClaim ? new Date(row.obj.lastClaim) : null;
  var now = new Date();
  if(last){
    var elapsed = now.getTime() - last.getTime();
    if(elapsed < COIN_COOLDOWN_MS){
      return {ok:false, reason:"cooldown", remainMs: COIN_COOLDOWN_MS - elapsed};
    }
  }
  var r = Math.random()*100, coin;
  if(r<35) coin=1; else if(r<65) coin=2; else if(r<85) coin=3; else if(r<95) coin=4; else coin=5;
  var newTotal = (Number(row.obj.coins)||0) + coin;
  writeCell_(row.sheet, row.row, row.head, "coins", newTotal);
  writeCell_(row.sheet, row.row, row.head, "lastClaim", nowIso_());
  return {ok:true, coin:coin, total:newTotal};
};

ACTIONS.robCoin = function(body){
  var f = verifySession_(body);
  if(!body.target) throw new Error("เลือกเป้าหมายก่อน");
  if(String(body.target).toLowerCase()===String(f.obj.username).toLowerCase()) throw new Error("ปล้นตัวเองไม่ได้");
  var myRow = coinRow_(f);
  var last = myRow.obj.lastRob ? new Date(myRow.obj.lastRob) : null;
  var now = new Date();
  if(last){
    var elapsed = now.getTime() - last.getTime();
    if(elapsed < COIN_COOLDOWN_MS){
      return {ok:false, reason:"cooldown", remainMs: COIN_COOLDOWN_MS - elapsed};
    }
  }
  var targetAcc = findAccount_(body.target);
  if(!targetAcc) throw new Error("ไม่พบผู้ใช้เป้าหมาย");
  var targetRow = coinRow_(targetAcc);
  var targetCoins = Number(targetRow.obj.coins)||0;
  if(targetCoins < 1) return {ok:false, reason:"notarget"};
  
  // บันทึกเวลาปล้นทันที (เสียสิทธิ์การปล้นของวันนั้นแล้ว)
  writeCell_(myRow.sheet, myRow.row, myRow.head, "lastRob", nowIso_());
  
  // โอกาสปล้นสำเร็จ 60%
  if(Math.random() < 0.6) {
    writeCell_(targetRow.sheet, targetRow.row, targetRow.head, "coins", targetCoins-1);
    var myNew = (Number(myRow.obj.coins)||0) + 1;
    writeCell_(myRow.sheet, myRow.row, myRow.head, "coins", myNew);
    return {ok:true, success:true, target: targetAcc.obj.displayName, total: myNew};
  } else {
    return {ok:true, success:false, target: targetAcc.obj.displayName, total: Number(myRow.obj.coins)||0};
  }
};

ACTIONS.listCoinLeaderboard = function(body){
  var f = verifySession_(body);
  var rows = readAll_("COINS");
  var mk = monthKey_();
  var items = rows.map(function(o){
    return { username:o.username, displayName:o.displayName||o.username,
             coins: (normMonthKey_(o.monthKey)===mk) ? (Number(o.coins)||0) : 0 };
  }).sort(function(a,b){ return b.coins-a.coins; });
  var top = items.slice(0,5);
  var myRow = coinRow_(f);
  return { ok:true, top:top, myTotal: Number(myRow.obj.coins)||0,
           myLastClaim: myRow.obj.lastClaim||null, myLastRob: myRow.obj.lastRob||null };
};
/* รายชื่อเป้าหมายที่ปล้นได้ (ทุกคนที่ยังใช้งานอยู่ ยกเว้นตัวเอง) พร้อมยอดคอยน์ปัจจุบัน */
ACTIONS.listRobTargets = function(body){
  var f = verifySession_(body);
  var accs = readAll_("ACCOUNTS");
  var coinsRows = readAll_("COINS");
  var mk = monthKey_();
  var coinMap = {};
  coinsRows.forEach(function(o){ coinMap[String(o.username).toLowerCase()] = (normMonthKey_(o.monthKey)===mk)?(Number(o.coins)||0):0; });
  var items = accs.filter(function(a){
    return String(a.username).toLowerCase()!==String(f.obj.username).toLowerCase() && a.active!==false;
  }).map(function(a){
    return { username:a.username, displayName:a.displayName, coins: coinMap[String(a.username).toLowerCase()]||0 };
  }).sort(function(a,b){ return b.coins-a.coins; });
  return {ok:true, items:items};
};
/* แอดมิน: ปรับคอยน์ของนักเรียนคนใดคนหนึ่งด้วยตนเอง (เช่น หักออกหลังแลกรางวัลกันตัวจริงแล้ว) */
ACTIONS.adminSetCoins = function(body){
  requireAdmin_(body);
  var targetAcc = findAccount_(body.target);
  if(!targetAcc) throw new Error("ไม่พบบัญชี");
  var row = coinRow_(targetAcc);
  var val = Math.max(0, parseInt(body.coins,10)||0);
  writeCell_(row.sheet, row.row, row.head, "coins", val);
  return {ok:true};
};

/* ── แจ้งเตือนก่อนถึงคาบเรียนถัดไป ──
   ติดตั้งครั้งเดียว: เปิดไฟล์นี้ใน Apps Script editor → ที่แถบด้านบนเลือกฟังก์ชัน "installScheduleReminder"
   จาก dropdown ข้างปุ่ม Run/Debug → กด ▶ Run → อนุญาตสิทธิ์ถ้าถาม
   จะสร้าง time-trigger ให้เช็คตารางเรียนทุก 5 นาที แล้วส่ง push แจ้งล่วงหน้าก่อนคาบเริ่ม
   ถอนการติดตั้ง: เลือกฟังก์ชัน "uninstallScheduleReminder" แล้ว Run แทน
   ⚠️ ตรวจสอบว่าโปรเจกต์ตั้ง Time zone เป็น Asia/Bangkok ที่ Project Settings (ไอคอนเฟือง) ไม่งั้นเวลาจะเพี้ยน */
function installScheduleReminder(){
  uninstallScheduleReminder();
  ScriptApp.newTrigger("checkUpcomingPeriod_").timeBased().everyMinutes(5).create();
  Logger.log("ติดตั้งการแจ้งเตือนตารางเรียนแล้ว — ทำงานทุก 5 นาที");
}
function uninstallScheduleReminder(){
  ScriptApp.getProjectTriggers().forEach(function(t){
    if(t.getHandlerFunction()==="checkUpcomingPeriod_") ScriptApp.deleteTrigger(t);
  });
}
/* เรียกอัตโนมัติทุก 5 นาทีโดย trigger — ถ้ามีคาบไหนจะเริ่มในอีก 0-4 นาที ส่ง push บอกล่วงหน้า (กันส่งซ้ำด้วย cache ต่อวันต่อคาบ) */
function checkUpcomingPeriod_(){
  var f = findRow_("SCHEDULE", function(o){ return o.id==="main"; });
  if(!f) return;
  var data; try{ data = JSON.parse(f.obj.data||"null"); }catch(e){ return; }
  if(!data || !data.periods || !data.days) return;

  var now = new Date();
  var dayIdx = now.getDay()-1;               // 0=จันทร์..4=ศุกร์ ตรงกับลำดับวันในตารางเรียน
  if(dayIdx<0 || dayIdx>4) return;
  var nowMin = now.getHours()*60+now.getMinutes();
  var tz = Session.getScriptTimeZone() || "Asia/Bangkok";
  var dateKey = Utilities.formatDate(now, tz, "yyyy-MM-dd");
  var cache = CacheService.getScriptCache();

  data.periods.forEach(function(p, pi){
    var m = String(p.time||"").match(/(\d{1,2})[.:](\d{2})/);
    if(!m) return;
    var startMin = (+m[1])*60+(+m[2]);
    var diff = startMin - nowMin;
    if(diff < 0 || diff > 4) return;          // สนใจเฉพาะช่วง 0-4 นาทีก่อนเริ่มคาบ (ให้ครอบคลุมรอบ trigger ทุก 5 นาที)

    var cacheKey = "sched_notif_"+dateKey+"_"+pi;
    if(cache.get(cacheKey)) return;           // แจ้งไปแล้วสำหรับคาบนี้วันนี้ ไม่ต้องซ้ำ
    cache.put(cacheKey, "1", 6*60*60);

    var content = String((data.cells[dayIdx+"-"+pi]||"")).split("\n")[0] || "ไม่มีข้อมูล";
    try{ sendPushToAll_("🔔 ใกล้ถึงคาบ "+(pi+1), content+" • เริ่ม "+p.time, null); }catch(e){}
  });
}

/* ── จดหมายเวลา (Time Capsule Letter) ──
   ผู้เขียนถูกเก็บไว้เฉพาะในชีตเพื่อยืนยันสิทธิ์การลบ และห้ามส่งกลับไปยังหน้าเว็บทุกกรณี */
function timeIso_(value){
  var date = value instanceof Date ? value : new Date(value);
  if(isNaN(date.getTime())) return String(value || "");
  return date.toISOString();
}
function requiredFutureTime_(raw, label){
  var date = new Date(raw);
  if(isNaN(date.getTime())) throw new Error("รูปแบบ"+(label||"วันเวลา")+"ไม่ถูกต้อง");
  if(date.getTime() <= Date.now()) throw new Error((label||"วันเวลา")+"ต้องอยู่ในอนาคต");
  return date.toISOString();
}
function timeLetterView_(letter, now){
  var unlockAt = timeIso_(letter.unlockAt);
  var opened = new Date(unlockAt).getTime() <= now.getTime();
  return {
    id:String(letter.id),
    title:String(letter.title || "จดหมายไม่มีชื่อเรื่อง"),
    unlockAt:unlockAt,
    createdAt:timeIso_(letter.createdAt),
    status:opened ? "opened" : "locked",
    body:opened ? String(letter.body || "") : null
  };
}
function countdownView_(item){
  return {
    id:String(item.id),
    title:String(item.title || "เคาท์ดาวน์"),
    targetAt:timeIso_(item.targetAt),
    createdAt:timeIso_(item.createdAt),
    updatedAt:timeIso_(item.updatedAt)
  };
}
function newId_(){ return Utilities.getUuid(); }
function normalizedText_(value, field, maxLength){
  var text = String(value || "").trim();
  if(!text) throw new Error("กรุณากรอก"+field);
  if(text.length > maxLength) throw new Error(field+"ยาวเกิน "+maxLength+" ตัวอักษร");
  return text;
}
function authorToken_(username){
  if(!TIME_LETTER_AUTHOR_SECRET){
    throw new Error("ยังไม่ได้ตั้งค่า TIME_LETTER_AUTHOR_SECRET ใน Script Properties");
  }
  var bytes = Utilities.computeHmacSha256Signature(String(username||"").toLowerCase(), TIME_LETTER_AUTHOR_SECRET);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, "");
}
function timeLettersSheet_(){
  var sh = sheet_("TIMELETTERS");
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  var legacyIndex = header.indexOf("authorUsername");
  var tokenIndex = header.indexOf("authorToken");
  if(tokenIndex < 0 && legacyIndex >= 0){
    var rowCount = sh.getLastRow()-1;
    if(rowCount > 0){
      var legacyValues = sh.getRange(2, legacyIndex+1, rowCount, 1).getValues();
      sh.getRange(2, legacyIndex+1, rowCount, 1).setValues(legacyValues.map(function(row){
        return [authorToken_(row[0])];
      }));
    }
    sh.getRange(1, legacyIndex+1).setValue("authorToken");
  }
  return sh;
}

ACTIONS.createTimeLetter = function(body){
  var account = verifySession_(body);
  timeLettersSheet_();
  var title = normalizedText_(body.title, "ชื่อเรื่อง", 120);
  var letterBody = normalizedText_(body.letterBody, "ข้อความในจดหมาย", 5000);
  var unlockAt = requiredFutureTime_(body.unlockAt, "วันเวลาเปิดผนึก");
  var id = newId_();
  sheet_("TIMELETTERS").appendRow([id, authorToken_(account.obj.username), title, letterBody, unlockAt, nowIso_()]);
  return {ok:true, letter:{id:id, title:title, unlockAt:unlockAt, status:"locked"}};
};

ACTIONS.listTimeLetters = function(body){
  verifySession_(body);
  timeLettersSheet_();
  var now = new Date();
  var items = readAll_("TIMELETTERS").map(function(letter){ return timeLetterView_(letter, now); });
  items.sort(function(a,b){ return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(); });
  return {ok:true, total:items.length, items:items};
};

ACTIONS.readTimeLetter = function(body){
  verifySession_(body);
  timeLettersSheet_();
  var id = String(body.id || "");
  var found = findRow_("TIMELETTERS", function(letter){ return String(letter.id)===id; });
  if(!found) throw new Error("ไม่พบจดหมายฉบับนี้");
  return {ok:true, letter:timeLetterView_(found.obj, new Date())};
};

ACTIONS.listMyTimeLetters = function(body){
  var account = verifySession_(body);
  timeLettersSheet_();
  var authorToken = authorToken_(account.obj.username);
  var now = new Date();
  var items = readAll_("TIMELETTERS").filter(function(letter){
    return String(letter.authorToken)===authorToken;
  }).map(function(letter){ return timeLetterView_(letter, now); });
  items.sort(function(a,b){ return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(); });
  return {ok:true, total:items.length, items:items};
};

ACTIONS.deleteMyTimeLetter = function(body){
  var account = verifySession_(body);
  timeLettersSheet_();
  var id = String(body.id || "");
  if(!id) throw new Error("ไม่พบรหัสจดหมาย");
  var authorToken = authorToken_(account.obj.username);
  var found = findRow_("TIMELETTERS", function(letter){
    return String(letter.id)===id && String(letter.authorToken)===authorToken;
  });
  if(!found) throw new Error("ไม่พบจดหมาย หรือคุณไม่มีสิทธิ์ลบจดหมายฉบับนี้");
  found.sheet.deleteRow(found.row);
  return {ok:true};
};

/* ── กำแพงความทรงจำ ── */
ACTIONS.createMemory = function(body){
  var account = verifySession_(body);
  var mimeType = String(body.mimeType || "").toLowerCase();
  var extension = MEMORY_ALLOWED_TYPES[mimeType];
  if(!extension) throw new Error("รองรับเฉพาะไฟล์ JPG, PNG และ WebP");
  var base64 = String(body.imageBase64 || "").replace(/\s/g, "");
  if(!base64) throw new Error("ไม่พบข้อมูลรูปภาพ");
  var bytes;
  try{ bytes = Utilities.base64Decode(base64); }
  catch(e){ throw new Error("ไฟล์รูปภาพไม่ถูกต้อง"); }
  if(!bytes.length || bytes.length > MEMORY_MAX_BYTES) throw new Error("รูปภาพต้องมีขนาดไม่เกิน 2 MB หลังปรับขนาด");
  var caption = memoryText_(body.caption, "คำบรรยาย", 240, false);
  var eventName = memoryText_(body.eventName, "ชื่อกิจกรรม", 80, false);
  var id = newId_();
  var now = nowIso_();
  var file = null;
  try{
    var blob = Utilities.newBlob(bytes, mimeType, "memory-"+id+"."+extension);
    file = memoryFolder_().createFile(blob).setName("memory-"+id+"."+extension);
    sheet_("MEMORIES").appendRow([id, file.getId(), account.obj.username, account.obj.displayName || account.obj.username, caption, eventName, "pending", now, now, "", "", ""]);
  }catch(e){
    if(file) trashMemoryFile_(file.getId());
    throw new Error("บันทึกรูปภาพไม่สำเร็จ: "+String(e && e.message || e));
  }
  return {ok:true, memory:{id:id, caption:caption, eventName:eventName, status:"pending", createdAt:now}};
};

ACTIONS.listMemories = function(body){
  verifySession_(body);
  var items = readAll_("MEMORIES").filter(function(item){ return String(item.status)==="approved"; }).map(function(item){ return memoryView_(item, "public"); });
  items.sort(function(a,b){ return new Date(b.createdAt).getTime()-new Date(a.createdAt).getTime(); });
  return {ok:true, items:items};
};

ACTIONS.listMyMemories = function(body){
  var account = verifySession_(body);
  var username = String(account.obj.username).toLowerCase();
  var items = readAll_("MEMORIES").filter(function(item){ return String(item.uploaderUsername).toLowerCase()===username; }).map(function(item){ return memoryView_(item, "owner"); });
  items.sort(function(a,b){ return new Date(b.createdAt).getTime()-new Date(a.createdAt).getTime(); });
  return {ok:true, items:items};
};

ACTIONS.listMemoryModeration = function(body){
  requireAdmin_(body);
  var items = readAll_("MEMORIES").filter(function(item){ return String(item.status)==="pending"; }).map(function(item){ return memoryView_(item, "admin"); });
  items.sort(function(a,b){ return new Date(a.createdAt).getTime()-new Date(b.createdAt).getTime(); });
  return {ok:true, items:items};
};

/* ส่งตัวอย่างรูปเป็น data URL เฉพาะเจ้าของหรือแอดมิน เพื่อให้รูป pending
   ยังเป็น private ใน Drive จนกว่าจะกดอนุมัติ แต่ตรวจสอบได้จากหน้าเว็บแอป */
ACTIONS.getMemoryPreview = function(body){
  var account = verifySession_(body);
  var id = String(body.id || "");
  var found = findRow_("MEMORIES", function(item){ return String(item.id)===id; });
  if(!found) throw new Error("ไม่พบรูปภาพนี้");
  var isOwner = String(found.obj.uploaderUsername).toLowerCase()===String(account.obj.username).toLowerCase();
  if(!isOwner && account.obj.role!=="admin") throw new Error("คุณไม่มีสิทธิ์ดูรูปนี้");
  if(String(found.obj.status)==="rejected") throw new Error("รูปนี้ถูกลบออกจากพื้นที่เก็บข้อมูลแล้ว");
  var file;
  try{ file = DriveApp.getFileById(String(found.obj.fileId)); }
  catch(e){ throw new Error("ไม่พบไฟล์รูปภาพใน Google Drive"); }
  var blob = file.getBlob();
  var mimeType = String(blob.getContentType() || "").toLowerCase();
  if(!MEMORY_ALLOWED_TYPES[mimeType]) throw new Error("ไม่สามารถเปิดตัวอย่างไฟล์นี้ได้");
  return {ok:true, imageDataUrl:"data:"+mimeType+";base64,"+Utilities.base64Encode(blob.getBytes()), caption:String(found.obj.caption || ""), eventName:String(found.obj.eventName || "")};
};

ACTIONS.approveMemory = function(body){
  var admin = requireAdmin_(body);
  var id = String(body.id || "");
  var found = findRow_("MEMORIES", function(item){ return String(item.id)===id; });
  if(!found) throw new Error("ไม่พบรูปภาพนี้");
  if(String(found.obj.status)!=="pending") throw new Error("รูปนี้ผ่านการตรวจสอบแล้ว");
  try{
    DriveApp.getFileById(String(found.obj.fileId)).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  }catch(e){
    throw new Error("เปิดสิทธิ์แสดงรูปในแกลเลอรีไม่สำเร็จ กรุณาตรวจสอบนโยบายการแชร์ของ Google Drive");
  }
  var now = nowIso_();
  writeCell_(found.sheet, found.row, found.head, "status", "approved");
  writeCell_(found.sheet, found.row, found.head, "updatedAt", now);
  writeCell_(found.sheet, found.row, found.head, "approvedAt", now);
  writeCell_(found.sheet, found.row, found.head, "approvedBy", admin.obj.username);
  writeCell_(found.sheet, found.row, found.head, "reviewNote", "");
  return {ok:true};
};

ACTIONS.rejectMemory = function(body){
  var admin = requireAdmin_(body);
  var id = String(body.id || "");
  var found = findRow_("MEMORIES", function(item){ return String(item.id)===id; });
  if(!found) throw new Error("ไม่พบรูปภาพนี้");
  if(String(found.obj.status)!=="pending") throw new Error("รูปนี้ผ่านการตรวจสอบแล้ว");
  var note = memoryText_(body.reviewNote, "เหตุผล", 240, false);
  trashMemoryFile_(found.obj.fileId);
  var now = nowIso_();
  writeCell_(found.sheet, found.row, found.head, "status", "rejected");
  writeCell_(found.sheet, found.row, found.head, "updatedAt", now);
  writeCell_(found.sheet, found.row, found.head, "reviewNote", note);
  writeCell_(found.sheet, found.row, found.head, "approvedBy", admin.obj.username);
  return {ok:true};
};

ACTIONS.deleteMyMemory = function(body){
  var account = verifySession_(body);
  var id = String(body.id || "");
  var username = String(account.obj.username).toLowerCase();
  var found = findRow_("MEMORIES", function(item){ return String(item.id)===id && String(item.uploaderUsername).toLowerCase()===username; });
  if(!found) throw new Error("ไม่พบรูปภาพ หรือคุณไม่มีสิทธิ์ลบรูปนี้");
  trashMemoryFile_(found.obj.fileId);
  found.sheet.deleteRow(found.row);
  return {ok:true};
};

ACTIONS.deleteMemory = function(body){
  requireAdmin_(body);
  var id = String(body.id || "");
  var found = findRow_("MEMORIES", function(item){ return String(item.id)===id; });
  if(!found) throw new Error("ไม่พบรูปภาพนี้");
  trashMemoryFile_(found.obj.fileId);
  found.sheet.deleteRow(found.row);
  return {ok:true};
};

/* ── เคาท์ดาวน์ ── */
ACTIONS.listCountdowns = function(body){
  verifySession_(body);
  var items = readAll_("COUNTDOWNS").map(countdownView_);
  items.sort(function(a,b){ return new Date(a.targetAt).getTime() - new Date(b.targetAt).getTime(); });
  return {ok:true, items:items};
};

ACTIONS.createCountdown = function(body){
  var admin = requireAdmin_(body);
  var title = normalizedText_(body.title, "หัวข้อเคาท์ดาวน์", 120);
  var targetAt = requiredFutureTime_(body.targetAt, "วันเวลาเป้าหมาย");
  var now = nowIso_();
  var id = newId_();
  sheet_("COUNTDOWNS").appendRow([id, title, targetAt, now, admin.obj.username, now]);
  return {ok:true, countdown:{id:id, title:title, targetAt:targetAt, createdAt:now, updatedAt:now}};
};

ACTIONS.updateCountdown = function(body){
  requireAdmin_(body);
  var id = String(body.id || "");
  var found = findRow_("COUNTDOWNS", function(item){ return String(item.id)===id; });
  if(!found) throw new Error("ไม่พบเคาท์ดาวน์นี้");
  var title = normalizedText_(body.title, "หัวข้อเคาท์ดาวน์", 120);
  var targetAt = requiredFutureTime_(body.targetAt, "วันเวลาเป้าหมาย");
  var updatedAt = nowIso_();
  writeCell_(found.sheet, found.row, found.head, "title", title);
  writeCell_(found.sheet, found.row, found.head, "targetAt", targetAt);
  writeCell_(found.sheet, found.row, found.head, "updatedAt", updatedAt);
  return {ok:true, countdown:{id:id, title:title, targetAt:targetAt, createdAt:timeIso_(found.obj.createdAt), updatedAt:updatedAt}};
};

ACTIONS.deleteCountdown = function(body){
  requireAdmin_(body);
  var id = String(body.id || "");
  var found = findRow_("COUNTDOWNS", function(item){ return String(item.id)===id; });
  if(!found) throw new Error("ไม่พบเคาท์ดาวน์นี้");
  found.sheet.deleteRow(found.row);
  return {ok:true};
};

/* ── entrypoints ── */
function doPost(e){
  var out;
  try{
    var body = JSON.parse(e.postData.contents);
    var fn = ACTIONS[body.action];
    if(!fn) throw new Error("ไม่รู้จักคำสั่ง: "+body.action);
    out = fn(body);
  }catch(err){
    out = { ok:false, error:String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
function doGet(e){
  ensureSeed_();
  return ContentService.createTextOutput(JSON.stringify({ok:true, msg:"ระบบหลังบ้านพร้อมใช้งาน"})).setMimeType(ContentService.MimeType.JSON);
}
