import csv
import os
from dotenv import load_dotenv
from datetime import datetime #for dates and times 
import numpy as np #for numerical computations
from lumibot.brokers import Alpaca #to connect to Alpaca trading plat
from lumibot.strategies.strategy import Strategy #base strat class to create custom trading strat
from lumibot.traders import Trader #exectues trading strat
import threading #threading module to run code concurrently (timed user input)
import time

load_dotenv() #load API keys

API_KEY = os.getenv("ALPACA_API_KEY") #.osgetenv() safely gets env variables without errors if they don't exist
API_SECRET = os.getenv("ALPACA_API_SECRET")

csv_file = "trade_history.csv" 

#Writing down title for CSV
if not os.path.exists(csv_file): #checks if it doesn't exist yet
    with open(csv_file, mode='w', newline='') as f: #opens in writing mode and f creates a file object named f
        writer = csv.writer(f) #writer that can write to f object/file
        writer.writerow(["Datetime", "Symbol", "Side", "Quantity", "Price", "Total", "P/L"]) #writerow() writes single list as one row

#Write down trade log into CSV
def log_trade(symbol, side, qty, price, total, profit_loss=""): #params and profit_loss defaults to empty string if not provied
    with open(csv_file, mode="a", newline='') as f: #appends to file
        writer = csv.writer(f)
        writer.writerow([
            datetime.now(),
            symbol,
            side,
            qty,
            f"{price:.2f}",
            f"{total:.2f}",
            f"{profit_loss:.2f}" if profit_loss != "" else "" # if profit_loss available round to 2 decimal, if not leave empty (ternerary)
        ])

def get_user_confirmation(prompt, timeout=30): #gets user input with time limit (default 30s)
    print(f"\n{'='*60}") 
    print(prompt) #prints message passed into function
    print(f"{'='*60}")
    
    result = {"confirmed": False, "answered": False} #dict to track what user responded
    
    def get_input(): 
        try:
            response = input("Enter your choice (y/n): ").strip().lower() #get user input
            result["answered"] = True #sets "answered" key in dict to True
            result["confirmed"] = response in ['y', 'yes'] #checks if response is y or yes and stores True/False. "in" checks if its in the list
        except: #catches errors. if it does occur, mark as answered by not confirmed
            result["answered"] = True 
            result["confirmed"] = False
    
    input_thread = threading.Thread(target=get_input, daemon=True) #creates new thread that will run get_input() function. deamon=True will automatically stop when program ends
    input_thread.start() #starts thread
    input_thread.join(timeout=timeout) #waits for thread to finish for timeout seconds. join() pauses the main program until thread completes or timeout expires
    
    if not result["answered"]: #checks if they didn't respond in timeout period
        print(f"\n⏱️  No response within {timeout} seconds. Defaulting to NO.") 
        return False #declines trade
    
    return result["confirmed"] #return what user chose (True if yes, False if no)

#Main strat class that gets manual confirmation
class CombinedFVGTrendStrategy(Strategy): #inherits from Strategy base class
    def initialize(self, symbol="SPY", cash_at_risk=0.5, stop_loss_pct=0.02, 
                   max_drawdown_pct=0.1, trend_window=20, max_fvg_age=10,
                   require_entry_confirmation=True, require_exit_confirmation=True,
                   auto_continue_after_exit=False):#trend_window looks at last 20 periods
        self.symbol = symbol #stores all in instance variable to use throughout class
        self.cash_at_risk = cash_at_risk
        self.stop_loss_pct = stop_loss_pct
        self.max_drawdown_pct = max_drawdown_pct
        self.trend_window = trend_window
        self.max_fvg_age = max_fvg_age
        
        # Manual control settings
        self.require_entry_confirmation = require_entry_confirmation
        self.require_exit_confirmation = require_exit_confirmation
        self.auto_continue_after_exit = auto_continue_after_exit
        self.trading_enabled = True  # Master switch
        
        self.sleeptime = "5M"
        self.entry_price = None
        self.max_equity = None
        
        # lists to track bull/bear fvgs
        self.bullish_fvgs = [] 
        self.bearish_fvgs = []
        
        self.last_candles = [] #list for previous candles
        self.pending_entry_signal = None
        self.pending_exit_signal = None

    def position_sizing(self, price):
        cash = self.get_cash() #get current cash from account
        qty = round((cash * self.cash_at_risk) / price, 0) #quantity to trade
        return max(qty, 1)

    def on_trading_iteration(self):
        # Check if trading is enabled
        if not self.trading_enabled:
            print("⏸️  Trading is paused. Waiting for user to re-enable...")
            return
        
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
        
        # Risk management: Max drawdown (EMERGENCY EXIT - no confirmation needed)
        if position and portfolio_value < self.max_equity * (1 - self.max_drawdown_pct):
            print(f"\n🚨 EMERGENCY: Max drawdown hit! Closing position immediately.")
            self.sell_all()
            self.entry_price = None
            self.trading_enabled = False
            print("⏸️  Trading disabled. Restart the bot to re-enable.")
            return
        
        # Risk management: Stop loss (EMERGENCY EXIT - no confirmation needed)
        if position and self.entry_price:
            if last_price <= self.entry_price * (1 - self.stop_loss_pct):
                print(f"\n🚨 STOP LOSS TRIGGERED at ${last_price:.2f}")
                qty = position.quantity
                order = self.create_order(self.symbol, qty, "sell")
                self.submit_order(order)
                log_trade(self.symbol, "SELL", qty, last_price, 
                         qty * last_price, 
                         (last_price - self.entry_price) * qty)
                self.entry_price = None
                
                # Ask if user wants to continue trading
                if not self.auto_continue_after_exit:
                    continue_trading = get_user_confirmation(
                        "Stop loss hit. Do you want to continue looking for new trades? (y/n)",
                        timeout=60
                    )
                    self.trading_enabled = continue_trading
                    if not continue_trading:
                        print("⏸️  Trading paused. Restart the bot to re-enable.")
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
            if gap_size > 0.2:
                fvg = {
                    "type": "bullish",
                    "low": candle_1["high"],
                    "high": candle_2["low"],
                    "age": 0
                }
                self.bullish_fvgs.append(fvg)
                print(f"\n✓ NEW Bullish FVG detected:")
                print(f"   Range: ${fvg['low']:.2f} - ${fvg['high']:.2f}")
                print(f"   Gap size: ${gap_size:.2f}")
        
        # Detect NEW Bearish FVG (gap down)
        if candle_2["high"] < candle_1["low"]:
            gap_size = candle_1["low"] - candle_2["high"]
            if gap_size > 0.5:
                fvg = {
                    "type": "bearish",
                    "low": candle_2["high"],
                    "high": candle_1["low"],
                    "age": 0
                }
                self.bearish_fvgs.append(fvg)
                print(f"\n✓ NEW Bearish FVG detected:")
                print(f"   Range: ${fvg['low']:.2f} - ${fvg['high']:.2f}")
                print(f"   Gap size: ${gap_size:.2f}")
        
        # Check if current candle fills any BULLISH FVGs (for ENTRY)
        if not position and in_uptrend:
            for fvg in self.bullish_fvgs[:]:
                if candle_3["low"] <= fvg["high"] and candle_3["high"] >= fvg["low"]:
                    # FVG filled - potential entry signal
                    qty = self.position_sizing(last_price)
                    
                    print(f"\n🎯 ENTRY SIGNAL DETECTED!")
                    print(f"   Symbol: {self.symbol}")
                    print(f"   Current Price: ${last_price:.2f}")
                    print(f"   FVG Range: ${fvg['low']:.2f} - ${fvg['high']:.2f}")
                    print(f"   Trend: {'✅ UPTREND' if in_uptrend else '❌ DOWNTREND'}")
                    print(f"   Proposed Quantity: {qty} shares")
                    print(f"   Total Investment: ${qty * last_price:.2f}")
                    print(f"   Stop Loss: ${last_price * (1 - self.stop_loss_pct):.2f} (-{self.stop_loss_pct*100}%)")
                    
                    # Ask for confirmation if required
                    if self.require_entry_confirmation:
                        confirmed = get_user_confirmation(
                            f"🚀 Do you want to ENTER this trade? (y/n)",
                            timeout=60
                        )
                        if not confirmed:
                            print("❌ Entry declined by user.")
                            self.bullish_fvgs.remove(fvg)
                            continue
                    
                    # Execute entry
                    order = self.create_order(self.symbol, qty, "buy")
                    self.submit_order(order)
                    self.entry_price = last_price
                    self.max_equity = max(self.max_equity, portfolio_value)
                    log_trade(self.symbol, "BUY", qty, last_price, qty * last_price)
                    
                    print(f"\n✅ LONG ENTRY EXECUTED at ${last_price:.2f}")
                    print(f"   Quantity: {qty} shares")
                    print(f"   Total: ${qty * last_price:.2f}")
                    
                    self.bullish_fvgs.remove(fvg)
                    return
        
        # Check if current candle fills any BEARISH FVGs (for EXIT)
        if position:
            for fvg in self.bearish_fvgs[:]:
                if candle_3["high"] >= fvg["low"] and candle_3["low"] <= fvg["high"]:
                    # FVG filled - potential exit signal
                    qty = position.quantity
                    profit_loss = (last_price - self.entry_price) * qty if self.entry_price else 0
                    profit_pct = ((last_price - self.entry_price) / self.entry_price * 100) if self.entry_price else 0
                    
                    print(f"\n📤 EXIT SIGNAL DETECTED!")
                    print(f"   Symbol: {self.symbol}")
                    print(f"   Current Price: ${last_price:.2f}")
                    print(f"   Entry Price: ${self.entry_price:.2f}")
                    print(f"   FVG Range: ${fvg['low']:.2f} - ${fvg['high']:.2f}")
                    print(f"   Quantity: {qty} shares")
                    print(f"   P/L: ${profit_loss:.2f} ({profit_pct:+.2f}%)")
                    
                    # Ask for confirmation if required
                    if self.require_exit_confirmation:
                        confirmed = get_user_confirmation(
                            f"📤 Do you want to EXIT this trade? (y/n)",
                            timeout=60
                        )
                        if not confirmed:
                            print("❌ Exit declined by user.")
                            self.bearish_fvgs.remove(fvg)
                            continue
                    
                    # Execute exit
                    order = self.create_order(self.symbol, qty, "sell")
                    self.submit_order(order)
                    log_trade(self.symbol, "SELL", qty, last_price, qty * last_price, profit_loss)
                    
                    print(f"\n✅ LONG EXIT EXECUTED at ${last_price:.2f}")
                    print(f"   P/L: ${profit_loss:.2f} ({profit_pct:+.2f}%)")
                    
                    self.entry_price = None
                    self.bearish_fvgs.remove(fvg)
                    
                    # Ask if user wants to continue trading after exit
                    if not self.auto_continue_after_exit:
                        continue_trading = get_user_confirmation(
                            "Trade closed. Do you want to continue looking for new trades? (y/n)",
                            timeout=60
                        )
                        self.trading_enabled = continue_trading
                        if not continue_trading:
                            print("⏸️  Trading paused. Restart the bot to re-enable.")
                    
                    return
        
        # Age out old FVGs
        for fvg in self.bullish_fvgs[:]:
            fvg["age"] += 1
            if fvg["age"] > self.max_fvg_age:
                self.bullish_fvgs.remove(fvg)
        
        for fvg in self.bearish_fvgs[:]:
            fvg["age"] += 1
            if fvg["age"] > self.max_fvg_age:
                self.bearish_fvgs.remove(fvg)

# -------------------------
# LIVE TRADING with Manual Control
# -------------------------
if __name__ == "__main__":
    broker_creds = {
        "API_KEY": API_KEY,
        "API_SECRET": API_SECRET,
        "PAPER": True  # Set to False for real money
    }

    broker = Alpaca(broker_creds)
    
    strategy = CombinedFVGTrendStrategy(
        name="manual_fvg_trend",
        broker=broker,
        parameters={
            "symbol": "SPY",
            "cash_at_risk": 0.5,
            "stop_loss_pct": 0.03,
            "max_drawdown_pct": 0.15,
            "trend_window": 30,
            "max_fvg_age": 20,
            
            # Manual control settings
            "require_entry_confirmation": True,   # Ask before entering
            "require_exit_confirmation": True,    # Ask before exiting
            "auto_continue_after_exit": False     # Ask if continue after exit
        }
    )

    print("\n" + "="*60)
    print("LIVE TRADING - MANUAL CONFIRMATION MODE")
    print("="*60)
    print("Paper Trading:", broker_creds["PAPER"])
    print("Entry Confirmation: REQUIRED")
    print("Exit Confirmation: REQUIRED")
    print("Auto-continue after exit: DISABLED")
    print("="*60)
    print("\n⚠️  You will be asked to confirm each trade.")
    print("⚠️  After exits, you'll choose whether to continue trading.")
    print("⚠️  Stop losses and max drawdown will execute immediately.\n")
    print("Press Ctrl+C to stop the bot\n")
    
    trader = Trader()
    trader.add_strategy(strategy)
    trader.run_all()