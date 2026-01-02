import { env } from "cloudflare:workers";
import { assetLabels } from './assets.js';

/* =======================
   CONSTANTES & UTILS
======================= */

const RATE_LIMIT_DELAY = 13000;

const TTL = {
  PRICE: 24 * 60 * 60 * 1000,
  RSI_WEEKLY: 7 * 24 * 60 * 60 * 1000,
  RSI_MONTHLY: 30 * 24 * 60 * 60 * 1000
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();
const isExpired = (ts, ttl) => !ts || now() - ts > ttl;

/* =======================
   ALPHA VANTAGE
======================= */

async function alphaFetch(url) {
  await sleep(RATE_LIMIT_DELAY);

  const res = await fetch(url);
  const data = await res.json();

  if (data?.Note || data?.Information || data?.message) {
    throw new Error('AlphaVantage quota exceeded');
  }

  return data;
}

/* =======================
   DATA FETCHERS (CACHED)
======================= */

async function getRSI(symbol, interval, env) {
  const cacheKey = `RSI_${interval}_${symbol}`;
  const ttl = interval === 'weekly' ? TTL.RSI_WEEKLY : TTL.RSI_MONTHLY;

  const cached = await env.ASSET_CACHE.get(cacheKey, 'json');
  if (cached && !isExpired(cached.ts, ttl)) return cached;

  const url =
    `https://www.alphavantage.co/query?function=RSI` +
    `&symbol=${symbol}&interval=${interval}` +
    `&time_period=14&series_type=close` +
    `&apikey=${env.ALPHA_VANTAGE_API_KEY}`;

  try {
    const data = await alphaFetch(url);
    const rsi = data['Technical Analysis: RSI'];
    const keys = Object.keys(rsi);

    const result = {
      current: parseFloat(rsi[keys[0]].RSI),
      previous: parseFloat(rsi[keys[1]].RSI),
      ts: now()
    };

    await env.ASSET_CACHE.put(cacheKey, JSON.stringify(result));
    return result;

  } catch (e) {
    console.log(`RSI error ${symbol} ${interval}`, e.message);
    return cached ?? null;
  }
}

async function getPrice(symbol, env) {
  const cacheKey = `PRICE_${symbol}`;
  const cached = await env.ASSET_CACHE.get(cacheKey, 'json');

  if (cached && !isExpired(cached.ts, TTL.PRICE)) {
    return cached.value;
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=1d`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    const result = data?.chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close;

    if (!Array.isArray(closes)) {
      throw new Error('Invalid Yahoo Finance response');
    }

    // On prend la DERNIÈRE clôture non null
    const lastClose = [...closes].reverse().find(v => typeof v === 'number');

    if (typeof lastClose !== 'number') {
      throw new Error('No valid closing price');
    }

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
   FORMATAGE MESSAGE
======================= */

const arrow = (c, p) =>
  typeof c === 'number' && typeof p === 'number'
    ? c > p ? '⬈' : c < p ? '⬊' : '➞'
    : '➞';

const safe = v => typeof v === 'number' ? v.toFixed(2) : 'N/A';

function assetMessage(label, w, m, price) {
  return (
    `*📊 ${label}*\n` +
    `• *RSI Hebdo* : \`${safe(w?.current)}\` ${arrow(w?.current, w?.previous)}\n` +
    `• *RSI Mensuel* : \`${safe(m?.current)}\` ${arrow(m?.current, m?.previous)}\n` +
    `• *Prix* : \`${safe(price)} €\`\n\n`
  );
}

/* =======================
   TELEGRAM
======================= */

async function sendTelegram(chatId, text, env) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_API_KEY}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown'
    })
  });
}

/* =======================
   MESSAGE BUILDERS
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
    if (req.method !== 'POST') return new Response('OK');

    const update = await req.json();
    const chatId = update.message?.chat?.id;
    const text = update.message?.text;

    if (!chatId || !text) return new Response('OK');

    const allowed = env.ALLOWED_CHAT_IDS
      .split(',')
      .map(id => parseInt(id.trim(), 10));

    if (!allowed.includes(chatId)) {
      console.log('Unauthorized chat:', chatId);
      return new Response('Unauthorized', { status: 403 });
    }

    /* /start */
    if (text === '/start') {
      const keyboard = Object.values(assetLabels).map(l => [l]);
      keyboard.push(['Tous les actifs']);

      await sendTelegram(chatId, 'Sélectionne un actif 👇', env);
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_API_KEY}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: 'Menu',
          reply_markup: { keyboard, resize_keyboard: true }
        })
      });
      return new Response('OK');
    }

    /* Tous les actifs */
    if (text === 'Tous les actifs') {
      const msg = await buildAllAssetsMessage(env);
      await sendTelegram(chatId, msg, env);
      return new Response('OK');
    }

    /* Actif unique */
    const symbol = Object.keys(assetLabels).find(k => assetLabels[k] === text);
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