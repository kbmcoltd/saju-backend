require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();

// Allow reasonably large JSON bodies since we're sending base64-encoded photos.
app.use(express.json({ limit: '12mb' }));

// Serve the frontend (public/index.html + any other static assets) from the same server.
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.warn('[경고] ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않습니다. .env 파일을 확인하세요.');
}

const PALM_PROMPT_KO = `당신은 재미로 손금을 봐주는 친근한 콘텐츠 크리에이터입니다. 첨부된 손바닥 사진을 보고, 전통 손금 풀이 스타일(생명선·감정선·두뇌선처럼 보이는 특징 언급)로 위트있고 희망적인 한국어 결과를 3~4문장으로 작성해 주세요.
반드시 지켜야 할 규칙:
- 의학적 진단, 건강 상태, 수명에 대한 언급은 절대 하지 마세요.
- 사진 속 인물이 누구인지 추측하거나 신원을 특정하지 마세요.
- 나이, 인종, 성별 등 민감한 특성에 대한 언급 없이, 오직 재미로 보는 손금 콘텐츠로만 작성하세요.
- 결과 텍스트만 출력하고, 다른 설명이나 전제문은 붙이지 마세요.`;

const PALM_PROMPT_EN = `You are a friendly content creator doing palm readings for entertainment. Looking at the attached photo of a palm, write a witty, upbeat palm reading in 3-4 sentences in English, in the style of traditional palmistry (referencing features that look like the life line, heart line, head line, etc.).
Rules you must follow:
- Never mention medical diagnoses, health conditions, or lifespan.
- Never guess or identify who the person in the photo is.
- Do not mention age, race, gender, or other sensitive traits — keep it purely fun palmistry-style content.
- Output only the result text, with no preamble or extra explanation.`;

const FACE_PROMPT_KO = `당신은 재미로 관상을 봐주는 친근한 콘텐츠 크리에이터입니다. 첨부된 얼굴 사진의 표정과 분위기(눈빛, 미소, 전체적인 인상)를 바탕으로, 전통 관상 풀이 스타일의 위트있고 긍정적인 한국어 총평을 3~4문장으로 작성해 주세요.
반드시 지켜야 할 규칙:
- 외모를 평가하거나 매력도를 판단하는 표현은 쓰지 마세요.
- 건강, 수명, 결혼운, 재물운처럼 단정적인 예언은 하지 마세요.
- 인종, 나이, 성별 등 민감한 특성에 대한 언급 없이, 성격이나 분위기에 대한 긍정적인 인상만 다루세요.
- 사진 속 인물이 누구인지 추측하거나 신원을 특정하지 마세요.
- 결과 텍스트만 출력하고, 다른 설명이나 전제문은 붙이지 마세요.`;

const FACE_PROMPT_EN = `You are a friendly content creator doing face readings for entertainment. Based on the expression and mood in the attached face photo (eyes, smile, overall impression), write a witty, positive overall impression in 3-4 sentences in English, in the style of traditional face reading.
Rules you must follow:
- Never evaluate physical appearance or judge attractiveness.
- Never make definitive predictions about health, lifespan, marriage, or wealth.
- Do not mention race, age, gender, or other sensitive traits — only cover positive impressions of personality or mood.
- Never guess or identify who the person in the photo is.
- Output only the result text, with no preamble or extra explanation.`;

// User-facing error messages, bilingual. Falls back to Korean if lang is missing/unrecognized.
const MESSAGES = {
  noApiKey: { ko: '서버에 ANTHROPIC_API_KEY가 설정되어 있지 않습니다.', en: 'ANTHROPIC_API_KEY is not configured on the server.' },
  rateLimited: { ko: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', en: 'Too many requests. Please try again in a moment.' },
  invalidType: { ko: '요청 종류(type)가 올바르지 않습니다.', en: 'Invalid request type.' },
  noImageData: { ko: '이미지 데이터가 없습니다.', en: 'No image data provided.' },
  unsupportedFormat: { ko: '지원하지 않는 이미지 형식입니다. (jpg/png/webp/gif만 가능)', en: 'Unsupported image format. (jpg/png/webp/gif only)' },
  imageTooLarge: { ko: '이미지 용량이 너무 큽니다.', en: 'The image file is too large.' },
  aiServerError: { ko: 'AI 서버 응답 오류가 발생했습니다.', en: 'The AI server returned an error.' },
  noAiResult: { ko: 'AI로부터 결과를 받지 못했습니다.', en: 'No result was received from the AI.' },
  serverError: { ko: '서버 오류가 발생했습니다.', en: 'A server error occurred.' },
  invalidPillars: { ko: '사주 정보가 올바르지 않습니다.', en: 'The Saju (Four Pillars) data is invalid.' },
  fortuneParseFailed: { ko: 'AI 응답을 해석하지 못했습니다.', en: "Couldn't parse the AI's response." },
  noValidFortune: { ko: 'AI로부터 유효한 운세 결과를 받지 못했습니다.', en: 'No valid fortune result was received from the AI.' },
};
function msg(key, lang) {
  const entry = MESSAGES[key];
  return entry ? (entry[lang] || entry.ko) : key;
}
function normalizeLang(lang) {
  return lang === 'en' ? 'en' : 'ko';
}

const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// Very small in-memory rate limiter: max N requests per IP per hour, per named bucket.
// Good enough for a small personal/demo deployment; swap for a real store (Redis, etc.)
// if you expect meaningful traffic.
const rateLimitBuckets = new Map(); // bucketName -> Map(ip -> {count, windowStart})
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
function isRateLimited(bucketName, ip, max) {
  if (!rateLimitBuckets.has(bucketName)) rateLimitBuckets.set(bucketName, new Map());
  const map = rateLimitBuckets.get(bucketName);
  const now = Date.now();
  const entry = map.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  map.set(ip, entry);
  return entry.count > max;
}

// ---------------- Today's fortune (오늘의 사주 운세) via AI ----------------
const STEMS = ['갑', '을', '병', '정', '무', '기', '경', '신', '임', '계'];
const BRANCHES = ['자', '축', '인', '묘', '진', '사', '오', '미', '신', '유', '술', '해'];
const ELEMENTS = ['목', '화', '토', '금', '수'];
const FORTUNE_CATEGORIES = ['work', 'money', 'love', 'health'];

function isValidPillarInput(body) {
  const { element, dayStem, dayBranch, yearStem, yearBranch, monthStem, monthBranch, hourStem, hourBranch } = body || {};
  if (!ELEMENTS.includes(element)) return false;
  if (!STEMS.includes(dayStem) || !BRANCHES.includes(dayBranch)) return false;
  if (!STEMS.includes(yearStem) || !BRANCHES.includes(yearBranch)) return false;
  if (!STEMS.includes(monthStem) || !BRANCHES.includes(monthBranch)) return false;
  // hour is optional, but if present both stem and branch must be valid; if absent both must be null/undefined.
  const hourProvided = hourStem != null || hourBranch != null;
  if (hourProvided && (!STEMS.includes(hourStem) || !BRANCHES.includes(hourBranch))) return false;
  return true;
}

function buildFortunePrompt({ element, dayStem, dayBranch, yearStem, yearBranch, monthStem, monthBranch, hourStem, hourBranch }, lang) {
  if (lang === 'en') {
    const hourPart = hourStem && hourBranch ? `Hour Pillar: '${hourStem}${hourBranch}'` : 'Hour Pillar: unknown';
    return `You are a content creator giving a fun daily fortune reading based on traditional Korean Saju (Four Pillars of Destiny) astrology.
Here is a user's Saju information:
- Year Pillar: '${yearStem}${yearBranch}'
- Month Pillar: '${monthStem}${monthBranch}'
- Day Pillar: '${dayStem}${dayBranch}'
- ${hourPart}
- Day Master element: '${element}'

Based on this Saju information, write today's fortune for each of these four categories, each in English, at most 2 sentences: work (career/business), money (finances), love (romance), health (wellness).

Rules you must follow:
- Output ONLY a single valid JSON object. No markdown code fences, explanations, or greetings.
- JSON format: {"items":[{"category":"work","text":"..."},{"category":"money","text":"..."},{"category":"love","text":"..."},{"category":"health","text":"..."}]}
- For the health item, never mention medical diagnoses, disease names, treatments, or lifespan — only light wellness/lifestyle suggestions.
- Avoid definitive predictions ("you will definitely..."); favor possibility and encouragement with a witty, hopeful tone.
- Each text should be 40-160 characters.`;
  }
  const hourPart = hourStem && hourBranch ? `시주 '${hourStem}${hourBranch}'` : '시주 정보 없음';
  return `당신은 한국 전통 사주 명리학을 바탕으로 재미 삼아 오늘의 운세를 알려주는 콘텐츠 크리에이터입니다.
아래는 어떤 사용자의 사주 정보입니다:
- 년주: '${yearStem}${yearBranch}'
- 월주: '${monthStem}${monthBranch}'
- 일주: '${dayStem}${dayBranch}'
- ${hourPart}
- 일간(日干)의 오행: '${element}'

이 사주 정보를 바탕으로 오늘 하루의 운세를 아래 네 항목에 대해 각각 한국어 2문장 이내로 작성해 주세요: work(사업·일운), money(금전운), love(연애운), health(건강운).

반드시 지켜야 할 규칙:
- 순수한 JSON 객체 하나만 출력하세요. 마크다운 코드블록(백틱)이나 설명, 인사말은 절대 포함하지 마세요.
- JSON 형식: {"items":[{"category":"work","text":"..."},{"category":"money","text":"..."},{"category":"love","text":"..."},{"category":"health","text":"..."}]}
- health 항목에서는 의학적 진단, 질병명, 치료법, 수명을 절대 언급하지 말고 컨디션 관리나 생활 습관에 대한 가벼운 조언만 담아주세요.
- "반드시 ~됩니다"처럼 확정적인 예언은 피하고, 가능성과 조언 위주로 위트있고 희망적인 톤을 유지하세요.
- 각 text는 40자 이상 90자 이하로 작성하세요.`;
}

function parseFortuneJson(text) {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const parsed = JSON.parse(cleaned);
  if (!parsed || !Array.isArray(parsed.items)) throw new Error('invalid fortune JSON shape');
  return parsed.items
    .filter((it) => it && FORTUNE_CATEGORIES.includes(it.category) && typeof it.text === 'string' && it.text.trim())
    .map((it) => ({ category: it.category, text: it.text.trim().slice(0, 200) }));
}

app.post('/api/analyze', async (req, res) => {
  const lang = normalizeLang(req.body && req.body.lang);
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: msg('noApiKey', lang) });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    if (isRateLimited('analyze', ip, 20)) {
      return res.status(429).json({ error: msg('rateLimited', lang) });
    }

    const { type, base64, mediaType } = req.body || {};

    if (type !== 'palm' && type !== 'face') {
      return res.status(400).json({ error: msg('invalidType', lang) });
    }
    if (!base64 || typeof base64 !== 'string') {
      return res.status(400).json({ error: msg('noImageData', lang) });
    }
    if (!mediaType || !ALLOWED_MEDIA_TYPES.has(mediaType)) {
      return res.status(400).json({ error: msg('unsupportedFormat', lang) });
    }
    // Rough size guard: base64 is ~4/3 the size of the original bytes.
    if (base64.length > 8 * 1024 * 1024) {
      return res.status(400).json({ error: msg('imageTooLarge', lang) });
    }

    const promptText = lang === 'en'
      ? (type === 'palm' ? PALM_PROMPT_EN : FACE_PROMPT_EN)
      : (type === 'palm' ? PALM_PROMPT_KO : FACE_PROMPT_KO);

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              { type: 'text', text: promptText },
            ],
          },
        ],
      }),
    });

    if (!anthropicResponse.ok) {
      const errBody = await anthropicResponse.text().catch(() => '');
      console.error('Anthropic API error:', anthropicResponse.status, errBody);
      return res.status(502).json({ error: msg('aiServerError', lang) });
    }

    const data = await anthropicResponse.json();
    const text = (data.content || [])
      .map((item) => (item.type === 'text' ? item.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();

    if (!text) {
      return res.status(502).json({ error: msg('noAiResult', lang) });
    }

    res.json({ result: text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: msg('serverError', lang) });
  }
});

app.post('/api/fortune', async (req, res) => {
  const lang = normalizeLang(req.body && req.body.lang);
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: msg('noApiKey', lang) });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    if (isRateLimited('fortune', ip, 30)) {
      return res.status(429).json({ error: msg('rateLimited', lang) });
    }

    if (!isValidPillarInput(req.body)) {
      return res.status(400).json({ error: msg('invalidPillars', lang) });
    }

    const promptText = buildFortunePrompt(req.body, lang);

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 700,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: promptText }],
          },
        ],
      }),
    });

    if (!anthropicResponse.ok) {
      const errBody = await anthropicResponse.text().catch(() => '');
      console.error('Anthropic API error:', anthropicResponse.status, errBody);
      return res.status(502).json({ error: msg('aiServerError', lang) });
    }

    const data = await anthropicResponse.json();
    const rawText = (data.content || [])
      .map((item) => (item.type === 'text' ? item.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();

    if (!rawText) {
      return res.status(502).json({ error: msg('noAiResult', lang) });
    }

    let items;
    try {
      items = parseFortuneJson(rawText);
    } catch (parseErr) {
      console.error('운세 JSON 파싱 실패:', parseErr, rawText);
      return res.status(502).json({ error: msg('fortuneParseFailed', lang) });
    }

    if (items.length === 0) {
      return res.status(502).json({ error: msg('noValidFortune', lang) });
    }

    res.json({ items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: msg('serverError', lang) });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`사주행운 서버 실행 중: http://localhost:${PORT}`);
});
