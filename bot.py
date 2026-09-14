import os
import json
import time
import threading
import requests
from datetime import datetime
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

app = FastAPI(title="Bybit Cloud Scalper")

# Mount static frontend directory
app.mount("/static", StaticFiles(directory="static"), name="static")

STATE_FILE = "trading_state.json"
BYBIT_TICKER_URL = "https://api.bybit.com/v5/market/tickers?category=spot"
TICK_INTERVAL_SECONDS = 5.0

# Standard browser headers so Bybit Cloudflare does not reject Python requests
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json"
}

# Native Bybit Spot pair mappings
ASSET_PAIRS = {
    "BTC": "BTCUSDT",
    "ETH": "ETHUSDT",
    "SOL": "SOLUSDT",
    "CORE": "COREUSDT",
    "MNT": "MNTUSDT",
    "XAUT": "XAUTUSDT"
}

# Scalping Parameters
BYBIT_FEE_RATE = 0.001       # 0.10% Spot fee per side
TAKE_PROFIT_PCT = 0.0065     # +0.65% TP
STOP_LOSS_PCT = -0.0035      # -0.35% SL
DIP_THRESHOLD_PCT = 0.002    # -0.20% dip to scale into next order
MAX_ORDERS_PER_COIN = 3
COOLDOWN_SECONDS = 600       # 10-minute cooldown on buy after exit
ORDER_INTERVAL_SECONDS = 60  # 60s delay between scaled entries
SMA_PERIOD = 5

state_lock = threading.Lock()

# Bot State Definition
state = {
    "cash": 5000.00,
    "initial_balance": 5000.00,
    "pnl": 0.0,
    "pnlPercent": 0.0,
    "totalPortfolio": 5000.00,
    "assets": {
        "BTC": {"symbol": "BTCUSDT", "price": 0.0, "lastPrice": None, "history": [], "orders": [], "decimals": 4, "lastExitTime": 0, "lastBuyTime": 0},
        "ETH": {"symbol": "ETHUSDT", "price": 0.0, "lastPrice": None, "history": [], "orders": [], "decimals": 4, "lastExitTime": 0, "lastBuyTime": 0},
        "SOL": {"symbol": "SOLUSDT", "price": 0.0, "lastPrice": None, "history": [], "orders": [], "decimals": 2, "lastExitTime": 0, "lastBuyTime": 0},
        "CORE": {"symbol": "COREUSDT", "price": 0.0, "lastPrice": None, "history": [], "orders": [], "decimals": 2, "lastExitTime": 0, "lastBuyTime": 0},
        "MNT": {"symbol": "MNTUSDT", "price": 0.0, "lastPrice": None, "history": [], "orders": [], "decimals": 2, "lastExitTime": 0, "lastBuyTime": 0},
        "XAUT": {"symbol": "XAUTUSDT", "price": 0.0, "lastPrice": None, "history": [], "orders": [], "decimals": 4, "lastExitTime": 0, "lastBuyTime": 0},
    },
    "trade_log": []
}

def load_state():
    global state
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r") as f:
                saved = json.load(f)
                state.update(saved)
                print("State loaded successfully from file.")
        except Exception as e:
            print(f"Error loading state file: {e}")

def save_state():
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f, indent=2)
    except Exception as e:
        print(f"Error writing state file: {e}")

def fetch_bybit_prices():
    """Fetch live Spot prices directly from Bybit V5 public tickers."""
    try:
        resp = requests.get(BYBIT_TICKER_URL, headers=HEADERS, timeout=6)
        if resp.status_code == 200:
            data = resp.json()
            items = data.get("result", {}).get("list", [])
            price_map = {}
            for item in items:
                sym = item.get("symbol")
                for coin, pair in ASSET_PAIRS.items():
                    if sym == pair:
                        price_map[coin] = float(item.get("lastPrice"))
            return price_map
        else:
            print(f"Bybit API HTTP Error: {resp.status_code}")
            return None
    except Exception as err:
        print(f"Network error contacting Bybit API: {err}")
        return None

def record_trade(trade_type, asset, price, qty, total_val, pnl, note):
    trade_entry = {
        "time": datetime.now().strftime("%H:%M:%S"),
        "type": trade_type,
        "asset": asset,
        "price": price,
        "quantity": qty,
        "totalValue": total_val,
        "pnl": pnl,
        "note": note
    }
    state["trade_log"].insert(0, trade_entry)
    if len(state["trade_log"]) > 100:
        state["trade_log"].pop()

def calculate_sma(history, period=SMA_PERIOD):
    if len(history) < period:
        return None
    return sum(history[-period:]) / period

def calculate_confidence_size(history, base_size=500.0):
    if len(history) < 4:
        return base_size
    diffs = [history[i] - history[i - 1] for i in range(1, len(history))]
    negatives = [d for d in diffs if d < 0]
    if len(negatives) >= 2:
        return round(min(base_size * 1.3, 700.0), 2)
    return base_size

def trading_worker():
    """Background engine running scalping strategies against live Bybit order books."""
    time.sleep(2)
    while True:
        try:
            live_prices = fetch_bybit_prices()
            if not live_prices:
                time.sleep(TICK_INTERVAL_SECONDS)
                continue

            current_time = time.time() * 1000

            with state_lock:
                holding_total = 0.0

                for coin, coin_data in state["assets"].items():
                    curr_price = live_prices.get(coin)
                    if not curr_price or curr_price <= 0:
                        continue

                    coin_data["lastPrice"] = coin_data["price"]
                    coin_data["price"] = curr_price
                    coin_data["history"].append(curr_price)
                    if len(coin_data["history"]) > 30:
                        coin_data["history"].pop(0)

                    orders = coin_data["orders"]
                    sma = calculate_sma(coin_data["history"])

                    # 1. EVALUATE EXITS (Take-Profit / Stop-Loss)
                    remaining_orders = []
                    for order in orders:
                        pnl_pct = (curr_price - order["entryPrice"]) / order["entryPrice"]

                        if pnl_pct >= TAKE_PROFIT_PCT:
                            revenue = order["qty"] * curr_price
                            sell_fee = revenue * BYBIT_FEE_RATE
                            net_revenue = revenue - sell_fee
                            trade_pnl = round(net_revenue - order["cost"], 2)

                            state["cash"] += net_revenue
                            coin_data["lastExitTime"] = current_time
                            record_trade(
                                "SELL",
                                coin,
                                curr_price,
                                order["qty"],
                                round(net_revenue, 2),
                                trade_pnl,
                                f"TP +{round(pnl_pct * 100, 2)}% | Net: +${trade_pnl}"
                            )
                        elif pnl_pct <= STOP_LOSS_PCT:
                            revenue = order["qty"] * curr_price
                            sell_fee = revenue * BYBIT_FEE_RATE
                            net_revenue = revenue - sell_fee
                            trade_pnl = round(net_revenue - order["cost"], 2)

                            state["cash"] += net_revenue
                            coin_data["lastExitTime"] = current_time
                            record_trade(
                                "STOP",
                                coin,
                                curr_price,
                                order["qty"],
                                round(net_revenue, 2),
                                trade_pnl,
                                f"SL {round(pnl_pct * 100, 2)}% | Loss: ${trade_pnl}"
                            )
                        else:
                            remaining_orders.append(order)

                    coin_data["orders"] = remaining_orders

                    # 2. EVALUATE ENTRIES
                    cooldown_active = (current_time - coin_data.get("lastExitTime", 0)) < (COOLDOWN_SECONDS * 1000)
                    can_scale = len(coin_data["orders"]) < MAX_ORDERS_PER_COIN
                    has_cash = state["cash"] >= 100.0

                    if not cooldown_active and can_scale and has_cash:
                        time_since_last_buy = (current_time - coin_data.get("lastBuyTime", 0))
                        should_buy = False
                        entry_size = 0.0

                        # Initial entry rule
                        if len(coin_data["orders"]) == 0:
                            if sma is not None and curr_price < sma:
                                entry_size = min(calculate_confidence_size(coin_data["history"]), state["cash"])
                                should_buy = True
                        # Scaled dip-buying rule
                        elif time_since_last_buy > (ORDER_INTERVAL_SECONDS * 1000):
                            last_entry = coin_data["orders"][-1]["entryPrice"]
                            if curr_price < (last_entry * (1.0 - DIP_THRESHOLD_PCT)):
                                if sma is None or curr_price < sma:
                                    entry_size = min(calculate_confidence_size(coin_data["history"]), state["cash"])
                                    should_buy = True

                        if should_buy and entry_size >= 20.0:
                            buy_fee = entry_size * BYBIT_FEE_RATE
                            usable_capital = entry_size - buy_fee
                            qty = usable_capital / curr_price

                            coin_data["orders"].append({
                                "id": int(current_time),
                                "entryPrice": curr_price,
                                "qty": qty,
                                "cost": entry_size,
                                "fee": buy_fee
                            })

                            state["cash"] -= entry_size
                            coin_data["lastBuyTime"] = current_time

                            record_trade(
                                "BUY",
                                coin,
                                curr_price,
                                round(qty, coin_data["decimals"]),
                                round(entry_size, 2),
                                None,
                                f"Order #{len(coin_data['orders'])} (Fee: ${round(buy_fee, 2)})"
                            )

                    # Compute total current asset valuation
                    current_qty = sum(o["qty"] for o in coin_data["orders"])
                    holding_total += current_qty * curr_price

                # 3. OVERALL PORTFOLIO METRICS
                total_portfolio = state["cash"] +  holding_total
                net_pnl = total_portfolio - state["initial_balance"]
                net_pnl_pct = (net_pnl / state["initial_balance"]) * 100

                state["totalPortfolio"] = round(total_portfolio, 2)
                state["pnl"] = round(net_pnl, 2)
                state["pnlPercent"] = round(net_pnl_pct, 2)

                save_state()

        except Exception as e:
            print(f"Error in trading cycle: {e}")

        time.sleep(TICK_INTERVAL_SECONDS)

worker_thread = threading.Thread(target=trading_worker, daemon=True)

@app.on_event("startup")
def startup_event():
    load_state()
    if not worker_thread.is_alive():
        worker_thread.start()

@app.get("/")
def read_root():
    return FileResponse("static/index.html")

@app.get("/state")
def get_state():
    with state_lock:
        return state
