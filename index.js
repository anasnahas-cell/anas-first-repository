const axios = require('axios');
const cron = require('node-cron');
const http = require('http');

// ============================================================
// الإعدادات الأساسية.
// ============================================================
const CONFIG = {
  TELEGRAM_TOKEN: '8655790784:AAFpiIu5mX3Je3jhMJ68Sih8iIfMsflpbns',
  TELEGRAM_CHAT_ID: '656032699',
  SCAN_INTERVAL: '*/10 * * * *',
  MAX_SYMBOLS: 300,
  TIMEFRAME: '4h',
  MAX_GAP: 4,
  PROXY_SOURCES: [
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
    'https://www.proxy-list.download/api/v1/get?type=http',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt'
  ]
};

// ============================================================
// جلب Proxies من المصادر
// ============================================================
let proxyList = [];
let currentProxyIndex = 0;

async function fetchProxiesFromSources() {
  for (const source of CONFIG.PROXY_SOURCES) {
    try {
      console.log(`🌐 جلب Proxies من: ${source}`);
      const response = await axios.get(source, { timeout: 15000 });
      const lines = response.data.split('\n').filter(line => line.trim() && !line.startsWith('#'));
      const proxies = lines.map(line => {
        const parts = line.trim().split(':');
        if (parts.length === 2) return `http://${parts[0]}:${parts[1]}`;
        return null;
      }).filter(p => p);
      if (proxies.length > 0) {
        console.log(`✅ تم جلب ${proxies.length} Proxy من ${source}`);
        return proxies;
      }
    } catch (error) {
      console.log(`❌ فشل جلب Proxies من ${source}: ${error.message}`);
    }
  }
  return [];
}

async function refreshProxyList() {
  console.log('🔄 جلب قائمة جديدة من الـ Proxies...');
  const newProxies = await fetchProxiesFromSources();
  if (newProxies.length > 0) {
    proxyList = newProxies;
    currentProxyIndex = 0;
    console.log(`✅ تم تحديث قائمة الـ Proxies: ${proxyList.length} Proxy`);
  } else {
    console.log('⚠️ لم يتم جلب أي Proxy، سيتم استخدام القائمة السابقة إن وجدت');
  }
}

// ============================================================
// جلب البيانات مع Proxy (بدون اختبار مسبق)
// ============================================================
async function fetchWithProxy(url) {
  // إذا كانت القائمة فارغة، نجلب Proxies جديدة
  if (proxyList.length === 0) {
    await refreshProxyList();
  }

  // نبدأ من آخر Proxy ناجح
  let attempts = 0;
  while (attempts < proxyList.length) {
    const proxy = proxyList[currentProxyIndex % proxyList.length];
    currentProxyIndex++;
    attempts++;

    try {
      const parsed = new URL(proxy);
      const config = {
        timeout: 15000,
        proxy: {
          protocol: parsed.protocol.replace(':', ''),
          host: parsed.hostname,
          port: parseInt(parsed.port) || 80
        }
      };
      const response = await axios.get(url, config);
      console.log(`✅ Proxy يعمل: ${proxy}`);
      return response.data;
    } catch (error) {
      console.log(`❌ Proxy ${proxy} فشل: ${error.message}`);
    }
  }

  // إذا فشلت جميع الـ Proxies، نجرب تحديث القائمة
  console.log('🔄 جميع الـ Proxies فشلت، جاري تحديث القائمة...');
  await refreshProxyList();
  throw new Error('جميع الـ Proxies فشلت');
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
    console.error('❌ فشل جلب العملات:', error.message);
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
// باقي الكود (نفسه)
// ============================================================
let sentSignals = new Set();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatPrice(p) {
  if (!p && p !== 0) return '-';
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(6);
  return p.toFixed(8);
}

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

async function sendTelegramMessage(symbol, data) {
  const shortSymbol = symbol.replace('USDT', '');
  const message = `📊 *إشارة تداول جديدة!*

💰 *العملة:* ${shortSymbol}/USDT
📈 *سعر الشراء:* ${formatPrice(data.buyPrice)}
💵 *السعر الحالي:* ${formatPrice(data.currentPrice)}
🎯 *جني الأرباح:* ${formatPrice(data.takeProfit)}
📈 *نسبة الربح:* +${data.tpPct.toFixed(2)}%
🛑 *وقف الخسارة:* ${formatPrice(data.stopLoss)}
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
      if (i % 10 === 0) await sleep(100);
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

console.log('🤖 بدء تشغيل سكرينر العملات (مع جلب Proxies تلقائي)');
console.log(`⏱️ الفحص كل 10 دقائق`);
console.log(`📊 الإطار الزمني: ${CONFIG.TIMEFRAME}`);
console.log(`🔍 البحث عن: E=1 و B=0`);
console.log(`🌐 سيتم جلب Proxies من 3 مصادر مختلفة`);
console.log('');

// جلب Proxies أول مرة
refreshProxyList().then(() => {
  scan();
});

// جدولة الفحص
cron.schedule(CONFIG.SCAN_INTERVAL, () => {
  scan();
});

// تجديد قائمة الـ Proxies كل ساعة
cron.schedule('0 * * * *', () => {
  refreshProxyList();
});

process.on('SIGINT', () => {
  console.log('\n👋 تم إيقاف التشغيل');
  process.exit();
});
