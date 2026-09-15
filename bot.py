import os
import json
import time
import random
import threading
from datetime import datetime
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response

app = FastAPI(title="Bybit Scalper Relay")
app.mount("/static", StaticFiles(directory="static"), name="static")

STATE_FILE = "trading_state.json"

# Scalping Strategy Parameters (Balanced against fees & volatility)
BYBIT_FEE_RATE = 0.001       # 0.10% Spot fee
TAKE_PROFIT_PCT = 0.0150     # +1.50% TP (covers round-trip fees with solid profit)
STOP_LOSS_PCT = -0.0100      # -1.00% SL (avoids getting stopped out by micro-chop)
DIP_THRESHOLD_PCT = 0.0075   # -0.75% dip required to average down
MAX_ORDERS_PER_COIN = 3
COOLDOWN_SECONDS = 300       # 5-minute cooldown after exit
ORDER_INTERVAL_SECONDS = 90  # 90s delay between scale-in entries
SMA_PERIOD = 20              # 20-tick rolling average (~60s) to smooth out tick noise

state_lock = threading.Lock()

state = {
    "cash": 5000.00,
    "initial_balance": 5000.00,
    "pnl": 0.0,
    "pnlPercent": 0.0,
    "totalPortfolio": 5000.00,
    "assets": {
        "BTC": {"symbol": "BTCUSDT", "price": 0.0, "history": [], "orders": [], "decimals": 2, "lastExitTime": 0, "lastBuyTime": 0},
        "ETH": {"symbol": "ETHUSDT", "price": 0.0, "history": [], "orders": [], "decimals": 2, "lastExitTime": 0, "lastBuyTime": 0},
        "SOL": {"symbol": "SOLUSDT", "price": 0.0, "history": [], "orders": [], "decimals": 2, "lastExitTime": 0, "lastBuyTime": 0},
        "CORE": {"symbol": "COREUSDT", "price": 0.0, "history": [], "orders": [], "decimals": 4, "lastExitTime": 0, "lastBuyTime": 0},
        "MNT": {"symbol": "MNTUSDT", "price": 0.0, "history": [], "orders": [], "decimals": 4, "lastExitTime": 0, "lastBuyTime": 0},
        "XAUT": {"symbol": "XAUTUSDT", "price": 0.0, "history": [], "orders": [], "decimals": 2, "lastExitTime": 0, "lastBuyTime": 0},
    },
    "trade_log": []
}

def load_state():
    global state
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r") as f:
                state.update(json.load(f))
        except Exception as e:
            print(f"Error loading state: {e}")

def save_state():
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f, indent=2)
    except Exception as e:
        print(f"Error saving state: {e}")

def record_trade(trade_type, asset, price, qty, total_val, pnl, note):
    state["trade_log"].insert(0, {
        "time": datetime.now().strftime("%H:%M:%S"),
        "type": trade_type,
        "asset": asset,
        "price": price,
        "quantity": qty,
        "totalValue": total_val,
        "pnl": pnl,
        "note": note
    })
    if len(state["trade_log"]) > 100:
        state["trade_log"].pop()

def process_tick(prices: dict):
    """Executes scalping strategy on incoming live Bybit prices."""
    current_time = time.time() * 1000
    with state_lock:
        holding_total = 0.0

        for coin, coin_data in state["assets"].items():
            curr_price = prices.get(coin)
            if not curr_price or curr_price <= 0:
                continue

            coin_data["price"] = curr_price
            coin_data["history"].append(curr_price)
            if len(coin_data["history"]) > 40:
                coin_data["history"].pop(0)

            orders = coin_data["orders"]
            sma = sum(coin_data["history"][-SMA_PERIOD:]) / len(coin_data["history"][-SMA_PERIOD:]) if len(coin_data["history"]) >= SMA_PERIOD else None

            # 1. EVALUATE EXITS (TP / SL)
            remaining = []
            for order in orders:
                pnl_pct = (curr_price - order["entryPrice"]) / order["entryPrice"]
                if pnl_pct >= TAKE_PROFIT_PCT:
                    rev = order["qty"] * curr_price
                    net_rev = rev * (1.0 - BYBIT_FEE_RATE)
                    trade_pnl = round(net_rev - order["cost"], 2)
                    state["cash"] += net_rev
                    coin_data["lastExitTime"] = current_time
                    record_trade("SELL", coin, curr_price, order["qty"], round(net_rev, 2), trade_pnl, f"TP +{round(pnl_pct * 100, 2)}% | Net: +${trade_pnl}")
                elif pnl_pct <= STOP_LOSS_PCT:
                    rev = order["qty"] * curr_price
                    net_rev = rev * (1.0 - BYBIT_FEE_RATE)
                    trade_pnl = round(net_rev - order["cost"], 2)
                    state["cash"] += net_rev
                    coin_data["lastExitTime"] = current_time
                    record_trade("STOP", coin, curr_price, order["qty"], round(net_rev, 2), trade_pnl, f"SL {round(pnl_pct * 100, 2)}% | Loss: ${trade_pnl}")
                else:
                    remaining.append(order)
            coin_data["orders"] = remaining

            # 2. EVALUATE ENTRIES
            cooldown = (current_time - coin_data.get("lastExitTime", 0)) < (COOLDOWN_SECONDS * 1000)
            if not cooldown and len(coin_data["orders"]) < MAX_ORDERS_PER_COIN and state["cash"] >= 200.0:
                time_since_buy = (current_time - coin_data.get("lastBuyTime", 0))
                should_buy = False

                if len(coin_data["orders"]) == 0:
                    if sma is not None and curr_price < sma:
                        should_buy = True
                elif time_since_buy > (ORDER_INTERVAL_SECONDS * 1000):
                    last_entry = coin_data["orders"][-1]["entryPrice"]
                    if curr_price < (last_entry * (1.0 - DIP_THRESHOLD_PCT)):
                        should_buy = True

                if should_buy:
                    # Random integer between $200 and $600 (no cents)
                    max_affordable = min(600, int(state["cash"]))
                    if max_affordable >= 200:
                        entry_size = float(random.randint(200, max_affordable))
                    else:
                        entry_size = float(int(state["cash"]))

                    fee = entry_size * BYBIT_FEE_RATE
                    usable = entry_size - fee
                    qty = usable / curr_price
                    coin_data["orders"].append({
                        "id": int(current_time),
                        "entryPrice": curr_price,
                        "qty": qty,
                        "cost": entry_size,
                        "fee": fee
                    })
                    state["cash"] -= entry_size
                    coin_data["lastBuyTime"] = current_time
                    record_trade("BUY", coin, curr_price, round(qty, coin_data["decimals"]), round(entry_size, 2), None, f"Order #{len(coin_data['orders'])} (Fee: ${round(fee, 2)})")

            holding_total += sum(o["qty"] for o in coin_data["orders"]) * curr_price

        # Portfolio Balance Aggregates
        state["totalPortfolio"] = round(state["cash"] + holding_total, 2)
        net_pnl = state["totalPortfolio"] - state["initial_balance"]
        state["pnl"] = round(net_pnl, 2)
        state["pnlPercent"] = round((net_pnl / state["initial_balance"]) * 100, 2)
        save_state()

@app.on_event("startup")
def startup_event():
    load_state()

@app.get("/")
def read_root():
    return FileResponse("static/index.html")

@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return Response(status_code=204)

@app.get("/state")
def get_state():
    with state_lock:
        return state

@app.post("/tick")
async def receive_tick(request: Request):
    """Processes incoming prices and returns the latest state in a single round-trip."""
    try:
        body = await request.json()
        prices = body.get("prices", {})
        if prices:
            process_tick(prices)
        with state_lock:
            return JSONResponse(state)
    except Exception as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=400)
