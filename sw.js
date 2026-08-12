/* service worker — แคชเปลือกแอป (ออฟไลน์) + รับ push notification ตอนแอปปิด/อยู่เบื้องหลัง
   บัมพ์เลข CACHE_NAME ทุกครั้งที่แก้ไฟล์หลัก เพื่อบังคับให้เครื่องนักเรียนโหลดของใหม่ */
var CACHE_NAME = "room-app-v5";
var SHELL = [ "./", "./index.html", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-152.png" ];

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

/* ── Firebase Cloud Messaging: รับ push ตอนแอปปิด/อยู่เบื้องหลัง ──
   ⚠️ ต้องแก้ FIREBASE_CONFIG ด้านล่างให้ตรงกับค่าเดียวกันที่ใส่ไว้ใน index.html
   ถ้ายังไม่ได้ตั้งค่า (ยังเป็น PASTE_...) จะข้ามส่วนนี้ไปเงียบๆ แอปยังใช้งานได้ปกติ */
var FIREBASE_CONFIG = {
  apiKey: "AIzaSyD3p6v9ke3QQpR1J3lhV5N6-OVwFgBuWPo",
  authDomain: "wt-85a44.firebaseapp.com",
  projectId: "wt-85a44",
  storageBucket: "wt-85a44.firebasestorage.app",
  messagingSenderId: "1000764979202",
  appId: "1:1000764979202:web:c21f421e7e435f8be70f1b"
};

if(FIREBASE_CONFIG.apiKey.indexOf("PASTE_")!==0){
  try{
    importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js");
    importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js");
    firebase.initializeApp(FIREBASE_CONFIG);
    var messaging = firebase.messaging();
    messaging.onBackgroundMessage(function(payload){
      var title = (payload.notification && payload.notification.title) || "ห้องเรียนของเรา";
      var body = (payload.notification && payload.notification.body) || "";
      self.registration.showNotification(title, {
        body: body, icon: "icons/icon-192.png", badge: "icons/icon-192.png"
      });
    });
  }catch(e){}
}

self.addEventListener("notificationclick", function(e){
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type:"window", includeUncontrolled:true }).then(function(list){
      for(var i=0;i<list.length;i++){ if("focus" in list[i]) return list[i].focus(); }
      if(clients.openWindow) return clients.openWindow("./");
    })
  );
});
