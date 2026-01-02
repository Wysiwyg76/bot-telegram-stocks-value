import { assetLabels } from './assets.js';

const RATE_LIMIT_DELAY = 13000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function alphaFetch(url, env) {
  await sleep(RATE_LIMIT_DELAY);
  const res = await fetch(url);
  return res.json();
}

async function getRSI(symbol, interval, env) {
  const url = `https://www.alphavantage.co/query?function=RSI&symbol=${symbol}&interval=${interval}&time_period=14&series_type=close&apikey=${env.ALPHA_VANTAGE_API_KEY}`;
  const data = await alphaFetch(url, env);
  const rsi = data['Technical Analysis: RSI'];
  const keys = Object.keys(rsi);
  return {
    current: parseFloat(rsi[keys[0]].RSI),
    previous: parseFloat(rsi[keys[1]].RSI)
  };
}

async function getPrice(symbol, env) {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&apikey=${env.ALPHA_VANTAGE_API_KEY}`;
  const data = await alphaFetch(url, env);
  const series = data['Time Series (Daily)'];
  return parseFloat(series[Object.keys(series)[0]]['4. close']);
}

const arrow = (c, p) => (c > p ? '⬈' : c < p ? '⬊' : '➞');

function assetMessage(label, w, m, price) {
  return (
    `*📊 ${label}*\n` +
    `• *RSI Hebdo* : \`${w.current.toFixed(2)}\` ${arrow(w.current, w.previous)}\n` +
    `• *RSI Mensuel* : \`${m.current.toFixed(2)}\` ${arrow(m.current, m.previous)}\n` +
    `• *Prix* : \`${price.toFixed(2)} €\`\n\n`
  );
}

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

async function buildAllAssetsMessage(env) {
  const date = new Date().toLocaleDateString('fr-FR');
  let msg = `*📅 ${date}*\n\n`;

  for (const s of Object.keys(assetLabels)) {
    const w = '';//await getRSI(s, 'weekly', env);
    const m = '';//await getRSI(s, 'monthly', env);
    const p = '';//await getPrice(s, env);
    //msg += assetMessage(assetLabels[s], w, m, p);
  }
  return msg;
}

export default {
  async fetch(req, env) {
    if (req.method !== 'POST') return new Response('OK');

    const update = await req.json();
    const chatId = update.message?.chat?.id;
    const text = update.message?.text;

    // Récupère les IDs autorisés depuis la variable d'environnement
    const allowedChatIds = env.ALLOWED_CHAT_IDS.split(',').map(id => parseInt(id));

    if (!allowedChatIds.includes(chatId)) {
      console.log(`Unauthorized access attempt: ${chatId}`);
      return new Response("Unauthorized", { status: 403 });
    }

    console.log("Received Telegram update:", update);

    if (!chatId || !text) return new Response('OK');

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

    if (text === 'Tous les actifs') {
      const msg = await buildAllAssetsMessage(env);
      await sendTelegram(chatId, msg, env);
      return new Response('OK');
    }

    const symbol = Object.keys(assetLabels).find(k => assetLabels[k] === text);
    if (!symbol) return new Response('OK');

    const date = new Date().toLocaleDateString('fr-FR');
    let msg = `*📅 ${date}*\n\n`;

    const w = '';//await getRSI(symbol, 'weekly', env);
    const m = '';//await getRSI(symbol, 'monthly', env);
    const p = '';//await getPrice(symbol, env);

    //msg += assetMessage(assetLabels[symbol], w, m, p);
    await sendTelegram(chatId, msg, env);

    return new Response('OK');
  },

  async scheduled(_, env) {
    const msg = await buildAllAssetsMessage(env);
    await sendTelegram(env.TELEGRAM_CHAT_ID, msg, env);
  }
};
