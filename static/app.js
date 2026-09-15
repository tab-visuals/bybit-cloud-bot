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

let isRunning = true;
let livePrices = {};

// Update the DOM cards directly
function updateDOMPrice(coin, price) {
  const el = document.getElementById(`price-${coin.toLowerCase()}`);
  if (el) {
    const dec = ASSET_CONFIG[coin]?.decimals || 2;
    el.innerText = `$${Number(price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: dec })}`;
  }
}

// Update balances, holdings, and trade logs
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

  // Update Holdings lines (e.g. Holding: 0.0000 BTC (0/3))
  if (state.assets) {
    Object.keys(state.assets).forEach(coin => {
      const asset = state.assets[coin];
      const lower = coin.toLowerCase();
      const dec = ASSET_CONFIG[coin]?.decimals || 2;
      const orders = asset.orders || [];
      const totalQty = orders.reduce((sum, o) => sum + Number(o.qty || 0), 0);

      const holdElem = document.getElementById(`holding-${lower}`) || document.getElementById(`hold-${lower}`);
      if (holdElem) {
        holdElem.innerText = `Holding: ${Number(totalQty).toFixed(dec)} ${coin} (${orders.length}/3)`;
      }
    });
  }

  // Render Trade Log Table
  const tbody = document.getElementById("trade-log");
  if (tbody && state.trade_log) {
    if (state.trade_log.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: #64748b; padding: 20px;">Awaiting trade triggers...</td></tr>`;
    } else {
      tbody.innerHTML = state.trade_log.map(trade => {
        const isBuy = trade.type === "BUY";
        const badgeClass = isBuy ? "buy-tag" : "sell-tag";
        let pnlHtml = "-";
        if (trade.pnl !== null && trade.pnl !== undefined) {
          const isProfit = Number(trade.pnl) >= 0;
          const sign = isProfit ? "+" : "";
          pnlHtml = `<span class="${isProfit ? 'profit' : 'loss'}">${sign}$${Number(trade.pnl).toFixed(2)}</span>`;
        }
        const dec = ASSET_CONFIG[trade.asset]?.decimals || 2;
        return `
          <tr>
            <td>${trade.time}</td>
            <td><span class="${badgeClass}">${trade.type}</span></td>
            <td><strong>${trade.asset}</strong></td>
            <td>$${Number(trade.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: dec })}</td>
            <td>${Number(trade.quantity).toFixed(dec)} ${trade.asset}</td>
            <td><strong>$${Number(trade.totalValue).toFixed(2)}</strong></td>
            <td>${pnlHtml}</td>
            <td>${trade.note || ""}</td>
          </tr>
        `;
      }).join("");
    }
  }
}

// Connect directly to Bybit WebSocket
function connectBybitWebSocket() {
  const wsUrl = "wss://stream.bybit.com/v5/public/spot";
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("Connected to Bybit Spot WebSocket");

    // Subscribe individually to guarantee immediate snapshots
    Object.keys(PAIR_MAP).forEach(pair => {
      ws.send(JSON.stringify({
        op: "subscribe",
        args: [`tickers.${pair}`]
      }));
    });

    setInterval(() => {
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
        const symbol = payload.symbol || msg.topic.replace("tickers.", "");
        const rawPrice = payload.lastPrice || payload.lp || payload.close;

        if (rawPrice) {
          const price = parseFloat(rawPrice);
          const coin = PAIR_MAP[symbol];

          if (coin && !isNaN(price) && price > 0) {
            livePrices[coin] = price;
            updateDOMPrice(coin, price);
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
    console.warn("WebSocket disconnected. Reconnecting in 3s...");
    setTimeout(connectBybitWebSocket, 3000);
  };
}

// Push live ticks to backend and get updated holdings/trades
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
