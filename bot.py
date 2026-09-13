import os
import time
import threading
import requests
from datetime import datetime
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from supabase import create_client, Client

app = FastAPI()

# Mount frontend static files
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
def read_root():
    return FileResponse("static/index.html")

# Initialize Supabase client
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")
supabase: Client = None

if SUPABASE_URL and SUPABASE_KEY:
    try:
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
        print("Connected successfully to Supabase.")
    except Exception as e:
        print(f"Supabase connection error: {e}")

# Portfolio State
portfolio = {
    "cash": 5000.0,
    "positions": {
        "BTC": {"qty": 0.0, "entries": []},
        "ETH": {"qty": 0.0, "entries": []},
        "SOL": {"qty": 0.0, "entries": []},
        "CORE": {"qty": 0.0, "entries": []},
        "MNT": {"qty": 0.0, "entries": []},
        "PAXG": {"qty": 0.0, "entries": []}
    },
    "trades": [],
    "prices": {
        "BTC": 0.0, "ETH": 0.0, "SOL": 0.0, 
        "CORE": 0.0, "MNT": 0.0, "PAXG": 0.0
    },
    "history": {
        "BTC": [], "ETH": [], "SOL": [],
        "CORE": [], "MNT": [], "PAXG": []
    }
}

BYBIT_SYMBOLS = {
    "BTC": "BTCUSDT",
    "ETH": "ETHUSDT",
    "SOL": "SOLUSDT",
    "CORE": "COREUSDT",
    "MNT": "MNTUSDT",
    "PAXG": "PAXGUSDT"
}

# Fetch historical trades from Supabase on startup
def load_trades_from_db():
    if not supabase:
        return
    try:
        response = supabase.table("trades").select("*").order("id", desc=True).limit(50).execute()
        if response.data:
            portfolio["trades"] = response.data
            print(f"Loaded {len(response.data)} trades from Supabase.")
    except Exception as e:
        print(f"Error fetching trades from Supabase: {e}")

# Save an execution directly to Supabase
def log_trade_to_db(trade):
    if not supabase:
        return
    try:
        db_payload = {
            "time": trade["time"],
            "type": trade["type"],
            "asset": trade["asset"],
            "price": float(trade["price"]),
            "quantity": float(trade["quantity"]),
            "total_value": float(trade["total_value"]),
            "pnl": float(trade["pnl"]) if trade.get("pnl") is not None else None,
            "note": str(trade.get("note", ""))
        }
        supabase.table("trades").insert(db_payload).execute()
    except Exception as e:
        print(f"Error logging trade to Supabase: {e}")

def fetch_prices():
    try:
        url = "https://api.bybit.com/v5/market/tickers?category=spot"
        res = requests.get(url, timeout=5).json()
        ticker_list = res.get("result", {}).get("list", [])
        price_lookup = {item["symbol"]: float(item["lastPrice"]) for item in ticker_list if "symbol" in item}
        
        for asset, ticker in BYBIT_SYMBOLS.items():
            if ticker in price_lookup:
                price = price_lookup[ticker]
                portfolio["prices"][asset] = price
                portfolio["history"][asset].append(price)
                if len(portfolio["history"][asset]) > 20:
                    portfolio["history"][asset].pop(0)
    except Exception as e:
        print(f"Bybit price fetch error: {e}")

def execute_buy(symbol, price, step_label, order_size=500.0):
    if portfolio["cash"] < order_size:
        return
    fee = round(order_size * 0.001, 2)
    net_val = order_size - fee
    qty = round(net_val / price, 4) if price < 100 else round(net_val / price, 6)

    portfolio["cash"] -= order_size
    portfolio["positions"][symbol]["qty"] += qty
    portfolio["positions"][symbol]["entries"].append({"price": price, "qty": qty})

    trade = {
        "time": datetime.utcnow().strftime("%H:%M:%S"),
        "type": "BUY",
        "asset": symbol,
        "price": price,
        "quantity": qty,
        "total_value": order_size,
        "pnl": None,
        "note": f"{step_label} (Fee: ${fee})"
    }
    portfolio["trades"].insert(0, trade)
    log_trade_to_db(trade)

def execute_sell(symbol, price, reason):
    pos = portfolio["positions"][symbol]
    if pos["qty"] <= 0 or not pos["entries"]:
        return

    qty = pos["qty"]
    gross_val = qty * price
    fee = round(gross_val * 0.001, 2)
    net_val = gross_val - fee

    total_cost = sum(e["price"] * e["qty"] for e in pos["entries"])
    pnl = round(net_val - total_cost, 2)

    portfolio["cash"] += net_val
    portfolio["positions"][symbol] = {"qty": 0.0, "entries": []}

    trade = {
        "time": datetime.utcnow().strftime("%H:%M:%S"),
        "type": "SELL",
        "asset": symbol,
        "price": price,
        "quantity": qty,
        "total_value": round(net_val, 2),
        "pnl": pnl,
        "note": f"{reason} (Fee: ${fee})"
    }
    portfolio["trades"].insert(0, trade)
    log_trade_to_db(trade)

def trading_worker():
    load_trades_from_db()
    while True:
        fetch_prices()
        for symbol, price in portfolio["prices"].items():
            if price <= 0:
                continue

            pos = portfolio["positions"][symbol]
            entries = pos["entries"]

            # Initial entry
            if len(entries) == 0:
                execute_buy(symbol, price, "Order #1")
            else:
                last_entry_price = entries[-1]["price"]
                # Dip buy up to 3 grid orders
                if len(entries) < 3 and price < (last_entry_price * 0.998):
                    execute_buy(symbol, price, f"Order #{len(entries) + 1}")

                # Take Profit / Stop Loss check
                avg_cost = sum(e["price"] * e["qty"] for e in entries) / pos["qty"]
                if price >= avg_cost * 1.0065:
                    execute_sell(symbol, price, "Take Profit (+0.65%)")
                elif price <= avg_cost * 0.9965:
                    execute_sell(symbol, price, "Stop Loss (-0.35%)")

        time.sleep(30)

@app.on_event("startup")
def start_bot():
    thread = threading.Thread(target=trading_worker, daemon=True)
    thread.start()

@app.get("/state")
def get_state():
    total_assets_val = sum(
        portfolio["positions"][s]["qty"] * portfolio["prices"][s]
        for s in portfolio["positions"]
    )
    total_val = round(portfolio["cash"] + total_assets_val, 2)
    total_pnl = round(total_val - 5000.0, 2)
    pnl_pct = round((total_pnl / 5000.0) * 100, 2)

    return {
        "total_portfolio": total_val,
        "available_cash": round(portfolio["cash"], 2),
        "total_pnl": total_pnl,
        "pnl_percentage": pnl_pct,
        "prices": portfolio["prices"],
        "history": portfolio["history"],
        "holdings": {
            s: {
                "qty": portfolio["positions"][s]["qty"],
                "orders": len(portfolio["positions"][s]["entries"])
            }
            for s in portfolio["positions"]
        },
        "trades": portfolio["trades"][:50]
    }
