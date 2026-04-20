/**
 * Rood's Vault — Cloudflare Worker API Proxy
 * 
 * All API keys are stored as Cloudflare Environment Variables (encrypted).
 * They are NEVER in this code file — set them in your Cloudflare dashboard.
 * 
 * Environment variables to set in Cloudflare:
 *   CLAUDE_KEY        → your Anthropic / OpenRouter key
 *   GEMINI_KEY        → your Google AI Studio key
 *   OPENAI_KEY        → your OpenAI key
 *   GROQ_KEY          → your Groq key (optional)
 *   JUSTTCG_KEY       → your JustTCG key
 *   POKEMONTCG_KEY    → your pokemontcg.io key
 *   ALLOWED_ORIGIN    → https://anirood2.github.io (your GitHub Pages URL)
 */

export default {
  async fetch(request, env) {

    // ── CORS ──────────────────────────────────────────────
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || '*';
    const corsOk = allowed === '*' || origin === allowed || origin.includes('localhost') || origin.includes('127.0.0.1');

    const corsHeaders = {
      'Access-Control-Allow-Origin': corsOk ? origin || '*' : 'null',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Model',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (!corsOk) {
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ── ROUTE ──────────────────────────────────────────
      if (path === '/scan' && request.method === 'POST') {
        return await handleScan(request, env, corsHeaders);
      }
      if (path === '/prices' && request.method === 'GET') {
        return await handlePrices(request, env, corsHeaders);
      }
      if (path === '/pokemon' && request.method === 'GET') {
        return await handlePokemon(request, env, corsHeaders);
      }
      if (path === '/sets' && request.method === 'GET') {
        return await handleSets(request, env, corsHeaders);
      }
      if (path === '/health') {
        return jsonResponse({ status: 'ok', keys: {
          claude: !!env.CLAUDE_KEY,
          gemini: !!env.GEMINI_KEY,
          openai: !!env.OPENAI_KEY,
          groq: !!env.GROQ_KEY,
          justtcg: !!env.JUSTTCG_KEY,
          pokemontcg: !!env.POKEMONTCG_KEY,
        }}, corsHeaders);
      }

      return jsonResponse({ error: 'Not found', path }, corsHeaders, 404);

    } catch (err) {
      return jsonResponse({ error: err.message }, corsHeaders, 500);
    }
  }
};

// ══════════════════════════════════════════════════════════
//  /scan  — run all available vision models in parallel,
//           return consensus best result
// ══════════════════════════════════════════════════════════
async function handleScan(request, env, cors) {
  const body = await request.json();
  const { base64, mimeType, typeHint } = body;

  if (!base64 || !mimeType) {
    return jsonResponse({ error: 'Missing base64 or mimeType' }, cors, 400);
  }

  const prompt = buildPrompt(typeHint || 'raw trading card');

  // Fire all available models in parallel
  const runners = [];
  if (env.CLAUDE_KEY)  runners.push(runClaude(base64, mimeType, prompt, env.CLAUDE_KEY).then(r => ({ model: 'claude',  raw: r, items: parse(r) })).catch(e => ({ model: 'claude',  error: e.message, items: null })));
  if (env.GEMINI_KEY)  runners.push(runGemini(base64, mimeType, prompt, env.GEMINI_KEY).then(r => ({ model: 'gemini',  raw: r, items: parse(r) })).catch(e => ({ model: 'gemini',  error: e.message, items: null })));
  if (env.OPENAI_KEY)  runners.push(runOpenAI(base64, mimeType, prompt, env.OPENAI_KEY).then(r => ({ model: 'openai',  raw: r, items: parse(r) })).catch(e => ({ model: 'openai',  error: e.message, items: null })));
  if (env.GROQ_KEY)    runners.push(runGroq(base64, mimeType, prompt, env.GROQ_KEY).then(r   => ({ model: 'groq',    raw: r, items: parse(r) })).catch(e => ({ model: 'groq',    error: e.message, items: null })));

  if (!runners.length) {
    return jsonResponse({ error: 'No AI keys configured on server' }, cors, 503);
  }

  const results = await Promise.all(runners);
  const best = pickBest(results);

  if (!best || !best.items?.length) {
    const errors = results.map(r => `${r.model}: ${r.error || 'no items'}`).join(', ');
    return jsonResponse({ error: 'No cards identified. ' + errors }, cors, 422);
  }

  return jsonResponse({
    items: best.items,
    wonModel: best.model,
    modelsUsed: results.filter(r => r.items?.length).map(r => r.model),
    modelResults: results.map(r => ({ model: r.model, count: r.items?.length || 0, error: r.error || null }))
  }, cors);
}

// ══════════════════════════════════════════════════════════
//  /prices?q=...&game=pokemon  — JustTCG price lookup
// ══════════════════════════════════════════════════════════
async function handlePrices(request, env, cors) {
  if (!env.JUSTTCG_KEY) return jsonResponse({ error: 'JustTCG key not configured' }, cors, 503);
  const url = new URL(request.url);
  const q = url.searchParams.get('q') || '';
  const game = url.searchParams.get('game') || 'pokemon';

  const res = await fetch(
    `https://api.justtcg.com/v1/cards?q=${encodeURIComponent(q)}&game=${game}&include_price_history=false&include_statistics=false`,
    { headers: { 'x-api-key': env.JUSTTCG_KEY } }
  );
  const data = await res.json();
  return jsonResponse(data, cors);
}

// ══════════════════════════════════════════════════════════
//  /pokemon?q=...&pageSize=N&page=N  — pokemontcg.io proxy
// ══════════════════════════════════════════════════════════
async function handlePokemon(request, env, cors) {
  if (!env.POKEMONTCG_KEY) return jsonResponse({ error: 'pokemontcg key not configured' }, cors, 503);
  const url = new URL(request.url);
  const q         = url.searchParams.get('q') || '';
  const pageSize  = url.searchParams.get('pageSize') || '48';
  const page      = url.searchParams.get('page') || '1';
  const select    = url.searchParams.get('select') || 'id,name,set,number,rarity,images,tcgplayer,cardmarket,supertype,subtypes';
  const orderBy   = url.searchParams.get('orderBy') || '';

  let apiUrl = `https://api.pokemontcg.io/v2/cards?pageSize=${pageSize}&page=${page}&select=${select}`;
  if (q)       apiUrl += `&q=${encodeURIComponent(q)}`;
  if (orderBy) apiUrl += `&orderBy=${encodeURIComponent(orderBy)}`;

  const res = await fetch(apiUrl, { headers: { 'X-Api-Key': env.POKEMONTCG_KEY } });
  const data = await res.json();
  return jsonResponse(data, cors);
}

// ══════════════════════════════════════════════════════════
//  /sets?q=...  — pokemontcg.io sets proxy
// ══════════════════════════════════════════════════════════
async function handleSets(request, env, cors) {
  if (!env.POKEMONTCG_KEY) return jsonResponse({ error: 'pokemontcg key not configured' }, cors, 503);
  const url = new URL(request.url);
  const q = url.searchParams.get('q') || '';
  const orderBy = url.searchParams.get('orderBy') || 'releaseDate';

  let apiUrl = `https://api.pokemontcg.io/v2/sets?pageSize=250&orderBy=${orderBy}`;
  if (q) apiUrl += `&q=${encodeURIComponent(q)}`;

  const res = await fetch(apiUrl, { headers: { 'X-Api-Key': env.POKEMONTCG_KEY } });
  const data = await res.json();
  return jsonResponse(data, cors);
}

// ══════════════════════════════════════════════════════════
//  AI MODEL RUNNERS
// ══════════════════════════════════════════════════════════
async function runClaude(base64, mimeType, prompt, key) {
  // Supports both Anthropic direct (sk-ant-) and OpenRouter (sk-or-)
  const isOpenRouter = key.startsWith('sk-or-');
  const url = isOpenRouter
    ? 'https://openrouter.ai/api/v1/chat/completions'
    : 'https://api.anthropic.com/v1/messages';

  if (isOpenRouter) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'anthropic/claude-opus-4-5',
        max_tokens: 2000,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: 'text', text: prompt + '\n\nIdentify all items. Return only the JSON array.' }
        ]}]
      })
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status} ${await res.text()}`);
    const d = await res.json();
    return d.choices?.[0]?.message?.content || '';
  } else {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-opus-4-5', max_tokens: 2000, system: prompt,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: 'Identify all items. Return only the JSON array.' }
        ]}]
      })
    });
    if (!res.ok) throw new Error(`Claude ${res.status} ${await res.text()}`);
    const d = await res.json();
    return (d.content || []).map(b => b.text || '').join('').trim();
  }
}

async function runGemini(base64, mimeType, prompt, key) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt + '\n\nIdentify all items. Return only the JSON array.' },
          { inline_data: { mime_type: mimeType, data: base64 } }
        ]}],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2000 }
      })
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status} ${await res.text()}`);
  const d = await res.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function runOpenAI(base64, mimeType, prompt, key) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini', max_tokens: 2000,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' } },
          { type: 'text', text: 'Identify all items. Return only the JSON array.' }
        ]}
      ]
    })
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status} ${await res.text()}`);
  const d = await res.json();
  return d.choices?.[0]?.message?.content || '';
}

async function runGroq(base64, mimeType, prompt, key) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct', max_tokens: 2000,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: 'text', text: 'Identify all items. Return only the JSON array.' }
        ]}
      ]
    })
  });
  if (!res.ok) throw new Error(`Groq ${res.status} ${await res.text()}`);
  const d = await res.json();
  return d.choices?.[0]?.message?.content || '';
}

// ══════════════════════════════════════════════════════════
//  CONSENSUS ENGINE
// ══════════════════════════════════════════════════════════
function pickBest(results) {
  const valid = results.filter(r => r.items?.length > 0);
  if (!valid.length) return null;

  const scored = valid.map(r => {
    let score = 0;
    const items = r.items;
    score += Math.min(items.length, 5) * 5;
    const avgConf = items.reduce((s, it) => s + (it.confidence || 50), 0) / items.length;
    score += avgConf * 0.5;
    items.forEach(it => {
      if (it.set?.length > 2)  score += 8;
      if (it.number)           score += 5;
      if (it.rarity)           score += 5;
      if (it.year)             score += 3;
      if (it.variant && it.variant !== 'None') score += 4;
      if (it.grade_company)    score += 6;
      if (it.search_name)      score += 3;
    });
    const weights = { claude: 1.15, gemini: 1.1, openai: 1.08, groq: 1.0 };
    score *= (weights[r.model] || 1.0);
    return { ...r, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const winner = { ...scored[0] };

  // Consensus enrichment from other models
  if (valid.length > 1) {
    winner.items = winner.items.map((item, idx) => {
      const peers = valid.filter(r => r.model !== winner.model && r.items[idx]).map(r => r.items[idx]);
      if (!peers.length) return item;
      ['set','number','rarity','year','variant','grade_company','grade_score','sealed_type'].forEach(field => {
        if (!item[field] || item[field] === 'None' || item[field] === 'null') {
          const peerVal = peers.find(p => p[field] && p[field] !== 'None' && p[field] !== 'null')?.[field];
          if (peerVal) item[field] = peerVal;
        }
      });
      const peerNames = peers.map(p => (p.name||'').toLowerCase());
      const firstName = (item.name||'').toLowerCase().split(' ')[0];
      if (firstName && peerNames.some(n => n.includes(firstName))) {
        item.confidence = Math.min(100, (item.confidence || 70) + 10);
      }
      return item;
    });
  }

  return winner;
}

// ══════════════════════════════════════════════════════════
//  PROMPT + PARSE
// ══════════════════════════════════════════════════════════
function buildPrompt(typeHint) {
  return `You are an expert TCG and collectibles identifier. The user is scanning a ${typeHint}. Identify every item visible.

For each item return JSON with these exact fields:
- name: exact item name as printed
- tcg: Pokemon | MTG | Yu-Gi-Oh | Baseball | Basketball | Football | Hockey | Lorcana | One Piece | Other
- set: set or product name
- number: card number if visible (e.g. "4/102")
- rarity: rarity if visible (e.g. "Holo Rare", "Ultra Rare")
- year: year printed on card if visible
- item_type: raw | graded | sealed
- condition: Near Mint | Lightly Played | Moderately Played | Heavily Played | Mint
- grade_company: PSA | BGS | CGC | SGC | null
- grade_score: grade as string e.g. "10" | "9.5" | null
- sealed_type: Booster Box | ETB | Booster Pack | Tin | Bundle | null
- variant: 1st Edition | Shadowless | Reverse Holo | Holo | Promo | None
- confidence: integer 0-100
- search_name: simplified card name only for database search

Return ONLY a valid JSON array. No markdown, no backticks, no explanation.`;
}

function parse(raw) {
  if (!raw) return null;
  try {
    const s = raw.replace(/```json|```/g, '').trim();
    const start = s.indexOf('['), end = s.lastIndexOf(']');
    if (start === -1 || end === -1) return null;
    const arr = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(arr) && arr.length ? arr : null;
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════════════════════
function jsonResponse(data, corsHeaders, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}
