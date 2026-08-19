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
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

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
    ko: "당신은 전통 손금(수상학) 풀이 스타일을 재미로 재구성하는 콘텐츠 작가입니다. 제공된 손바닥 사진의 생명선·감정선·두뇌선 등 주요 손금의 특징을 관찰한 것처럼 묘사하며, 흥미롭고 따뜻한 톤으로 3~5문장의 총평을 한국어로 작성하세요. 이 콘텐츠는 재미를 위한 것이며 의학적·과학적 진단이 아니라는 전제를 항상 유지하고, 건강에 대한 단정적 진단이나 불안을 조장하는 표현은 쓰지 마세요.",
    en: "You are a content writer who reimagines traditional palmistry as light entertainment. Describe the photographed palm's life/heart/head lines as if observing their traditional features, in a warm and engaging tone, in 3-5 sentences of English. Always keep the framing that this is entertainment only, not a medical or scientific diagnosis, and avoid definitive health claims or anxiety-inducing language.",
  },
  face: {
    ko: "당신은 전통 관상학 풀이 스타일을 재미로 재구성하는 콘텐츠 작가입니다. 제공된 얼굴 사진에서 느껴지는 인상의 특징을 관찰한 것처럼 묘사하며, 흥미롭고 긍정적인 톤으로 3~5문장의 총평을 한국어로 작성하세요. 외모를 평가하거나 순위를 매기지 말고, 이 콘텐츠는 재미를 위한 것이며 의학적 진단이 아니라는 전제를 항상 유지하세요.",
    en: "You are a content writer who reimagines traditional East Asian face reading as light entertainment. Describe the impression conveyed by the photographed face as if observing its traditional features, in a positive and engaging tone, in 3-5 sentences of English. Never rank or judge physical appearance, and always keep the framing that this is entertainment only, not a medical diagnosis.",
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
      max_tokens: 512,
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

/* ---------------- Claude API: today's saju-based fortune ---------------- */
const FORTUNE_CATEGORIES = ['work', 'money', 'love', 'health'];

const FORTUNE_TOOL = {
  name: 'submit_fortune',
  description: "Submit today's four-category Saju fortune reading.",
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: FORTUNE_CATEGORIES },
            text: { type: 'string' },
          },
          required: ['category', 'text'],
        },
      },
    },
    required: ['items'],
  },
};

app.post('/api/fortune', requireAuth, async (req, res) => {
  try {
    const {
      element, dayStem, dayBranch, yearStem, yearBranch,
      monthStem, monthBranch, hourStem, hourBranch, lang,
    } = req.body || {};
    if (!element || !dayStem || !dayBranch) {
      return res.status(400).json({ error: errMsg('invalidSajuData', lang) });
    }

    const language = lang === 'en' ? 'English' : 'Korean';
    const hourPart = hourStem ? `, hour pillar ${hourStem}${hourBranch}` : ' (birth hour unknown)';
    const promptText = `You write short, warm, entertainment-only daily fortunes based on traditional Korean Saju (Four Pillars). ` +
      `Someone's day-master element is ${element}, with year pillar ${yearStem}${yearBranch}, month pillar ${monthStem}${monthBranch}, ` +
      `day pillar ${dayStem}${dayBranch}${hourPart}. ` +
      `Write today's fortune in ${language} for exactly these four categories: work (career/business), money, love, health. ` +
      `Each entry should be 1-2 upbeat, concrete sentences, avoid medical claims or fatalistic/alarming language, and call the submit_fortune tool with the result.`;

    const message = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 700,
      tools: [FORTUNE_TOOL],
      tool_choice: { type: 'tool', name: 'submit_fortune' },
      messages: [{ role: 'user', content: promptText }],
    });

    const toolUse = (message.content || []).find((block) => block.type === 'tool_use');
    const items = toolUse && Array.isArray(toolUse.input && toolUse.input.items) ? toolUse.input.items : null;
    if (!items) return res.status(502).json({ error: errMsg('noAiResult', lang) });

    const cleaned = FORTUNE_CATEGORIES.map((cat) => {
      const found = items.find((it) => it.category === cat);
      return { category: cat, text: found && found.text ? String(found.text).trim() : '' };
    }).filter((it) => it.text);

    if (!cleaned.length) return res.status(502).json({ error: errMsg('noAiResult', lang) });
    res.json({ items: cleaned });
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
