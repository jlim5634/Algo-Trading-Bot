import csv
from datetime import datetime
import numpy as np
from lumibot.brokers import Alpaca
from lumibot.backtesting import YahooDataBacktesting
from lumibot.strategies.strategy import Strategy

# -------------------------
# Alpaca API credentials
# -------------------------
API_KEY = ""
API_SECRET = ""

# -------------------------
# CSV logging setup
# -------------------------
csv_file = "trade_history.csv"
with open(csv_file, mode='w', newline='') as f:
    writer = csv.writer(f)
    writer.writerow(["Datetime", "Symbol", "Side", "Quantity", "Price", "Total", "P/L"])

def log_trade(symbol, side, qty, price, total, profit_loss=""):
    with open(csv_file, mode="a", newline='') as f:
        writer = csv.writer(f)
        writer.writerow([
            datetime.now(),
            symbol,
            side,
            qty,
            f"{price:.2f}",
            f"{total:.2f}",
            f"{profit_loss:.2f}" if profit_loss != "" else ""
        ])

# -------------------------
# Combined Strategy Class
# -------------------------
class CombinedFVGTrendStrategy(Strategy):
    def initialize(self, symbol="SPY", cash_at_risk=0.5, stop_loss_pct=0.02, 
                   max_drawdown_pct=0.1, trend_window=20):
        self.symbol = symbol
        self.cash_at_risk = cash_at_risk
        self.stop_loss_pct = stop_loss_pct
        self.max_drawdown_pct = max_drawdown_pct
        self.trend_window = trend_window
        
        self.sleeptime = "1D"  # Check daily
        self.previous_candles = []
        self.open_fvgs = []
        self.entry_price = None

    def position_sizing(self, price):
        cash = self.get_cash()
        qty = round((cash * self.cash_at_risk) / price, 0)
        return max(qty, 1)  # At least 1 share

    def on_trading_iteration(self):
        # Fetch historical data
        bars = self.get_historical_prices(self.symbol, 25, "day")
        if bars is None or bars.df.empty:
            return
        
        df = bars.df
        
        # Build candle data
        for i in range(len(df)):
            candle = {
                "high": df.iloc[i]["high"],
                "low": df.iloc[i]["low"],
                "close": df.iloc[i]["close"],
                "open": df.iloc[i]["open"]
            }
            if len(self.previous_candles) == 0 or \
               self.previous_candles[-1]["close"] != candle["close"]:
                self.previous_candles.append(candle)
        
        # Keep only recent candles
        if len(self.previous_candles) > self.trend_window + 5:
            self.previous_candles = self.previous_candles[-self.trend_window - 5:]
        
        if len(self.previous_candles) < 3:
            return
        
        # Detect FVG
        fvg = self.detect_fvg()
        if fvg:
            self.open_fvgs.append(fvg)
        
        # Check filled FVGs
        last_candle = self.previous_candles[-1]
        filled_fvgs = self.check_fvg_fill(last_candle)
        
        last_price = last_candle["close"]
        position = self.get_position(self.symbol)
        
        # Check max drawdown
        portfolio_value = self.get_portfolio_value()
        if position and hasattr(self, 'max_equity'):
            if portfolio_value < self.max_equity * (1 - self.max_drawdown_pct):
                print(f"[Risk] Max drawdown hit. Closing position.")
                self.sell_all()
                return
        
        # Stop loss
        if position and self.entry_price:
            if last_price <= self.entry_price * (1 - self.stop_loss_pct):
                print(f"[Risk] Stop loss at {last_price:.2f}")
                self.sell_all()
                self.entry_price = None
                return
        
        # Trading logic
        for filled in filled_fvgs:
            if filled["type"] == "bearish" and not position and self.in_uptrend():
                # Enter long
                qty = self.position_sizing(last_price)
                order = self.create_order(self.symbol, qty, "buy")
                self.submit_order(order)
                self.entry_price = last_price
                self.max_equity = portfolio_value
                log_trade(self.symbol, "BUY", qty, last_price, qty * last_price)
                print(f"[Trade] Enter LONG at {last_price:.2f}")
                
            elif filled["type"] == "bullish" and position:
                # Exit long
                self.sell_all()
                profit_loss = (last_price - self.entry_price) * position.quantity if self.entry_price else 0
                log_trade(self.symbol, "SELL", position.quantity, last_price, 
                         position.quantity * last_price, profit_loss)
                self.entry_price = None
                print(f"[Trade] Exit LONG at {last_price:.2f}")
    
    def detect_fvg(self):
        if len(self.previous_candles) < 2:
            return None
        prev = self.previous_candles[-2]
        curr = self.previous_candles[-1]
        
        if curr["low"] > prev["high"]:
            return {"type": "bullish", "low": prev["high"], "high": curr["low"]}
        if curr["high"] < prev["low"]:
            return {"type": "bearish", "low": curr["high"], "high": prev["low"]}
        return None
    
    def check_fvg_fill(self, candle):
        fills = []
        for fvg in self.open_fvgs[:]:
            if candle["high"] >= fvg["low"] and candle["low"] <= fvg["high"]:
                fills.append(fvg)
                self.open_fvgs.remove(fvg)
        return fills
    
    def in_uptrend(self):
        if len(self.previous_candles) < self.trend_window:
            return False
        prices = [c["close"] for c in self.previous_candles[-self.trend_window:]]
        ma = np.mean(prices)
        return self.previous_candles[-1]["close"] > ma

    def on_trading_iteration(self, price_data=None):
        if price_data is None:
            return

        # Update prices and candles
        self.prices.append(price_data["close"])
        self.previous_candles.append(price_data)
        if len(self.previous_candles) > 3:
            self.previous_candles.pop(0)

        # Detect and track FVG
        fvg = self.detect_fvg()
        if fvg:
            self.open_fvgs.append(fvg)

        # Check for filled FVGs
        filled_fvgs = self.check_fvg_fill(price_data)
        last_price = price_data["close"]
        qty = self.position_sizing(last_price)

        # Check max drawdown
        if self.position and self.current_equity < self.max_equity * (1 - self.max_drawdown_pct):
            print("[Risk] Max drawdown hit. Closing position.")
            self.close_position(last_price, qty)
            return

        # Stop loss for long position
        if self.position == "long":
            if last_price <= self.entry_price * (1 - self.stop_loss_pct):
                print(f"[Risk] Stop loss triggered at {last_price:.2f}. Closing position.")
                self.close_position(last_price, qty)
                return

        # Trading logic: enter/exit on FVG fill with trend filter
        for filled in filled_fvgs:
            if filled["type"] == "bearish" and self.position != "long" and self.in_uptrend():
                # Enter long
                total_cost = qty * last_price
                log_trade(self.symbol, "BUY", qty, last_price, total_cost)
                self.position = "long"
                self.entry_price = last_price
                self.max_equity = max(self.current_equity, self.max_equity)
                print(f"[Trade] Enter LONG on bearish FVG fill at {last_price:.2f}")
            elif filled["type"] == "bullish" and self.position == "long":
                # Exit long
                proceeds = qty * last_price
                profit_loss = proceeds - (self.entry_price * qty)
                log_trade(self.symbol, "SELL", qty, last_price, proceeds, profit_loss)
                self.position = None
                self.entry_price = None
                self.current_equity += profit_loss
                print(f"[Trade] Exit LONG on bullish FVG fill at {last_price:.2f} | P/L: {profit_loss:.2f}")

    def close_position(self, price, qty):
        if self.position == "long":
            proceeds = qty * price
            profit_loss = proceeds - (self.entry_price * qty)
            log_trade(self.symbol, "SELL", qty, price, proceeds, profit_loss)
            self.position = None
            self.entry_price = None
            self.current_equity += profit_loss
            print(f"[Trade] Position closed at {price:.2f} | P/L: {profit_loss:.2f}")

# -------------------------
# Backtesting example
# -------------------------
if __name__ == "__main__":
    start_date = datetime(2023, 1, 1)
    end_date = datetime(2023, 4, 20)

    broker_creds = {
        "API_KEY": API_KEY,
        "API_SECRET": API_SECRET,
        "PAPER": True
    }

    broker = Alpaca(broker_creds)
    strategy = CombinedFVGTrendStrategy(
        name="combined_fvg_trend",
        broker=broker,
        parameters={
            "symbol": "SPY",
            "cash_at_risk": 0.5,
            "stop_loss_pct": 0.02,
            "max_drawdown_pct": 0.1,
            "trend_window": 20
        }
    )

    strategy.backtest(
        YahooDataBacktesting,
        start_date,
        end_date,
        parameters={"symbol": "SPY"}
    )
