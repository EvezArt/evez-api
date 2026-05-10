const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));

// --- Config ---
const VULTR_BASE = 'https://api.vultrinference.com/v1';
const VULTR_KEY = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.openclaw', 'secrets', 'vultr.json'))).key1; }
  catch { return process.env.VULTR_API_KEY || ''; }
})();

const MODELS = {
  'evez-smart': 'zai-org/GLM-5.1-FP8',
  'evez-code': 'nvidia/DeepSeek-V3.2-NVFP4',
  'evez-fast': 'MiniMaxAI/MiniMax-M2.5',
  'evez-vision': 'moonshotai/Kimi-K2.5',
};

const PRICING = { input: 0.002, output: 0.006 }; // per 1K tokens (way cheaper than GPT-4)

// --- API Key Store (file-based) ---
const KEYS_PATH = path.join(__dirname, '..', 'api-keys.json');
function loadKeys() {
  try { return JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8')); }
  catch { return {}; }
}
function saveKeys(keys) { fs.writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2)); }

// --- Usage tracking ---
const USAGE_PATH = path.join(__dirname, '..', 'usage.json');
function loadUsage() {
  try { return JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8')); }
  catch { return {}; }
}
function saveUsage(u) { fs.writeFileSync(USAGE_PATH, JSON.stringify(u, null, 2)); }

// --- Auth middleware ---
function auth(req, res, next) {
  const key = req.headers['authorization']?.replace('Bearer ', '');
  if (!key) return res.status(401).json({ error: { message: 'Missing API key. Pass as Bearer token.', type: 'auth_error' }});
  const keys = loadKeys();
  const k = keys[key];
  if (!k) return res.status(401).json({ error: { message: 'Invalid API key', type: 'auth_error' }});
  if (k.disabled) return res.status(403).json({ error: { message: 'API key disabled', type: 'auth_error' }});
  if (k.credits !== null && k.credits <= 0) return res.status(429).json({ error: { message: 'Credits exhausted', type: 'credits_error' }});
  req.apiKey = key;
  req.keyInfo = k;
  next();
}

// --- OpenAI-compatible endpoints ---

// GET /v1/models
app.get('/v1/models', auth, (req, res) => {
  res.json({
    object: 'list',
    data: Object.entries(MODELS).map(([id, _]) => ({
      id, object: 'model', created: Math.floor(Date.now()/1000), owned_by: 'evez'
    }))
  });
});

// POST /v1/chat/completions
app.post('/v1/chat/completions', auth, async (req, res) => {
  const { model, messages, max_tokens, temperature, stream } = req.body;
  const upstreamModel = MODELS[model];
  if (!upstreamModel) return res.status(400).json({ error: { message: `Unknown model: ${model}. Available: ${Object.keys(MODELS).join(', ')}`, type: 'invalid_request_error' }});

  const requestId = 'evez-' + crypto.randomUUID();
  const startTime = Date.now();

  try {
    const resp = await fetch(`${VULTR_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${VULTR_KEY}`
      },
      body: JSON.stringify({
        model: upstreamModel,
        messages,
        max_tokens: max_tokens || 4096,
        temperature: temperature || 0.7,
        stream: stream || false
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      return res.status(resp.status).json({ error: { message: err, type: 'upstream_error' }});
    }

    if (stream) {
      // Stream through
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
        
        // Rewrite model name in SSE
        const rewritten = chunk.replace(/"model":"[^"]*"/g, `"model":"${model}"`);
        res.write(rewritten);
        
        // Count tokens roughly
        const lines = chunk.split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines) {
          try {
            const d = JSON.parse(line.slice(6));
            if (d.usage) totalTokens = d.usage.total_tokens;
          } catch {}
        }
      }
      res.write('data: [DONE]\n\n');
      res.end();
      trackUsage(req.apiKey, model, totalTokens || estimateTokens(messages));
    } else {
      const data = await resp.json();
      // Rewrite model
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

function estimateTokens(messages) {
  return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
}

function trackUsage(key, model, tokens) {
  const usage = loadUsage();
  const today = new Date().toISOString().split('T')[0];
  if (!usage[key]) usage[key] = {};
  if (!usage[key][today]) usage[key][today] = [];
  usage[key][today].push({ model, tokens, ts: Date.now() });
  saveUsage(usage);

  // Deduct credits if applicable
  const keys = loadKeys();
  if (keys[key]?.credits !== null && keys[key]?.credits > 0) {
    keys[key].credits -= tokens;
    saveKeys(keys);
  }
}

// --- Admin endpoints (master key required) ---
const MASTER_KEY = process.env.MASTER_KEY || 'evez-admin-' + crypto.randomBytes(8).toString('hex');

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== MASTER_KEY) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// Create API key
app.post('/admin/keys', adminAuth, (req, res) => {
  const { name, credits } = req.body;
  const key = 'evez-' + crypto.randomBytes(16).toString('hex');
  const keys = loadKeys();
  keys[key] = {
    name: name || 'unnamed',
    credits: credits !== undefined ? credits : null, // null = unlimited
    disabled: false,
    created: Date.now()
  };
  saveKeys(keys);
  res.json({ key, ...keys[key] });
});

// List keys
app.get('/admin/keys', adminAuth, (req, res) => {
  const keys = loadKeys();
  res.json(Object.entries(keys).map(([k, v]) => ({ key: k, ...v })));
});

// Revoke key
app.delete('/admin/keys/:key', adminAuth, (req, res) => {
  const keys = loadKeys();
  if (keys[req.params.key]) { keys[req.params.key].disabled = true; saveKeys(keys); }
  res.json({ ok: true });
});

// Usage stats
app.get('/admin/usage', adminAuth, (req, res) => {
  res.json(loadUsage());
});

// Revenue estimate
app.get('/admin/revenue', adminAuth, (req, res) => {
  const usage = loadUsage();
  let totalTokens = 0;
  for (const keyUsage of Object.values(usage)) {
    for (const days of Object.values(keyUsage)) {
      for (const entry of days) totalTokens += entry.tokens;
    }
  }
  res.json({
    totalTokens,
    estimatedRevenue: (totalTokens / 1000) * PRICING.output,
    pricing: PRICING
  });
});

// Self-service signup (free tier — captures email for upselling)
app.post('/signup', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
  const key = 'evez-' + crypto.randomBytes(16).toString('hex');
  const keys = loadKeys();
  keys[key] = {
    name: email,
    email,
    credits: 100000, // ~100K tokens free
    plan: 'free',
    disabled: false,
    created: Date.now()
  };
  saveKeys(keys);
  // Save email list for marketing
  const EMAILS_PATH = path.join(__dirname, '..', 'emails.json');
  let emails;
  try { emails = JSON.parse(fs.readFileSync(EMAILS_PATH, 'utf8')); } catch { emails = []; }
  if (!emails.find(e => e.email === email)) emails.push({ email, date: Date.now(), plan: 'free' });
  fs.writeFileSync(EMAILS_PATH, JSON.stringify(emails, null, 2));
  res.json({ key, plan: 'free', credits: 100000, models: Object.keys(MODELS), baseURL: 'https://evez-api2.fly.dev/v1' });
});

// Signup page
app.get('/signup', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Get EVEZ API Key</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e8e8e8;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{max-width:420px;padding:40px}h1{font-size:28px;margin-bottom:8px}h1 span{color:#6c5ce7}p{color:#888;margin-bottom:24px}input{width:100%;padding:14px;background:#141414;border:1px solid #2a2a2a;border-radius:10px;color:#e8e8e8;font-size:16px;margin-bottom:16px;outline:none}input:focus{border-color:#6c5ce7}button{width:100%;padding:14px;background:#6c5ce7;border:none;border-radius:10px;color:white;font-size:16px;font-weight:600;cursor:pointer}button:hover{background:#a29bfe}#result{margin-top:20px;display:none}#result .key{background:#141414;border:1px solid #00b894;border-radius:8px;padding:12px;font-family:monospace;word-break:break-all;color:#00b894;margin:8px 0}#result small{color:#666}</style></head><body><div class="card"><h1>Get your <span>free</span> key</h1><p>100K tokens free. No credit card. Instant.</p><input type="email" id="email" placeholder="you@company.com" onkeydown="if(event.key==='Enter')signup()"><button onclick="signup()">Get API Key →</button><div id="result"><p>Your API key:</p><div class="key" id="apiKey"></div><small>Base URL: https://evez-api2.fly.dev/v1</small><br><small>Models: evez-smart, evez-code, evez-fast, evez-vision</small></div></div><script>async function signup(){const e=document.getElementById('email').value;if(!e)return;const r=await fetch('/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e})});const d=await r.json();if(d.key){document.getElementById('apiKey').textContent=d.key;document.getElementById('result').style.display='block'}}</script></body></html>`);
});

// Health
app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// Landing page
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EVEZ API</title><style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e8e8e8;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{max-width:600px;padding:40px;text-align:center}h1{font-size:48px;margin-bottom:8px}h1 span{color:#6c5ce7}p{color:#888;margin:16px 0;line-height:1.6}
.badge{display:inline-block;background:#00b894;color:#000;padding:4px 12px;border-radius:20px;font-weight:700;font-size:14px;margin:8px}
.code{background:#141414;border:1px #2a2a2a solid;border-radius:12px;padding:20px;text-align:left;margin:20px 0;font-family:monospace;font-size:14px;overflow-x:auto}
.models{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:20px 0}.model{background:#141414;border:1px #2a2a2a solid;border-radius:10px;padding:12px;text-align:left}.model b{color:#a29bfe}.model small{color:#666}
a{color:#6c5ce7}footer{margin-top:40px;color:#444;font-size:12px}
</style></head><body><div class="card">
<h1>EVEZ<span>API</span></h1>
<p>OpenAI-compatible AI API. Drop-in replacement. 10x cheaper.</p>
<span class="badge">$0.002/1K tokens input</span><span class="badge">$0.006/1K tokens output</span><span class="badge">99.9% cheaper than GPT-4</span>
<div class="models">
<div class="model"><b>evez-smart</b><br><small>GLM-5.1 — best overall</small></div>
<div class="model"><b>evez-code</b><br><small>DeepSeek V3.2 — code & reasoning</small></div>
<div class="model"><b>evez-fast</b><br><small>MiniMax M2.5 — quick & balanced</small></div>
<div class="model"><b>evez-vision</b><br><small>Kimi K2.5 — multimodal</small></div>
</div>
<p>Swap one line of code:</p>
<div class="code"><span style="color:#6a9955">// Before</span><br>const openai = new OpenAI({ baseURL: "https://api.openai.com/v1" })<br><br><span style="color:#6a9955">// After</span><br>const openai = new OpenAI({ baseURL: "https://api.evez.dev/v1" })</div>
<p>Get your API key → <a href="mailto:admin@evez.dev">admin@evez.dev</a></p>
<footer>Powered by free infrastructure. Built by <a href="https://github.com/EvezArt">EvezArt</a></footer>
</div></body></html>`);
});

const PORT = process.env.PORT || 9090;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`EVEZ API on :${PORT}`);
  console.log(`Master key: ${MASTER_KEY}`);
  console.log(`Save this key — it controls everything`);
});
