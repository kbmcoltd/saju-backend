// 행운사주로또 서비스워커 - PWA 설치 및 기본 오프라인 지원용
//
// 업데이트 방식:
// - 화면(HTML) 요청은 "네트워크 우선": 인터넷이 되면 항상 서버의 최신 화면을 받고,
//   오프라인일 때만 저장해 둔 화면을 보여준다. (예전에는 저장본을 먼저 보여줘서
//   앱을 삭제 후 재설치해야 업데이트가 보이는 문제가 있었음)
// - 아이콘 등 나머지 파일은 저장본을 먼저 쓰고 뒤에서 최신본으로 갱신한다.
// - 화면에 큰 변화가 있으면 CACHE_NAME 버전을 올려 오래된 저장본을 한 번에 비운다.
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
  // 새 서비스워커가 설치되면 기다리지 않고 바로 교체
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isHtmlRequest(request, url) {
  if (request.mode === 'navigate') return true;
  if (url.pathname === '/' || url.pathname.endsWith('.html')) return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('text/html');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // API 요청(손금/관상 분석 등)은 항상 네트워크로 - 절대 캐시하지 않음
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // 다른 출처나 GET이 아닌 요청은 서비스워커가 관여하지 않음
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // 1) 화면(HTML): 네트워크 우선, 실패(오프라인) 시에만 저장본
  if (isHtmlRequest(request, url)) {
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match('/index.html'))
        )
    );
    return;
  }

  // 2) 나머지 파일: 저장본 먼저, 뒤에서 최신본으로 갱신
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
