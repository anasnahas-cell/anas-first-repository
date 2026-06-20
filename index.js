// ============================================================
// إعدادات التلغرام
// ============================================================
const TELEGRAM_TOKEN = '8655790784:AAFpiIu5mX3Je3jhMJ68Sih8iIfMsflpbns';
const TELEGRAM_CHAT_ID = '656032699';

// ============================================================
// استيراد ccxt مع Bybit (بديل Binance)
// ============================================================
const ccxt = require('ccxt');

// إنشاء عميل Bybit (ما بيحظر مثل Binance)
const exchange = new ccxt.bybit({
  options: {
    defaultType: 'spot',  // التداول الفوري (Spot)
  },
  enableRateLimit: true,  // يتحكم بالتأخير بين الطلبات تلقائياً
});

// ============================================================
// جلب أفضل 500 عملة حسب السيولة من Bybit
// ============================================================
async function getTopSymbols(limit = 500) {
  try {
    console.log('📊 جلب قائمة العملات من Bybit...');
    const tickers = await exchange.fetchTickers();
    
    // تصفية العملات التي تنتهي بـ /USDT
    const symbols = Object.keys(tickers)
      .filter(sym => sym.endsWith('/USDT'))
      .sort((a, b) => {
        const volA = tickers[a].quoteVolume || 0;
        const volB = tickers[b].quoteVolume || 0;
        return volB - volA;
      })
      .slice(0, limit);
    
    console.log(`✅ تم جلب ${symbols.length} عملة من Bybit`);
    return symbols;
  } catch (error) {
    console.error('❌ خطأ في جلب العملات من Bybit:', error.message);
    return [];
  }
}

// ============================================================
// جلب شموع عملة معينة من Bybit
// ============================================================
async function getKlines(symbol, interval = '4h', limit = 6) {
  try {
    const candles = await exchange.fetchOHLCV(symbol, interval, undefined, limit);
    return candles.map(c => ({
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
    }));
  } catch (error) {
    console.error(`❌ خطأ في جلب شموع ${symbol}:`, error.message);
    return null;
  }
}

// ============================================================
// منطق اكتشاف النمط (E و B)
// ============================================================
function detectPattern(candles, maxGap = 4) {
  const n = candles.length;
  let bestE = null;
  
  for (let i = 0; i < n - 1; i++) {
    const c1 = candles[i];
    const c2 = candles[i + 1];
    // C1: شمعة حمراء
    if (c1.close >= c1.open) continue;
    // C2: شمعة خضراء
    if (c2.close <= c2.open) continue;
    // قاع C2 أقل من قاع C1
    if (c2.low >= c1.low) continue;
    // إغلاق C2 أعلى من قمة C1 (ابتلاع كامل)
    if (c2.close <= c1.high) continue;
    
    const age = (n - 1) - (i + 1);
    bestE = { i1: i, i2: i + 1, c1, c2, eAge: age };
  }
  
  if (!bestE) return { hasE: false, E: 0, B: 0 };
  
  const result = {
    hasE: true,
    hasB: false,
    E: 1,                    // ✅ عمود E = 1 عند تحقق الشرط
    B: 0,                    // ✅ عمود B = 0 افتراضياً
    eAge: bestE.eAge,
    buyPrice: bestE.c1.high,
    takeProfit: bestE.c2.close,
    stopLoss: bestE.c2.low,
  };
  
  // البحث عن إشارة B (عودة السعر لمستوى الشراء)
  const c1High = bestE.c1.high;
  for (let j = bestE.i2 + 1; j <= Math.min(bestE.i2 + maxGap, n - 1); j++) {
    const c3 = candles[j];
    if (c3.low <= c1High) {
      result.hasB = true;
      result.B = 0;          // ✅ عمود B = 0 عند تحقق الشرط
      result.bAge = (n - 1) - j;
      result.c3 = c3;
      break;
    }
  }
  
  return result;
}

// ============================================================
// إرسال تنبيه تلغرام (بالصيغة المطلوبة)
// ============================================================
async function sendTelegramAlert(symbol, price, buyPrice, tp, sl, tpPct, slPct) {
  const currencyName = symbol.replace('/USDT', '');
  const message = `Currency Name : ${currencyName}\n` +
                  `Buy Entry Price : ${buyPrice.toFixed(4)}\n` +
                  `Current Price : ${price.toFixed(4)}\n` +
                  `Take Profit : ${tp.toFixed(4)}\n` +
                  `Profit Percentage : +${tpPct.toFixed(2)}%\n` +
                  `Stop Loss : ${sl.toFixed(4)}\n` +
                  `Loss Percentage : ${slPct.toFixed(2)}%`;
  
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message
      })
    });
    if (response.ok) {
      console.log(`✅ تم إرسال تنبيه لـ ${symbol}`);
    } else {
      console.error(`❌ فشل إرسال تنبيه لـ ${symbol}: ${response.status}`);
    }
  } catch (error) {
    console.error(`❌ فشل إرسال تنبيه لـ ${symbol}:`, error.message);
  }
}

// ============================================================
// الفحص الرئيسي
// ============================================================
async function mainScan() {
  console.log(`🔄 بدء الفحص - ${new Date().toLocaleString()}`);
  console.log('📡 باستخدام Bybit API (بديل Binance)');
  
  const symbols = await getTopSymbols(500);
  if (symbols.length === 0) {
    console.error('❌ لا توجد عملات للفحص');
    return;
  }
  
  let alerts = 0;
  
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    try {
      const candles = await getKlines(sym, '4h', 6);
      if (!candles || candles.length < 5) continue;
      
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
    
    // تأخير بسيط لتجنب الـ Rate Limits
    if (i % 10 === 0) await new Promise(r => setTimeout(r, 100));
  }
  
  console.log(`✅ اكتمل الفحص. تم العثور على ${alerts} إشارة.`);
}

// ============================================================
// التشغيل
// ============================================================
mainScan();
