// ===== Config =====
const GOLD_API_URL = "https://api.chnwt.dev/thai-gold-api/latest";

// OPTIONAL but recommended: your own CORS proxy (e.g. a free Cloudflare Worker).
// If set, it is tried alongside the direct call. Must accept "<url>" appended
// and URL-encoded, e.g. "https://my-proxy.workers.dev/?url="
const CUSTOM_PROXY_URL = "";

// Public CORS proxies (free ones come and go, so several are listed and raced)
const PROXIES = [
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`
];

// Fallback #2: international spot gold -> estimated Thai price (always flagged "estimate")
const SPOT_SOURCES = {
    coingecko: "https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=thb", // THB per troy oz
    goldApi:   "https://api.gold-api.com/price/XAU",                                           // USD per troy oz
    fxApi:     "https://open.er-api.com/v6/latest/USD"                                         // USD -> THB
};

const REFRESH_INTERVAL_SEC = 60;
const STORAGE_PORTFOLIO = "gold_tracker_portfolio_v2";
const STORAGE_THEME = "gold_tracker_theme";
const STORAGE_CACHE = "gold_tracker_price_cache_v2";
const STORAGE_PREMIUM = "gold_tracker_premium_v1";

const API_TIMEOUT_MS = 5000;           // abort a single request after 5s
const RETRY_DELAY_MS = 800;            // one quick retry per source
const API_COOLDOWN_MS = 2 * 60 * 1000; // after total live failure, skip live calls for 2 min (manual refresh ignores this)
const FRESH_CACHE_MS = 15 * 60 * 1000; // a cached Thai price younger than this beats a spot-based estimate
const LOADER_FAILSAFE_MS = 15000;      // loader can never stay on screen longer than this

// Spot -> Thai baht-weight conversion
const TROY_OZ_TO_GRAM = 31.1035;
const BAHT_WEIGHT_GRAM = 15.244;       // 1 baht-weight of gold
const GOLD_PURITY = 0.965;             // 96.5% Thai gold
const DEFAULT_PREMIUM = 1.025;         // Thai price is usually ~2-3% above pure spot; auto-calibrated when live data is available
const BAR_HALF_SPREAD = 100;           // gold bar: buy = mid - 100, sell = mid + 100
const ORNAMENT_BUY_DISCOUNT = 1350;    // ornament buy  ~ bar buy  - 1,350
const ORNAMENT_SELL_MARKUP = 800;      // ornament sell ~ bar sell + 800

// localStorage can throw (private mode, blocked storage). Never let that kill the app.
const store = {
    get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }
};

const DEFAULT_PORTFOLIO = [
    { id: 1, weight: 3, cost: 45750 },
    { id: 2, weight: 2, cost: 61460 },
    { id: 3, weight: 1, cost: 67550 }
];

// ===== State =====
let isFirstLoad = true;
let portfolio = loadPortfolio();
let priceType = "gold_bar"; 
let lastApiData = null;     
let prevPrices = { buy: null, sell: null };
let manualMode = false;
let countdownHandle = null;
let countdownRemaining = REFRESH_INTERVAL_SEC;
let apiCooldownUntil = 0;         // timestamp when live API may be retried
let inFlight = false;             // prevents overlapping fetches
let lastSource = 'live';          // 'live' | 'cache' | 'estimate'

// ===== DOM refs =====
const appLoader = document.getElementById('appLoader');
const buyPriceEl = document.getElementById('buyPrice');
const sellPriceEl = document.getElementById('sellPrice');
const buyTrendEl = document.getElementById('buyTrend');
const sellTrendEl = document.getElementById('sellTrend');
const profitEl = document.getElementById('totalProfit');
const profitPctEl = document.getElementById('profitPct');
const profitIcon = document.getElementById('profitIcon');
const currentValueEl = document.getElementById('currentValue');
const initialCostEl = document.getElementById('initialCost');
const lastUpdatedEl = document.getElementById('lastUpdated');
const syncTimeEl = document.getElementById('syncTime');
const countdownText = document.getElementById('countdownText');
const refreshBtn = document.getElementById('refreshBtn');
const refreshIcon = document.getElementById('refreshIcon');
const statusBox = document.getElementById('statusBox');
const cacheBanner = document.getElementById('cacheBanner');
const cacheBannerText = document.getElementById('cacheBannerText');
const resumeLiveBtn = document.getElementById('resumeLiveBtn');
const themeToggle = document.getElementById('themeToggle');
const batchListEl = document.getElementById('batchList');
const totalWeightDisplay = document.getElementById('totalWeightDisplay');

const applyManualBtn = document.getElementById('applyManualBtn');
const manualBuyInput = document.getElementById('manualBuy');
const manualSellInput = document.getElementById('manualSell');

// ===== Theme =====
function initTheme() {
    const saved = store.get(STORAGE_THEME);
    const isDark = saved === 'dark';
    document.documentElement.classList.toggle('dark', isDark);
    themeToggle.innerHTML = isDark ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
}
themeToggle.addEventListener('click', () => {
    const isDark = document.documentElement.classList.toggle('dark');
    store.set(STORAGE_THEME, isDark ? 'dark' : 'light');
    themeToggle.innerHTML = isDark ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
});

// Immediately apply theme before rendering
initTheme();

// ===== Loader Hide Logic =====
function hideAppLoader() {
    if (isFirstLoad && appLoader) {
        isFirstLoad = false;
        setTimeout(() => {
            appLoader.classList.add('loader-exit');
            setTimeout(() => appLoader.remove(), 700); // Clean up from DOM
        }, 500); // Small delay to guarantee visual smooth transition after data arrives
    }
}

// ===== Portfolio persistence =====
function loadPortfolio() {
    try {
        const raw = store.get(STORAGE_PORTFOLIO);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
        }
    } catch (e) {}
    store.set(STORAGE_PORTFOLIO, JSON.stringify(DEFAULT_PORTFOLIO));
    return JSON.parse(JSON.stringify(DEFAULT_PORTFOLIO));
}
function savePortfolio() {
    store.set(STORAGE_PORTFOLIO, JSON.stringify(portfolio));
}

function getTotals() {
    const totalAmount = portfolio.reduce((s, b) => s + Number(b.weight || 0), 0);
    const totalCost = portfolio.reduce((s, b) => s + (Number(b.weight || 0) * Number(b.cost || 0)), 0);
    return { totalAmount, totalCost };
}

function renderPortfolio() {
    batchListEl.innerHTML = '';
    portfolio.forEach((batch, idx) => {
        const row = document.createElement('div');
        row.className = 'flex items-center gap-3 p-2 rounded-2xl hover:bg-slate-50 transition-colors fade-in';
        row.innerHTML = `
            <div class="w-12 h-12 rounded-xl bg-amber-100 flex items-center justify-center text-amber-600 font-bold text-xs shrink-0">${batch.weight}฿</div>
            <div class="flex-1 grid grid-cols-2 gap-2">
                <input type="number" step="0.25" min="0.25" value="${batch.weight}" data-id="${batch.id}" data-field="weight"
                    class="batch-input bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-bold text-center focus:outline-none focus:ring-2 focus:ring-amber-300" title="Weight (บาท)">
                <input type="number" step="1" min="0" value="${batch.cost}" data-id="${batch.id}" data-field="cost"
                    class="batch-input bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-bold text-center focus:outline-none focus:ring-2 focus:ring-amber-300" title="Cost per บาท (฿)">
            </div>
            <button class="delete-batch-btn w-8 h-8 flex items-center justify-center text-slate-300 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition-colors shrink-0" data-id="${batch.id}" title="Remove batch">
                <i class="fas fa-trash-can text-xs"></i>
            </button>
        `;
        batchListEl.appendChild(row);
    });

    const { totalAmount } = getTotals();
    totalWeightDisplay.innerText = `${totalAmount.toFixed(2)} Baht`;

    document.querySelectorAll('.batch-input').forEach(inp => {
        inp.addEventListener('change', (e) => {
            const id = Number(e.target.dataset.id);
            const field = e.target.dataset.field;
            const val = parseFloat(e.target.value);
            if (isNaN(val) || val < 0) { showStatus('Please enter a valid number', 'error'); return; }
            const batch = portfolio.find(b => b.id === id);
            if (batch) { batch[field] = val; savePortfolio(); renderPortfolio(); recomputeWithLastPrices(); }
        });
    });
    document.querySelectorAll('.delete-batch-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = Number(e.currentTarget.dataset.id);
            portfolio = portfolio.filter(b => b.id !== id);
            savePortfolio();
            renderPortfolio();
            recomputeWithLastPrices();
        });
    });
}

document.getElementById('addBatchBtn').addEventListener('click', () => {
    const weightInput = document.getElementById('newBatchWeight');
    const costInput = document.getElementById('newBatchCost');
    const weight = parseFloat(weightInput.value);
    const cost = parseFloat(costInput.value);
    if (isNaN(weight) || weight <= 0 || isNaN(cost) || cost < 0) {
        showStatus('Enter a valid weight and cost to add a batch', 'error');
        return;
    }
    const newId = portfolio.length ? Math.max(...portfolio.map(b => b.id)) + 1 : 1;
    portfolio.push({ id: newId, weight, cost });
    savePortfolio();
    renderPortfolio();
    recomputeWithLastPrices();
    weightInput.value = '';
    costInput.value = '';
    showStatus('Batch added', 'success');
});

document.getElementById('resetPortfolioBtn').addEventListener('click', () => {
    if (!confirm('Reset portfolio to default sample batches?')) return;
    portfolio = JSON.parse(JSON.stringify(DEFAULT_PORTFOLIO));
    savePortfolio();
    renderPortfolio();
    recomputeWithLastPrices();
    showStatus('Portfolio reset', 'success');
});

// ===== Price type toggle =====
function renderPriceTypeButtons() {
    document.querySelectorAll('.price-type-btn').forEach(btn => {
        const active = btn.dataset.type === priceType;
        btn.className = `price-type-btn toggle-pill flex-1 py-2.5 rounded-xl ${active ? 'bg-white shadow text-amber-600' : 'text-slate-400 hover:text-slate-600'}`;
    });
}
document.querySelectorAll('.price-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        priceType = btn.dataset.type;
        renderPriceTypeButtons();
        if (lastApiData) applyLivePrices(lastApiData, false);
    });
});

// ===== Fetching =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const parseNum = (v) => parseFloat(String(v).replace(/,/g, ''));
const validPrice = (n) => Number.isFinite(n) && n > 1000 && n < 1000000;

// fetch -> JSON with a hard timeout. Reads as text first because some CORS proxies
// return JSON with a text/plain content-type.
async function fetchJson(url, parentSignal) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, API_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (parentSignal) {
        if (parentSignal.aborted) controller.abort();
        else parentSignal.addEventListener('abort', onAbort);
    }
    try {
        const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return JSON.parse(await res.text());
    } catch (err) {
        if (timedOut) { const e = new Error('Timeout'); e.timeout = true; throw e; }
        throw err;
    } finally {
        clearTimeout(timer);
        if (parentSignal) parentSignal.removeEventListener('abort', onAbort);
    }
}

// One quick retry for fast failures only. A timeout already cost the full wait, so it is not retried.
async function withRetry(fn, signal) {
    try { return await fn(); }
    catch (err) {
        if (err.timeout || (signal && signal.aborted)) throw err;
        await sleep(RETRY_DELAY_MS);
        if (signal && signal.aborted) throw err;
        return await fn();
    }
}

// Race several sources: first VALID result wins, the rest are aborted.
// Total wait is ~one timeout instead of timeout x sources x retries.
function firstSuccess(tasks) {
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
        let pending = tasks.length;
        const errors = [];
        if (!pending) return reject(new Error('No sources'));
        tasks.forEach((task, i) => {
            Promise.resolve()
                .then(() => task(controller.signal))
                .then(
                    (value) => { controller.abort(); resolve(value); },
                    (err) => {
                        errors[i] = err;
                        if (--pending === 0) {
                            const e = new Error('All sources failed');
                            e.errors = errors;
                            reject(e);
                        }
                    }
                );
        });
    });
}

// Validate + normalise the Thai Gold API payload. Throws on anything unexpected,
// so a "200 OK" with junk is treated as a failure and the next source is used.
function normalizeThai(data) {
    const r = data && data.response;
    const p = r && r.price;
    if (!data || data.status !== 'success' || !p) throw new Error('Unexpected response shape');
    const price = {};
    ['gold_bar', 'gold'].forEach((key) => {
        if (!p[key]) return;
        const buy = parseNum(p[key].buy), sell = parseNum(p[key].sell);
        if (validPrice(buy) && validPrice(sell)) price[key] = { buy, sell };
    });
    if (!price.gold_bar && !price.gold) throw new Error('No valid prices in response');
    return { price, updateDate: r.update_date || r.date || '', updateTime: r.update_time || '', source: 'live' };
}

// Source 1: official Thai Gold Traders data (direct + custom proxy + public proxies, raced)
async function fetchLivePrice() {
    const urls = [];
    if (CUSTOM_PROXY_URL) urls.push(CUSTOM_PROXY_URL + encodeURIComponent(GOLD_API_URL));
    urls.push(GOLD_API_URL);
    PROXIES.forEach(p => urls.push(p(GOLD_API_URL)));

    const tasks = urls.map((u) => (signal) =>
        withRetry(async () => normalizeThai(await fetchJson(u, signal)), signal));
    try {
        return await firstSuccess(tasks);
    } catch (e) {
        console.warn('Live Thai gold API failed on all routes', e.errors || e);
        return null;
    }
}

// ----- Source 2: international spot gold -> estimated Thai price -----
const toBahtPure = (thbPerOz) => thbPerOz / TROY_OZ_TO_GRAM * BAHT_WEIGHT_GRAM * GOLD_PURITY;

async function fetchSpotThbPerOz() {
    const validOz = (n) => Number.isFinite(n) && n > 10000 && n < 2000000;
    return firstSuccess([
        // A: CoinGecko PAX Gold (1 token = 1 troy oz) priced in THB
        async (signal) => {
            const d = await fetchJson(SPOT_SOURCES.coingecko, signal);
            const v = Number(d && d['pax-gold'] && d['pax-gold'].thb);
            if (!validOz(v)) throw new Error('Bad CoinGecko data');
            return v;
        },
        // B: XAU/USD x USD/THB
        async (signal) => {
            const [g, fx] = await Promise.all([
                fetchJson(SPOT_SOURCES.goldApi, signal),
                fetchJson(SPOT_SOURCES.fxApi, signal)
            ]);
            const usd = Number(g && (g.price != null ? g.price : g.priceUsd));
            const thb = Number(fx && fx.rates && fx.rates.THB);
            const v = usd * thb;
            if (!validOz(v)) throw new Error('Bad spot/FX data');
            return v;
        }
    ]);
}

function getPremiumRatio() {
    try {
        const saved = JSON.parse(store.get(STORAGE_PREMIUM) || 'null');
        if (saved && saved.ratio > 0.9 && saved.ratio < 1.15 && Date.now() - saved.at < 7 * 24 * 3600 * 1000) return saved.ratio;
    } catch (e) {}
    return DEFAULT_PREMIUM;
}

// Whenever live Thai data is available, learn today's Thai-vs-spot premium (max once / 30 min,
// fire-and-forget) so the estimate stays close to the real market if the API later goes down.
async function calibratePremium(live) {
    try {
        const saved = JSON.parse(store.get(STORAGE_PREMIUM) || 'null');
        if (saved && Date.now() - saved.at < 30 * 60 * 1000) return;
        const bar = live.price.gold_bar;
        if (!bar) return;
        const ratio = ((bar.buy + bar.sell) / 2) / toBahtPure(await fetchSpotThbPerOz());
        if (ratio > 0.9 && ratio < 1.15) store.set(STORAGE_PREMIUM, JSON.stringify({ ratio, at: Date.now() }));
    } catch (e) { /* best effort */ }
}

async function fetchEstimatedPrice() {
    try {
        const pure = toBahtPure(await fetchSpotThbPerOz());
        const mid = Math.round(pure * getPremiumRatio() / 50) * 50;
        const barBuy = mid - BAR_HALF_SPREAD, barSell = mid + BAR_HALF_SPREAD;
        return {
            price: {
                gold_bar: { buy: barBuy, sell: barSell },
                gold: { buy: barBuy - ORNAMENT_BUY_DISCOUNT, sell: barSell + ORNAMENT_SELL_MARKUP }
            },
            updateDate: '', updateTime: '', source: 'estimate'
        };
    } catch (e) {
        console.warn('Spot-price estimate failed', e.errors || e);
        return null;
    }
}

// ----- Cache -----
function readCache() {
    try {
        const cached = JSON.parse(store.get(STORAGE_CACHE) || 'null');
        if (cached && cached.price && (cached.price.gold_bar || cached.price.gold)) return cached;
    } catch (e) {}
    return null;
}

function setSourceLabel(source) {
    const label = document.getElementById('liveLabel');
    if (label) label.innerText = source === 'estimate' ? 'ราคาประมาณการ (จากราคาทองโลก)' : 'สมาคมค้าทองคำแห่งประเทศไทย';
}

function showBanner(text) {
    cacheBannerText.innerText = text;
    cacheBanner.classList.remove('hidden');
}

function showNoData(msg) {
    buyPriceEl.innerText = 'N/A';
    sellPriceEl.innerText = 'N/A';
    lastUpdatedEl.innerText = msg;
}

function useCachedPrice() {
    const cached = readCache();
    if (!cached) { showNoData('ไม่มีข้อมูลราคาที่บันทึกไว้'); return false; }
    lastSource = 'cache';
    lastApiData = cached.price;
    const when = new Date(cached.fetchedAt).toLocaleString('th-TH', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    showBanner(`การเชื่อมต่อสดใช้งานไม่ได้ — แสดงราคาที่บันทึกไว้ล่าสุดเมื่อ ${when}`);
    setSourceLabel('cache');
    applyLivePrices(cached.price, false, cached.updateDate, cached.updateTime);
    return true;
}

function useEstimate(est) {
    lastSource = 'estimate';
    lastApiData = est.price;
    showBanner('⚠ ราคาประมาณการจากราคาทองคำตลาดโลก × อัตราแลกเปลี่ยน — ไม่ใช่ราคาประกาศของสมาคมค้าทองคำ อาจคลาดเคลื่อนได้');
    setSourceLabel('estimate');
    const t = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    applyLivePrices(est.price, true, 'ประมาณการ', t);
}

async function fetchGoldData(isManualClick = false) {
    if (inFlight) return;
    inFlight = true;
    const wasFirstLoad = isFirstLoad;
    setLoading(true);
    manualMode = false;
    resumeLiveBtn.classList.add('hidden');

    try {
        // 1) Live Thai price. Skipped during the cooldown unless the user pressed refresh.
        let live = null;
        if (isManualClick || Date.now() >= apiCooldownUntil) {
            live = await fetchLivePrice();
            apiCooldownUntil = live ? 0 : Date.now() + API_COOLDOWN_MS;
        }

        if (live) {
            lastSource = 'live';
            lastApiData = live.price;
            store.set(STORAGE_CACHE, JSON.stringify({
                price: live.price, updateDate: live.updateDate, updateTime: live.updateTime, fetchedAt: Date.now()
            }));
            cacheBanner.classList.add('hidden');
            setSourceLabel('live');
            applyLivePrices(live.price, true, live.updateDate, live.updateTime);
            if (isManualClick || !wasFirstLoad) showStatus('อัปเดตราคาทองสำเร็จ', 'success');
            calibratePremium(live);   // background, not awaited
            return;
        }

        // 2) A very fresh cached Thai price is more accurate than a spot-based estimate.
        const cached = readCache();
        if (cached && Date.now() - cached.fetchedAt < FRESH_CACHE_MS) {
            useCachedPrice();
            showStatus('เชื่อมต่อ API ไม่ได้ กำลังใช้ราคาล่าสุดที่บันทึกไว้', 'error');
            return;
        }

        // 3) Estimate from international spot gold.
        const est = await fetchEstimatedPrice();
        if (est) {
            useEstimate(est);
            showStatus('เชื่อมต่อ API ไทยไม่ได้ กำลังแสดงราคาประมาณการ', 'error');
            return;
        }

        // 4) Whatever we saved last time (any age), or an explicit N/A.
        useCachedPrice();
        showStatus('เชื่อมต่อ API ไม่ได้ กำลังใช้ราคาล่าสุดที่บันทึกไว้', 'error');
    } catch (err) {
        console.error('fetchGoldData crashed', err);
        useCachedPrice();
    } finally {
        // Always release the UI, no matter which path was taken.
        inFlight = false;
        setLoading(false);
        resetCountdown();
        hideAppLoader();
    }
}

function applyLivePrices(price, animate, updateDate, updateTime) {
    const typeData = price[priceType] || price['gold_bar'] || price['gold'];
    if (!typeData) return;
    const buy = parseFloat(String(typeData.buy).replace(/,/g, ''));
    const sell = parseFloat(String(typeData.sell).replace(/,/g, ''));
    if (isNaN(buy) || isNaN(sell)) return;

    manualBuyInput.value = Math.round(buy);
    manualSellInput.value = Math.round(sell);

    if (updateDate || updateTime) {
        lastUpdatedEl.innerText = `ประกาศราคา: ${updateDate || ''} ${updateTime || ''}`.trim();
    }
    const now = new Date();
    syncTimeEl.innerText = `Local Sync: ${now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;

    renderTrend(buyTrendEl, prevPrices.buy, buy);
    renderTrend(sellTrendEl, prevPrices.sell, sell);
    prevPrices = { buy, sell };

    updateDashboard(buy, sell, animate);
}

function renderTrend(el, prevVal, newVal) {
    if (prevVal === null || prevVal === newVal) { el.innerText = ''; return; }
    if (newVal > prevVal) {
        el.innerHTML = '<i class="fas fa-caret-up"></i> ' + (newVal - prevVal).toFixed(0);
        el.className = 'text-[10px] font-bold mt-1 text-emerald-500';
    } else {
        el.innerHTML = '<i class="fas fa-caret-down"></i> ' + (prevVal - newVal).toFixed(0);
        el.className = 'text-[10px] font-bold mt-1 text-rose-500';
    }
}

function recomputeWithLastPrices() {
    const buy = parseFloat(String(buyPriceEl.innerText).replace(/[฿,]/g, ''));
    const sell = parseFloat(String(sellPriceEl.innerText).replace(/[฿,]/g, ''));
    if (!isNaN(buy) && !isNaN(sell)) updateDashboard(buy, sell, false);
}

// ===== Manual override =====
applyManualBtn.addEventListener('click', () => {
    const customBuy = parseFloat(manualBuyInput.value);
    const customSell = parseFloat(manualSellInput.value);
    if (isNaN(customBuy) || isNaN(customSell)) {
        showStatus('Please enter valid numbers for both Buy and Sell.', 'error');
        return;
    }
    manualMode = true;
    resumeLiveBtn.classList.remove('hidden');
    lastUpdatedEl.innerText = 'Custom Input Applied (live updates paused)';
    updateDashboard(customBuy, customSell, true);
    showStatus('Custom prices applied', 'success');
});

resumeLiveBtn.addEventListener('click', () => {
    manualMode = false;
    resumeLiveBtn.classList.add('hidden');
    fetchGoldData();
});

// ===== Dashboard =====
function updateDashboard(buy, sell, animate = true) {
    const { totalAmount, totalCost } = getTotals();
    const portfolioValue = buy * totalAmount;
    const profit = portfolioValue - totalCost;
    const pct = totalCost > 0 ? (profit / totalCost) * 100 : 0;

    buyPriceEl.innerText = `฿${Math.round(buy).toLocaleString('th-TH')}`;
    sellPriceEl.innerText = `฿${Math.round(sell).toLocaleString('th-TH')}`;

    const startVal = parseFloat(String(profitEl.innerText).replace(/,/g, '')) || 0;
    if (animate) {
        animateValue(profitEl, startVal, profit, 800);
    } else {
        profitEl.innerHTML = profit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    profitPctEl.innerText = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
    currentValueEl.innerText = `฿${portfolioValue.toLocaleString('th-TH', { maximumFractionDigits: 0 })}`;
    initialCostEl.innerText = `฿${totalCost.toLocaleString('th-TH', { maximumFractionDigits: 0 })}`;

    if (profit >= 0) {
        profitEl.className = 'text-5xl sm:text-7xl font-black tracking-tighter profit-positive text-pop';
        profitIcon.className = 'fas fa-arrow-trend-up text-emerald-400 drop-shadow-md';
    } else {
        profitEl.className = 'text-5xl sm:text-7xl font-black tracking-tighter profit-negative text-pop';
        profitIcon.className = 'fas fa-arrow-trend-down text-rose-400 drop-shadow-md';
    }
}

function animateValue(obj, start, end, duration) {
    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        const val = progress * (end - start) + start;
        obj.innerHTML = val.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        if (progress < 1) window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
}

// ===== Countdown / auto-refresh =====
function resetCountdown() {
    countdownRemaining = REFRESH_INTERVAL_SEC;
    if (countdownHandle) clearInterval(countdownHandle);
    countdownHandle = setInterval(() => {
        if (manualMode) { countdownText.innerText = 'Live paused (manual)'; return; }
        countdownRemaining--;
        if (countdownRemaining <= 0) {
            fetchGoldData();
        } else {
            countdownText.innerText = `อัปเดตใน ${countdownRemaining}s`;
        }
    }, 1000);
}

// ===== UI helpers =====
function setLoading(isLoading) {
    if (isLoading) {
        refreshIcon.classList.add('fa-spin');
        refreshBtn.classList.add('opacity-50', 'pointer-events-none');
        if (buyPriceEl.innerText === '---') { buyPriceEl.classList.add('skeleton'); sellPriceEl.classList.add('skeleton'); }
    } else {
        refreshIcon.classList.remove('fa-spin');
        refreshBtn.classList.remove('opacity-50', 'pointer-events-none');
        buyPriceEl.classList.remove('skeleton');
        sellPriceEl.classList.remove('skeleton');
    }
}

function showStatus(msg, type) {
    statusBox.innerText = msg;
    const isError = type === 'error';
    statusBox.className = `fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-[90%] max-w-xs text-center p-4 rounded-2xl text-xs font-bold shadow-2xl transition-all duration-500 transform translate-y-0 opacity-100 ${isError ? 'bg-rose-500 text-white' : 'bg-emerald-500 text-white'}`;
    statusBox.classList.remove('hidden');
    setTimeout(() => {
        statusBox.classList.add('translate-y-10', 'opacity-0');
        setTimeout(() => statusBox.classList.add('hidden'), 500);
    }, 3000);
}

// ===== Init =====
refreshBtn.addEventListener('click', () => fetchGoldData(true));

setTimeout(hideAppLoader, LOADER_FAILSAFE_MS);   // last-resort: never trap the user behind the loader
renderPriceTypeButtons();
renderPortfolio();
fetchGoldData();