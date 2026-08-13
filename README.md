# 사주행운 앱 백엔드

손금/관상 AI 분석 기능이 실제로 동작하려면, Anthropic API 키를 안전하게 보관하는
서버가 필요합니다. 이 폴더가 그 서버이며, 프론트엔드(`public/index.html`)도 함께 서빙합니다.

```
saju-backend/
├─ server.js         # Express 서버 (API + 정적 파일 서빙)
├─ package.json
├─ .env.example       # 환경변수 예시 (실제 키는 .env에 넣으세요)
└─ public/
   └─ index.html       # 프론트엔드 (사주행운 앱)
```

## 1. Anthropic API 키 발급

1. https://console.anthropic.com 에 가입 후 로그인
2. 좌측 메뉴에서 **API Keys** 이동 → **Create Key**
3. 발급된 키(`sk-ant-...`)를 복사해 둡니다. (한 번만 보여주니 안전한 곳에 저장하세요)
4. 결제 수단 등록이 필요할 수 있습니다 (사용량만큼 과금되는 종량제입니다)

## 2. 로컬에서 실행해보기

Node.js 18 이상이 필요합니다.

```bash
cd saju-backend
npm install
cp .env.example .env
# .env 파일을 열어 ANTHROPIC_API_KEY 값을 방금 발급받은 키로 교체

npm start
```

브라우저에서 `http://localhost:3000` 접속 → 정상적으로 앱이 뜨고, 손금/관상 분석까지
바로 테스트할 수 있습니다.

## 3. 인터넷에 배포하기 (Render 기준, 무료 플랜 가능)

Render는 Git 저장소만 연결하면 자동으로 빌드·배포해주는 서비스라 가장 간단합니다.

1. 이 `saju-backend` 폴더를 GitHub 저장소로 올립니다 (`.env`는 `.gitignore`에 이미 포함되어 있어 올라가지 않습니다)
2. https://render.com 가입 → **New** → **Web Service** → 방금 만든 GitHub 저장소 선택
3. 설정값
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. **Environment** 탭에서 환경변수 추가
   - `ANTHROPIC_API_KEY` = 발급받은 키
5. **Deploy** 클릭 → 몇 분 뒤 `https://your-app-name.onrender.com` 같은 주소가 생성됩니다
6. 그 주소로 접속하면 완성된 앱이 그대로 동작합니다 (회원가입, 사주, 손금, 관상 전부 포함)

> Render, Railway, Fly.io 등 Node.js 웹 서비스를 지원하는 곳이면 어디든 같은 방식으로
> 배포할 수 있습니다. Vercel처럼 서버리스 전용 플랫폼을 쓰려면 `server.js`의 라우트를
> 서버리스 함수 형태로 약간 변형해야 합니다 (원하시면 그 버전도 만들어 드릴 수 있어요).

## 4. 데이터 저장 관련 참고

- 회원가입/로그인 정보와 사주 결과는 여전히 **각 사용자 브라우저의 localStorage**에 저장됩니다.
  즉, 여러 사람이 같은 서버에 접속해도 서로의 회원 정보를 공유하지 않지만, 반대로 관리자가
  전체 회원 목록을 볼 수도 없습니다.
- 정식 서비스로 키우고 싶다면(회원 DB, 관리자 페이지, 여러 기기 로그인 동기화 등) 별도의
  데이터베이스(PostgreSQL, MongoDB 등) 연동이 필요합니다. 이 부분도 필요하시면 도와드릴게요.

## 5. 보안/비용 관련 참고

- API 키는 서버 환경변수에만 있고 브라우저로는 절대 전달되지 않습니다.
- `server.js`에 간단한 요청 제한(IP당 시간당 20회)을 넣어 뒀지만, 트래픽이 많아질 경우
  더 견고한 방식(Redis 기반 rate limit, 로그인 필요 시에만 분석 허용 등)으로 교체하는 것을
  권장합니다.
- 이미지 분석 1회당 Anthropic API 사용료가 발생합니다. 예상보다 비용이 많이 나오지 않도록
  Anthropic 콘솔에서 사용량 한도(budget alert)를 설정해두는 것을 추천합니다.
