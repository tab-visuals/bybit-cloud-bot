// DOM Selectors
const tradeLogTable = document.getElementById("trade-log");
const balanceElement = document.getElementById("balance");
const cashBalanceElement = document.getElementById("cash-balance");
const pnlElement = document.getElementById("pnl");
const toggleBtn = document.getElementById("toggle-btn");
const statusPill = document.getElementById("status-pill");

let isRunning = true;

const assetColors = {
  BTC: "#10b981",
  ETH: "#6366f1",
  SOL: "#f59e0b",
  CORE: "#ec4899",
  MNT: "#14b8a6",
  XAUT: "#eab308"
};

// 1. Audio Engine
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playTone(freq, type, startTime, duration, gainLevel = 0.15) {
  try {
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
  } catch (e) {}
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

for (const coin in assetColors) {
  charts[coin] = createChart(`chart-${coin}`, coin, assetColors[coin]);
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

function getTimestamp() {
  return new Date().toTimeString().split(' ')[0];
}

let lastLogCount = 0;

// 3. Render Trades Table
function renderTradeLog(tradeLog) {
  if (!tradeLog || tradeLog.length === 0) return;
  
  if (tradeLog.length > lastLogCount && lastLogCount !== 0) {
    playSound(tradeLog[0].type);
  }
  lastLogCount = tradeLog.length;

  let rowsHtml = "";
  for (const trade of tradeLog) {
    const typeClass = trade.type === "BUY" ? "buy-tag" : "sell-tag";
    let pnlDisplay = "-";
    if (trade.pnl !== null && trade.pnl !== undefined) {
      const sign = trade.pnl >= 0 ? "+" : "";
      const pnlClass = trade.pnl >= 0 ? "buy-tag" : "sell-tag";
      pnlDisplay = `<span class="${pnlClass}">${sign}$${Number(trade.pnl).toFixed(2)}</span>`;
    }

    rowsHtml += `
      <tr>
        <td>${trade.time}</td>
        <td class="${typeClass}">${trade.type}</td>
        <td><strong>${trade.asset}</strong></td>
        <td>$${Number(trade.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
        <td>${Number(trade.quantity).toFixed(4)} ${trade.asset}</td>
        <td><strong>$${Number(trade.totalValue).toFixed(2)}</strong></td>
        <td>${pnlDisplay}</td>
        <td>${trade.note || ""}</td>
      </tr>
    `;
  }
  tradeLogTable.innerHTML = rowsHtml;
}

// 4. Update UI from Backend State
async function updateDashboard() {
  if (!isRunning) return;

  try {
    const res = await fetch("/state");
    const data = await res.json();
    const timestamp = getTimestamp();

    // Top metrics
    balanceElement.innerText = `$${Number(data.totalPortfolio).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    cashBalanceElement.innerText = `$${Number(data.cashBalance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const sign = data.pnl >= 0 ? "+" : "";
    pnlElement.innerText = `${sign}$${Number(data.pnl).toFixed(2)} (${sign}${Number(data.pnlPercent).toFixed(2)}%)`;
    pnlElement.className = data.pnl >= 0 ? "metric-value profit" : "metric-value sell-tag";

    // Assets Cards & Charts
    const assets = data.assets || {};
    for (const key in assets) {
      const asset = assets[key];
      // Map PAXG from Python to XAUT in HTML if needed
      const uiKey = key === "PAXG" ? "XAUT" : key;

      const priceElem = document.getElementById(`price-${uiKey}`);
      const holdElem = document.getElementById(`hold-${uiKey}`);

      if (priceElem && asset.price) {
        priceElem.innerText = `$${Number(asset.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
      }

      if (holdElem) {
        const totalQty = (asset.orders || []).reduce((sum, o) => sum + o.qty, 0);
        const orderCount = (asset.orders || []).length;
        holdElem.innerText = `Holding: ${totalQty.toFixed(asset.decimals || 2)} ${uiKey} (${orderCount}/3)`;
      }

      if (asset.price > 0) {
        updateSingleChart(uiKey, timestamp, asset.price);
      }
    }

    // Trade Table
    renderTradeLog(data.tradeLog);

  } catch (err) {
    console.error("Dashboard fetch error:", err);
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

// Run immediately, then poll every 4 seconds
updateDashboard();
setInterval(updateDashboard, 4000);
