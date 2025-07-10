require('dotenv').config();
const express  = require('express');
const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const crypto   = require('crypto');
const Redis    = require('ioredis');

const app  = express();
const PORT = process.env.PORT || 3000;

/* =================== REDIS =================== */
const redis = new Redis(process.env.REDIS_URL || 'redis://default:hunted123@main_redis:6379');
redis.on('connect', () => console.log('Redis conectado'));
redis.on('error',   err => console.error('Redis erro:', err));

/* =========== Tokens vindos do .env =========== */
const freeTokens       = process.env.FREE_TOKENS       ? process.env.FREE_TOKENS.split(',')                 : [];
const freeResetDays    = process.env.FREE_RESET_DAYS   ? process.env.FREE_RESET_DAYS.split(',').map(Number) : [];
const premiumTokens    = process.env.PREMIUM_TOKENS    ? process.env.PREMIUM_TOKENS.split(',')               : [];
const premiumResetDays = process.env.PREMIUM_RESET_DAYS? process.env.PREMIUM_RESET_DAYS.split(',').map(Number): [];

/* ========== Token extra do “bless” ========== */
const BLESS_TOKEN  = process.env.BLESS_TOKEN || '1fb500014123ab7f55c31f3a999f1d98';
const BLESS_LAUNCH = encodeURIComponent(JSON.stringify({
  headless: false,
  args    : ['--window-size=1920,1080']
}));

/* ========= Diretórios (mantidos p/ compat) ========= */
const INSTANCE_ID       = process.env.HOSTNAME || os.hostname() || crypto.randomBytes(8).toString('hex');
const BASE_DATA_DIR     = path.join(__dirname, 'data');
const INSTANCE_DATA_DIR = path.join(BASE_DATA_DIR, INSTANCE_ID);
if (!fs.existsSync(BASE_DATA_DIR))     fs.mkdirSync(BASE_DATA_DIR);
if (!fs.existsSync(INSTANCE_DATA_DIR)) fs.mkdirSync(INSTANCE_DATA_DIR);

/* =================== Token cache =================== */
let tokenData = {};          // espelho em memória (sincronizado c/ Redis)

/* ---------- helpers p/ persistir no Redis ---------- */
function redisKey(token) {
  return `tokenData:${token}`;
}
async function persistToken(token) {
  await redis.set(redisKey(token), JSON.stringify(tokenData[token]));
}
async function saveAllTokens() {
  const pipeline = redis.pipeline();
  Object.entries(tokenData).forEach(([token, data]) => {
    pipeline.set(redisKey(token), JSON.stringify(data));
  });
  await pipeline.exec();
  if (global.gc) { global.gc(); }
}

/* -------- Inicialização / carregamento -------- */
async function initOrLoadTokens() {
  const allTokens = [...freeTokens, ...premiumTokens];
  const now   = new Date();
  const month = now.getMonth();
  const year  = now.getFullYear();

  for (const token of allTokens) {
    const stored = await redis.get(redisKey(token));
    if (stored) {
      tokenData[token] = JSON.parse(stored);
      continue;
    }

    /* não existia no Redis ⇒ cria com defaults */
    let type, resetDay;
    if (freeTokens.includes(token)) {
      type     = 'free';
      resetDay = freeResetDays[freeTokens.indexOf(token)]   || 1;
    } else {
      type     = 'premium';
      resetDay = premiumResetDays[premiumTokens.indexOf(token)] || 1;
    }
    tokenData[token] = {
      type,
      resetDay,
      count             : 0,
      month,
      year,
      concurrentRequests: 0,
      cooldownUntil     : null
    };
    await persistToken(token);
  }
}

/* ------------ Demais funções (inalteradas salvo persistToken) ------------ */
function getMaxApiCalls(token) {
  return tokenData[token].type === 'premium' ? 250_000 : 1_000;
}

function calculateRemainingCalls() {
  let totalRemaining = 0;
  const remainingByToken = {};
  [...freeTokens, ...premiumTokens].forEach(token => {
    const data    = tokenData[token];
    const max     = getMaxApiCalls(token);
    const remain  = max - data.count;
    remainingByToken[token] = remain;
    totalRemaining         += remain;
  });
  return { remainingByToken, totalRemaining };
}

function logProxyUsage(usedToken) {
  const { remainingByToken, totalRemaining } = calculateRemainingCalls();
  console.log(`Token utilizado: ${usedToken}`);
  console.log('Quantidade restante por token:');
  Object.keys(remainingByToken).forEach(t => {
    console.log(`- ${t}: ${remainingByToken[t]} chamadas restantes`);
  });
  console.log(`Quantidade total restante: ${totalRemaining} chamadas\n`);
}

function getAvailableToken(list) {
  const shuffled = [...list].sort(() => 0.5 - Math.random());
  const now      = Date.now();
  for (const token of shuffled) {
    const data = tokenData[token];
    if (data.cooldownUntil && now < data.cooldownUntil) continue;
    if (data.count < getMaxApiCalls(token) && data.concurrentRequests < 5) {
      return token;
    }
  }
  return null;
}
function getToken() {
  return getAvailableToken(premiumTokens) || getAvailableToken(freeTokens);
}

/* ------------ Fallback “bless” ------------- */
async function tryBlessScrape(url) {
  const endpoint = `https://bless.neuralbase.com.br/content?token=${BLESS_TOKEN}&launch=${BLESS_LAUNCH}`;
  const body = {
    url,
    gotoOptions: { waitUntil: 'networkidle2', timeout: 45_000 }
  };
  const headers = {
    'Cache-Control': 'no-cache',
    'Content-Type' : 'application/json'
  };
  const resp = await axios.post(endpoint, body, { headers, responseType: 'text' });
  return resp.data;
}

/* --------------- Scraping / proxy --------------- */
async function tryScrapeWithParams(url, token) {
  const attempts = [
    { extraParams: {},                  cost: 1 },
    { extraParams: { geoCode: 'br' },   cost: 1 },
    { extraParams: { render : 'true' }, cost: 5 },
    { extraParams: { super  : 'true' }, cost:10 }
  ];
  const data = tokenData[token];
  let lastErr = null;

  for (const attempt of attempts) {
    if (data.count >= getMaxApiCalls(token)) throw new Error(`Token ${token} estourou limite.`);
    if (data.concurrentRequests >= 5)       throw new Error(`Token ${token} limite de concorrência.`);

    data.count             += attempt.cost;
    data.concurrentRequests++;
    await persistToken(token);

    try {
      const params = { token, url, ...attempt.extraParams };
      const resp   = await axios.get('https://api.scrape.do', { params });
      data.concurrentRequests--;
      await persistToken(token);
      return resp.data;
    } catch (err) {
      data.concurrentRequests--;
      await persistToken(token);
      lastErr = err;
      if (err.response && err.response.status === 429) {
        console.log(`Token ${token} rate-limited – cooldown 1 min`);
        data.cooldownUntil = Date.now() + 60_000;
        await persistToken(token);
        throw err;
      }
    }
  }

  /* ---------- Fallback final via bless ---------- */
  try {
    console.log('Tentando fallback via bless…');
    const blessData = await tryBlessScrape(url);
    return blessData;
  } catch (err) {
    console.log('Fallback bless falhou.');
    if (lastErr) throw lastErr;
    throw err;
  }
}

/* ------------- Reset mensal dos contadores ------------- */
async function resetTokenCounts() {
  const now   = new Date();
  const day   = now.getDate();
  const month = now.getMonth();
  const year  = now.getFullYear();

  for (const token of Object.keys(tokenData)) {
    const data = tokenData[token];
    if (day === data.resetDay && (data.month !== month || data.year !== year)) {
      data.count             = 0;
      data.month             = month;
      data.year              = year;
      data.concurrentRequests= 0;
      data.cooldownUntil     = null;
      console.log(`Contador resetado para ${token}`);
      await persistToken(token);
    }
  }
  if (global.gc) global.gc();
}

/* ------------------- Request queue ------------------- */
const requestQueue = [];
async function processRequest(req, res, tokenFromQueue = null) {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL não fornecida.' });

  /* === tenta direto antes de qualquer proxy === */
  try {
    const direct = await axios.get(url);
    console.log(`Requisição direta p/ ${url} OK`);
    return res.send(direct.data);
  } catch {
    console.log('Direto falhou, usando proxy/bless...');
  }

  /* ====================== fluxo de proxy ====================== */
  let token = tokenFromQueue;
  const tried = new Set();

  while (true) {
    if (!token) token = getToken();

    /* --------- não há tokens configurados -> bless direto --------- */
    if (!token && premiumTokens.length === 0 && freeTokens.length === 0) {
      try {
        console.log('Nenhum token configurado – usando bless diretamente.');
        const blessData = await tryBlessScrape(url);
        return res.send(blessData);
      } catch (err) {
        console.log(`Erro bless direto: ${err.message}`);
        return res.status(err.response?.status || 500).json({
          error  : 'Erro no fallback bless',
          details: err.message
        });
      }
    }

    /* --------- tokens configurados mas nenhum disponível -> fila --------- */
    if (!token || tried.has(token)) {
      console.log('Sem tokens disponíveis – enfileirando.');
      requestQueue.push({ req, res });
      return;
    }
    tried.add(token);

    const data = tokenData[token];
    if (data.count >= getMaxApiCalls(token) || data.concurrentRequests >= 5) {
      token = null;
      continue;
    }

    try {
      const result = await tryScrapeWithParams(url, token);
      // log da URL quando usar proxy
      console.log(`Requisição via proxy p/ ${url} com token ${token} OK`);
      logProxyUsage(token);
      if (requestQueue.length) processQueue();
      return res.send(result);
    } catch (err) {
      if (err.response && err.response.status === 429) {
        console.log(`Token ${token} em cooldown, tentando próximo...`);
        token = null;
        continue;
      }
      console.log(`Erro token ${token}: ${err.message}`);
      return res.status(err.response?.status || 500).json({
        error  : `Erro na API de scraping com token ${token}`,
        details: err.message
      });
    }
  }
}

function processQueue() {
  if (!requestQueue.length) return;

  /* se fila existir mas não há tokens, tenta bless */
  if (premiumTokens.length === 0 && freeTokens.length === 0) {
    const { req, res } = requestQueue.shift();
    processRequest(req, res);
    return;
  }

  const token = getToken();
  if (!token) return;
  const { req, res } = requestQueue.shift();
  processRequest(req, res, token);
}

/* -------------------- Rotas -------------------- */
app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));
app.get('/readyz',  (_req, res) => {
  fs.access(INSTANCE_DATA_DIR, fs.constants.R_OK | fs.constants.W_OK, err => {
    if (err) return res.status(500).json({ status: 'error', message: 'Data dir inacessível' });
    res.status(200).json({ status: 'ready' });
  });
});
app.get('/fetch', (req, res) => processRequest(req, res));

/* =============== Bootstrap assíncrono =============== */
(async () => {
  await initOrLoadTokens();                     
  setInterval(() => saveAllTokens().catch(console.error), 60_000);
  setInterval(() => resetTokenCounts().catch(console.error), 3_600_000);

  const server = app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
  });

  function shutdown() {
    console.log('Shutting down gracefully…');
    server.close(async () => {
      console.log('Connections closed.');
      await redis.quit();
      process.exit(0);
    });
    setTimeout(() => { console.error('Forçando shutdown.'); process.exit(1); }, 10_000);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);
})();
