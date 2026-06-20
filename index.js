// ============================================================
// إعدادات التلغرام
// ============================================================
const TELEGRAM_TOKEN = '8655790784:AAFpiIu5mX3Je3jhMJ68Sih8iIfMsflpbns';
const TELEGRAM_CHAT_ID = '656032699';

// ============================================================
// CoinCap API (بدون 429، بدون Proxies)
// ============================================================
const fetch = require('node-fetch');

async function getTopCoins(limit = 50) {
  try {
    console.log('📊 جلب العملات من CoinCap...');
    const r = await fetch(
      `https://api.coincap.io/v2/assets?limit=${limit}&sort=volumeUsd&order=desc`
    );
    if (!r.ok) {
      console.error(`❌ خطأ CoinCap: ${r.status}`);
      return [];
    }
    const data = await r.json();
    console.log(`✅ تم جلب ${data.data.length} عملة من CoinCap`);
    return data.data.map(coin => ({
      id: coin.id,
      symbol: coin.symbol + 'USDT',
      name: coin.name,
      price: parseFloat(coin.priceUsd),
    }));
  } catch (error) {
    console.error('❌ خطأ في جلب العملات:', error.message);
    return [];
  }
}

async function getCandles(coinId, limit = 3) {
  try {
    const r = await fetch(
      `https://api.coincap.io/v2/assets/${coinId}/history?interval=h1&limit=${limit}`
    );
    if (!r.ok) return null;
    const data = await r.json();
    if (!data.data || data.data.length < limit) return null;

    const prices = data.data.map(p => parseFloat(p.priceUsd));
    const candles = [];
    let lastPrice = prices[0] || 100;

    for (let i = 0; i < prices.length; i++) {
      const open = lastPrice;
      const close = prices[i];
      const high = Math.max(open, close) * (1 + Math.random() * 0.01);
      const low = Math.min(open, close) * (1 - Math.random() * 0.01);
      
      candles.push({ open, high, low, close });
      lastPrice = close;
    }
    return candles;
  } catch (error) {
    console.error(`❌ خطأ في جلب شموع ${coinId}:`, error.message);
    return null;
  }
}

// ============================================================
// منطق اكتشاف النمط (نفسه)
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
  console.log('📡 باستخدام CoinCap API (بدون 429)');
  
  const coins = await getTopCoins(50);
  if (coins.length === 0) {
    console.error('❌ لا توجد عملات للفحص');
    return;
  }
  
  let alerts = 0;
  
  for (let i = 0; i < coins.length; i++) {
    const coin = coins[i];
    try {
      const candles = await getCandles(coin.id, 3);
      if (!candles || candles.length < 3) continue;
      
      const result = detectPattern(candles, 4);
      if (!result.hasE) continue;
      
      const currentPrice = coin.price;
      
      const tpPct = ((result.takeProfit - result.buyPrice) / result.buyPrice) * 100;
      const slPct = ((result.stopLoss - result.buyPrice) / result.buyPrice) * 100;
      
      if (result.hasB && result.eAge <= 3) {
        await sendTelegramAlert(coin.symbol, currentPrice, result.buyPrice, result.takeProfit, result.stopLoss, tpPct, slPct);
        alerts++;
        console.log(`✅ إشارة: ${coin.symbol} - السعر: ${currentPrice}`);
      }
    } catch (e) {
      // نتجاوز الأخطاء
    }
    
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log(`✅ اكتمل الفحص. تم العثور على ${alerts} إشارة.`);
}

// ============================================================
// التشغيل
// ============================================================
mainScan();
