const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- Config ---
const VULTR_BASE = 'https://api.vultrinference.com/v1';
const VULTR_KEY = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.openclaw', 'secrets', 'vultr.json'))).key1; }
  catch { return process.env.VULTR_API_KEY || ''; }
})();

const MODELS = {
  'evez-smart': { upstream: 'zai-org/GLM-5.1-FP8', desc: 'Best overall — reasoning, analysis, creative', ctx: 32768 },
  'evez-code': { upstream: 'nvidia/DeepSeek-V3.2-NVFP4', desc: 'Code generation & debugging', ctx: 65536 },
  'evez-fast': { upstream: 'MiniMaxAI/MiniMax-M2.5', desc: 'Quick & balanced responses', ctx: 32768 },
  'evez-vision': { upstream: 'moonshotai/Kimi-K2.5', desc: 'Multimodal — images + text', ctx: 131072 },
};

const PRICING = { input: 0.002, output: 0.006 };

// --- File-based stores ---
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const KEYS_PATH = path.join(DATA_DIR, 'api-keys.json');
const USAGE_PATH = path.join(DATA_DIR, 'usage.json');
const EMAILS_PATH = path.join(DATA_DIR, 'emails.json');

function loadJSON(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def || {}; } }
function saveJSON(p, d) { fs.writeFileSync(p, JSON.stringify(d, null, 2)); }

// --- Rate limiting ---
const rateLimiter = {};
function checkRateLimit(key, limit) {
  const now = Date.now();
  if (!rateLimiter[key]) rateLimiter[key] = [];
  rateLimiter[key] = rateLimiter[key].filter(t => now - t < 60000);
  if (rateLimiter[key].length >= limit) return false;
  rateLimiter[key].push(now);
  return true;
}

// --- Auth ---
function auth(req, res, next) {
  const key = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!key) return res.status(401).json({ error: { message: 'Missing API key. Pass as Bearer token.', type: 'auth_error' }});
  const keys = loadJSON(KEYS_PATH);
  const k = keys[key];
  if (!k) return res.status(401).json({ error: { message: 'Invalid API key', type: 'auth_error' }});
  if (k.disabled) return res.status(403).json({ error: { message: 'API key disabled', type: 'auth_error' }});
  if (k.credits !== null && k.credits <= 0) return res.status(429).json({ error: { message: 'Credits exhausted. Upgrade at evez.dev', type: 'credits_error' }});
  if (!checkRateLimit(key, k.plan === 'free' ? 20 : 120)) return res.status(429).json({ error: { message: 'Rate limited. Try again in a minute.', type: 'rate_limit' }});
  req.apiKey = key;
  req.keyData = k;
  next();
}

// --- Routes ---
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: Object.entries(MODELS).map(([id, m]) => ({
      id, object: 'model', created: 1746897600, owned_by: 'evez',
      context_window: m.ctx, description: m.desc
    }))
  });
});

app.post('/v1/chat/completions', auth, async (req, res) => {
  const { model, messages, max_tokens, temperature, stream, top_p, frequency_penalty, presence_penalty } = req.body;
  const modelInfo = MODELS[model];
  if (!modelInfo) return res.status(400).json({ error: { message: `Unknown model: ${model}. Available: ${Object.keys(MODELS).join(', ')}`, type: 'invalid_request_error' }});

  const requestId = 'evez-' + crypto.randomUUID();

  try {
    const resp = await fetch(`${VULTR_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${VULTR_KEY}` },
      body: JSON.stringify({
        model: modelInfo.upstream, messages, max_tokens: max_tokens || 4096,
        temperature: temperature || 0.7, stream: stream || false,
        top_p, frequency_penalty, presence_penalty
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      return res.status(resp.status).json({ error: { message: err, type: 'upstream_error' }});
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let totalTokens = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const rewritten = chunk.replace(/"model":"[^"]*"/g, `"model":"${model}"`);
        res.write(rewritten);
        const lines = chunk.split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines) {
          try { const d = JSON.parse(line.slice(6)); if (d.usage) totalTokens = d.usage.total_tokens; } catch {}
        }
      }
      res.write('data: [DONE]\n\n');
      res.end();
      trackUsage(req.apiKey, model, totalTokens || estimateTokens(messages));
    } else {
      const data = await resp.json();
      data.model = model;
      data.id = requestId;
      const tokens = data.usage?.total_tokens || estimateTokens(messages);
      trackUsage(req.apiKey, model, tokens);
      res.json(data);
    }
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'server_error' }});
  }
});

// Legacy completions
app.post('/v1/completions', auth, async (req, res) => {
  const { model, prompt, max_tokens, temperature } = req.body;
  const modelInfo = MODELS[model];
  if (!modelInfo) return res.status(400).json({ error: { message: `Unknown model: ${model}`, type: 'invalid_request_error' }});
  const messages = [{ role: 'user', content: prompt }];
  try {
    const resp = await fetch(`${VULTR_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${VULTR_KEY}` },
      body: JSON.stringify({ model: modelInfo.upstream, messages, max_tokens: max_tokens || 2048, temperature: temperature || 0.7, stream: false })
    });
    const data = await resp.json();
    res.json({
      id: 'evez-' + crypto.randomUUID(), object: 'text_completion',
      created: Math.floor(Date.now()/1000), model,
      choices: (data.choices || []).map(c => ({ text: c.message?.content || '', index: c.index || 0, finish_reason: c.finish_reason || 'stop' })),
      usage: data.usage
    });
    trackUsage(req.apiKey, model, data.usage?.total_tokens || estimateTokens(messages));
  } catch (e) {
    res.status(500).json({ error: { message: e.message, type: 'server_error' }});
  }
});

function estimateTokens(messages) {
  const text = messages.map(m => typeof m === 'string' ? m : m.content || '').join(' ');
  return Math.ceil(text.length / 4);
}

function trackUsage(key, model, tokens) {
  const usage = loadJSON(USAGE_PATH);
  const today = new Date().toISOString().split('T')[0];
  if (!usage[key]) usage[key] = {};
  if (!usage[key][today]) usage[key][today] = [];
  usage[key][today].push({ model, tokens, ts: Date.now() });
  saveJSON(USAGE_PATH, usage);
  const keys = loadJSON(KEYS_PATH);
  if (keys[key]?.credits !== null && keys[key]?.credits > 0) {
    keys[key].credits -= tokens;
    saveJSON(KEYS_PATH, keys);
  }
}

// --- Admin ---
const MASTER_KEY = process.env.MASTER_KEY; // REQUIRED — no default. Set in env.
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== MASTER_KEY) return res.status(403).json({ error: 'Forbidden' });
  next();
}

app.post('/admin/keys', adminAuth, (req, res) => {
  const { name, credits, plan, email } = req.body;
  const key = 'evez-' + crypto.randomBytes(16).toString('hex');
  const keys = loadJSON(KEYS_PATH);
  keys[key] = { name: name || 'unnamed', email: email || '', credits: credits !== undefined ? credits : null, plan: plan || 'free', disabled: false, created: Date.now() };
  saveJSON(KEYS_PATH, keys);
  res.json({ key, ...keys[key] });
});

app.get('/admin/keys', adminAuth, (req, res) => {
  const keys = loadJSON(KEYS_PATH);
  res.json(Object.entries(keys).map(([k, v]) => ({ key: k, ...v })));
});

app.delete('/admin/keys/:key', adminAuth, (req, res) => {
  const keys = loadJSON(KEYS_PATH);
  if (keys[req.params.key]) { keys[req.params.key].disabled = true; saveJSON(KEYS_PATH, keys); }
  res.json({ ok: true });
});

app.get('/admin/usage', adminAuth, (req, res) => res.json(loadJSON(USAGE_PATH)));

app.get('/admin/revenue', adminAuth, (req, res) => {
  const usage = loadJSON(USAGE_PATH);
  let totalTokens = 0;
  for (const ku of Object.values(usage)) for (const days of Object.values(ku)) for (const e of days) totalTokens += e.tokens;
  res.json({ totalTokens, estimatedRevenue: (totalTokens / 1000) * PRICING.output, pricing: PRICING, signups: loadJSON(EMAILS_PATH, []).length });
});

app.get('/admin/stats', adminAuth, (req, res) => {
  const keys = loadJSON(KEYS_PATH);
  const emails = loadJSON(EMAILS_PATH, []);
  const usage = loadJSON(USAGE_PATH);
  let totalReqs = 0, totalTokens = 0;
  for (const ku of Object.values(usage)) for (const days of Object.values(ku)) for (const e of days) { totalReqs++; totalTokens += e.tokens; }
  res.json({ totalKeys: Object.keys(keys).length, activeKeys: Object.values(keys).filter(k => !k.disabled).length, totalSignups: emails.length, totalRequests: totalReqs, totalTokens, estimatedRevenue: (totalTokens / 1000) * PRICING.output });
});

// --- Signup ---
app.post('/signup', (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
  const key = 'evez-' + crypto.randomBytes(16).toString('hex');
  const keys = loadJSON(KEYS_PATH);
  keys[key] = { name: email, email, credits: 100000, plan: 'free', disabled: false, created: Date.now() };
  saveJSON(KEYS_PATH, keys);
  const emails = loadJSON(EMAILS_PATH, []);
  if (!emails.find(e => e.email === email)) emails.push({ email, date: Date.now(), plan: 'free' });
  saveJSON(EMAILS_PATH, emails);
  res.json({ key, plan: 'free', credits: 100000, models: Object.keys(MODELS), baseURL: 'https://api.evez.dev/v1' });
});

// --- Stripe Checkout ---
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
if (STRIPE_SECRET) {
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(STRIPE_SECRET);
    app.post('/v1/checkout', async (req, res) => {
      const { plan, email } = req.body;
      const PLANS = {
        pro: { price: 500, name: 'EVEZ Pro — Unlimited' },
        business: { price: 2500, name: 'EVEZ Business — Team + SLA' }
      };
      const p = PLANS[plan];
      if (!p) return res.status(400).json({ error: 'Invalid plan' });
      try {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'], customer_email: email,
          line_items: [{ price_data: { currency: 'usd', product_data: { name: p.name }, unit_amount: p.price, recurring: { interval: 'month' } }, quantity: 1 }],
          mode: 'subscription',
          success_url: 'https://evez.dev/signup?plan=' + plan,
          cancel_url: 'https://evez.dev/'
        });
        res.json({ url: session.url });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
  } catch (e) {}
}

// Health
app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.0.0', models: Object.keys(MODELS).length, uptime: Math.floor(process.uptime()) }));

// Landing page
const LANDING = require('fs').readFileSync(path.join(__dirname, '..', 'public-site', 'index.html'), 'utf8');
app.get('/', (req, res) => res.send(LANDING));

// Signup page
const SIGNUP = require('fs').readFileSync(path.join(__dirname, '..', 'public-site', 'signup.html'), 'utf8');
app.get('/signup', (req, res) => res.send(SIGNUP));

const PORT = process.env.PORT || 9090;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`EVEZ API v2.0 on :${PORT}`);
  console.log(`Master key: ${MASTER_KEY}`);
});
