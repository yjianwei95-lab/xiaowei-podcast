// 小伟播客 PWA Service Worker
// 版本号 - 每次更新内容时递增
const CACHE_NAME = 'xiaowei-podcast-v1.0.0';
const urlsToCache = [
  '/',
  '/css/style.css',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json'
];

// 安装事件 - 缓存核心资源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('SW: 缓存核心资源');
        return cache.addAll(urlsToCache);
      })
      .then(() => self.skipWaiting())
  );
});

// 激活事件 - 清理旧缓存
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames.map(cacheName => {
            if (cacheName !== CACHE_NAME) {
              console.log('SW: 删除旧缓存', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => self.clients.claim())
  );
});

// 请求拦截 - 缓存优先策略
self.addEventListener('fetch', event => {
  // 跳过非GET请求和非HTTP请求
  if (event.request.method !== 'GET' || !event.request.url.startsWith('http')) {
    return;
  }

  // API请求 - 网络优先
  if (event.request.url.includes('/api/') || event.request.url.includes('/upload')) {
    event.respondWith(
      fetch(event.request)
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // 静态资源 - 缓存优先
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          // 返回缓存，同时在后台更新缓存
          fetchAndCache(event.request);
          return response;
        }
        // 无缓存，从网络获取
        return fetchAndCache(event.request);
      })
      .catch(() => {
        // 离线且无可缓存响应
        if (event.request.headers.get('accept')?.includes('text/html')) {
          return caches.match('/');
        }
      })
  );
});

// 辅助函数：获取并更新缓存
function fetchAndCache(request) {
  return fetch(request).then(response => {
    if (response && response.status === 200 && response.type === 'basic') {
      const responseClone = response.clone();
      caches.open(CACHE_NAME).then(cache => {
        cache.put(request, responseClone);
      });
    }
    return response;
  });
}

// 推送事件 - 显示通知
self.addEventListener('push', event => {
  const options = {
    body: event.data?.text() || '小伟播客有新内容啦！',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    data: { url: '/' }
  };
  
  event.waitUntil(
    self.registration.showNotification('小伟播客', options)
  );
});

// 通知点击事件
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' })
      .then(clientList => {
        const url = event.notification.data?.url || '/';
        for (const client of clientList) {
          if (client.url === url && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(url);
        }
      })
  );
});
