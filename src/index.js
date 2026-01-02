import { env } from "cloudflare:workers";
import { assetLabels } from "./assets.js";

/* =======================
   CONFIGURATION
======================= */

const RATE_LIMIT_DELAY = 13000;

const TTL_PRICE = 6 * 60 * 60;        // 6h
const TTL_RSI_WEEKLY = 24 * 60 * 60;  // 24h
const TTL_RSI_MONTHLY = 7 * 24 * 60 * 60; // 7j
const TTL_ERROR = 5 * 60;             // 5 min

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* =======================
   ALPHAVANTAGE FETCH
======================= */

async function alphaFetch(url, cacheKey, ttl, env) {
  // Cache
  const cached = await env.ASSET_CACHE.get(cacheKey, { type: "json" });
  if (cached) return cached;

  await sleep(RATE_LIMIT_DELAY);

  try {
    const res = await fetch(url);
    const data = await res.json();

    // AlphaVantage errors
    if (data.Note || data["Error Message"]) {
      const err = { error: true, message: data.Note || data["Error Message"] };
      await env.ASSET_CACHE.put(cacheKey, JSON.stringify(err), {
        expirationTtl: TTL_ERROR
      });
      return err;
    }

    await env.ASSET_CACHE.put(cacheKey, JSON.stringify(data), {
      expirationTtl: ttl
    });

    return data;
  } catch (e) {
    const err = { error: true, message: e.message };
    await env.ASSET_CACHE.put(cacheKey, JSON.stringify(err), {
      expirationTtl: TTL_ERROR
    });
    return err;
  }
}

/* =======================
   RSI
======================= */

async function getRSI(symbol, interval, env) {
  const ttl = interval === "weekly" ? TTL_RSI_WEEKLY : TTL_RSI_MONTHLY;
  const cacheKey = `RSI_${interval}_${symbol}`;

  const url =
    `https://www.alphavantage.co/query?function=RSI` +
    `&symbol=${symbol}&interval=${interval}` +
    `&time_period=14&series_type=close` +
    `&apikey=${env.ALPHA_VANTAGE_API_KEY}`;

  const data = await alphaFetch(url, cacheKey, ttl, env);

  if (data.error || !data["Technical Analysis: RSI"]) {
    return { current: null, previous: null };
  }

  const keys = Object.keys(data["Technical Analysis: RSI"]);
  if (keys.length < 2) return { current: null, previous: null };

  return {
    current: parseFloat(data["Technical Analysis: RSI"][keys[0]].RSI),
    previous: parseFloat(data["Technical Analysis: RSI"][keys[1]].RSI)
  };
}

/* =======================
   PRICE
======================= */

async function getPrice(symbol, env) {
  const cacheKey = `PRICE_${symbol}`;

  const url =
    `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY` +
    `&symbol=${symbol}&apikey=${env.ALPHA_VANTAGE_API_KEY}`;

  const data = await alphaFetch(url, cacheKey, TTL_PRICE, env);

  if (data.error || !data["Time Series (Daily)"]) return null;

  const key = Object.keys(data["Time Series (Daily)"])[0];
  return parseFloat(data["Time Series (Daily)"][key]["4. close"]);
}

/* =======================
   MESSAGE
======================= */

const arrow = (c, p) =>
  typeof c === "number" && typeof p === "number"
    ? c > p ? "⬈" : c < p ? "⬊" : "➞"
    : "➞";

const fmt = v => (typeof v === "number" ? v.toFixed(2) : "N/A");

function assetMessage(label, w, m, price) {
  return (
    `*📊 ${label}*\n` +
    `• *RSI Hebdo* : \`${fmt(w?.current)}\` ${arrow(w?.current, w?.previous)}\n` +
    `• *RSI Mensuel* : \`${fmt(m?.current)}\` ${arrow(m?.current, m?.previous)}\n` +
    `• *Prix* : \`${fmt(price)} €\`\n\n`
  );
}

/* =======================
   TELEGRAM
======================= */

async function sendTelegram(chatId, text, env) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_API_KEY}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown"
    })
  });
}

/* =======================
   BUILD MESSAGE
======================= */

async function buildAllAssetsMessage(env) {
  const date = new Date().toLocaleDateString("fr-FR");
  let msg = `*📅 ${date}*\n\n`;

  for (const symbol of Object.keys(assetLabels)) {
    const w = await getRSI(symbol, "weekly", env);
    const m = await getRSI(symbol, "monthly", env);
    const p = await getPrice(symbol, env);

    msg += assetMessage(assetLabels[symbol], w, m, p);
  }

  return msg;
}

/* =======================
   WORKER
======================= */

export default {
  async fetch(req, env) {
    if (req.method !== "POST") return new Response("OK");

    const update = await req.json();
    const chatId = update.message?.chat?.id;
    const text = update.message?.text;

    if (!chatId || !text) return new Response("OK");

    const allowed = env.ALLOWED_CHAT_IDS
      .split(",")
      .map(id => parseInt(id));

    if (!allowed.includes(chatId)) {
      console.log("Unauthorized:", chatId);
      return new Response("Forbidden", { status: 403 });
    }

    // START
    if (text === "/start") {
      const keyboard = Object.values(assetLabels).map(l => [l]);
      keyboard.push(["Tous les actifs"]);

      await sendTelegram(chatId, "Sélectionne un actif 👇", env);
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_API_KEY}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "Menu",
          reply_markup: { keyboard, resize_keyboard: true }
        })
      });
      return new Response("OK");
    }

    // ALL
    if (text === "Tous les actifs") {
      await sendTelegram(chatId, await buildAllAssetsMessage(env), env);
      return new Response("OK");
    }

    // SINGLE
    const symbol = Object.keys(assetLabels).find(k => assetLabels[k] === text);
    if (!symbol) return new Response("OK");

    const date = new Date().toLocaleDateString("fr-FR");
    const w = await getRSI(symbol, "weekly", env);
    const m = await getRSI(symbol, "monthly", env);
    const p = await getPrice(symbol, env);

    await sendTelegram(
      chatId,
      `*📅 ${date}*\n\n` + assetMessage(assetLabels[symbol], w, m, p),
      env
    );

    return new Response("OK");
  },

  async scheduled(_, env) {
    const msg = await buildAllAssetsMessage(env);
    await sendTelegram(env.TELEGRAM_CHAT_ID, msg, env);
  }
};