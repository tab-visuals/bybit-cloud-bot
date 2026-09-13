const ASSETS = ['BTC', 'ETH', 'SOL', 'CORE', 'MNT', 'XAUT'];
const charts = {};

// Initialize Chart.js sparkline charts
function initCharts() {
  ASSETS.forEach(symbol => {
    const canvas = document.getElementById(`chart-${symbol}`);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    charts[symbol] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: Array(20).fill(''),
        datasets: [{
          data: [],
          borderColor: '#10b981',
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
          tension: 0.2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { display: false },
          y: {
            display: true,
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#64748b', font: { size: 10 } }
          }
        },
        animation: false
      }
    });
  });
}

async function updateDashboard() {
  try {
    const res = await fetch('/state');
    if (!res.ok) return;
    const data = await res.json();

    // 1. Top Metrics
    const balanceEl = document.getElementById('balance');
    const cashEl = document.getElementById('cash-balance');
    const pnlEl = document.getElementById('pnl');

    if (balanceEl && data.total_portfolio !== undefined) {
      balanceEl.textContent = `$${Number(data.total_portfolio).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    }

    if (cashEl && data.available_cash !== undefined) {
      cashEl.textContent = `$${Number(data.available_cash).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    }

    if (pnlEl && data.total_pnl !== undefined) {
      const pnl = Number(data.total_pnl);
      const pct = Number(data.pnl_percentage || 0);
      const sign = pnl >= 0 ? '+' : '';
      pnlEl.textContent = `${sign}$${pnl.toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
      pnlEl.className = pnl >= 0 ? 'metric-value profit' : 'metric-value loss';
    }

    // 2. Asset Cards & Charts
    ASSETS.forEach(symbol => {
      const price = (data.prices && data.prices[symbol] !== undefined) ? Number(data.prices[symbol]) : 0;
      const holding = (data.holdings && data.holdings[symbol]) ? data.holdings[symbol] : { qty: 0, orders: 0 };

      const priceEl = document.getElementById(`price-${symbol}`);
      const holdEl = document.getElementById(`hold-${symbol}`);

      if (priceEl) {
        priceEl.textContent = price >= 10 
          ? `$${price.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}` 
          : `$${price.toFixed(4)}`;
      }

      if (holdEl) {
        const qtyFormatted = (symbol === 'BTC' || symbol === 'ETH' || symbol === 'XAUT') 
          ? Number(holding.qty).toFixed(4) 
          : Number(holding.qty).toFixed(2);
        holdEl.textContent = `Holding: ${qtyFormatted} ${symbol} (${holding.orders}/3)`;
      }

      // Update Chart history
      if (charts[symbol] && data.history && data.history[symbol]) {
        charts[symbol].data.labels = Array(data.history[symbol].length).fill('');
        charts[symbol].data.datasets[0].data = data.history[symbol];
        charts[symbol].update();
      }
    });

    // 3. Recent Trades Table
    const tradeLog = document.getElementById('trade-log');
    if (tradeLog && data.trades) {
      tradeLog.innerHTML = data.trades.map(t => {
        const isBuy = t.type === 'BUY';
        let pnlText = '-';
        let pnlClass = '';

        if (t.pnl !== null && t.pnl !== undefined) {
          const val = Number(t.pnl);
          pnlText = val >= 0 ? `+$${val.toFixed(2)}` : `-$${Math.abs(val).toFixed(2)}`;
          pnlClass = val >= 0 ? 'profit' : 'loss';
        }

        return `
          <tr>
            <td>${t.time}</td>
            <td class="${isBuy ? 'profit' : 'loss'} font-bold">${t.type}</td>
            <td>${t.asset}</td>
            <td>$${Number(t.price).toLocaleString()}</td>
            <td>${Number(t.quantity).toFixed(4)}</td>
            <td>$${Number(t.total_value).toFixed(2)}</td>
            <td class="${pnlClass}">${pnlText}</td>
            <td><span class="badge">${t.note || ''}</span></td>
          </tr>
        `;
      }).join('');
    }

  } catch (err) {
    console.error("Dashboard update error:", err);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  updateDashboard();
  setInterval(updateDashboard, 3000);
});
