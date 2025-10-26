import csv
from datetime import datetime, time, timedelta
import numpy as np
import asyncio
from alpaca.trading.client import TradingClient
from alpaca.trading.requests import MarketOrderRequest, GetOrdersRequest
from alpaca.trading.enums import OrderSide, TimeInForce
from alpaca.trading.stream import TradingStream
from alpaca.data.requests import StockBarsRequest
from alpaca.data.timeframe import TimeFrame
from alpaca.data.historical import StockHistoricalDataClient



# -------------------------
# Alpaca API credentials
# -------------------------
API_KEY = ""
API_SECRET = ""

# -------------------------
# Market hours check
# -------------------------
now = datetime.now()
current_time = now.time()
formatted_time = current_time.strftime("%H:%M")
current_day = now.strftime("%A")

market_open = time(6, 30)
market_close = time(13, 0)

if current_time < market_open or current_time > market_close or current_day in ["Saturday", "Sunday"]:
    print("\nMarket is closed. Can only trade from 6:30 - 13:00 , Mon-Fri")
    print(f"Current time and day is {formatted_time} {current_day}\n")
    quit()
else:
    print("Market is open, you can trade")

# -------------------------
# Connect to Alpaca
# -------------------------
api = TradingClient(API_KEY, API_SECRET, paper=True)
data_client = StockHistoricalDataClient(API_KEY, API_SECRET)

# Cancel any open orders
request_params = GetOrdersRequest(status="open", limit=50)
open_orders = api.get_orders(request_params)
for o in open_orders:
    api.cancel_order(o.id)
    print(f"Cancelled old order {o.id}")

# -------------------------
# CSV logging
# -------------------------
csv_file = "trade_history.csv"
with open(csv_file, mode='w', newline='') as f:
    writer = csv.writer(f)
    writer.writerow(["Datetime", "Symbol", "Side", "Quantity", "Price", "Total", "P/L"])

def log_trade(symbol, side, qty, price, total, profit_loss=None):
    with open(csv_file, mode="a", newline='') as f:
        writer = csv.writer(f)
        writer.writerow([datetime.now(), symbol, side, qty, f"{price:.2f}", f"{total:.2f}", f"{profit_loss:.2f}" if profit_loss is not None else ""])

# -------------------------
# Strategy parameters
# -------------------------
STOP_LOSS_PCT = 0.02
TREND_WINDOW = 20
CANDLE_HISTORY = 3  # number of past candles to track for FVG

# Trade tracking
trade_data = {"cost": None, "qty": None, "symbol": None, "entry_price": None, "position": None}
price_history = []
candles = []  # last few candles for FVG

# -------------------------
# Helper functions for FVG
# -------------------------
def detect_fvg():
    """Return list of open FVGs (bullish or bearish)"""
    if len(candles) < 2:
        return []
    prev = candles[-2]
    curr = candles[-1]
    fvgs = []

    # Bullish FVG: current high < previous low
    if curr["high"] < prev["low"]:
        fvgs.append({"type": "bullish", "low": curr["high"], "high": prev["low"]})

    # Bearish FVG: current low > previous high
    if curr["low"] > prev["high"]:
        fvgs.append({"type": "bearish", "low": prev["high"], "high": curr["low"]})

    return fvgs

def fvg_filled(fvg, candle):
    """Return True if candle fills the FVG"""
    return candle["low"] <= fvg["high"] and candle["high"] >= fvg["low"]

def in_uptrend():
    if len(price_history) < TREND_WINDOW:
        return False
    return price_history[-1] > np.mean(price_history[-TREND_WINDOW:])

def position_sizing(price):
    # Example: fixed qty of 1 for simplicity; can adapt to cash at risk
    return 1

# -------------------------
# Submit initial BUY order (optional)
# -------------------------
# buy_order_data = MarketOrderRequest(
#     symbol="SPY",
#     qty=1,
#     side=OrderSide.BUY,
#     time_in_force=TimeInForce.GTC
# )
# buy_order = api.submit_order(buy_order_data)

# -------------------------
# Event handler for order updates
# -------------------------
async def on_order_update(data):
    global trade_data
    order = data.order
    print(f"🔔 Order update: {data.event} | ID: {order.id} | Status: {order.status}")

    if order.status == "filled" and order.side == "buy":
        total_cost = float(order.qty) * float(order.filled_avg_price)
        trade_data.update({
            "cost": total_cost,
            "qty": float(order.qty),
            "symbol": order.symbol,
            "entry_price": float(order.filled_avg_price),
            "position": "long"
        })
        log_trade(order.symbol, "BUY", order.qty, float(order.filled_avg_price), total_cost)
        print(f"✅ Buy filled: {order.qty} {order.symbol} at ${order.filled_avg_price}")

    elif order.status == "filled" and order.side == "sell":
        proceeds = float(order.qty) * float(order.filled_avg_price)
        profit_loss = 0
        if trade_data.get("cost"):
            profit_loss = proceeds - trade_data["cost"]
        log_trade(order.symbol, "SELL", order.qty, float(order.filled_avg_price), proceeds, profit_loss)
        print(f"✅ Sell filled: {order.qty} {order.symbol} at ${order.filled_avg_price} | P/L: {profit_loss:.2f}")
        trade_data.update({"position": None, "cost": None, "entry_price": None, "qty": None, "symbol": None})

# -------------------------
# Strategy monitoring loop
# -------------------------
from datetime import datetime, timedelta

async def monitor_strategy():
    global trade_data, price_history, candles

    while True:
        # --- Get the latest 1-minute bar for SPY ---
        now = datetime.utcnow()
        request_params = StockBarsRequest(
            symbol_or_symbols=["SPY"],
            timeframe=TimeFrame.Minute,
            start=now - timedelta(minutes=5),
            end=now
        )

        try:
            bars_response = await data_client.get_stock_bars(request_params)
            bars = bars_response.get("SPY", [])
        except Exception as e:
            print(f"[Error] Failed to fetch bars: {e}")
            await asyncio.sleep(10)
            continue

        if not bars:
            print("[Data] No bars returned, retrying...")
            await asyncio.sleep(10)
            continue

        last_bar = bars[-1]
        candle = {
            "open": float(last_bar.open),
            "high": float(last_bar.high),
            "low": float(last_bar.low),
            "close": float(last_bar.close)
        }

        candles.append(candle)
        if len(candles) > CANDLE_HISTORY:
            candles.pop(0)

        price_history.append(candle["close"])
        if len(price_history) > TREND_WINDOW:
            price_history.pop(0)

        # --- Stop Loss Check ---
        if trade_data.get("position") == "long" and candle["close"] <= trade_data["entry_price"] * (1 - STOP_LOSS_PCT):
            sell_order_data = MarketOrderRequest(
                symbol=trade_data["symbol"],
                qty=trade_data["qty"],
                side=OrderSide.SELL,
                time_in_force=TimeInForce.GTC
            )
            api.submit_order(sell_order_data)
            print(f"[Strategy] Stop loss triggered. Selling {trade_data['qty']} {trade_data['symbol']}")
            await asyncio.sleep(60)
            continue

        # --- FVG Detection ---
        fvgs = detect_fvg()
        for fvg in fvgs:
            if fvg["type"] == "bearish" and trade_data.get("position") != "long" and in_uptrend():
                # Enter long
                qty = position_sizing(candle["close"])
                buy_order_data = MarketOrderRequest(
                    symbol="SPY",
                    qty=qty,
                    side=OrderSide.BUY,
                    time_in_force=TimeInForce.GTC
                )
                api.submit_order(buy_order_data)
                print(f"[Strategy] Bearish FVG filled. Buying {qty} SPY")
                await asyncio.sleep(60)
            elif fvg["type"] == "bullish" and trade_data.get("position") == "long":
                # Exit long
                sell_order_data = MarketOrderRequest(
                    symbol=trade_data["symbol"],
                    qty=trade_data["qty"],
                    side=OrderSide.SELL,
                    time_in_force=TimeInForce.GTC
                )
                api.submit_order(sell_order_data)
                print(f"[Strategy] Bullish FVG filled. Selling {trade_data['qty']} {trade_data['symbol']}")
                await asyncio.sleep(60)

        await asyncio.sleep(10)


# -------------------------
# Run stream + monitoring
# -------------------------
stream = TradingStream(API_KEY, API_SECRET, paper=True)
stream.subscribe_trade_updates(on_order_update)

async def main():
    await asyncio.gather(
        stream._run_forever(),
        monitor_strategy()
    )

asyncio.run(main())
