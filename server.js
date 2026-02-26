/**
 * Mixboard — StagelinQ DJ Equipment Monitor
 * Main server: Express HTTP + WebSocket for real-time state push.
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const StagelinqManager = require('./stagelinq-manager');
const DeviceHistory = require('./device-history');

// ─── Prevent stagelinq library unhandled errors from crashing the process ────
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Process] Unhandled promise rejection (caught):', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
    // Only catch stagelinq-related errors; re-throw everything else
    if (err?.stack?.includes('stagelinq') || err?.message?.includes('Could not connect')) {
        console.error('[Process] StagelinQ exception (caught):', err.message);
    } else {
        console.error('[Process] Uncaught exception:', err);
        process.exit(1);
    }
});

// Config
const PORT = process.env.PORT || 3000;
const IS_DEMO = process.argv.includes('--demo');
const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
    networkInterface: 'auto',
    autoReconnect: true,
    refreshInterval: 500,
};

// ─── Settings Persistence ────────────────────────────────────────────────────

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadSettings() {
    ensureDataDir();
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) };
        }
    } catch (e) { console.warn('[Settings] Load failed:', e.message); }
    return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
    ensureDataDir();
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
    } catch (e) { console.error('[Settings] Save failed:', e.message); }
}

let currentSettings = loadSettings();

// ─── Init ────────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const manager = new StagelinqManager({ demo: IS_DEMO });
const history = new DeviceHistory();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── REST API ────────────────────────────────────────────────────────────────

app.get('/api/state', (req, res) => {
    res.json(manager.getState());
});

app.get('/api/network-interfaces', (req, res) => {
    const interfaces = os.networkInterfaces();
    const result = [];
    for (const [name, addrs] of Object.entries(interfaces)) {
        for (const addr of addrs) {
            if (addr.family === 'IPv4') {
                result.push({
                    name,
                    address: addr.address,
                    netmask: addr.netmask,
                    mac: addr.mac,
                    internal: addr.internal,
                });
            }
        }
    }
    res.json(result);
});

app.get('/api/settings', (req, res) => res.json(currentSettings));

app.post('/api/settings', (req, res) => {
    currentSettings = { ...currentSettings, ...req.body };
    saveSettings(currentSettings);
    res.json({ ok: true, settings: currentSettings });
});

app.get('/api/history', (req, res) => res.json(history.getAll()));

app.delete('/api/history', (req, res) => {
    const { ip, deviceName } = req.body;
    history.remove(ip, deviceName);
    res.json({ ok: true, devices: history.getAll() });
});

app.post('/api/history/auto-connect', (req, res) => {
    const { ip, deviceName, autoConnect } = req.body;
    history.setAutoConnect(ip, deviceName, autoConnect);
    res.json({ ok: true });
});

app.get('/api/info', (req, res) => {
    res.json({
        version: '1.0.0',
        demoMode: manager.isDemoMode(),
        uptime: process.uptime(),
        settings: currentSettings,
    });
});

// Artwork API — serve album art from Engine Library DB
app.get('/api/artwork/:deckNum', async (req, res) => {
    const deckNum = parseInt(req.params.deckNum);
    if (deckNum < 1 || deckNum > 4) return res.status(400).json({ error: 'Invalid deck' });
    try {
        const buffer = await manager.getArtworkBuffer(deckNum);
        if (buffer) {
            res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' });
            return res.send(buffer);
        }
        res.status(404).json({ error: 'No artwork available' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/mode — Switch between Demo and Live mode without restart
 */
app.post('/api/mode', async (req, res) => {
    const { mode } = req.body;
    const newDemoMode = mode === 'demo';
    try {
        await manager.restart(newDemoMode);
        broadcast('modeChanged', { demoMode: newDemoMode });
        broadcast('info', { demoMode: newDemoMode, settings: currentSettings });
        res.json({ ok: true, demoMode: newDemoMode });
    } catch (err) {
        console.error('[Server] Mode switch error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * GET /api/discovered-devices — List all devices discovered on the network
 */
app.get('/api/discovered-devices', (req, res) => {
    res.json(manager.getDiscoveredDevices());
});

/**
 * POST /api/connect — Manually connect to a device by IP
 */
app.post('/api/connect', async (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ ok: false, error: '缺少 IP 地址' });
    try {
        const result = await manager.connectToDevice(ip);
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * POST /api/disconnect — Disconnect from a device by IP
 */
app.post('/api/disconnect', async (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ ok: false, error: '缺少 IP 地址' });
    try {
        const result = await manager.disconnectDevice(ip);
        res.json(result);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * POST /api/restart — Save settings and restart the entire server process
 */
app.post('/api/restart', async (req, res) => {
    // Save any incoming settings first
    if (req.body.settings) {
        currentSettings = { ...currentSettings, ...req.body.settings };
        saveSettings(currentSettings);
    }

    console.log('[Server] Restart requested by user. Saving and restarting...');
    res.json({ ok: true, message: '正在重启...' });

    // Give the response time to be sent, then restart
    setTimeout(() => {
        // Determine how to restart — re-spawn via the same node args
        const args = process.argv.slice(1);
        const child = spawn(process.execPath, args, {
            detached: true,
            stdio: 'inherit',
            cwd: __dirname,
            env: { ...process.env },
        });
        child.unref();

        // Kill current process
        process.exit(0);
    }, 500);
});

// ─── WebSocket ───────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
    console.log('[WS] Client connected');
    ws.send(JSON.stringify({ type: 'state', data: manager.getState() }));
    ws.send(JSON.stringify({ type: 'info', data: { demoMode: manager.isDemoMode(), settings: currentSettings } }));
    ws.on('close', () => console.log('[WS] Client disconnected'));
    ws.on('error', (err) => console.error('[WS] Error:', err.message));
});

function broadcast(type, data) {
    const msg = JSON.stringify({ type, data });
    wss.clients.forEach((client) => {
        if (client.readyState === 1) client.send(msg);
    });
}

// ─── StagelinQ Events → WebSocket ────────────────────────────────────────────

manager.on('stateUpdate', (state) => broadcast('state', state));
manager.on('beatInfo', (beatData) => broadcast('beat', beatData));

manager.on('deviceReady', (deviceInfo) => {
    history.upsert(deviceInfo);
    broadcast('deviceReady', deviceInfo);
    broadcast('history', history.getAll());
    broadcast('notification', {
        type: 'connected',
        title: '设备已连接',
        body: `${deviceInfo.deviceName} (${deviceInfo.ip})`,
        icon: '🟢',
    });
});

manager.on('deviceDisconnected', (deviceInfo) => {
    broadcast('notification', {
        type: 'disconnected',
        title: '设备已断开',
        body: `${deviceInfo.deviceName} (${deviceInfo.ip})`,
        icon: '🔴',
    });
});

// ─── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║         MIXBOARD — StagelinQ Monitor         ║');
    console.log('  ╠══════════════════════════════════════════════╣');
    console.log(`  ║  🌐 http://localhost:${PORT}                   ║`);
    console.log(`  ║  📡 Mode: ${IS_DEMO ? 'DEMO (simulated data)     ' : 'LIVE (StagelinQ listen)   '}  ║`);
    if (currentSettings.networkInterface !== 'auto') {
        console.log(`  ║  🔌 Interface: ${currentSettings.networkInterface.padEnd(24)}  ║`);
    }
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');
    manager.start();
});

process.on('SIGINT', async () => {
    console.log('\n[Server] Shutting down...');
    await manager.stop();
    server.close();
    process.exit(0);
});
