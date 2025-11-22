import csv
import os
from dotenv import load_dotenv
from datetime import datetime
import numpy as np
from lumibot.brokers import Alpaca
from lumibot.backtesting import YahooDataBacktesting
from lumibot.strategies.strategy import Strategy
from lumibot.traders import Trader #exectues trading strat


# -------------------------
# Alpaca API credentials
# -------------------------
load_dotenv()

API_KEY = os.getenv("ALPACA_API_KEY")
API_SECRET = os.getenv("ALPACA_API_SECRET")

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
# Combined Strategy Class - TRACKS FVGs ACROSS MULTIPLE CANDLES
# -------------------------
class CombinedFVGTrendStrategy(Strategy):
    def initialize(self, symbol="SPY", cash_at_risk=0.5, stop_loss_pct=0.02, 
                   max_drawdown_pct=0.1, trend_window=20, max_fvg_age=10):
        self.symbol = symbol
        self.cash_at_risk = cash_at_risk
        self.stop_loss_pct = stop_loss_pct
        self.max_drawdown_pct = max_drawdown_pct
        self.trend_window = trend_window
        self.max_fvg_age = max_fvg_age  # Max candles to track an FVG
        
        self.sleeptime = "1D"
        self.entry_price = None
        self.max_equity = None
        
        # Track open FVGs
        self.bullish_fvgs = []  # [{low, high, age}]
        self.bearish_fvgs = []  # [{low, high, age}]
        
        self.last_candles = []

    def position_sizing(self, price):
        cash = self.get_cash()
        qty = round((cash * self.cash_at_risk) / price, 0)
        return max(qty, 1)

    def on_trading_iteration(self):
        # Get data
        bars = self.get_historical_prices(self.symbol, self.trend_window + 10, "day")
        
        if bars is None or bars.df.empty or len(bars.df) < 3:
            return
        
        df = bars.df
        
        # Get last 3 candles
        candle_1 = df.iloc[-3]
        candle_2 = df.iloc[-2]
        candle_3 = df.iloc[-1]
        
        last_price = candle_3["close"]
        position = self.get_position(self.symbol)
        portfolio_value = self.get_portfolio_value()
        
        # Initialize max equity
        if self.max_equity is None:
            self.max_equity = portfolio_value
        
        # Risk management: Max drawdown
        if position and portfolio_value < self.max_equity * (1 - self.max_drawdown_pct):
            print(f"[Risk] Max drawdown hit. Closing position.")
            self.sell_all()
            self.entry_price = None
            return
        
        # Risk management: Stop loss
        if position and self.entry_price:
            if last_price <= self.entry_price * (1 - self.stop_loss_pct):
                print(f"[Risk] Stop loss triggered at ${last_price:.2f}")
                qty = position.quantity
                order = self.create_order(self.symbol, qty, "sell")
                self.submit_order(order)
                log_trade(self.symbol, "SELL", qty, last_price, 
                         qty * last_price, 
                         (last_price - self.entry_price) * qty)
                self.entry_price = None
                return
        
        # Check trend
        closes = df["close"].values
        if len(closes) < self.trend_window:
            return
        
        sma = np.mean(closes[-self.trend_window:])
        in_uptrend = last_price > sma
        
        # Detect NEW Bullish FVG (gap up)
        if candle_2["low"] > candle_1["high"]:
            gap_size = candle_2["low"] - candle_1["high"]
            if gap_size > 0.2:  # Minimum gap size filter
                fvg = {
                    "type": "bullish",
                    "low": candle_1["high"],
                    "high": candle_2["low"],
                    "age": 0
                }
                self.bullish_fvgs.append(fvg)
                print(f"✓ NEW Bullish FVG: ${fvg['low']:.2f} - ${fvg['high']:.2f} (gap: ${gap_size:.2f})")
        
        # Detect NEW Bearish FVG (gap down)
        if candle_2["high"] < candle_1["low"]:
            gap_size = candle_1["low"] - candle_2["high"]
            if gap_size > 0.5:  # Minimum gap size filter
                fvg = {
                    "type": "bearish",
                    "low": candle_2["high"],
                    "high": candle_1["low"],
                    "age": 0
                }
                self.bearish_fvgs.append(fvg)
                print(f"✓ NEW Bearish FVG: ${fvg['low']:.2f} - ${fvg['high']:.2f} (gap: ${gap_size:.2f})")
        
        # Check if current candle fills any BULLISH FVGs (for entry)
        if not position and in_uptrend:
            for fvg in self.bullish_fvgs[:]:
                # Check if price came back down into the gap
                if candle_3["low"] <= fvg["high"] and candle_3["high"] >= fvg["low"]:
                    # FVG filled - enter long
                    qty = self.position_sizing(last_price)
                    order = self.create_order(self.symbol, qty, "buy")
                    self.submit_order(order)
                    self.entry_price = last_price
                    self.max_equity = max(self.max_equity, portfolio_value)
                    log_trade(self.symbol, "BUY", qty, last_price, qty * last_price)
                    print(f"🚀 LONG ENTRY at ${last_price:.2f} - Bullish FVG filled!")
                    print(f"   FVG: ${fvg['low']:.2f} - ${fvg['high']:.2f}")
                    
                    # Remove filled FVG
                    self.bullish_fvgs.remove(fvg)
                    return
        
        # Check if current candle fills any BEARISH FVGs (for exit)
        if position:
            for fvg in self.bearish_fvgs[:]:
                # Check if price came back up into the gap
                if candle_3["high"] >= fvg["low"] and candle_3["low"] <= fvg["high"]:
                    # FVG filled - exit long
                    qty = position.quantity
                    order = self.create_order(self.symbol, qty, "sell")
                    self.submit_order(order)
                    profit_loss = (last_price - self.entry_price) * qty if self.entry_price else 0
                    log_trade(self.symbol, "SELL", qty, last_price, qty * last_price, profit_loss)
                    print(f"📤 LONG EXIT at ${last_price:.2f} - Bearish FVG filled!")
                    print(f"   FVG: ${fvg['low']:.2f} - ${fvg['high']:.2f}")
                    print(f"   P/L: ${profit_loss:.2f}")
                    self.entry_price = None
                    
                    # Remove filled FVG
                    self.bearish_fvgs.remove(fvg)
                    return
        
        # Age out old FVGs and remove those that are too old
        for fvg in self.bullish_fvgs[:]:
            fvg["age"] += 1
            if fvg["age"] > self.max_fvg_age:
                self.bullish_fvgs.remove(fvg)
        
        for fvg in self.bearish_fvgs[:]:
            fvg["age"] += 1
            if fvg["age"] > self.max_fvg_age:
                self.bearish_fvgs.remove(fvg)
        
        # Print status
        if len(self.bullish_fvgs) > 0 or len(self.bearish_fvgs) > 0:
            print(f"📊 Tracking {len(self.bullish_fvgs)} bullish FVGs, {len(self.bearish_fvgs)} bearish FVGs")

# -------------------------
# Backtesting
# -------------------------
if __name__ == "__main__":
    start_date = datetime(2020, 1, 1)
    end_date = datetime(2025, 4, 20)

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
            "cash_at_risk": 0.8,
            "stop_loss_pct": 0.03,
            "max_drawdown_pct": 0.4,
            "trend_window": 30,
            "max_fvg_age": 20  # Track FVGs for up to 10 candles
        }
    )

    print("\n" + "="*60)
    print("STARTING BACKTEST - FVG TRACKING MODE")
    print("="*60)

    trader = Trader()
    trader.add_strategy(strategy)
    trader.run_all()
    
    # strategy.backtest(
    #     YahooDataBacktesting,
    #     start_date,
    #     end_date,
    #     parameters={"symbol": "SPY"}
    # )