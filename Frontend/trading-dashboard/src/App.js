import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea } from 'recharts';
import { TrendingUp, TrendingDown, Activity, DollarSign, BarChart3, AlertTriangle, PlayCircle, PauseCircle, Wifi, WifiOff } from 'lucide-react';
import './App.css';

// App component - main dashboard
function App() {
  // --- Core market & UI state ---
  const [candleData, setCandleData] = useState([]);           // last N candles for charting
  const [currentCandle, setCurrentCandle] = useState(null);   // most recent candle
  const [position, setPosition] = useState(null);             // current position object from backend
  const [bullishFVGs, setBullishFVGs] = useState([]);         // list of bullish FVG zones from backend
  const [bearishFVGs, setBearishFVGs] = useState([]);         // list of bearish FVG zones from backend
  const [touchedFVGs, setTouchedFVGs] = useState([]);         // local list of FVGs that were touched (for UI highlight)
  const [tradeHistory, setTradeHistory] = useState([]);       // trade history from backend
  const [portfolioValue, setPortfolioValue] = useState(100000);// portfolio value from backend
  const [sma, setSma] = useState(null);                       // SMA from backend
  const [tradingEnabled, setTradingEnabled] = useState(true); // trading toggle local state
  const [pendingSignal, setPendingSignal] = useState(null);   // entry/exit signal waiting for user confirm
  const [connected, setConnected] = useState(false);          // websocket connection flag
  const [wsStatus, setWsStatus] = useState('Disconnected');   // readable ws status
  const [autoConfirm, setAutoConfirm] = useState(false);      // optional: auto-confirm entry/exit signals

  // --- refs for ws and reconnect management ---
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  // --- helper: send a message via websocket if open ---
  const sendWebSocketMessage = (message) => {
    // only send when socket is open
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      console.error('WebSocket is not connected; cannot send message', message);
    }
  };

  // --- HANDLE incoming websocket messages (from backend) ---
  const handleWebSocketMessage = useCallback((data) => {
    switch (data.type) {
      // candle updates -> update chart / run local FVG touch logic (see handleCandleUpdate)
      case 'candle_update':
        handleCandleUpdate(data.payload);
        break;

      // backend authoritative FVG list -> replace local FVGs
      case 'fvg_update':
        handleFVGUpdate(data.payload);
        break;

      // backend position update -> update UI
      case 'position_update':
        handlePositionUpdate(data.payload);
        break;

      // trade executed -> add to trade history
      case 'trade_executed':
        handleTradeExecuted(data.payload);
        break;

      // portfolio / sma / trading_status updates -> simple setters
      case 'portfolio_update':
        setPortfolioValue(data.payload.value);
        break;
      case 'sma_update':
        setSma(data.payload.value);
        break;
      case 'trading_status':
        setTradingEnabled(data.payload.enabled);
        break;

      // backend can push entry/exit signals to UI (we show modal) 
      case 'entry_signal':
        setPendingSignal({ type: 'entry', ...data.payload });
        break;
      case 'exit_signal':
        setPendingSignal({ type: 'exit', ...data.payload });
        break;

      // signal timeout from backend -> clear modal
      case 'signal_timeout':
        setPendingSignal(null);
        break;

      default:
        console.log('Unknown message type:', data.type);
    }
  }, []);

  // --- Setup and maintain WebSocket connection ---
  const connectWebSocket = useCallback(() => {
    try {
      const ws = new WebSocket('ws://localhost:8765'); // same endpoint as backend
      wsRef.current = ws;

      // on connection open
      ws.onopen = () => {
        console.log('WebSocket Connected');
        setConnected(true);
        setWsStatus('Connected');
      };

      // on message from backend, parse JSON and dispatch
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleWebSocketMessage(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      // error handling
      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setWsStatus('Error');
      };

      // closed -> attempt reconnect after delay
      ws.onclose = () => {
        console.log('WebSocket Disconnected');
        setConnected(false);
        setWsStatus('Disconnected');

        reconnectTimeoutRef.current = setTimeout(() => {
          console.log('Attempting to reconnect...');
          setWsStatus('Reconnecting...');
          connectWebSocket(); // try again
        }, 5000);
      };
    } catch (error) {
      console.error('Failed to connect WebSocket:', error);
      setWsStatus('Failed');
    }
  }, [handleWebSocketMessage]);

  // connect on mount, clean up on unmount
  useEffect(() => {
    connectWebSocket();
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    };
  }, [connectWebSocket]);

  // --- Data handlers (basic) ---
  // Append new candle to local chart state and keep last 30 candles
  const handleCandleUpdate = (candle) => {
    // add candle to chart data (backend is source of truth)
    setCandleData(prevData => {
      const newData = [...prevData, candle];
      return newData.slice(-30);
    });
    // set latest candle for UI details
    setCurrentCandle(candle);

    // After we save the candle locally, run FVG-touch & invalidation checks
    detectFVGInteractions(candle);
  };

  // Replace FVG lists when backend sends authoritative list
  const handleFVGUpdate = (fvgs) => {
    setBullishFVGs(fvgs.bullish || []);
    setBearishFVGs(fvgs.bearish || []);
    // clear local touched list if zones changed (keeps UI consistent)
    setTouchedFVGs([]);
  };

  // update position object
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

  // add executed trade to history (keep max 20)
  const handleTradeExecuted = (trade) => {
    setTradeHistory(prevHistory => [trade, ...prevHistory].slice(0, 20));
  };

  
  // --- Candle metric helper (unchanged) ---
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

  // --- NEW: Detect wick touches / full submersion of FVGs on incoming candle ---
  const firstCandleIndex = candleData.length > 0 ? candleData[0].index : 0;

  const mapAbsoluteIndexToChartIndex = (absoluteIndex) => {
    const relativeIndex = absoluteIndex - firstCandleIndex;

    if (relativeIndex >= 0 && relativeIndex < candleData.length){
      return relativeIndex;
    }
    return null;
  }

  const detectFVGInteractions = (candle) => {
    if (!candle) return;

    // helper: determine if a candle's wick (low) touches a bullish FVG zone
    const checkBullishTouch = (fvg, candle) => {
      // wick touch: candle.low is within [fvg.low, fvg.high]
      return (candle.low >= fvg.low) && (candle.low <= fvg.high);
    };
    // helper: determine if a candle fully submerges (entire range inside) an fvg
    const candleFullySubmergesFvg = (fvg, candle) => {
      // full submerge: candle.high <= fvg.high AND candle.low >= fvg.low
      return (candle.high <= fvg.high) && (candle.low >= fvg.low);
    };
    // helper: bullish orderflow check using SMA if available
    const isBullishOrderflow = () => {
      if (sma === null || sma === undefined) return true; // default to bullish if unknown
      return candle.close > sma;
    };

    const newTouched = [];   // accumulate new touches to highlight in UI
  

    // --- Check bullish FVGs for wick-touch / full-submerge ---
    bullishFVGs.forEach((fvg) => {
      try {
        // if the candle fully submerges the FVG -> remove it locally and tell backend (invalidate)
        if (candleFullySubmergesFvg(fvg, candle)) {
          // remove locally
          setBullishFVGs(prev => prev.filter(x => !(x.low === fvg.low && x.high === fvg.high)));
          // notify backend (optional helper message)
          sendWebSocketMessage({ type: 'invalidate_fvg', payload: { type: 'bullish', low: fvg.low, high: fvg.high } });
          console.log('Removed bullish FVG due to full submerge:', fvg);
        } else if (checkBullishTouch(fvg, candle)) {
          // wick touched the FVG
          newTouched.push({ ...fvg, side: 'bullish' });
          // notify backend optionally that a wick touched the FVG
          sendWebSocketMessage({ type: 'fvg_touch', payload: { type: 'bullish', low: fvg.low, high: fvg.high, candle } });
          // If orderflow is bullish and tradingEnabled, highlight and optionally auto-confirm entry
          if (isBullishOrderflow() && tradingEnabled && autoConfirm) {
            // If backend expects user confirmation, frontend auto-confirms for testing
            sendWebSocketMessage({ type: 'trade_confirmation', payload: { confirmed: true, signal_type: 'entry' } });
          }
        }
      } catch (e) {
        console.warn('Error checking bullish FVG interaction', e);
      }
    });

    // --- Check bearish FVGs for wick-touch / full-submerge (mirrored logic) ---
    bearishFVGs.forEach((fvg) => {
      try {
        // full submerge -> remove locally + notify backend
        if (candleFullySubmergesFvg(fvg, candle)) {
          setBearishFVGs(prev => prev.filter(x => !(x.low === fvg.low && x.high === fvg.high)));
          sendWebSocketMessage({ type: 'invalidate_fvg', payload: { type: 'bearish', low: fvg.low, high: fvg.high } });
          console.log('Removed bearish FVG due to full submerge:', fvg);
        } else {
          // bearish wick-touch is when candle.high is inside fvg
          const bearishWickTouch = (c, f) => (c.high >= f.low) && (c.high <= f.high);
          if (bearishWickTouch(candle, fvg)) {
            newTouched.push({ ...fvg, side: 'bearish' });
            sendWebSocketMessage({ type: 'fvg_touch', payload: { type: 'bearish', low: fvg.low, high: fvg.high, candle } });
            // if orderflow bearish and trading enabled + autoConfirm -> auto-confirm exit/entry
            if (!isBullishOrderflow() && tradingEnabled && autoConfirm) {
              sendWebSocketMessage({ type: 'trade_confirmation', payload: { confirmed: true, signal_type: 'entry' } });
            }
          }
        }
      } catch (e) {
        console.warn('Error checking bearish FVG interaction', e);
      }
    });

    // merge newly touched FVGs into local touchedFVGs state (for highlight)
    if (newTouched.length > 0) {
      setTouchedFVGs(prev => {
        // keep unique touched zones by low+high; newest touches first
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
        // keep only recent handful
        return uniq.slice(0, 20);
      });
    }
  };

  // --- UI handlers for user confirming/declining signals (modal) ---
  const handleConfirmTrade = (confirm) => {
    // send confirmation to backend (backend is authoritative and will act)
    sendWebSocketMessage({
      type: 'trade_confirmation',
      payload: {
        confirmed: confirm,
        signal_type: pendingSignal?.type
      }
    });
    // close pending modal locally
    setPendingSignal(null);
  };

  // toggle trading on/off (sends request to backend to toggle)
  const toggleTrading = () => {
    const newStatus = !tradingEnabled;
    sendWebSocketMessage({ type: 'toggle_trading', payload: { enabled: newStatus } });
    setTradingEnabled(newStatus);
  };

  // --- Custom candlestick renderer (kept from your code, minor local tweaks) ---
  const CustomCandlestick = ({ data }) => {
    const chartData = data.map(candle => ({
      ...candle,
      isGreen: candle.close >= candle.open,
      bodyLow: Math.min(candle.open, candle.close),
      bodyHigh: Math.max(candle.open, candle.close),
    }));

    // same CandlestickShape as before; unchanged
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
      const candleWidth = Math.max(width * 0.6, 6);
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
                  <XAxis 
                      dataKey="index" // Use 'index' as the dataKey for proper ReferenceArea alignment
                      stroke="#9CA3AF" 
                      tick={{ fill: '#9CA3AF', fontSize: 11 }} 
                      interval="preserveStartEnd" 
                      // Use a formatter to show the readable time instead of the number index
                      tickFormatter={(index) => {
                          const candle = candleData.find(c => c.index === index);
                          return candle ? candle.time : '';
                      }}
                  />
                  <YAxis domain={['dataMin - 2', 'dataMax + 2']} stroke="#9CA3AF" tick={{ fill: '#9CA3AF', fontSize: 11 }} />
                  
                  {/* Custom Tooltip remains here */}
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

            {/* draw SMA if present */}
            {sma && (
              <ReferenceLine y={sma} stroke="#F59E0B" strokeWidth={2} strokeDasharray="5 5" label={{ value: `SMA: $${sma.toFixed(2)}`, fill: '#F59E0B', fontSize: 11 }} />
            )}

            {/* draw bullish FVGs (backend authoritative) */}
            {bullishFVGs.map((fvg, index) => {
                const startIdx = mapAbsoluteIndexToChartIndex(fvg.candle1_index);
                const endIdx = mapAbsoluteIndexToChartIndex(fvg.candle3_index);
                
                if (startIdx !== null && endIdx !== null) {
                    return (
                        <ReferenceArea
                            key={`b-fvg-${index}`}
                            x1={startIdx} // X-axis start (relative index of Candle 1)
                            x2={endIdx}   // X-axis end (relative index of Candle 3)
                            y1={fvg.low}  // Y-axis lower price (Candle 1 High)
                            y2={fvg.high} // Y-axis upper price (Candle 3 Low)
                            fill="#4caf50" // Green
                            fillOpacity={0.15}
                            stroke="#4caf50"
                            strokeOpacity={0.7}
                        />
                    );
                }
                return null;
            })}

            {/* draw bearish FVGs */}
            {bearishFVGs.map((fvg, idx) => (
              <ReferenceArea key={`bear-${idx}`} y1={fvg.low} y2={fvg.high} fill="#EF4444" fillOpacity={0.12} stroke="#EF4444" strokeWidth={1.5} strokeDasharray="4 4" />
            ))}

            {/* visually highlight touched FVGs (local detection) */}
            {touchedFVGs.map((fvg, idx) => (
              <ReferenceArea
                key={`touched-${idx}`}
                y1={fvg.low}
                y2={fvg.high}
                stroke={fvg.side === 'bullish' ? '#34D399' : '#F87171'}
                strokeWidth={2}
                strokeDasharray="2 2"
                fill={fvg.side === 'bullish' ? '#34D399' : '#F87171'}
                fillOpacity={0.06}
              />
            ))}

            {/* position entry and stop visuals */}
            {position && (
              <ReferenceLine y={position.entryPrice} stroke="#8B5CF6" strokeWidth={2} strokeDasharray="8 4" label={{ value: `Entry: $${position.entryPrice.toFixed(2)}`, fill: '#8B5CF6', fontSize: 11 }} />
            )}
            {position && (
              <ReferenceLine y={position.entryPrice * 0.98} stroke="#DC2626" strokeWidth={2} strokeDasharray="4 4" label={{ value: `Stop: $${(position.entryPrice * 0.98).toFixed(2)}`, fill: '#DC2626', fontSize: 10 }} />
            )}

            {/* invisible high & low lines used for scale but not drawn */}
            <Line type="monotone" dataKey="high" stroke="transparent" dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="low" stroke="transparent" dot={false} isAnimationActive={false} />

            {/* draw custom candlesticks */}
            <Bar dataKey="bodyLow" fill="transparent" shape={CandlestickShape} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>

        {/* legend */}
        <div className="absolute top-6 left-6 bg-gray-800 bg-opacity-95 rounded-lg px-3 py-2 text-xs shadow-lg border border-gray-700">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="w-4 h-3 bg-green-500 rounded border border-green-600"></div>
              <span className="text-gray-300 font-semibold">Bullish</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-3 bg-red-500 rounded border border-red-600"></div>
              <span className="text-gray-300 font-semibold">Bearish</span>
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

  // --- MAIN JSX returned by App ---
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header with connection & trading toggle */}
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-white flex items-center gap-3">
              <BarChart3 className="text-blue-500" size={36} />
              FVG Trading Dashboard
            </h1>
            <p className="text-gray-400 mt-1">Real-time Fair Value Gap Strategy Monitor</p>
          </div>

          {/* connection & control area */}
          <div className="flex items-center gap-4">
            <div className={`flex items-center gap-2 px-4 py-2 rounded-lg ${connected ? 'bg-green-900 bg-opacity-30' : 'bg-red-900 bg-opacity-30'}`}>
              {connected ? <Wifi className="text-green-500" size={20} /> : <WifiOff className="text-red-500" size={20} />}
              <span className={`text-sm font-semibold ${connected ? 'text-green-400' : 'text-red-400'}`}>{wsStatus}</span>
            </div>

            {/* trading on/off + auto confirm toggle for testing */}
            <div className="flex items-center gap-2">
              <button onClick={toggleTrading} disabled={!connected} className={`flex items-center gap-2 px-6 py-3 rounded-lg font-semibold transition-all ${!connected ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : tradingEnabled ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}`}>
                {tradingEnabled ? <PlayCircle size={20} /> : <PauseCircle size={20} />}
                {tradingEnabled ? 'Trading Active' : 'Trading Paused'}
              </button>

              {/* autoConfirm toggle - only for dev/testing - default false */}
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={autoConfirm} onChange={(e) => setAutoConfirm(e.target.checked)} />
                <span>Auto-confirm</span>
              </label>
            </div>
          </div>
        </div>

        {/* connection warning when disconnected */}
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

        {/* Dashboard summary cards */}
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

        {/* Chart */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
          <h2 className="text-xl font-bold text-white mb-4">SPY - 15 Minute Chart</h2>
          {candleData.length > 0 ? <CustomCandlestick data={candleData} /> : <div className="h-96 flex items-center justify-center text-gray-500"><p>Waiting for market data...</p></div>}
        </div>

        {/* current candle analysis */}
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

        {/* active position view */}
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

        {/* trade history table */}
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

        {/* Pending signal modal (backend -> frontend) */}
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

export default App;
