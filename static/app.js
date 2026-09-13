async function updateDashboard() {
  try {
    const res = await fetch('/state');
    if (!res.ok) return;
    const data = await res.json();

    // 1. Top Metrics
    const totalEl = document.getElementById('total-portfolio');
    const cashEl = document.getElementById('available-cash');
    const pnlEl = document.getElementById('total-pnl');

    if (totalEl) totalEl.textContent = `$${Number(data.total_portfolio || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    if (cashEl) cashEl.textContent = `$${Number(data.available_cash || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    
    if (pnlEl) {
      const pnl = Number(data.total_pnl || 0);
      const pct = Number(data.pnl_percentage || 0);
      const sign = pnl >= 0 ? '+' : '';
      pnlEl.textContent = `${sign}$${pnl.toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
      pnlEl.className = pnl >= 0 ? 'text-green' : 'text-red';
    }

    // 2. Asset Cards
    const assets = ['BTC', 'ETH', 'SOL', 'CORE', 'MNT', 'XAUT'];
    assets.forEach(symbol => {
      const price = data.prices && data.prices[symbol] ? Number(data.prices[symbol]) : 0;
      const holding = data.holdings && data.holdings[symbol] ? data.holdings[symbol] : { qty: 0, orders: 0 };

      const priceEl = document.getElementById(`price-${symbol.toLowerCase()}`);
      const holdEl = document.getElementById(`holding-${symbol.toLowerCase()}`);

      if (priceEl) {
        priceEl.textContent = price >= 1 ? `$${price.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : `$${price.toFixed(4)}`;
      }
      if (holdEl) {
        holdEl.textContent = `Holding: ${Number(holding.qty).toFixed(4)} ${symbol} (${holding.orders}/3)`;
      }
    });

    // 3. Trade History Table (if exists)
    const tableBody = document.getElementById('trades-body');
    if (tableBody && data.trades) {
      tableBody.innerHTML = data.trades.map(t => `
        <tr>
          <td>${t.time}</td>
          <td class="${t.type === 'BUY' ? 'text-green' : 'text-red'} font-bold">${t.type}</td>
          <td>${t.asset}</td>
          <td>$${Number(t.price).toLocaleString()}</td>
          <td>${Number(t.quantity).toFixed(4)}</td>
          <td>$${Number(t.total_value).toFixed(2)}</td>
          <td class="${t.pnl && t.pnl > 0 ? 'text-green' : (t.pnl && t.pnl < 0 ? 'text-red' : '')}">${t.pnl !== null ? (t.pnl >= 0 ? '+$' + Number(t.pnl).toFixed(2) : '-$' + Math.abs(t.pnl).toFixed(2)) : '-'}</td>
          <td><span class="badge">${t.note || ''}</span></td>
        </tr>
      `).join('');
    }
  } catch (err) {
    console.error("Dashboard update failed:", err);
  }
}

// Poll state every 3 seconds
setInterval(updateDashboard, 3000);
document.addEventListener('DOMContentLoaded', updateDashboard);
