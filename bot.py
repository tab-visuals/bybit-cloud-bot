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

app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
def read_root():
    return FileResponse("static/index.html")

# Initialize Supabase
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")
supabase: Client = None

if SUPABASE_URL and SUPABASE_KEY:
    try:
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
        print("Connected successfully to Supabase.")
    except Exception as e:
        print(f"Supabase connection error: {e}")

TARGET_ASSETS = ["BTC", "ETH", "SOL", "CORE", "MNT", "XAUT"]

portfolio = {
    "cash": 5000.0,
    "positions": {s: {"qty": 0.0, "entries": []} for s in TARGET_ASSETS},
    "trades": [],
    "prices": {
        "BTC": 60000.0,
        "ETH": 2400.0,
        "SOL": 135.0,
        "CORE": 0.95,
        "MNT": 0.60,
        "XAUT": 2500.0
    },
    "history": {s: [] for s in TARGET_ASSETS}
}

def load_trades_from_db():
    if not supabase:
        return
    try:
        response = supabase.table("trades").select("*").order("id", desc=True).limit(50).execute()
        if response.data:
            portfolio["trades"] = response.data
    except Exception as e:
        print(f"Supabase load error: {e}")

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
        print(f"Supabase log error: {e}")

def fetch_prices():
    # 1. Fetch majors from Binance
    try:
        res = requests.get("https://api.binance.com/api/v3/ticker/price", timeout=5).json()
        lookup = {item["symbol"]: float(item["price"]) for item in res if "symbol" in item}
        if "BTCUSDT" in lookup:
            portfolio["prices"]["BTC"] = lookup["BTCUSDT"]
        if "ETHUSDT" in lookup:
            portfolio["prices"]["ETH"] = lookup["ETHUSDT"]
        if "SOLUSDT" in lookup:
            portfolio["prices"]["SOL"] = lookup["SOLUSDT"]
        if "PAXGUSDT" in lookup:
            portfolio["prices"]["XAUT"] = lookup["PAXGUSDT"]
    except Exception as e:
        print(f"Binance fetch error: {e}")

    # 2. Fetch CORE and MNT fallback from public CoinCap API
    try:
        cc_res = requests.get("https://api.coincap.io/v2/assets?ids=core-dao,mantle", timeout=5).json()
        for item in cc_res.get("data", []):
            if item["id"] == "core-dao":
                portfolio["prices"]["CORE"] = round(float(item["priceUsd"]), 4)
            elif item["id"] == "mantle":
                portfolio["prices"]["MNT"] = round(float(item["priceUsd"]), 4)
    except Exception:
        pass

    for asset in TARGET_ASSETS:
        price = portfolio["prices"][asset]
        portfolio["history"][asset].append(price)
        if len(portfolio["history"][asset]) > 20:
            portfolio["history"][asset].pop(0)

def execute_buy(symbol, price, step_label, order_size=500.0):
    if portfolio["cash"] < order_size or price <= 0:
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
    if pos["qty"] <= 0 or not pos["entries"] or price <= 0:
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

            if len(entries) == 0:
                execute_buy(symbol, price, "Order #1")
            else:
                last_entry_price = entries[-1]["price"]
                if len(entries) < 3 and price < (last_entry_price * 0.998):
                    execute_buy(symbol, price, f"Order #{len(entries) + 1}")

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
        portfolio["positions"][s]["qty"] * (portfolio["prices"].get(s, 0.0) or 0.0)
        for s in TARGET_ASSETS
    )
    cash = float(portfolio["cash"] if portfolio["cash"] is not None else 5000.0)
    total_val = round(cash + total_assets_val, 2)
    total_pnl = round(total_val - 5000.0, 2)
    pnl_pct = round((total_pnl / 5000.0) * 100, 2)

    return {
        "total_portfolio": total_val,
        "available_cash": round(cash, 2),
        "total_pnl": total_pnl,
        "pnl_percentage": pnl_pct,
        "prices": portfolio["prices"],
        "history": portfolio["history"],
        "holdings": {
            s: {
                "qty": round(portfolio["positions"][s]["qty"], 6),
                "orders": len(portfolio["positions"][s]["entries"])
            }
            for s in TARGET_ASSETS
        },
        "trades": portfolio["trades"][:50]
    }
