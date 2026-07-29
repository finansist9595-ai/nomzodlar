import React, { useState, useEffect, useRef, useMemo } from 'react';
import { LineChart, Line, ResponsiveContainer, YAxis, ReferenceLine } from 'recharts';
import {
  Plus, X, RefreshCw, AlertCircle,
  ChevronDown, ChevronUp, Key, Settings2, ListChecks, Gauge, Square, ExternalLink, Maximize2, Minimize2
} from 'lucide-react';

const STORAGE_KEY = 'nomzodlar-terminal-state-v1';

const COLORS = {
  void: '#0A0E17',
  surface: '#121828',
  surfaceRaised: '#1A2236',
  hairline: '#2A3350',
  textPrimary: '#EDEBE2',
  textMuted: '#8790A8',
  brass: '#C9A24B',
  brassDim: '#8A7434',
  positive: '#3FBF8F',
  negative: '#E8615C',
};

/* ============================================================
   INDICATOR MATH — verified independently before integration
   ============================================================ */

function smaAt(values, period, endIndex) {
  if (endIndex - period + 1 < 0) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) sum += values[i];
  return sum / period;
}

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  out[period - 1] = seed;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function rsiWilder(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff; else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function macdCalc(closes, fast = 12, slow = 26, signalP = 9) {
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine = closes.map((_, i) => (emaFast[i] != null && emaSlow[i] != null) ? emaFast[i] - emaSlow[i] : null);
  const firstValid = macdLine.findIndex(v => v !== null);
  if (firstValid === -1) return { macdLine, signalLine: new Array(closes.length).fill(null), hist: new Array(closes.length).fill(null) };
  const compact = macdLine.slice(firstValid);
  const signalCompact = emaSeries(compact, signalP);
  const signalLine = new Array(closes.length).fill(null);
  for (let i = 0; i < signalCompact.length; i++) {
    if (signalCompact[i] != null) signalLine[firstValid + i] = signalCompact[i];
  }
  const hist = macdLine.map((v, i) => (v != null && signalLine[i] != null) ? v - signalLine[i] : null);
  return { macdLine, signalLine, hist };
}

/* ============================================================
   PROFESSIONAL STRATEGY DETECTORS
   Each verified independently with synthetic data before being wired in here.
   ============================================================ */

function findSwingPoints(bars, lookback = 3) {
  const highs = [], lows = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    const wH = bars.slice(i - lookback, i + lookback + 1).map(b => b.high);
    const wL = bars.slice(i - lookback, i + lookback + 1).map(b => b.low);
    if (bars[i].high === Math.max(...wH)) highs.push({ index: i, price: bars[i].high });
    if (bars[i].low === Math.min(...wL)) lows.push({ index: i, price: bars[i].low });
  }
  return { highs, lows };
}

function classifySwings(points) {
  return points.map((p, i) => (i === 0 ? { ...p, tag: null } : { ...p, tag: p.price > points[i - 1].price ? 'higher' : 'lower' }));
}

function clusterZones(points, tolerancePct = 0.025, minTouches = 2) {
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const p of sorted) {
    let placed = false;
    for (const c of clusters) {
      if (Math.abs(p.price - c.avgPrice) / c.avgPrice <= tolerancePct) {
        c.touches.push(p); c.avgPrice = c.touches.reduce((s, t) => s + t.price, 0) / c.touches.length; placed = true; break;
      }
    }
    if (!placed) clusters.push({ avgPrice: p.price, touches: [p] });
  }
  return clusters.filter(c => c.touches.length >= minTouches).map(c => ({ price: c.avgPrice, touchCount: c.touches.length, lastIndex: Math.max(...c.touches.map(t => t.index)) }));
}

function detectBreakout(bars) {
  const closes = bars.map(b => b.close);
  const lastIdx = closes.length - 1;
  const price = closes[lastIdx];
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const { highs, lows } = findSwingPoints(bars, 3);
  const zones = clusterZones(highs, 0.025, 2);

  const criteria = [];

  // 1) To'g'ridan-to'g'ri 1 yillik taqqoslash: hozirgi narx ~252 savdo kuni oldingi narxdan yuqorimi.
  const yearAgoIdx = Math.max(0, lastIdx - 252);
  const uptrend = price > closes[yearAgoIdx];
  criteria.push({ id: 'uptrend', label: 'Yillik uptrend (1 yil oldingi narxdan yuqori)', passed: uptrend, detail: `1 yil oldin: $${closes[yearAgoIdx].toFixed(2)}, hozir: $${price.toFixed(2)}` });

  const relevantZones = zones.filter(z => z.lastIndex < lastIdx - 1 && z.price < price * 1.15 && z.price > price * 0.7);
  const nearestZone = relevantZones.sort((a, b) => b.lastIndex - a.lastIndex)[0];
  const broken = nearestZone ? price > nearestZone.price : false;
  const strong = nearestZone ? price > nearestZone.price * 1.005 : false;
  criteria.push({
    id: 'resistance_break', label: 'Qarshilikni buzib o\u2018tish (2+ tegilgan)', passed: broken,
    detail: nearestZone ? `Zona: $${nearestZone.price.toFixed(2)} (${nearestZone.touchCount}x tegilgan)${broken && !strong ? ' \u2014 kuchsiz, retest kutish tavsiya etiladi' : ''}` : 'Aniq qarshilik zonasi topilmadi',
  });

  const vol5 = bars.slice(-5).reduce((s, b) => s + (b.volume || 0), 0) / 5;
  const vol20 = bars.slice(-25, -5).reduce((s, b) => s + (b.volume || 0), 0) / 20;
  const volUp = vol20 > 0 && vol5 > vol20 * 1.1;
  criteria.push({ id: 'volume', label: 'Hajm o\u2018sishi', passed: volUp, detail: vol20 > 0 ? `${(vol5 / vol20).toFixed(2)}x o\u2018rtachaga nisbatan` : 'ma\u2018lumot yetarli emas' });

  // 4) Higher Low -- kamida 2 marta (bitta emas), konsolidatsiyadan chiqish belgisi.
  const hlCount = countRecentClassification(lows, 'higher', 5);
  criteria.push({ id: 'higher_low', label: 'Higher Low (kamida 2 marta)', passed: hlCount >= 2, detail: `${hlCount} marta topildi` });

  // 5) EMA tartibi -- alohida mezon sifatida.
  const emaOrder = ema20[lastIdx] != null && ema50[lastIdx] != null && price > ema20[lastIdx] && price > ema50[lastIdx];
  criteria.push({ id: 'ema_order', label: 'Narx EMA20 va EMA50dan yuqori', passed: emaOrder });

  let crossedRecently = false;
  for (let i = Math.max(1, lastIdx - 10); i <= lastIdx; i++) {
    if (ema20[i] != null && ema50[i] != null && ema20[i - 1] != null && ema50[i - 1] != null) {
      if (ema20[i] > ema50[i] && ema20[i - 1] <= ema50[i - 1]) { crossedRecently = true; break; }
    }
  }
  criteria.push({ id: 'ema_cross_bonus', label: '(qo\u2018shimcha) EMA20>EMA50 yangi kesishuvi', passed: crossedRecently, bonus: true });

  const coreCriteria = criteria.filter(c => !c.bonus);
  const corePassed = coreCriteria.filter(c => c.passed).length;
  return { matched: corePassed === coreCriteria.length, criteria, corePassed, coreTotal: coreCriteria.length };
}

// Ixtiyoriy, qo'shimcha tasdiq: Higher Low'ni soatlik ma'lumotda tekshirish (foydalanuvchi
// tasvirlagan "bu narsa soatlikda aniqroq ko'rinadi" mezoni). Breakout'ning asosiy 5 mezoniga
// TA'SIR QILMAYDI -- faqat qo'shimcha, ixtiyoriy "chuqur tekshiruv" sifatida ko'rsatiladi.
function detectBreakoutHourlyHL(hourlyBars) {
  const { lows } = findSwingPoints(hourlyBars, 3);
  const hlCount = countRecentClassification(lows, 'higher', 5);
  return { hlCount, confirmed: hlCount >= 2 };
}

// ---- Reversal: split into a cheap DAILY pre-check (data we already have) and an
// expensive HOURLY deep-check (only fetched for stocks that already pass the pre-check) ----

// Umumiy "darvoza": narx haqiqatan ham so\u2018nggi ~6 oyning muhim qismida (oxirgi 20 kundan tashqari)
// EMA200'dan pastda bo\u2018lganmi? Bu -- MRK kabi, katta uptrend ichidagi mahalliy pauzani chinakam
// yillik downtrenddan ajratib beruvchi asosiy tekshiruv (uzoq, sun\u2018iy MRK-o\u2018xshash misolda tasdiqlangan).
function genuineDowntrendGate(bars) {
  const closes = bars.map(b => b.close);
  const ema200 = emaSeries(closes, 200);
  const lastIdx = bars.length - 1;
  const windowStart = Math.max(0, lastIdx - 180);
  const windowEnd = Math.max(windowStart, lastIdx - 20);
  let belowCount = 0, validCount = 0;
  for (let i = windowStart; i <= windowEnd; i++) {
    if (ema200[i] != null) { validCount++; if (closes[i] < ema200[i]) belowCount++; }
  }
  const bearishShare = validCount > 0 ? belowCount / validCount : 0;
  return { passed: bearishShare >= 0.35, bearishShare };
}

function detectDowntrendLineBreak(bars, gatePassed = true, lookback = 3) {
  if (!gatePassed) return { hasLine: false, broken: false };
  const { highs } = findSwingPoints(bars, lookback);
  if (highs.length < 2) return { hasLine: false, broken: false };
  let bestP1 = null, bestP2 = null;
  for (let end = highs.length - 1; end >= 1; end--) {
    if (highs[end].price < highs[end - 1].price) { bestP1 = highs[end - 1]; bestP2 = highs[end]; break; }
  }
  if (!bestP1) return { hasLine: false, broken: false };
  const slope = (bestP2.price - bestP1.price) / (bestP2.index - bestP1.index);
  const lastIdx = bars.length - 1;
  const projected = bestP2.price + slope * (lastIdx - bestP2.index);
  const price = bars[lastIdx].close;
  return { hasLine: true, lineValue: projected, broken: price > projected, p1: bestP1, p2: bestP2 };
}

// EMA20 va EMA50 munosabati (narx-vs-o\u2018z-EMA20si emas): EMA20 avval EMA50'dan pastda, endi
// yuqoriga kesib o\u2018tgan yoki juda yaqinlashgan bo\u2018lishi kerak -- foydalanuvchi tasvirlagan
// aniq mezon.
function detectEma20CrossEma50(closes, gatePassed, recentWindow = 15) {
  if (!gatePassed) return false;
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const lastIdx = closes.length - 1;
  const price = closes[lastIdx];
  // Narx EMA20dan "biroz baland" bo'lishi kerak (0-5%) -- endigina qaytarilgan, hali uzoqlashib
  // ketmagan holat, foydalanuvchi tasvirlagan aniq mezon.
  if (ema20[lastIdx] == null || !(price > ema20[lastIdx] && price < ema20[lastIdx] * 1.05)) return false;
  for (let i = Math.max(1, lastIdx - recentWindow); i <= lastIdx; i++) {
    if (ema20[i] != null && ema50[i] != null) {
      if (ema20[i] > ema50[i]) return true;
      if (ema50[i] - ema20[i] > 0 && (ema50[i] - ema20[i]) / ema50[i] < 0.01) return true;
    }
  }
  return false;
}

function findBullishGaps(bars) {
  const gaps = [];
  for (let i = 1; i < bars.length; i++) if (bars[i].low > bars[i - 1].high) gaps.push({ index: i, gapTop: bars[i].low });
  return gaps;
}

function countRecentClassification(points, tag, lastN = 5) {
  return classifySwings(points).slice(-lastN).filter(p => p.tag === tag).length;
}

function detectReversalDaily(bars) {
  const closes = bars.map(b => b.close);
  const gate = genuineDowntrendGate(bars);
  const dt = detectDowntrendLineBreak(bars, gate.passed);
  const emaCross = detectEma20CrossEma50(closes, gate.passed);
  const vol5 = bars.slice(-5).reduce((s, b) => s + (b.volume || 0), 0) / 5;
  const vol20 = bars.slice(-25, -5).reduce((s, b) => s + (b.volume || 0), 0) / 20;
  const volUp = vol20 > 0 && vol5 > vol20 * 1.1;
  const criteria = [
    { id: 'genuine_downtrend', label: 'Yillik kontekstda chinakam downtrend bo\u2018lgani', passed: gate.passed, detail: `EMA200'dan past kunlar ulushi: ${(gate.bearishShare * 100).toFixed(0)}%` },
    { id: 'downtrend_break', label: 'Downtrend liniyasini buzish', passed: dt.broken, detail: dt.hasLine ? `Chiziq qiymati: $${dt.lineValue.toFixed(2)}` : (gate.passed ? 'Aniq downtrend liniyasi topilmadi' : 'Yillik darvoza o\u2018tmagani uchun tekshirilmadi') },
    { id: 'ema20_cross_ema50', label: 'EMA20 EMA50ni kesgan/yaqinlashgan + narx EMA20dan biroz baland', passed: emaCross },
    { id: 'volume_bonus', label: '(qo\u2018shimcha) Hajm o\u2018sishi', passed: volUp, bonus: true },
  ];
  return { criteria, passedDailyPreCheck: gate.passed && dt.broken && emaCross };
}

function detectReversalHourly(hourlyBars) {
  const { highs, lows } = findSwingPoints(hourlyBars, 3);
  const hlCount = countRecentClassification(lows, 'higher', 5);
  const hhCount = countRecentClassification(highs, 'higher', 5);
  const zones = clusterZones(highs, 0.02, 2);
  const gaps = findBullishGaps(hourlyBars);
  const lastIdx = hourlyBars.length - 1;
  const price = hourlyBars[lastIdx].close;
  const relevantZone = zones.filter(z => z.lastIndex < lastIdx - 1).sort((a, b) => b.lastIndex - a.lastIndex)[0];
  const resistanceBroken = relevantZone ? price > relevantZone.price : false;
  const recentGap = gaps.filter(g => g.index < lastIdx).sort((a, b) => b.index - a.index)[0];
  const gapBroken = recentGap ? price > recentGap.gapTop : false;
  return {
    criteria: [
      { id: 'hourly_hl', label: 'Soatlikda kamida 2 marta Higher Low', passed: hlCount >= 2, detail: `${hlCount} marta topildi` },
      { id: 'hourly_hh', label: 'Soatlikda kamida 1 marta Higher High', passed: hhCount >= 1, detail: `${hhCount} marta topildi` },
      { id: 'hourly_break', label: 'Soatlik qarshilik/gap buzilishi', passed: resistanceBroken || gapBroken },
    ],
  };
}

// ---- Pullback: cheap DAILY uptrend gate (is this stock even in the right context?), then a
// 4-HOUR deep-check for the actual 5 criteria, which are inherently a shorter-timeframe read ----

function computeFibLevels(swingLow, swingHigh) {
  const range = swingHigh - swingLow;
  return { 0: swingHigh, 0.236: swingHigh - range * 0.236, 0.382: swingHigh - range * 0.382, 0.5: swingHigh - range * 0.5, 0.618: swingHigh - range * 0.618, 0.786: swingHigh - range * 0.786, 1: swingLow };
}

// Kunlik, UZOQ muddatli Fibonacci: butun mavjud tarixdagi eng past nuqtadan, undan keyingi eng
// baland nuqtagacha (foydalanuvchi tasvirlagan "eng quyi narxdan yuqoriga tortish, uzoq muddat").
function dailyFibFromBars(dailyBars) {
  if (!dailyBars || dailyBars.length < 20) return null;
  let minIdx = 0;
  for (let i = 1; i < dailyBars.length; i++) if (dailyBars[i].low < dailyBars[minIdx].low) minIdx = i;
  const swingLow = dailyBars[minIdx].low;
  let swingHigh = -Infinity;
  for (let i = minIdx; i < dailyBars.length; i++) if (dailyBars[i].high > swingHigh) swingHigh = dailyBars[i].high;
  if (swingHigh <= swingLow) return null;
  return computeFibLevels(swingLow, swingHigh);
}

function detectResistanceFlipToSupport(bars, zones, tolerancePct = 0.025) {
  const lastIdx = bars.length - 1;
  const price = bars[lastIdx].close;
  for (const z of zones) {
    const brokeIdx = bars.findIndex((b, i) => i > z.lastIndex && b.close > z.price * 1.01);
    if (brokeIdx === -1) continue;
    const afterBreak = bars.slice(brokeIdx);
    let peakIdx = 0;
    for (let i = 1; i < afterBreak.length; i++) if (afterBreak[i].high > afterBreak[peakIdx].high) peakIdx = i;
    if (afterBreak[peakIdx].high < z.price * 1.03) continue; // needs genuine separation before we call it a "flip"
    const afterPeak = afterBreak.slice(peakIdx + 1);
    if (afterPeak.length < 2) continue;
    const pullbackLow = Math.min(...afterPeak.map(b => b.low));
    const nearZone = Math.abs(pullbackLow - z.price) / z.price <= tolerancePct;
    const recovered = price > pullbackLow * 1.01 && price > z.price * 0.99;
    if (nearZone && recovered) return { flipped: true, zonePrice: z.price };
  }
  return { flipped: false };
}

function detectPullbackDailyGate(bars) {
  const closes = bars.map(b => b.close);
  const lastIdx = closes.length - 1;
  const ema50 = emaSeries(closes, 50);
  const priorEma50 = ema50[Math.max(0, lastIdx - 40)];
  const uptrend = ema50[lastIdx] != null && closes[lastIdx] > ema50[lastIdx] && priorEma50 != null && ema50[lastIdx] > priorEma50;
  return { passedDailyGate: uptrend, dailyFib: dailyFibFromBars(bars) };
}

// dailyFib -- Kunlik (daily) darvozadan o'tkazib yuborilgan, uzoq muddatli Fibonacci darajalari.
function detectPullback4h(bars4h, dailyFib) {
  const closes = bars4h.map(b => b.close);
  const lastIdx = closes.length - 1;
  const price = closes[lastIdx];
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const stack = ema20[lastIdx] != null && ema50[lastIdx] != null && price > ema20[lastIdx] && price > ema50[lastIdx];

  const dt = detectDowntrendLineBreak(bars4h); // the pullback's OWN short-term down-move, same brick as Reversal
  const { highs } = findSwingPoints(bars4h, 3);
  const zones = clusterZones(highs, 0.025, 2);
  const flip = detectResistanceFlipToSupport(bars4h, zones);
  const zonePrice = flip.zonePrice != null ? flip.zonePrice : price; // agar flip topilmasa, joriy narxni "zona" sifatida ishlatamiz

  // Qisqa muddatli, 4-soatlik Fibonacci: BUTUN 4-soatlik ma'lumot (bu allaqachon kunlikka nisbatan
  // "qisqa muddatli" oyna) -- ichki qo'shimcha kesish qo'llanilmaydi, aks holda zona hosil bo'lgan
  // boshlang'ich nuqtalar tasodifan chetlab ketishi mumkin.
  const shortLow = Math.min(...bars4h.map(b => b.low));
  const shortHigh = Math.max(...bars4h.map(b => b.high));
  const shortFib = shortHigh > shortLow ? computeFibLevels(shortLow, shortHigh) : null;

  // Kunlik (uzoq muddatli) tekshiruv: "asosiy zona Fibonaccida yuqorida turishi kerak" -- aniq
  // daraja berilmagani uchun 50% (o'rta chiziq) standart sifatida tanlandi: zona uzoq muddatli
  // diapazonning YUQORI yarmida joylashgan bo'lishi kerak.
  const aboveDailyFib = dailyFib != null && zonePrice > dailyFib[0.5];
  // Qisqa muddatli (4soat) tekshiruv: zona 0.382dan yuqorida.
  const aboveShortFib382 = shortFib != null && zonePrice > shortFib[0.382];
  // Qo'shimcha tasdiq: narx yaqinda 0.236 darajasini yuqoriga kesib o'tganmi.
  let crossed236 = false;
  if (shortFib != null) {
    for (let i = Math.max(1, closes.length - 15); i < closes.length; i++) {
      if (closes[i] > shortFib[0.236] && closes[i - 1] <= shortFib[0.236]) { crossed236 = true; break; }
    }
  }

  const last = bars4h[lastIdx], prev = bars4h[lastIdx - 1];
  const bullishEngulfing = prev && last.close > last.open && prev.close < prev.open && last.close >= prev.open && last.open <= prev.close;

  return {
    criteria: [
      { id: 'ema_stack_4h', label: 'Narx EMA20 va EMA50dan yuqori (4soat)', passed: stack },
      { id: 'microtrend_break', label: 'Pullback ichidagi downtrend buzilishi (LL\u2192HL)', passed: dt.broken, detail: dt.hasLine ? `Chiziq: $${dt.lineValue.toFixed(2)}` : 'Aniq mikro-trend topilmadi' },
      { id: 'sr_flip', label: 'Qarshilik supportga aylanib reaksiya olgani', passed: flip.flipped, detail: flip.flipped ? `Zona: $${flip.zonePrice.toFixed(2)}` : 'Flip tasdiqlanmadi' },
      { id: 'fib_daily', label: 'Zona kunlik (uzoq muddatli) Fibonacci 50%dan yuqorida', passed: aboveDailyFib, detail: dailyFib != null ? `50% daraja: $${dailyFib[0.5].toFixed(2)}` : 'Yetarli kunlik ma\u2018lumot yo\u2018q' },
      { id: 'fib_short_bonus', label: '(qo\u2018shimcha) Zona 4-soatlik Fibonacci 0.382dan yuqorida', passed: aboveShortFib382, bonus: true, detail: shortFib != null ? `0.382 daraja: $${shortFib[0.382].toFixed(2)}${crossed236 ? ' \u00b7 narx 0.236ni yaqinda kesib o\u2018tgan' : ''}` : 'Yetarli 4soatlik ma\u2018lumot yo\u2018q' },
      { id: 'price_action_bonus', label: '(qo\u2018shimcha) Bullish engulfing shamcha', passed: !!bullishEngulfing, bonus: true },
    ],
  };
}

// ---- Historical backtest: replay the SAME detector used live, day by day, using only data
// "known" as of that day (bars.slice(0, i+1)) -- no lookahead leak -- then measure the forward
// return `forwardDays` later. Verified independently with a known-outcome synthetic scenario. ----
function runBacktest(bars, detectorFn, forwardDays = 10, minLookback = 200) {
  const triggers = [];
  for (let i = minLookback; i < bars.length - forwardDays; i++) {
    const windowBars = bars.slice(0, i + 1);
    let result;
    try { result = detectorFn(windowBars); } catch (e) { continue; }
    if (result && result.matched) {
      const entryPrice = bars[i].close;
      const exitPrice = bars[i + forwardDays].close;
      triggers.push({ index: i, returnPct: (exitPrice - entryPrice) / entryPrice * 100 });
    }
  }
  const wins = triggers.filter(t => t.returnPct > 0).length;
  const avgReturn = triggers.length > 0 ? triggers.reduce((s, t) => s + t.returnPct, 0) / triggers.length : null;
  return { triggerCount: triggers.length, winRate: triggers.length > 0 ? (wins / triggers.length) * 100 : null, avgReturn, forwardDays };
}

/* ============================================================
   SCORING ENGINE
   ============================================================ */

function buildChartSeries(bars, windowDays = 90) {
  // Computed over the FULL fetched history (so SMA50/RSI are correctly warmed up),
  // then trimmed to the recent window actually shown in the chart -- this avoids
  // needing to store/persist the full 260-day history just for charting.
  const closes = bars.map(b => b.close);
  const rsiSeries = rsiWilder(closes, 14);
  const sma50Series = closes.map((_, i) => smaAt(closes, 50, i));
  const start = Math.max(0, bars.length - windowDays);
  return bars.slice(start).map((b, idx) => ({
    datetime: b.datetime,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    sma50: sma50Series[start + idx],
    rsi: rsiSeries[start + idx],
  }));
}

function computeATR(bars, period = 14) {
  const tr = bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const prevClose = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
  });
  const out = new Array(bars.length).fill(null);
  if (bars.length <= period) return out;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  out[period] = sum / period;
  for (let i = period + 1; i < bars.length; i++) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  return out;
}

function findCloseOnOrNear(bars, targetDate, toleranceDays = 3) {
  const target = new Date(targetDate).getTime();
  let best = null, bestDiff = Infinity;
  for (const b of bars) {
    const diff = Math.abs(new Date(b.datetime).getTime() - target);
    if (diff < bestDiff) { bestDiff = diff; best = b; }
  }
  const toleranceMs = toleranceDays * 24 * 60 * 60 * 1000;
  return (best && bestDiff <= toleranceMs) ? best.close : null;
}

function computeRelativeStrength(stockBars, spyBars) {
  if (!spyBars || spyBars.length === 0) return null;
  const periods = [{ label: '1 oy', days: 21 }, { label: '3 oy', days: 63 }, { label: '6 oy', days: 126 }];
  const lastIdx = stockBars.length - 1;
  const spyEnd = findCloseOnOrNear(spyBars, stockBars[lastIdx].datetime);
  const results = periods.map(p => {
    const startIdx = lastIdx - p.days;
    if (startIdx < 0 || spyEnd == null) return { ...p, outperformance: null };
    const spyStart = findCloseOnOrNear(spyBars, stockBars[startIdx].datetime);
    if (spyStart == null) return { ...p, outperformance: null };
    const stockReturn = ((stockBars[lastIdx].close - stockBars[startIdx].close) / stockBars[startIdx].close) * 100;
    const spyReturn = ((spyEnd - spyStart) / spyStart) * 100;
    return { ...p, stockReturn, spyReturn, outperformance: stockReturn - spyReturn };
  });
  const valid = results.filter(r => r.outperformance != null);
  const strong = valid.length > 0 && valid.every(r => r.outperformance > 0);
  const weak = valid.length > 0 && valid.every(r => r.outperformance < 0);
  return { periods: results, strong, weak };
}

function scoreTechnical(bars) {
  // bars: chronological array of {datetime, open, high, low, close, volume}
  const closes = bars.map(b => b.close);
  const lastIdx = closes.length - 1;
  const price = closes[lastIdx];
  const sma50 = smaAt(closes, 50, lastIdx);
  const sma200 = smaAt(closes, 200, lastIdx);
  const rsiSeries = rsiWilder(closes, 14);
  const rsi = rsiSeries[lastIdx];
  const { hist } = macdCalc(closes);
  const macdHist = hist[lastIdx];
  const macdHistPrev = hist[lastIdx - 1];
  const vol20 = bars.slice(Math.max(0, bars.length - 20)).reduce((s, b) => s + (b.volume || 0), 0) / Math.min(20, bars.length);
  const lastVolume = bars[lastIdx].volume || 0;
  const volRatio = vol20 > 0 ? lastVolume / vol20 : null;
  const low20 = Math.min(...bars.slice(Math.max(0, bars.length - 20)).map(b => b.low));
  const atrSeries = computeATR(bars, 14);
  const atr = atrSeries[lastIdx];

  let score = 50;
  const notes = [];

  if (sma50 != null) {
    if (price > sma50) { score += 12; notes.push('Narx 50-kunlik o\u2018rtachadan yuqori — qisqa muddatli trend ijobiy'); }
    else { score -= 12; notes.push('Narx 50-kunlik o\u2018rtachadan past — qisqa muddatli trend salbiy'); }
  }
  if (sma200 != null) {
    if (price > sma200) { score += 12; notes.push('Narx 200-kunlik o\u2018rtachadan yuqori — uzoq muddatli trend ijobiy'); }
    else { score -= 12; notes.push('Narx 200-kunlik o\u2018rtachadan past — uzoq muddatli trend salbiy'); }
  }
  if (sma50 != null && sma200 != null) {
    if (sma50 > sma200) { score += 8; notes.push('50 > 200 (oltin kesishma holati) — ijobiy signal'); }
    else { score -= 8; notes.push('50 < 200 (o\u2018lim kesishmasi holati) — salbiy signal'); }
  }
  if (rsi != null) {
    if (rsi > 70) { score -= 10; notes.push(`RSI ${rsi.toFixed(0)} — haddan tashqari sotib olingan, qaytish xavfi bor`); }
    else if (rsi >= 50) { score += 10; notes.push(`RSI ${rsi.toFixed(0)} — sog\u2018lom bullish momentum`); }
    else if (rsi >= 30) { score += 0; notes.push(`RSI ${rsi.toFixed(0)} — neytral hudud`); }
    else { notes.push(`RSI ${rsi.toFixed(0)} — haddan tashqari sotilgan, diqqat bilan tekshiring (qaytish yoki davom etayotgan zaiflik bo\u2018lishi mumkin)`); }
  }
  if (macdHist != null) {
    if (macdHist > 0) {
      score += (macdHistPrev != null && macdHist > macdHistPrev) ? 10 : 6;
      notes.push('MACD gistogrammasi musbat — momentum xaridorlar tomonida');
    } else {
      score -= (macdHistPrev != null && macdHist < macdHistPrev) ? 10 : 6;
      notes.push('MACD gistogrammasi manfiy — momentum sotuvchilar tomonida');
    }
  }
  if (volRatio != null) {
    if (volRatio > 1.5 && price > (bars[lastIdx - 1]?.close ?? price)) { score += 6; notes.push(`Hajm o\u2018rtachadan ${volRatio.toFixed(1)}x yuqori — harakat tasdiqlangan`); }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, price, sma50, sma200, rsi, macdHist, volRatio, low20, atr, notes };
}

function digNumber(obj, paths) {
  for (const path of paths) {
    const parts = path.split('.');
    let cur = obj;
    let ok = true;
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
      else { ok = false; break; }
    }
    if (ok && cur != null && cur !== '' && !isNaN(parseFloat(cur))) return parseFloat(cur);
  }
  return null;
}

function scoreFundamental(raw, criteria) {
  if (!raw) return null;
  const c = criteria || { goodPE: 15, expensivePE: 40, minRevenueGrowth: 0, goodMargin: 0.15 };
  // Alpha Vantage OVERVIEW: numeric fields arrive as strings and are sometimes empty ("") --
  // digNumber's parseFloat+isNaN check already treats those as missing rather than zero.
  const pe = digNumber(raw, ['PERatio']);
  const profitMargin = digNumber(raw, ['ProfitMargin']);
  const revenueGrowth = digNumber(raw, ['QuarterlyRevenueGrowthYOY']);

  let score = 50;
  const notes = [];
  let foundAny = false;

  if (pe != null) {
    foundAny = true;
    if (pe <= 0) { score -= 15; notes.push('P/E manfiy (kompaniya zararda)'); }
    else if (pe < c.goodPE) { score += 15; notes.push(`P/E ${pe.toFixed(1)} — nisbatan arzon baholangan (chegara: <${c.goodPE})`); }
    else if (pe < c.expensivePE) { score += 5; notes.push(`P/E ${pe.toFixed(1)} — o\u2018rtacha baholash`); }
    else { score -= 15; notes.push(`P/E ${pe.toFixed(1)} — qimmat baholangan (chegara: >${c.expensivePE})`); }
  }
  if (revenueGrowth != null) {
    foundAny = true;
    if (revenueGrowth * 100 > c.minRevenueGrowth) { score += 15; notes.push(`Daromad o\u2018sishi ijobiy (${(revenueGrowth * 100).toFixed(1)}%, chorakma-chorak YoY, talab: >${c.minRevenueGrowth}%)`); }
    else { score -= 15; notes.push(`Daromad o\u2018sishi mezondan past (${(revenueGrowth * 100).toFixed(1)}%, talab: >${c.minRevenueGrowth}%)`); }
  }
  if (profitMargin != null) {
    foundAny = true;
    if (profitMargin > c.goodMargin) { score += 15; notes.push(`Foyda marjasi yuqori (${(profitMargin * 100).toFixed(1)}%, chegara: >${(c.goodMargin * 100).toFixed(0)}%)`); }
    else if (profitMargin < 0) { score -= 15; notes.push('Foyda marjasi manfiy'); }
    else { notes.push(`Foyda marjasi o\u2018rtacha (${(profitMargin * 100).toFixed(1)}%)`); }
  }

  if (!foundAny) return { score: null, notes: ['Bu aksiya uchun fundamental maydonlar topilmadi (yangi IPO yoki ma\u2018lumot yo\u2018q bo\u2018lishi mumkin)'], raw, incomplete: true };

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, pe, profitMargin, revenueGrowth, notes, raw, incomplete: false };
}

function compositeScore(tech, fund, weights) {
  if (!tech) return null;
  if (!fund || fund.score == null) return { value: tech.score, techOnly: true };
  const wT = weights.technical / (weights.technical + weights.fundamental);
  const wF = weights.fundamental / (weights.technical + weights.fundamental);
  return { value: Math.round(tech.score * wT + fund.score * wF), techOnly: false };
}

function matchesStrategy(row, strategy) {
  const tech = row?.tech;
  if (!tech) return false;
  if (strategy.builtin === 'breakout') return !!row.breakout?.matched;
  if (strategy.builtin === 'reversal') {
    if (!row.reversalDaily?.passedDailyPreCheck) return false;
    if (!row.reversalHourly) return false; // daily looks promising but hourly deep-check not run yet
    return row.reversalHourly.criteria.every(c => c.passed);
  }
  if (strategy.builtin === 'pullback') {
    if (!row.pullbackGate?.passedDailyGate) return false;
    if (!row.pullback4h) return false; // uptrend confirmed but 4h deep-check not run yet
    return row.pullback4h.criteria.filter(c => !c.bonus).every(c => c.passed);
  }
  if (strategy.trend === 'up') {
    if (tech.sma50 == null || tech.sma200 == null) return false;
    if (!(tech.price > tech.sma50 && tech.price > tech.sma200)) return false;
  }
  if (strategy.trend === 'down') {
    if (tech.sma50 == null || tech.sma200 == null) return false;
    if (!(tech.price < tech.sma50 && tech.price < tech.sma200)) return false;
  }
  if (tech.rsi != null && (tech.rsi < strategy.rsiMin || tech.rsi > strategy.rsiMax)) return false;
  if (strategy.macd === 'positive' && !(tech.macdHist != null && tech.macdHist > 0)) return false;
  if (strategy.macd === 'negative' && !(tech.macdHist != null && tech.macdHist < 0)) return false;
  if (strategy.volMin > 0 && !(tech.volRatio != null && tech.volRatio >= strategy.volMin)) return false;
  return true;
}

function computeRisk(price, stopPrice, accountSize, riskPercent, riskReward) {
  if (!price || !stopPrice || price <= stopPrice) return null;
  const riskAmount = accountSize * (riskPercent / 100);
  const perShareRisk = price - stopPrice;
  let shares = Math.floor(riskAmount / perShareRisk);
  let positionValue = shares * price;
  let capped = false;
  if (positionValue > accountSize) {
    shares = Math.floor(accountSize / price);
    positionValue = shares * price;
    capped = true;
  }
  const takeProfit = price + perShareRisk * (riskReward || 2);
  return { shares, riskAmount, positionValue, perShareRisk, capped, takeProfit };
}

/* ============================================================
   API CALLS
   ============================================================ */

async function fetchTimeSeries(symbol, apiKey, interval = '1day', outputsize = 260) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status === 'error' || data.code) {
    throw new Error(data.message || 'Noma\u2018lum xato (time_series)');
  }
  if (!data.values || !Array.isArray(data.values)) throw new Error('Ma\u2018lumot formati kutilganidek emas');
  const bars = data.values
    .map(v => ({
      datetime: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: parseFloat(v.volume),
    }))
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
  return bars;
}

async function fetchOverview(symbol, alphaVantageKey) {
  const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(alphaVantageKey)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.Note || data.Information) {
    // Alpha Vantage returns HTTP 200 with a polite message body when the key is invalid or the rate limit is hit,
    // rather than a normal error status -- so both fields must be checked explicitly.
    throw new Error(data.Note || data.Information);
  }
  if (!data || !data.Symbol) throw new Error('Bu belgi uchun fundamental ma\u2018lumot topilmadi');
  return data;
}

async function testApiKey(apiKey) {
  const url = `https://api.twelvedata.com/quote?symbol=AAPL&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status === 'error' || data.code) throw new Error(data.message || 'Kalit ishlamayapti');
  return true;
}

const hasClaudeStorage = typeof window !== 'undefined' && window.storage && typeof window.storage.get === 'function';

async function storageGet(key) {
  if (hasClaudeStorage) {
    try {
      const res = await window.storage.get(key, false);
      return res ? res.value : null;
    } catch (e) { return null; }
  }
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

async function storageSet(key, value) {
  if (hasClaudeStorage) {
    try { await window.storage.set(key, value, false); } catch (e) { /* ignore */ }
    return;
  }
  try { localStorage.setItem(key, value); } catch (e) { /* ignore */ }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function notify(title, body) {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return;
  if (window.Notification.permission !== 'granted') return;
  try { new window.Notification(title, { body, icon: undefined }); } catch (e) { /* some browsers restrict this silently -- fine to ignore */ }
}

/* ============================================================
   UI PRIMITIVES
   ============================================================ */

function Card({ title, icon: Icon, children, right }) {
  return (
    <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.hairline}`, borderRadius: 10 }} className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {Icon && <Icon size={15} color={COLORS.brass} />}
          <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 11, letterSpacing: '0.08em', color: COLORS.textMuted }}>{title.toUpperCase()}</span>
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function ScoreBar({ label, value, height = 6 }) {
  const color = value == null ? COLORS.hairline : value >= 65 ? COLORS.positive : value >= 40 ? COLORS.brass : COLORS.negative;
  return (
    <div className="flex items-center gap-2">
      <span style={{ width: 14, fontFamily: 'IBM Plex Mono, monospace', fontSize: 10, color: COLORS.textMuted }}>{label}</span>
      <div style={{ flex: 1, height, background: COLORS.hairline, borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${value ?? 0}%`, height: '100%', background: color, transition: 'width 0.5s ease' }} />
      </div>
      <span style={{ width: 28, textAlign: 'right', fontFamily: 'IBM Plex Mono, monospace', fontSize: 11, color: COLORS.textPrimary }}>{value ?? '—'}</span>
    </div>
  );
}

// Self-contained candlestick chart -- plain SVG, no charting library needed (keeps this 100% free).
// viewBox + preserveAspectRatio="none" lets it scale to any container width while the coordinate
// math below stays fixed to VIEW_W, so the geometry is easy to reason about and test in isolation.
const CANDLE_VIEW_W = 640;
const CANDLE_AXIS_W = 54;
const CANDLE_DATE_H = 16;
const OY_MONTHS = ['Yan', 'Fev', 'Mar', 'Apr', 'May', 'Iyun', 'Iyul', 'Avg', 'Sen', 'Okt', 'Noy', 'Dek'];

function formatAxisDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return `${d.getDate()} ${OY_MONTHS[d.getMonth()]}`;
}

function computeXLayout(n) {
  const plotW = CANDLE_VIEW_W - CANDLE_AXIS_W;
  const gap = plotW / n;
  const candleW = Math.max(1.5, gap * 0.6);
  const xFor = (i) => CANDLE_AXIS_W + gap * i + gap / 2;
  return { gap, candleW, xFor };
}

function computeCandleLayout(data, refs, plotHeight) {
  const highs = data.map(d => d.high).filter(v => v != null);
  const lows = data.map(d => d.low).filter(v => v != null);
  let minP = Math.min(...lows);
  let maxP = Math.max(...highs);
  const refVals = Object.values(refs).filter(v => v != null);
  if (refVals.length) { minP = Math.min(minP, ...refVals); maxP = Math.max(maxP, ...refVals); }
  const pad = (maxP - minP) * 0.08 || 1;
  minP -= pad; maxP += pad;
  const yFor = (price) => plotHeight - ((price - minP) / (maxP - minP)) * plotHeight;
  return { minP, maxP, yFor };
}

// N evenly spaced tick values between min and max (simple, readable -- not a "nice-number" rounding
// algorithm, but plenty clean for this purpose and avoids that extra complexity).
function evenTicks(min, max, count) {
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, i) => min + step * i);
}

function priceDecimals(price) {
  return price < 20 ? 2 : price < 200 ? 1 : 0;
}

function CandlestickChart({ data, sma200, entry, stopLoss, takeProfit, plotHeight = 170 }) {
  if (!data || data.length === 0) return null;
  const totalHeight = plotHeight + CANDLE_DATE_H;
  const { minP, maxP, yFor } = computeCandleLayout(data, { sma200, entry, stopLoss, takeProfit }, plotHeight);
  const { gap, candleW, xFor } = computeXLayout(data.length);
  const dec = priceDecimals(maxP);
  const yTicks = evenTicks(minP, maxP, 5);
  const xTickEvery = Math.max(1, Math.round(data.length / 5));
  const sma50Points = data.map((d, i) => (d.sma50 != null ? `${xFor(i)},${yFor(d.sma50)}` : null)).filter(Boolean).join(' ');
  const last = data[data.length - 1];
  const lastUp = last.close >= last.open;

  const refLine = (val, color, label, dash) => val == null ? null : (
    <g>
      <line x1={CANDLE_AXIS_W} x2={CANDLE_VIEW_W} y1={yFor(val)} y2={yFor(val)} stroke={color} strokeWidth={1} strokeDasharray={dash ? '4 3' : undefined} opacity={0.85} />
      <text x={CANDLE_VIEW_W - 3} y={yFor(val) - 3} textAnchor="end" fontSize="9" fill={color} fontFamily="IBM Plex Mono, monospace" fontWeight="600">{label}</text>
    </g>
  );

  return (
    <svg width="100%" height={totalHeight} viewBox={`0 0 ${CANDLE_VIEW_W} ${totalHeight}`} preserveAspectRatio="none" style={{ overflow: 'visible', display: 'block' }}>
      {/* horizontal grid + price labels */}
      {yTicks.map((t, i) => (
        <g key={`hy${i}`}>
          <line x1={CANDLE_AXIS_W} x2={CANDLE_VIEW_W} y1={yFor(t)} y2={yFor(t)} stroke={COLORS.hairline} strokeWidth={1} strokeDasharray="2 3" />
          <text x={CANDLE_AXIS_W - 5} y={yFor(t) + 3} textAnchor="end" fontSize="9" fill={COLORS.textMuted} fontFamily="IBM Plex Mono, monospace">{t.toFixed(dec)}</text>
        </g>
      ))}
      {/* vertical grid + date labels */}
      {data.map((d, i) => (i % xTickEvery === 0 ? (
        <g key={`vx${i}`}>
          <line x1={xFor(i)} x2={xFor(i)} y1={0} y2={plotHeight} stroke={COLORS.hairline} strokeWidth={1} strokeDasharray="2 3" />
          <text x={xFor(i)} y={plotHeight + 11} textAnchor="middle" fontSize="8.5" fill={COLORS.textMuted} fontFamily="IBM Plex Mono, monospace">{formatAxisDate(d.datetime)}</text>
        </g>
      ) : null))}

      {refLine(sma200, COLORS.textMuted, `SMA200 ${sma200 != null ? sma200.toFixed(dec) : ''}`, true)}
      {refLine(takeProfit, COLORS.positive, `TP ${takeProfit != null ? takeProfit.toFixed(2) : ''}`, false)}
      {refLine(stopLoss, COLORS.negative, `SL ${stopLoss != null ? stopLoss.toFixed(2) : ''}`, false)}
      {refLine(entry, COLORS.brass, `Kirish ${entry != null ? entry.toFixed(2) : ''}`, true)}

      {data.map((d, i) => {
        const up = d.close >= d.open;
        const color = up ? COLORS.positive : COLORS.negative;
        const x = xFor(i);
        const bodyTop = yFor(Math.max(d.open, d.close));
        const bodyBottom = yFor(Math.min(d.open, d.close));
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={yFor(d.high)} y2={yFor(d.low)} stroke={color} strokeWidth={1} />
            <rect x={x - candleW / 2} y={bodyTop} width={candleW} height={Math.max(1, bodyBottom - bodyTop)} fill={color} />
          </g>
        );
      })}
      {sma50Points && <polyline points={sma50Points} fill="none" stroke={COLORS.brass} strokeWidth={1.3} opacity={0.9} />}

      {/* live last-price tag, TradingView-style */}
      <rect x={CANDLE_VIEW_W - 40} y={yFor(last.close) - 7} width={40} height={14} fill={lastUp ? COLORS.positive : COLORS.negative} rx={2} />
      <text x={CANDLE_VIEW_W - 20} y={yFor(last.close) + 3} textAnchor="middle" fontSize="9" fill="#0A0E17" fontFamily="IBM Plex Mono, monospace" fontWeight="700">{last.close.toFixed(dec)}</text>
    </svg>
  );
}

function VolumeChart({ data, height = 40 }) {
  if (!data || data.length === 0) return null;
  const vols = data.map(d => d.volume || 0);
  const maxV = Math.max(...vols, 1);
  const { candleW, xFor } = computeXLayout(data.length);
  const yFor = (v) => height - (v / maxV) * height;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${CANDLE_VIEW_W} ${height}`} preserveAspectRatio="none" style={{ overflow: 'visible', display: 'block' }}>
      {data.map((d, i) => {
        const up = d.close >= d.open;
        const x = xFor(i);
        const y = yFor(d.volume || 0);
        return <rect key={i} x={x - candleW / 2} y={y} width={candleW} height={Math.max(0.5, height - y)} fill={up ? COLORS.positive : COLORS.negative} opacity={0.55} />;
      })}
    </svg>
  );
}

/* ============================================================
   MAIN COMPONENT
   ============================================================ */

export default function NomzodlarTerminal() {
  const [loaded, setLoaded] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [keyStatus, setKeyStatus] = useState(null); // null | 'checking' | 'ok' | 'error'
  const [keyError, setKeyError] = useState('');
  const [alphaKey, setAlphaKey] = useState('');
  const [alphaKeyStatus, setAlphaKeyStatus] = useState(null);
  const [alphaKeyError, setAlphaKeyError] = useState('');
  const [watchlist, setWatchlist] = useState([]);
  const [tickerInput, setTickerInput] = useState('');
  const [weights, setWeights] = useState({ technical: 50, fundamental: 50 });
  const [risk, setRisk] = useState({ accountSize: 1000, riskPercent: 1, stopLossPercent: 7, riskReward: 2, stopMode: 'percent', atrMultiplier: 2 });
  const [fundCriteria, setFundCriteria] = useState({ goodPE: 15, expensivePE: 40, minRevenueGrowth: 0, goodMargin: 0.15 });
  const [strategies, setStrategies] = useState([
    { id: 'breakout', name: 'Breakout (professional)', active: true, builtin: 'breakout' },
    { id: 'reversal', name: 'Reversal (professional)', active: true, builtin: 'reversal' },
    { id: 'pullback', name: 'Pullback (professional)', active: true, builtin: 'pullback' },
    { id: 's1', name: 'Uptrend Momentum', active: false, trend: 'up', rsiMin: 45, rsiMax: 70, macd: 'positive', volMin: 0 },
  ]);
  const [strategyForm, setStrategyForm] = useState(null); // null = closed, {} = editing draft
  const [results, setResults] = useState({}); // { SYMBOL: { tech, fund, updatedAt, error } }
  const [expanded, setExpanded] = useState({});
  const [chartBig, setChartBig] = useState({});
  const [journal, setJournal] = useState([]);
  const [notifEnabled, setNotifEnabled] = useState(false);
  const [lastExportAt, setLastExportAt] = useState(null);
  const [journalForm, setJournalForm] = useState(null); // symbol being logged, or null
  const [running, setRunning] = useState(false);
  const [runningFund, setRunningFund] = useState(false);
  const [runningReversal, setRunningReversal] = useState(false);
  const [runningPullback, setRunningPullback] = useState(false);
  const [runningBreakoutHL, setRunningBreakoutHL] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const stopFlag = useRef(false);
  const importFileRef = useRef(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  // Load persisted state
  useEffect(() => {
    (async () => {
      try {
        const value = await storageGet(STORAGE_KEY);
        if (value) {
          const parsed = JSON.parse(value);
          setApiKey(parsed.apiKey || '');
          setAlphaKey(parsed.alphaKey || '');
          setWatchlist(parsed.watchlist || []);
          setWeights(parsed.weights || { technical: 50, fundamental: 50 });
          setRisk({ accountSize: 1000, riskPercent: 1, stopLossPercent: 7, riskReward: 2, stopMode: 'percent', atrMultiplier: 2, ...(parsed.risk || {}) });
          setFundCriteria(parsed.fundCriteria || { goodPE: 15, expensivePE: 40, minRevenueGrowth: 0, goodMargin: 0.15 });
          if (parsed.strategies) {
            const loaded = parsed.strategies;
            const builtins = [
              { id: 'breakout', name: 'Breakout (professional)', active: true, builtin: 'breakout' },
              { id: 'reversal', name: 'Reversal (professional)', active: true, builtin: 'reversal' },
              { id: 'pullback', name: 'Pullback (professional)', active: true, builtin: 'pullback' },
            ];
            const missing = builtins.filter(b => !loaded.some(s => s.builtin === b.builtin));
            setStrategies(missing.length ? [...missing, ...loaded] : loaded);
          }
          setResults(parsed.results || {});
          setJournal(parsed.journal || []);
          setLastExportAt(parsed.lastExportAt || null);
          setLastUpdated(parsed.lastUpdated || null);
        }
      } catch (e) { /* first run, nothing stored yet */ }
      setLoaded(true);
    })();
  }, []);

  // Persist state on change
  useEffect(() => {
    if (!loaded) return;
    const payload = JSON.stringify({ apiKey, alphaKey, watchlist, weights, risk, fundCriteria, strategies, results, journal, lastUpdated, lastExportAt });
    storageSet(STORAGE_KEY, payload);
  }, [apiKey, alphaKey, watchlist, weights, risk, fundCriteria, strategies, results, journal, lastUpdated, lastExportAt, loaded]);

  const addTickers = () => {
    const parts = tickerInput
      .split(/[,\s\n]+/)
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);
    if (parts.length === 0) return;
    setWatchlist(prev => Array.from(new Set([...prev, ...parts])));
    setTickerInput('');
  };

  const removeTicker = (sym) => {
    setWatchlist(prev => prev.filter(s => s !== sym));
    setResults(prev => {
      const next = { ...prev };
      delete next[sym];
      return next;
    });
  };

  const blankStrategy = () => ({ id: `s${Date.now()}`, name: '', active: true, trend: 'any', rsiMin: 0, rsiMax: 100, macd: 'any', volMin: 0 });

  const saveStrategy = () => {
    if (!strategyForm || !strategyForm.name.trim()) return;
    setStrategies(prev => {
      const exists = prev.some(s => s.id === strategyForm.id);
      return exists ? prev.map(s => (s.id === strategyForm.id ? strategyForm : s)) : [...prev, strategyForm];
    });
    setStrategyForm(null);
  };

  const deleteStrategy = (id) => setStrategies(prev => prev.filter(s => s.id !== id));
  const toggleStrategyActive = (id) => setStrategies(prev => prev.map(s => (s.id === id ? { ...s, active: !s.active } : s)));

  const resetBuiltinStrategies = () => {
    const defaults = [
      { id: 'breakout', name: 'Breakout (professional)', active: true, builtin: 'breakout' },
      { id: 'reversal', name: 'Reversal (professional)', active: true, builtin: 'reversal' },
      { id: 'pullback', name: 'Pullback (professional)', active: true, builtin: 'pullback' },
    ];
    setStrategies(prev => {
      const custom = prev.filter(s => !s.builtin);
      return [...defaults, ...custom];
    });
  };

  const addJournalEntry = (entry) => {
    setJournal(prev => [...prev, { ...entry, id: `t${Date.now()}`, status: 'open', loggedAt: Date.now() }]);
    setJournalForm(null);
  };
  const closeJournalEntry = (id, exitPrice, reason) => {
    setJournal(prev => prev.map(t => (t.id === id ? { ...t, status: reason, exitPrice, closedAt: Date.now() } : t)));
  };
  const deleteJournalEntry = (id) => setJournal(prev => prev.filter(t => t.id !== id));

  const enableNotifications = async () => {
    if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return;
    if (window.Notification.permission === 'granted') { setNotifEnabled(true); return; }
    const result = await window.Notification.requestPermission();
    setNotifEnabled(result === 'granted');
  };

  const exportSettings = () => {
    const now = Date.now();
    const payload = { apiKey, alphaKey, watchlist, weights, risk, fundCriteria, strategies, results, journal, lastUpdated, exportedAt: now, exportVersion: 1 };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nomzodlar-sozlamalari-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setLastExportAt(now);
  };

  const importSettings = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (typeof data.apiKey === 'string') setApiKey(data.apiKey);
        if (typeof data.alphaKey === 'string') setAlphaKey(data.alphaKey);
        if (Array.isArray(data.watchlist)) setWatchlist(data.watchlist);
        if (data.weights) setWeights(data.weights);
        if (data.risk) setRisk(data.risk);
        if (data.fundCriteria) setFundCriteria(data.fundCriteria);
        if (Array.isArray(data.strategies)) setStrategies(data.strategies);
        if (data.results) setResults(data.results);
        if (Array.isArray(data.journal)) setJournal(data.journal);
        if (data.lastUpdated) setLastUpdated(data.lastUpdated);
        if (data.exportedAt) setLastExportAt(data.exportedAt);
        alert('Sozlamalar muvaffaqiyatli yuklandi!');
      } catch (err) {
        alert('Fayl formatida xatolik: bu to\u2018g\u2018ri eksport fayli emasga o\u2018xshaydi.');
      }
    };
    reader.readAsText(file);
  };

  const checkKey = async () => {
    setKeyStatus('checking');
    setKeyError('');
    try {
      await testApiKey(apiKey);
      setKeyStatus('ok');
    } catch (e) {
      setKeyStatus('error');
      setKeyError(e.message);
    }
  };

  const checkAlphaKey = async () => {
    setAlphaKeyStatus('checking');
    setAlphaKeyError('');
    try {
      await fetchOverview('IBM', alphaKey);
      setAlphaKeyStatus('ok');
    } catch (e) {
      setAlphaKeyStatus('error');
      setAlphaKeyError(e.message);
    }
  };

  const runTechnicalAnalysis = async () => {
    if (!apiKey || watchlist.length === 0) return;
    setRunning(true);
    stopFlag.current = false;
    setProgress({ done: 0, total: watchlist.length });
    let spyBars = null;
    try {
      spyBars = await fetchTimeSeries('SPY', apiKey); // fetched ONCE for the whole run, not per stock
    } catch (e) { /* RS simply won't be available this run if SPY fetch fails -- doesn't block the rest */ }
    const newCandidates = [];
    for (let i = 0; i < watchlist.length; i++) {
      if (stopFlag.current) break;
      const symbol = watchlist[i];
      setResults(prev => ({ ...prev, [symbol]: { ...(prev[symbol] || {}), loading: true, error: null } }));
      try {
        const bars = await fetchTimeSeries(symbol, apiKey);
        const tech = scoreTechnical(bars);
        const chartData = buildChartSeries(bars);
        const breakout = bars.length >= 60 ? detectBreakout(bars) : null;
        const reversalDaily = bars.length >= 60 ? detectReversalDaily(bars) : null;
        const pullbackGate = bars.length >= 60 ? detectPullbackDailyGate(bars) : null;
        const relativeStrength = (symbol !== 'SPY' && bars.length >= 30) ? computeRelativeStrength(bars, spyBars) : null;
        let backtests = null;
        if (bars.length >= 220) {
          backtests = {
            breakout: runBacktest(bars, detectBreakout, 10, 200),
            reversal: runBacktest(bars, (b) => ({ matched: detectReversalDaily(b).passedDailyPreCheck }), 10, 200),
            pullback: runBacktest(bars, (b) => ({ matched: detectPullbackDailyGate(b).passedDailyGate }), 10, 200),
          };
        }
        const wasCandidate = candidateSymbols.includes(symbol);
        const nowMatches = activeStrategies.some(s => matchesStrategy({ tech, breakout, reversalDaily, reversalHourly: results[symbol]?.reversalHourly, pullbackGate, pullback4h: results[symbol]?.pullback4h }, s));
        if (nowMatches && !wasCandidate) newCandidates.push(symbol);
        setResults(prev => ({
          ...prev,
          [symbol]: { ...(prev[symbol] || {}), tech, chartData, breakout, reversalDaily, reversalHourly: null, pullbackGate, pullback4h: null, relativeStrength, backtests, loading: false, error: null, updatedAt: Date.now() }
        }));
      } catch (e) {
        setResults(prev => ({ ...prev, [symbol]: { ...(prev[symbol] || {}), loading: false, error: e.message } }));
      }
      setProgress({ done: i + 1, total: watchlist.length });
      if (i < watchlist.length - 1) await sleep(8000);
    }
    setRunning(false);
    setLastUpdated(Date.now());
    if (newCandidates.length > 0) {
      notify('Nomzodlar — yangi nomzod topildi', `${newCandidates.slice(0, 5).join(', ')}${newCandidates.length > 5 ? ` va yana ${newCandidates.length - 5} ta` : ''} strategiyangizga mos keldi.`);
    }
  };

  // Telegram Mini App: if opened inside Telegram (window.Telegram.WebApp exists), initialize it
  // to use full height and match our navy/brass theme. If opened as a normal website, this
  // safely no-ops -- window.Telegram simply won't exist.
  useEffect(() => {
    const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : null;
    if (!tg) return;
    try {
      tg.ready();
      tg.expand();
      tg.setHeaderColor?.(COLORS.surface);
      tg.setBackgroundColor?.(COLORS.void);
    } catch (e) { /* older Telegram client versions may not support every method -- safe to ignore */ }
  }, []);

  // Auto-run on open: if a watchlist is already saved and its last analysis is stale (or missing),
  // kick off technical analysis automatically once, without waiting for a button click.
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (!loaded || autoRanRef.current) return;
    autoRanRef.current = true;
    const STALE_MS = 4 * 60 * 60 * 1000; // 4 soat
    const isStale = !lastUpdated || (Date.now() - lastUpdated > STALE_MS);
    if (apiKey && watchlist.length > 0 && isStale) {
      runTechnicalAnalysis();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Watch open journal positions: notify once (per position) the moment price crosses TP or SL.
  useEffect(() => {
    if (!loaded) return;
    for (const t of journal) {
      if (t.status !== 'open' || t.notified) continue;
      const live = results[t.symbol]?.tech?.price;
      if (live == null) continue;
      if (live >= t.takeProfit) {
        notify(`${t.symbol} — Take-profit darajasiga yetdi`, `Joriy narx $${live.toFixed(2)}, TP $${t.takeProfit.toFixed(2)}. Jurnalda tasdiqlang.`);
        setJournal(prev => prev.map(j => (j.id === t.id ? { ...j, notified: true } : j)));
      } else if (live <= t.stopLoss) {
        notify(`${t.symbol} — Stop-loss darajasiga yetdi`, `Joriy narx $${live.toFixed(2)}, SL $${t.stopLoss.toFixed(2)}. Jurnalda tasdiqlang.`);
        setJournal(prev => prev.map(j => (j.id === t.id ? { ...j, notified: true } : j)));
      }
    }
  }, [journal, results, loaded]);

  const runReversalDeepCheck = async () => {
    const targets = watchlist.filter(sym => results[sym]?.reversalDaily?.passedDailyPreCheck);
    if (!apiKey || targets.length === 0) return;
    setRunningReversal(true);
    stopFlag.current = false;
    setProgress({ done: 0, total: targets.length });
    for (let i = 0; i < targets.length; i++) {
      if (stopFlag.current) break;
      const symbol = targets[i];
      setResults(prev => ({ ...prev, [symbol]: { ...(prev[symbol] || {}), reversalLoading: true } }));
      try {
        const hourlyBars = await fetchTimeSeries(symbol, apiKey, '1h', 300);
        const reversalHourly = hourlyBars.length >= 40 ? detectReversalHourly(hourlyBars) : null;
        setResults(prev => ({ ...prev, [symbol]: { ...(prev[symbol] || {}), reversalHourly, reversalLoading: false, reversalError: null } }));
      } catch (e) {
        setResults(prev => ({ ...prev, [symbol]: { ...(prev[symbol] || {}), reversalLoading: false, reversalError: e.message } }));
      }
      setProgress({ done: i + 1, total: targets.length });
      if (i < targets.length - 1) await sleep(8000);
    }
    setRunningReversal(false);
  };

  const runBreakoutHourlyCheck = async () => {
    const targets = watchlist.filter(sym => results[sym]?.breakout?.matched);
    if (!apiKey || targets.length === 0) return;
    setRunningBreakoutHL(true);
    stopFlag.current = false;
    setProgress({ done: 0, total: targets.length });
    for (let i = 0; i < targets.length; i++) {
      if (stopFlag.current) break;
      const symbol = targets[i];
      setResults(prev => ({ ...prev, [symbol]: { ...(prev[symbol] || {}), breakoutHLLoading: true } }));
      try {
        const hourlyBars = await fetchTimeSeries(symbol, apiKey, '1h', 300);
        const breakoutHourlyHL = hourlyBars.length >= 40 ? detectBreakoutHourlyHL(hourlyBars) : null;
        setResults(prev => ({ ...prev, [symbol]: { ...(prev[symbol] || {}), breakoutHourlyHL, breakoutHLLoading: false, breakoutHLError: null } }));
      } catch (e) {
        setResults(prev => ({ ...prev, [symbol]: { ...(prev[symbol] || {}), breakoutHLLoading: false, breakoutHLError: e.message } }));
      }
      setProgress({ done: i + 1, total: targets.length });
      if (i < targets.length - 1) await sleep(8000);
    }
    setRunningBreakoutHL(false);
  };

  const runPullbackDeepCheck = async () => {
    const targets = watchlist.filter(sym => results[sym]?.pullbackGate?.passedDailyGate);
    if (!apiKey || targets.length === 0) return;
    setRunningPullback(true);
    stopFlag.current = false;
    setProgress({ done: 0, total: targets.length });
    for (let i = 0; i < targets.length; i++) {
      if (stopFlag.current) break;
      const symbol = targets[i];
      setResults(prev => ({ ...prev, [symbol]: { ...(prev[symbol] || {}), pullbackLoading: true } }));
      try {
        const bars4h = await fetchTimeSeries(symbol, apiKey, '4h', 200);
        const dailyFib = results[symbol]?.pullbackGate?.dailyFib || null;
        const pullback4h = bars4h.length >= 40 ? detectPullback4h(bars4h, dailyFib) : null;
        setResults(prev => ({ ...prev, [symbol]: { ...(prev[symbol] || {}), pullback4h, pullbackLoading: false, pullbackError: null } }));
      } catch (e) {
        setResults(prev => ({ ...prev, [symbol]: { ...(prev[symbol] || {}), pullbackLoading: false, pullbackError: e.message } }));
      }
      setProgress({ done: i + 1, total: targets.length });
      if (i < targets.length - 1) await sleep(8000);
    }
    setRunningPullback(false);
  };

  const runFundamentalRefresh = async () => {
    const targets = candidateSymbols;
    if (!alphaKey || targets.length === 0) return;
    setRunningFund(true);
    stopFlag.current = false;
    setProgress({ done: 0, total: targets.length });
    for (let i = 0; i < targets.length; i++) {
      if (stopFlag.current) break;
      const symbol = targets[i];
      setResults(prev => ({ ...prev, [symbol]: { ...(prev[symbol] || {}), fundLoading: true } }));
      try {
        const raw = await fetchOverview(symbol, alphaKey);
        const fund = scoreFundamental(raw, fundCriteria);
        setResults(prev => ({ ...prev, [symbol]: { ...(prev[symbol] || {}), fund, fundLoading: false, fundError: null, fundUpdatedAt: Date.now() } }));
      } catch (e) {
        setResults(prev => ({ ...prev, [symbol]: { ...(prev[symbol] || {}), fundLoading: false, fundError: e.message } }));
      }
      setProgress({ done: i + 1, total: targets.length });
      // Alpha Vantage free tier: 5 calls/minute -- 13s keeps us safely under that.
      if (i < targets.length - 1) await sleep(13000);
    }
    setRunningFund(false);
  };

  const stopRun = () => { stopFlag.current = true; };

  const activeStrategies = useMemo(() => strategies.filter(s => s.active), [strategies]);

  const rows = useMemo(() => {
    return watchlist.map(symbol => {
      const r = results[symbol] || {};
      const comp = compositeScore(r.tech, r.fund, weights);
      const matched = r.tech ? activeStrategies.filter(s => matchesStrategy(r, s)).map(s => s.name) : [];
      let affordable = null;
      if (r.tech) {
        const stopPrice = r.tech.price * (1 - risk.stopLossPercent / 100);
        const pr = computeRisk(r.tech.price, stopPrice, risk.accountSize, risk.riskPercent, risk.riskReward);
        affordable = pr ? pr.shares > 0 : false;
      }
      const isCandidate = r.tech ? (activeStrategies.length === 0 || matched.length > 0) && affordable !== false : false;
      return { symbol, ...r, composite: comp, matchedStrategies: matched, isCandidate };
    }).sort((a, b) => {
      if (a.isCandidate !== b.isCandidate) return a.isCandidate ? -1 : 1;
      return (b.composite?.value ?? -1) - (a.composite?.value ?? -1);
    });
  }, [watchlist, results, weights, activeStrategies, risk]);

  const candidateSymbols = useMemo(() => rows.filter(r => r.isCandidate).map(r => r.symbol), [rows]);
  const needsExportReminder = useMemo(() => {
    if (watchlist.length === 0) return false;
    if (!lastExportAt) return true;
    const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
    return Date.now() - lastExportAt > FOURTEEN_DAYS;
  }, [watchlist, lastExportAt]);
  const aggregateRisk = useMemo(() => {
    let totalRisk = 0, totalValue = 0, count = 0;
    for (const row of rows) {
      if (!row.isCandidate || !row.tech) continue;
      const atrDist = row.tech.atr != null ? row.tech.atr * risk.atrMultiplier : null;
      const sp = risk.stopMode === 'atr' && atrDist != null ? row.tech.price - atrDist : row.tech.price * (1 - risk.stopLossPercent / 100);
      const pr = computeRisk(row.tech.price, sp, risk.accountSize, risk.riskPercent, risk.riskReward);
      if (pr) { totalRisk += pr.riskAmount; totalValue += pr.positionValue; count++; }
    }
    return { totalRisk, totalValue, count };
  }, [rows, risk]);
  const journalStats = useMemo(() => {
    const closed = journal.filter(t => t.status !== 'open');
    const byStrategy = {};
    for (const t of closed) {
      const pct = ((t.exitPrice - t.entryPrice) / t.entryPrice) * 100;
      if (!byStrategy[t.strategy]) byStrategy[t.strategy] = { returns: [], wins: 0 };
      byStrategy[t.strategy].returns.push(pct);
      if (pct > 0) byStrategy[t.strategy].wins++;
    }
    return Object.entries(byStrategy).map(([strategy, d]) => ({
      strategy, count: d.returns.length, winRate: (d.wins / d.returns.length) * 100,
      avgReturn: d.returns.reduce((s, p) => s + p, 0) / d.returns.length,
    }));
  }, [journal]);
  const reversalPreCandidates = useMemo(
    () => watchlist.filter(sym => results[sym]?.reversalDaily?.passedDailyPreCheck),
    [watchlist, results]
  );
  const pullbackGateCandidates = useMemo(
    () => watchlist.filter(sym => results[sym]?.pullbackGate?.passedDailyGate),
    [watchlist, results]
  );
  const breakoutMatchedCandidates = useMemo(
    () => watchlist.filter(sym => results[sym]?.breakout?.matched),
    [watchlist, results]
  );
  const estSeconds = watchlist.length > 0 ? (watchlist.length - 1) * 8 : 0;

  return (
    <div style={{ minHeight: '100vh', background: COLORS.void, color: COLORS.textPrimary, fontFamily: 'Inter, sans-serif' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        input:focus, button:focus { outline: 2px solid ${COLORS.brass}; outline-offset: 1px; }
        ::placeholder { color: #576079; }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
      `}</style>

      <div style={{ maxWidth: 980, margin: '0 auto', padding: '32px 20px 60px' }}>

        {/* Header */}
        <div style={{ marginBottom: 28, borderBottom: `1px solid ${COLORS.hairline}`, paddingBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ fontFamily: 'Space Grotesk, sans-serif', fontWeight: 700, fontSize: 28, letterSpacing: '-0.01em' }}>
              NOMZODLAR<span style={{ color: COLORS.brass }}>.</span>
            </div>
            <div style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 12.5, color: COLORS.textMuted, marginTop: 4 }}>
              AQSH aksiyalari uchun fundamental + texnik tahlil terminali · {watchlist.length} ta kuzatuvda
              {lastUpdated && ` · oxirgi yangilanish: ${new Date(lastUpdated).toLocaleString('uz-UZ')}`}
            </div>
          </div>
          <div className="flex items-center" style={{ gap: 8, flexWrap: 'wrap' }}>
            {needsExportReminder && (
              <span style={{ fontSize: 10.5, color: COLORS.brass }} title="Ma'lumotlaringiz faqat shu brauzerda saqlanadi">
                {lastExportAt ? `oxirgi zaxira: ${Math.floor((Date.now() - lastExportAt) / (24 * 60 * 60 * 1000))} kun oldin` : "hali zaxira olinmagan"} —
              </span>
            )}
            <button onClick={exportSettings}
              style={{ background: COLORS.surfaceRaised, border: `1px solid ${COLORS.hairline}`, color: COLORS.textPrimary, borderRadius: 6, padding: '6px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
              Sozlamalarni yuklab olish
            </button>
            <button onClick={() => importFileRef.current?.click()}
              style={{ background: COLORS.surfaceRaised, border: `1px solid ${COLORS.hairline}`, color: COLORS.textPrimary, borderRadius: 6, padding: '6px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
              Sozlamalarni yuklash
            </button>
            <input ref={importFileRef} type="file" accept="application/json" style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f && window.confirm("Joriy sozlamalar (kalitlar, ro'yxat, jurnal) tanlangan fayldagi ma'lumot bilan almashtiriladi. Davom etaymi?")) importSettings(f); e.target.value = ''; }} />
            {typeof window !== 'undefined' && typeof window.Notification !== 'undefined' && (
              window.Notification.permission === 'granted' ? (
                <span style={{ fontSize: 11, color: COLORS.positive, border: `1px solid ${COLORS.positive}`, borderRadius: 6, padding: '5px 10px', display: 'flex', alignItems: 'center', gap: 5 }}>
                  ✓ Bildirishnomalar yoqilgan
                </span>
              ) : window.Notification.permission === 'denied' ? (
                <span style={{ fontSize: 11, color: COLORS.textMuted, border: `1px solid ${COLORS.hairline}`, borderRadius: 6, padding: '5px 10px' }} title="Brauzer sozlamalarida qayta yoqishingiz kerak">
                  Bildirishnomalar bloklangan
                </span>
              ) : (
                <button onClick={enableNotifications}
                  style={{ background: COLORS.surfaceRaised, border: `1px solid ${COLORS.brassDim}`, color: COLORS.brass, borderRadius: 6, padding: '6px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
                  Bildirishnomalarni yoqish
                </button>
              )
            )}
          </div>
        </div>

        {/* Control grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, marginBottom: 20 }}>

          <Card title="Texnik kalit (Twelve Data)" icon={Key} right={
            keyStatus === 'ok' ? <span style={{ fontSize: 11, color: COLORS.positive, fontFamily: 'IBM Plex Mono, monospace' }}>ULANDI</span> :
            keyStatus === 'error' ? <span style={{ fontSize: 11, color: COLORS.negative, fontFamily: 'IBM Plex Mono, monospace' }}>XATO</span> : null
          }>
            <input
              type="password"
              value={apiKey}
              onChange={e => { setApiKey(e.target.value); setKeyStatus(null); }}
              placeholder="Twelve Data API kalitingiz"
              style={{ width: '100%', background: COLORS.surfaceRaised, border: `1px solid ${COLORS.hairline}`, borderRadius: 6, padding: '8px 10px', color: COLORS.textPrimary, fontFamily: 'IBM Plex Mono, monospace', fontSize: 12.5, marginBottom: 8 }}
            />
            <div className="flex items-center gap-2">
              <button onClick={checkKey} disabled={!apiKey || keyStatus === 'checking'}
                style={{ background: COLORS.brass, color: '#1A1405', border: 'none', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: apiKey ? 'pointer' : 'not-allowed', opacity: apiKey ? 1 : 0.5 }}>
                {keyStatus === 'checking' ? 'Tekshirilmoqda...' : 'Kalitni tekshirish'}
              </button>
              <a href="https://twelvedata.com/pricing" target="_blank" rel="noopener noreferrer" style={{ fontSize: 11.5, color: COLORS.textMuted, textDecoration: 'underline' }}>
                Bepul kalit olish →
              </a>
            </div>
            {keyStatus === 'error' && <div style={{ fontSize: 11.5, color: COLORS.negative, marginTop: 6 }}>{keyError}</div>}
            {!apiKey && <div style={{ fontSize: 11.5, color: COLORS.textMuted, marginTop: 6 }}>Narx va texnik indikatorlar uchun. twelvedata.com'da bepul ro'yxatdan o'ting (faqat email).</div>}
          </Card>

          <Card title="Fundamental kalit (Alpha Vantage)" icon={Key} right={
            alphaKeyStatus === 'ok' ? <span style={{ fontSize: 11, color: COLORS.positive, fontFamily: 'IBM Plex Mono, monospace' }}>ULANDI</span> :
            alphaKeyStatus === 'error' ? <span style={{ fontSize: 11, color: COLORS.negative, fontFamily: 'IBM Plex Mono, monospace' }}>XATO</span> : null
          }>
            <input
              type="password"
              value={alphaKey}
              onChange={e => { setAlphaKey(e.target.value); setAlphaKeyStatus(null); }}
              placeholder="Alpha Vantage API kalitingiz"
              style={{ width: '100%', background: COLORS.surfaceRaised, border: `1px solid ${COLORS.hairline}`, borderRadius: 6, padding: '8px 10px', color: COLORS.textPrimary, fontFamily: 'IBM Plex Mono, monospace', fontSize: 12.5, marginBottom: 8 }}
            />
            <div className="flex items-center gap-2">
              <button onClick={checkAlphaKey} disabled={!alphaKey || alphaKeyStatus === 'checking'}
                style={{ background: COLORS.brass, color: '#1A1405', border: 'none', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: alphaKey ? 'pointer' : 'not-allowed', opacity: alphaKey ? 1 : 0.5 }}>
                {alphaKeyStatus === 'checking' ? 'Tekshirilmoqda...' : 'Kalitni tekshirish'}
              </button>
              <a href="https://www.alphavantage.co/support/#api-key" target="_blank" rel="noopener noreferrer" style={{ fontSize: 11.5, color: COLORS.textMuted, textDecoration: 'underline' }}>
                Bepul kalit olish →
              </a>
            </div>
            {alphaKeyStatus === 'error' && <div style={{ fontSize: 11.5, color: COLORS.negative, marginTop: 6 }}>{alphaKeyError}</div>}
            {!alphaKey && <div style={{ fontSize: 11.5, color: COLORS.textMuted, marginTop: 6 }}>P/E, foyda marjasi, daromad o'sishi uchun. Bepul tarif: kuniga atigi 25 so'rov — shuning uchun kamdan-kam yangilang.</div>}
          </Card>

          <Card title="Xavf sozlamalari" icon={Gauge}>
            <div className="flex flex-col gap-2">
              <label style={{ fontSize: 11.5, color: COLORS.textMuted }}>Kapital hajmi ($)
                <input type="number" value={risk.accountSize} onChange={e => setRisk(r => ({ ...r, accountSize: parseFloat(e.target.value) || 0 }))}
                  style={{ width: '100%', background: COLORS.surfaceRaised, border: `1px solid ${COLORS.hairline}`, borderRadius: 6, padding: '6px 8px', color: COLORS.textPrimary, fontFamily: 'IBM Plex Mono, monospace', fontSize: 12.5, marginTop: 3 }} />
              </label>
              <label style={{ fontSize: 11.5, color: COLORS.textMuted }}>Savdoga xavf, % ({risk.riskPercent}%)
                <input type="range" min="0.25" max="3" step="0.25" value={risk.riskPercent} onChange={e => setRisk(r => ({ ...r, riskPercent: parseFloat(e.target.value) }))}
                  style={{ width: '100%', accentColor: COLORS.brass, marginTop: 3 }} />
              </label>
              <label style={{ fontSize: 11.5, color: COLORS.textMuted }}>Stop-loss usuli
                <div className="flex gap-2" style={{ marginTop: 3 }}>
                  <button onClick={() => setRisk(r => ({ ...r, stopMode: 'percent' }))}
                    style={{ flex: 1, background: risk.stopMode === 'percent' ? COLORS.brass : COLORS.surfaceRaised, color: risk.stopMode === 'percent' ? '#1A1405' : COLORS.textMuted, border: `1px solid ${COLORS.hairline}`, borderRadius: 5, padding: '5px 0', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Foiz</button>
                  <button onClick={() => setRisk(r => ({ ...r, stopMode: 'atr' }))}
                    style={{ flex: 1, background: risk.stopMode === 'atr' ? COLORS.brass : COLORS.surfaceRaised, color: risk.stopMode === 'atr' ? '#1A1405' : COLORS.textMuted, border: `1px solid ${COLORS.hairline}`, borderRadius: 5, padding: '5px 0', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>ATR</button>
                </div>
              </label>
              {risk.stopMode === 'percent' ? (
                <label style={{ fontSize: 11.5, color: COLORS.textMuted }}>Stop-loss, narxdan % past ({risk.stopLossPercent}%)
                  <input type="range" min="2" max="20" step="1" value={risk.stopLossPercent} onChange={e => setRisk(r => ({ ...r, stopLossPercent: parseFloat(e.target.value) }))}
                    style={{ width: '100%', accentColor: COLORS.brass, marginTop: 3 }} />
                </label>
              ) : (
                <label style={{ fontSize: 11.5, color: COLORS.textMuted }}>ATR ko'paytiruvchisi ({risk.atrMultiplier}x)
                  <input type="range" min="1" max="4" step="0.5" value={risk.atrMultiplier} onChange={e => setRisk(r => ({ ...r, atrMultiplier: parseFloat(e.target.value) }))}
                    style={{ width: '100%', accentColor: COLORS.brass, marginTop: 3 }} />
                  <div style={{ fontSize: 10.5, color: COLORS.textMuted, marginTop: 3 }}>Har bir aksiyaning o'z volatilligiga moslashadi — sokin aksiyada tor, harakatchan aksiyada keng stop.</div>
                </label>
              )}
              <label style={{ fontSize: 11.5, color: COLORS.textMuted }}>Xavf:Foyda nisbati (1:{risk.riskReward})
                <input type="range" min="1" max="5" step="0.5" value={risk.riskReward} onChange={e => setRisk(r => ({ ...r, riskReward: parseFloat(e.target.value) }))}
                  style={{ width: '100%', accentColor: COLORS.brass, marginTop: 3 }} />
              </label>
            </div>
          </Card>

          <Card title="Strategiya og'irligi" icon={Settings2}>
            <label style={{ fontSize: 11.5, color: COLORS.textMuted }}>
              Fundamental {weights.fundamental}% · Texnik {weights.technical}%
              <input type="range" min="0" max="100" step="5" value={weights.fundamental}
                onChange={e => { const f = parseInt(e.target.value); setWeights({ fundamental: f, technical: 100 - f }); }}
                style={{ width: '100%', accentColor: COLORS.brass, marginTop: 6 }} />
            </label>
            <div style={{ fontSize: 11.5, color: COLORS.textMuted, marginTop: 8, lineHeight: 1.5 }}>
              Chapga — texnikaga og'irlik beradi, o'ngga — fundamentalga. Bu vaznlarni o'zingizning strategiyangizga mos ravishda istalgan payt o'zgartira olasiz.
            </div>
          </Card>

          <Card title="Fundamental mezonlari" icon={Gauge}>
            <div className="flex flex-col gap-2">
              <label style={{ fontSize: 11.5, color: COLORS.textMuted }}>Arzon P/E chegarasi (&lt;{fundCriteria.goodPE})
                <input type="range" min="5" max="30" step="1" value={fundCriteria.goodPE}
                  onChange={e => setFundCriteria(f => ({ ...f, goodPE: parseInt(e.target.value) }))}
                  style={{ width: '100%', accentColor: COLORS.brass, marginTop: 3 }} />
              </label>
              <label style={{ fontSize: 11.5, color: COLORS.textMuted }}>Qimmat P/E chegarasi (&gt;{fundCriteria.expensivePE})
                <input type="range" min="20" max="80" step="5" value={fundCriteria.expensivePE}
                  onChange={e => setFundCriteria(f => ({ ...f, expensivePE: parseInt(e.target.value) }))}
                  style={{ width: '100%', accentColor: COLORS.brass, marginTop: 3 }} />
              </label>
              <label style={{ fontSize: 11.5, color: COLORS.textMuted }}>Min daromad o'sishi (&gt;{fundCriteria.minRevenueGrowth}%)
                <input type="range" min="-20" max="30" step="1" value={fundCriteria.minRevenueGrowth}
                  onChange={e => setFundCriteria(f => ({ ...f, minRevenueGrowth: parseInt(e.target.value) }))}
                  style={{ width: '100%', accentColor: COLORS.brass, marginTop: 3 }} />
              </label>
              <label style={{ fontSize: 11.5, color: COLORS.textMuted }}>Yaxshi foyda marjasi (&gt;{(fundCriteria.goodMargin * 100).toFixed(0)}%)
                <input type="range" min="0" max="40" step="1" value={fundCriteria.goodMargin * 100}
                  onChange={e => setFundCriteria(f => ({ ...f, goodMargin: parseInt(e.target.value) / 100 }))}
                  style={{ width: '100%', accentColor: COLORS.brass, marginTop: 3 }} />
              </label>
            </div>
          </Card>

          <Card title="Kuzatuv ro'yxati" icon={ListChecks}>
            <textarea
              value={tickerInput}
              onChange={e => setTickerInput(e.target.value)}
              placeholder="Masalan: AAPL, MSFT, NVDA"
              rows={2}
              style={{ width: '100%', background: COLORS.surfaceRaised, border: `1px solid ${COLORS.hairline}`, borderRadius: 6, padding: '8px 10px', color: COLORS.textPrimary, fontFamily: 'IBM Plex Mono, monospace', fontSize: 12.5, resize: 'vertical', marginBottom: 8 }}
            />
            <button onClick={addTickers} disabled={!tickerInput.trim()}
              style={{ background: COLORS.surfaceRaised, border: `1px solid ${COLORS.brassDim}`, color: COLORS.brass, borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Plus size={13} /> Ro'yxatga qo'shish
            </button>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              {watchlist.map(sym => (
                <span key={sym} style={{ display: 'flex', alignItems: 'center', gap: 4, background: COLORS.surfaceRaised, border: `1px solid ${COLORS.hairline}`, borderRadius: 5, padding: '3px 6px 3px 8px', fontFamily: 'IBM Plex Mono, monospace', fontSize: 11.5 }}>
                  {sym}
                  <X size={11} style={{ cursor: 'pointer', color: COLORS.textMuted }} onClick={() => removeTicker(sym)} />
                </span>
              ))}
              {watchlist.length === 0 && <span style={{ fontSize: 11.5, color: COLORS.textMuted }}>Ro'yxat bo'sh</span>}
            </div>
          </Card>
        </div>

        {/* Strategies */}
        <Card title={`Strategiyalar (${strategies.filter(s => s.active).length}/${strategies.length} faol)`} icon={Settings2} right={
          <div className="flex items-center gap-2">
            <button onClick={() => { if (window.confirm("Uchala professional strategiyani standart holatga qaytarasizmi? Boshqa qo'shgan strategiyalaringiz saqlanib qoladi.")) resetBuiltinStrategies(); }} title="Uchala professional strategiyani standart holatga qaytaradi (boshqa qo'shgan strategiyalaringiz saqlanadi)"
              style={{ background: 'transparent', border: `1px solid ${COLORS.hairline}`, color: COLORS.textMuted, borderRadius: 6, padding: '4px 10px', fontSize: 11.5, cursor: 'pointer' }}>
              Standartga qaytarish
            </button>
            <button onClick={() => setStrategyForm(blankStrategy())}
              style={{ background: COLORS.surfaceRaised, border: `1px solid ${COLORS.brassDim}`, color: COLORS.brass, borderRadius: 6, padding: '4px 10px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Plus size={12} /> Yangi strategiya
            </button>
          </div>
        }>
          <div className="flex flex-col gap-2" style={{ marginBottom: strategyForm ? 12 : 0 }}>
            {strategies.map(s => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: COLORS.surfaceRaised, borderRadius: 6, flexWrap: 'wrap' }}>
                <input type="checkbox" checked={s.active} onChange={() => toggleStrategyActive(s.id)} style={{ accentColor: COLORS.brass }} />
                <span style={{ fontWeight: 600, fontSize: 12.5, minWidth: 140 }}>{s.name}</span>
                <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 11, color: COLORS.textMuted, flex: 1 }}>
                  {s.builtin === 'breakout'
                    ? '5 mezon: uptrend, qarshilik buzilishi, hajm, HL+EMA, (+EMA kesishuv) \u2014 quyida "BREAKOUT TAHLILI"da batafsil'
                    : s.builtin === 'reversal'
                    ? 'Kunlik: downtrend buzilishi + EMA20 kesishuv \u2014 o\u2018tsa, "Reversal chuqur tekshiruvi" bilan soatlik HL/HH/qarshilik tekshiriladi'
                    : s.builtin === 'pullback'
                    ? 'Kunlik: umumiy uptrend \u2014 o\u2018tsa, "Pullback chuqur tekshiruvi" bilan 4soatlik EMA/Fibonacci/flip tekshiriladi'
                    : `trend=${s.trend} · RSI ${s.rsiMin}-${s.rsiMax} · MACD=${s.macd}${s.volMin > 0 ? ` · hajm≥${s.volMin}x` : ''}`}
                </span>
                {!s.builtin && (
                  <button onClick={() => setStrategyForm({ ...s })} style={{ background: 'transparent', border: 'none', color: COLORS.textMuted, cursor: 'pointer', fontSize: 11.5, textDecoration: 'underline' }}>tahrirlash</button>
                )}
                <X size={14} style={{ cursor: 'pointer', color: COLORS.negative }} onClick={() => deleteStrategy(s.id)} />
              </div>
            ))}
            {strategies.length === 0 && <span style={{ fontSize: 11.5, color: COLORS.textMuted }}>Hali strategiya yo'q — "Yangi strategiya"ni bosing</span>}
          </div>

          {strategyForm && (
            <div style={{ border: `1px solid ${COLORS.brassDim}`, borderRadius: 8, padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
              <label style={{ fontSize: 11, color: COLORS.textMuted, gridColumn: '1 / -1' }}>Nomi
                <input value={strategyForm.name} onChange={e => setStrategyForm(f => ({ ...f, name: e.target.value }))} placeholder="Masalan: Breakout"
                  style={{ width: '100%', background: COLORS.surface, border: `1px solid ${COLORS.hairline}`, borderRadius: 6, padding: '6px 8px', color: COLORS.textPrimary, fontSize: 12.5, marginTop: 3 }} />
              </label>
              <label style={{ fontSize: 11, color: COLORS.textMuted }}>Trend talabi
                <select value={strategyForm.trend} onChange={e => setStrategyForm(f => ({ ...f, trend: e.target.value }))}
                  style={{ width: '100%', background: COLORS.surface, border: `1px solid ${COLORS.hairline}`, borderRadius: 6, padding: '6px 8px', color: COLORS.textPrimary, fontSize: 12.5, marginTop: 3 }}>
                  <option value="any">Muhim emas</option>
                  <option value="up">Yuqoriga (uptrend)</option>
                  <option value="down">Pastga (downtrend)</option>
                </select>
              </label>
              <label style={{ fontSize: 11, color: COLORS.textMuted }}>MACD talabi
                <select value={strategyForm.macd} onChange={e => setStrategyForm(f => ({ ...f, macd: e.target.value }))}
                  style={{ width: '100%', background: COLORS.surface, border: `1px solid ${COLORS.hairline}`, borderRadius: 6, padding: '6px 8px', color: COLORS.textPrimary, fontSize: 12.5, marginTop: 3 }}>
                  <option value="any">Muhim emas</option>
                  <option value="positive">Musbat</option>
                  <option value="negative">Manfiy</option>
                </select>
              </label>
              <label style={{ fontSize: 11, color: COLORS.textMuted }}>RSI min
                <input type="number" min="0" max="100" value={strategyForm.rsiMin} onChange={e => setStrategyForm(f => ({ ...f, rsiMin: parseFloat(e.target.value) || 0 }))}
                  style={{ width: '100%', background: COLORS.surface, border: `1px solid ${COLORS.hairline}`, borderRadius: 6, padding: '6px 8px', color: COLORS.textPrimary, fontSize: 12.5, marginTop: 3 }} />
              </label>
              <label style={{ fontSize: 11, color: COLORS.textMuted }}>RSI max
                <input type="number" min="0" max="100" value={strategyForm.rsiMax} onChange={e => setStrategyForm(f => ({ ...f, rsiMax: parseFloat(e.target.value) || 100 }))}
                  style={{ width: '100%', background: COLORS.surface, border: `1px solid ${COLORS.hairline}`, borderRadius: 6, padding: '6px 8px', color: COLORS.textPrimary, fontSize: 12.5, marginTop: 3 }} />
              </label>
              <label style={{ fontSize: 11, color: COLORS.textMuted }}>Min hajm nisbati (0 = shart emas)
                <input type="number" min="0" step="0.1" value={strategyForm.volMin} onChange={e => setStrategyForm(f => ({ ...f, volMin: parseFloat(e.target.value) || 0 }))}
                  style={{ width: '100%', background: COLORS.surface, border: `1px solid ${COLORS.hairline}`, borderRadius: 6, padding: '6px 8px', color: COLORS.textPrimary, fontSize: 12.5, marginTop: 3 }} />
              </label>
              <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
                <button onClick={saveStrategy} disabled={!strategyForm.name.trim()}
                  style={{ background: COLORS.brass, color: '#1A1405', border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Saqlash</button>
                <button onClick={() => setStrategyForm(null)}
                  style={{ background: 'transparent', border: `1px solid ${COLORS.hairline}`, color: COLORS.textMuted, borderRadius: 6, padding: '6px 14px', fontSize: 12, cursor: 'pointer' }}>Bekor qilish</button>
              </div>
            </div>
          )}
        </Card>
        <div style={{ marginBottom: 20 }} />

        {/* Trade journal */}
        <Card title={`Savdo jurnali (${journal.filter(t => t.status === 'open').length} ochiq · ${journal.filter(t => t.status !== 'open').length} yopilgan)`} icon={ListChecks}>
          {journal.length === 0 ? (
            <div style={{ fontSize: 12.5, color: COLORS.textMuted }}>Hali savdo yozilmagan. Har bir nomzodning "KIRISH/TP/SL" panelida "+ Savdoni jurnalga yozib qo'yish" tugmasini bosing.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {journal.slice().reverse().map(t => {
                const live = results[t.symbol]?.tech?.price;
                const pnlPct = (t.status === 'open' && live != null) ? ((live - t.entryPrice) / t.entryPrice) * 100 : null;
                const hitTP = t.status === 'open' && live != null && live >= t.takeProfit;
                const hitSL = t.status === 'open' && live != null && live <= t.stopLoss;
                return (
                  <div key={t.id} style={{ background: COLORS.surfaceRaised, borderRadius: 6, padding: '10px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontWeight: 700, fontSize: 13, minWidth: 55 }}>{t.symbol}</span>
                      <span style={{ fontSize: 10.5, color: COLORS.textMuted }}>{t.strategy}</span>
                      <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 11.5 }}>Kirish ${t.entryPrice.toFixed(2)} · {t.shares} dona</span>
                      {t.status === 'open' ? (
                        <>
                          <span style={{ fontSize: 10, background: 'rgba(201,162,75,0.15)', color: COLORS.brass, borderRadius: 3, padding: '1px 6px' }}>OCHIQ</span>
                          {pnlPct != null && (
                            <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 12.5, fontWeight: 700, color: pnlPct >= 0 ? COLORS.positive : COLORS.negative }}>
                              {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(1)}%
                            </span>
                          )}
                          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                            {(hitTP || hitSL) && (
                              <button onClick={() => closeJournalEntry(t.id, hitTP ? t.takeProfit : t.stopLoss, hitTP ? 'closed_tp' : 'closed_sl')}
                                style={{ background: hitTP ? COLORS.positive : COLORS.negative, color: '#0A0E17', border: 'none', borderRadius: 5, padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                                {hitTP ? 'TP ga yetdi — yopish' : 'SL ga yetdi — yopish'}
                              </button>
                            )}
                            <button onClick={() => { const ep = prompt("Chiqish narxini kiriting:", live?.toFixed(2) || t.entryPrice.toFixed(2)); if (ep && !isNaN(parseFloat(ep))) closeJournalEntry(t.id, parseFloat(ep), 'closed_manual'); }}
                              style={{ background: 'transparent', border: `1px solid ${COLORS.hairline}`, color: COLORS.textMuted, borderRadius: 5, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}>Qo'lda yopish</button>
                            <X size={14} style={{ cursor: 'pointer', color: COLORS.negative, alignSelf: 'center' }} onClick={() => deleteJournalEntry(t.id)} />
                          </div>
                        </>
                      ) : (
                        <>
                          <span style={{ fontSize: 10, background: t.status === 'closed_tp' ? 'rgba(63,191,143,0.15)' : t.status === 'closed_sl' ? 'rgba(232,97,92,0.15)' : 'rgba(139,145,168,0.15)', color: t.status === 'closed_tp' ? COLORS.positive : t.status === 'closed_sl' ? COLORS.negative : COLORS.textMuted, borderRadius: 3, padding: '1px 6px' }}>
                            {t.status === 'closed_tp' ? 'TP' : t.status === 'closed_sl' ? 'SL' : 'QO\u2018LDA'} YOPILDI
                          </span>
                          <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 12.5, fontWeight: 700, color: t.exitPrice >= t.entryPrice ? COLORS.positive : COLORS.negative }}>
                            {(((t.exitPrice - t.entryPrice) / t.entryPrice) * 100) >= 0 ? '+' : ''}{(((t.exitPrice - t.entryPrice) / t.entryPrice) * 100).toFixed(1)}%
                          </span>
                          <X size={14} style={{ marginLeft: 'auto', cursor: 'pointer', color: COLORS.textMuted }} onClick={() => deleteJournalEntry(t.id)} />
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {journalStats.length > 0 && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${COLORS.hairline}` }}>
              <div style={{ fontSize: 11, letterSpacing: '0.06em', color: COLORS.textMuted, marginBottom: 8 }}>STRATEGIYA BO'YICHA HAQIQIY NATIJA (sizning yopilgan savdolaringiz asosida)</div>
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                {journalStats.map(s => (
                  <div key={s.strategy} style={{ fontSize: 12.5 }}>
                    <div style={{ color: COLORS.textMuted }}>{s.strategy}</div>
                    <div style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
                      {s.count} savdo · <span style={{ color: s.winRate >= 50 ? COLORS.positive : COLORS.negative }}>{s.winRate.toFixed(0)}% g'olib</span> · o'rtacha {s.avgReturn >= 0 ? '+' : ''}{s.avgReturn.toFixed(1)}%
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
        <div style={{ marginBottom: 20 }} />

        {/* Action row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 24, background: COLORS.surface, border: `1px solid ${COLORS.hairline}`, borderRadius: 10, padding: '14px 16px' }}>
          <button onClick={runTechnicalAnalysis} disabled={!apiKey || watchlist.length === 0 || running || runningFund}
            style={{ background: COLORS.brass, color: '#1A1405', border: 'none', borderRadius: 6, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: (!apiKey || watchlist.length === 0) ? 'not-allowed' : 'pointer', opacity: (!apiKey || watchlist.length === 0) ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={14} className={running ? 'animate-spin' : ''} /> Texnik tahlilni ishga tushirish
          </button>
          <div className="flex flex-col" style={{ gap: 3 }}>
            <button onClick={runFundamentalRefresh} disabled={!alphaKey || candidateSymbols.length === 0 || running || runningFund}
              style={{ background: 'transparent', color: COLORS.textPrimary, border: `1px solid ${COLORS.hairline}`, borderRadius: 6, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: (!alphaKey || candidateSymbols.length === 0) ? 'not-allowed' : 'pointer', opacity: (!alphaKey || candidateSymbols.length === 0) ? 0.5 : 1 }}>
              Fundamentalni yangilash ({candidateSymbols.length} nomzod)
            </button>
            {candidateSymbols.length > 0 && <span style={{ fontSize: 10.5, color: COLORS.textMuted, fontFamily: 'IBM Plex Mono, monospace' }}>{candidateSymbols.join(', ')}</span>}
          </div>
          <div className="flex flex-col" style={{ gap: 3 }}>
            <button onClick={runReversalDeepCheck} disabled={!apiKey || reversalPreCandidates.length === 0 || running || runningFund || runningReversal || runningPullback || runningBreakoutHL}
              style={{ background: 'transparent', color: COLORS.textPrimary, border: `1px solid ${COLORS.hairline}`, borderRadius: 6, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: (!apiKey || reversalPreCandidates.length === 0) ? 'not-allowed' : 'pointer', opacity: (!apiKey || reversalPreCandidates.length === 0) ? 0.5 : 1 }}>
              Reversal chuqur tekshiruvi ({reversalPreCandidates.length})
            </button>
            {reversalPreCandidates.length > 0 && <span style={{ fontSize: 10.5, color: COLORS.textMuted, fontFamily: 'IBM Plex Mono, monospace' }}>{reversalPreCandidates.join(', ')}</span>}
          </div>
          <div className="flex flex-col" style={{ gap: 3 }}>
            <button onClick={runPullbackDeepCheck} disabled={!apiKey || pullbackGateCandidates.length === 0 || running || runningFund || runningReversal || runningPullback || runningBreakoutHL}
              style={{ background: 'transparent', color: COLORS.textPrimary, border: `1px solid ${COLORS.hairline}`, borderRadius: 6, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: (!apiKey || pullbackGateCandidates.length === 0) ? 'not-allowed' : 'pointer', opacity: (!apiKey || pullbackGateCandidates.length === 0) ? 0.5 : 1 }}>
              Pullback chuqur tekshiruvi ({pullbackGateCandidates.length})
            </button>
            {pullbackGateCandidates.length > 0 && <span style={{ fontSize: 10.5, color: COLORS.textMuted, fontFamily: 'IBM Plex Mono, monospace' }}>{pullbackGateCandidates.join(', ')}</span>}
          </div>
          <div className="flex flex-col" style={{ gap: 3 }}>
            <button onClick={runBreakoutHourlyCheck} disabled={!apiKey || breakoutMatchedCandidates.length === 0 || running || runningFund || runningReversal || runningPullback || runningBreakoutHL}
              title="Ixtiyoriy: Higher Low'ni soatlik ma'lumotda qo'shimcha tasdiqlaydi. Breakout'ning asosiy natijasiga ta'sir qilmaydi."
              style={{ background: 'transparent', color: COLORS.textPrimary, border: `1px solid ${COLORS.hairline}`, borderRadius: 6, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: (!apiKey || breakoutMatchedCandidates.length === 0) ? 'not-allowed' : 'pointer', opacity: (!apiKey || breakoutMatchedCandidates.length === 0) ? 0.5 : 1 }}>
              Breakout HL tasdig'i, soatlik (ixtiyoriy) ({breakoutMatchedCandidates.length})
            </button>
            {breakoutMatchedCandidates.length > 0 && <span style={{ fontSize: 10.5, color: COLORS.textMuted, fontFamily: 'IBM Plex Mono, monospace' }}>{breakoutMatchedCandidates.join(', ')}</span>}
          </div>
          {(running || runningFund || runningReversal || runningPullback || runningBreakoutHL) && (
            <button onClick={stopRun} style={{ background: 'transparent', color: COLORS.negative, border: `1px solid ${COLORS.negative}`, borderRadius: 6, padding: '9px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
              <Square size={12} /> To'xtatish
            </button>
          )}
          {(running || runningFund || runningReversal || runningPullback || runningBreakoutHL) ? (
            <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 12, color: COLORS.textMuted }}>
              {progress.done}/{progress.total} tahlil qilindi...
            </span>
          ) : watchlist.length > 0 && (
            <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 12, color: COLORS.textMuted }}>
              Texnik: ~{estSeconds}s (kuniga 800, hammasiga). Fundamental: faqat {candidateSymbols.length} ta nomzodga — kuniga 25 limitiga bemalol sig'adi.
            </span>
          )}
        </div>

        {aggregateRisk.count > 0 && (
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16, background: COLORS.surface, border: `1px solid ${COLORS.hairline}`, borderRadius: 10, padding: '12px 16px' }}>
            <span style={{ fontSize: 11, letterSpacing: '0.06em', color: COLORS.textMuted, fontWeight: 700 }}>UMUMIY XAVF ({aggregateRisk.count} nomzod birga olinsa)</span>
            <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 13 }}>
              Jami xavf: <span style={{ color: aggregateRisk.totalRisk > risk.accountSize * (risk.riskPercent / 100) * aggregateRisk.count * 1.01 ? COLORS.negative : COLORS.textPrimary, fontWeight: 700 }}>${aggregateRisk.totalRisk.toFixed(0)}</span>
              <span style={{ color: COLORS.textMuted }}> ({((aggregateRisk.totalRisk / risk.accountSize) * 100).toFixed(1)}% kapitaldan)</span>
            </span>
            <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 13 }}>
              Jami pozitsiya qiymati: <span style={{ fontWeight: 700 }}>${aggregateRisk.totalValue.toFixed(0)}</span>
              {aggregateRisk.totalValue > risk.accountSize && <span style={{ color: COLORS.negative }}> — kapitalingizdan (${risk.accountSize}) oshadi!</span>}
            </span>
          </div>
        )}

        {/* Results */}
        <div className="flex flex-col gap-3">
          {rows.length === 0 && (
            <div style={{ textAlign: 'center', padding: '48px 20px', color: COLORS.textMuted, border: `1px dashed ${COLORS.hairline}`, borderRadius: 10 }}>
              Hali ro'yxat bo'sh. Yuqorida "Kuzatuv ro'yxati"ga aksiyalaringizni qo'shing va tahlilni ishga tushiring.
            </div>
          )}
          {rows.map(row => {
            const isOpen = expanded[row.symbol];
            const c = row.composite?.value;
            const tint = c == null ? COLORS.hairline : c >= 65 ? COLORS.positive : c >= 40 ? COLORS.brass : COLORS.negative;
            const atrStopDistance = row.tech?.atr != null ? row.tech.atr * risk.atrMultiplier : null;
            const stopPrice = row.tech
              ? (risk.stopMode === 'atr' && atrStopDistance != null
                  ? row.tech.price - atrStopDistance
                  : row.tech.price * (1 - risk.stopLossPercent / 100))
              : null;
            const posRisk = row.tech ? computeRisk(row.tech.price, stopPrice, risk.accountSize, risk.riskPercent, risk.riskReward) : null;

            return (
              <div key={row.symbol} style={{ background: COLORS.surface, border: `1px solid ${COLORS.hairline}`, borderLeft: `3px solid ${tint}`, borderRadius: 8, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', cursor: 'pointer', flexWrap: 'wrap', opacity: (row.tech && !row.isCandidate && !isOpen) ? 0.45 : 1 }}
                  onClick={() => setExpanded(prev => ({ ...prev, [row.symbol]: !prev[row.symbol] }))}>

                  <div style={{ width: 84, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontWeight: 600, fontSize: 15 }}>{row.symbol}</span>
                    <a
                      href={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(row.symbol)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="TradingView'da ochish"
                      onClick={(e) => e.stopPropagation()}
                      style={{ color: COLORS.textMuted, display: 'flex' }}
                    >
                      <ExternalLink size={12} />
                    </a>
                  </div>

                  <div style={{ width: 90, fontFamily: 'IBM Plex Mono, monospace', fontSize: 13 }}>
                    {row.tech ? `$${row.tech.price.toFixed(2)}` : row.loading ? '...' : '—'}
                  </div>

                  <div style={{ flex: 1, minWidth: 160, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <ScoreBar label="F" value={row.fund?.score ?? null} />
                    <ScoreBar label="T" value={row.tech?.score ?? null} />
                    {row.tech && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
                        {row.matchedStrategies.length > 0 ? row.matchedStrategies.map(name => (
                          <span key={name} style={{ fontSize: 9.5, background: 'rgba(63,191,143,0.15)', color: COLORS.positive, border: `1px solid ${COLORS.positive}`, borderRadius: 3, padding: '1px 5px' }}>{name}</span>
                        )) : <span style={{ fontSize: 9.5, color: COLORS.textMuted }}>Hech bir strategiyaga mos emas</span>}
                        {row.tech && !row.isCandidate && row.matchedStrategies.length > 0 && (
                          <span style={{ fontSize: 9.5, color: COLORS.negative }}>· kapitalga sig'maydi</span>
                        )}
                        {row.relativeStrength?.strong && (
                          <span style={{ fontSize: 9.5, background: 'rgba(201,162,75,0.15)', color: COLORS.brass, border: `1px solid ${COLORS.brass}`, borderRadius: 3, padding: '1px 5px' }}>S&P 500dan kuchli</span>
                        )}
                        {row.relativeStrength?.weak && (
                          <span style={{ fontSize: 9.5, color: COLORS.textMuted }}>· bozordan zaif</span>
                        )}
                      </div>
                    )}
                  </div>

                  <div style={{ width: 70, textAlign: 'center' }}>
                    <div style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 20, fontWeight: 600, color: tint }}>{c ?? '—'}</div>
                    <div style={{ fontSize: 9.5, color: COLORS.textMuted, letterSpacing: '0.05em' }}>UMUMIY</div>
                  </div>

                  {(row.loading || row.fundLoading) && <RefreshCw size={15} className="animate-spin" color={COLORS.brass} />}
                  {row.error && <AlertCircle size={16} color={COLORS.negative} title={row.error} />}
                  {isOpen ? <ChevronUp size={16} color={COLORS.textMuted} /> : <ChevronDown size={16} color={COLORS.textMuted} />}
                </div>

                {isOpen && (
                  <div style={{ padding: '4px 16px 18px', borderTop: `1px solid ${COLORS.hairline}` }}>
                    {row.error && <div style={{ color: COLORS.negative, fontSize: 12.5, marginBottom: 10 }}>Texnik xato: {row.error}</div>}
                    {row.fundError && <div style={{ color: COLORS.negative, fontSize: 12.5, marginBottom: 10 }}>Fundamental xato: {row.fundError}</div>}

                    {row.chartData && row.chartData.length > 5 && (() => {
                      const big = !!chartBig[row.symbol];
                      return (
                      <div style={{ marginBottom: 14 }}>
                        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 10, color: COLORS.textMuted }}>
                            <span style={{ display: 'inline-block', width: 8, height: 8, background: COLORS.positive, marginRight: 4, borderRadius: 1 }} />Yuqori shamcha
                          </span>
                          <span style={{ fontSize: 10, color: COLORS.textMuted }}>
                            <span style={{ display: 'inline-block', width: 8, height: 8, background: COLORS.negative, marginRight: 4, borderRadius: 1 }} />Pastki shamcha
                          </span>
                          <span style={{ fontSize: 10, color: COLORS.textMuted }}>
                            <span style={{ display: 'inline-block', width: 8, height: 2, background: COLORS.brass, marginRight: 4 }} />SMA50
                          </span>
                          <button
                            onClick={(e) => { e.stopPropagation(); setChartBig(prev => ({ ...prev, [row.symbol]: !prev[row.symbol] })); }}
                            title={big ? 'Kichraytirish' : 'Kattalashtirish'}
                            style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, background: COLORS.surfaceRaised, border: `1px solid ${COLORS.hairline}`, color: COLORS.brass, borderRadius: 5, padding: '3px 8px', fontSize: 10.5, cursor: 'pointer' }}>
                            {big ? <Minimize2 size={11} /> : <Maximize2 size={11} />} {big ? 'Kichraytirish' : 'Kattalashtirish'}
                          </button>
                        </div>
                        <div style={{ background: COLORS.surfaceRaised, borderRadius: 6, padding: '8px 4px 4px' }}>
                          <CandlestickChart
                            data={row.chartData}
                            sma200={row.tech?.sma200}
                            entry={row.tech?.price}
                            stopLoss={stopPrice}
                            takeProfit={posRisk?.takeProfit}
                            plotHeight={big ? 440 : 170}
                          />
                          <div style={{ marginTop: 2 }}>
                            <VolumeChart data={row.chartData} height={big ? 90 : 40} />
                          </div>
                        </div>
                        <div style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 8, marginBottom: 4 }}>RSI (14) — 30/70 chegaralari bilan</div>
                        <div style={{ height: big ? 100 : 44 }}>
                          <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={row.chartData}>
                              <YAxis domain={[0, 100]} hide />
                              <ReferenceLine y={70} stroke={COLORS.negative} strokeDasharray="2 2" />
                              <ReferenceLine y={30} stroke={COLORS.positive} strokeDasharray="2 2" />
                              <Line type="monotone" dataKey="rsi" stroke={COLORS.brass} strokeWidth={1.3} dot={false} isAnimationActive={false} />
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                      );
                    })()}

                    {row.breakout && (
                      <div style={{ background: row.breakout.matched ? 'rgba(63,191,143,0.1)' : 'rgba(139,145,168,0.06)', border: `1px solid ${row.breakout.matched ? COLORS.positive : COLORS.hairline}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                          <span style={{ fontSize: 11.5, letterSpacing: '0.06em', color: COLORS.brass, fontWeight: 700 }}>BREAKOUT TAHLILI</span>
                          <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 11, color: row.breakout.matched ? COLORS.positive : COLORS.textMuted, fontWeight: 700 }}>
                            {row.breakout.corePassed}/{row.breakout.coreTotal} mezon {row.breakout.matched ? '\u2014 TO\u2018LIQ MOS' : ''}
                          </span>
                        </div>
                        <ul style={{ fontSize: 13, lineHeight: 1.8, paddingLeft: 0, margin: 0, listStyle: 'none' }}>
                          {row.breakout.criteria.map(c => (
                            <li key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', opacity: c.bonus && !c.passed ? 0.6 : 1 }}>
                              <span style={{ color: c.passed ? COLORS.positive : (c.bonus ? COLORS.textMuted : COLORS.negative), fontWeight: 700, width: 14, flexShrink: 0 }}>{c.passed ? '\u2713' : '\u2717'}</span>
                              <span style={{ color: COLORS.textPrimary }}>{c.label}{c.detail ? <span style={{ color: COLORS.textMuted }}> — {c.detail}</span> : null}</span>
                            </li>
                          ))}
                          {row.breakoutHourlyHL && (
                            <li style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                              <span style={{ color: row.breakoutHourlyHL.confirmed ? COLORS.positive : COLORS.textMuted, fontWeight: 700, width: 14, flexShrink: 0 }}>{row.breakoutHourlyHL.confirmed ? '\u2713' : '\u2717'}</span>
                              <span style={{ color: COLORS.textPrimary }}>(ixtiyoriy) Higher Low, soatlik tasdiq<span style={{ color: COLORS.textMuted }}> — {row.breakoutHourlyHL.hlCount} marta topildi</span></span>
                            </li>
                          )}
                        </ul>
                      </div>
                    )}

                    {row.reversalDaily && (() => {
                      const hourlyDone = !!row.reversalHourly;
                      const fullyMatched = row.reversalDaily.passedDailyPreCheck && hourlyDone && row.reversalHourly.criteria.every(c => c.passed);
                      const preQualified = row.reversalDaily.passedDailyPreCheck;
                      return (
                        <div style={{ background: fullyMatched ? 'rgba(63,191,143,0.1)' : 'rgba(139,145,168,0.06)', border: `1px solid ${fullyMatched ? COLORS.positive : COLORS.hairline}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 11.5, letterSpacing: '0.06em', color: COLORS.brass, fontWeight: 700 }}>REVERSAL TAHLILI</span>
                            <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 11, color: fullyMatched ? COLORS.positive : COLORS.textMuted, fontWeight: 700 }}>
                              {fullyMatched ? 'TO\u2018LIQ MOS' : preQualified ? (hourlyDone ? 'Soatlik mos emas' : 'Kunlik o\u2018tdi \u2014 chuqur tekshiruv kerak') : 'Kunlik mezonlardan o\u2018tmadi'}
                            </span>
                          </div>
                          <div style={{ fontSize: 10.5, color: COLORS.textMuted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Kunlik (yillik kontekst)</div>
                          <ul style={{ fontSize: 13, lineHeight: 1.8, paddingLeft: 0, margin: '0 0 8px', listStyle: 'none' }}>
                            {row.reversalDaily.criteria.map(c => (
                              <li key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', opacity: c.bonus && !c.passed ? 0.6 : 1 }}>
                                <span style={{ color: c.passed ? COLORS.positive : (c.bonus ? COLORS.textMuted : COLORS.negative), fontWeight: 700, width: 14, flexShrink: 0 }}>{c.passed ? '\u2713' : '\u2717'}</span>
                                <span style={{ color: COLORS.textPrimary }}>{c.label}{c.detail ? <span style={{ color: COLORS.textMuted }}> — {c.detail}</span> : null}</span>
                              </li>
                            ))}
                          </ul>
                          <div style={{ fontSize: 10.5, color: COLORS.textMuted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Soatlik (chuqur tekshiruv)</div>
                          {hourlyDone ? (
                            <ul style={{ fontSize: 13, lineHeight: 1.8, paddingLeft: 0, margin: 0, listStyle: 'none' }}>
                              {row.reversalHourly.criteria.map(c => (
                                <li key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                                  <span style={{ color: c.passed ? COLORS.positive : COLORS.negative, fontWeight: 700, width: 14, flexShrink: 0 }}>{c.passed ? '\u2713' : '\u2717'}</span>
                                  <span style={{ color: COLORS.textPrimary }}>{c.label}{c.detail ? <span style={{ color: COLORS.textMuted }}> — {c.detail}</span> : null}</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <div style={{ fontSize: 12, color: COLORS.textMuted }}>
                              {preQualified ? 'Kunlik mezonlar o\u2018tdi \u2014 yuqoridagi "Reversal chuqur tekshiruvi" tugmasini bosing' : 'Avval kunlik mezonlardan o\u2018tishi kerak'}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {row.pullbackGate && (() => {
                      const deepDone = !!row.pullback4h;
                      const coreCrit = deepDone ? row.pullback4h.criteria.filter(c => !c.bonus) : [];
                      const fullyMatched = row.pullbackGate.passedDailyGate && deepDone && coreCrit.every(c => c.passed);
                      const gatePassed = row.pullbackGate.passedDailyGate;
                      return (
                        <div style={{ background: fullyMatched ? 'rgba(63,191,143,0.1)' : 'rgba(139,145,168,0.06)', border: `1px solid ${fullyMatched ? COLORS.positive : COLORS.hairline}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 11.5, letterSpacing: '0.06em', color: COLORS.brass, fontWeight: 700 }}>PULLBACK TAHLILI</span>
                            <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 11, color: fullyMatched ? COLORS.positive : COLORS.textMuted, fontWeight: 700 }}>
                              {fullyMatched ? 'TO\u2018LIQ MOS' : gatePassed ? (deepDone ? '4soatlikda mos emas' : 'Uptrend tasdiqlandi \u2014 chuqur tekshiruv kerak') : 'Umumiy uptrendda emas'}
                            </span>
                          </div>
                          <div style={{ fontSize: 10.5, color: COLORS.textMuted, marginBottom: 6 }}>Kunlik: umumiy uptrend {gatePassed ? '\u2713' : '\u2717'}</div>
                          <div style={{ fontSize: 10.5, color: COLORS.textMuted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>4-soatlik (chuqur tekshiruv)</div>
                          {deepDone ? (
                            <ul style={{ fontSize: 13, lineHeight: 1.8, paddingLeft: 0, margin: 0, listStyle: 'none' }}>
                              {row.pullback4h.criteria.map(c => (
                                <li key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', opacity: c.bonus && !c.passed ? 0.6 : 1 }}>
                                  <span style={{ color: c.passed ? COLORS.positive : (c.bonus ? COLORS.textMuted : COLORS.negative), fontWeight: 700, width: 14, flexShrink: 0 }}>{c.passed ? '\u2713' : '\u2717'}</span>
                                  <span style={{ color: COLORS.textPrimary }}>{c.label}{c.detail ? <span style={{ color: COLORS.textMuted }}> — {c.detail}</span> : null}</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <div style={{ fontSize: 12, color: COLORS.textMuted }}>
                              {gatePassed ? 'Uptrend tasdiqlandi \u2014 yuqoridagi "Pullback chuqur tekshiruvi" tugmasini bosing' : 'Avval umumiy uptrendda bo\u2018lishi kerak'}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                      <div style={{ background: 'rgba(63,191,143,0.06)', border: `1px solid ${COLORS.hairline}`, borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 11.5, letterSpacing: '0.06em', color: COLORS.brass, marginBottom: 8, fontWeight: 700 }}>TEXNIK IZOH</div>
                        {row.tech ? (
                          <ul style={{ fontSize: 13.5, lineHeight: 1.75, paddingLeft: 18, margin: 0, color: COLORS.textPrimary, fontWeight: 500 }}>
                            {row.tech.notes.map((n, i) => <li key={i}>{n}</li>)}
                          </ul>
                        ) : <div style={{ fontSize: 12.5, color: COLORS.textMuted }}>Hali tahlil qilinmagan</div>}
                      </div>
                      <div style={{ background: 'rgba(63,191,143,0.06)', border: `1px solid ${COLORS.hairline}`, borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 11.5, letterSpacing: '0.06em', color: COLORS.brass, marginBottom: 8, fontWeight: 700 }}>FUNDAMENTAL IZOH</div>
                        {row.fund ? (
                          <ul style={{ fontSize: 13.5, lineHeight: 1.75, paddingLeft: 18, margin: 0, color: COLORS.textPrimary, fontWeight: 500 }}>
                            {row.fund.notes.map((n, i) => <li key={i}>{n}</li>)}
                          </ul>
                        ) : <div style={{ fontSize: 12.5, color: COLORS.textMuted }}>Hali yangilanmagan — "Fundamentalni yangilash" tugmasini bosing</div>}
                      </div>
                      <div>
                        <div style={{ fontSize: 11, letterSpacing: '0.06em', color: COLORS.textMuted, marginBottom: 6 }}>KIRISH / TP / SL</div>
                        {(activeStrategies.length > 0 && row.matchedStrategies.length === 0) ? (
                          <div style={{ fontSize: 12.5, color: COLORS.textMuted, lineHeight: 1.6 }}>Bu aksiya faol strategiyalaringizning birortasiga mos kelmadi, shuning uchun savdo darajalari ko'rsatilmaydi.</div>
                        ) : posRisk ? (
                          <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
                            <div>Kirish (joriy narx): <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>${row.tech.price.toFixed(2)}</span></div>
                            <div>Take-profit: <span style={{ fontFamily: 'IBM Plex Mono, monospace', color: COLORS.positive }}>${posRisk.takeProfit.toFixed(2)}</span> (1:{risk.riskReward})</div>
                            <div>Stop-loss: <span style={{ fontFamily: 'IBM Plex Mono, monospace', color: COLORS.negative }}>${stopPrice.toFixed(2)}</span> ({risk.stopMode === 'atr' && atrStopDistance != null ? `${risk.atrMultiplier}x ATR ($${row.tech.atr.toFixed(2)})` : `${risk.stopLossPercent}% past`})</div>
                            <div>20-kunlik pastki: <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>${row.tech.low20?.toFixed(2)}</span></div>
                            <div>Tavsiya etilgan hajm: <span style={{ fontFamily: 'IBM Plex Mono, monospace', color: COLORS.brass }}>{posRisk.shares} dona</span></div>
                            {posRisk.shares === 0 && <div style={{ color: COLORS.textMuted, fontSize: 11.5 }}>0 chiqdi — bu xato emas: joriy xavf byudjetingiz (kapital × xavf%) bitta aksiyaning stop masofasidan kichik. Xavf % ni oshiring yoki stop-lossni torayting.</div>}
                            <div>Pozitsiya qiymati: <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>${posRisk.positionValue.toFixed(0)}</span></div>
                            {posRisk.capped && <div style={{ color: COLORS.negative, fontSize: 11.5 }}>Kapital chegarasi tufayli hajm cheklandi</div>}
                            <button
                              onClick={() => setJournalForm({
                                symbol: row.symbol, strategy: row.matchedStrategies[0] || 'Boshqa',
                                entryPrice: row.tech.price, stopLoss: stopPrice, takeProfit: posRisk.takeProfit, shares: posRisk.shares,
                              })}
                              style={{ marginTop: 8, background: COLORS.surfaceRaised, border: `1px solid ${COLORS.brassDim}`, color: COLORS.brass, borderRadius: 6, padding: '5px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>
                              + Savdoni jurnalga yozib qo'yish
                            </button>
                          </div>
                        ) : <div style={{ fontSize: 12.5, color: COLORS.textMuted }}>Texnik tahlildan keyin ko'rinadi</div>}
                      </div>
                    </div>

                    {row.relativeStrength && row.relativeStrength.periods.some(p => p.outperformance != null) && (
                      <div style={{ marginTop: 12, background: 'rgba(201,162,75,0.05)', border: `1px solid ${COLORS.hairline}`, borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 11.5, letterSpacing: '0.06em', color: COLORS.brass, marginBottom: 8, fontWeight: 700 }}>NISBIY KUCH (S&P 500ga nisbatan)</div>
                        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                          {row.relativeStrength.periods.map(p => (
                            <div key={p.label} style={{ fontSize: 12.5 }}>
                              <span style={{ color: COLORS.textMuted }}>{p.label}: </span>
                              {p.outperformance != null ? (
                                <span style={{ fontFamily: 'IBM Plex Mono, monospace', color: p.outperformance > 0 ? COLORS.positive : COLORS.negative, fontWeight: 700 }}>
                                  {p.outperformance > 0 ? '+' : ''}{p.outperformance.toFixed(1)}pp
                                </span>
                              ) : <span style={{ color: COLORS.textMuted }}>—</span>}
                            </div>
                          ))}
                        </div>
                        <div style={{ fontSize: 10.5, color: COLORS.textMuted, marginTop: 6 }}>pp = foiz punkti farqi (aksiya foizi − SPY foizi, shu davrda)</div>
                      </div>
                    )}

                    {row.backtests && (
                      <div style={{ marginTop: 12, background: 'rgba(139,145,168,0.05)', border: `1px solid ${COLORS.hairline}`, borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 11.5, letterSpacing: '0.06em', color: COLORS.brass, marginBottom: 8, fontWeight: 700 }}>TARIXIY TEKSHIRUV (~1 yillik ma'lumot, 10 kunlik natija)</div>
                        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                          {[['Breakout', row.backtests.breakout], ['Reversal (kunlik)', row.backtests.reversal], ['Pullback (kunlik)', row.backtests.pullback]].map(([label, bt]) => (
                            <div key={label} style={{ fontSize: 12.5, minWidth: 150 }}>
                              <div style={{ color: COLORS.textMuted, marginBottom: 2 }}>{label}</div>
                              {bt.triggerCount > 0 ? (
                                <div style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
                                  {bt.triggerCount} marta · <span style={{ color: bt.winRate >= 50 ? COLORS.positive : COLORS.negative }}>{bt.winRate.toFixed(0)}% g'olib</span> · o'rtacha {bt.avgReturn > 0 ? '+' : ''}{bt.avgReturn.toFixed(1)}%
                                </div>
                              ) : <div style={{ color: COLORS.textMuted, fontFamily: 'IBM Plex Mono, monospace' }}>signal chiqmagan</div>}
                            </div>
                          ))}
                        </div>
                        <div style={{ fontSize: 10.5, color: COLORS.textMuted, marginTop: 8, lineHeight: 1.5 }}>
                          Reversal va Pullback bu yerda faqat kunlik (arzon) qismi bo'yicha tekshiriladi, soatlik/4-soatlik tasdiqsiz — to'liq signaldan farq qiladi. Bu tarixiy statistika, kafolat emas — kelajakda xuddi shunday natija bo'lishini bildirmaydi.
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ marginTop: 32, paddingTop: 16, borderTop: `1px solid ${COLORS.hairline}`, fontSize: 11.5, color: COLORS.textMuted, lineHeight: 1.6 }}>
          Bu terminal signal va ball beradi, lekin hech qanday buyurtmani avtomatik yubormaydi — yakuniy sotib olish/sotish qarori har doim sizda qoladi. Ballar standart formula asosida hisoblanadi; strategiyangizga mos ravishda vaznlarni yuqorida sozlashingiz mumkin. Bu moliyaviy maslahat emas.
        </div>
      </div>

      {journalForm && (
        <div onClick={() => setJournalForm(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 20 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: COLORS.surface, border: `1px solid ${COLORS.hairline}`, borderRadius: 10, padding: 20, width: '100%', maxWidth: 380 }}>
            <div style={{ fontFamily: 'Space Grotesk, sans-serif', fontWeight: 700, fontSize: 16, marginBottom: 4 }}>{journalForm.symbol} — savdoni yozib qo'yish</div>
            <div style={{ fontSize: 11.5, color: COLORS.textMuted, marginBottom: 14 }}>Strategiya: {journalForm.strategy}</div>
            <div className="flex flex-col gap-2">
              <label style={{ fontSize: 11.5, color: COLORS.textMuted }}>Kirish narxi
                <input type="number" step="0.01" value={journalForm.entryPrice} onChange={e => setJournalForm(f => ({ ...f, entryPrice: parseFloat(e.target.value) || 0 }))}
                  style={{ width: '100%', background: COLORS.surfaceRaised, border: `1px solid ${COLORS.hairline}`, borderRadius: 6, padding: '6px 8px', color: COLORS.textPrimary, fontFamily: 'IBM Plex Mono, monospace', fontSize: 12.5, marginTop: 3 }} />
              </label>
              <label style={{ fontSize: 11.5, color: COLORS.textMuted }}>Take-profit
                <input type="number" step="0.01" value={journalForm.takeProfit} onChange={e => setJournalForm(f => ({ ...f, takeProfit: parseFloat(e.target.value) || 0 }))}
                  style={{ width: '100%', background: COLORS.surfaceRaised, border: `1px solid ${COLORS.hairline}`, borderRadius: 6, padding: '6px 8px', color: COLORS.textPrimary, fontFamily: 'IBM Plex Mono, monospace', fontSize: 12.5, marginTop: 3 }} />
              </label>
              <label style={{ fontSize: 11.5, color: COLORS.textMuted }}>Stop-loss
                <input type="number" step="0.01" value={journalForm.stopLoss} onChange={e => setJournalForm(f => ({ ...f, stopLoss: parseFloat(e.target.value) || 0 }))}
                  style={{ width: '100%', background: COLORS.surfaceRaised, border: `1px solid ${COLORS.hairline}`, borderRadius: 6, padding: '6px 8px', color: COLORS.textPrimary, fontFamily: 'IBM Plex Mono, monospace', fontSize: 12.5, marginTop: 3 }} />
              </label>
              <label style={{ fontSize: 11.5, color: COLORS.textMuted }}>Hajm (dona)
                <input type="number" value={journalForm.shares} onChange={e => setJournalForm(f => ({ ...f, shares: parseInt(e.target.value) || 0 }))}
                  style={{ width: '100%', background: COLORS.surfaceRaised, border: `1px solid ${COLORS.hairline}`, borderRadius: 6, padding: '6px 8px', color: COLORS.textPrimary, fontFamily: 'IBM Plex Mono, monospace', fontSize: 12.5, marginTop: 3 }} />
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button onClick={() => addJournalEntry(journalForm)}
                style={{ flex: 1, background: COLORS.brass, color: '#1A1405', border: 'none', borderRadius: 6, padding: '9px 0', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Saqlash</button>
              <button onClick={() => setJournalForm(null)}
                style={{ flex: 1, background: 'transparent', border: `1px solid ${COLORS.hairline}`, color: COLORS.textMuted, borderRadius: 6, padding: '9px 0', fontSize: 13, cursor: 'pointer' }}>Bekor qilish</button>
            </div>
            <div style={{ fontSize: 10.5, color: COLORS.textMuted, marginTop: 10 }}>Bu — faqat siz o'zingiz haqiqiy brokeringizda (IBKR, Webull va h.k.) bajargan savdoni yozib boruvchi jurnal. Hech qanday buyurtma avtomatik yuborilmaydi.</div>
          </div>
        </div>
      )}
    </div>
  );
}
