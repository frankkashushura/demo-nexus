/* NEXUS – background notifications for browsers and the Windows app (Firebase Cloud Messaging).
   Firebase shows the notification; tapping it opens NEXUS on the right page. */
self.window = self;   // config.js sets window.NEXUS_CONFIG
importScripts('https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js', 'https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js', 'config.js?v=' + (new URL(location.href).searchParams.get('v') || '1'));
if (self.NEXUS_CONFIG && self.NEXUS_CONFIG.firebase && self.NEXUS_CONFIG.firebase.apiKey) {
  firebase.initializeApp(self.NEXUS_CONFIG.firebase);
  firebase.messaging();
}
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
