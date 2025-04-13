require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Parse tokens and reset days from env
const freeTokens = process.env.FREE_TOKENS ? process.env.FREE_TOKENS.split(',') : [];
const freeResetDays = process.env.FREE_RESET_DAYS ? process.env.FREE_RESET_DAYS.split(',').map(Number) : [];

const premiumTokens = process.env.PREMIUM_TOKENS ? process.env.PREMIUM_TOKENS.split(',') : [];
const premiumResetDays = process.env.PREMIUM_RESET_DAYS ? process.env.PREMIUM_RESET_DAYS.split(',').map(Number) : [];

// File to persist token data
const TOKEN_DATA_FILE = path.join(__dirname, 'tokenData.json');

let tokenData = {};

// Função para inicializar tokenData
function initTokenData() {
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  tokenData = {};

  // Inicializar tokens gratuitos
  for (let i = 0; i < freeTokens.length; i++) {
    const token = freeTokens[i];
    const resetDay = freeResetDays[i] || 1; // Default para 1 se não especificado

    tokenData[token] = {
      type: 'free',
      resetDay: resetDay,
      count: 0,
      month: currentMonth,
      year: currentYear,
      concurrentRequests: 0,
      cooldownUntil: null // Para gerenciar cooldown de rate limiting
    };
  }

  // Inicializar tokens premium
  for (let i = 0; i < premiumTokens.length; i++) {
    const token = premiumTokens[i];
    const resetDay = premiumResetDays[i] || 1; // Default para 1 se não especificado

    tokenData[token] = {
      type: 'premium',
      resetDay: resetDay,
      count: 0,
      month: currentMonth,
      year: currentYear,
      concurrentRequests: 0,
      cooldownUntil: null // Para gerenciar cooldown de rate limiting
    };
  }
}

// Função para inicializar tokenData para tokens novos
function initTokenDataForNewTokens() {
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  const allTokens = [...freeTokens, ...premiumTokens];

  allTokens.forEach((token) => {
    if (!tokenData[token]) {
      // Determinar o tipo e resetDay do token
      let type, resetDay;
      if (freeTokens.includes(token)) {
        type = 'free';
        const idx = freeTokens.indexOf(token);
        resetDay = freeResetDays[idx] || 1;
      } else {
        type = 'premium';
        const idx = premiumTokens.indexOf(token);
        resetDay = premiumResetDays[idx] || 1;
      }

      // Inicializar o tokenData para o novo token
      tokenData[token] = {
        type: type,
        resetDay: resetDay,
        count: 0,
        month: currentMonth,
        year: currentYear,
        concurrentRequests: 0,
        cooldownUntil: null
      };

      console.log(`Novo token detectado e inicializado: ${token}`);
    }
  });
}

// Função para carregar tokenData do arquivo
function loadTokenData() {
  if (fs.existsSync(TOKEN_DATA_FILE)) {
    const rawData = fs.readFileSync(TOKEN_DATA_FILE);
    tokenData = JSON.parse(rawData);

    // Inicializar tokens novos que não estão no tokenData
    initTokenDataForNewTokens();
  } else {
    initTokenData();
  }
}

// Função para salvar tokenData no arquivo
function saveTokenData() {
  fs.writeFileSync(TOKEN_DATA_FILE, JSON.stringify(tokenData, null, 2));
}

// Carregar tokenData na inicialização
loadTokenData();

// Salvar tokenData periodicamente
setInterval(saveTokenData, 60 * 1000); // A cada 1 minuto

// Função para resetar contadores dos tokens no dia de reset
function resetTokenCounts() {
  const now = new Date();
  const currentDay = now.getDate();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  Object.keys(tokenData).forEach(token => {
    const data = tokenData[token];
    const resetDay = data.resetDay;

    if (currentDay === resetDay && (data.month !== currentMonth || data.year !== currentYear)) {
      // Resetar o contador
      data.count = 0;
      data.month = currentMonth;
      data.year = currentYear;
      data.concurrentRequests = 0;
      data.cooldownUntil = null;
      console.log(`Contador resetado para o token ${token}`);
    }
  });
}

// Resetar contadores a cada hora
setInterval(resetTokenCounts, 60 * 60 * 1000); // A cada 1 hora

// Fila de requisições
const requestQueue = [];

// Função para obter o máximo de chamadas da API para um token
function getMaxApiCalls(token) {
  const data = tokenData[token];
  return data.type === 'premium' ? 250000 : 1000;
}

// Função para calcular chamadas restantes
function calculateRemainingCalls() {
  let totalRemaining = 0;
  const remainingByToken = {};

  const allTokens = [...freeTokens, ...premiumTokens];

  allTokens.forEach(token => {
    const data = tokenData[token];
    const maxApiCalls = getMaxApiCalls(token);
    const remaining = maxApiCalls - data.count;
    remainingByToken[token] = remaining;
    totalRemaining += remaining;
  });

  return { remainingByToken, totalRemaining };
}

// Função para registrar o uso do proxy
function logProxyUsage(usedToken) {
  const { remainingByToken, totalRemaining } = calculateRemainingCalls();

  console.log(`Token utilizado: ${usedToken}`);
  console.log('Quantidade restante por token:');
  Object.keys(remainingByToken).forEach(token => {
    console.log(`- ${token}: ${remainingByToken[token]} chamadas restantes`);
  });
  console.log(`Quantidade total restante: ${totalRemaining} chamadas\n`);
}

// Função para obter um token disponível aleatoriamente
function getAvailableToken(tokenList) {
  // Embaralhar a lista de tokens
  const shuffledTokens = [...tokenList].sort(() => 0.5 - Math.random());

  const now = Date.now();

  for (let token of shuffledTokens) {
    const data = tokenData[token];

    // Verificar se o token está em cooldown
    if (data.cooldownUntil && now < data.cooldownUntil) {
      continue; // Token ainda está em cooldown
    }

    const maxApiCalls = getMaxApiCalls(token);
    const maxConcurrentRequests = 5;

    if (data.count < maxApiCalls && data.concurrentRequests < maxConcurrentRequests) {
      return token;
    }
  }
  return null;
}

// Função para obter um token (priorizando premium, depois free)
function getToken() {
  // Tenta obter um token premium disponível
  let token = getAvailableToken(premiumTokens);
  if (token) return token;

  // Tenta obter um token gratuito disponível
  token = getAvailableToken(freeTokens);
  if (token) return token;

  // Se nenhum token estiver disponível, retorna null
  return null;
}

// Função para processar a fila de requisições
function processQueue() {
  if (requestQueue.length === 0) {
    return;
  }

  // Verifica se há algum token disponível
  const token = getToken();
  if (!token) {
    // Nenhum token disponível, não pode processar a próxima requisição
    return;
  }

  // Obtém a próxima requisição na fila
  const { req, res } = requestQueue.shift();

  // Processa a requisição com o token disponível
  processRequest(req, res, token);
}

// <<< Alterado >>>
// Função auxiliar para fazer requisições ao scrape.do com retentativas de parâmetros
async function tryScrapeWithParams(url, token) {
  /**
   * A ordem de tentativas será:
   * 1) Nenhum parâmetro extra (padrão)
   * 2) geoCode=br            (se a primeira falhar)
   * 3) render=true           (se a segunda falhar) -> consome 5 créditos
   * 4) super=true            (se a terceira falhar) -> consome 10 créditos
   *
   * Ao final, se todas falharem, jogamos o erro para ser tratado.
   */

  // Parâmetros de tentativas em sequência
  const attempts = [
    { extraParams: {},                cost: 1 },  // sem nada extra
    { extraParams: { geoCode: 'br' }, cost: 1 },  // geoCode=br
    { extraParams: { render: 'true' }, cost: 5 }, // render=true
    { extraParams: { super: 'true' },  cost: 10 } // super=true
  ];

  // Precisamos do objeto data do token para atualizar contadores
  const data = tokenData[token];

  let lastError = null;

  for (const attempt of attempts) {
    // Se o token estiver com usage estourado, paramos
    const maxApiCalls = getMaxApiCalls(token);
    if (data.count >= maxApiCalls) {
      // Lança erro para tratar fora
      throw new Error(`Token ${token} estourou o limite de chamadas (count=${data.count}).`);
    }

    // Verifica também se concurrency está disponível
    if (data.concurrentRequests >= 5) {
      throw new Error(`Token ${token} atingiu o limite de concorrência.`);
    }

    // Incrementa contadores antes da requisição
    data.count += attempt.cost;       // consome X créditos
    data.concurrentRequests++;

    try {
      // Monta os parâmetros da chamada
      const scrapeParams = {
        token,
        url,
        ...attempt.extraParams
      };

      // Faz a requisição ao scrape.do
      const scrapeResponse = await axios.get('https://api.scrape.do', {
        params: scrapeParams,
      });

      // Decrementa concurrentRequests
      data.concurrentRequests--;

      // Deu certo, retorna o body
      return scrapeResponse.data;

    } catch (err) {
      // Decrementa concurrentRequests
      data.concurrentRequests--;

      lastError = err;

      // Se for 429, coloca o token em cooldown e tenta outro token no loop externo
      if (err.response && err.response.status === 429) {
        console.log(`Token ${token} está rate limitado (429). Marcando como indisponível por 1 minuto.`);
        tokenData[token].cooldownUntil = Date.now() + 60 * 1000; // 1 minuto
        // Lança esse erro para forçar o while(true) a pegar outro token
        throw err;
      }

      // Se for outro tipo de erro (ex: 502, 403, etc), a gente só tenta o próximo "attempt" 
      // com outro parâmetro, sem colocar token em cooldown. 
      // O loop continua e passamos para a próxima config.
    }
  }

  // Se chegou aqui, é pq TODAS as tentativas falharam
  if (lastError) {
    // Lançamos o último erro capturado para ser tratado fora.
    throw lastError;
  }
}

// <<< Alterado >>>
async function processRequest(req, res, tokenFromQueue = null) {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'URL não fornecida.' });
  }

  try {
    // 1) Tenta a requisição direta via HTTP
    const response = await axios.get(url);

    // Se chegar aqui, a requisição direta foi bem-sucedida
    console.log(`Requisição direta para ${url} bem-sucedida. Nenhum token utilizado.\n`);
    return res.send(response.data);

  } catch (directError) {
    console.log('Requisição direta falhou, tentando via scraping API.');

    // 2) Como a requisição direta falhou, vamos tentar via proxy
    let token = tokenFromQueue;
    // Lista de tokens já tentados
    const triedTokens = new Set();

    while (true) {
      // Se não veio token na fila, obtém um token disponível
      if (!token) {
        token = getToken();
      }

      // Se não houver tokens ou se já tentamos esse token, enfileira
      if (!token || triedTokens.has(token)) {
        console.log('Todos os tokens estão ocupados ou indisponíveis, colocando a requisição na fila.');
        requestQueue.push({ req, res });
        return;
      }

      // Marca este token como tentado
      triedTokens.add(token);

      // Verifica disponibilidade do token
      const data = tokenData[token];
      const maxApiCalls = getMaxApiCalls(token);

      if (data.count >= maxApiCalls || data.concurrentRequests >= 5) {
        // Token não disponível, tenta outro
        token = null;
        continue;
      }

      // Tenta efetivamente com esse token, nas 4 variações (sem param extra, geoCode, render, super)
      try {
        const scrapeResult = await tryScrapeWithParams(url, token);

        // Se deu certo, loga o uso (pelo menos uma chamada foi feita)
        logProxyUsage(token);

        // Processa a próxima requisição na fila (caso haja)
        processQueue();

        // Retorna o resultado para o cliente
        return res.send(scrapeResult);

      } catch (scrapeError) {
        // Em caso de erro, ver se foi 429 (cooldown aplicado) ou outro erro
        if (scrapeError.response && scrapeError.response.status === 429) {
          // Token entrou em cooldown, vamos tentar outro token
          console.log(`Token ${token} foi colocado em cooldown, tentando outro token...`);
          token = null;
          continue;
        } else {
          // Se for outro tipo de erro que não entrou no cooldown, 
          // significa que falhou em todas as tentativas (geoCode, render, super).
          // Vamos retornar o erro ao cliente.
          console.log(`Falha ao usar o token ${token}: ${scrapeError.message}. Retornando erro ao cliente.`);
          return res.status(scrapeError.response?.status || 500).json({
            error: `Erro ao acessar a API de scraping com o token ${token}.`,
            details: scrapeError.message
          });
        }
      }
    } // while(true)
  }
}

// Rota principal
app.get('/fetch', (req, res) => {
  processRequest(req, res);
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
