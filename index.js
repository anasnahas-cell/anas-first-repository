// ============================================================
// إعدادات التلغرام
// ============================================================
const TELEGRAM_TOKEN = '8655790784:AAFpiIu5mX3Je3jhMJ68Sih8iIfMsflpbns';
const TELEGRAM_CHAT_ID = '656032699';

// ============================================================
// دوال Binance API
// ============================================================
const BASE = 'https://api.binance.com/api/v3';

async function getTopSymbols(limit = 500) {
  const r = await fetch(`${BASE}/ticker/24hr`);
  const data = await r.json();
  return data
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('DOWN') && !t.symbol.includes('UP') && !t.symbol.includes('BULL') && !t.symbol.includes('BEAR'))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, limit)
    .map(t => t.symbol);
}

async function getKlines(symbol, interval = '4h', limit = 6) {
  const r = await fetch(`${BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!r.ok) return null;
  const data = await r.json();
  return data.map(k => ({
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
  }));
}

// ============================================================
// منطق اكتشاف النمط
// ============================================================
function detectPattern(candles, maxGap = 4) {
  const n = candles.length;
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
  
  if (!bestE) return { hasE: false, E: 0, B: 0 };
  
  const result = {
    hasE: true,
    hasB: false,
    E: 1,
    B: 0,
    eAge: bestE.eAge,
    buyPrice: bestE.c1.high,
    takeProfit: bestE.c2.close,
    stopLoss: bestE.c2.low,
    c1: bestE.c1,
    c2: bestE.c2,
  };
  
  const c1High = bestE.c1.high;
  for (let j = bestE.i2 + 1; j <= Math.min(bestE.i2 + maxGap, n - 1); j++) {
    const c3 = candles[j];
    if (c3.low <= c1High) {
      result.hasB = true;
      result.B = 0;
      result.bAge = (n - 1) - j;
      result.c3 = c3;
      break;
    }
  }
  
  return result;
}

// ============================================================
// إرسال تنبيه تلغرام
// ============================================================
async function sendTelegramAlert(symbol, price, buyPrice, tp, sl, tpPct, slPct) {
  const currencyName = symbol.replace('USDT', '');
  const message = `Currency Name : ${currencyName}\n` +
                  `Buy Entry Price : ${buyPrice.toFixed(4)}\n` +
                  `Current Price : ${price.toFixed(4)}\n` +
                  `Take Profit : ${tp.toFixed(4)}\n` +
                  `Profit Percentage : +${tpPct.toFixed(2)}%\n` +
                  `Stop Loss : ${sl.toFixed(4)}\n` +
                  `Loss Percentage : ${slPct.toFixed(2)}%`;
  
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message
      })
    });
    console.log(`✅ تم إرسال تنبيه لـ ${symbol}`);
  } catch (error) {
    console.error(`❌ فشل إرسال تنبيه لـ ${symbol}:`, error.message);
  }
}

// ============================================================
// الفحص الرئيسي
// ============================================================
async function mainScan() {
  console.log(`🔄 بدء الفحص - ${new Date().toLocaleString()}`);
  
  const symbols = await getTopSymbols(500);
  let alerts = 0;
  
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    try {
      const candles = await getKlines(sym, '4h', 6);
      if (!candles) continue;
      
      const result = detectPattern(candles, 4);
      if (!result.hasE) continue;
      
      const currentPrice = candles[candles.length - 1].close;
      
      const tpPct = ((result.takeProfit - result.buyPrice) / result.buyPrice) * 100;
      const slPct = ((result.stopLoss - result.buyPrice) / result.buyPrice) * 100;
      
      if (result.hasB && result.eAge <= 3) {
        await sendTelegramAlert(sym, currentPrice, result.buyPrice, result.takeProfit, result.stopLoss, tpPct, slPct);
        alerts++;
        console.log(`✅ إشارة: ${sym} - السعر: ${currentPrice}`);
      }
    } catch (e) {
      // نتجاوز الأخطاء
    }
    
    if (i % 10 === 0) await new Promise(r => setTimeout(r, 100));
  }
  
  console.log(`✅ اكتمل الفحص. تم العثور على ${alerts} إشارة.`);
}

// ============================================================
// التشغيل
// ============================================================
mainScan();
