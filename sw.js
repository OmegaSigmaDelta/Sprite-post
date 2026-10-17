// Служебный скрипт. Нужен, чтобы на телефоне показывались уведомления
// и чтобы по нажатию на уведомление открывалась страница.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of all) {
      if ("focus" in client) { await client.focus(); return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow("./");
  })());
});
