# trading_with_fvg.py
# Fixed version - removed test data, added FVG candle position tracking

import csv
import os
from dotenv import load_dotenv
from datetime import datetime
import numpy as np
from lumibot.brokers import Alpaca
from lumibot.strategies.strategy import Strategy
from lumibot.traders import Trader
import threading
import time
import asyncio
import websockets
import json
from queue import Queue

load_dotenv()

API_KEY = os.getenv("ALPACA_API_KEY")
API_SECRET = os.getenv("ALPACA_API_SECRET")

csv_file = "trade_history.csv"

if not os.path.exists(csv_file):
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

class TradingWebSocketServer:
    def __init__(self, host='localhost', port=8765):
        self.host = host
        self.port = port
        self.clients = set()
        self.message_queue = Queue()
        self.loop = None
        self.server = None

    async def register(self, websocket):
        self.clients.add(websocket)
        print(f"✅ Web client connected. Total: {len(self.clients)}")

    async def unregister(self, websocket):
        self.clients.remove(websocket)
        print(f"❌ Web client disconnected. Total: {len(self.clients)}")

    async def send_to_all(self, message):
        if self.clients:
            if isinstance(message, dict):
                message = json.dumps(message)
            await asyncio.gather(
                *[client.send(message) for client in self.clients],
                return_exceptions=True
            )

    async def handle_message(self, websocket, message):
        try:
            data = json.loads(message)
            print(f"📩 Received: {data.get('type')}")
            self.message_queue.put(data)
        except Exception as e:
            print(f"❌ Error parsing or queueing message: {e}")

    async def handle_client(self, websocket):
        await self.register(websocket)
        try:
            async for message in websocket:
                await self.handle_message(websocket, message)
        except websockets.exceptions.ConnectionClosed:
            pass
        except Exception as e:
            print(f"❌ Client handler error: {e}")
        finally:
            await self.unregister(websocket)

    async def start_server(self):
        self.server = await websockets.serve(
            self.handle_client,
            self.host,
            self.port
        )
        print(f"🚀 WebSocket server running on ws://{self.host}:{self.port}")
        await asyncio.Future()

    def run_in_thread(self):
        def run_server():
            self.loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self.loop)
            try:
                self.loop.run_until_complete(self.start_server())
            except Exception as e:
                print(f"❌ WebSocket server error: {e}")

        thread = threading.Thread(target=run_server, daemon=True)
        thread.start()
        print("✅ WebSocket thread started")
        return thread

    def broadcast(self, msg_type, payload):
        if self.loop and self.clients:
            try:
                asyncio.run_coroutine_threadsafe(
                    self.send_to_all({'type': msg_type, 'payload': payload}),
                    self.loop
                )
            except Exception as e:
                print(f"⚠️ Broadcast error: {e}")

    def get_message(self, timeout=None):
        try:
            return self.message_queue.get(timeout=timeout)
        except:
            return None

class CombinedFVGTrendStrategy(Strategy):
    def initialize(self, symbol="SPY", cash_at_risk=0.5, stop_loss_pct=0.02,
                   max_drawdown_pct=0.1, trend_window=20, max_fvg_age=10,
                   require_entry_confirmation=True, require_exit_confirmation=True,
                   auto_continue_after_exit=False, ws_server=None):
        self.symbol = symbol
        self.cash_at_risk = cash_at_risk
        self.stop_loss_pct = stop_loss_pct
        self.max_drawdown_pct = max_drawdown_pct
        self.trend_window = trend_window
        self.max_fvg_age = max_fvg_age
        self.require_entry_confirmation = require_entry_confirmation
        self.require_exit_confirmation = require_exit_confirmation
        self.auto_continue_after_exit = auto_continue_after_exit
        self.trading_enabled = True
        self.ws_server = ws_server
        self.sleeptime = "15M"
        self.entry_price = None
        self.max_equity = None
        
        # Updated FVG structure to include candle indices
        self.bullish_fvgs = []
        self.bearish_fvgs = []
        
        # Track candle counter for proper indexing
        self.candle_counter = 0

        print("✅ Strategy initialized with WebSocket support")

    def calculate_candle_metrics(self, candle):
        open_price = candle["open"]
        high = candle["high"]
        low = candle["low"]
        close = candle["close"]

        body_size = abs(close - open_price)
        body_direction = "bullish" if close > open_price else "bearish"
        body_top = max(close, open_price)
        body_bottom = min(close, open_price)
        upper_wick = high - body_top
        lower_wick = body_bottom - low
        total_range = high - low
        body_to_range_ratio = (body_size / total_range * 100) if total_range > 0 else 0

        return {
            "body_size": body_size,
            "body_direction": body_direction,
            "upper_wick": upper_wick,
            "lower_wick": lower_wick,
            "total_range": total_range,
            "body_to_range_ratio": body_to_range_ratio,
            "open": open_price,
            "high": high,
            "low": low,
            "close": close
        }

    def print_candle_analysis(self, candle, label="Candle"):
        metrics = self.calculate_candle_metrics(candle)
        print(f"\n{'='*60}")
        print(f"📊 {label} Analysis")
        print(f"{'='*60}")
        print(f"   Open:  ${metrics['open']:.2f}")
        print(f"   High:  ${metrics['high']:.2f}")
        print(f"   Low:   ${metrics['low']:.2f}")
        print(f"   Close: ${metrics['close']:.2f}")
        print(f"{'-'*60}")
        print(f"   Direction: {'🟢 ' if metrics['body_direction'] == 'bullish' else '🔴 '}{metrics['body_direction'].upper()}")
        print(f"   Body Size: ${metrics['body_size']:.2f}")
        print(f"   Upper Wick: ${metrics['upper_wick']:.2f}")
        print(f"   Lower Wick: ${metrics['lower_wick']:.2f}")

    def position_sizing(self, price):
        cash = self.get_cash()
        qty = round((cash * self.cash_at_risk) / price, 0)
        return max(qty, 1)

    def get_web_confirmation(self, signal_type, **kwargs):
        if not self.ws_server:
            return True

        if signal_type == 'entry':
            self.ws_server.broadcast('entry_signal', kwargs)
        else:
            self.ws_server.broadcast('exit_signal', kwargs)

        start_time = time.time()
        while time.time() - start_time < 60:
            msg = self.ws_server.get_message(timeout=1)
            if msg and msg['type'] == 'trade_confirmation':
                return msg['payload'].get('confirmed', False)

        self.ws_server.broadcast('signal_timeout', {})
        print("⏱️  Web confirmation timeout")
        return False

    def on_trading_iteration(self):
        if self.ws_server:
            msg = self.ws_server.get_message(timeout=0)
            if msg and msg['type'] == 'toggle_trading':
                self.trading_enabled = msg['payload'].get('enabled', self.trading_enabled)

        if not self.trading_enabled:
            print("⏸️  Trading paused")
            return

        bars = self.get_historical_prices(self.symbol, 30, "15Min")
        if bars is None or bars.df.empty or len(bars.df) < 3:
            return

        df = bars.df
        candle_1 = df.iloc[-3]
        candle_2 = df.iloc[-2]
        candle_3 = df.iloc[-1]

        # Increment candle counter
        self.candle_counter += 1

        self.print_candle_analysis(candle_3, "Current Candle")

        # Get timestamp for the current candle
        current_time = datetime.now().strftime('%H:%M:%S')
        
        if self.ws_server:
            self.ws_server.broadcast('candle_update', {
                'time': current_time,
                'open': float(candle_3['open']),
                'high': float(candle_3['high']),
                'low': float(candle_3['low']),
                'close': float(candle_3['close']),
                'index': self.candle_counter  # Add index for frontend
            })

        last_price = candle_3["close"]
        position = self.get_position(self.symbol)
        portfolio_value = self.get_portfolio_value()

        if self.max_equity is None:
            self.max_equity = portfolio_value

        if self.ws_server:
            self.ws_server.broadcast('portfolio_update', {'value': float(portfolio_value)})
            self.ws_server.broadcast('position_update', {
                'quantity': position.quantity if position else 0,
                'entry_price': float(self.entry_price) if self.entry_price else None
            })

        # Emergency drawdown check
        if position and portfolio_value < self.max_equity * (1 - self.max_drawdown_pct):
            print("\n🚨 EMERGENCY: Max drawdown!")
            self.sell_all()
            if self.ws_server:
                self.ws_server.broadcast('trade_executed', {
                    'datetime': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                    'symbol': self.symbol,
                    'side': 'SELL',
                    'quantity': position.quantity,
                    'price': float(last_price),
                    'total': float(position.quantity * last_price),
                    'pl': float((last_price - self.entry_price) * position.quantity) if self.entry_price else 0
                })
            self.entry_price = None
            self.trading_enabled = False
            return

        # Stop loss check
        if position and self.entry_price and last_price <= self.entry_price * (1 - self.stop_loss_pct):
            print(f"\n🚨 STOP LOSS at ${last_price:.2f}")
            qty = position.quantity
            order = self.create_order(self.symbol, qty, "sell")
            self.submit_order(order)
            pl = (last_price - self.entry_price) * qty
            log_trade(self.symbol, "SELL", qty, last_price, qty * last_price, pl)
            if self.ws_server:
                self.ws_server.broadcast('trade_executed', {
                    'datetime': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                    'symbol': self.symbol,
                    'side': 'SELL',
                    'quantity': int(qty),
                    'price': float(last_price),
                    'total': float(qty * last_price),
                    'pl': float(pl)
                })
            self.entry_price = None
            return

        # Calculate SMA
        closes = df["close"].values
        if len(closes) < self.trend_window:
            return
        sma = np.mean(closes[-self.trend_window:])
        in_uptrend = last_price > sma

        if self.ws_server:
            self.ws_server.broadcast('sma_update', {'value': float(sma)})

        # FVG DETECTION with candle indices
        try:
            c1_high = float(candle_1['high'])
            c1_low = float(candle_1['low'])
            c3_high = float(candle_3['high'])
            c3_low = float(candle_3['low'])
        except Exception as e:
            print(f"⚠️  Skipping FVG detection due to malformed candle data: {e}")
            c1_high = c1_low = c3_high = c3_low = None

        # Bullish FVG: Candle1.high < Candle3.low
        if c1_high is not None and c3_low is not None and (c1_high < c3_low):
            gap_size = c3_low - c1_high
            if gap_size > 0.0:
                fvg = {
                    "type": "bullish",
                    "low": float(c1_high),
                    "high": float(c3_low),
                    "age": 0,
                    "candle1_index": self.candle_counter - 2,  # Index of candle 1
                    "candle3_index": self.candle_counter  # Index of candle 3 (current)
                }
                exists = any(abs(existing['low'] - fvg['low']) < 1e-9 and abs(existing['high'] - fvg['high']) < 1e-9 for existing in self.bullish_fvgs)
                if not exists:
                    self.bullish_fvgs.append(fvg)
                    print(f"\n✓ DETECTED Bullish FVG: ${fvg['low']:.2f} - ${fvg['high']:.2f} (Candle {fvg['candle1_index']} to {fvg['candle3_index']})")

        # Bearish FVG: Candle1.low > Candle3.high
        if c1_low is not None and c3_high is not None and (c1_low > c3_high):
            gap_size = c1_low - c3_high
            if gap_size > 0.0:
                fvg = {
                    "type": "bearish",
                    "low": float(c3_high),
                    "high": float(c1_low),
                    "age": 0,
                    "candle1_index": self.candle_counter - 2,
                    "candle3_index": self.candle_counter
                }
                exists = any(abs(existing['low'] - fvg['low']) < 1e-9 and abs(existing['high'] - fvg['high']) < 1e-9 for existing in self.bearish_fvgs)
                if not exists:
                    self.bearish_fvgs.append(fvg)
                    print(f"\n✓ DETECTED Bearish FVG: ${fvg['low']:.2f} - ${fvg['high']:.2f} (Candle {fvg['candle1_index']} to {fvg['candle3_index']})")

        # Broadcast FVGs with candle indices
        if self.ws_server:
            self.ws_server.broadcast('fvg_update', {
                'bullish': [{
                    'low': float(f['low']),
                    'high': float(f['high']),
                    'age': f['age'],
                    'candle1_index': f['candle1_index'],
                    'candle3_index': f['candle3_index']
                } for f in self.bullish_fvgs],
                'bearish': [{
                    'low': float(f['low']),
                    'high': float(f['high']),
                    'age': f['age'],
                    'candle1_index': f['candle1_index'],
                    'candle3_index': f['candle3_index']
                } for f in self.bearish_fvgs]
            })

        # FVG INVALIDATION (full submersion check)
        def candle_fully_submerges_fvg(candle, fvg):
            try:
                h = float(candle['high'])
                l = float(candle['low'])
            except:
                return False
            return (h <= fvg['high']) and (l >= fvg['low'])

        for f in self.bullish_fvgs[:]:
            if candle_fully_submerges_fvg(candle_3, f):
                print(f"\n⚠️  Bullish FVG fully submerged and removed: ${f['low']:.2f} - ${f['high']:.2f}")
                self.bullish_fvgs.remove(f)

        for f in self.bearish_fvgs[:]:
            if candle_fully_submerges_fvg(candle_3, f):
                print(f"\n⚠️  Bearish FVG fully submerged and removed: ${f['low']:.2f} - ${f['high']:.2f}")
                self.bearish_fvgs.remove(f)

        # ENTRY LOGIC (rest of the code remains the same)
        def try_enter_long_on_fvg(fvg):
            if self.get_position(self.symbol):
                return False
            try:
                c_low = float(candle_3['low'])
            except:
                return False
            if (c_low >= fvg['low']) and (c_low <= fvg['high']):
                if not in_uptrend:
                    return False
                qty = self.position_sizing(last_price)
                print(f"\n🎯 Bullish Wick Entry detected into FVG {fvg['low']:.2f}-{fvg['high']:.2f}")
                confirmed = True
                if self.require_entry_confirmation:
                    confirmed = self.get_web_confirmation('entry', symbol=self.symbol, price=float(last_price), quantity=int(qty))
                if not confirmed:
                    print("❌ Entry declined by web")
                    return False
                order = self.create_order(self.symbol, qty, "buy")
                self.submit_order(order)
                self.entry_price = last_price
                self.max_equity = max(self.max_equity, portfolio_value)
                log_trade(self.symbol, "BUY", qty, last_price, qty * last_price)
                if self.ws_server:
                    self.ws_server.broadcast('trade_executed', {
                        'datetime': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                        'symbol': self.symbol,
                        'side': 'BUY',
                        'quantity': int(qty),
                        'price': float(last_price),
                        'total': float(qty * last_price),
                        'pl': ''
                    })
                print(f"\n✅ LONG ENTRY at ${last_price:.2f}")
                return True
            return False

        def try_enter_short_on_fvg(fvg):
            if self.get_position(self.symbol):
                return False
            try:
                c_high = float(candle_3['high'])
            except:
                return False
            if (c_high >= fvg['low']) and (c_high <= fvg['high']):
                if in_uptrend:
                    return False
                qty = self.position_sizing(last_price)
                print(f"\n🎯 Bearish Wick Entry detected into FVG {fvg['low']:.2f}-{fvg['high']:.2f}")
                confirmed = True
                if self.require_entry_confirmation:
                    confirmed = self.get_web_confirmation('entry', symbol=self.symbol, price=float(last_price), quantity=int(qty))
                if not confirmed:
                    print("❌ Entry declined by web")
                    return False
                order = self.create_order(self.symbol, qty, "sell")
                self.submit_order(order)
                self.entry_price = last_price
                self.max_equity = max(self.max_equity, portfolio_value)
                log_trade(self.symbol, "SELL", qty, last_price, qty * last_price)
                if self.ws_server:
                    self.ws_server.broadcast('trade_executed', {
                        'datetime': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                        'symbol': self.symbol,
                        'side': 'SELL',
                        'quantity': int(qty),
                        'price': float(last_price),
                        'total': float(qty * last_price),
                        'pl': ''
                    })
                print(f"\n✅ SHORT ENTRY at ${last_price:.2f}")
                return True
            return False

        if not self.get_position(self.symbol) and in_uptrend:
            for fvg in self.bullish_fvgs[:]:
                entered = try_enter_long_on_fvg(fvg)
                if entered:
                    if fvg in self.bullish_fvgs:
                        self.bullish_fvgs.remove(fvg)
                    return

        if not self.get_position(self.symbol) and (not in_uptrend):
            for fvg in self.bearish_fvgs[:]:
                entered = try_enter_short_on_fvg(fvg)
                if entered:
                    if fvg in self.bearish_fvgs:
                        self.bearish_fvgs.remove(fvg)
                    return

        # EXIT LOGIC
        if self.get_position(self.symbol):
            pos = self.get_position(self.symbol)
            for fvg in self.bearish_fvgs[:]:
                if float(candle_3['high']) >= fvg['low'] and float(candle_3['low']) <= fvg['high']:
                    qty = pos.quantity
                    pl = (last_price - self.entry_price) * qty if self.entry_price else 0
                    pl_pct = ((last_price - self.entry_price) / self.entry_price * 100) if self.entry_price else 0
                    print(f"\n📤 EXIT SIGNAL triggered by bearish FVG touch")
                    confirmed = True
                    if self.require_exit_confirmation:
                        confirmed = self.get_web_confirmation('exit', symbol=self.symbol, price=float(last_price), quantity=int(qty), pl=float(pl), pl_pct=float(pl_pct))
                    if not confirmed:
                        print("❌ Exit declined")
                        continue
                    order = self.create_order(self.symbol, qty, "sell")
                    self.submit_order(order)
                    log_trade(self.symbol, "SELL", qty, last_price, qty * last_price, pl)
                    if self.ws_server:
                        self.ws_server.broadcast('trade_executed', {
                            'datetime': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
                            'symbol': self.symbol,
                            'side': 'SELL',
                            'quantity': int(qty),
                            'price': float(last_price),
                            'total': float(qty * last_price),
                            'pl': float(pl)
                        })
                    print(f"\n✅ EXIT at ${last_price:.2f}")
                    self.entry_price = None
                    if fvg in self.bearish_fvgs:
                        self.bearish_fvgs.remove(fvg)
                    return

        # Age out FVGs
        for fvg in self.bullish_fvgs[:]:
            fvg["age"] += 1
            if fvg["age"] > self.max_fvg_age:
                print(f"⌛ Removing aged bullish FVG: {fvg['low']:.2f}-{fvg['high']:.2f}")
                self.bullish_fvgs.remove(fvg)

        for fvg in self.bearish_fvgs[:]:
            fvg["age"] += 1
            if fvg["age"] > self.max_fvg_age:
                print(f"⌛ Removing aged bearish FVG: {fvg['low']:.2f}-{fvg['high']:.2f}")
                self.bearish_fvgs.remove(fvg)

if __name__ == "__main__":
    ws_server = TradingWebSocketServer(host='localhost', port=8765)
    ws_server.run_in_thread()
    time.sleep(3)

    # TEST DATA GENERATOR COMMENTED OUT - Using live data now
    # test_thread = threading.Thread(target=send_test_data, args=(ws_server,), daemon=True)
    # test_thread.start()
    # print("🧪 Test data sender started")

    broker_creds = {
        "API_KEY": API_KEY,
        "API_SECRET": API_SECRET,
        "PAPER": True
    }

    broker = Alpaca(broker_creds)

    strategy = CombinedFVGTrendStrategy(
        name="websocket_fvg_trend",
        broker=broker,
        parameters={
            "symbol": "SPY",
            "cash_at_risk": 0.5,
            "stop_loss_pct": 0.02,
            "max_drawdown_pct": 0.15,
            "trend_window": 20,
            "max_fvg_age": 8,
            "require_entry_confirmation": True,
            "require_exit_confirmation": True,
            "auto_continue_after_exit": False,
            "ws_server": ws_server
        }
    )

    print("\n" + "="*60)
    print("🚀 LIVE TRADING WITH WEB DASHBOARD")
    print("="*60)
    print("📊 Open dashboard at: http://localhost:3000")
    print("🔌 WebSocket: ws://localhost:8765")
    print("🎯 Using LIVE market data (no test candles)")
    print("="*60)
    print("\nPress Ctrl+C to stop\n")

    trader = Trader()
    trader.add_strategy(strategy)
    trader.run_all()