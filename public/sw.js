// 사주행운 서비스워커 - PWA 설치 및 기본 오프라인 지원용
// v3: 캐시 우선 -> 네트워크 우선으로 전략 변경 (배포 시 최신 코드가 바로 반영되도록).
// 앱 코드를 수정할 때마다 CACHE_NAME 값을 올려주세요. 그래야 예전 캐시가 확실히 폐기됩니다.
const CACHE_NAME = 'saju-lucky-v3';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API 요청(손금/관상 분석, 오늘의 운세 등)은 항상 네트워크로 - 절대 캐시하지 않음
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 같은 출처(GET 요청)는 네트워크 우선: 온라인일 때는 항상 최신 버전을 받아오고
  // 성공한 응답은 캐시에 갱신해 둔다. 네트워크 실패(오프라인) 시에만 캐시로 폴백한다.
  if (event.request.method === 'GET' && url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
