const axios = require('axios');
const cron = require('node-cron');
const http = require('http');

// ============================================================
// الإعدادات
// ============================================================
const CONFIG = {
  TELEGRAM_TOKEN: '8655790784:AAFpiIu5mX3Je3jhMJ68Sih8iIfMsflpbns',
  TELEGRAM_CHAT_ID: '656032699',
  SCAN_INTERVAL: '*/10 * * * *',
  MAX_SYMBOLS: 300,
  TIMEFRAME: '4h',
  MAX_GAP: 4,
  USE_PROXY: true,
  PROXY_URL: 'http://51.158.99.220:8811',  // ✅ Proxy جديد
};

// ============================================================
// إعداد Proxy Agent
// ============================================================
function getProxyConfig() {
  if (!CONFIG.USE_PROXY) return null;
  try {
    const url = new URL(CONFIG.PROXY_URL);
    return {
      protocol: url.protocol.replace(':', ''),
      host: url.hostname,
      port: parseInt(url.port) || 80,
    };
  } catch (e) {
    console.error('❌ خطأ في إعدادات Proxy:', e.message);
    return null;
  }
}

// ============================================================
// جلب البيانات مع Proxy
// ============================================================
async function fetchWithProxy(url) {
  try {
    const proxy = getProxyConfig();
    const config = {
      timeout: 20000,
      proxy: proxy || undefined,
    };
    const response = await axios.get(url, config);
    return response.data;
  } catch (error) {
    console.error(`❌ خطأ في جلب ${url}:`, error.message);
    throw error;
  }
}

// ============================================================
// دوال Binance API
// ============================================================
async function getTopSymbols() {
  try {
    const data = await fetchWithProxy('https://api.binance.com/api/v3/ticker/24hr');
    return data
      .filter(t => 
        t.symbol.endsWith('USDT') && 
        !t.symbol.includes('DOWNUSDT') && 
        !t.symbol.includes('UPUSDT') && 
        !t.symbol.includes('BULLUSDT') && 
        !t.symbol.includes('BEARUSDT')
      )
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, CONFIG.MAX_SYMBOLS)
      .map(t => t.symbol);
  } catch (error) {
    console.error('❌ خطأ في جلب قائمة العملات:', error.message);
    return [];
  }
}

async function getKlines(symbol, limit = 30) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${CONFIG.TIMEFRAME}&limit=${limit}`;
    const data = await fetchWithProxy(url);
    return data.map(k => ({
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
    }));
  } catch (error) {
    return null;
  }
}

// ============================================================
// خوارزمية الكشف (نفسها)
// ============================================================
function detectPattern(candles) {
  const n = candles.length;
  let result = {
    hasE: false, eAge: null,
    hasB: false, bAge: null,
    buyPrice: null, takeProfit: null, stopLoss: null
  };

  let bestE = null;
  for (let i = 0; i < n - 1; i++) {
    const c1 = candles[i], c2 = candles[i + 1];
    if (c1.close >= c1.open) continue;
    if (c2.close <= c2.open) continue;
    if (c2.low >= c1.low) continue;
    if (c2.close <= c1.high) continue;
    const age = (n - 1) - (i + 1);
    bestE = { i1: i, i2: i + 1, c1, c2, eAge: age };
  }
  if (!bestE) return result;

  result.hasE = true;
  result.eAge = bestE.eAge;
  result.buyPrice = bestE.c1.high;
  result.takeProfit = bestE.c2.close;
  result.stopLoss = bestE.c2.low;

  const c1High = bestE.c1.high;
  let bestB = null;
  for (let j = bestE.i2 + 1; j <= Math.min(bestE.i2 + CONFIG.MAX_GAP, n - 1); j++) {
    const c3 = candles[j];
    if (c3.low <= c1High) {
      bestB = { j, c3, bAge: (n - 1) - j };
    }
  }
  if (bestB) {
    result.hasB = true;
    result.bAge = bestB.bAge;
  }
  return result;
}

// ============================================================
// إرسال رسالة إلى تيليغرام
// ============================================================
let sentSignals = new Set();

async function sendTelegramMessage(symbol, data) {
  const shortSymbol = symbol.replace('USDT', '');
  const message = `📊 *إشارة تداول جديدة!*

💰 *العملة:* ${shortSymbol}/USDT
📈 *سعر الشراء:* ${data.buyPrice.toFixed(4)}
💵 *السعر الحالي:* ${data.currentPrice.toFixed(4)}
🎯 *جني الأرباح:* ${data.takeProfit.toFixed(4)}
📈 *نسبة الربح:* +${data.tpPct.toFixed(2)}%
🛑 *وقف الخسارة:* ${data.stopLoss.toFixed(4)}
📉 *نسبة الخسارة:* ${data.slPct.toFixed(2)}%

⏱️ *الإطار الزمني:* ${CONFIG.TIMEFRAME}
#${shortSymbol} #CryptoSignal`;

  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    });
    console.log(`✅ تم إرسال إشارة لـ ${shortSymbol}`);
  } catch (error) {
    console.error(`❌ فشل إرسال رسالة لـ ${shortSymbol}:`, error.message);
  }
}

// ============================================================
// دالة الفحص الرئيسية
// ============================================================
async function scan() {
  console.log(`\n🔍 بدء الفحص - ${new Date().toLocaleString('ar')}`);
  try {
    const symbols = await getTopSymbols();
    console.log(`📋 تم جلب ${symbols.length} عملة`);
    let signalsFound = 0;

    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i];
      try {
        const candles = await getKlines(symbol);
        if (!candles || candles.length < 5) continue;
        const currentPrice = candles[candles.length - 1].close;
        const pat = detectPattern(candles);

        if (pat.hasE && pat.eAge === 1 && pat.hasB && pat.bAge === 0) {
          const tpPct = ((pat.takeProfit - pat.buyPrice) / pat.buyPrice) * 100;
          const slPct = ((pat.stopLoss - pat.buyPrice) / pat.buyPrice) * 100;
          const signalKey = `${symbol}_${pat.eAge}_${pat.bAge}`;

          if (!sentSignals.has(signalKey)) {
            sentSignals.add(signalKey);
            signalsFound++;
            await sendTelegramMessage(symbol, {
              buyPrice: pat.buyPrice,
              currentPrice: currentPrice,
              takeProfit: pat.takeProfit,
              stopLoss: pat.stopLoss,
              tpPct: tpPct,
              slPct: slPct
            });
          }
        }
      } catch (e) {}
      if (i % 10 === 0) await new Promise(r => setTimeout(r, 100));
    }
    console.log(`📊 اكتمل الفحص. تم العثور على ${signalsFound} إشارة جديدة.`);
  } catch (error) {
    console.error('❌ خطأ في الفحص:', error.message);
  }
}

// ============================================================
// خادم HTTP لإبقاء المنفذ مفتوحاً
// ============================================================
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Crypto Scanner Bot is running!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌐 خادم HTTP يعمل على المنفذ ${PORT}`);
});

// ============================================================
// تشغيل السكرينر
// ============================================================
console.log('🤖 بدء تشغيل سكرينر العملات...');
console.log(`⏱️ الفحص كل 10 دقائق`);
console.log(`📊 الإطار الزمني: ${CONFIG.TIMEFRAME}`);
console.log(`🔍 البحث عن: E=1 و B=0`);
console.log(`🔄 استخدام Proxy: ${CONFIG.USE_PROXY ? 'نعم' : 'لا'}`);
if (CONFIG.USE_PROXY) console.log(`🌐 Proxy: ${CONFIG.PROXY_URL}`);
console.log('');

scan();
cron.schedule(CONFIG.SCAN_INTERVAL, () => scan());

process.on('SIGINT', () => {
  console.log('\n👋 تم إيقاف التشغيل');
  process.exit();
});
