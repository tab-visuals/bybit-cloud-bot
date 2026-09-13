// Configuration
const INITIAL_BALANCE = 5000.00;
const BYBIT_FEE_RATE = 0.001;              // 0.10% Spot fee per side (0.20% round trip)
const COOLDOWN_MS = 10 * 60 * 1000;        // 10-minute cooldown on BUY after exit
const ORDER_INTERVAL_MS = 60 * 1000;       // Minimum 60s delay between scaled entries
const MAX_ORDERS_PER_COIN = 3;             // Max 3 trades per coin

let cashBalance = localStorage.getItem("algotrader_cash") 
  ? parseFloat(localStorage.getItem("algotrader_cash")) 
  : INITIAL_BALANCE;

let isRunning = true;

const defaultAssets = {
  BTC:  { symbol: "BTCUSDT",  price: 0, lastPrice: null, history: [], orders: [], decimals: 4, color: "#10b981", lastExitTime: 0, lastBuyTime: 0 },
  ETH:  { symbol: "ETHUSDT",  price: 0, lastPrice: null, history: [], orders: [], decimals: 4, color: "#6366f1", lastExitTime: 0, lastBuyTime: 0 },
  SOL:  { symbol: "SOLUSDT",  price: 0, lastPrice: null, history: [], orders: [], decimals: 2, color: "#f59e0b", lastExitTime: 0, lastBuyTime: 0 },
  CORE: { symbol: "COREUSDT", price: 0, lastPrice: null, history: [], orders: [], decimals: 2, color: "#ec4899", lastExitTime: 0, lastBuyTime: 0 },
  MNT:  { symbol: "MNTUSDT",  price: 0, lastPrice: null, history: [], orders: [], decimals: 2, color: "#14b8a6", lastExitTime: 0, lastBuyTime: 0 },
  XAUT: { symbol: "XAUTUSDT", price: 0, lastPrice: null, history: [], orders: [], decimals: 4, color: "#eab308", lastExitTime: 0, lastBuyTime: 0 }
};

let assets = defaultAssets;
const savedAssets = localStorage.getItem("algotrader_assets");
if (savedAssets) {
  try {
    const parsed = JSON.parse(savedAssets);
    for (const key in defaultAssets) {
      if (parsed[key]) {
        assets[key] = {
          ...defaultAssets[key],
          ...parsed[key],
          orders: Array.isArray(parsed[key].orders) ? parsed[key].orders : []
        };
      }
    }
  } catch (e) {
    assets = defaultAssets;
  }
}

// DOM Selectors
const tradeLogTable = document.getElementById("trade-log");
const balanceElement = document.getElementById("balance");
const cashBalanceElement = document.getElementById("cash-balance");
const pnlElement = document.getElementById("pnl");
const toggleBtn = document.getElementById("toggle-btn");
const statusPill = document.getElementById("status-pill");

const savedLogs = localStorage.getItem("algotrader_logs");
if (savedLogs) {
  tradeLogTable.innerHTML = savedLogs;
}

function saveStateToStorage() {
  localStorage.setItem("algotrader_cash", cashBalance.toString());
  localStorage.setItem("algotrader_assets", JSON.stringify(assets));
  localStorage.setItem("algotrader_logs", tradeLogTable.innerHTML);
}

// 1. Audio Engine
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playTone(freq, type, startTime, duration, gainLevel = 0.15) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, startTime);

  gain.gain.setValueAtTime(gainLevel, startTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playSound(type) {
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const now = audioCtx.currentTime;

  if (type === "BUY") {
    playTone(523.25, "sine", now, 0.12, 0.18);
    playTone(783.99, "sine", now + 0.08, 0.18, 0.16);
  } else if (type === "SELL") {
    playTone(523.25, "triangle", now, 0.10, 0.15);
    playTone(659.25, "triangle", now + 0.07, 0.10, 0.15);
    playTone(783.99, "sine", now + 0.14, 0.25, 0.20);
  } else {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.exponentialRampToValueAtTime(140, now + 0.25);
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.25);
  }
}

// 2. Charts Factory
const charts = {};

function createChart(canvasId, coin, color) {
  const elem = document.getElementById(canvasId);
  if (!elem) return null;
  const ctx = elem.getContext('2d');
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: `${coin} Price`,
        data: [],
        borderColor: color,
        backgroundColor: 'rgba(255, 255, 255, 0.02)',
        fill: true,
        tension: 0.25,
        borderWidth: 2,
        pointRadius: 1
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { display: false },
        y: { 
          grid: { color: '#1e2430' }, 
          ticks: { color: '#8b949e', font: { size: 9 } } 
        }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });
}

for (const coin in assets) {
  charts[coin] = createChart(`chart-${coin}`, coin, assets[coin].color);
}

function updateSingleChart(coin, timestamp, price) {
  const targetChart = charts[coin];
  if (!targetChart) return;

  targetChart.data.labels.push(timestamp);
  targetChart.data.datasets[0].data.push(price);

  if (targetChart.data.labels.length > 20) {
    targetChart.data.labels.shift();
    targetChart.data.datasets[0].data.shift();
  }
  targetChart.update();
}

// 3. Execution Helpers
function getTimestamp() {
  return new Date().toTimeString().split(' ')[0];
}

function calculateSMA(history, period = 5) {
  if (history.length < period) return null;
  const slice = history.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calculateConfidenceSize() {
  const minTrade = 200;
  const maxTrade = 600;
  const randomSize = Math.floor(Math.random() * (maxTrade - minTrade + 1)) + minTrade;
  return Math.min(cashBalance, randomSize);
}

function recordTrade(type, coin, price, amount, totalSpentOrReceived, pnlVal = null, note = "") {
  const row = document.createElement("tr");
  const typeClass = type === "BUY" ? "buy-tag" : "sell-tag";

  let pnlDisplay = "-";
  if (pnlVal !== null) {
    const sign = pnlVal >= 0 ? "+" : "";
    const pnlClass = pnlVal >= 0 ? "buy-tag" : "sell-tag";
    pnlDisplay = `<span class="${pnlClass}">${sign}$${pnlVal.toFixed(2)}</span>`;
  }

  row.innerHTML = `
    <td>${getTimestamp()}</td>
    <td class="${typeClass}">${type}</td>
    <td><strong>${coin}</strong></td>
    <td>$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
    <td>${amount.toFixed(assets[coin].decimals)} ${coin}</td>
    <td><strong>$${totalSpentOrReceived.toFixed(2)}</strong></td>
    <td>${pnlDisplay}</td>
    <td>${note}</td>
  `;

  tradeLogTable.prepend(row);
  playSound(type);
  saveStateToStorage();
}

function updatePortfolioMetrics() {
  let holdingsValue = 0;
  for (const key in assets) {
    const totalQty = assets[key].orders.reduce((sum, ord) => sum + ord.qty, 0);
    holdingsValue += (totalQty * assets[key].price);
  }

  const totalPortfolio = cashBalance + holdingsValue;
  const totalPnL = totalPortfolio - INITIAL_BALANCE;
  const pnlPercent = ((totalPnL / INITIAL_BALANCE) * 100).toFixed(2);

  balanceElement.innerText = `$${totalPortfolio.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  cashBalanceElement.innerText = `$${cashBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const sign = totalPnL >= 0 ? "+" : "";
  pnlElement.innerText = `${sign}$${totalPnL.toFixed(2)} (${sign}${pnlPercent}%)`;
  pnlElement.className = totalPnL >= 0 ? "metric-value profit" : "metric-value sell-tag";
}

// 4. Execution Loop
async function runBotTick() {
  if (!isRunning) return;

  try {
    const response = await fetch("/state");
    const json = await response.json();
    const tickerList = json.result.list;
    const timestamp = getTimestamp();
    const now = Date.now();

    for (const coin in assets) {
      const asset = assets[coin];
      const tickerData = tickerList.find(item => item.symbol === asset.symbol);
      
      if (!tickerData) continue;

      const currentPrice = parseFloat(tickerData.lastPrice);
      asset.price = currentPrice;
      asset.history.push(currentPrice);
      if (asset.history.length > 30) asset.history.shift();

      const totalHeld = asset.orders.reduce((sum, ord) => sum + ord.qty, 0);
      const activeCount = asset.orders.length;

      // Cooldown Status Calculation
      const timeSinceExit = now - (asset.lastExitTime || 0);
      const isCoolingDown = timeSinceExit < COOLDOWN_MS;
      const cooldownRemaining = isCoolingDown ? Math.ceil((COOLDOWN_MS - timeSinceExit) / 60000) : 0;

      const priceElem = document.getElementById(`price-${coin}`);
      const holdElem = document.getElementById(`hold-${coin}`);
      if (priceElem) priceElem.innerText = `$${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
      if (holdElem) {
        if (isCoolingDown && activeCount === 0) {
          holdElem.innerText = `Cooldown: ${cooldownRemaining}m left`;
        } else {
          holdElem.innerText = `Holding: ${totalHeld.toFixed(asset.decimals)} ${coin} (${activeCount}/${MAX_ORDERS_PER_COIN})`;
        }
      }

      updateSingleChart(coin, timestamp, currentPrice);

      if (asset.lastPrice === null) {
        asset.lastPrice = currentPrice;
        continue;
      }

      const sma = calculateSMA(asset.history, 5);
      const takeProfitThreshold = 0.0065; // +0.65%
      const stopLossThreshold   = 0.0035; // -0.35%

      // 1. EVALUATE EXITS (Only TP or SL triggers; no time-based forced liquidations)
      if (activeCount > 0) {
        for (let i = asset.orders.length - 1; i >= 0; i--) {
          const ord = asset.orders[i];
          const pnlRate = (currentPrice - ord.entryPrice) / ord.entryPrice;
          const grossSaleValue = ord.qty * currentPrice;
          const exitFee = grossSaleValue * BYBIT_FEE_RATE;
          const netSaleValue = grossSaleValue - exitFee;
          const netDollarPnL = netSaleValue - ord.cost;

          let shouldExit = false;
          let exitReason = "";

          if (pnlRate >= takeProfitThreshold) {
            shouldExit = true;
            exitReason = "Target Profit";
          } else if (pnlRate <= -stopLossThreshold) {
            shouldExit = true;
            exitReason = "Stop Loss";
          }

          if (shouldExit) {
            cashBalance += netSaleValue;
            asset.orders.splice(i, 1);
            asset.lastExitTime = Date.now(); // 10-minute cooldown on new BUYs

            recordTrade(pnlRate >= takeProfitThreshold ? "SELL" : "STOP", coin, currentPrice, ord.qty, netSaleValue, netDollarPnL, `${exitReason} [10m Cool]`);
          }
        }
      }

      // 2. EVALUATE BUYS (Under 3 orders, outside cooldown, spaced out, dip confirmed)
      const hasOrderSpacing = (now - (asset.lastBuyTime || 0)) >= ORDER_INTERVAL_MS;

      let isDippingFurther = true;
      if (asset.orders.length > 0) {
        const lastEntry = asset.orders[asset.orders.length - 1].entryPrice;
        isDippingFurther = currentPrice < (lastEntry * 0.998); // At least 0.2% lower than prior entry
      }

      if (
        asset.orders.length < MAX_ORDERS_PER_COIN &&
        !isCoolingDown &&
        hasOrderSpacing &&
        isDippingFurther &&
        sma !== null &&
        currentPrice < sma &&
        cashBalance >= 200
      ) {
        const tradeAmount = calculateConfidenceSize();

        if (tradeAmount >= 200) {
          const entryFee = tradeAmount * BYBIT_FEE_RATE;
          const effectiveCapital = tradeAmount - entryFee;
          const qty = effectiveCapital / currentPrice;

          cashBalance -= tradeAmount;
          asset.lastBuyTime = now;
          asset.orders.push({
            id: Date.now(),
            entryPrice: currentPrice,
            qty: qty,
            cost: tradeAmount
          });

          recordTrade("BUY", coin, currentPrice, qty, tradeAmount, null, `Order #${asset.orders.length} (Fee: $${entryFee.toFixed(2)})`);
        }
      }

      asset.lastPrice = currentPrice;
    }

    updatePortfolioMetrics();

  } catch (error) {
    console.error("Bybit tick cycle error:", error);
  }
}

// Bot Control Toggle
toggleBtn.addEventListener("click", () => {
  isRunning = !isRunning;
  if (isRunning) {
    toggleBtn.innerText = "Pause Bot";
    toggleBtn.className = "btn btn-pause";
    statusPill.innerText = "Bot: Running";
    statusPill.className = "status-badge active";
  } else {
    toggleBtn.innerText = "Resume Bot";
    toggleBtn.className = "btn btn-start";
    statusPill.innerText = "Bot: Paused";
    statusPill.className = "status-badge paused";
  }
});

runBotTick();
setInterval(runBotTick, 3500);