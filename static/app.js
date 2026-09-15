const ASSET_CONFIG = {
  BTC: { name: "Bitcoin", color: "#10b981", decimals: 2 },
  ETH: { name: "Ethereum", color: "#6366f1", decimals: 2 },
  SOL: { name: "Solana", color: "#f59e0b", decimals: 2 },
  CORE: { name: "Core DAO", color: "#ec4899", decimals: 4 },
  MNT: { name: "Mantle", color: "#06b6d4", decimals: 4 },
  XAUT: { name: "Tether Gold", color: "#eab308", decimals: 2 }
};

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
let livePrices = {};
let priceHistories = {
  BTC: [], ETH: [], SOL: [], CORE: [], MNT: [], XAUT: []
};

// Initialize Chart.js instances
function initCharts() {
  Object.keys(ASSET_CONFIG).forEach(coin => {
    const canvas = document.getElementById(`chart-${coin.toLowerCase()}`);
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    const color = ASSET_CONFIG[coin].color;

    charts[coin] = new Chart(ctx, {
      type: "line",
      data: {
        labels: [],
        datasets: [{
          data: [],
          borderColor: color,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.25,
          fill: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false }
        },
        scales: {
          x: { display: false },
          y: {
            display: true,
            grid: { color: "rgba(255, 255, 255, 0.05)", drawBorder: false },
            ticks: {
              color: "#94a3b8",
              font: { size: 10 },
              maxTicksLimit: 4
            }
          }
        }
      }
    });
  });
}

function pushPriceToChart(coin, price) {
  if (!priceHistories[coin]) priceHistories[coin] = [];
  priceHistories[coin].push(price);
  if (priceHistories[coin].length > 25) priceHistories[coin].shift();

  if (charts[coin]) {
    charts[coin].data.labels = priceHistories[coin].map(() => "");
    charts[coin].data.datasets[0].data = priceHistories[coin];
    charts[coin].update("none");
  }
}

function updateHoldingDOM(coin, qty, ordersCount, decimals) {
  const lower = coin.toLowerCase();
  // Target both standard naming conventions
  const el = document.getElementById(`hold-${lower}`) || document.getElementById(`holding-${lower}`);
  if (el) {
    el.innerText = `Holding: ${Number(qty).toFixed(decimals)} ${coin} (${ordersCount}/3)`;
  }
}

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

function updateUI(state) {
  if (!state) return;

  const totalPort = document.getElementById("total-portfolio");
  const availCash = document.getElementById("available-cash");
  const totalPnl = document.getElementById("total-pnl");

  if (totalPort) totalPort.innerText = `$${Number(state.totalPortfolio || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  if (availCash) availCash.innerText = `$${Number(state.cash || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

  if (totalPnl) {
    const pnl = Number(state.pnl || 0);
    const pnlPct = Number(state.pnlPercent || 0);
    const isProfit = pnl >= 0;
    const sign = isProfit ? "+" : "";
    totalPnl.innerText = `${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%)`;
    totalPnl.className = isProfit ? "metric-value profit" : "metric-value loss";
  }

  if (state.assets) {
    Object.keys(state.assets).forEach(coin => {
      const asset = state.assets[coin];
      const decimals = ASSET_CONFIG[coin]?.decimals || 2;
      const orders = asset.orders || [];
      const totalQty = orders.reduce((sum, o) => sum + Number(o.qty || 0), 0);
      
      updateHoldingDOM(coin, totalQty, orders.length, decimals);

      if (asset.history && asset.history.length > 0 && priceHistories[coin].length === 0) {
        priceHistories[coin] = [...asset.history];
        if (charts[coin]) {
          charts[coin].data.labels = priceHistories[coin].map(() => "");
          charts[coin].data.datasets[0].data = priceHistories[coin];
          charts[coin].update("none");
        }
      }
    });
  }

  renderTradeLog(state.trade_log);
}

// Connect directly to Bybit Spot WebSocket
function connectBybitWebSocket() {
  const wsUrl = "wss://stream.bybit.com/v5/public/spot";
  const ws = new WebSocket(wsUrl);
  let pingInterval;

  ws.onopen = () => {
    console.log("Connected to Bybit Spot WebSocket");
    
    Object.keys(PAIR_MAP).forEach(pair => {
      ws.send(JSON.stringify({
        op: "subscribe",
        args: [`tickers.${pair}`]
      }));
    });

    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ op: "ping" }));
      }
    }, 20000);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.op === "pong" || msg.ret_msg === "pong") return;

      if (msg.topic && msg.topic.startsWith("tickers.") && msg.data) {
        const payload = msg.data;
        const symbol = payload.symbol || msg.topic.split(".")[1];
        const rawPrice = payload.lastPrice;

        if (rawPrice) {
          const price = parseFloat(rawPrice);
          const coin = PAIR_MAP[symbol];

          if (coin && !isNaN(price) && price > 0) {
            livePrices[coin] = price;

            // 1. Update Price Card
            const el = document.getElementById(`price-${coin.toLowerCase()}`);
            if (el) {
              const decimals = ASSET_CONFIG[coin]?.decimals || 2;
              el.innerText = `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: decimals })}`;
            }

            // 2. Stream into Live Chart
            pushPriceToChart(coin, price);
          }
        }
      }
    } catch (e) {
      console.error("WS Parse Error:", e);
    }
  };

  ws.onerror = (err) => {
    console.error("Bybit WS Error:", err);
  };

  ws.onclose = () => {
    clearInterval(pingInterval);
    console.warn("WebSocket disconnected. Reconnecting in 3s...");
    setTimeout(connectBybitWebSocket, 3000);
  };
}

// Push live Bybit ticks to Python backend and retrieve updated state
async function syncWithServer() {
  if (!isRunning || Object.keys(livePrices).length === 0) return;

  try {
    const tickRes = await fetch("/tick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prices: livePrices })
    });

    if (tickRes.ok) {
      const res = await fetch("/state");
      if (res.ok) {
        const data = await res.json();
        updateUI(data);
      }
    }
  } catch (err) {
    console.warn("Sync error:", err);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initCharts();
  connectBybitWebSocket();
  setInterval(syncWithServer, 2000);

  const pauseBtn = document.getElementById("pause-btn");
  if (pauseBtn) {
    pauseBtn.addEventListener("click", () => {
      isRunning = !isRunning;
      pauseBtn.innerText = isRunning ? "Pause Bot" : "Resume Bot";
      pauseBtn.className = isRunning ? "btn pause" : "btn resume";
    });
  }
});
