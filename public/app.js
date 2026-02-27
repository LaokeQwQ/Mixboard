/**
 * Mixboard — Frontend Application
 * Compact single-screen DJ monitor with real-time updates.
 */
(function () {
    'use strict';

    let ws = null;
    let reconnectTimer = null;
    let devicePollTimer = null;
    let settingsPanelOpen = false;
    const WS_URL = `ws://${location.host}`;

    // SMPTE Timer state
    let smpteState = 'stopped';
    let smpteStartTime = 0;
    let smpteElapsed = 0;

    // Client-side position tracking per deck
    const deckPlayback = { 1: { lastPos: 0, lastUpdate: 0, playing: false }, 2: { lastPos: 0, lastUpdate: 0, playing: false }, 3: { lastPos: 0, lastUpdate: 0, playing: false }, 4: { lastPos: 0, lastUpdate: 0, playing: false } };
    // Track artwork state per deck
    const lastTrackPath = { 1: '', 2: '', 3: '', 4: '' };

    // ─── WebSocket ─────────
    function connectWebSocket() {
        ws = new WebSocket(WS_URL);
        ws.onopen = () => { clearReconnectTimer(); };
        ws.onmessage = (e) => { try { handleMessage(JSON.parse(e.data)); } catch (err) { } };
        ws.onclose = () => scheduleReconnect();
        ws.onerror = () => ws.close();
    }
    function scheduleReconnect() { if (reconnectTimer) return; reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWebSocket(); }, 2000); }
    function clearReconnectTimer() { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } }

    // ─── Message Handler ─────────
    function handleMessage(msg) {
        switch (msg.type) {
            case 'state': updateUI(msg.data); break;
            case 'info': updateServerInfo(msg.data); break;
            case 'history': updateHistoryList(msg.data); break;
            case 'notification': handleNotification(msg.data); break;
            case 'modeChanged': handleModeChanged(msg.data); break;
        }
    }

    // ─── Notifications ─────────
    function requestNotificationPermission() { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); }
    function handleNotification(data) {
        if (!data) return;
        showToast({ type: data.type || 'info', icon: data.icon || 'ℹ️', title: data.title || '', message: data.body || '' });
        if ('Notification' in window && Notification.permission === 'granted') { try { new Notification(data.title, { body: data.body, tag: 'mixboard-' + Date.now() }); } catch (e) { } }
    }
    function handleModeChanged(data) {
        if (!data) return;
        const demoBadge = document.getElementById('demo-badge');
        const modeSelect = document.getElementById('mode-select');
        const modeInfo = document.getElementById('current-mode-info');
        demoBadge.style.display = data.demoMode ? 'inline-flex' : 'none';
        if (modeSelect) modeSelect.value = data.demoMode ? 'demo' : 'live';
        if (modeInfo) modeInfo.textContent = `当前: ${data.demoMode ? 'Demo' : 'Live'} 模式`;
        showToast({ type: 'info', icon: data.demoMode ? '🎭' : '📡', title: '模式已切换', message: data.demoMode ? 'Demo 模式' : 'Live 模式' });
    }

    // ─── Toast ─────────
    function showToast({ type, icon, title, message, duration }) {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast toast-${type || 'info'}`;
        toast.innerHTML = `<span class="toast-icon">${icon || 'ℹ️'}</span><div class="toast-body"><div class="toast-title">${escapeHtml(title)}</div><div class="toast-message">${escapeHtml(message)}</div></div><button class="toast-close" onclick="this.parentElement.remove()">✕</button>`;
        container.appendChild(toast);
        setTimeout(() => { toast.classList.add('toast-out'); setTimeout(() => toast.remove(), 300); }, duration || 5000);
    }

    // ─── UI Updates ─────────
    function updateUI(state) {
        if (!state) return;
        updateDeviceInfo(state.device);
        updateSettingsStatus(state.device);
        for (let i = 1; i <= 4; i++) updateDeck(i, state.decks[i], state.device);
        updateMixer(state.mixer);
    }

    function updateDeviceInfo(device) {
        if (!device) return;
        const badge = document.getElementById('connection-badge');
        const text = document.getElementById('connection-text');
        badge.className = device.connectionState === 'connected' ? 'badge badge-connected' : 'badge badge-disconnected';
        text.textContent = device.connectionState === 'connected' ? '已连接' : '未连接';
        setText('device-name', device.name || '等待设备...');
        setText('device-ip', device.ip ? `${device.ip} • ${device.softwareName} ${device.softwareVersion}` : '');

        const sdBadge = document.getElementById('sd-badge');
        const usbBadge = document.getElementById('usb-badge');
        if (sdBadge) sdBadge.style.display = device.hasSDCard ? 'inline-block' : 'none';
        if (usbBadge) usbBadge.style.display = device.hasUsb ? 'inline-block' : 'none';
    }

    function updateSettingsStatus(device) {
        if (!device) return;
        setText('settings-conn-state', device.connectionState === 'connected' ? '已连接' : '未连接');
        setText('settings-device-name', device.name || '—');
        setText('settings-device-ip', device.ip || '—');
        setText('settings-device-sw', device.softwareName && device.softwareVersion ? `${device.softwareName} ${device.softwareVersion}` : '—');
    }

    function updateServerInfo(info) {
        if (!info) return;
        const demoBadge = document.getElementById('demo-badge');
        const modeSelect = document.getElementById('mode-select');
        const modeInfo = document.getElementById('current-mode-info');
        demoBadge.style.display = info.demoMode ? 'inline-flex' : 'none';
        if (modeSelect) modeSelect.value = info.demoMode ? 'demo' : 'live';
        if (modeInfo) modeInfo.textContent = `当前: ${info.demoMode ? 'Demo' : 'Live'} 模式`;
        if (info.settings) applySettingsToUI(info.settings);
    }

    function applySettingsToUI(settings) {
        const select = document.getElementById('interface-select');
        const toggle = document.getElementById('auto-reconnect-toggle');
        const infoEl = document.getElementById('current-interface-info');
        if (settings.networkInterface && select) {
            for (let i = 0; i < select.options.length; i++) { if (select.options[i].value === settings.networkInterface) { select.selectedIndex = i; break; } }
            if (infoEl) infoEl.textContent = settings.networkInterface === 'auto' ? '当前: 自动选择' : `当前: ${settings.networkInterface}`;
        }
        if (toggle && settings.autoReconnect !== undefined) toggle.checked = settings.autoReconnect;
    }

    function updateDeck(num, deck, device) {
        if (!deck) return;
        const card = document.getElementById(`deck-${num}`);
        card.classList.toggle('is-playing', !!deck.play);
        card.classList.toggle('is-master', !!deck.deckIsMaster);
        card.classList.toggle('is-active', device && device.activeDeck === num);

        // Track info
        setText(`deck-${num}-title`, deck.songLoaded ? (deck.trackName || deck.songName || '—') : '—');
        setText(`deck-${num}-artist`, deck.songLoaded ? (deck.artistName || '未知艺术家') : '未加载曲目');

        // Artwork — clear immediately on track change, then fetch new
        const currentPath = deck.trackNetworkPath || deck.trackPath || '';
        if (currentPath && currentPath !== lastTrackPath[num]) {
            lastTrackPath[num] = currentPath;
            clearArtwork(num); // clear old artwork immediately
            loadArtwork(num);  // fetch new (with debounce to allow DB update)
        } else if (!currentPath && lastTrackPath[num]) {
            lastTrackPath[num] = '';
            clearArtwork(num);
        }

        // Play/CUE detection/sync/master
        const playEl = document.getElementById(`deck-${num}-play`);
        const pb = deckPlayback[num];
        const isCuePreviewing = !deck.play && !deck.externalScratchWheelTouch && deck.currentPosition > 0 && pb.lastPos > 0 && Math.abs(deck.currentPosition - pb.lastPos) > 0.01;
        if (isCuePreviewing) {
            playEl.textContent = 'CUE';
            playEl.className = 'status-icon cue-active';
        } else if (deck.play) {
            playEl.textContent = '▶';
            playEl.className = 'status-icon active';
        } else {
            playEl.textContent = '⏸';
            playEl.className = 'status-icon';
        }
        const syncEl = document.getElementById(`deck-${num}-sync`);
        // syncMode can be boolean (true/false) or integer (1/0)
        const isSyncOn = deck.syncMode === true || deck.syncMode > 0;
        syncEl.style.display = isSyncOn ? 'inline' : 'none';
        syncEl.classList.toggle('active', isSyncOn);
        document.getElementById(`deck-${num}-master`).style.display = deck.deckIsMaster ? 'inline' : 'none';

        // BPM with Pitch Percentage
        let pitchStr = '';
        if (deck.songLoaded && deck.speed !== undefined) {
            // Speed is usually 0 at center. If speed > 0, it means +%. 
            // e.g., if +1.11%, we want "+1.11%".
            const diff = deck.speed * 100;
            if (Math.abs(diff) > 0.01) {
                const sign = diff > 0 ? '+' : '';
                pitchStr = ` (${sign}${diff.toFixed(2)}%)`;
            }
        }

        if (deck.songLoaded && deck.currentBPM > 0) {
            setText(`deck-${num}-bpm`, deck.currentBPM.toFixed(2) + pitchStr);
        } else {
            setText(`deck-${num}-bpm`, '—');
        }
        setText(`deck-${num}-track-bpm`, deck.songLoaded && deck.trackBPM > 0 ? deck.trackBPM.toFixed(2) : '—');
        setText(`deck-${num}-key`, deck.songLoaded && deck.currentKey ? deck.currentKey : '—');

        // KeyLock
        const keylockEl = document.getElementById(`deck-${num}-keylock`);
        keylockEl.textContent = deck.keyLock ? 'ON' : 'OFF';
        keylockEl.className = `meta-value indicator ${deck.keyLock ? 'on' : 'off'}`;

        // Touch
        const touchEl = document.getElementById(`deck-${num}-touch`);
        touchEl.textContent = deck.externalScratchWheelTouch ? 'ON' : 'OFF';
        touchEl.className = `meta-value indicator ${deck.externalScratchWheelTouch ? 'on' : 'off'}`;

        // Update playback tracking (pb already declared above for CUE detection)
        if (deck.currentPosition > 0) {
            pb.lastPos = deck.currentPosition;
            pb.lastUpdate = Date.now();
        }
        pb.playing = !!deck.play;

        // Duration/progress
        const totalLen = deck.trackLength || 0;
        const elapsed = getEstimatedPosition(num, deck);
        if (deck.songLoaded && totalLen > 0) {
            setText(`deck-${num}-elapsed`, formatTime(elapsed));
            setText(`deck-${num}-total`, formatTime(totalLen));
            const pct = Math.min(100, Math.max(0, (elapsed / totalLen) * 100));
            const progressFill = document.getElementById(`deck-${num}-progress-fill`);
            if (progressFill) progressFill.style.width = `${pct}%`;
        } else {
            setText(`deck-${num}-elapsed`, '--:--');
            setText(`deck-${num}-total`, '--:--');
            const progressFill = document.getElementById(`deck-${num}-progress-fill`);
            if (progressFill) progressFill.style.width = '0%';
        }

        // CUE
        setText(`deck-${num}-cue`, deck.songLoaded && deck.cuePosition > 0 ? formatTime(deck.cuePosition) : '—');

        // Loop
        const loopBadge = document.getElementById(`deck-${num}-loop-state`);
        loopBadge.textContent = deck.loopEnableState ? 'ON' : 'OFF';
        loopBadge.classList.toggle('active', !!deck.loopEnableState);
        setText(`deck-${num}-loop-in`, deck.currentLoopInPosition > 0 ? formatTime(deck.currentLoopInPosition) : '—');
        setText(`deck-${num}-loop-out`, deck.currentLoopOutPosition > 0 ? formatTime(deck.currentLoopOutPosition) : '—');
        setText(`deck-${num}-loop-beats`, deck.currentLoopSizeInBeats > 0 ? formatBeats(deck.currentLoopSizeInBeats) : '—');

        // Hotcues
        if (deck.hotcues) {
            for (let i = 1; i <= 8; i++) {
                const hc = deck.hotcues[i];
                const padEl = document.getElementById(`deck-${num}-hc-${i}`);
                if (!padEl) continue;

                if (hc && hc.state) {
                    padEl.classList.add('active');
                    // StageLinq provides color as ARGB integer (usually)
                    // If it's a number, we can convert it to hex. Sometimes it's a string #RRGGBB.
                    let colorStr = 'rgba(255,255,255,0.8)';
                    if (hc.color) {
                        if (typeof hc.color === 'number') {
                            const hex = (hc.color >>> 0).toString(16).padStart(8, '0');
                            // ARGB -> RGBA
                            colorStr = `#${hex.substring(2)}${hex.substring(0, 2)}`;
                        } else {
                            colorStr = hc.color;
                        }
                    }
                    padEl.style.color = colorStr;
                } else {
                    padEl.classList.remove('active');
                    padEl.style.color = '';
                }
            }
        }

        // Volume
        const volFill = document.getElementById(`deck-${num}-volume-fill`);
        if (volFill) volFill.style.height = `${Math.min(1, Math.max(0, deck.externalMixerVolume || 0)) * 100}%`;
    }

    function getEstimatedPosition(num, deck) {
        const pb = deckPlayback[num];
        if (deck.currentPosition > 0) return deck.currentPosition;
        if (!pb.playing || pb.lastPos <= 0) return pb.lastPos;
        const elapsed = (Date.now() - pb.lastUpdate) / 1000;
        return pb.lastPos + elapsed;
    }

    function updateMixer(mixer) {
        if (!mixer) return;
        const channelOrder = [3, 1, 2, 4];
        channelOrder.forEach((ch) => {
            const pct = Math.min(100, Math.max(0, (mixer[`ch${ch}Fader`] || 0) * 100));
            const fill = document.getElementById(`mixer-ch${ch}-fill`);
            const knob = document.getElementById(`mixer-ch${ch}-knob`);
            const valEl = document.getElementById(`mixer-ch${ch}-val`);
            if (fill) fill.style.height = `${pct}%`;
            if (knob) knob.style.bottom = `calc(${pct}% - 5px)`;
            if (valEl) valEl.textContent = `${Math.round(pct)}%`;
        });
        const cfPct = Math.min(100, Math.max(0, (mixer.crossfader != null ? mixer.crossfader : 0.5) * 100));
        const cfKnob = document.getElementById('mixer-cf-knob');
        if (cfKnob) cfKnob.style.left = `${cfPct}%`;
    }

    // ─── System Clock & SMPTE ─────────
    function updateSystemClock() {
        const el = document.getElementById('system-clock');
        if (!el) return;
        const now = new Date();
        const beijing = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
        el.textContent = `${p2(beijing.getHours())}:${p2(beijing.getMinutes())}:${p2(beijing.getSeconds())}`;
    }

    function updateSmpteDisplay() {
        const el = document.getElementById('smpte-time');
        if (!el) return;
        let ms = smpteState === 'running' ? Date.now() - smpteStartTime + smpteElapsed : smpteElapsed;
        const t = Math.floor(ms / 1000);
        el.textContent = `${p2(Math.floor(t / 3600))}:${p2(Math.floor((t % 3600) / 60))}:${p2(t % 60)}.${p2(Math.floor((ms % 1000) / 10))}`;
    }

    function initSmpteTimer() {
        const startBtn = document.getElementById('smpte-start');
        const pauseBtn = document.getElementById('smpte-pause');
        const resetBtn = document.getElementById('smpte-reset');
        if (startBtn) startBtn.addEventListener('click', () => {
            if (smpteState !== 'running') { smpteStartTime = Date.now(); smpteState = 'running'; startBtn.classList.add('active'); }
        });
        if (pauseBtn) pauseBtn.addEventListener('click', () => {
            if (smpteState === 'running') { smpteElapsed += Date.now() - smpteStartTime; smpteState = 'paused'; startBtn.classList.remove('active'); }
        });
        if (resetBtn) resetBtn.addEventListener('click', () => {
            smpteState = 'stopped'; smpteElapsed = 0; smpteStartTime = 0; startBtn.classList.remove('active'); updateSmpteDisplay();
        });
    }

    function startClockLoop() {
        setInterval(() => { updateSystemClock(); updateSmpteDisplay(); }, 50);
    }

    // ─── Settings Panel (unchanged logic) ─────────
    function initSettings() {
        const btn = document.getElementById('settings-btn');
        const panel = document.getElementById('settings-panel');
        const overlay = document.getElementById('settings-overlay');
        const closeBtn = document.getElementById('settings-close');
        function openSettings() { panel.classList.add('open'); overlay.classList.add('open'); settingsPanelOpen = true; loadNetworkInterfaces(); loadHistory(); loadSettings(); refreshDiscoveredDevices(); startDevicePolling(); }
        function closeSettings() { panel.classList.remove('open'); overlay.classList.remove('open'); settingsPanelOpen = false; stopDevicePolling(); }
        btn.addEventListener('click', openSettings);
        closeBtn.addEventListener('click', closeSettings);
        overlay.addEventListener('click', closeSettings);
        document.getElementById('refresh-interfaces').addEventListener('click', loadNetworkInterfaces);
        document.getElementById('apply-interface').addEventListener('click', async () => { const s = document.getElementById('interface-select'); await saveSettingsToServer({ networkInterface: s.value }); setText('current-interface-info', s.value === 'auto' ? '✓ 已保存' : `✓ ${s.value}`); });
        document.getElementById('auto-reconnect-toggle').addEventListener('change', async function () { await saveSettingsToServer({ autoReconnect: this.checked }); });
        document.getElementById('apply-mode').addEventListener('click', async function () {
            const ms = document.getElementById('mode-select'); this.disabled = true; this.textContent = '切换中...';
            try { const r = await fetch('/api/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: ms.value }) }); const result = await r.json(); setText('current-mode-info', result.ok ? `✓ ${result.demoMode ? 'Demo' : 'Live'}` : '✗'); } catch (e) { setText('current-mode-info', '✗'); }
            this.disabled = false; this.textContent = '切换模式';
        });
        document.getElementById('manual-connect-btn').addEventListener('click', manualConnect);
        document.getElementById('manual-ip-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') manualConnect(); });
        document.getElementById('refresh-devices-btn').addEventListener('click', refreshDiscoveredDevices);
        initRestartButton();
    }

    async function manualConnect() {
        const input = document.getElementById('manual-ip-input'); const statusEl = document.getElementById('manual-connect-status'); const ip = input.value.trim();
        if (!ip) { statusEl.textContent = '请输入 IP'; return; }
        if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) { statusEl.textContent = '✗ IP 格式无效'; return; }
        statusEl.textContent = '⏳ 连接中...';
        try { const r = await fetch('/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip }) }); const result = await r.json(); statusEl.textContent = result.ok ? `✓ ${result.message}` : `✗ ${result.error}`; refreshDiscoveredDevices(); } catch (e) { statusEl.textContent = '✗ 网络错误'; }
    }

    function startDevicePolling() { stopDevicePolling(); devicePollTimer = setInterval(refreshDiscoveredDevices, 1000); }
    function stopDevicePolling() { if (devicePollTimer) { clearInterval(devicePollTimer); devicePollTimer = null; } }
    async function refreshDiscoveredDevices() { try { const r = await fetch('/api/discovered-devices'); renderDiscoveredDevices(await r.json()); } catch (e) { } }
    function renderDiscoveredDevices(devices) {
        const c = document.getElementById('discovered-devices-list');
        if (!devices || !devices.length) { c.innerHTML = '<div class="empty-state">未发现设备</div>'; return; }
        c.innerHTML = devices.map(d => { const ic = d.status === 'connected'; return `<div class="device-item ${ic ? 'is-connected' : ''}"><div class="device-status-dot ${ic ? 'connected' : 'discovered'}"></div><div class="device-item-info"><div class="device-item-name">${escapeHtml(d.name)}</div><div class="device-item-detail">${escapeHtml(d.ip)} • ${escapeHtml(d.software || '')} ${escapeHtml(d.version || '')}</div></div><div class="device-item-action">${ic ? `<button class="btn-disconnect" onclick="window.__disconnectDevice('${escapeHtml(d.ip)}')">断开</button>` : `<button class="btn-connect" onclick="window.__connectDevice('${escapeHtml(d.ip)}')">连接</button>`}</div></div>`; }).join('');
    }
    window.__connectDevice = async function (ip) { try { const r = await fetch('/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip }) }); const res = await r.json(); if (res.ok) showToast({ type: 'connected', icon: '🟢', title: '已连接', message: res.message }); refreshDiscoveredDevices(); } catch (e) { showToast({ type: 'disconnected', icon: '❌', title: '失败', message: e.message }); } };
    window.__disconnectDevice = async function (ip) { try { const r = await fetch('/api/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip }) }); const res = await r.json(); if (res.ok) showToast({ type: 'disconnected', icon: '🔴', title: '已断开', message: res.message }); refreshDiscoveredDevices(); } catch (e) { } };

    function initRestartButton() {
        const btn = document.getElementById('restart-btn'); let ct = null, ic = false;
        btn.addEventListener('click', async () => {
            if (!ic) { ic = true; btn.classList.add('confirming'); btn.textContent = '⚠️ 再次确认'; ct = setTimeout(() => { ic = false; btn.classList.remove('confirming'); btn.textContent = '⟳ 重启'; }, 3000); }
            else { clearTimeout(ct); ic = false; btn.classList.remove('confirming'); btn.disabled = true; btn.textContent = '重启中...'; showToast({ type: 'info', icon: '⟳', title: '重启', message: '正在重启...' }); try { await fetch('/api/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); } catch (e) { } setTimeout(() => { btn.textContent = '等待...'; waitForServerAndReload(); }, 1500); }
        });
    }
    function waitForServerAndReload() { const c = async () => { try { const r = await fetch('/api/info'); if (r.ok) { location.reload(); return; } } catch (e) { } setTimeout(c, 1000); }; c(); }

    async function loadSettings() { try { applySettingsToUI(await (await fetch('/api/settings')).json()); } catch (e) { } }
    async function saveSettingsToServer(partial) { try { await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(partial) }); } catch (e) { } }
    async function loadNetworkInterfaces() { try { const ifs = await (await fetch('/api/network-interfaces')).json(); const s = document.getElementById('interface-select'); while (s.options.length > 1) s.remove(1); ifs.forEach(i => { if (i.internal) return; const o = document.createElement('option'); o.value = i.address; o.textContent = `${i.name} — ${i.address}`; s.appendChild(o); }); await loadSettings(); } catch (e) { } }
    async function loadHistory() { try { updateHistoryList(await (await fetch('/api/history')).json()); } catch (e) { } }
    function updateHistoryList(devices) { const c = document.getElementById('history-list'); if (!devices || !devices.length) { c.innerHTML = '<div class="empty-state">暂无历史设备</div>'; return; } c.innerHTML = devices.map(d => `<div class="history-item"><div class="history-item-info"><div class="history-item-name">${escapeHtml(d.deviceName)}</div><div class="history-item-ip">${escapeHtml(d.ip)}</div></div><div class="history-item-time">${formatDate(d.lastSeen)}</div><div class="history-item-actions"><button class="history-delete-btn" onclick="window.__deleteHistoryDevice('${escapeHtml(d.ip)}','${escapeHtml(d.deviceName)}')" title="删">✕</button></div></div>`).join(''); }
    window.__deleteHistoryDevice = async function (ip, name) { try { const r = await fetch('/api/history', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip, deviceName: name }) }); const res = await r.json(); if (res.ok) updateHistoryList(res.devices); } catch (e) { } };


    // ─── Artwork Loading ─────────
    const artworkRequestId = { 1: 0, 2: 0, 3: 0, 4: 0 };
    function loadArtwork(deckNum) {
        const container = document.getElementById(`deck-${deckNum}-artwork`);
        if (!container) return;
        const reqId = ++artworkRequestId[deckNum];
        // Delay to let DB catch up after track load
        setTimeout(() => {
            if (artworkRequestId[deckNum] !== reqId) return; // stale request
            const img = new Image();
            img.onload = () => {
                if (artworkRequestId[deckNum] !== reqId) return; // stale
                container.innerHTML = '';
                img.style.width = '100%';
                img.style.height = '100%';
                img.style.objectFit = 'cover';
                img.style.borderRadius = 'inherit';
                container.appendChild(img);
            };
            img.onerror = () => { /* keep placeholder */ };
            img.src = `/api/artwork/${deckNum}?t=${Date.now()}`;
        }, 800);
    }
    function clearArtwork(deckNum) {
        const container = document.getElementById(`deck-${deckNum}-artwork`);
        if (!container) return;
        artworkRequestId[deckNum]++; // cancel any pending load
        container.innerHTML = '<div class="artwork-placeholder"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg></div>';
    }

    // ─── Utilities ─────────
    function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
    function p2(n) { return n.toString().padStart(2, '0'); }
    function formatTime(s) { s = Number(s); if (isNaN(s) || s < 0) return '--:--'; return `${Math.floor(s / 60)}:${p2(Math.floor(s % 60))}`; }
    function formatBeats(beats) {
        if (!beats || beats <= 0) return '—';
        if (beats >= 1) return `${beats} 拍`;
        const fracs = [[0.03125, '1/32'], [0.0625, '1/16'], [0.125, '1/8'], [0.25, '1/4'], [0.5, '1/2']];
        let best = fracs[0]; let minD = Math.abs(beats - fracs[0][0]);
        for (const f of fracs) { const d = Math.abs(beats - f[0]); if (d < minD) { minD = d; best = f; } }
        return `${best[1]} 拍`;
    }
    function formatDate(iso) { if (!iso) return ''; try { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${p2(d.getMinutes())}`; } catch { return ''; } }
    function escapeHtml(s) { return s ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') : ''; }

    // ─── Theme Toggle ─────────
    function initThemeToggle() {
        const saved = localStorage.getItem('mixboard-theme') || 'dark';
        applyTheme(saved);
        const btn = document.getElementById('theme-toggle-btn');
        if (btn) btn.addEventListener('click', () => {
            const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
            applyTheme(next);
            localStorage.setItem('mixboard-theme', next);
        });
    }
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        const dark = document.getElementById('theme-icon-dark');
        const light = document.getElementById('theme-icon-light');
        if (dark) dark.style.display = theme === 'dark' ? 'block' : 'none';
        if (light) light.style.display = theme === 'light' ? 'block' : 'none';
    }

    // ─── Init ─────────
    function init() { initSettings(); initSmpteTimer(); initThemeToggle(); connectWebSocket(); requestNotificationPermission(); startClockLoop(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
