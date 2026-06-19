const axios = require('axios');
const cron = require('node-cron');
const https = require('https');
const http = require('http');

// ============================================================
// الإعدادات - ضع التوكن الخاص بك هنا
// ============================================================
const CONFIG = {
  TELEGRAM_TOKEN: '8655790784:AAFpiIu5mX3Je3jhMJ68Sih8iIfMsflpbns',   // ✅ توكنك
  TELEGRAM_CHAT_ID: '656032699',                                     // ✅ رقمك
  SCAN_INTERVAL: '*/10 * * * *',          // كل 10 دقائق
  MAX_SYMBOLS: 300,                       // عدد العملات للفحص
  TIMEFRAME: '4h',                        // الإطار الزمني (15m, 1h, 4h, 1d)
  MAX_GAP: 4,                             // الحد الأقصى للفجوة بين E و B
  // Proxy Settings
  USE_PROXY: true,                        // ✅ تفعيل Proxy
  PROXY_URL: 'http://185.199.229.156:7497',  // Proxy مجاني (قد يتغير)
};

// ============================================================
// إعداد Proxy Agent
// ============================================================
function getProxyAgent() {
  if (!CONFIG.USE_PROXY) return null;
  
  const proxyUrl = new URL(CONFIG.PROXY_URL);
  const isHttps = proxyUrl.protocol === 'https:';
  
  const agent = isHttps
    ? new https.Agent({ rejectUnauthorized: false })
    : new http.Agent();
  
  return {
    protocol: proxyUrl.protocol.replace(':', ''),
    host: proxyUrl.hostname,
    port: parseInt(proxyUrl.port) || (isHttps ? 443 : 80),
    agent: agent
  };
}

// ============================================================
// دوال Binance API مع Proxy
// ============================================================
async function fetchWithProxy(url) {
  try {
    const proxyConfig = getProxyAgent();
    const config = {
      timeout: 15000, // 15 ثانية مهلة
    };

    if (proxyConfig) {
      config.proxy = {
        protocol: proxyConfig.protocol,
        host: proxyConfig.host,
        port: proxyConfig.port,
      };
    }

    const response = await axios.get(url, config);
    return response.data;
  } catch (error) {
    console.error(`❌ خطأ في جلب البيانات:`, error.message);
    throw error;
  }
}

async function getTopSymbols() {
  try {
    const data = await fetchWithProxy('https://api.binance.com/api/v3/ticker/24hr');
    const usdt = data
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
    return usdt;
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
    console.error(`❌ خطأ في جلب بيانات ${symbol}:`, error.message);
    return null;
  }
}

// ============================================================
// باقي الكود (نفس الخوارزمية السابقة)
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

// ============================================================
// خوارزمية الكشف عن النمط (نفسها)
// ============================================================
function detectPattern(candles) {
  const n = candles.length;
  let result = {
    hasE: false,
    eAge: null,
    hasB: false,
    bAge: null,
    buyPrice: null,
    takeProfit: null,
    stopLoss: null,
    c1: null,
    c2: null,
    c3: null
  };

  let bestE = null;
  
  for (let i = 0; i < n - 1; i++) {
    const c1 = candles[i];
    const c2 = candles[i + 1];
    
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
  result.c1 = bestE.c1;
  result.c2 = bestE.c2;
  result.buyPrice = bestE.c1.high;
  result.takeProfit = bestE.c2.close;
  result.stopLoss = bestE.c2.low;

  const c1High = bestE.c1.high;
  let bestB = null;

  for (let j = bestE.i2 + 1; j <= Math.min(bestE.i2 + CONFIG.MAX_GAP, n - 1); j++) {
    const c3 = candles[j];
    if (c3.low <= c1High) {
      const bAge = (n - 1) - j;
      bestB = { j, c3, bAge };
    }
  }

  if (bestB) {
    result.hasB = true;
    result.bAge = bestB.bAge;
    result.c3 = bestB.c3;
  }

  return result;
}

// ============================================================
// إرسال رسالة إلى تيليغرام
// ============================================================
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
🕐 *عمر الإشارة E:* ${data.eAge === 0 ? 'الشمعة الحالية' : data.eAge + ' شمعة'}
🕐 *عمر الإشارة B:* ${data.bAge === 0 ? 'الشمعة الحالية' : data.bAge + ' شمعة'}

#${shortSymbol} #CryptoSignal`;

  try {
    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    });
    console.log(`✅ تم إرسال إشارة لـ ${shortSymbol} إلى تيليغرام`);
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
    console.log(`📋 تم جلب ${symbols.length} عملة للفحص`);
    
    let signalsFound = 0;

    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i];
      
      try {
        const candles = await getKlines(symbol);
        if (!candles || candles.length < 5) continue;
        
        const currentPrice = candles[candles.length - 1].close;
        const pat = detectPattern(candles);
        
        // التحقق من الشرطين: E=1 و B=0
        if (pat.hasE && pat.eAge === 1 && pat.hasB && pat.bAge === 0) {
          
          const pctFromBuy = ((currentPrice - pat.buyPrice) / pat.buyPrice) * 100;
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
              slPct: slPct,
              eAge: pat.eAge,
              bAge: pat.bAge
            });
          }
        }
      } catch (error) {
        // تخطي العملات التي تسبب خطأ
      }
      
      if (i % 10 === 0) await sleep(100);
    }
    
    console.log(`📊 اكتمل الفحص. تم العثور على ${signalsFound} إشارة جديدة.`);
    
  } catch (error) {
    console.error('❌ خطأ في الفحص:', error.message);
  }
}

// ============================================================
// تشغيل السكرينر
// ============================================================
console.log('🤖 بدء تشغيل سكرينر العملات مع تنبيهات تيليغرام...');
console.log(`⏱️ سيتم الفحص كل 10 دقائق (${CONFIG.SCAN_INTERVAL})`);
console.log(`📊 الإطار الزمني: ${CONFIG.TIMEFRAME}`);
console.log(`🔍 البحث عن: E=1 و B=0`);
console.log(`🔄 استخدام Proxy: ${CONFIG.USE_PROXY ? 'نعم' : 'لا'}`);
if (CONFIG.USE_PROXY) {
  console.log(`🌐 عنوان الـ Proxy: ${CONFIG.PROXY_URL}`);
}
console.log('');

// تنفيذ فحص أولي عند بدء التشغيل
scan();

// جدولة الفحص كل 10 دقائق
cron.schedule(CONFIG.SCAN_INTERVAL, () => {
  scan();
});

// ============================================================
// التعامل مع إيقاف التشغيل
// ============================================================
process.on('SIGINT', () => {
  console.log('\n👋 تم إيقاف التشغيل');
  process.exit();
});
