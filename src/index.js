import { env } from "cloudflare:workers";
import { assetLabels } from './assets.js';

/* =======================
   CONSTANTES & UTILS
======================= */

const TTL = {
  PRICE: 24 * 60 * 60 * 1000,
  RSI_WEEKLY: 7 * 24 * 60 * 60 * 1000,
  RSI_MONTHLY: 30 * 24 * 60 * 60 * 1000
};

const now = () => Date.now();
const isExpired = (ts, ttl) => !ts || now() - ts > ttl;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));


/* =======================
   FETCH PRIX (Yahoo Finance)
======================= */

async function getPrice(symbol, env) {
  const cacheKey = `PRICE_${symbol}`;
  const cached = await env.ASSET_CACHE.get(cacheKey, 'json');
  if (cached && !isExpired(cached.ts, TTL.PRICE)) return cached.value;

  await sleep(1500); // pause pour ne pas spammer Yahoo

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=14d&interval=1d`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
        "Referer": "https://finance.yahoo.com/"
      }
    });
    const data = await res.json();
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    const lastClose = [...closes].reverse().find(v => typeof v === 'number');

    if (typeof lastClose !== 'number') throw new Error('No valid closing price');

    await env.ASSET_CACHE.put(
      cacheKey,
      JSON.stringify({ value: lastClose, ts: now() })
    );
    return lastClose;

  } catch (e) {
    console.log(`Yahoo price error ${symbol}`, e.message);
    return cached?.value ?? null;
  }
}

/* =======================
   RSI CALCULATOR
======================= */

function calculateRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/* =======================
   GET RSI (Hebdo / Mensuel)
======================= */

async function getRSI(symbol, interval, env) {
  const cacheKey = `RSI_${interval}_${symbol}`;
  const ttl = interval === 'weekly' ? TTL.RSI_WEEKLY : TTL.RSI_MONTHLY;

  // Vérifie cache
  const cached = await env.ASSET_CACHE.get(cacheKey, 'json');
  if (cached && !isExpired(cached.ts, ttl)) return cached;

  await sleep(1500); // pause pour ne pas spammer Yahoo

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5y&interval=${interval === 'weekly' ? '1wk' : '1mo'}`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
        "Referer": "https://finance.yahoo.com/"
      }
    });

    const data = await res.json();
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;

    if (!Array.isArray(closes) || closes.length < 15) {
      console.log(`Yahoo RSI warning: not enough data for ${symbol} ${interval}`);
      return cached ?? null;
    }

    // RSI actuel : dernières 14 périodes
    const currentRSI = calculateRSI(closes.slice(-15));

    // RSI précédent : 14 périodes avant la dernière
    const previousRSI = calculateRSI(closes.slice(-16, -1));

    const result = {
      current: currentRSI,
      previous: previousRSI,
      ts: now()
    };

    await env.ASSET_CACHE.put(cacheKey, JSON.stringify(result));
    return result;

  } catch (e) {
    console.log(`Yahoo RSI error ${symbol} ${interval}`, e.message);
    return cached ?? null;
  }
}

/* =======================
   FORMATAGE MESSAGE
======================= */

const arrow = (c, p) =>
  typeof c === 'number' && typeof p === 'number' ? c > p*1.01 ? '⬈' : c < p*0.99 ? '⬊' : '➞' : '➞';

const safe = v => typeof v === 'number' ? v.toFixed(1) : 'N/A';

function assetMessage(asset, w, m, price) {

  const currency = asset.currency || '?';

  return (
    `*${asset.name}*\n` +
    `  • Prix clôture : *\`${safe(price)} ${currency}*\`\n` +
    `  • RSI hebdo : *\`${safe(w?.current)}\` ${arrow(w?.current, w?.previous)}*\n` +
    `  • RSI mensuel : *\`${safe(m?.current)}\` ${arrow(m?.current, m?.previous)}*\n\n`
  );
}

/* =======================
   TELEGRAM
======================= */

async function sendTelegram(chatId, text, env) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_API_KEY}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
  });
}

/* =======================
   BUILD MESSAGE
======================= */

async function buildAllAssetsMessage(env) {
  const date = new Date().toLocaleDateString('fr-FR');
  let msg = `*📅 ${date}*\n\n`;

  for (const s of Object.keys(assetLabels)) {
    const w = await getRSI(s, 'weekly', env);
    const m = await getRSI(s, 'monthly', env);
    const p = await getPrice(s, env);

    msg += assetMessage(assetLabels[s], w, m, p);
  }
  return msg;
}

/* =======================
   WORKER
======================= */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // Ignore favicon / robots.txt
    if (url.pathname === '/favicon.ico' || url.pathname === '/robots.txt') {
      return new Response('Not Found', { status: 404 });
    }

    if (req.method !== 'POST') return new Response('OK');

    const update = await req.json();
    const chatId = update.message?.chat?.id;
    const text = update.message?.text;

    if (!chatId || !text) return new Response('OK');

    const allowed = env.ALLOWED_CHAT_IDS.split(',').map(id => parseInt(id.trim(), 10));
    if (!allowed.includes(chatId)) {
      console.log('Unauthorized chat:', chatId);
      return new Response('Unauthorized', { status: 403 });
    }

    if (text === '/start') {
      const keyboard = Object.values(assetLabels).map(l => [l]);
      keyboard.push(['Tous les actifs']);

      await sendTelegram(chatId, 'Sélectionne un actif 👇', env);
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_API_KEY}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: 'Menu', reply_markup: { keyboard, resize_keyboard: true } })
      });
      return new Response('OK');
    }

    if (text === 'Tous les actifs') {
      const msg = await buildAllAssetsMessage(env);
      await sendTelegram(chatId, msg, env);
      return new Response('OK');
    }

    const symbol = Object.keys(assetLabels).find(k => assetLabels[k].name === text);
    if (!symbol) return new Response('OK');

    const date = new Date().toLocaleDateString('fr-FR');
    let msg = `*📅 ${date}*\n\n`;

    const w = await getRSI(symbol, 'weekly', env);
    const m = await getRSI(symbol, 'monthly', env);
    const p = await getPrice(symbol, env);

    msg += assetMessage(assetLabels[symbol], w, m, p);
    await sendTelegram(chatId, msg, env);

    return new Response('OK');
  },

  async scheduled(_, env) {
    const msg = await buildAllAssetsMessage(env);
    await sendTelegram(env.TELEGRAM_CHAT_ID, msg, env);
  }
};