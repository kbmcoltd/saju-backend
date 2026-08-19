# 사주행운 앱 백엔드

손금/관상 AI 분석과 오늘의 사주 운세 기능이 동작하려면, Anthropic API 키를 안전하게
보관하는 서버가 필요합니다. 이 저장소가 그 서버이며, 프론트엔드(`public/index.html`)도
함께 서빙합니다. 회원 정보(이름·전화번호·비밀번호 해시)는 Postgres 데이터베이스에
저장됩니다.

```
saju-backend/
├─ server.js           # Express 서버 (인증 + API + 정적 파일 서빙)
├─ package.json
├─ render.yaml          # Render Blueprint (웹서비스 + Postgres DB 자동 생성)
├─ .env.example          # 환경변수 예시 (실제 값은 .env에 넣으세요)
└─ public/
   ├─ index.html          # 프론트엔드 (사주행운 앱)
   ├─ manifest.json, sw.js # PWA 설정
   ├─ privacy.html         # 개인정보처리방침
   ├─ delete-account.html  # 계정 삭제 요청 안내 (구글플레이 정책 대응)
   └─ .well-known/assetlinks.json # 안드로이드 TWA 앱과의 디지털 자산 링크
```

## 1. 준비물

- Anthropic API 키 (https://console.anthropic.com → API Keys → Create Key)
- Postgres 데이터베이스 (Render Blueprint를 쓰면 자동 생성됨)

## 2. 로컬에서 실행해보기

Node.js 18 이상과 접속 가능한 Postgres가 필요합니다.

```bash
npm install
cp .env.example .env
# .env 파일을 열어 ANTHROPIC_API_KEY, SESSION_SECRET, DATABASE_URL을 채워주세요

npm start
```

브라우저에서 `http://localhost:3000` 접속 → 회원가입부터 사주, 손금, 관상, 오늘의 운세까지
전부 테스트할 수 있습니다.

## 3. Render에 배포하기 (Blueprint 사용, 무료 플랜 가능)

이 저장소의 `render.yaml`을 사용하면 웹서비스와 Postgres DB가 한 번에 생성되고
`DATABASE_URL`이 자동으로 연결됩니다.

1. Render 대시보드 → **New +** → **Blueprint** → 이 GitHub 저장소 선택
2. `ANTHROPIC_API_KEY`만 대시보드에서 직접 입력 (`SESSION_SECRET`은 자동 생성됨)
3. **Apply** → 몇 분 뒤 배포 완료

기존에 이미 Render 웹서비스가 연결되어 있다면(Blueprint 없이), 해당 서비스의
**Environment** 탭에서 Postgres를 하나 추가로 연결하고 `DATABASE_URL`,
`ANTHROPIC_API_KEY`, `SESSION_SECRET`을 직접 설정해도 됩니다.

> ⚠️ 이미 서명된 안드로이드 앱(TWA)이 특정 도메인(예: `saju-lucky777.onrender.com`)을
> 바라보고 있다면, 서비스 이름/도메인을 반드시 그대로 유지해야 `.well-known/assetlinks.json`의
> 디지털 자산 링크 검증이 계속 통과합니다.

## 4. 데이터 저장 관련 참고

- **계정 정보(이름·전화번호·비밀번호 해시)**: 서버의 Postgres 데이터베이스에 저장됩니다.
  비밀번호는 bcrypt로 해싱되어 저장되며 원문은 어디에도 저장되지 않습니다.
- **생년월일시·사주팔자·행운번호 계산 결과**: 사용자 브라우저의 localStorage에만
  저장되고 서버에는 저장되지 않습니다.
- **손금·관상 사진**: 서버에 저장되지 않습니다. AI 분석을 위해 일시적으로 전송된 후
  즉시 폐기됩니다.
- 로그인한 사용자는 앱 홈 화면의 '회원 탈퇴'에서 비밀번호 확인 후 즉시 계정을
  삭제할 수 있습니다 (`/delete-account.html`에도 안내되어 있습니다).

## 5. 보안/비용 관련 참고

- API 키는 서버 환경변수에만 있고 브라우저로는 절대 전달되지 않습니다.
- 비밀번호는 bcrypt 해시로만 저장되고, 세션은 httpOnly 쿠키(서명된 JWT)로 관리됩니다.
- 로그인·가입·비밀번호 재설정 요청에는 rate limit이 걸려 있습니다.
- 이미지 분석·운세 생성 API는 로그인한 사용자만 호출할 수 있습니다.
- 이미지 분석 1회당 Anthropic API 사용료가 발생합니다. Anthropic 콘솔에서 사용량
  한도(budget alert)를 설정해두는 것을 추천합니다.
- 비밀번호 재설정은 현재 이름+전화번호 확인만으로 진행됩니다 (내부테스트 단계에
  적합한 수준). 정식/공개 출시 전에는 SMS OTP 등 실제 본인확인으로 교체를 권장합니다.
