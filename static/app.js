// Asset visual theme configuration
const ASSET_CONFIG = {
  BTC: { name: "Bitcoin", color: "#10b981", decimals: 2 },
  ETH: { name: "Ethereum", color: "#6366f1", decimals: 2 },
  SOL: { name: "Solana", color: "#f59e0b", decimals: 2 },
  CORE: { name: "Core DAO", color: "#ec4899", decimals: 4 },
  MNT: { name: "Mantle", color: "#06b6d4", decimals: 4 },
  XAUT: { name: "Tether Gold", color: "#eab308", decimals: 2 }
};

const BYBIT_PUBLIC_URL = "https://api.bybit.com/v5/market/tickers?category=spot";

const PAIR_MAP = {
  "BTCUSDT": "BTC",
  "ETHUSDT": "ETH",
  "SOLUSDT": "SOL",
  "COREUSDT": "CORE",
  "MNTUSDT": "MNT",
  "XAUTUSDT": "XAUT"
};

let charts = {};
let isRunning = true;

// Initialize Chart.js instances with custom neon borders
function initCharts() {
  Object.keys(ASSET_CONFIG).forEach(coin => {
    const canvas = document.getElementById(`chart-${coin.toLowerCase()}`);
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    const color = ASSET_CONFIG[coin].color;

    charts[coin] = new Chart(ctx, {
      type: "line",
      data: {
        labels: Array(30).fill(""),
        datasets: [{
          data: [],
          borderColor: color,
          backgroundColor: color.replace(")", ", 0.08)").replace("rgb", "rgba").replace("#", "rgba(") + (color.startsWith("#") ? "14" : ""),
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 3,
          tension: 0.25,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true, mode: "index", intersect: false }
        },
        scales: {
          x: { display: false },
          y: {
            display: true,
            grid: { color: "rgba(255, 255, 255, 0.05)", drawBorder: false },
            ticks: {
              color: "#94a3b8",
              font: { size: 10 },
              maxTicksLimit: 5
            }
          }
        }
      }
    });
  });
}

// Update chart lines dynamically
function updateChartData(coin, history) {
  if (!charts[coin] || !history || history.length === 0) return;
  charts[coin].data.labels = history.map(() => "");
  charts[coin].data.datasets[0].data = history;
  charts[coin].update();
}

// Render recent trade executions with neon badges
function renderTradeLog(tradeLog) {
  const tbody = document.getElementById("trade-log");
  if (!tbody || !tradeLog) return;

  if (tradeLog.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: #64748b; padding: 20px;">Awaiting trade triggers...</td></tr>`;
    return;
  }

  let rowsHtml = "";
  tradeLog.forEach(trade => {
    const isBuy = trade.type === "BUY";
    const badgeClass = isBuy ? "buy-tag" : "sell-tag";

    let pnlHtml = "-";
    if (trade.pnl !== null && trade.pnl !== undefined) {
      const isProfit = Number(trade.pnl) >= 0;
      const sign = isProfit ? "+" : "";
      const pnlClass = isProfit ? "profit" : "loss";
      pnlHtml = `<span class="${pnlClass}">${sign}$${Number(trade.pnl).toFixed(2)}</span>`;
    }

    const priceDecimals = ASSET_CONFIG[trade.asset]?.decimals || 2;

    rowsHtml += `
      <tr>
        <td>${trade.time}</td>
        <td><span class="${badgeClass}">${trade.type}</span></td>
        <td><strong>${trade.asset}</strong></td>
        <td>$${Number(trade.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: priceDecimals })}</td>
        <td>${Number(trade.quantity).toFixed(priceDecimals)} ${trade.asset}</td>
        <td><strong>$${Number(trade.totalValue).toFixed(2)}</strong></td>
        <td>${pnlHtml}</td>
        <td>${trade.note || ""}</td>
      </tr>
    `;
  });

  tbody.innerHTML = rowsHtml;
}

// Update top statistics and cards
function updateUI(state) {
  const totalPort = document.getElementById("total-portfolio");
  const availCash = document.getElementById("available-cash");
  const totalPnl = document.getElementById("total-pnl");

  if (totalPort) totalPort.innerText = `$${Number(state.totalPortfolio).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  if (availCash) availCash.innerText = `$${Number(state.cash).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

  if (totalPnl) {
    const isNetProfit = Number(state.pnl) >= 0;
    const sign = isNetProfit ? "+" : "";
    totalPnl.innerText = `${sign}$${Number(state.pnl).toFixed(2)} (${sign}${Number(state.pnlPercent).toFixed(2)}%)`;
    totalPnl.className = isNetProfit ? "metric-value profit" : "metric-value loss";
  }

  if (state.assets) {
    Object.keys(state.assets).forEach(coin => {
      const assetData = state.assets[coin];
      const lowerCoin = coin.toLowerCase();

      const priceElem = document.getElementById(`price-${lowerCoin}`);
      const holdElem = document.getElementById(`hold-${lowerCoin}`);

      const decimals = ASSET_CONFIG[coin]?.decimals || 2;
      const currentPrice = Number(assetData.price || 0);

      if (priceElem) {
        priceElem.innerText = `$${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: decimals })}`;
      }

      if (holdElem) {
        const totalQty = (assetData.orders || []).reduce((acc, o) => acc + Number(o.qty || 0), 0);
        const orderCount = assetData.orders ? assetData.orders.length : 0;
        holdElem.innerText = `Holding: ${totalQty.toFixed(decimals)} ${coin} (${orderCount}/3)`;
      }

      if (assetData.history) {
        updateChartData(coin, assetData.history);
      }
    });
  }

  renderTradeLog(state.trade_log);
}

// Fetch Bybit directly and relay to Python backend
async function fetchBybitAndRelay() {
  if (!isRunning) return;

  try {
    const res = await fetch(BYBIT_PUBLIC_URL);
    if (!res.ok) throw new Error(`Bybit response status: ${res.status}`);
    const json = await res.json();
    const list = json?.result?.list || [];

    const prices = {};
    for (const item of list) {
      if (PAIR_MAP[item.symbol]) {
        prices[PAIR_MAP[item.symbol]] = parseFloat(item.lastPrice);
      }
    }

    if (Object.keys(prices).length > 0) {
      // Send prices to Python backend
      await fetch("/tick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prices })
      });
    }

    // Pull current trading state back to display
    const stateRes = await fetch("/state");
    const stateData = await stateRes.json();
    updateUI(stateData);

  } catch (err) {
    console.error("Bybit Relay Error:", err);
  }
}

// App lifecycle
document.addEventListener("DOMContentLoaded", () => {
  initCharts();
  fetchBybitAndRelay();
  setInterval(fetchBybitAndRelay, 3000);

  const pauseBtn = document.getElementById("pause-btn");
  if (pauseBtn) {
    pauseBtn.addEventListener("click", () => {
      isRunning = !isRunning;
      pauseBtn.innerText = isRunning ? "Pause Bot" : "Resume Bot";
      pauseBtn.className = isRunning ? "btn pause" : "btn resume";
    });
  }
});
