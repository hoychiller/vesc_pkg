/* MT5 Order Simulator - Core Logic */

// ─── STATE ────────────────────────────────────────────────────────────────────
const STATE = {
  symbol: 'BTCUSD',
  tf: 60,
  candles: [],
  simIndex: 0,
  simRunning: false,
  simInterval: null,
  simSpeed: 5,
  currentPrice: 0,
  gridSize: 200,
  gridVisible: true,
  gridOpacity: 0.15,
  selectedOrderType: 'market',
  orders: [],
  nextOrderId: 1,
  account: { balance: 10000, equity: 10000, margin: 0 },
  indicators: { ma20: true, ma50: true, ma200: false, bb: false, rsi: false, macd: false, vol: true },
  series: {},
  chart: null,
  candleSeries: null,
  volumeSeries: null,
  ocoGroups: [],   // { id, orderIds: [a, b] }
  otoGroups: [],   // { id, trigger: orderId, child: orderId }
};

// ─── CHART INIT ───────────────────────────────────────────────────────────────
function initChart() {
  const container = document.getElementById('chart');
  STATE.chart = LightweightCharts.createChart(container, {
    layout: { background: { color: '#0d1117' }, textColor: '#c9d1d9' },
    grid: { vertLines: { color: '#1c2128' }, horzLines: { color: '#1c2128' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#30363d' },
    timeScale: { borderColor: '#30363d', timeVisible: true },
    handleScroll: true, handleScale: true,
  });

  STATE.candleSeries = STATE.chart.addCandlestickSeries({
    upColor: '#3fb950', downColor: '#f85149',
    borderUpColor: '#3fb950', borderDownColor: '#f85149',
    wickUpColor: '#3fb950', wickDownColor: '#f85149',
  });

  STATE.volumeSeries = STATE.chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: 'vol',
    color: '#30363d',
  });
  STATE.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

  STATE.chart.subscribeCrosshairMove(onCrosshairMove);
  window.addEventListener('resize', resizeAll);
  resizeAll();
}

// ─── CANDLE GENERATION ───────────────────────────────────────────────────────
const SYMBOL_PARAMS = {
  BTCUSD: { base: 65000, vol: 1200, pip: 1 },
  ETHUSD: { base: 3200,  vol: 80,   pip: 0.1 },
  EURUSD: { base: 1.085, vol: 0.003, pip: 0.0001 },
  XAUUSD: { base: 2300,  vol: 20,   pip: 0.01 },
};

function generateCandles(symbol, tf, count = 300) {
  const p = SYMBOL_PARAMS[symbol] || SYMBOL_PARAMS.BTCUSD;
  const candles = [];
  const now = Math.floor(Date.now() / 1000);
  const interval = tf * 60;
  let price = p.base + (Math.random() - 0.5) * p.base * 0.05;

  for (let i = count; i >= 0; i--) {
    const time = now - i * interval;
    const change = (Math.random() - 0.5) * p.vol;
    const open = price;
    const close = open + change;
    const range = Math.abs(change) * (1 + Math.random());
    const high = Math.max(open, close) + Math.random() * range * 0.5;
    const low  = Math.min(open, close) - Math.random() * range * 0.5;
    const volume = Math.floor(1000 + Math.random() * 5000);
    candles.push({ time, open, high, low, close, volume });
    price = close;
  }
  return candles;
}

// ─── INDICATORS ──────────────────────────────────────────────────────────────
function calcSMA(candles, period) {
  return candles.map((c, i) => {
    if (i < period - 1) return null;
    const sum = candles.slice(i - period + 1, i + 1).reduce((a, b) => a + b.close, 0);
    return { time: c.time, value: sum / period };
  }).filter(Boolean);
}

function calcBB(candles, period = 20, mult = 2) {
  const upper = [], middle = [], lower = [];
  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b.close, 0) / period;
    const std = Math.sqrt(slice.reduce((a, b) => a + (b.close - mean) ** 2, 0) / period);
    upper.push({ time: candles[i].time, value: mean + mult * std });
    middle.push({ time: candles[i].time, value: mean });
    lower.push({ time: candles[i].time, value: mean - mult * std });
  }
  return { upper, middle, lower };
}

function calcRSI(candles, period = 14) {
  const rsi = [];
  for (let i = period; i < candles.length; i++) {
    let gains = 0, losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = candles[j].close - candles[j-1].close;
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const rs = gains / (losses || 0.001);
    rsi.push({ time: candles[i].time, value: 100 - 100 / (1 + rs) });
  }
  return rsi;
}

function calcMACD(candles) {
  const ema = (data, period) => {
    const k = 2 / (period + 1), result = [];
    let prev = data[0].close;
    for (const c of data) { prev = c.close * k + prev * (1 - k); result.push({ time: c.time, value: prev }); }
    return result;
  };
  const ema12 = ema(candles, 12), ema26 = ema(candles, 26);
  const macdLine = candles.slice(25).map((c, i) => ({ time: c.time, value: ema12[i+25].value - ema26[i+25].value }));
  return macdLine;
}

function ensureSeries(key, type, opts) {
  if (!STATE.series[key]) {
    STATE.series[key] = type === 'line'
      ? STATE.chart.addLineSeries(opts)
      : STATE.chart.addHistogramSeries(opts);
  }
  return STATE.series[key];
}

function removeSeries(key) {
  if (STATE.series[key]) {
    STATE.chart.removeSeries(STATE.series[key]);
    delete STATE.series[key];
  }
}

function renderIndicators(candles) {
  const { indicators: ind } = STATE;

  if (ind.ma20) {
    ensureSeries('ma20','line',{color:'#f0a500',lineWidth:1,title:'MA20'}).setData(calcSMA(candles,20));
  } else removeSeries('ma20');

  if (ind.ma50) {
    ensureSeries('ma50','line',{color:'#58a6ff',lineWidth:1,title:'MA50'}).setData(calcSMA(candles,50));
  } else removeSeries('ma50');

  if (ind.ma200) {
    ensureSeries('ma200','line',{color:'#a371f7',lineWidth:1,title:'MA200'}).setData(calcSMA(candles,200));
  } else removeSeries('ma200');

  if (ind.bb) {
    const bb = calcBB(candles);
    ensureSeries('bb_upper','line',{color:'#3fb950',lineWidth:1,lineStyle:2,title:'BB+'}).setData(bb.upper);
    ensureSeries('bb_mid','line',{color:'#3fb950',lineWidth:1,title:'BB'}).setData(bb.middle);
    ensureSeries('bb_lower','line',{color:'#3fb950',lineWidth:1,lineStyle:2,title:'BB-'}).setData(bb.lower);
  } else { removeSeries('bb_upper'); removeSeries('bb_mid'); removeSeries('bb_lower'); }

  if (ind.vol) {
    const volData = candles.map(c => ({ time: c.time, value: c.volume, color: c.close >= c.open ? '#1f3a1f' : '#3a1f1f' }));
    STATE.volumeSeries.setData(volData);
  } else STATE.volumeSeries.setData([]);

  // RSI & MACD would need sub-charts — simplified: log to console for now
}

// ─── LOAD SYMBOL ─────────────────────────────────────────────────────────────
function loadSymbol() {
  STATE.symbol = document.getElementById('symbol-select').value;
  STATE.tf = parseInt(document.getElementById('tf-select').value);
  STATE.candles = generateCandles(STATE.symbol, STATE.tf, 400);
  STATE.simIndex = STATE.candles.length - 1;
  STATE.currentPrice = STATE.candles[STATE.simIndex].close;
  document.getElementById('current-price').textContent = formatPrice(STATE.currentPrice);

  const visible = STATE.candles.slice(0, STATE.simIndex + 1);
  STATE.candleSeries.setData(visible);
  renderIndicators(visible);
  drawGrid();
  updateBarInfo(STATE.candles[STATE.simIndex]);
  renderOrderTable();
}

// ─── SIMULATION ───────────────────────────────────────────────────────────────
function startSimulation() {
  if (STATE.simRunning) return;
  STATE.simRunning = true;
  document.getElementById('btn-sim-start').style.display = 'none';
  document.getElementById('btn-sim-stop').style.display = '';
  document.getElementById('sim-status').textContent = '● Läuft';
  document.getElementById('sim-status').className = 'running';

  // Extend candles for future playback
  STATE.candles = STATE.candles.slice(0, STATE.simIndex + 1);
  const p = SYMBOL_PARAMS[STATE.symbol];
  const interval = STATE.tf * 60;
  const lastTime = STATE.candles[STATE.candles.length - 1].time;
  let price = STATE.currentPrice;

  for (let i = 1; i <= 200; i++) {
    const change = (Math.random() - 0.485) * p.vol;
    const open = price;
    const close = open + change;
    const range = Math.abs(change) * (1 + Math.random());
    const high = Math.max(open, close) + Math.random() * range * 0.5;
    const low  = Math.min(open, close) - Math.random() * range * 0.5;
    STATE.candles.push({ time: lastTime + i * interval, open, high, low, close, volume: Math.floor(800+Math.random()*4000) });
    price = close;
  }

  const delay = () => Math.max(50, 600 - (STATE.simSpeed - 1) * 60);
  const tick = () => {
    if (!STATE.simRunning) return;
    STATE.simIndex++;
    if (STATE.simIndex >= STATE.candles.length) { stopSimulation(); return; }

    const c = STATE.candles[STATE.simIndex];
    STATE.currentPrice = c.close;
    const visible = STATE.candles.slice(0, STATE.simIndex + 1);
    STATE.candleSeries.setData(visible);
    renderIndicators(visible);
    updateBarInfo(c);
    document.getElementById('current-price').textContent = formatPrice(c.close);
    document.getElementById('current-time').textContent = new Date(c.time * 1000).toLocaleString('de-DE', { hour:'2-digit', minute:'2-digit', day:'2-digit', month:'2-digit' });

    checkOrders(c);
    updateStats();
    drawGrid();
    STATE.simInterval = setTimeout(tick, delay());
  };
  STATE.simInterval = setTimeout(tick, delay());
}

function stopSimulation() {
  STATE.simRunning = false;
  clearTimeout(STATE.simInterval);
  document.getElementById('btn-sim-start').style.display = '';
  document.getElementById('btn-sim-stop').style.display = 'none';
  document.getElementById('sim-status').textContent = '● Bereit';
  document.getElementById('sim-status').className = 'stopped';
}

function resetSimulation() {
  stopSimulation();
  STATE.orders = [];
  STATE.ocoGroups = [];
  STATE.otoGroups = [];
  STATE.account = { balance: 10000, equity: 10000, margin: 0 };
  STATE.nextOrderId = 1;
  document.getElementById('log-entries').innerHTML = '';
  loadSymbol();
  updateStats();
}

// ─── ORDER MANAGEMENT ─────────────────────────────────────────────────────────
function selectOrderType(btn, type) {
  document.querySelectorAll('.order-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  STATE.selectedOrderType = type;
  document.getElementById('trigger-price-row').style.display = ['oco','oto'].includes(type) ? 'flex' : 'none';
}

function placeOrder(price, type, opts = {}) {
  const lot = parseFloat(document.getElementById('lot-size').value) || 0.1;
  const slPips = parseFloat(document.getElementById('sl-pips').value) || 0;
  const tpPips = parseFloat(document.getElementById('tp-pips').value) || 0;
  const pipVal = SYMBOL_PARAMS[STATE.symbol].pip;

  const isBuy = type.includes('buy') || type === 'market';
  const sl = slPips > 0 ? (isBuy ? price - slPips * pipVal : price + slPips * pipVal) : null;
  const tp = tpPips > 0 ? (isBuy ? price + tpPips * pipVal : price - tpPips * pipVal) : null;

  const order = {
    id: STATE.nextOrderId++,
    type, price, lot, sl, tp,
    status: type === 'market' ? 'open' : 'pending',
    openPrice: type === 'market' ? STATE.currentPrice : null,
    openTime: STATE.candles[STATE.simIndex]?.time,
    closePrice: null,
    pnl: 0,
    relation: opts.relation || null,
    triggerPrice: opts.triggerPrice || null,
    linkedId: opts.linkedId || null,
    side: isBuy ? 'buy' : 'sell',
  };

  STATE.orders.push(order);
  if (type === 'market') {
    order.openPrice = STATE.currentPrice;
    logEntry(`#${order.id} Market ${isBuy?'BUY':'SELL'} @ ${formatPrice(STATE.currentPrice)}`, isBuy?'log-buy':'log-sell');
  } else {
    logEntry(`#${order.id} ${type.toUpperCase()} @ ${formatPrice(price)}`, 'log-trigger');
  }
  renderOrderTable();
  updateStats();
  return order;
}

function placeOCO(priceA, priceB) {
  const a = placeOrder(priceA, 'buy_limit',  { relation: 'OCO' });
  const b = placeOrder(priceB, 'sell_stop',  { relation: 'OCO', linkedId: a.id });
  a.linkedId = b.id;
  STATE.ocoGroups.push({ id: STATE.nextOrderId++, orderIds: [a.id, b.id] });
  logEntry(`OCO Group: #${a.id} + #${b.id}`, 'log-trigger');
  renderOrderTable();
}

function placeOTO(triggerPrice, childType) {
  const trigger = placeOrder(triggerPrice, 'buy_stop', { relation: 'OTO' });
  const child   = placeOrder(triggerPrice * 1.02, childType || 'sell_limit', { relation: 'OTO-child', linkedId: trigger.id });
  child.status = 'oto-waiting';
  trigger.linkedId = child.id;
  STATE.otoGroups.push({ id: STATE.nextOrderId++, trigger: trigger.id, child: child.id });
  logEntry(`OTO Group: trigger #${trigger.id} → child #${child.id}`, 'log-trigger');
  renderOrderTable();
}

function checkOrders(candle) {
  for (const order of STATE.orders) {
    if (order.status === 'open') {
      // Update P&L
      const pip = SYMBOL_PARAMS[STATE.symbol].pip;
      const mult = STATE.symbol === 'BTCUSD' ? 1 : STATE.symbol === 'ETHUSD' ? 10 : 100000;
      const pips = order.side === 'buy'
        ? (candle.close - order.openPrice) / pip
        : (order.openPrice - candle.close) / pip;
      order.pnl = pips * order.lot * mult * pip;

      // Check SL/TP
      if (order.sl && order.side === 'buy' && candle.low <= order.sl) closeOrder(order, order.sl, 'SL Hit');
      else if (order.sl && order.side === 'sell' && candle.high >= order.sl) closeOrder(order, order.sl, 'SL Hit');
      else if (order.tp && order.side === 'buy' && candle.high >= order.tp) closeOrder(order, order.tp, 'TP Hit');
      else if (order.tp && order.side === 'sell' && candle.low <= order.tp) closeOrder(order, order.tp, 'TP Hit');
    }

    if (order.status === 'pending') {
      let triggered = false;
      if (order.type === 'buy_limit'  && candle.low  <= order.price) triggered = true;
      if (order.type === 'sell_limit' && candle.high >= order.price) triggered = true;
      if (order.type === 'buy_stop'   && candle.high >= order.price) triggered = true;
      if (order.type === 'sell_stop'  && candle.low  <= order.price) triggered = true;

      if (triggered) {
        order.status = 'open';
        order.openPrice = order.price;
        order.openTime = candle.time;
        logEntry(`#${order.id} ${order.type.toUpperCase()} ausgelöst @ ${formatPrice(order.price)}`, 'log-trigger');

        // OCO: cancel partner
        for (const grp of STATE.ocoGroups) {
          if (grp.orderIds.includes(order.id)) {
            grp.orderIds.filter(id => id !== order.id).forEach(id => {
              const partner = STATE.orders.find(o => o.id === id);
              if (partner && partner.status === 'pending') {
                partner.status = 'cancelled';
                logEntry(`#${partner.id} OCO cancelled`, 'log-cancel');
              }
            });
          }
        }

        // OTO: activate child
        for (const grp of STATE.otoGroups) {
          if (grp.trigger === order.id) {
            const child = STATE.orders.find(o => o.id === grp.child);
            if (child && child.status === 'oto-waiting') {
              child.status = 'pending';
              logEntry(`#${child.id} OTO child aktiviert`, 'log-trigger');
            }
          }
        }
      }
    }
  }
  renderOrderTable();
}

function closeOrder(order, price, reason) {
  order.status = 'filled';
  order.closePrice = price;
  const pip = SYMBOL_PARAMS[STATE.symbol].pip;
  const mult = STATE.symbol === 'BTCUSD' ? 1 : STATE.symbol === 'ETHUSD' ? 10 : 100000;
  const pips = order.side === 'buy'
    ? (price - order.openPrice) / pip
    : (order.openPrice - price) / pip;
  order.pnl = pips * order.lot * mult * pip;
  STATE.account.balance += order.pnl;
  logEntry(`#${order.id} geschlossen @ ${formatPrice(price)} | ${reason} | P&L: ${order.pnl >= 0 ? '+' : ''}$${order.pnl.toFixed(2)}`, order.pnl >= 0 ? 'log-buy' : 'log-sell');
}

function cancelOrder(id) {
  const order = STATE.orders.find(o => o.id === id);
  if (order && ['pending','oto-waiting'].includes(order.status)) {
    order.status = 'cancelled';
    logEntry(`#${order.id} manuell storniert`, 'log-cancel');
    renderOrderTable();
  }
}

// ─── CHART CLICK → PLACE ORDER ───────────────────────────────────────────────
function onChartClick(event) {
  const canvas = document.getElementById('order-canvas');
  const rect = canvas.getBoundingClientRect();
  const y = event.clientY - rect.top;
  const price = canvasToPriceApprox(y);
  if (!price) return;

  const type = STATE.selectedOrderType;
  if (type === 'market') {
    placeOrder(STATE.currentPrice, 'market');
  } else if (type === 'oco') {
    const tp2 = parseFloat(document.getElementById('trigger-price').value) || price * 0.99;
    placeOCO(price, tp2);
  } else if (type === 'oto') {
    const tp2 = parseFloat(document.getElementById('trigger-price').value) || 'sell_limit';
    placeOTO(price, 'sell_limit');
  } else {
    placeOrder(price, type);
  }
}

function canvasToPriceApprox(y) {
  if (!STATE.candleSeries || STATE.candles.length === 0) return null;
  try {
    return STATE.candleSeries.coordinateToPrice(y);
  } catch(e) { return null; }
}

// ─── GRID ─────────────────────────────────────────────────────────────────────
function drawGrid() {
  const canvas = document.getElementById('grid-canvas');
  const container = document.getElementById('chart-container');
  canvas.width  = container.offsetWidth;
  canvas.height = container.offsetHeight;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!STATE.gridVisible) return;

  const opacity = parseFloat(document.getElementById('grid-opacity').value);
  ctx.strokeStyle = `rgba(88, 166, 255, ${opacity})`;
  ctx.lineWidth = 0.5;
  ctx.setLineDash([4, 4]);

  // Horizontal grid lines
  const gs = STATE.gridSize;
  if (!STATE.candleSeries) return;
  const price = STATE.currentPrice || 65000;
  for (let i = -20; i <= 20; i++) {
    const p = price + i * gs;
    try {
      const y = STATE.candleSeries.priceToCoordinate(p);
      if (y === null || y < 0 || y > canvas.height) continue;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y);
      ctx.stroke();
      ctx.fillStyle = `rgba(88,166,255,${Math.min(opacity*2,0.6)})`;
      ctx.font = '9px monospace';
      ctx.fillText(formatPrice(p), 4, y - 2);
    } catch(e) {}
  }
  ctx.setLineDash([]);
}

function toggleGrid(visible) {
  STATE.gridVisible = visible;
  drawGrid();
}

function updateGridSize(val) {
  STATE.gridSize = parseInt(val);
  document.getElementById('grid-size-val').textContent = val;
  drawGrid();
}

// ─── RESIZE ───────────────────────────────────────────────────────────────────
function resizeAll() {
  const container = document.getElementById('chart-container');
  const w = container.offsetWidth, h = container.offsetHeight;
  if (STATE.chart) STATE.chart.resize(w, h);
  const gc = document.getElementById('grid-canvas');
  const oc = document.getElementById('order-canvas');
  gc.width = oc.width = w;
  gc.height = oc.height = h;
  drawGrid();
}

// ─── CROSSHAIR ────────────────────────────────────────────────────────────────
function onCrosshairMove(param) {
  if (!param.point) return;
  const bar = param.seriesData?.get(STATE.candleSeries);
  if (bar) updateBarInfo(bar);
}

// ─── UI HELPERS ───────────────────────────────────────────────────────────────
function formatPrice(p) {
  if (!p) return '--';
  const sym = STATE.symbol;
  if (sym === 'EURUSD') return p.toFixed(5);
  if (sym === 'XAUUSD') return p.toFixed(2);
  if (sym === 'ETHUSD') return p.toFixed(2);
  return p.toFixed(2);
}

function updateBarInfo(bar) {
  if (!bar) return;
  document.getElementById('bar-open').textContent  = formatPrice(bar.open);
  document.getElementById('bar-high').textContent  = formatPrice(bar.high);
  document.getElementById('bar-low').textContent   = formatPrice(bar.low);
  document.getElementById('bar-close').textContent = formatPrice(bar.close || bar.value || bar.open);
}

function updateStats() {
  const openOrders = STATE.orders.filter(o => o.status === 'open');
  const openPL = openOrders.reduce((s, o) => s + (o.pnl || 0), 0);
  const closedPL = STATE.orders.filter(o => o.status === 'filled').reduce((s, o) => s + o.pnl, 0);
  const equity = STATE.account.balance + openPL;
  const wins   = STATE.orders.filter(o => o.status === 'filled' && o.pnl > 0).length;
  const losses = STATE.orders.filter(o => o.status === 'filled' && o.pnl < 0).length;

  const set = (id, val, cls) => {
    const el = document.getElementById(id);
    el.textContent = typeof val === 'number' ? `$${val.toFixed(2)}` : val;
    if (cls) el.className = 'stat-value ' + cls;
  };
  set('stat-balance',     STATE.account.balance);
  set('stat-equity',      equity, equity >= 10000 ? 'positive' : 'negative');
  set('stat-open-pl',     openPL, openPL >= 0 ? 'positive' : 'negative');
  set('stat-total-pl',    closedPL, closedPL >= 0 ? 'positive' : 'negative');
  document.getElementById('stat-margin').textContent = '$0';
  document.getElementById('stat-free-margin').textContent = `$${equity.toFixed(2)}`;
  document.getElementById('stat-trades').textContent = STATE.orders.filter(o=>o.status==='filled').length;
  document.getElementById('stat-wins').textContent   = wins;
  document.getElementById('stat-losses').textContent = losses;
}

function renderOrderTable() {
  const tbody = document.getElementById('order-table-body');
  if (STATE.orders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="color:#8b949e;text-align:center;padding:20px">Keine Orders — Klicke auf den Chart um Orders zu platzieren</td></tr>';
    return;
  }

  const statusBadge = s => {
    const map = { open:'badge-open', pending:'badge-pending', filled:'badge-filled', cancelled:'badge-cancelled', 'oto-waiting':'badge-triggered' };
    const label = { open:'Offen', pending:'Pending', filled:'Gefüllt', cancelled:'Storniert', 'oto-waiting':'OTO-Warten' };
    return `<span class="badge ${map[s]||''}">${label[s]||s}</span>`;
  };

  const rowClass = o => {
    if (o.status === 'filled') return 'order-row-filled';
    if (o.status === 'cancelled') return 'order-row-cancelled';
    if (o.side === 'buy') return 'order-row-buy';
    return 'order-row-sell';
  };

  tbody.innerHTML = [...STATE.orders].reverse().map(o => `
    <tr class="${rowClass(o)}">
      <td>${o.type.replace(/_/g,' ').toUpperCase()}</td>
      <td>${formatPrice(o.openPrice || o.price)}</td>
      <td>${o.lot}</td>
      <td>${o.sl ? formatPrice(o.sl) : '—'}</td>
      <td>${o.tp ? formatPrice(o.tp) : '—'}</td>
      <td style="color:${(o.pnl||0)>=0?'#3fb950':'#f85149'}">${o.status==='open'?(o.pnl>=0?'+':'')+`$${(o.pnl||0).toFixed(2)}`:'—'}</td>
      <td>${statusBadge(o.status)}</td>
      <td style="color:#a371f7;font-size:10px">${o.relation ? `${o.relation}→#${o.linkedId||'?'}` : '—'}</td>
      <td>${['pending','oto-waiting'].includes(o.status) ? `<button onclick="cancelOrder(${o.id})" style="font-size:10px;padding:1px 5px;background:#2a1a1a;border:1px solid #f85149;color:#f85149;border-radius:3px;cursor:pointer">✕</button>` : ''}</td>
    </tr>
  `).join('');
}

function logEntry(msg, cls = '') {
  const container = document.getElementById('log-entries');
  const now = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const div = document.createElement('div');
  div.className = `log-entry ${cls}`;
  div.innerHTML = `<span class="time">[${now}]</span> ${msg}`;
  container.prepend(div);
  // Max 200 entries
  while (container.children.length > 200) container.lastChild.remove();
}

function toggleIndicator(key, val) {
  STATE.indicators[key] = val;
  renderIndicators(STATE.candles.slice(0, STATE.simIndex + 1));
}

// ─── EVENT LISTENERS ─────────────────────────────────────────────────────────
document.getElementById('btn-sim-start').addEventListener('click', startSimulation);
document.getElementById('btn-sim-stop').addEventListener('click', stopSimulation);
document.getElementById('btn-sim-reset').addEventListener('click', resetSimulation);
document.getElementById('symbol-select').addEventListener('change', resetSimulation);
document.getElementById('tf-select').addEventListener('change', resetSimulation);
document.getElementById('sim-speed').addEventListener('input', function() {
  STATE.simSpeed = parseInt(this.value);
  document.getElementById('sim-speed-label').textContent = this.value + 'x';
});

// ─── BOOTSTRAP ───────────────────────────────────────────────────────────────
initChart();
loadSymbol();
logEntry('MT5 Order Simulator bereit. Klicke auf den Chart um Orders zu platzieren.', '');
