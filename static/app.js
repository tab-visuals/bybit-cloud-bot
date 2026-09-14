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
        animation: { duration: 200 },
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

function updateChartData(coin, history) {
  if (!charts[coin] || !history || history.length === 0) return;
  charts[coin].data.labels = history.map(() => "");
  charts[coin].data.datasets[0].data = history;
  charts[coin].update();
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

function setPriceInDOM(coin, price) {
  const priceElem = document.getElementById(`price-${coin.toLowerCase()}`);
  const decimals = ASSET_CONFIG[coin]?.decimals || 2;
  if (priceElem) {
    priceElem.innerText = `$${Number(price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: decimals })}`;
  }
}

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

      const holdElem = document.getElementById(`hold-${lowerCoin}`);
      const decimals = ASSET_CONFIG[coin]?.decimals || 2;
      const currentPrice = Number(assetData.price || livePrices[coin] || 0);

      if (currentPrice > 0) {
        setPriceInDOM(coin, currentPrice);
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

// Initial bootstrap to get immediate prices before socket events
async function fetchBootstrapPrices() {
  try {
    const res = await fetch("https://api.bybit.com/v5/market/tickers?category=spot");
    if (!res.ok) return;
    const json = await res.json();
    const list = json?.result?.list || [];
    list.forEach(item => {
      const coin = PAIR_MAP[item.symbol];
      if (coin && item.lastPrice) {
        const p = parseFloat(item.lastPrice);
        livePrices[coin] = p;
        setPriceInDOM(coin, p);
      }
    });
  } catch (_) {
    // If CORS prevents the REST fetch, WebSocket remains the live pipeline
  }
}

// Connect directly to Bybit Spot WebSocket
function connectBybitWebSocket() {
  const wsUrl = "wss://stream.bybit.com/v5/public/spot";
  const ws = new WebSocket(wsUrl);
  let pingInterval;

  ws.onopen = () => {
    console.log("Connected to Bybit Spot WebSocket");
    
    // Subscribe to all spot ticker pairs in a single message
    const args = Object.keys(PAIR_MAP).map(pair => `tickers.${pair}`);
    ws.send(JSON.stringify({ op: "subscribe", args: args }));

    // Heartbeat ping every 20 seconds
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ op: "ping" }));
      }
    }, 20000);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.op === "pong" || data.ret_msg === "pong") return;

      if (data.topic && data.topic.startsWith("tickers.") && data.data) {
        const item = Array.isArray(data.data) ? data.data[0] : data.data;
        const symbol = item.symbol || data.topic.split(".")[1];
        const rawPrice = item.lastPrice || item.lp || item.close;

        if (rawPrice) {
          const price = parseFloat(rawPrice);
          const coin = PAIR_MAP[symbol];

          if (coin && !isNaN(price) && price > 0) {
            livePrices[coin] = price;
            setPriceInDOM(coin, price);
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
    console.warn("Bybit WebSocket closed. Reconnecting in 3 seconds...");
    setTimeout(connectBybitWebSocket, 3000);
  };
}

// Push live Bybit ticks to Python backend
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
      const state = await res.json();
      updateUI(state);
    }
  } catch (err) {
    console.warn("Sync error:", err);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initCharts();
  fetchBootstrapPrices();
  connectBybitWebSocket();
  setInterval(syncWithServer, 3000);

  const pauseBtn = document.getElementById("pause-btn");
  if (pauseBtn) {
    pauseBtn.addEventListener("click", () => {
      isRunning = !isRunning;
      pauseBtn.innerText = isRunning ? "Pause Bot" : "Resume Bot";
      pauseBtn.className = isRunning ? "btn pause" : "btn resume";
    });
  }
});
