# Algo-Trading-Bot
A full-stack algorithmic trading system leveraging Fair Value Gap (FVG) patterns and trend analysis. Designed for both backtesting and live trading, with a focus on performance, risk management, and real-time monitoring.

Key Features

High-Performance Trading Strategy

Achieved 55.5% win rate and 79% improvement vs SPY benchmark over 5-year backtests.

Utilizes Fair Value Gap patterns combined with trend analysis for precise entry/exit points.

Dual-Mode Engine (Live & Backtest)

Integrates with the Alpaca API for live trading.

Supports threaded user confirmations and configurable strategy parameters.

Logs all trades and data to CSV for easy analysis and auditing.

Robust Risk Management

Automated stop-loss and drawdown monitoring.

Dynamic position sizing to optimize risk-adjusted returns.

Reduced SPY volatility from 21.6% to 5.1% while maintaining independent market behavior.

Real-Time React Dashboard

WebSocket integration for live candlestick updates.

SMA overlays and bullish/bearish FVG highlights.

Portfolio metrics, trade history, and interactive trade confirmations.

Technologies Used

Backend: Python, Alpaca API, multithreading, CSV logging

Frontend: React, WebSockets, Recharts

Strategy: Fair Value Gap analysis, trend following, risk management algorithms
