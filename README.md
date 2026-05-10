# 🧠 EVEZ AI API

**OpenAI-compatible AI API — 99% cheaper than GPT-4. Free tier available.**

## Why EVEZ?

| Provider | Model | 1M output tokens |
|----------|-------|------------------|
| OpenAI | GPT-4o | $17.50 |
| Anthropic | Claude Sonnet | $15.00 |
| Google | Gemini Pro | $7.00 |
| **EVEZ** | **evez-smart** | **$6.00** |

## Get Started — 30 Seconds

```bash
# 1. Get a free API key at https://evez-api2.fly.dev/signup
# 2. Swap one line of code:

export OPENAI_BASE_URL=https://evez-api2.fly.dev/v1
export OPENAI_API_KEY=evez-your-key
```

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://evez-api2.fly.dev/v1",
    api_key="evez-your-key"
)

response = client.chat.completions.create(
    model="evez-smart",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## Models

| Model ID | Base | Best For |
|----------|------|----------|
| `evez-smart` | GLM-5.1 | General purpose — smart & fast |
| `evez-code` | DeepSeek V3.2 | Code generation & reasoning |
| `evez-fast` | MiniMax M2.5 | Quick balanced responses |
| `evez-vision` | Kimi K2.5 | Multimodal (text + image) |

## Pricing

- **Free tier:** 100K tokens/month — no credit card
- **Pro:** $5/month — unlimited tokens
- **Business:** $25/month — team + SLA

## Features

- ✅ OpenAI-compatible (drop-in replacement)
- ✅ Streaming support (SSE)
- ✅ 4 models including vision
- ✅ API key management
- ✅ Usage tracking
- ✅ 99.9% uptime on Fly.io

## Self-Host

```bash
git clone https://github.com/EvezArt/evez-api.git
cd evez-api
npm install
VULTR_API_KEY=your-key MASTER_KEY=your-admin-key npm start
```

## Links

- 🌐 [API](https://evez-api2.fly.dev)
- 📝 [Get API Key](https://evez-api2.fly.dev/signup)
- 💬 [Discord](https://discord.com/invite/clawd)
- 📦 [GitHub](https://github.com/EvezArt/evez-api)

---

Built by [EvezArt](https://github.com/EvezArt) · Powered by free infrastructure
