// ✅ Full auto-backtest system: fetch from Binance, scan, and export

const fs = require("fs");
const axios = require("axios");
// Support/Resistance functions
function findNearestSupport(candles, currentPrice) {
  if (!candles || !Array.isArray(candles)) return null;
  const supports = candles
    .filter((c) => c.low < currentPrice)
    .sort(
      (a, b) => Math.abs(currentPrice - a.low) - Math.abs(currentPrice - b.low),
    );
  return supports[0]?.low || null;
}

function findNearestResistance(candles, currentPrice) {
  if (!candles || !Array.isArray(candles)) return null;
  const resistances = candles
    .filter((c) => c.high > currentPrice)
    .sort(
      (a, b) =>
        Math.abs(currentPrice - a.high) - Math.abs(currentPrice - b.high),
    );
  return resistances[0]?.high || null;
}

// EMA calculation
function calculateEMA(candles, period) {
  const k = 2 / (period + 1);
  let ema =
    candles.slice(0, period).reduce((acc, candle) => acc + candle.close, 0) /
    period;
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
  }
  return ema;
}

//RSI calculation
function calculateRSI(candles, period = 14) {
  let gains = 0,
    losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Trend determination with EMA34 and EMA89
function determineTrend(candles) {
  if (candles.length < 89) return "bearish"; // Default to bearish if not enough data

  // Sử dụng 34 và 89 nến cuối cùng để tính EMA34 và EMA89
  const ema34 = calculateEMA(candles.slice(-34), 34);
  const ema89 = calculateEMA(candles.slice(-89), 89);

  // Chỉ xác định bullish hoặc bearish, không có neutral
  return ema34 >= ema89 ? "bullish" : "bearish";
}

// Improved SL & TP calculation using dynamic Fibonacci retracement
function determineSLTP(entry, atr, orderBlock, candles, type) {
  const fibLevels = [0.236, 0.382, 0.618]; // Fibonacci retracement levels
  const lastHigh = Math.max(...candles.map((c) => c.high));
  const lastLow = Math.min(...candles.map((c) => c.low));

  // Dùng Fibonacci để xác định mức TP và SL
  const retracementLevel =
    type === "bullish"
      ? lastHigh - (lastHigh - lastLow) * fibLevels[2] // Take profit cho giao dịch bullish
      : lastLow + (lastHigh - lastLow) * fibLevels[2]; // Take profit cho giao dịch bearish

  // Dựa trên Fibonacci retracement để xác định TP
  const takeProfit =
    type === "bullish"
      ? entry + (retracementLevel - entry)
      : entry - (entry - retracementLevel);

  // Tính Stop Loss (SL) bằng cách sử dụng ATR để tính mức độ rủi ro
  const stopLoss =
    type === "bullish"
      ? Math.max(orderBlock.low - atr * 0.5, entry - atr * 1.5) // SL động cho giao dịch bullish
      : Math.min(orderBlock.high + atr * 0.5, entry + atr * 1.5); // SL động cho giao dịch bearish

  return { stopLoss, takeProfit };
}

// Tính toán sức mạnh của nến (candle strength)
function calculateCandleStrength(candle, avgVolume) {
  const body = Math.abs(candle.close - candle.open) / candle.open; // Tính kích thước thân nến
  const volumeRatio = candle.volume / avgVolume; // So sánh volume của nến với volume trung bình
  const wick = Math.abs(candle.high - candle.low) / candle.open; // Tính kích thước bấc (wick)

  // Tính sức mạnh của nến dựa trên các yếu tố trên
  const strength = Math.min(
    Math.max(
      body * 0.5 + Math.min(volumeRatio, 1) * 0.3 + Math.min(wick, 0.5) * 0.2, // Trọng số cho các yếu tố
      0,
    ),
    1, // Đảm bảo sức mạnh nằm trong khoảng từ 0 đến 1
  );

  return strength;
}

// Tính toán ATR (Average True Range) để xác định mức độ biến động
function calculateATR(candles, period = 14) {
  const trs = []; // Mảng để lưu các giá trị True Range
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]; // Nến hiện tại
    const p = candles[i - 1]; // Nến trước đó

    // Tính True Range (TR) cho mỗi nến
    const tr = Math.max(
      c.high - c.low, // Khoảng cách giữa giá cao nhất và thấp nhất của nến hiện tại
      Math.abs(c.high - p.close), // Khoảng cách giữa giá cao nhất và giá đóng cửa của nến trước
      Math.abs(c.low - p.close), // Khoảng cách giữa giá thấp nhất và giá đóng cửa của nến trước
    );

    trs.push(tr); // Thêm giá trị TR vào mảng
  }

  // Tính ATR là trung bình của các True Range trong một khoảng period
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period; // Tính ATR bằng trung bình cộng các TR
}
// Đánh giá sức khỏe tín hiệu dựa trên điểm số
function getHealthGrade(score) {
  if (score >= 90) return "A+";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  return "F";
}

// Tính toán sức khỏe tín hiệu
function calculateSignalHealth(candles, current, params) {
  try {
    const weights = {
      trend: 0.15,
      volume: 0.15,
      pattern: 0.2,
      risk: 0.2,
      momentum: 0.3,
    };

    const components = {
      trend: calculateTrendStrength(candles), // Sức mạnh xu hướng
      volume: calculateVolumeScore(candles, current, params.levels?.avgVolume), // Điểm volume
      pattern: params.pattern.strength, // Điểm mạnh mô hình nến
      risk: calculateRiskScore(params.riskRewardRatio), // Điểm rủi ro từ Risk-Reward Ratio
      momentum: calculateMomentumScore(candles, params.type), // Điểm động lượng
      bonus: 0, // Điểm thưởng cho tín hiệu mạnh mẽ
    };

    // Cộng tổng điểm cho các thành phần theo trọng số
    let baseScore = 0;
    for (let key of ["trend", "volume", "pattern", "risk", "momentum"]) {
      baseScore += components[key] * weights[key];
    }

    // Tăng điểm thưởng nếu đạt được tỷ lệ Risk-Reward hợp lý và động lượng mạnh
    if (params.riskRewardRatio >= 2) components.bonus += 0.05;
    if (components.momentum >= 0.5) components.bonus += 0.05;

    // Tổng điểm cuối cùng, đảm bảo không vượt quá 100
    const totalScore = Math.min(baseScore + components.bonus, 1);
    const finalScore = Math.round(totalScore * 100);

    return {
      score: finalScore,
      grade: getHealthGrade(finalScore),
      components,
    };
  } catch (error) {
    // Nếu có lỗi trong quá trình tính toán, trả về điểm F
    return { score: 0, grade: "F", components: {} };
  }
}

// Tính toán sức mạnh xu hướng từ dữ liệu nến
function calculateTrendStrength(candles) {
  const period = 20;
  const prices = candles.slice(0, period).map((c) => c.close);
  let upCount = 0;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > prices[i - 1]) upCount++; // Đếm số lần tăng giá
  }

  const trendStrength = upCount / (period - 1); // Tính tỷ lệ tăng giá

  return trendStrength;
}

// Tính toán điểm số volume so với khối lượng trung bình
function calculateVolumeScore(candles, current, avgVolume) {
  if (!avgVolume) return 0.5; // Nếu không có volume trung bình, trả về giá trị mặc định

  const volumeRatio = current.volume / avgVolume;
  const volumeScore = Math.min(volumeRatio, 2) / 2;

  // Kiểm tra tính đồng nhất của volume trong những nến gần đây
  const recentCandles = candles.slice(0, 5);
  const consistent = recentCandles.every((c) => c.volume > avgVolume * 0.7);
  return consistent ? volumeScore * 1.2 : volumeScore * 0.8;
}

// Tính toán điểm động lượng của thị trường
function calculateMomentumScore(candles, signalType) {
  const recent = candles.slice(0, 3);
  let momentum = 0;

  for (let i = 0; i < recent.length - 1; i++) {
    const change =
      (recent[i].close - recent[i + 1].close) / recent[i + 1].close;
    momentum += change; // Tính sự thay đổi giữa các nến
  }

  const normalized = Math.min(Math.abs(momentum), 1);

  // Nếu xu hướng và động lượng đồng nhất, giữ nguyên momentum
  if (
    (signalType === "bullish" && momentum > 0) ||
    (signalType === "bearish" && momentum < 0)
  ) {
    return normalized;
  }

  return normalized * 0.5; // Giảm điểm momentum nếu xu hướng trái ngược
}

// Tính toán rủi ro từ tỷ lệ Risk-Reward
function calculateRiskScore(riskRewardRatio) {
  if (riskRewardRatio >= 2.5 && riskRewardRatio <= 4) return 1; // Tỷ lệ hợp lý
  if (riskRewardRatio >= 2 && riskRewardRatio < 2.5) return 0.8; // Tỷ lệ thấp
  if (riskRewardRatio > 4 && riskRewardRatio <= 5) return 0.7; // Tỷ lệ quá cao
  return 0.5; // Tỷ lệ không hợp lý
}

// Tìm kiếm Order Block gần nhất từ dữ liệu nến
function findNearestOrderBlock(candles, current) {
  if (!candles || candles.length < 2) return null;

  let nearestOB = null;
  let minDist = Infinity;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];

    // Điều kiện tìm Order Block Bullish
    const isBullish = c.close > c.open && current.low >= c.low * 0.98; // Nến Bullish với điều kiện giá thấp hơn không quá 2%

    // Điều kiện tìm Order Block Bearish
    const isBearish = c.close < c.open && current.high <= c.high * 1.02; // Nến Bearish với điều kiện giá cao hơn không quá 2%

    if (isBullish || isBearish) {
      // Tính khoảng cách giữa giá đóng cửa hiện tại và giá đóng cửa của nến trong quá khứ
      const dist = Math.abs(current.close - c.close);

      // Kiểm tra nếu khoảng cách nhỏ hơn khoảng cách tối thiểu hiện tại
      if (dist < minDist) {
        minDist = dist;
        nearestOB = c; // Cập nhật nến gần nhất là Order Block
      }
    }
  }

  // Trả về Order Block gần nhất
  return nearestOB;
}
// Analyze Order Blocks with enhanced filtering
function analyzeOrderBlocks(data, levels) {
  const candles = data.candles;
  if (!candles || candles.length < 20 || !levels?.avgVolume) return [];
  const current = candles[0];
  const realtimePrice = data.realtimePrice || current.close;

  // Tính điểm momentum và xu hướng từ EMA34 và EMA89
  const momentumScore = calculateMomentumScore(candles, "bullish");
  const trend = determineTrend(candles); // Xác định xu hướng với EMA34, EMA89

  // Tìm nearest order block (nếu có)
  const orderBlock = findNearestOrderBlock(candles, current);
  if (!orderBlock) return [];

  // Xác định loại và sức mạnh của mô hình nến
  const patternType = trend;
  const patternStrength = calculateCandleStrength(current, levels.avgVolume);
  const pattern = { type: patternType, strength: patternStrength };

  // Loại bỏ tín hiệu yếu
  if (pattern.strength < 0.3) return [];

  // Tính ATR và các mức SL, TP
  const atr = calculateATR(candles);
  let entry =
    pattern.type === "bullish"
      ? Math.min(orderBlock.high, realtimePrice)
      : Math.max(orderBlock.low, realtimePrice);

  // Kiểm tra độ xa của entry so với realtimePrice
  const entryDistance = Math.abs(entry - realtimePrice) / realtimePrice;
  if (entryDistance > 0.05) return []; // Loại bỏ nếu entry quá xa

  // Kiểm tra RSI để lọc các tín hiệu không hợp lệ
  const rsi = calculateRSI(candles, 7);
  if (pattern.type === "bullish" && rsi < 55) return [];
  if (pattern.type === "bearish" && rsi > 45) return [];

  // Xác định Entry, SL, TP dựa trên loại tín hiệu
  // let entry, stopLoss, takeProfit;

  if (pattern.type === "bearish") {
    // Short position
    entry = Math.min(orderBlock.high, realtimePrice);
    stopLoss = entry + atr * 1.5; // SL above entry
    takeProfit = entry - atr * 3; // TP below entry
  } else {
    // Bullish - Long position
    entry = Math.max(orderBlock.low, realtimePrice);
    stopLoss = entry - atr * 1.5; // SL below entry
    takeProfit = entry + atr * 3; // TP above entry
  }

  // Validate TP/SL distances
  const tpDistance = Math.abs(takeProfit - entry) / entry;
  const slDistance = Math.abs(stopLoss - entry) / entry;
  if (tpDistance < 0.01 || tpDistance > 0.1) return []; // TP distance check
  if (slDistance < 0.005 || slDistance > 0.05) return []; // SL distance check

  // Tính Risk/Reward Ratio và lọc tín hiệu nếu không hợp lý
  const riskRewardRatio = tpDistance / slDistance;
  if (riskRewardRatio < 1.2 || riskRewardRatio > 3.5) return []; // Kiểm tra R:R hợp lý

  // Tính toán sức khỏe tín hiệu
  const healthScore = calculateSignalHealth(candles, current, {
    type: pattern.type,
    pattern,
    levels,
    entry,
    realtimePrice,
    riskRewardRatio,
  });

  return [
    {
      type: pattern.type,
      strength: pattern.strength,
      entry,
      stopLoss,
      takeProfit,
      currentPrice: realtimePrice,
      healthScore,
    },
  ];
}
// Get backtest data from Binance API
async function getBacktestData(
  symbol = "BTC-USDT",
  interval = "4h",
  limit = 1000,
) {
  try {
    const binanceSymbol = symbol.replace("-", "");
    const response = await axios.get("https://api.binance.com/api/v3/klines", {
      params: { symbol: binanceSymbol, interval, limit },
    });

    if (!response.data || response.data.length === 0) {
      throw new Error("No data received");
    }

    const candles = response.data.map((d) => ({
      timestamp: d[0],
      open: +d[1],
      high: +d[2],
      low: +d[3],
      close: +d[4],
      volume: +d[5],
    }));

    console.log(`✅ Fetched ${candles.length} candles for ${symbol}`);
    return candles;
  } catch (err) {
    console.error(`❌ Error fetching ${symbol}:`, err.message);
    return [];
  }
}

// Tính toán khối lượng trung bình từ dãy nến
function calcAvgVolume(candles) {
  return candles.reduce((sum, c) => sum + c.volume, 0) / candles.length;
}

// Quét các tín hiệu giao dịch từ dữ liệu lịch sử
function scanHistoricalSignals(candles, levels, windowSize = 50) {
  const signals = [];
  if (!Array.isArray(candles) || candles.length < windowSize + 20)
    return signals;

  for (let i = candles.length - windowSize - 1; i >= 20; i--) {
    const window = candles.slice(i, i + windowSize);
    const realtimePrice = window[0].close;

    try {
      // Gọi hàm phân tích Order Blocks
      const result = analyzeOrderBlocks(
        { candles: window, realtimePrice },
        levels,
      );

      // Nếu có tín hiệu, thêm vào danh sách tín hiệu
      if (result.length > 0) {
        signals.push({
          index: i,
          timestamp: window[0].timestamp || null,
          ...result[0],
        });
      }
    } catch (err) {
      console.error(`❌ scan error at index ${i}:`, err.message);
      // Có thể thêm thông tin chi tiết để dễ dàng debug lỗi tín hiệu cụ thể
      signals.push({
        error: `Error at index ${i}: ${err.message}`,
        candles: window,
      });
    }
  }

  return signals;
}

async function runBacktest(symbol = "BTC-USDT", interval = "4h") {
  try {
    const candles = await getBacktestData(symbol, interval, 1000);
    if (!candles || candles.length < 20) {
      console.error(`❌ No sufficient data for ${symbol}`);
      return;
    }

    const levels = { avgVolume: calcAvgVolume(candles) };
    const signals = scanHistoricalSignals(candles, levels, 50);

    if (signals.length === 0) {
      console.log(`❌ No valid signals found for ${symbol}`);
      return;
    }

    const pnlSignals = appendPNLToSignals(signals, candles);
    pnlSignals.forEach((s) => {
      s.symbol = symbol;
      s.timestamp = new Date(s.timestamp).toISOString();
    });

    const fileBase = symbol.replace("-", "") + "_" + interval;
    exportSignalsToCSV(pnlSignals, `${fileBase}_signals.csv`);
    console.log(`✅ Backtest completed for ${symbol}`);
  } catch (error) {
    console.error(`❌ Error in backtest for ${symbol}:`, error.message);
  }
}

// Hàm backtest cho nhiều cặp tiền tệ
async function runBatchBacktest(
  symbols = ["BTC-USDT", "ETH-USDT", "SOL-USDT"],
  interval = "4h",
) {
  try {
    for (let symbol of symbols) {
      await runBacktest(symbol, interval);
    }
  } catch (error) {
    console.error("❌ Error during batch backtest:", error.message);
  }
}
// Đánh giá kết quả của tín hiệu (win, loss, open) dựa trên SL và TP
function evaluateSignalOutcome(signal, futureCandles) {
  const { entry, stopLoss: sl, takeProfit: tp, type } = signal;
  const isLong = type === "bullish";

  for (const candle of futureCandles) {
    // Nếu giao dịch là Bullish (Long)
    if (isLong) {
      // Kiểm tra nếu giá chạm Stop Loss
      if (candle.low <= sl) return "loss";
      // Kiểm tra nếu giá chạm Take Profit
      if (candle.high >= tp) return "win";
    }
    // Nếu giao dịch là Bearish (Short)
    else {
      // Kiểm tra nếu giá chạm Stop Loss
      if (candle.high >= sl) return "loss";
      // Kiểm tra nếu giá chạm Take Profit
      if (candle.low <= tp) return "win";
    }
  }

  return "open"; // Nếu không chạm SL hoặc TP, giao dịch vẫn mở
}

// Tính toán PNL cho các tín hiệu và thêm thông tin về thời gian giao dịch
function appendPNLToSignals(signals, candles) {
  return signals.map((sig) => {
    const index = sig.index || 0; // Lấy chỉ mục của tín hiệu trong dữ liệu
    const future = candles.slice(index + 1, index + 20); // Xác định các nến tương lai để tính toán kết quả
    const outcome = evaluateSignalOutcome(sig, future); // Tính kết quả giao dịch
    const duration = calculateTradeDuration(
      candles[index].timestamp, // Thời gian mở giao dịch
      future, // Nến tương lai để kiểm tra thời gian
      sig, // Tín hiệu
    );

    return { ...sig, outcome, tradeDurationHours: duration }; // Trả về tín hiệu với kết quả và thời gian giao dịch
  });
}

// Tính toán thời gian giao dịch từ Entry đến khi chạm TP hoặc SL
function calculateTradeDuration(entryTimestamp, futureCandles, signal) {
  const isLong = signal.type === "bullish";

  for (let candle of futureCandles) {
    // Nếu giao dịch là Long (Bullish)
    if (isLong) {
      // Kiểm tra nếu giá chạm Stop Loss hoặc Take Profit
      if (candle.low <= signal.stopLoss)
        return (candle.timestamp - entryTimestamp) / (1000 * 60 * 60); // Đổi sang giờ
      if (candle.high >= signal.takeProfit)
        return (candle.timestamp - entryTimestamp) / (1000 * 60 * 60); // Đổi sang giờ
    }
    // Nếu giao dịch là Short (Bearish)
    else {
      // Kiểm tra nếu giá chạm Stop Loss hoặc Take Profit
      if (candle.high >= signal.stopLoss)
        return (candle.timestamp - entryTimestamp) / (1000 * 60 * 60); // Đổi sang giờ
      if (candle.low <= signal.takeProfit)
        return (candle.timestamp - entryTimestamp) / (1000 * 60 * 60); // Đổi sang giờ
    }
  }

  return null; // Nếu không chạm TP hoặc SL, trả về null
}

function exportSignalsToCSV(signals, filePath = "signals.csv") {
  if (!Array.isArray(signals) || signals.length === 0) {
    console.log("❌ No signals to export");
    return;
  }

  // Calculate winrate statistics
  const stats = {
    total: signals.length,
    wins: signals.filter((s) => s.outcome === "win").length,
    losses: signals.filter((s) => s.outcome === "loss").length,
    opens: signals.filter((s) => s.outcome === "open").length,
  };

  stats.winRate =
    stats.total > 0 ? ((stats.wins / stats.total) * 100).toFixed(2) : "0.00";

  const headers = [
    "symbol",
    "timestamp",
    "type",
    "entry",
    "stopLoss",
    "takeProfit",
    "currentPrice",
    "score",
    "grade",
    "outcome",
    "tradeDurationHours",
    "riskRewardRatio",
    "winRate",
    "totalTrades",
    "totalWins",
    "totalLosses",
  ];

  try {
    const lines = [headers.join(",")];
    for (const s of signals) {
      if (!s) continue;
      lines.push(
        [
          s.symbol || "",
          new Date(s.timestamp).toISOString(),
          s.type || "",
          s.entry?.toFixed(8) || "",
          s.stopLoss?.toFixed(8) || "",
          s.takeProfit?.toFixed(8) || "",
          s.currentPrice?.toFixed(8) || "",
          s.healthScore?.score || "",
          s.healthScore?.grade || "",
          s.outcome || "",
          s.tradeDurationHours !== null ? s.tradeDurationHours.toFixed(2) : "",
          (
            Math.abs(s.takeProfit - s.entry) / Math.abs(s.stopLoss - s.entry)
          ).toFixed(2) || "",
          stats.winRate,
          stats.total,
          stats.wins,
          stats.losses,
        ].join(","),
      );
    }
    fs.writeFileSync(filePath, lines.join("\n"));
    console.log(
      `✅ Exported ${signals.length} signals to ${filePath} (Winrate: ${stats.winRate}%)`,
    );
  } catch (error) {
    console.error(`❌ Error exporting to CSV: ${error.message}`);
  }
}

function summarizeResults(signals) {
  const outcomeCount = { win: 0, loss: 0, open: 0, unknown: 0 };
  const gradeCount = {};
  let totalR = 0,
    totalWin = 0,
    totalLoss = 0;

  for (const s of signals) {
    const grade = s.healthScore?.grade || "F";
    const outcome = s.outcome || "unknown";

    gradeCount[grade] = (gradeCount[grade] || 0) + 1;
    outcomeCount[outcome]++;

    if (outcome === "win") {
      const rr = Math.abs((s.takeProfit - s.entry) / (s.entry - s.stopLoss));
      totalR += rr;
      totalWin++;
    } else if (outcome === "loss") {
      totalR -= 1;
      totalLoss++;
    }
  }

  const total = signals.length;
  const winrate = total > 0 ? ((totalWin / total) * 100).toFixed(1) : "0.0";
  const avgR =
    totalWin + totalLoss > 0
      ? (totalR / (totalWin + totalLoss)).toFixed(2)
      : "0.00";

  console.log("\n📊 Backtest Summary:");
  console.log("--------------------");
  console.log(`Total signals: ${total}`);
  console.log(
    `✅ Wins: ${totalWin} | ❌ Losses: ${totalLoss} | 📭 Open: ${outcomeCount.open}`,
  );
  console.log(`🏆 Winrate: ${winrate}% | 📈 Avg R: ${avgR}`);

  console.log("\n🎓 Grade distribution:");
  Object.entries(gradeCount)
    .sort()
    .forEach(([grade, count]) => {
      const percent = ((count / total) * 100).toFixed(1);
      console.log(`  ${grade}: ${count} (${percent}%)`);
    });
}

async function main() {
  try {
    console.log("🚀 Starting backtest...");

    const pairs = [
      "BTC-USDT",
      "ETH-USDT",
      "BNB-USDT",
      "ALT-USDT",
      "APT-USDT",
      "SOL-USDT",
      "DOT-USDT",
      "LINK-USDT",
      "HBAR-USDT",
      "NEAR-USDT",
    ];
    console.log(`📊 Testing pairs: ${pairs.join(", ")}`);

    for (const pair of pairs) {
      await runBacktest(pair, "4h");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    console.log("✅ Backtest completed!");
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  runBacktest,
  runBatchBacktest,
};
