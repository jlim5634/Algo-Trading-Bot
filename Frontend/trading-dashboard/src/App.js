import React, { useState, useEffect, useRef, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine, ReferenceArea } from 'recharts';
import { TrendingUp, TrendingDown, Activity, DollarSign, BarChart3, AlertTriangle, PlayCircle, PauseCircle, Wifi, WifiOff } from 'lucide-react';
import './App.css';

function App() {
  const [candleData, setCandleData] = useState([]);
  const [currentCandle, setCurrentCandle] = useState(null);
  const [position, setPosition] = useState(null);
  const [bullishFVGs, setBullishFVGs] = useState([]);
  const [bearishFVGs, setBearishFVGs] = useState([]);
  const [tradeHistory, setTradeHistory] = useState([]);
  const [portfolioValue, setPortfolioValue] = useState(100000);
  const [sma, setSma] = useState(null);
  const [tradingEnabled, setTradingEnabled] = useState(true);
  const [pendingSignal, setPendingSignal] = useState(null);
  const [connected, setConnected] = useState(false);
  const [wsStatus, setWsStatus] = useState('Disconnected');
  
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

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
        setPendingSignal({
          type: 'entry',
          ...data.payload
        });
        break;
      
      case 'exit_signal':
        setPendingSignal({
          type: 'exit',
          ...data.payload
        });
        break;
      
      case 'signal_timeout':
        setPendingSignal(null);
        break;
      
      default:
        console.log('Unknown message type:', data.type);
    }
  }, []);

  const connectWebSocket = useCallback(() => {
    try {
      // Replace with your backend WebSocket URL
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
        
        // Attempt to reconnect after 5 seconds
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

  // WebSocket connection
  useEffect(() => {
    connectWebSocket();
    
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [connectWebSocket]);

  const handleCandleUpdate = (candle) => {
    setCandleData(prevData => {
      const newData = [...prevData, candle];
      // Keep only last 30 candles
      return newData.slice(-30);
    });
    setCurrentCandle(candle);
  };

  const handleFVGUpdate = (fvgs) => {
    setBullishFVGs(fvgs.bullish || []);
    setBearishFVGs(fvgs.bearish || []);
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

  const sendWebSocketMessage = (message) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      console.error('WebSocket is not connected');
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
    sendWebSocketMessage({
      type: 'toggle_trading',
      payload: { enabled: newStatus }
    });
    setTradingEnabled(newStatus);
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

  const CustomCandlestick = ({ data }) => {
    return (
      <div className="relative h-96 bg-gray-900 rounded-lg p-4">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis 
              dataKey="time" 
              stroke="#9CA3AF"
              tick={{ fill: '#9CA3AF', fontSize: 12 }}
            />
            <YAxis 
              domain={['auto', 'auto']}
              stroke="#9CA3AF"
              tick={{ fill: '#9CA3AF', fontSize: 12 }}
            />
            <Tooltip 
              contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #374151', borderRadius: '8px' }}
              labelStyle={{ color: '#F3F4F6' }}
            />
            <Legend />
            
            {/* SMA Line */}
            {sma && <ReferenceLine y={sma} stroke="#F59E0B" strokeDasharray="5 5" label={{ value: `SMA: ${sma}`, fill: '#F59E0B', fontSize: 12 }} />}
            
            {/* Bullish FVGs */}
            {bullishFVGs.map((fvg, idx) => (
              <ReferenceArea
                key={`bull-${idx}`}
                y1={fvg.low}
                y2={fvg.high}
                fill="#10B981"
                fillOpacity={0.2}
                stroke="#10B981"
                strokeWidth={2}
                strokeDasharray="3 3"
                label={{ value: `FVG (Age: ${fvg.age})`, fill: '#10B981', fontSize: 10 }}
              />
            ))}
            
            {/* Bearish FVGs */}
            {bearishFVGs.map((fvg, idx) => (
              <ReferenceArea
                key={`bear-${idx}`}
                y1={fvg.low}
                y2={fvg.high}
                fill="#EF4444"
                fillOpacity={0.2}
                stroke="#EF4444"
                strokeWidth={2}
                strokeDasharray="3 3"
                label={{ value: `FVG (Age: ${fvg.age})`, fill: '#EF4444', fontSize: 10 }}
              />
            ))}
            
            {/* Position Entry Line */}
            {position && (
              <ReferenceLine 
                y={position.entryPrice} 
                stroke="#8B5CF6" 
                strokeWidth={2}
                strokeDasharray="8 4"
                label={{ value: `Entry: $${position.entryPrice.toFixed(2)}`, fill: '#8B5CF6', fontSize: 12 }} 
              />
            )}
            
            {/* Stop Loss Line */}
            {position && (
              <ReferenceLine 
                y={position.entryPrice * 0.98} 
                stroke="#DC2626" 
                strokeWidth={2}
                strokeDasharray="4 4"
                label={{ value: `Stop Loss`, fill: '#DC2626', fontSize: 10 }} 
              />
            )}
            
            <Line 
              type="monotone" 
              dataKey="close" 
              stroke="#3B82F6" 
              strokeWidth={2}
              dot={{ fill: '#3B82F6', r: 3 }}
              name="Close Price"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Header */}
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-white flex items-center gap-3">
              <BarChart3 className="text-blue-500" size={36} />
              FVG Trading Dashboard
            </h1>
            <p className="text-gray-400 mt-1">Real-time Fair Value Gap Strategy Monitor</p>
          </div>
          <div className="flex items-center gap-4">
            {/* Connection Status */}
            <div className={`flex items-center gap-2 px-4 py-2 rounded-lg ${
              connected ? 'bg-green-900 bg-opacity-30' : 'bg-red-900 bg-opacity-30'
            }`}>
              {connected ? <Wifi className="text-green-500" size={20} /> : <WifiOff className="text-red-500" size={20} />}
              <span className={`text-sm font-semibold ${connected ? 'text-green-400' : 'text-red-400'}`}>
                {wsStatus}
              </span>
            </div>
            
            {/* Trading Toggle */}
            <button
              onClick={toggleTrading}
              disabled={!connected}
              className={`flex items-center gap-2 px-6 py-3 rounded-lg font-semibold transition-all ${
                !connected ? 'bg-gray-700 text-gray-500 cursor-not-allowed' :
                tradingEnabled 
                  ? 'bg-green-600 hover:bg-green-700' 
                  : 'bg-red-600 hover:bg-red-700'
              }`}
            >
              {tradingEnabled ? <PlayCircle size={20} /> : <PauseCircle size={20} />}
              {tradingEnabled ? 'Trading Active' : 'Trading Paused'}
            </button>
          </div>
        </div>

        {/* Connection Warning */}
        {!connected && (
          <div className="bg-yellow-900 bg-opacity-30 border border-yellow-600 rounded-lg p-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="text-yellow-500" size={24} />
              <div>
                <p className="text-yellow-400 font-semibold">Not Connected to Backend</p>
                <p className="text-yellow-300 text-sm">
                  Make sure your Python trading bot is running with WebSocket server enabled.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Stats Cards */}
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
                <p className="text-2xl font-bold text-white">
                  {position ? `${position.quantity} SPY` : 'None'}
                </p>
              </div>
              <Activity className="text-blue-500" size={32} />
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-sm">Active FVGs</p>
                <p className="text-2xl font-bold text-white">
                  <span className="text-green-500">{bullishFVGs.length}</span> / <span className="text-red-500">{bearishFVGs.length}</span>
                </p>
              </div>
              <TrendingUp className="text-purple-500" size={32} />
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-sm">Current Price</p>
                <p className="text-2xl font-bold text-white">
                  {currentCandle ? `$${currentCandle.close.toFixed(2)}` : '--'}
                </p>
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
          {candleData.length > 0 ? (
            <>
              <CustomCandlestick data={candleData} />
              
              {/* Legend */}
              <div className="flex gap-6 mt-4 justify-center flex-wrap">
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 bg-green-500 opacity-40 border-2 border-green-500"></div>
                  <span className="text-sm text-gray-300">Bullish FVG</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 bg-red-500 opacity-40 border-2 border-red-500"></div>
                  <span className="text-sm text-gray-300">Bearish FVG</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-16 h-0.5 bg-amber-500" style={{ borderTop: '2px dashed' }}></div>
                  <span className="text-sm text-gray-300">SMA-20</span>
                </div>
                {position && (
                  <>
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-0.5 bg-purple-500" style={{ borderTop: '2px dashed' }}></div>
                      <span className="text-sm text-gray-300">Entry Price</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-0.5 bg-red-600" style={{ borderTop: '2px dashed' }}></div>
                      <span className="text-sm text-gray-300">Stop Loss</span>
                    </div>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="h-96 flex items-center justify-center text-gray-500">
              <p>Waiting for market data...</p>
            </div>
          )}
        </div>

        {/* Current Candle Analysis */}
        {metrics && currentCandle && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <h2 className="text-xl font-bold text-white mb-4">📊 Current Candle Analysis</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-gray-400 text-sm">Open</p>
                <p className="text-lg font-semibold text-white">${currentCandle.open.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-gray-400 text-sm">High</p>
                <p className="text-lg font-semibold text-white">${currentCandle.high.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-gray-400 text-sm">Low</p>
                <p className="text-lg font-semibold text-white">${currentCandle.low.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-gray-400 text-sm">Close</p>
                <p className="text-lg font-semibold text-white">${currentCandle.close.toFixed(2)}</p>
              </div>
            </div>
            
            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-gray-400 text-sm">Direction</p>
                <p className={`text-lg font-semibold ${metrics.bodyDirection === 'bullish' ? 'text-green-500' : 'text-red-500'}`}>
                  {metrics.bodyDirection === 'bullish' ? '🟢 BULLISH' : '🔴 BEARISH'}
                </p>
              </div>
              <div>
                <p className="text-gray-400 text-sm">Body Size</p>
                <p className="text-lg font-semibold text-white">${metrics.bodySize.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-gray-400 text-sm">Upper Wick</p>
                <p className="text-lg font-semibold text-white">${metrics.upperWick.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-gray-400 text-sm">Lower Wick</p>
                <p className="text-lg font-semibold text-white">${metrics.lowerWick.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-gray-400 text-sm">Total Range</p>
                <p className="text-lg font-semibold text-white">${metrics.totalRange.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-gray-400 text-sm">Body/Range Ratio</p>
                <p className="text-lg font-semibold text-white">{metrics.bodyToRangeRatio.toFixed(1)}%</p>
              </div>
            </div>

            {/* Visual Candle */}
            <div className="mt-6 flex justify-center">
              <div className="text-center">
                <p className="text-gray-400 text-sm mb-2">Visual Representation</p>
                <div className="inline-block bg-gray-800 p-6 rounded-lg">
                  <div className="flex flex-col items-center font-mono text-sm">
                    <div className="text-gray-400">|  ← Upper Wick (${metrics.upperWick.toFixed(2)})</div>
                    <div className={`border-2 ${metrics.bodyDirection === 'bullish' ? 'border-green-500 bg-green-900' : 'border-red-500 bg-red-900'} px-8 py-4 my-1`}>
                      <span className={metrics.bodyDirection === 'bullish' ? 'text-green-400' : 'text-red-400'}>
                        {metrics.bodyDirection === 'bullish' ? '↑' : '↓'}
                      </span>
                    </div>
                    <div className="text-gray-400">|  ← Lower Wick (${metrics.lowerWick.toFixed(2)})</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Position Info */}
        {position && currentCandle && (
          <div className="bg-gray-900 border border-yellow-600 rounded-lg p-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="text-yellow-500 flex-shrink-0" size={24} />
              <div className="flex-1">
                <h3 className="text-lg font-bold text-white mb-2">Active Position</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <p className="text-gray-400 text-sm">Quantity</p>
                    <p className="text-white font-semibold">{position.quantity} shares</p>
                  </div>
                  <div>
                    <p className="text-gray-400 text-sm">Entry Price</p>
                    <p className="text-white font-semibold">${position.entryPrice.toFixed(2)}</p>
                  </div>
                  <div>
                    <p className="text-gray-400 text-sm">Current P/L</p>
                    <p className={`font-semibold ${currentCandle.close > position.entryPrice ? 'text-green-500' : 'text-red-500'}`}>
                      ${((currentCandle.close - position.entryPrice) * position.quantity).toFixed(2)}
                      {' '}
                      ({(((currentCandle.close - position.entryPrice) / position.entryPrice) * 100).toFixed(2)}%)
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-400 text-sm">Stop Loss</p>
                    <p className="text-red-400 font-semibold">${(position.entryPrice * 0.98).toFixed(2)}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Trade History */}
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
                      <td className="py-3">
                        <span className={`px-2 py-1 rounded text-xs font-semibold ${
                          trade.side === 'BUY' ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'
                        }`}>
                          {trade.side}
                        </span>
                      </td>
                      <td className="py-3 text-gray-300">{trade.quantity}</td>
                      <td className="py-3 text-gray-300">${trade.price.toFixed(2)}</td>
                      <td className="py-3 text-gray-300">${trade.total.toFixed(2)}</td>
                      <td className="py-3">
                        {trade.pl !== undefined && trade.pl !== '' && (
                          <span className={parseFloat(trade.pl) >= 0 ? 'text-green-500 font-semibold' : 'text-red-500 font-semibold'}>
                            ${parseFloat(trade.pl).toFixed(2)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-gray-500 text-center py-8">No trades yet</p>
          )}
        </div>

        {/* Pending Signal Modal */}
        {pendingSignal && (
          <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
            <div className="bg-gray-900 border-2 border-blue-500 rounded-lg p-8 max-w-md w-full mx-4 shadow-2xl">
              <h3 className="text-2xl font-bold text-white mb-4">
                {pendingSignal.type === 'entry' ? '🚀 Entry Signal' : '📤 Exit Signal'}
              </h3>
              <div className="space-y-2 mb-6">
                <p className="text-gray-300">Symbol: <span className="text-white font-semibold">{pendingSignal.symbol || 'SPY'}</span></p>
                <p className="text-gray-300">Current Price: <span className="text-white font-semibold">${pendingSignal.price?.toFixed(2)}</span></p>
                <p className="text-gray-300">Quantity: <span className="text-white font-semibold">{pendingSignal.quantity} shares</span></p>
                <p className="text-gray-300">Total: <span className="text-white font-semibold">${(pendingSignal.quantity * pendingSignal.price).toFixed(2)}</span></p>
                {pendingSignal.type === 'exit' && pendingSignal.pl !== undefined && (
                  <p className="text-gray-300">P/L: <span className={`font-semibold ${pendingSignal.pl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                    ${pendingSignal.pl.toFixed(2)} ({pendingSignal.pl_pct?.toFixed(2)}%)
                  </span></p>
                )}
                {pendingSignal.type === 'entry' && (
                  <p className="text-gray-300">Stop Loss: <span className="text-red-400 font-semibold">${(pendingSignal.price * 0.98).toFixed(2)}</span></p>
                )}
              </div>
              <div className="flex gap-4">
                <button
                  onClick={() => handleConfirmTrade(true)}
                  className="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-lg transition-colors"
                >
                  ✓ Confirm
                </button>
                <button
                  onClick={() => handleConfirmTrade(false)}
                  className="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-3 rounded-lg transition-colors"
                >
                  ✗ Decline
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
};

export default App;