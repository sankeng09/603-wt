/* service worker อย่างง่าย — แคชเปลือกแอป (HTML/CSS/JS) ให้เปิดได้แม้เน็ตหลุดชั่วคราว
   ไม่แคช API ของ Google Apps Script (ต้องออนไลน์เพื่อดู/สร้างข้อมูลเสมอ)
   บัมพ์เลข CACHE_NAME ทุกครั้งที่แก้ไฟล์หลัก เพื่อบังคับให้เครื่องนักเรียนโหลดของใหม่ */
var CACHE_NAME = "room-app-v1";
var SHELL = [ "./", "./index.html", "./manifest.webmanifest" ];

self.addEventListener("install", function(e){
  e.waitUntil(caches.open(CACHE_NAME).then(function(c){ return c.addAll(SHELL); }));
});
self.addEventListener("activate", function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k!==CACHE_NAME; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});
self.addEventListener("message", function(e){
  if(e.data==="skip-waiting") self.skipWaiting();
});
self.addEventListener("fetch", function(e){
  var url = e.request.url;
  if(url.indexOf("script.google.com")>=0) return;   // ไม่แคช API — ต้องได้ข้อมูลสดเสมอ
  if(e.request.method!=="GET") return;
  e.respondWith(
    caches.match(e.request).then(function(cached){
      var fetchPromise = fetch(e.request).then(function(res){
        if(res && res.ok){
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function(c){ c.put(e.request, copy); });
        }
        return res;
      }).catch(function(){ return cached; });
      return cached || fetchPromise;
    })
  );
});
