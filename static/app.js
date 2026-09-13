async function updateDashboard() {
  try {
    const res = await fetch('/state');
    if (!res.ok) return;
    const data = await res.json();

    // 1. Top Metrics (support hyphens, camelCase, and underscores)
    const totalEl = document.getElementById('total-portfolio') || document.getElementById('totalPortfolio') || document.getElementById('total_portfolio');
    const cashEl = document.getElementById('available-cash') || document.getElementById('availableCash') || document.getElementById('available_cash');
    const pnlEl = document.getElementById('total-pnl') || document.getElementById('totalPnl') || document.getElementById('total_pnl');

    if (totalEl && data.total_portfolio !== undefined) {
      totalEl.textContent = `$${Number(data.total_portfolio).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    }
    if (cashEl && data.available_cash !== undefined) {
      cashEl.textContent = `$${Number(data.available_cash).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    }
    if (pnlEl && data.total_pnl !== undefined) {
      const pnl = Number(data.total_pnl);
      const pct = Number(data.pnl_percentage || 0);
      const sign = pnl >= 0 ? '+' : '';
      pnlEl.textContent = `${sign}$${pnl.toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
      pnlEl.className = pnl >= 0 ? 'text-green' : 'text-red';
    }

    // 2. Asset Cards (matches price-SOL / hold-SOL exactly)
    const assets = ['BTC', 'ETH', 'SOL', 'CORE', 'MNT', 'XAUT'];
    assets.forEach(symbol => {
      const price = (data.prices && data.prices[symbol] !== undefined) ? Number(data.prices[symbol]) : 0;
      const holding = (data.holdings && data.holdings[symbol]) ? data.holdings[symbol] : { qty: 0, orders: 0 };

      // Check uppercase first (as in your HTML), fallback to lowercase
      const priceEl = document.getElementById(`price-${symbol}`) || document.getElementById(`price-${symbol.toLowerCase()}`);
      const holdEl = document.getElementById(`hold-${symbol}`) || document.getElementById(`holding-${symbol.toLowerCase()}`) || document.getElementById(`hold-${symbol.toLowerCase()}`);

      if (priceEl) {
        priceEl.textContent = price >= 1 
          ? `$${price.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}` 
          : `$${price.toFixed(4)}`;
      }

      if (holdEl) {
        const qtyFormatted = symbol === 'BTC' || symbol === 'ETH' || symbol === 'XAUT' 
          ? Number(holding.qty).toFixed(4) 
          : Number(holding.qty).toFixed(2);
        holdEl.textContent = `Holding: ${qtyFormatted} ${symbol} (${holding.orders}/3)`;
      }
    });

    // 3. Trade History Table
    const tableBody = document.getElementById('trades-body') || document.getElementById('tradesBody') || document.querySelector('#trades-table tbody');
    if (tableBody && data.trades && data.trades.length > 0) {
      tableBody.innerHTML = data.trades.map(t => `
        <tr>
          <td>${t.time}</td>
          <td class="${t.type === 'BUY' ? 'text-green' : 'text-red'} font-bold">${t.type}</td>
          <td>${t.asset}</td>
          <td>$${Number(t.price).toLocaleString()}</td>
          <td>${Number(t.quantity).toFixed(4)}</td>
          <td>$${Number(t.total_value).toFixed(2)}</td>
          <td class="${t.pnl && t.pnl > 0 ? 'text-green' : (t.pnl && t.pnl < 0 ? 'text-red' : '')}">
            ${t.pnl !== null && t.pnl !== undefined ? (t.pnl >= 0 ? '+$' + Number(t.pnl).toFixed(2) : '-$' + Math.abs(t.pnl).toFixed(2)) : '-'}
          </td>
          <td><span class="badge">${t.note || ''}</span></td>
        </tr>
      `).join('');
    }
  } catch (err) {
    console.error("Dashboard update error:", err);
  }
}

// Initial run and repeat every 3s
updateDashboard();
setInterval(updateDashboard, 3000);
