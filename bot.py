import time
import threading
import requests
import json
import os
import random
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# --- Bot Configuration ---
INITIAL_BALANCE = 5000.00
BYBIT_FEE_RATE = 0.001          # 0.10% Spot fee
COOLDOWN_SECONDS = 10 * 60      # 10-minute cooldown on BUY after exit
ORDER_INTERVAL_SECONDS = 60     # 60s delay between scaled orders
MAX_ORDERS_PER_COIN = 3
TICK_INTERVAL_SECONDS = 5.0     # CoinGecko rate-limit friendly

TAKE_PROFIT_THRESHOLD = 0.0065  # +0.65%
STOP_LOSS_THRESHOLD = 0.0035    # -0.35%

COINS = {
    "BTC": {"symbol": "BTCUSDT", "gecko_id": "bitcoin", "decimals": 4},
    "ETH": {"symbol": "ETHUSDT", "gecko_id": "ethereum", "decimals": 4},
    "SOL": {"symbol": "SOLUSDT", "gecko_id": "solana", "decimals": 2},
    "CORE": {"symbol": "COREUSDT", "gecko_id": "coredaoorg", "decimals": 2},
    "MNT": {"symbol": "MNTUSDT", "gecko_id": "mantle", "decimals": 2},
    "PAXG": {"symbol": "PAXGUSDT", "gecko_id": "pax-gold", "decimals": 4},
}

STATE_FILE = "trading_state.json"

# --- In-Memory State & Persistence ---
def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return {
        "cashBalance": INITIAL_BALANCE,
        "tradeLog": [],
        "assets": {
            coin: {
                "symbol": meta["symbol"],
                "price": 0.0,
                "history": [],
                "orders": [],
                "decimals": meta["decimals"],
                "lastExitTime": 0,
                "lastBuyTime": 0
            }
            for coin, meta in COINS.items()
        }
    }

state = load_state()

def save_state():
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f, indent=2)
    except Exception as e:
        print(f"Failed to save state: {e}")

# --- Strategy Helpers ---
def calculate_sma(history, period=5):
    if len(history) < period:
        return None
    return sum(history[-period:]) / period

def get_random_trade_size(cash):
    min_trade = 200
    max_trade = 600
    size = random.randint(min_trade, max_trade)
    return min(cash, size)

def record_trade(action, coin, price, qty, total_val, pnl=None, note=""):
    timestamp = time.strftime("%H:%M:%S", time.gmtime())
    entry = {
        "time": timestamp,
        "type": action,
        "asset": coin,
        "price": price,
        "quantity": qty,
        "totalValue": round(total_val, 2),
        "pnl": round(pnl, 2) if pnl is not None else None,
        "note": note
    }
    state["tradeLog"].insert(0, entry)
    if len(state["tradeLog"]) > 100:
        state["tradeLog"].pop()
    save_state()

# --- Main Trading Thread ---
def trading_worker():
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json"
    })
    
    url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,coredaoorg,mantle,pax-gold&vs_currencies=usd"

    while True:
        try:
            res = session.get(url, timeout=10)
            if res.status_code != 200:
                print(f"CoinGecko status error: {res.status_code}")
                time.sleep(TICK_INTERVAL_SECONDS)
                continue

            data = res.json()
            now = time.time()

            for coin, meta in COINS.items():
                gecko_key = meta["gecko_id"]
                if gecko_key not in data or "usd" not in data[gecko_key]:
                    continue

                curr_price = float(data[gecko_key]["usd"])
                asset = state["assets"][coin]
                asset["price"] = curr_price
                asset["history"].append(curr_price)
                if len(asset["history"]) > 30:
                    asset["history"].pop(0)

                active_orders = asset["orders"]
                active_count = len(active_orders)

                # 1. Evaluate Exits (TP / SL)
                for i in range(len(active_orders) - 1, -1, -1):
                    ord_item = active_orders[i]
                    pnl_rate = (curr_price - ord_item["entryPrice"]) / ord_item["entryPrice"]
                    gross_sale = ord_item["qty"] * curr_price
                    exit_fee = gross_sale * BYBIT_FEE_RATE
                    net_sale = gross_sale - exit_fee
                    net_pnl = net_sale - ord_item["cost"]

                    should_exit = False
                    reason = ""

                    if pnl_rate >= TAKE_PROFIT_THRESHOLD:
                        should_exit = True
                        reason = "Target Profit"
                    elif pnl_rate <= -STOP_LOSS_THRESHOLD:
                        should_exit = True
                        reason = "Stop Loss"

                    if should_exit:
                        state["cashBalance"] += net_sale
                        active_orders.pop(i)
                        asset["lastExitTime"] = now
                        record_trade(
                            "SELL" if pnl_rate >= TAKE_PROFIT_THRESHOLD else "STOP",
                            coin,
                            curr_price,
                            ord_item["qty"],
                            net_sale,
                            pnl=net_pnl,
                            note=f"{reason} [10m Cool]"
                        )

                # 2. Evaluate Buys
                sma = calculate_sma(asset["history"], 5)
                is_cooling_down = (now - asset.get("lastExitTime", 0)) < COOLDOWN_SECONDS
                has_spacing = (now - asset.get("lastBuyTime", 0)) >= ORDER_INTERVAL_SECONDS

                is_dipping_further = True
                if len(active_orders) > 0:
                    last_entry = active_orders[-1]["entryPrice"]
                    is_dipping_further = curr_price < (last_entry * 0.998)

                if (
                    active_count < MAX_ORDERS_PER_COIN
                    and not is_cooling_down
                    and has_spacing
                    and is_dipping_further
                    and sma is not None
                    and curr_price < sma
                    and state["cashBalance"] >= 200
                ):
                    size = get_random_trade_size(state["cashBalance"])
                    if size >= 200:
                        fee = size * BYBIT_FEE_RATE
                        net_cap = size - fee
                        qty = net_cap / curr_price

                        state["cashBalance"] -= size
                        asset["lastBuyTime"] = now
                        active_orders.append({
                            "id": int(now * 1000),
                            "entryPrice": curr_price,
                            "qty": qty,
                            "cost": size,
                            "entryTime": now
                        })
                        record_trade("BUY", coin, curr_price, qty, size, note=f"Order #{len(active_orders)} (Fee: ${fee:.2f})")

            save_state()

        except Exception as e:
            print(f"Loop error: {e}")

        time.sleep(TICK_INTERVAL_SECONDS)

# Start trading thread in background
thread = threading.Thread(target=trading_worker, daemon=True)
thread.start()

# --- Web API for Dashboard ---
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/state")
def get_state():
    holdings_val = 0.0
    for coin, asset in state["assets"].items():
        total_held = sum(o["qty"] for o in asset["orders"])
        holdings_val += (total_held * asset["price"])

    total_val = state["cashBalance"] + holdings_val
    total_pnl = total_val - INITIAL_BALANCE
    pnl_pct = (total_pnl / INITIAL_BALANCE) * 100

    return {
        "cashBalance": round(state["cashBalance"], 2),
        "totalPortfolio": round(total_val, 2),
        "pnl": round(total_pnl, 2),
        "pnlPercent": round(pnl_pct, 2),
        "assets": state["assets"],
        "tradeLog": state["tradeLog"]
    }
