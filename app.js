
        // ===== Config =====
        const GOLD_API_URL = "https://api.chnwt.dev/thai-gold-api/latest";
        const PROXY_URL = (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`;
        const REFRESH_INTERVAL_SEC = 60;
        const STORAGE_PORTFOLIO = "gold_tracker_portfolio_v2";
        const STORAGE_THEME = "gold_tracker_theme";
        const STORAGE_CACHE = "gold_tracker_price_cache_v2";
        const API_TIMEOUT_MS = 10000;      // Abort a single request after 10s
        const RETRY_DELAYS_MS = [1000, 2000];
        const API_COOLDOWN_MS = 5 * 60 * 1000; // Skip live calls for 5 min after total failure
        const FALLBACK_API_URL = "https://api.coingecko.com/api/v3/simple/price?ids=gold&vs_currencies=thb,usd";

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
            const saved = localStorage.getItem(STORAGE_THEME);
            const isDark = saved === 'dark';
            document.documentElement.classList.toggle('dark', isDark);
            themeToggle.innerHTML = isDark ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
        }
        themeToggle.addEventListener('click', () => {
            const isDark = document.documentElement.classList.toggle('dark');
            localStorage.setItem(STORAGE_THEME, isDark ? 'dark' : 'light');
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
                const raw = localStorage.getItem(STORAGE_PORTFOLIO);
                if (raw) return JSON.parse(raw);
            } catch (e) {}
            localStorage.setItem(STORAGE_PORTFOLIO, JSON.stringify(DEFAULT_PORTFOLIO));
            return JSON.parse(JSON.stringify(DEFAULT_PORTFOLIO));
        }
        function savePortfolio() {
            localStorage.setItem(STORAGE_PORTFOLIO, JSON.stringify(portfolio));
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
                    <div class="w-12 h-12 rounded-xl bg-amber-100 flex items-center justify-center text-amber-600 font-bold text-xs shrink-0">${batch.weight}à¸¿</div>
                    <div class="flex-1 grid grid-cols-2 gap-2">
                        <input type="number" step="0.25" min="0.25" value="${batch.weight}" data-id="${batch.id}" data-field="weight"
                            class="batch-input bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-bold text-center focus:outline-none focus:ring-2 focus:ring-amber-300" title="Weight (à¸šà¸²à¸—)">
                        <input type="number" step="1" min="0" value="${batch.cost}" data-id="${batch.id}" data-field="cost"
                            class="batch-input bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-bold text-center focus:outline-none focus:ring-2 focus:ring-amber-300" title="Cost per à¸šà¸²à¸— (à¸¿)">
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
        async function fetchJson(url) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
            try {
                const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
                if (!res.ok) throw new Error('Network error: ' + res.status);
                return await res.json();
            } finally {
                clearTimeout(timer);
            }
        }

        // Fetch the live price, trying direct then proxy with a short retry/backoff.
        // Returns the API payload, or null when every attempt failed or timed out.
        async function fetchLivePrice() {
            const endpoints = [GOLD_API_URL, PROXY_URL(GOLD_API_URL), FALLBACK_API_URL];

            for (const endpoint of endpoints) {
                for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
                    try {
                        const data = await fetchJson(endpoint);
                        if (data && data.status === 'success' && data.response && data.response.price) {
                            return data;
                        }
                        // Fallback API returns different shape: { gold: { thb: X, usd: Y } }
                        if (data && data.gold && typeof data.gold.thb === 'number') {
                            return { status: 'success', response: { price: data.gold } };
                        }
                        throw new Error('Unexpected API response shape');
                    } catch (err) {
                        const isLastAttempt = attempt === RETRY_DELAYS_MS.length && endpoint === endpoints[endpoints.length - 1];
                        if (isLastAttempt) return null;
                        const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
                        await new Promise(r => setTimeout(r, delay));
                    }
                }
            }
            return null;
        }

        async function fetchGoldData(isManualClick = false) {
            setLoading(true);
            manualMode = false;
            resumeLiveBtn.classList.add('hidden');

            // Circuit breaker: while the API is known to be down, jump straight to cache
            // so the page never sits waiting on a dead endpoint.
            if (Date.now() < apiCooldownUntil) {
                setLoading(false);
                useCachedPrice();
                resetCountdown();
                hideAppLoader();
                if (isManualClick) showStatus('API à¹„à¸¡à¹ˆà¸žà¸£à¹‰à¸­à¸¡à¹ƒà¸Šà¹‰à¸‡à¸²à¸™ à¸à¸³à¸¥à¸±à¸‡à¹à¸ªà¸”à¸‡à¸£à¸²à¸„à¸²à¸—à¸µà¹ˆà¸šà¸±à¸™à¸—à¸¶à¸à¹„à¸§à¹‰', 'error');
                return;
            }

            const data = await fetchLivePrice();

            if (data) {
                const price = data.response.price;
                lastApiData = price;
                apiCooldownUntil = 0;

                // Build cache payload from either API shape
                let updateDate = '', updateTime = '';
                if (data.response.update_date) {
                    updateDate = data.response.update_date;
                    updateTime = data.response.update_time || '';
                } else if (data.gold) {
                    updateDate = new Date().toISOString().split('T')[0];
                    updateTime = new Date().toTimeString().slice(0,5);
                }

                const cachePayload = {
                    price,
                    updateDate,
                    updateTime,
                    fetchedAt: Date.now()
                };
                localStorage.setItem(STORAGE_CACHE, JSON.stringify(cachePayload));

                cacheBanner.classList.add('hidden');
                applyLivePrices(price, true, updateDate, updateTime);
                setLoading(false);
                resetCountdown();
                hideAppLoader();

                // Don't show toast on initial background load
                if (isManualClick || !isFirstLoad) {
                    showStatus('à¸­à¸±à¸›à¹€à¸”à¸•à¸£à¸²à¸„à¸²à¸—à¸­à¸‡à¸ªà¸³à¹€à¸£à¹‡à¸ˆ', 'success');
                }
                return;
            }

            // Every attempt failed: back off, fall back to cache, and always release the UI.
            apiCooldownUntil = Date.now() + API_COOLDOWN_MS;
            setLoading(false);
            useCachedPrice();
            showStatus('à¹€à¸Šà¸·à¹ˆà¸­à¸¡à¸•à¹ˆà¸­ API à¹„à¸¡à¹ˆà¹„à¸”à¹‰ à¸à¸³à¸¥à¸±à¸‡à¹ƒà¸Šà¹‰à¸£à¸²à¸„à¸²à¸¥à¹ˆà¸²à¸ªà¸¸à¸”à¸—à¸µà¹ˆà¸šà¸±à¸™à¸—à¸¶à¸à¹„à¸§à¹‰', 'error');
            resetCountdown();
            hideAppLoader();
        }

        function useCachedPrice() {
            try {
                const raw = localStorage.getItem(STORAGE_CACHE);
                if (!raw) {
                    // Nothing cached yet â€” show an explicit state instead of a blank page.
                    buyPriceEl.innerText = 'N/A';
                    sellPriceEl.innerText = 'N/A';
                    lastUpdatedEl.innerText = 'à¹„à¸¡à¹ˆà¸¡à¸µà¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸£à¸²à¸„à¸²à¸—à¸µà¹ˆà¸šà¸±à¸™à¸—à¸¶à¸à¹„à¸§à¹‰';
                    return;
                }
                const cached = JSON.parse(raw);
                lastApiData = cached.price;
                const when = new Date(cached.fetchedAt).toLocaleString('th-TH', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
                cacheBannerText.innerText = `à¸à¸²à¸£à¹€à¸Šà¸·à¹ˆà¸­à¸¡à¸•à¹ˆà¸­à¸ªà¸”à¹ƒà¸Šà¹‰à¸‡à¸²à¸™à¹„à¸¡à¹ˆà¹„à¸”à¹‰ â€” à¹à¸ªà¸”à¸‡à¸£à¸²à¸„à¸²à¸—à¸µà¹ˆà¸šà¸±à¸™à¸—à¸¶à¸à¹„à¸§à¹‰à¸¥à¹ˆà¸²à¸ªà¸¸à¸”à¹€à¸¡à¸·à¹ˆà¸­ ${when}`;
                cacheBanner.classList.remove('hidden');
                applyLivePrices(cached.price, false, cached.updateDate, cached.updateTime);
            } catch (e) {
                buyPriceEl.innerText = 'N/A';
                sellPriceEl.innerText = 'N/A';
                lastUpdatedEl.innerText = 'à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸£à¸²à¸„à¸²à¸—à¸µà¹ˆà¸šà¸±à¸™à¸—à¸¶à¸à¹„à¸§à¹‰à¹€à¸ªà¸µà¸¢à¸«à¸²à¸¢';
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
                lastUpdatedEl.innerText = `à¸›à¸£à¸°à¸à¸²à¸¨à¸£à¸²à¸„à¸²: ${updateDate || ''} ${updateTime || ''}`.trim();
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
            const buy = parseFloat(String(buyPriceEl.innerText).replace(/[à¸¿,]/g, ''));
            const sell = parseFloat(String(sellPriceEl.innerText).replace(/[à¸¿,]/g, ''));
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

            buyPriceEl.innerText = `à¸¿${Math.round(buy).toLocaleString('th-TH')}`;
            sellPriceEl.innerText = `à¸¿${Math.round(sell).toLocaleString('th-TH')}`;

            const startVal = parseFloat(String(profitEl.innerText).replace(/,/g, '')) || 0;
            if (animate) {
                animateValue(profitEl, startVal, profit, 800);
            } else {
                profitEl.innerHTML = profit.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            }

            profitPctEl.innerText = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
            currentValueEl.innerText = `à¸¿${portfolioValue.toLocaleString('th-TH', { maximumFractionDigits: 0 })}`;
            initialCostEl.innerText = `à¸¿${totalCost.toLocaleString('th-TH', { maximumFractionDigits: 0 })}`;

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
                    countdownText.innerText = `à¸­à¸±à¸›à¹€à¸”à¸•à¹ƒà¸™ ${countdownRemaining}s`;
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

        renderPriceTypeButtons();
        renderPortfolio();
        fetchGoldData();
    
