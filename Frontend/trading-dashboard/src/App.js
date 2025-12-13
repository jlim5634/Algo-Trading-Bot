import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea } from 'recharts';
import { TrendingUp, TrendingDown, Activity, DollarSign, BarChart3, AlertTriangle, PlayCircle, PauseCircle, Wifi, WifiOff } from 'lucide-react';
import './App.css';

function App() {
  const [candleData, setCandleData] = useState([]);
  const [currentCandle, setCurrentCandle] = useState(null);
  const [position, setPosition] = useState(null);
  const [bullishFVGs, setBullishFVGs] = useState([]);
  const [bearishFVGs, setBearishFVGs] = useState([]);
  const [touchedFVGs, setTouchedFVGs] = useState([]);
  const [tradeHistory, setTradeHistory] = useState([]);
  const [portfolioValue, setPortfolioValue] = useState(100000);
  const [sma, setSma] = useState(null);
  const [tradingEnabled, setTradingEnabled] = useState(true);
  const [pendingSignal, setPendingSignal] = useState(null);
  const [connected, setConnected] = useState(false);
  const [wsStatus, setWsStatus] = useState('Disconnected');
  const [autoConfirm, setAutoConfirm] = useState(false);

  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  const sendWebSocketMessage = (message) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      console.error('WebSocket is not connected; cannot send message', message);
    }
  };

  const handleWebSocketMessage = useCallback((data) => {
    switch (data.type) {
      case 'candle_update':
        handleCandleUpdate(data.payload);
        break;
      case 'fvg_update':
        handleFVGUpdate(data.payload);
        break;
      case 'position_update':
        handlePositionUpdate(data.payload);
        break;
      case 'trade_executed':
        handleTradeExecuted(data.payload);
        break;
      case 'portfolio_update':
        setPortfolioValue(data.payload.value);
        break;
      case 'sma_update':
        setSma(data.payload.value);
        break;
      case 'trading_status':
        setTradingEnabled(data.payload.enabled);
        break;
      case 'entry_signal':
        setPendingSignal({ type: 'entry', ...data.payload });
        break;
      case 'exit_signal':
        setPendingSignal({ type: 'exit', ...data.payload });
        break;
      case 'signal_timeout':
        setPendingSignal(null);
        break;
      case 'daily_rest':
        console.log('📅 Daily resset receeived:', data.payload);
        setCandleData([])
        setBullishFVGs([])
        setBearishFVGs([])
        setTouchedFVGs([])
        break;
      default:
        console.log('Unknown message type:', data.type);
    }
  }, []);

  const connectWebSocket = useCallback(() => {
    try {
      const ws = new WebSocket('ws://localhost:8765');
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('WebSocket Connected');
        setConnected(true);
        setWsStatus('Connected');
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleWebSocketMessage(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setWsStatus('Error');
      };

      ws.onclose = () => {
        console.log('WebSocket Disconnected');
        setConnected(false);
        setWsStatus('Disconnected');

        reconnectTimeoutRef.current = setTimeout(() => {
          console.log('Attempting to reconnect...');
          setWsStatus('Reconnecting...');
          connectWebSocket();
        }, 5000);
      };
    } catch (error) {
      console.error('Failed to connect WebSocket:', error);
      setWsStatus('Failed');
    }
  }, [handleWebSocketMessage]);

  useEffect(() => {
    connectWebSocket();
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    };
  }, [connectWebSocket]);

  const handleCandleUpdate = (candle) => {
    setCandleData(prevData => {
      const newData = [...prevData, candle];
      return newData.slice(-30);
    });
    setCurrentCandle(candle);
    detectFVGInteractions(candle);
  };

  const handleFVGUpdate = (fvgs) => {
    setBullishFVGs(fvgs.bullish || []);
    setBearishFVGs(fvgs.bearish || []);
    setTouchedFVGs([]);
  };

  const handlePositionUpdate = (positionData) => {
    if (positionData && positionData.quantity > 0) {
      setPosition({
        quantity: positionData.quantity,
        entryPrice: positionData.entry_price
      });
    } else {
      setPosition(null);
    }
  };

  const handleTradeExecuted = (trade) => {
    setTradeHistory(prevHistory => [trade, ...prevHistory].slice(0, 20));
  };

  const calculateCandleMetrics = (candle) => {
    if (!candle) return null;
    const bodySize = Math.abs(candle.close - candle.open);
    const bodyDirection = candle.close > candle.open ? 'bullish' : 'bearish';
    const bodyTop = Math.max(candle.close, candle.open);
    const bodyBottom = Math.min(candle.close, candle.open);
    const upperWick = candle.high - bodyTop;
    const lowerWick = bodyBottom - candle.low;
    const totalRange = candle.high - candle.low;
    const bodyToRangeRatio = totalRange > 0 ? (bodySize / totalRange * 100) : 0;
    return {
      bodySize,
      bodyDirection,
      upperWick,
      lowerWick,
      totalRange,
      bodyToRangeRatio
    };
  };
  const metrics = calculateCandleMetrics(currentCandle);

  const detectFVGInteractions = (candle) => {
    if (!candle) return;

    const checkBullishTouch = (fvg, candle) => {
      return (candle.low >= fvg.low) && (candle.low <= fvg.high);
    };

    const candleFullySubmergesFvg = (fvg, candle) => {
      return (candle.high <= fvg.high) && (candle.low >= fvg.low);
    };

    const isBullishOrderflow = () => {
      if (sma === null || sma === undefined) return true;
      return candle.close > sma;
    };

    const newTouched = [];

    bullishFVGs.forEach((fvg) => {
      try {
        if (candleFullySubmergesFvg(fvg, candle)) {
          setBullishFVGs(prev => prev.filter(x => !(x.low === fvg.low && x.high === fvg.high)));
          sendWebSocketMessage({ type: 'invalidate_fvg', payload: { type: 'bullish', low: fvg.low, high: fvg.high } });
          console.log('Removed bullish FVG due to full submerge:', fvg);
        } else if (checkBullishTouch(fvg, candle)) {
          newTouched.push({ ...fvg, side: 'bullish' });
          sendWebSocketMessage({ type: 'fvg_touch', payload: { type: 'bullish', low: fvg.low, high: fvg.high, candle } });
          if (isBullishOrderflow() && tradingEnabled && autoConfirm) {
            sendWebSocketMessage({ type: 'trade_confirmation', payload: { confirmed: true, signal_type: 'entry' } });
          }
        }
      } catch (e) {
        console.warn('Error checking bullish FVG interaction', e);
      }
    });

    bearishFVGs.forEach((fvg) => {
      try {
        if (candleFullySubmergesFvg(fvg, candle)) {
          setBearishFVGs(prev => prev.filter(x => !(x.low === fvg.low && x.high === fvg.high)));
          sendWebSocketMessage({ type: 'invalidate_fvg', payload: { type: 'bearish', low: fvg.low, high: fvg.high } });
          console.log('Removed bearish FVG due to full submerge:', fvg);
        } else {
          const bearishWickTouch = (c, f) => (c.high >= f.low) && (c.high <= f.high);
          if (bearishWickTouch(candle, fvg)) {
            newTouched.push({ ...fvg, side: 'bearish' });
            sendWebSocketMessage({ type: 'fvg_touch', payload: { type: 'bearish', low: fvg.low, high: fvg.high, candle } });
            if (!isBullishOrderflow() && tradingEnabled && autoConfirm) {
              sendWebSocketMessage({ type: 'trade_confirmation', payload: { confirmed: true, signal_type: 'entry' } });
            }
          }
        }
      } catch (e) {
        console.warn('Error checking bearish FVG interaction', e);
      }
    });

    if (newTouched.length > 0) {
      setTouchedFVGs(prev => {
        const combined = [...newTouched, ...prev];
        const uniq = [];
        const seen = new Set();
        combined.forEach(z => {
          const id = `${z.side}-${z.low}-${z.high}`;
          if (!seen.has(id)) {
            seen.add(id);
            uniq.push(z);
          }
        });
        return uniq.slice(0, 20);
      });
    }
  };

  const handleConfirmTrade = (confirm) => {
    sendWebSocketMessage({
      type: 'trade_confirmation',
      payload: {
        confirmed: confirm,
        signal_type: pendingSignal?.type
      }
    });
    setPendingSignal(null);
  };

  const toggleTrading = () => {
    const newStatus = !tradingEnabled;
    sendWebSocketMessage({ type: 'toggle_trading', payload: { enabled: newStatus } });
    setTradingEnabled(newStatus);
  };

  // Custom FVG rendering component that draws boxes between candle indices
  const FVGRenderer = ({ fvgs, color, candleData }) => {
    if (!fvgs || fvgs.length === 0 || !candleData || candleData.length === 0) return null;

    return fvgs.map((fvg, idx) => {
      // Find the actual candle positions in our chart data
      const candle1Index = candleData.findIndex(c => c.index === fvg.candle1_index);
      const candle3Index = candleData.findIndex(c => c.index === fvg.candle3_index);

      // Only render if both candles are visible in current data
      if (candle1Index === -1 || candle3Index === -1) return null;

      const x1 = candleData[candle1Index]?.time;
      const x2 = candleData[candle3Index]?.time;

      return (
        <ReferenceArea
          key={`fvg-${color}-${idx}`}
          x1={x1}
          x2={x2}
          y1={fvg.low}
          y2={fvg.high}
          fill={color}
          fillOpacity={0.15}
          stroke={color}
          strokeWidth={2}
          strokeDasharray="4 4"
        />
      );
    });
  };

  const CustomCandlestick = ({ data }) => {
    const chartData = data.map(candle => ({
      ...candle,
      isGreen: candle.close >= candle.open,
      bodyLow: Math.min(candle.open, candle.close),
      bodyHigh: Math.max(candle.open, candle.close),
    }));

    const CandlestickShape = (props) => {
      const { x, y, width, height, index } = props;
      if (!chartData[index]) return null;
      const candle = chartData[index];
      const isGreen = candle.isGreen;
      const bodyColor = isGreen ? '#10B981' : '#EF4444';
      const wickColor = '#9CA3AF';

      const allValues = data.flatMap(d => [d.high, d.low]);
      const yMin = Math.min(...allValues) - 2;
      const yMax = Math.max(...allValues) + 2;
      const yRange = yMax - yMin;
      const chartHeight = 320;

      const scaleY = (value) => {
        return chartHeight * (1 - (value - yMin) / yRange);
      };

      const highY = scaleY(candle.high);
      const lowY = scaleY(candle.low);
      const bodyTopY = scaleY(candle.bodyHigh);
      const bodyBottomY = scaleY(candle.bodyLow);
      const bodyHeight = Math.max(bodyBottomY - bodyTopY, 1);

      const wickX = x + width / 2;
      const candleWidth = Math.min(width * 0.5, 8);
      const candleX = x + (width - candleWidth) / 2;

      return (
        <g>
          <line x1={wickX} y1={highY} x2={wickX} y2={bodyTopY} stroke={wickColor} strokeWidth={1.5} />
          <rect x={candleX} y={bodyTopY} width={candleWidth} height={bodyHeight} fill={bodyColor} stroke={bodyColor} strokeWidth={1} />
          <line x1={wickX} y1={bodyBottomY} x2={wickX} y2={lowY} stroke={wickColor} strokeWidth={1.5} />
        </g>
      );
    };

    return (
      <div className="relative h-96 bg-gray-900 rounded-lg p-4">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
            <XAxis dataKey="time" stroke="#9CA3AF" tick={{ fill: '#9CA3AF', fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis domain={['dataMin - 2', 'dataMax + 2']} stroke="#9CA3AF" tick={{ fill: '#9CA3AF', fontSize: 11 }} />
            <Tooltip content={({ active, payload }) => {
              if (active && payload && payload.length) {
                const data = payload[0].payload;
                const isGreen = data.close >= data.open;
                const change = data.close - data.open;
                const changePercent = (change / data.open) * 100;
                const bodySize = Math.abs(data.close - data.open);
                const upperWick = data.high - Math.max(data.open, data.close);
                const lowerWick = Math.min(data.open, data.close) - data.low;
                return (
                  <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 shadow-xl">
                    <p className="text-gray-300 text-sm font-bold mb-2">{data.time}</p>
                    <div className="space-y-1">
                      <p className="text-gray-400 text-xs">Open: <span className="text-white font-semibold">${data.open?.toFixed(2)}</span></p>
                      <p className="text-gray-400 text-xs">High: <span className="text-green-400 font-semibold">${data.high?.toFixed(2)}</span></p>
                      <p className="text-gray-400 text-xs">Low: <span className="text-red-400 font-semibold">${data.low?.toFixed(2)}</span></p>
                      <p className="text-gray-400 text-xs">Close: <span className={`font-semibold ${isGreen ? 'text-green-400' : 'text-red-400'}`}>${data.close?.toFixed(2)}</span></p>
                      <div className="border-t border-gray-600 pt-1 mt-1">
                        <p className="text-gray-400 text-xs">
                          Change: <span className={`font-bold ${isGreen ? 'text-green-400' : 'text-red-400'}`}>{isGreen ? '+' : ''}{change.toFixed(2)} ({changePercent >= 0 ? '+' : ''}{changePercent.toFixed(2)}%)</span>
                        </p>
                        <p className="text-gray-400 text-xs">Body: ${bodySize.toFixed(2)}</p>
                        <p className="text-gray-400 text-xs">Upper Wick: ${upperWick.toFixed(2)}</p>
                        <p className="text-gray-400 text-xs">Lower Wick: ${lowerWick.toFixed(2)}</p>
                      </div>
                    </div>
                  </div>
                );
              }
              return null;
            }} />

            {sma && (
              <ReferenceLine y={sma} stroke="#F59E0B" strokeWidth={2} strokeDasharray="5 5" label={{ value: `SMA: $${sma.toFixed(2)}`, fill: '#F59E0B', fontSize: 11 }} />
            )}

            {bullishFVGs.map((fvg, idx) => {
              const candle1 = chartData.find(c => c.index === fvg.candle1_index);
              const candle3 = chartData.find(c => c.index === fvg.candle3_index);
              
              if (!candle1 || !candle3) return null;

              return (
                <ReferenceArea
                  key={`bullish-fvg-${idx}`}
                  x1={candle1.time}
                  x2={candle3.time}
                  y1={fvg.low}
                  y2={fvg.high}
                  fill="#10B981"
                  fillOpacity={0.2}
                  stroke="#10B981"
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  label={{
                    value: `FVG ${fvg.candle1_index}-${fvg.candle3_index}`,
                    position: 'insideTopLeft',
                    fill: '#10B981',
                    fontSize: 10
                  }}
                />
              );
            })}

            {bearishFVGs.map((fvg, idx) => {
              const candle1 = chartData.find(c => c.index === fvg.candle1_index);
              const candle3 = chartData.find(c => c.index === fvg.candle3_index);
              
              if (!candle1 || !candle3) return null;

              return (
                <ReferenceArea
                  key={`bearish-fvg-${idx}`}
                  x1={candle1.time}
                  x2={candle3.time}
                  y1={fvg.low}
                  y2={fvg.high}
                  fill="#EF4444"
                  fillOpacity={0.2}
                  stroke="#EF4444"
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  label={{
                    value: `FVG ${fvg.candle1_index}-${fvg.candle3_index}`,
                    position: 'insideTopLeft',
                    fill: '#EF4444',
                    fontSize: 10
                  }}
                />
              );
            })} 


            {/* Highlight touched FVGs */}
            {touchedFVGs.map((fvg, idx) => {
              const candle1Index = candleData.findIndex(c => c.index === fvg.candle1_index);
              const candle3Index = candleData.findIndex(c => c.index === fvg.candle3_index);
              
              if (candle1Index === -1 || candle3Index === -1) return null;

              return (
                <ReferenceArea
                  key={`touched-${idx}`}
                  x1={candleData[candle1Index]?.time}
                  x2={candleData[candle3Index]?.time}
                  y1={fvg.low}
                  y2={fvg.high}
                  stroke={fvg.side === 'bullish' ? '#34D399' : '#F87171'}
                  strokeWidth={3}
                  strokeDasharray="2 2"
                  fill={fvg.side === 'bullish' ? '#34D399' : '#F87171'}
                  fillOpacity={0.08}
                />
              );
            })}

            {position && (
              <ReferenceLine y={position.entryPrice} stroke="#8B5CF6" strokeWidth={2} strokeDasharray="8 4" label={{ value: `Entry: $${position.entryPrice.toFixed(2)}`, fill: '#8B5CF6', fontSize: 11 }} />
            )}
            {position && (
              <ReferenceLine y={position.entryPrice * 0.98} stroke="#DC2626" strokeWidth={2} strokeDasharray="4 4" label={{ value: `Stop: $${(position.entryPrice * 0.98).toFixed(2)}`, fill: '#DC2626', fontSize: 10 }} />
            )}

            <Line type="monotone" dataKey="high" stroke="transparent" dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="low" stroke="transparent" dot={false} isAnimationActive={false} />

            <Bar dataKey="bodyLow" fill="transparent" shape={CandlestickShape} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>

        <div className="absolute top-6 left-6 bg-gray-800 bg-opacity-95 rounded-lg px-3 py-2 text-xs shadow-lg border border-gray-700">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="w-4 h-3 bg-green-500 rounded border border-green-600"></div>
              <span className="text-gray-300 font-semibold">Bullish FVG</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-3 bg-red-500 rounded border border-red-600"></div>
              <span className="text-gray-300 font-semibold">Bearish FVG</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-1 h-4 bg-gray-400"></div>
              <span className="text-gray-300 font-semibold">Wicks</span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-white flex items-center gap-3">
              <BarChart3 className="text-blue-500" size={36} />
              FVG Trading Dashboard
            </h1>
            <p className="text-gray-400 mt-1">Real-time Fair Value Gap Strategy Monitor - Live Data</p>
          </div>

          <div className="flex items-center gap-4">
            <div className={`flex items-center gap-2 px-4 py-2 rounded-lg ${connected ? 'bg-green-900 bg-opacity-30' : 'bg-red-900 bg-opacity-30'}`}>
              {connected ? <Wifi className="text-green-500" size={20} /> : <WifiOff className="text-red-500" size={20} />}
              <span className={`text-sm font-semibold ${connected ? 'text-green-400' : 'text-red-400'}`}>{wsStatus}</span>
            </div>

            <div className="flex items-center gap-2">
              <button onClick={toggleTrading} disabled={!connected} className={`flex items-center gap-2 px-6 py-3 rounded-lg font-semibold transition-all ${!connected ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : tradingEnabled ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}`}>
                {tradingEnabled ? <PlayCircle size={20} /> : <PauseCircle size={20} />}
                {tradingEnabled ? 'Trading Active' : 'Trading Paused'}
              </button>

              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={autoConfirm} onChange={(e) => setAutoConfirm(e.target.checked)} />
                <span>Auto-confirm</span>
              </label>
            </div>
          </div>
        </div>

        {!connected && (
          <div className="bg-yellow-900 bg-opacity-30 border border-yellow-600 rounded-lg p-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="text-yellow-500" size={24} />
              <div>
                <p className="text-yellow-400 font-semibold">Not Connected to Backend</p>
                <p className="text-yellow-300 text-sm">Make sure your Python trading bot is running with WebSocket server enabled.</p>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-sm">Portfolio Value</p>
                <p className="text-2xl font-bold text-white">${portfolioValue.toLocaleString()}</p>
              </div>
              <DollarSign className="text-green-500" size={32} />
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-sm">Current Position</p>
                <p className="text-2xl font-bold text-white">{position ? `${position.quantity} SPY` : 'None'}</p>
              </div>
              <Activity className="text-blue-500" size={32} />
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-sm">Active FVGs</p>
                <p className="text-2xl font-bold text-white"><span className="text-green-500">{bullishFVGs.length}</span> / <span className="text-red-500">{bearishFVGs.length}</span></p>
              </div>
              <TrendingUp className="text-purple-500" size={32} />
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-sm">Current Price</p>
                <p className="text-2xl font-bold text-white">{currentCandle ? `$${currentCandle.close.toFixed(2)}` : '--'}</p>
              </div>
              <div className={currentCandle && currentCandle.close > currentCandle.open ? 'text-green-500' : 'text-red-500'}>
                {currentCandle && currentCandle.close > currentCandle.open ? <TrendingUp size={32} /> : <TrendingDown size={32} />}
              </div>
            </div>
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
          <h2 className="text-xl font-bold text-white mb-4">SPY - 15 Minute Chart (Live Data)</h2>
          {candleData.length > 0 ? <CustomCandlestick data={candleData} /> : <div className="h-96 flex items-center justify-center text-gray-500"><p>Waiting for live market data...</p></div>}
        </div>

        {metrics && currentCandle && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <h2 className="text-xl font-bold text-white mb-4">📊 Current Candle Analysis</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div><p className="text-gray-400 text-sm">Open</p><p className="text-lg font-semibold text-white">${currentCandle.open.toFixed(2)}</p></div>
              <div><p className="text-gray-400 text-sm">High</p><p className="text-lg font-semibold text-white">${currentCandle.high.toFixed(2)}</p></div>
              <div><p className="text-gray-400 text-sm">Low</p><p className="text-lg font-semibold text-white">${currentCandle.low.toFixed(2)}</p></div>
              <div><p className="text-gray-400 text-sm">Close</p><p className="text-lg font-semibold text-white">${currentCandle.close.toFixed(2)}</p></div>
            </div>

            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
              <div><p className="text-gray-400 text-sm">Direction</p><p className={`text-lg font-semibold ${metrics.bodyDirection === 'bullish' ? 'text-green-500' : 'text-red-500'}`}>{metrics.bodyDirection === 'bullish' ? '🟢 BULLISH' : '🔴 BEARISH'}</p></div>
              <div><p className="text-gray-400 text-sm">Body Size</p><p className="text-lg font-semibold text-white">${metrics.bodySize.toFixed(2)}</p></div>
              <div><p className="text-gray-400 text-sm">Upper Wick</p><p className="text-lg font-semibold text-white">${metrics.upperWick.toFixed(2)}</p></div>
              <div><p className="text-gray-400 text-sm">Lower Wick</p><p className="text-lg font-semibold text-white">${metrics.lowerWick.toFixed(2)}</p></div>
              <div><p className="text-gray-400 text-sm">Total Range</p><p className="text-lg font-semibold text-white">${metrics.totalRange.toFixed(2)}</p></div>
              <div><p className="text-gray-400 text-sm">Body/Range Ratio</p><p className="text-lg font-semibold text-white">{metrics.bodyToRangeRatio.toFixed(1)}%</p></div>
            </div>

            <div className="mt-6 flex justify-center">
              <div className="text-center">
                <p className="text-gray-400 text-sm mb-2">Visual Representation</p>
                <div className="inline-block bg-gray-800 p-6 rounded-lg">
                  <div className="flex flex-col items-center font-mono text-sm">
                    <div className="text-gray-400">|  ← Upper Wick (${metrics.upperWick.toFixed(2)})</div>
                    <div className={`border-2 ${metrics.bodyDirection === 'bullish' ? 'border-green-500 bg-green-900' : 'border-red-500 bg-red-900'} px-8 py-4 my-1`}>
                      <span className={metrics.bodyDirection === 'bullish' ? 'text-green-400' : 'text-red-400'}>{metrics.bodyDirection === 'bullish' ? '↑' : '↓'}</span>
                    </div>
                    <div className="text-gray-400">|  ← Lower Wick (${metrics.lowerWick.toFixed(2)})</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {position && currentCandle && (
          <div className="bg-gray-900 border border-yellow-600 rounded-lg p-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="text-yellow-500 flex-shrink-0" size={24} />
              <div className="flex-1">
                <h3 className="text-lg font-bold text-white mb-2">Active Position</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div><p className="text-gray-400 text-sm">Quantity</p><p className="text-white font-semibold">{position.quantity} shares</p></div>
                  <div><p className="text-gray-400 text-sm">Entry Price</p><p className="text-white font-semibold">${position.entryPrice.toFixed(2)}</p></div>
                  <div><p className="text-gray-400 text-sm">Current P/L</p><p className={`font-semibold ${currentCandle.close > position.entryPrice ? 'text-green-500' : 'text-red-500'}`}>${((currentCandle.close - position.entryPrice) * position.quantity).toFixed(2)} ({(((currentCandle.close - position.entryPrice) / position.entryPrice) * 100).toFixed(2)}%)</p></div>
                  <div><p className="text-gray-400 text-sm">Stop Loss</p><p className="text-red-400 font-semibold">${(position.entryPrice * 0.98).toFixed(2)}</p></div>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
          <h2 className="text-xl font-bold text-white mb-4">Trade History</h2>
          {tradeHistory.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-gray-700">
                  <tr className="text-left">
                    <th className="pb-3 text-gray-400 font-semibold">Datetime</th>
                    <th className="pb-3 text-gray-400 font-semibold">Symbol</th>
                    <th className="pb-3 text-gray-400 font-semibold">Side</th>
                    <th className="pb-3 text-gray-400 font-semibold">Quantity</th>
                    <th className="pb-3 text-gray-400 font-semibold">Price</th>
                    <th className="pb-3 text-gray-400 font-semibold">Total</th>
                    <th className="pb-3 text-gray-400 font-semibold">P/L</th>
                  </tr>
                </thead>
                <tbody>
                  {tradeHistory.map((trade, idx) => (
                    <tr key={idx} className="border-b border-gray-800">
                      <td className="py-3 text-gray-300">{trade.datetime}</td>
                      <td className="py-3 text-white font-semibold">{trade.symbol}</td>
                      <td className="py-3"><span className={`px-2 py-1 rounded text-xs font-semibold ${trade.side === 'BUY' ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'}`}>{trade.side}</span></td>
                      <td className="py-3 text-gray-300">{trade.quantity}</td>
                      <td className="py-3 text-gray-300">${trade.price.toFixed(2)}</td>
                      <td className="py-3 text-gray-300">${trade.total.toFixed(2)}</td>
                      <td className="py-3">{trade.pl !== undefined && trade.pl !== '' && (<span className={parseFloat(trade.pl) >= 0 ? 'text-green-500 font-semibold' : 'text-red-500 font-semibold'}>${parseFloat(trade.pl).toFixed(2)}</span>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (<p className="text-gray-500 text-center py-8">No trades yet</p>)}
        </div>

        {pendingSignal && (
          <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
            <div className="bg-gray-900 border-2 border-blue-500 rounded-lg p-8 max-w-md w-full mx-4 shadow-2xl">
              <h3 className="text-2xl font-bold text-white mb-4">{pendingSignal.type === 'entry' ? '🚀 Entry Signal' : '📤 Exit Signal'}</h3>
              <div className="space-y-2 mb-6">
                <p className="text-gray-300">Symbol: <span className="text-white font-semibold">{pendingSignal.symbol || 'SPY'}</span></p>
                <p className="text-gray-300">Current Price: <span className="text-white font-semibold">${pendingSignal.price?.toFixed(2)}</span></p>
                <p className="text-gray-300">Quantity: <span className="text-white font-semibold">{pendingSignal.quantity} shares</span></p>
                <p className="text-gray-300">Total: <span className="text-white font-semibold">${(pendingSignal.quantity * pendingSignal.price).toFixed(2)}</span></p>
                {pendingSignal.type === 'exit' && pendingSignal.pl !== undefined && (<p className="text-gray-300">P/L: <span className={`font-semibold ${pendingSignal.pl >= 0 ? 'text-green-500' : 'text-red-500'}`}>${pendingSignal.pl.toFixed(2)} ({pendingSignal.pl_pct?.toFixed(2)}%)</span></p>)}
                {pendingSignal.type === 'entry' && (<p className="text-gray-300">Stop Loss: <span className="text-red-400 font-semibold">${(pendingSignal.price * 0.98).toFixed(2)}</span></p>)}
              </div>
              <div className="flex gap-4">
                <button onClick={() => handleConfirmTrade(true)} className="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-lg transition-colors">✓ Confirm</button>
                <button onClick={() => handleConfirmTrade(false)} className="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-3 rounded-lg transition-colors">✗ Decline</button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

export default App