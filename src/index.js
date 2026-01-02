import { env } from "cloudflare:workers";
import { assetLabels } from './assets.js';

const RATE_LIMIT_DELAY = 20000; // 13 secondes pour AlphaVantage
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Fetch sécurisé pour AlphaVantage avec gestion de rate limit et erreurs
 */
async function alphaFetch(url, env) {
  await sleep(RATE_LIMIT_DELAY); // respect du rate limit
  try {
    const res = await fetch(url);
    const data = await res.json();

    // Gestion des erreurs AlphaVantage
    if (data.Note) {
      console.warn("AlphaVantage rate limit exceeded:", data.Note);
      return { error: "rate_limit", message: data.Note };
    }
    if (data["Error Message"]) {
      console.warn("AlphaVantage invalid symbol:", data["Error Message"]);
      return { error: "invalid_symbol", message: data["Error Message"] };
    }

    return data;
  } catch (err) {
    console.error("AlphaVantage fetch failed:", err);
    return { error: "fetch_failed", message: err.message };
  }
}

/**
 * Récupère le RSI sécurisé
 */
async function getRSI(symbol, interval, env) {
  const url = `https://www.alphavantage.co/query?function=RSI&symbol=${symbol}&interval=${interval}&time_period=14&series_type=close&apikey=${env.ALPHA_VANTAGE_API_KEY}`;
  const data = await alphaFetch(url, env);

  if (data.error || !data['Technical Analysis: RSI']) {
    return { current: null, previous: null };
  }

  const keys = Object.keys(data['Technical Analysis: RSI']);
  if (keys.length < 2) return { current: null, previous: null };

  return {
    current: parseFloat(data['Technical Analysis: RSI'][keys[0]].RSI),
    previous: parseFloat(data['Technical Analysis: RSI'][keys[1]].RSI)
  };
}

/**
 * Récupère le prix sécurisé
 */
async function getPrice(symbol, env) {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&apikey=${env.ALPHA_VANTAGE_API_KEY}`;
  const data = await alphaFetch(url, env);

  if (data.error || !data['Time Series (Daily)']) return null;

  const keys = Object.keys(data['Time Series (Daily)']);
  if (keys.length === 0) return null;

  return parseFloat(data['Time Series (Daily)'][keys[0]]['4. close']);
}

/**
 * Calcul flèche de tendance sécurisée
 */
const arrow = (current, previous) => {
  if (typeof current === "number" && typeof previous === "number") {
    return current > previous ? "⬈" : current < previous ? "⬊" : "➞";
  }
  return "➞"; // flèche neutre si données manquantes
};

/**
 * Construction du message pour un actif
 */
function assetMessage(label, w, m, price) {
  const safeNumber = (num) => (typeof num === "number" ? num.toFixed(2) : "N/A");

  return (
    `*📊 ${label}*\n` +
    `• *RSI Hebdo* : \`${safeNumber(w?.current)}\` ${arrow(w?.current, w?.previous)}\n` +
    `• *RSI Mensuel* : \`${safeNumber(m?.current)}\` ${arrow(m?.current, m?.previous)}\n` +
    `• *Prix* : \`${typeof price === "number" ? price.toFixed(2) : "N/A"} €\`\n\n`
  );
}

/**
 * Envoi d'un message Telegram
 */
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

/**
 * Construire le message pour tous les actifs
 */
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

/**
 * Worker fetch
 */
export default {
  async fetch(req, env) {
    if (req.method !== 'POST') return new Response('OK');

    const update = await req.json();
    const chatId = update.message?.chat?.id;
    const text = update.message?.text;

    const allowedChatIds = env.ALLOWED_CHAT_IDS.split(',').map(id => parseInt(id));

    if (!allowedChatIds.includes(chatId)) {
      console.log(`Unauthorized access attempt: ${chatId}`);
      return new Response("Unauthorized", { status: 403 });
    }

    if (!chatId || !text) return new Response('OK');

    // Commande /start
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

    // Tous les actifs
    if (text === 'Tous les actifs') {
      const msg = await buildAllAssetsMessage(env);
      await sendTelegram(chatId, msg, env);
      return new Response('OK');
    }

    // Un actif spécifique
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