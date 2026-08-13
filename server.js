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

const PALM_PROMPT = `당신은 재미로 손금을 봐주는 친근한 콘텐츠 크리에이터입니다. 첨부된 손바닥 사진을 보고, 전통 손금 풀이 스타일(생명선·감정선·두뇌선처럼 보이는 특징 언급)로 위트있고 희망적인 한국어 결과를 3~4문장으로 작성해 주세요.
반드시 지켜야 할 규칙:
- 의학적 진단, 건강 상태, 수명에 대한 언급은 절대 하지 마세요.
- 사진 속 인물이 누구인지 추측하거나 신원을 특정하지 마세요.
- 나이, 인종, 성별 등 민감한 특성에 대한 언급 없이, 오직 재미로 보는 손금 콘텐츠로만 작성하세요.
- 결과 텍스트만 출력하고, 다른 설명이나 전제문은 붙이지 마세요.`;

const FACE_PROMPT = `당신은 재미로 관상을 봐주는 친근한 콘텐츠 크리에이터입니다. 첨부된 얼굴 사진의 표정과 분위기(눈빛, 미소, 전체적인 인상)를 바탕으로, 전통 관상 풀이 스타일의 위트있고 긍정적인 한국어 총평을 3~4문장으로 작성해 주세요.
반드시 지켜야 할 규칙:
- 외모를 평가하거나 매력도를 판단하는 표현은 쓰지 마세요.
- 건강, 수명, 결혼운, 재물운처럼 단정적인 예언은 하지 마세요.
- 인종, 나이, 성별 등 민감한 특성에 대한 언급 없이, 성격이나 분위기에 대한 긍정적인 인상만 다루세요.
- 사진 속 인물이 누구인지 추측하거나 신원을 특정하지 마세요.
- 결과 텍스트만 출력하고, 다른 설명이나 전제문은 붙이지 마세요.`;

const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// Very small in-memory rate limiter: max 20 analyze requests per IP per hour.
// Good enough for a small personal/demo deployment; swap for a real store (Redis, etc.)
// if you expect meaningful traffic.
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 20;
function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  rateLimitMap.set(ip, entry);
  return entry.count > RATE_LIMIT_MAX;
}

app.post('/api/analyze', async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: '서버에 ANTHROPIC_API_KEY가 설정되어 있지 않습니다.' });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
    }

    const { type, base64, mediaType } = req.body || {};

    if (type !== 'palm' && type !== 'face') {
      return res.status(400).json({ error: '요청 종류(type)가 올바르지 않습니다.' });
    }
    if (!base64 || typeof base64 !== 'string') {
      return res.status(400).json({ error: '이미지 데이터가 없습니다.' });
    }
    if (!mediaType || !ALLOWED_MEDIA_TYPES.has(mediaType)) {
      return res.status(400).json({ error: '지원하지 않는 이미지 형식입니다. (jpg/png/webp/gif만 가능)' });
    }
    // Rough size guard: base64 is ~4/3 the size of the original bytes.
    if (base64.length > 8 * 1024 * 1024) {
      return res.status(400).json({ error: '이미지 용량이 너무 큽니다.' });
    }

    const promptText = type === 'palm' ? PALM_PROMPT : FACE_PROMPT;

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
      return res.status(502).json({ error: 'AI 서버 응답 오류가 발생했습니다.' });
    }

    const data = await anthropicResponse.json();
    const text = (data.content || [])
      .map((item) => (item.type === 'text' ? item.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();

    if (!text) {
      return res.status(502).json({ error: 'AI로부터 결과를 받지 못했습니다.' });
    }

    res.json({ result: text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`사주행운 서버 실행 중: http://localhost:${PORT}`);
});
