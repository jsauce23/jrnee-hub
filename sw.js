/* JRNEE Hub service worker — notifications only, no offline caching.
   The push arrives with no payload on purpose (see notify.js), so this
   fetches the lead itself and builds the notification from real data. */

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

async function newestLead() {
  try {
    const r = await fetch('/api/leads', { credentials: 'same-origin' });
    if (!r.ok) return null;
    const d = await r.json();
    return (d.leads || []).find(l => l.status !== 'done') || null;
  } catch (e) { return null; }
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    const lead = await newestLead();
    // Falls back to a plain nudge if the session has expired — better to say
    // "something came in" than to stay silent.
    const title = lead ? `New lead — ${lead.name || 'someone'}` : 'New JRNEE lead';
    const bits = lead
      ? [lead.company, lead.topic || (lead.details || '').slice(0, 70), lead.phone || lead.email]
          .filter(Boolean)
      : ['Open the hub to see it'];
    await self.registration.showNotification(title, {
      body: bits.join('\n'),
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: lead ? 'lead-' + lead.id : 'lead',   // one lead, one notification
      renotify: true,
      requireInteraction: true,                  // stays until it's dealt with
      data: { url: '/#/leads' }
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/#/leads';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(self.location.origin)) { await c.focus(); return c.navigate(url).catch(() => {}); }
    }
    return self.clients.openWindow(url);
  })());
});
