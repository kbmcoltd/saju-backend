require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');

const SESSION_SECRET = process.env.SESSION_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

if (!SESSION_SECRET || SESSION_SECRET === 'change-me-to-a-long-random-value') {
  console.error('SESSION_SECRET이 설정되지 않았습니다. .env 파일을 만들고 .env.example을 참고해 값을 채워주세요.');
  process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY가 설정되지 않았습니다. .env 파일에 Claude API 키를 넣어주세요.');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('DATABASE_URL이 설정되지 않았습니다. Postgres 연결 문자열을 .env에 넣어주세요 (예: Render Postgres의 Internal/External Database URL).');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

/* ---------------- Postgres-backed user store ----------------
 * Render's web service filesystem is ephemeral (wiped on every deploy/restart),
 * so accounts live in Postgres instead of a local file - see render.yaml, which
 * provisions a free Postgres database and wires DATABASE_URL automatically. */
const pool = new Pool({
  connectionString: DATABASE_URL,
  // Render's managed Postgres uses a certificate that Node's default trust store
  // doesn't recognize; a plain localhost dev database has no TLS at all.
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      phone TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);
}

async function getUser(phone) {
  const { rows } = await pool.query(
    'SELECT phone, name, password_hash AS "passwordHash", created_at AS "createdAt" FROM users WHERE phone = $1',
    [phone]
  );
  return rows[0] || null;
}
async function upsertUser(user) {
  await pool.query(
    `INSERT INTO users (phone, name, password_hash, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash`,
    [user.phone, user.name, user.passwordHash, user.createdAt || Date.now()]
  );
}
async function deleteUser(phone) {
  await pool.query('DELETE FROM users WHERE phone = $1', [phone]);
}

/* ---------------- validation (mirrors client-side rules) ---------------- */
function normalizePhone(v) {
  return String(v || '').replace(/[^0-9]/g, '');
}
function isValidPhone(v) {
  const d = normalizePhone(v);
  return d.length === 10 || d.length === 11;
}
function isValidPassword(v) {
  const s = String(v || '');
  return /[A-Za-z]/.test(s) && /[0-9]/.test(s) && /[^A-Za-z0-9]/.test(s) && s.length >= 8;
}

/* ---------------- localized error messages (mirrors client TRANSLATIONS keys) ---------------- */
const ERR = {
  nameRequired: { ko: '이름을 입력해 주세요.', en: 'Please enter your name.' },
  phoneInvalid: { ko: '전화번호를 정확히 입력해 주세요.', en: 'Please enter a valid phone number.' },
  passwordInvalid: { ko: '비밀번호는 영문, 숫자, 특수문자를 포함해 8자 이상이어야 합니다.', en: 'Password must include letters, numbers, and symbols, at least 8 characters.' },
  phoneAlreadyUsed: { ko: '이미 가입된 전화번호입니다. 로그인해 주세요.', en: 'This phone number is already registered. Please log in.' },
  loginFailed: { ko: '전화번호 또는 비밀번호가 올바르지 않습니다.', en: 'Incorrect phone number or password.' },
  resetNotFound: { ko: '일치하는 회원 정보를 찾을 수 없습니다. 이름과 전화번호를 다시 확인해 주세요.', en: 'No matching account found. Please check your name and phone number again.' },
  resetTokenMissing: { ko: '본인 확인을 먼저 진행해 주세요.', en: 'Please verify your identity first.' },
  resetTokenExpired: { ko: '본인 확인이 만료되었습니다. 다시 시도해 주세요.', en: 'Identity verification expired. Please try again.' },
  resetUserNotFound: { ko: '회원 정보를 찾을 수 없습니다.', en: 'Account not found.' },
  tooManyRequests: { ko: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', en: 'Too many requests. Please try again later.' },
  needLogin: { ko: '로그인이 필요합니다.', en: 'Please log in.' },
  accountNotFound: { ko: '계정을 찾을 수 없습니다.', en: 'Account not found.' },
  sessionExpired: { ko: '세션이 만료되었습니다. 다시 로그인해 주세요.', en: 'Your session has expired. Please log in again.' },
  invalidRequest: { ko: '유효하지 않은 요청입니다.', en: 'Invalid request.' },
  unsupportedAnalyzeType: { ko: '지원하지 않는 분석 유형입니다.', en: 'Unsupported analysis type.' },
  noPhotoData: { ko: '사진 데이터가 없습니다.', en: 'No photo data was provided.' },
  unsupportedImageType: { ko: '지원하지 않는 이미지 형식입니다.', en: 'Unsupported image format.' },
  imageTooLarge: { ko: '이미지 용량이 너무 큽니다. 더 작은 사진으로 다시 시도해 주세요.', en: 'The image is too large. Please try a smaller photo.' },
  noAiResult: { ko: 'AI로부터 결과를 받지 못했습니다.', en: 'No result received from the AI.' },
  analyzeFailed: { ko: 'AI 분석 중 오류가 발생했습니다.', en: 'An error occurred during AI analysis.' },
  invalidSajuData: { ko: '사주 정보가 올바르지 않습니다.', en: 'Invalid Saju data.' },
  fortuneFailed: { ko: 'AI 운세 생성 중 오류가 발생했습니다.', en: 'An error occurred while generating the AI fortune.' },
  passwordRequired: { ko: '비밀번호를 입력해 주세요.', en: 'Please enter your password.' },
  accountDeleted: { ko: '계정이 삭제되었습니다.', en: 'Your account has been deleted.' },
};
function errMsg(key, lang) {
  const entry = ERR[key];
  if (!entry) return key;
  return entry[lang === 'en' ? 'en' : 'ko'];
}

/* ---------------- sessions & reset tokens (JWT) ---------------- */
const SESSION_COOKIE = 'sajuapp_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function issueSessionCookie(req, res, phone) {
  const token = jwt.sign({ phone }, SESSION_SECRET, { expiresIn: '30d' });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Render (and most PaaS hosts) terminate TLS at the edge and proxy plain HTTP
    // to the app, so NODE_ENV alone can't tell us the original request was HTTPS.
    // `trust proxy` + req.secure reads X-Forwarded-Proto instead.
    secure: req.secure,
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  });
}

async function requireAuth(req, res, next) {
  const lang = (req.query && req.query.lang) || (req.body && req.body.lang);
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: errMsg('needLogin', lang) });
  try {
    const payload = jwt.verify(token, SESSION_SECRET);
    const user = await getUser(payload.phone);
    if (!user) return res.status(401).json({ error: errMsg('accountNotFound', lang) });
    req.user = user;
    next();
  } catch (e) {
    if (e instanceof jwt.JsonWebTokenError || e instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: errMsg('sessionExpired', lang) });
    }
    console.error('requireAuth 오류:', e);
    return res.status(500).json({ error: errMsg('invalidRequest', lang) });
  }
}

/* ---------------- app ---------------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '12mb' })); // headroom above the client-side resized image size
app.use(cookieParser());
// Only ./public is served over HTTP - serving __dirname directly would publish
// server.js, package.json/-lock.json, and .env alongside the app.
const PUBLIC_DIR = path.join(__dirname, 'public');
// express.static ignores dotfiles by default (so a stray request can't read .env
// off the same directory) - the Digital Asset Links file needs to be reachable
// despite that, so it gets its own narrowly-scoped static mount instead of a
// blanket `dotfiles: 'allow'` on the whole public dir.
app.use('/.well-known', express.static(path.join(PUBLIC_DIR, '.well-known'), { dotfiles: 'allow' }));
app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  // The app screen, service worker and manifest must never be served from the phone's
  // HTTP cache, otherwise an installed app keeps showing the old version after a deploy
  // (users had to uninstall/reinstall to see updates). "no-cache" still allows a cheap
  // 304 revalidation, so this costs almost nothing.
  setHeaders: (res, filePath) => {
    const name = path.basename(filePath);
    if (name.endsWith('.html') || name === 'sw.js' || name === 'manifest.json') {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: errMsg('tooManyRequests', req.body && req.body.lang) }),
});
// Identity verification by name+phone is inherently guessable, so the reset-verify
// endpoint gets a tighter limit than ordinary login/signup traffic.
const resetVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: errMsg('tooManyRequests', req.body && req.body.lang) }),
});

/* ---------------- auth routes ---------------- */
app.post('/api/auth/signup', authLimiter, async (req, res) => {
  try {
    const { name, phone: phoneRaw, password, lang } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: errMsg('nameRequired', lang) });
    if (!isValidPhone(phoneRaw)) return res.status(400).json({ error: errMsg('phoneInvalid', lang) });
    if (!isValidPassword(password)) return res.status(400).json({ error: errMsg('passwordInvalid', lang) });

    const phone = normalizePhone(phoneRaw);
    if (await getUser(phone)) return res.status(409).json({ error: errMsg('phoneAlreadyUsed', lang) });

    const passwordHash = bcrypt.hashSync(password, 10);
    await upsertUser({ name: String(name).trim(), phone, passwordHash, createdAt: Date.now() });
    issueSessionCookie(req, res, phone);
    res.json({ name: String(name).trim(), phone });
  } catch (e) {
    console.error('/api/auth/signup 오류:', e);
    res.status(500).json({ error: errMsg('invalidRequest', req.body && req.body.lang) });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { phone: phoneRaw, password, lang } = req.body || {};
    if (!isValidPhone(phoneRaw)) return res.status(400).json({ error: errMsg('phoneInvalid', lang) });
    const phone = normalizePhone(phoneRaw);
    const user = await getUser(phone);
    if (!user || !bcrypt.compareSync(String(password || ''), user.passwordHash)) {
      return res.status(401).json({ error: errMsg('loginFailed', lang) });
    }
    issueSessionCookie(req, res, phone);
    res.json({ name: user.name, phone: user.phone });
  } catch (e) {
    console.error('/api/auth/login 오류:', e);
    res.status(500).json({ error: errMsg('invalidRequest', req.body && req.body.lang) });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ name: req.user.name, phone: req.user.phone });
});

// Identity check only proves the caller knows the account's name + phone number.
// That is inherently guessable, so this endpoint is rate-limited and only ever
// issues a short-lived, single-purpose token instead of logging the caller in.
// Before a public (non-internal-testing) launch this should be replaced with a
// real possession proof, e.g. an SMS OTP sent to the phone number.
app.post('/api/auth/reset/verify', resetVerifyLimiter, async (req, res) => {
  try {
    const { name, phone: phoneRaw, lang } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: errMsg('nameRequired', lang) });
    if (!isValidPhone(phoneRaw)) return res.status(400).json({ error: errMsg('phoneInvalid', lang) });

    const phone = normalizePhone(phoneRaw);
    const user = await getUser(phone);
    if (!user || user.name !== String(name).trim()) {
      return res.status(404).json({ error: errMsg('resetNotFound', lang) });
    }

    const resetToken = jwt.sign({ phone, purpose: 'reset' }, SESSION_SECRET, { expiresIn: '5m' });
    res.json({ resetToken });
  } catch (e) {
    console.error('/api/auth/reset/verify 오류:', e);
    res.status(500).json({ error: errMsg('invalidRequest', req.body && req.body.lang) });
  }
});

app.post('/api/auth/reset/save', authLimiter, async (req, res) => {
  try {
    const { resetToken, password, lang } = req.body || {};
    if (!resetToken) return res.status(400).json({ error: errMsg('resetTokenMissing', lang) });
    if (!isValidPassword(password)) return res.status(400).json({ error: errMsg('passwordInvalid', lang) });

    let payload;
    try {
      payload = jwt.verify(resetToken, SESSION_SECRET);
    } catch (e) {
      return res.status(401).json({ error: errMsg('resetTokenExpired', lang) });
    }
    if (payload.purpose !== 'reset') return res.status(401).json({ error: errMsg('invalidRequest', lang) });

    const user = await getUser(payload.phone);
    if (!user) return res.status(404).json({ error: errMsg('resetUserNotFound', lang) });

    user.passwordHash = bcrypt.hashSync(password, 10);
    await upsertUser(user);
    res.json({ ok: true });
  } catch (e) {
    console.error('/api/auth/reset/save 오류:', e);
    res.status(500).json({ error: errMsg('invalidRequest', req.body && req.body.lang) });
  }
});

// Self-service account deletion (Google Play's account deletion policy expects an
// in-app path when the app supports in-app account creation, in addition to the
// public web page at /delete-account.html). Requires an active session AND the
// current password, since this is irreversible.
app.post('/api/auth/account/delete', authLimiter, requireAuth, async (req, res) => {
  try {
    const { password, lang } = req.body || {};
    if (!password) return res.status(400).json({ error: errMsg('passwordRequired', lang) });
    if (!bcrypt.compareSync(String(password), req.user.passwordHash)) {
      return res.status(401).json({ error: errMsg('loginFailed', lang) });
    }
    await deleteUser(req.user.phone);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  } catch (e) {
    console.error('/api/auth/account/delete 오류:', e);
    res.status(500).json({ error: errMsg('invalidRequest', req.body && req.body.lang) });
  }
});

/* ---------------- Claude API: palm / face photo reading ---------------- */
const READING_PROMPTS = {
  palm: {
    ko: "당신은 전통 손금(수상학) 풀이 스타일을 재미로 재구성하는 콘텐츠 작가입니다. 제공된 손바닥 사진을 보고, 전통 수상학의 기준에 따라 각 선과 언덕의 특징을 관찰한 것처럼 구체적으로 묘사하세요.\n\n[수상학 기준]\n- 생명선(엄지와 검지 사이에서 손목 쪽으로 휘는 선): 체력, 활력, 생활 리듬. 짙고 길면 기초 체력이 강함, 끊어짐·갈라짐은 큰 환경 변화의 시기.\n- 두뇌선(손바닥 가운데를 가로지르는 선): 사고방식, 판단력, 적성. 곧으면 이성적·현실적, 아래로 휘면 감성적·창의적.\n- 감정선(손가락 아래 손바닥 위쪽을 가로지르는 선): 애정관, 감정 표현, 대인관계. 검지 쪽으로 길게 올라가면 솔직·열정적, 짧고 곧으면 신중함.\n- 결혼선(새끼손가락 아래 옆면의 짧은 가로선): 인연의 시기와 결혼 생활의 특징. 감정선에 가까우면 이른 인연, 새끼손가락 쪽이면 늦은 인연.\n- 재물선(새끼손가락 아래로 향하는 선)과 태양선(약지 아래 세로선): 돈 버는 수완, 재물 관리, 결실과 명예.\n- 운명선(손목에서 중지 쪽으로 올라가는 세로선): 직업운, 목표 의식, 사회적 성공. 곧고 뚜렷하면 자수성가형, 중간에서 시작하면 대기만성형.\n- 손 모양·손가락 길이·언덕(금성구, 목성구 등)의 발달: 기본 성격과 추진력.\n\n아래 형식 그대로, 마크다운 기호(*, #, - 등) 없이 일반 텍스트로 작성하세요. 각 항목은 빈 줄로 구분하세요.\n\n🖐 손금 한눈에 보기\n(이 손금의 전체적인 특징과 기운을 2문장으로 요약)\n\n🧠 성격 (두뇌선·손 모양)\n(관찰한 선의 특징 1문장 + 그에 따른 성격·사고방식 풀이 2문장)\n⚠️ 주의: (성격상 조심할 점 1문장)\n🍀 개운 팁: (생활 속 실천 팁 1문장)\n\n💪 건강 (생명선)\n(관찰한 선의 특징 1문장 + 체력·활력·생활 리듬 풀이 2문장)\n⚠️ 주의: (무리하기 쉬운 습관이나 생활 패턴 1문장)\n🍀 개운 팁: (생활 습관 팁 1문장)\n\n💕 연애 (감정선)\n(관찰한 선의 특징 1문장 + 연애 스타일과 애정 표현 풀이 2문장)\n⚠️ 주의: (연애에서 조심할 점 1문장)\n🍀 개운 팁: (인연을 좋게 만드는 팁 1문장)\n\n💍 결혼 (결혼선)\n(관찰한 선의 특징 1문장 + 인연이 오는 시기와 결혼 생활의 특징 풀이 2문장)\n⚠️ 주의: (결혼 생활에서 조심할 점 1문장)\n🍀 개운 팁: (부부·가정운을 높이는 팁 1문장)\n\n💰 재물 (재물선·태양선)\n(관찰한 선의 특징 1문장 + 돈 버는 방식과 재물 흐름 풀이 2문장)\n⚠️ 주의: (돈 관리에서 조심할 점 1문장)\n🍀 개운 팁: (재물운을 지키는 팁 1문장)\n\n🏆 성공·직업 (운명선)\n(관찰한 선의 특징 1문장 + 직업 적성과 성공이 찾아오는 방식 풀이 2문장)\n⚠️ 주의: (일과 커리어에서 조심할 점 1문장)\n🍀 개운 팁: (성공운을 높이는 팁 1문장)\n\n📌 손금은 생활 습관과 마음가짐에 따라 몇 달 단위로도 변할 수 있어요. 지금의 노력이 앞으로의 손금을 만듭니다.\n\n좋은 말만 하지 말고 모든 항목에서 좋은 점과 주의할 점을 균형 있게 쓰세요. 주의할 점은 불안을 주는 단정이 아니라 미리 대비하라는 부드럽고 현실적인 조언 톤으로 쓰세요. 사진에서 선이 잘 보이지 않는 부분은 '선이 옅게 보이는 편'처럼 자연스럽게 표현하고 풀이는 이어가세요. 이 콘텐츠는 재미를 위한 것이며 의학적·과학적 진단이 아니라는 전제를 유지하세요. 건강 항목은 체력과 생활 습관 이야기로만 쓰고 특정 질병명을 언급하거나 진단처럼 말하지 마세요. 질병·사고·죽음·이혼·이별을 단정적으로 예언하지 마세요. 한국어로 작성하세요.",
    en: "You are a content writer who reimagines traditional palmistry as light entertainment. Look at the photographed palm and describe the features of each line and mount as if observing them by the standards of traditional palmistry.\n\n[Palmistry guide]\n- Life line (curves from between the thumb and index finger toward the wrist): stamina, vitality, daily rhythm. Deep and long means strong natural stamina; breaks or forks mark periods of big life change.\n- Head line (runs across the middle of the palm): way of thinking, judgment, aptitude. Straight means rational and practical; sloping down means sensitive and creative.\n- Heart line (runs across the upper palm below the fingers): attitude to love, emotional expression, relationships. Long and rising toward the index finger means open and passionate; short and straight means careful.\n- Marriage line (short horizontal line on the side of the palm below the little finger): timing of meaningful partnerships and the character of married life. Close to the heart line means an early match; close to the little finger means a later one.\n- Money line (toward the little finger) and sun line (vertical line below the ring finger): money-making skill, managing wealth, rewards and reputation.\n- Fate line (vertical line from the wrist toward the middle finger): career, sense of purpose, success. Straight and clear means self-made; starting mid-palm means a late bloomer.\n- Hand shape, finger length and the mounts (Venus, Jupiter, etc.): basic temperament and drive.\n\nUse exactly the format below, as plain text with no markdown symbols (*, #, - etc.). Separate each section with a blank line.\n\n🖐 Your Palm at a Glance\n(2 sentences summarizing the overall character and energy of this palm)\n\n🧠 Personality (Head Line, Hand Shape)\n(1 sentence on the observed line features + 2 sentences on personality and way of thinking)\n⚠️ Watch out: (1 sentence on a personality trait to be careful with)\n🍀 Luck tip: (1 sentence of practical advice)\n\n💪 Health (Life Line)\n(1 sentence on the observed line features + 2 sentences on stamina, vitality and daily rhythm)\n⚠️ Watch out: (1 sentence on habits or patterns where you tend to overdo it)\n🍀 Luck tip: (1 sentence of lifestyle advice)\n\n💕 Love (Heart Line)\n(1 sentence on the observed line features + 2 sentences on love style and how you show affection)\n⚠️ Watch out: (1 sentence on something to be careful with in love)\n🍀 Luck tip: (1 sentence on nurturing good relationships)\n\n💍 Marriage (Marriage Line)\n(1 sentence on the observed line features + 2 sentences on when a partner is likely to appear and the character of married life)\n⚠️ Watch out: (1 sentence on something to be careful with in married life)\n🍀 Luck tip: (1 sentence on strengthening family harmony)\n\n💰 Wealth (Money Line, Sun Line)\n(1 sentence on the observed line features + 2 sentences on how you make money and how wealth flows)\n⚠️ Watch out: (1 sentence on something to be careful with in managing money)\n🍀 Luck tip: (1 sentence on protecting your wealth luck)\n\n🏆 Success & Career (Fate Line)\n(1 sentence on the observed line features + 2 sentences on career aptitude and how success tends to arrive)\n⚠️ Watch out: (1 sentence on something to be careful with at work)\n🍀 Luck tip: (1 sentence on boosting career luck)\n\n📌 Palm lines can change within months with your habits and mindset. What you do now shapes the palm you'll have later.\n\nDo not give only flattering remarks: balance good points and cautions in every section. Write the cautions as gentle, practical advice for preparing ahead, never as anxiety-inducing predictions. If a line is hard to see in the photo, describe it naturally (for example 'this line appears faint') and still give the reading. Always keep the framing that this is entertainment only, not a medical or scientific diagnosis. Keep the health section to stamina and lifestyle habits only; never name specific illnesses or speak as if giving a diagnosis. Never predict illness, accidents, death, divorce or breakups as certainties. Write in English.",
  },
  face: {
    ko: "당신은 전통 관상학 풀이 스타일을 재미로 재구성하는 콘텐츠 작가입니다. 제공된 얼굴 사진에서 느껴지는 인상(이마·눈·코·입·턱 등)의 전통적 특징을 관찰한 것처럼 묘사하세요. 좋은 말만 하지 말고, 반드시 좋은 점과 조심할 점을 균형 있게 함께 풀이해야 합니다. 아래 형식 그대로, 마크다운 기호(*, #, - 등) 없이 일반 텍스트로 작성하세요.\n\n✨ 좋은 점\n(전통 관상에서 좋게 보는 인상과 타고난 강점을 2~3문장)\n\n⚠️ 조심할 점\n(전통 관상에서 시사하는 성향·행동 습관 측면의 주의점과 대비 팁을 2~3문장)\n\n조심할 점은 얼굴 생김새에 대한 평가나 단점 지적이 아니라 성향과 생활 습관에 대한 부드러운 조언으로만 쓰세요(예: 성급함, 고집, 과로하기 쉬운 경향). 외모를 평가하거나 순위를 매기거나 비하하지 마세요. 이 콘텐츠는 재미를 위한 것이며 의학적 진단이 아니라는 전제를 유지하고, 질병이나 불행을 단정적으로 예언하지 마세요. 한국어로 작성하세요.",
    en: "You are a content writer who reimagines traditional East Asian face reading as light entertainment. Describe the impression conveyed by the photographed face (forehead, eyes, nose, mouth, chin, etc.) as if observing its traditional features. Do not give only flattering remarks: you must give a balanced reading with both good points and things to watch out for. Use exactly the format below, as plain text with no markdown symbols (*, #, - etc.).\n\n✨ Good Points\n(2-3 sentences on impressions traditionally seen as favorable and natural strengths)\n\n⚠️ Things to Watch Out For\n(2-3 sentences on tendencies and habits the tradition associates with this impression, with practical tips to prepare)\n\nWrite the cautions only as gentle advice about temperament and habits (for example haste, stubbornness, a tendency to overwork), never as criticism of how the face looks. Never rank, judge or disparage physical appearance. Always keep the framing that this is entertainment only, not a medical diagnosis, and never predict illness or misfortune as a certainty. Write in English.",
  },
};

app.post('/api/analyze', requireAuth, async (req, res) => {
  try {
    const { type, base64, mediaType, lang } = req.body || {};
    if (type !== 'palm' && type !== 'face') {
      return res.status(400).json({ error: errMsg('unsupportedAnalyzeType', lang) });
    }
    if (!base64 || typeof base64 !== 'string') {
      return res.status(400).json({ error: errMsg('noPhotoData', lang) });
    }
    if (!mediaType || !/^image\/(jpeg|png|webp|gif)$/i.test(mediaType)) {
      return res.status(400).json({ error: errMsg('unsupportedImageType', lang) });
    }
    // Rough decoded-size guard (base64 is ~4/3 the size of the raw bytes).
    if (base64.length > 9_000_000) {
      return res.status(413).json({ error: errMsg('imageTooLarge', lang) });
    }

    const language = lang === 'en' ? 'en' : 'ko';
    const promptText = READING_PROMPTS[type][language];

    const message = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      // palm now returns six categories (personality/health/love/marriage/wealth/success) plus a summary,
      // so it needs much more room than the two-section face reading.
      max_tokens: type === 'palm' ? 2500 : 1000,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: promptText },
          ],
        },
      ],
    });

    const resultText = (message.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (!resultText) return res.status(502).json({ error: errMsg('noAiResult', lang) });
    res.json({ result: resultText });
  } catch (e) {
    console.error('/api/analyze 오류:', e);
    res.status(502).json({ error: errMsg('analyzeFailed', req.body && req.body.lang) });
  }
});

/* ---------------- Claude API: saju-based fortune (today / this month / this year) ---------------- */
const FORTUNE_CATEGORIES = ['work', 'money', 'love', 'health'];

const STEM_SET = ['갑', '을', '병', '정', '무', '기', '경', '신', '임', '계'];
const BRANCH_SET = ['자', '축', '인', '묘', '진', '사', '오', '미', '신', '유', '술', '해'];
const ELEMENT_SET = ['목', '화', '토', '금', '수'];
const POS_SET = ['year', 'month', 'day', 'hour'];
const SIPSUNG_SET = ['비견', '겁재', '식신', '상관', '편재', '정재', '편관', '정관', '편인', '정인'];
const STRENGTH_SET = ['strong', 'weak', 'balanced'];
const RELATION_SET = ['clash', 'harmony', 'punish', 'stemHarmony', 'stemClash'];

const POS_TEXT = {
  year: 'year pillar (roots, ancestors, outer environment)',
  month: 'month pillar (career, social life)',
  day: 'day pillar (self, spouse, home)',
  hour: 'hour pillar (children, later life, subordinates)',
};
const STUDENT_POS_TEXT = {
  month: 'month pillar (school life, friends, studies)',
  day: 'day pillar (self, family, home)',
  hour: 'hour pillar (future, aspirations)',
};
const RELATION_TEXT = {
  clash: "the period's branch CLASHES (충) with the person's {pos} branch {target}",
  harmony: "the period's branch HARMONIZES (합) with the person's {pos} branch {target}",
  punish: "the period's branch forms a PUNISHMENT (형) with the person's {pos} branch {target}",
  stemHarmony: "the period's stem COMBINES (합) with the person's {pos} stem {target}",
  stemClash: "the period's stem CLASHES (충) with the person's {pos} stem {target}",
};
const STRENGTH_TEXT = {
  strong: 'strong (신강: the day master is well supported, tends toward stubbornness and excess)',
  weak: 'gentle (신약: the day master is thinly supported, tends to tire and lean on others)',
  balanced: 'balanced (중화)',
};

const DAY_FORTUNE_TOOL = {
  name: 'submit_fortune',
  description: "Submit today's four-category Saju fortune reading, each with a good point and a caution.",
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: FORTUNE_CATEGORIES },
            text: { type: 'string', description: 'The favorable reading for this category.' },
            caution: { type: 'string', description: 'What to watch out for in this category.' },
          },
          required: ['category', 'text', 'caution'],
        },
      },
    },
    required: ['items'],
  },
};

const PERIOD_FORTUNE_TOOL = {
  name: 'submit_period_fortune',
  description: 'Submit a monthly or yearly Saju reading with good points and cautions.',
  input_schema: {
    type: 'object',
    properties: {
      summaryGood: { type: 'string', description: 'Overall favorable flow, 1-2 sentences.' },
      summaryCaution: { type: 'string', description: 'Overall things to watch out for, 1-2 sentences.' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: FORTUNE_CATEGORIES },
            good: { type: 'string' },
            caution: { type: 'string' },
          },
          required: ['category', 'good', 'caution'],
        },
      },
    },
    required: ['summaryGood', 'summaryCaution', 'items'],
  },
};

const LIFE_STAGE_KEYS = ['early', 'middle', 'late'];
const LIFE_FORTUNE_TOOL = {
  name: 'submit_life_fortune',
  description: 'Submit a lifetime Saju reading split into early, middle and later years, each with good points and cautions.',
  input_schema: {
    type: 'object',
    properties: {
      stages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            stage: { type: 'string', enum: LIFE_STAGE_KEYS },
            good: { type: 'string', description: 'The favorable flow of this life stage, 2-3 sentences.' },
            caution: { type: 'string', description: 'What to watch out for in this life stage, 1-2 sentences.' },
          },
          required: ['stage', 'good', 'caution'],
        },
      },
    },
    required: ['stages'],
  },
};

// Everything from the request that reaches the prompt is checked against a fixed list or
// is a bounded integer, so a crafted request cannot slip free text into the prompt.
function pickFrom(set, v) {
  return set.includes(v) ? v : null;
}
function cleanChartFacts(chart, period, student) {
  const c = chart && typeof chart === 'object' ? chart : {};
  const p = period && typeof period === 'object' ? period : {};
  const counts = ELEMENT_SET.map((el) => {
    const n = Number(c.elements && c.elements[el]);
    return `${el} ${Number.isInteger(n) && n >= 0 && n <= 8 ? n : 0}`;
  }).join(', ');
  const strength = pickFrom(STRENGTH_SET, c.strength);
  const lacking = (Array.isArray(c.lacking) ? c.lacking : []).filter((e) => ELEMENT_SET.includes(e)).slice(0, 5);
  const excess = (Array.isArray(c.excess) ? c.excess : []).filter((e) => ELEMENT_SET.includes(e)).slice(0, 5);

  const chartText =
    `Element balance across the eight characters: ${counts}. ` +
    (strength ? `The day master is ${STRENGTH_TEXT[strength]}. ` : '') +
    `Lacking elements: ${lacking.length ? lacking.join(', ') : 'none'}. ` +
    `Excessive elements (3 or more): ${excess.length ? excess.join(', ') : 'none'}.`;

  const lines = [];
  const sip = pickFrom(SIPSUNG_SET, p.sipsung);
  if (sip) lines.push(`its stem is the "${sip}" ten god relative to the person's day master`);
  (Array.isArray(p.relations) ? p.relations : []).slice(0, 8).forEach((r) => {
    if (!r || !RELATION_SET.includes(r.type) || !POS_SET.includes(r.pos)) return;
    const target = STEM_SET.includes(r.target) || BRANCH_SET.includes(r.target) ? r.target : '';
    if (!target) return;
    const posText = student && STUDENT_POS_TEXT[r.pos] ? STUDENT_POS_TEXT[r.pos] : POS_TEXT[r.pos];
    lines.push(RELATION_TEXT[r.type].replace('{pos}', posText).replace('{target}', target));
  });
  const fills = (Array.isArray(p.fills) ? p.fills : []).filter((e) => ELEMENT_SET.includes(e));
  const feeds = (Array.isArray(p.feeds) ? p.feeds : []).filter((e) => ELEMENT_SET.includes(e));
  if (fills.length) lines.push(`it supplies the lacking element(s) ${fills.join(', ')}`);
  if (feeds.length) lines.push(`it adds even more of the already excessive element(s) ${feeds.join(', ')}`);

  return { chartText, periodText: lines.length ? lines.join('; ') + '.' : 'no special clash or harmony with the person\'s pillars.' };
}

app.post('/api/fortune', requireAuth, async (req, res) => {
  try {
    const {
      dayStem, dayBranch, yearStem, yearBranch,
      monthStem, monthBranch, hourStem, hourBranch, lang,
      todayKey, todayStem, todayBranch,
      scope, periodYear, periodMonth, chart, period,
    } = req.body || {};
    if (!STEM_SET.includes(dayStem) || !BRANCH_SET.includes(dayBranch)) {
      return res.status(400).json({ error: errMsg('invalidSajuData', lang) });
    }
    const element = pickFrom(ELEMENT_SET, req.body.element) || '토';
    const kind = scope === 'month' || scope === 'year' || scope === 'life' ? scope : 'day';
    // Age 18 or under: the 'work' category becomes study luck, and everything stays age-appropriate.
    const student = req.body.student === true;
    const workName = student ? 'study (academics, exams, school life, learning habits)' : 'work (career/business)';

    const language = lang === 'en' ? 'English' : 'Korean';
    const okStem = (s) => (STEM_SET.includes(s) ? s : '?');
    const okBranch = (b) => (BRANCH_SET.includes(b) ? b : '?');
    const hourPart = STEM_SET.includes(hourStem) && BRANCH_SET.includes(hourBranch)
      ? `, hour pillar ${hourStem}${hourBranch}`
      : ' (birth hour unknown)';

    const { chartText, periodText } = cleanChartFacts(chart, period, student);
    const chartIntro =
      `This person's chart: year pillar ${okStem(yearStem)}${okBranch(yearBranch)}, month pillar ${okStem(monthStem)}${okBranch(monthBranch)}, ` +
      `day pillar ${dayStem}${dayBranch}${hourPart}; the day master's element is ${element}. ${chartText}`;

    const personalize =
      `Ground EVERY point in this person's own chart facts above and the period facts below, and say concretely what drives it ` +
      `(for example the clash with their day branch, a lacking element being supplied, or a strong day master meeting more of the same energy). ` +
      `Two people with different charts must get clearly different readings, so never write generic advice that would fit anyone. `;
    const tone =
      `Tone: warm, entertainment-only and constructive. Be honest about what to watch out for, but frame cautions as habits, timing and ` +
      `choices to be careful with, never as fate. Do not make medical, illness, accident, death or lawsuit predictions. ` +
      (student
        ? `This person is a student aged 18 or under: the "work" category is about STUDY LUCK (concentration, exams, homework, study habits, school life), not a career or a business. ` +
          `Keep everything age-appropriate and about school, study, friends and family; for "money" talk only about allowance, saving and spending habits (no investing or business), ` +
          `and for "love" keep it innocent (friendship, getting along with peers, first feelings) with nothing romantic or adult. `
        : '') +
      `Call the tool with the result.`;

    let promptText;
    let tool;
    let maxTokens;

    if (kind === 'life') {
      const lf = req.body.life && typeof req.body.life === 'object' ? req.body.life : {};
      const sipE = pickFrom(SIPSUNG_SET, lf.early);
      const sipM = pickFrom(SIPSUNG_SET, lf.middle);
      const sipL = pickFrom(SIPSUNG_SET, lf.late);
      const noHour = lf.noHour === true;
      const stageFacts =
        `Early years (birth to about 30) are read from the year pillar ${okStem(yearStem)}${okBranch(yearBranch)}` +
        (sipE ? `, whose stem is the "${sipE}" ten god` : '') + '. ' +
        `Middle years (30s to 50s) are read from the day pillar ${dayStem}${dayBranch}, home and partner` +
        (sipM ? `; the day branch's main hidden stem is the "${sipM}" ten god` : '') + '. ' +
        (noHour
          ? `The birth hour is unknown, so later years (60 and beyond) are read from the month pillar ${okStem(monthStem)}${okBranch(monthBranch)}`
          : `Later years (60 and beyond) are read from the hour pillar ${okStem(hourStem)}${okBranch(hourBranch)}`) +
        (sipL ? `, whose stem is the "${sipL}" ten god` : '') + '.';

      promptText =
        `You write warm, entertainment-only lifetime fortunes (일생운) based on traditional Korean Saju (Four Pillars). ${chartIntro} ` +
        `${stageFacts} ` +
        `Write in ${language} a reading for each of the three life stages: "early" (초년운), "middle" (중년운) and "late" (말년운). ` +
        `For each stage give "good" (the favorable flow of that stage: study, career, wealth, relationships and family as they fit the stage, 2-3 sentences) ` +
        `and "caution" (what to watch out for in that stage, 1-2 sentences). Make the three stages read as one life story that develops over time. ` +
        `Ground every point in this person's own chart and the pillar and ten god of each stage, and say concretely what drives it. ` +
        `Two people with different charts must get clearly different readings, so never write generic advice that would fit anyone. ` +
        `Tone: warm, entertainment-only and constructive. Be honest about what to watch out for, but frame cautions as habits, timing and ` +
        `choices to be careful with, never as fate. Do not make medical, illness, accident, death, divorce or lawsuit predictions, and do not state a lifespan. ` +
        (student ? `This person is a student aged 18 or under: keep everything age-appropriate and encouraging, with nothing romantic or adult. ` : '') +
        `Call the tool with the result.`;

      const message = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 1500,
        tools: [LIFE_FORTUNE_TOOL],
        tool_choice: { type: 'tool', name: LIFE_FORTUNE_TOOL.name },
        messages: [{ role: 'user', content: promptText }],
      });
      const toolUse = (message.content || []).find((block) => block.type === 'tool_use');
      const stages = toolUse && toolUse.input && Array.isArray(toolUse.input.stages) ? toolUse.input.stages : [];
      const str = (v) => (v ? String(v).trim() : '');
      const cleaned = LIFE_STAGE_KEYS.map((k) => {
        const f = stages.find((it) => it && it.stage === k);
        return { stage: k, good: str(f && f.good), caution: str(f && f.caution) };
      });
      if (!cleaned.every((it) => it.good && it.caution)) return res.status(502).json({ error: errMsg('noAiResult', lang) });
      return res.json({ stages: cleaned });
    }

    if (kind === 'day') {
      // Today's date: use the client's local date when it is a well-formed Y-M-D (so it
      // matches the date the user sees), otherwise fall back to today in Korea time.
      let todayText;
      const keyMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(todayKey || ''));
      if (keyMatch && Number(keyMatch[2]) >= 1 && Number(keyMatch[2]) <= 12 && Number(keyMatch[3]) >= 1 && Number(keyMatch[3]) <= 31) {
        todayText = `${keyMatch[1]}-${String(keyMatch[2]).padStart(2, '0')}-${String(keyMatch[3]).padStart(2, '0')}`;
      } else {
        todayText = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date()); // YYYY-MM-DD
      }
      const todayPillar = STEM_SET.includes(todayStem) && BRANCH_SET.includes(todayBranch) ? `${todayStem}${todayBranch}` : null;

      promptText =
        `You write short, warm, entertainment-only daily fortunes based on traditional Korean Saju (Four Pillars). ${chartIntro} ` +
        `Today's date is ${todayText}.${todayPillar ? ` Today's own day pillar (일진) is ${todayPillar}.` : ''} ` +
        `How today's pillar meets this person's chart: ${periodText} ` +
        `Write today's reading in ${language} for exactly these four categories: ${workName}, money, love, health. ` +
        `For each category give "text" (the favorable side, 1-2 concrete sentences) and "caution" (what to watch out for today, 1 concrete sentence). ` +
        personalize +
        `Start from this person's chart (who they are), then let today's pillar decide what is highlighted today. ` + tone;
      tool = DAY_FORTUNE_TOOL;
      maxTokens = 1400;
    } else {
      const y = Number(periodYear);
      const m = Number(periodMonth);
      const yearOk = Number.isInteger(y) && y >= 1900 && y <= 2200;
      const monthOk = Number.isInteger(m) && m >= 1 && m <= 12;
      if (!yearOk || (kind === 'month' && !monthOk)) {
        return res.status(400).json({ error: errMsg('invalidSajuData', lang) });
      }
      const when = kind === 'month' ? `the month ${y}-${String(m).padStart(2, '0')}` : `the year ${y}`;
      const pPillar =
        period && STEM_SET.includes(period.stem) && BRANCH_SET.includes(period.branch) ? `${period.stem}${period.branch}` : null;

      promptText =
        `You write warm, entertainment-only ${kind === 'month' ? 'monthly' : 'yearly'} fortunes based on traditional Korean Saju (Four Pillars). ${chartIntro} ` +
        `Write the reading for ${when}.${pPillar ? ` This ${kind === 'month' ? 'month' : 'year'}'s own pillar is ${pPillar}.` : ''} ` +
        `How this ${kind === 'month' ? 'month' : 'year'}'s pillar meets this person's chart: ${periodText} ` +
        `Write in ${language}. Give "summaryGood" (the overall favorable flow, 1-2 sentences) and "summaryCaution" (the overall things to watch out for, 1-2 sentences), ` +
        `then for each of ${workName}, money, love and health give one "good" sentence and one "caution" sentence. ` +
        `Keep every sentence concrete and short. ` + personalize + tone;
      tool = PERIOD_FORTUNE_TOOL;
      maxTokens = 1700;
    }

    const message = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: promptText }],
    });

    const toolUse = (message.content || []).find((block) => block.type === 'tool_use');
    const input = toolUse && toolUse.input ? toolUse.input : null;
    const items = input && Array.isArray(input.items) ? input.items : null;
    if (!items) return res.status(502).json({ error: errMsg('noAiResult', lang) });
    const str = (v) => (v ? String(v).trim() : '');

    if (kind === 'day') {
      const cleaned = FORTUNE_CATEGORIES.map((cat) => {
        const found = items.find((it) => it.category === cat);
        return { category: cat, text: str(found && found.text), caution: str(found && found.caution) };
      }).filter((it) => it.text);
      if (!cleaned.length) return res.status(502).json({ error: errMsg('noAiResult', lang) });
      return res.json({ items: cleaned });
    }

    const cleaned = FORTUNE_CATEGORIES.map((cat) => {
      const found = items.find((it) => it.category === cat);
      return { category: cat, good: str(found && found.good), caution: str(found && found.caution) };
    }).filter((it) => it.good && it.caution);
    const summaryGood = str(input.summaryGood);
    const summaryCaution = str(input.summaryCaution);
    if (!summaryGood || !summaryCaution || !cleaned.length) return res.status(502).json({ error: errMsg('noAiResult', lang) });
    res.json({ summaryGood, summaryCaution, items: cleaned });
  } catch (e) {
    console.error('/api/fortune 오류:', e);
    res.status(502).json({ error: errMsg('fortuneFailed', req.body && req.body.lang) });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`사주행운 서버 실행 중: http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error('데이터베이스 초기화 실패. DATABASE_URL이 올바른지 확인해 주세요:', e);
    process.exit(1);
  });