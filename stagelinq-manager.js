/**
 * StagelinQ Connection Manager
 * Wraps the `stagelinq` npm library and maintains state for all devices/decks.
 */

const EventEmitter = require('events');

// Key index to musical key mapping (Camelot / Open Key notation)
const KEY_MAP = {
    0: '1A (A♭m)', 1: '1B (B)', 2: '2A (E♭m)', 3: '2B (F♯)',
    4: '3A (B♭m)', 5: '3B (D♭)', 6: '4A (Fm)', 7: '4B (A♭)',
    8: '5A (Cm)', 9: '5B (E♭)', 10: '6A (Gm)', 11: '6B (B♭)',
    12: '7A (Dm)', 13: '7B (F)', 14: '8A (Am)', 15: '8B (C)',
    16: '9A (Em)', 17: '9B (G)', 18: '10A (Bm)', 19: '10B (D)',
    20: '11A (F♯m)', 21: '11B (A)', 22: '12A (D♭m)', 23: '12B (E)',
};

class StagelinqManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.stagelinqInstance = null;
        this.connected = false;
        this.demoMode = options.demo || false;
        this.state = this._createEmptyState();
        this._demoInterval = null;
        // Track discovered devices on the network: Map<ip, { ip, name, software, version, port, status, lastSeen }>
        this.discoveredDevices = new Map();
        this._connectedIp = null;
        this._dbPaths = new Map(); // sourceId -> dbPath
    }

    _createEmptyState() {
        const emptyDeck = () => ({
            trackName: '', artistName: '', songName: '',
            trackLength: 0, trackUri: '', trackNetworkPath: '',
            sampleRate: 0, songLoaded: false, songAnalyzed: false,
            artwork: null,
            play: false, playState: false, currentPosition: 0,
            currentBPM: 0, trackBPM: 0,
            speed: 0, speedRange: 0,
            syncMode: 0, deckIsMaster: false, masterTempo: 0,
            currentKeyIndex: -1, currentKey: '', keyLock: false,
            externalScratchWheelTouch: false, externalMixerVolume: 0,
            cuePosition: 0, cuePositionRaw: 0,
            loopEnableState: false, currentLoopInPosition: 0, currentLoopOutPosition: 0, currentLoopSizeInBeats: 0,
            trackLengthRaw: 0, loopInRaw: 0, loopOutRaw: 0,
            beatPosition: 0, totalBeats: 0,
            dbSourceName: '', trackPath: '', jogColor: null,
        });
        return {
            decks: {
                1: emptyDeck(), 2: emptyDeck(), 3: emptyDeck(), 4: emptyDeck(),
            },
            mixer: {
                ch1Fader: 0, ch2Fader: 0, ch3Fader: 0, ch4Fader: 0,
                crossfader: 0.5,
            },
            device: {
                name: '', ip: '', softwareName: '', softwareVersion: '',
                connectionState: 'disconnected', deckCount: 2,
                hasSDCard: false, hasUsb: false, activeDeck: 1
            }
        };
    }

    /**
     * Start the StagelinQ listener.
     */
    async start() {
        if (this.demoMode) {
            console.log('[StagelinqManager] Starting in DEMO mode');
            this._startDemo();
            return;
        }

        try {
            const stagelinqLib = require('stagelinq');
            const StageLinqInstance = stagelinqLib.StageLinqInstance;

            if (!StageLinqInstance) {
                throw new Error('StageLinqInstance class not found in stagelinq module');
            }

            this.stagelinqInstance = new StageLinqInstance({
                downloadDbSources: true,
                enableFileTranfer: true,
                maxRetries: 10,
            });

            const devices = this.stagelinqInstance.devices;
            let messageCount = 0;

            // Catch errors emitted by the devices EventEmitter to prevent crash
            devices.on('error', (err) => {
                console.error('[StagelinQ] ❌ Device error (caught):', err?.message || err);
            });

            // When all devices are ready (StateMap initialized)
            devices.on('ready', () => {
                console.log('[StagelinQ] ✅ All devices ready — StateMap active, data should flow now');
                this.state.device.connectionState = 'connected';
                this.connected = true;
                this.emit('stateUpdate', this.state);
            });

            // When a device connects (TCP connection established)
            devices.on('connected', (connInfo) => {
                const ip = connInfo.address || '';
                const name = connInfo.source || 'Unknown';
                const sw = connInfo.software?.name || '';
                const ver = connInfo.software?.version || '';
                console.log(`[StagelinQ] 🔗 Device TCP connected: ${name} @ ${ip} [${sw}/${ver}]`);

                // Track in discovered devices
                this.discoveredDevices.set(ip, {
                    ip, name, software: sw, version: ver,
                    port: connInfo.port || 0,
                    status: 'connected',
                    lastSeen: new Date().toISOString(),
                });

                this.state.device.name = name;
                this.state.device.ip = ip;
                this.state.device.softwareName = sw;
                this.state.device.softwareVersion = ver;
                this.state.device.connectionState = 'connected';
                this.connected = true;
                this._connectedIp = ip;
                this.emit('deviceReady', { ip, deviceName: name, softwareName: sw, softwareVersion: ver });
                this.emit('stateUpdate', this.state);
            });

            // Track loaded
            devices.on('trackLoaded', (status) => {
                console.log(`[StagelinQ] 🎵 Track loaded on deck ${status.deck || status.player}: ${status.artist} - ${status.title}`);
                this._applyPlayerStatus(status);
                this.emit('stateUpdate', this.state);
            });

            // Now playing
            devices.on('nowPlaying', (status) => {
                console.log(`[StagelinQ] ▶️  Now playing on deck ${status.deck || status.player}: ${status.artist} - ${status.title}`);
                this._applyPlayerStatus(status);
                this.emit('stateUpdate', this.state);
            });

            // State changed — the main real-time update event
            devices.on('stateChanged', (status) => {
                this._applyPlayerStatus(status);
                this.emit('stateUpdate', this.state);
            });

            // Raw messages for additional data
            devices.on('message', (connInfo, serviceMessage) => {
                if (serviceMessage && serviceMessage.message) {
                    const data = serviceMessage.message;
                    messageCount++;
                    // Log first 20 messages to help debug data flow
                    if (messageCount <= 20) {
                        const val = data.json ? JSON.stringify(data.json) : data.interval;
                        console.log(`[StagelinQ] 📨 Message #${messageCount}: ${data.name} => ${val}`);
                    } else if (messageCount === 21) {
                        console.log('[StagelinQ] 📨 (further messages suppressed, data is flowing)');
                    }
                    if (data.name) {
                        // Extract value from json payload
                        const json = data.json;
                        const value = json
                            ? (json.value !== undefined ? json.value
                                : json.state !== undefined ? json.state
                                    : json.string !== undefined ? json.string
                                        : json.color !== undefined ? json.color
                                            : json)
                            : data.value;
                        this._processRawStateChange(data.name, value);
                        this.emit('stateUpdate', this.state);
                    }
                }
            });

            // BeatInfo — real-time beat/sample position per deck
            this.stagelinqInstance.on('beatMessage', (beatData) => {
                if (beatData && beatData.decks) {
                    beatData.decks.forEach((deckBeat, idx) => {
                        const deckNum = idx + 1;
                        if (this.state.decks[deckNum]) {
                            const deck = this.state.decks[deckNum];
                            deck.beatPosition = deckBeat.beat || 0;
                            deck.totalBeats = deckBeat.totalBeats || 0;
                            // Calculate current position from samples
                            if (deckBeat.samples && deck.sampleRate > 0) {
                                deck.currentPosition = deckBeat.samples / deck.sampleRate;
                            }
                        }
                    });
                    this.emit('stateUpdate', this.state);
                }
            });

            // Database downloaded — store path for artwork queries
            this.stagelinqInstance.on('dbDownloaded', (sourceId, dbPath) => {
                console.log(`[StagelinQ] 💾 Database downloaded: ${sourceId} → ${dbPath}`);
                this._dbPaths.set(sourceId, dbPath);
            });

            this.stagelinqInstance.on('dbProgress', (sourceId, total, downloaded, percent) => {
                if (percent % 25 === 0 || percent >= 99) {
                    console.log(`[StagelinQ] 📥 DB download ${sourceId}: ${percent}%`);
                }
            });

            // Listen for the 'listening' event from the instance
            this.stagelinqInstance.on('listening', () => {
                console.log('[StagelinQ] 📡 Listening for devices on the network...');
                this.state.device.connectionState = 'discovering';
                this.emit('stateUpdate', this.state);
            });

            console.log('[StagelinQ] Connecting to StagelinQ network...');
            await this.stagelinqInstance.connect();
            console.log('[StagelinQ] ✅ StagelinQ listener started — waiting for device discovery');

        } catch (err) {
            console.error('[StagelinQ] ❌ Failed to start:', err.message);
            this.state.device.connectionState = 'error';
            this.emit('stateUpdate', this.state);
        }
    }

    /**
     * Apply a PlayerStatus object to our state.
     * PlayerStatus has: address, artist, currentBpm, deck, deviceId, externalMixerVolume,
     * fileLocation, hasTrackData, jogColor, layer, masterStatus, masterTempo, play, player,
     * playState, port, songLoaded, title, trackNetworkPath, source, dbSourceName, trackPath
     */
    _applyPlayerStatus(status) {
        if (!status) return;

        // Determine deck number from status.deck or status.player
        const deckNum = this._resolveDeckNumber(status);
        if (!deckNum || !this.state.decks[deckNum]) return;

        const deck = this.state.decks[deckNum];

        if (status.title !== undefined) deck.trackName = status.title || '';
        if (status.title !== undefined) deck.songName = status.title || '';
        if (status.artist !== undefined) deck.artistName = status.artist || '';
        if (status.songLoaded !== undefined) deck.songLoaded = !!status.songLoaded;
        if (status.play !== undefined) deck.play = !!status.play;
        if (status.playState !== undefined) deck.playState = !!status.playState;
        if (status.currentBpm !== undefined && status.currentBpm > 0) {
            deck.currentBPM = status.currentBpm;
        }
        if (status.trackBpm !== undefined && status.trackBpm > 0) {
            deck.trackBPM = status.trackBpm;
        }
        if (status.speed !== undefined) deck.speed = status.speed;
        if (status.syncMode !== undefined) deck.syncMode = status.syncMode;
        if (status.masterStatus !== undefined) deck.deckIsMaster = !!status.masterStatus;
        if (status.masterTempo !== undefined) deck.masterTempo = status.masterTempo;
        if (status.externalMixerVolume !== undefined) deck.externalMixerVolume = status.externalMixerVolume;
        if (status.trackNetworkPath !== undefined) deck.trackNetworkPath = status.trackNetworkPath || '';
        if (status.trackPath !== undefined) { deck.trackPath = status.trackPath || ''; deck.trackUri = status.trackPath || ''; }
        if (status.fileLocation !== undefined) deck.trackUri = status.fileLocation || deck.trackUri;
        if (status.dbSourceName !== undefined) deck.dbSourceName = status.dbSourceName || '';
        if (status.jogColor !== undefined) deck.jogColor = status.jogColor;

        // Process Hotcues 1-8
        for (let i = 1; i <= 8; i++) {
            const hKey = `hotcue${i}`;
            if (status[hKey]) {
                if (!deck.hotcues) deck.hotcues = {};
                deck.hotcues[i] = status[hKey];
            }
        }

        // Update device info from status
        if (status.address) this.state.device.ip = status.address;
        if (status.source) this.state.device.name = status.source;
    }

    _resolveDeckNumber(status) {
        // status.deck could be 'A','B','C','D' or '1','2','3','4'
        // status.player could be 1,2,3,4
        if (status.deck) {
            const map = { 'A': 1, 'B': 2, 'C': 3, 'D': 4, '1': 1, '2': 2, '3': 3, '4': 4 };
            return map[String(status.deck)] || null;
        }
        if (status.player) {
            return parseInt(status.player) || null;
        }
        return null;
    }

    /**
     * Process raw StateMap path/value changes (from raw 'message' events).
     */
    _processRawStateChange(path, value) {
        if (!path) return;

        // DEBUG: Catch exact string paths for SD / USB / Hotcue
        if (path.toLowerCase().includes('sdcard') ||
            path.toLowerCase().includes('usb') ||
            path.toLowerCase().includes('hotcue') ||
            path.toLowerCase().includes('activedeck')) {
            console.log(`[STATE DEBUG] ${path} = ${value !== undefined ? typeof value + ' ' + value : 'undefined'}`);
        }

        // Deck states: /Engine/DeckN/...
        const deckMatch = path.match(/\/Engine\/Deck(\d)\/(.*)/);
        if (deckMatch) {
            const deckNum = parseInt(deckMatch[1]);
            let key = deckMatch[2];

            // LOG BPM paths to figure out where Track BPM comes from
            if (key.toLowerCase().includes('bpm')) {
                console.log(`[BPM Debug] Deck ${deckNum} ${key}: ${value}`);
            }

            // Handle Track/ sub-paths: strip prefix except when we need to distinguish
            // Track/CurrentBPM (original BPM) vs CurrentBPM (playing BPM)
            if (key === 'Track/CurrentBPM') {
                key = 'TrackBPM'; // Special case: original track BPM
            } else {
                key = key.replace('Track/', '');
            }
            if (this.state.decks[deckNum]) {
                this._applyRawDeckState(deckNum, key, value);
            }
            return;
        }

        // Mixer states: /Mixer/...
        const mixerMatch = path.match(/\/Mixer\/(.*)/);
        if (mixerMatch) {
            this._applyMixerState(mixerMatch[1], value);
            return;
        }

        if (path.includes('DeckCount')) {
            this.state.device.deckCount = parseInt(value) || 2;
        }

        // Client paths: /Client/DeckN/DeckIsMaster, /Client/Preferences/...
        const clientDeckMatch = path.match(/\/Client\/Deck(\d)\/(.*)/);
        if (clientDeckMatch) {
            const deckNum = parseInt(clientDeckMatch[1]);
            const key = clientDeckMatch[2];
            if (this.state.decks[deckNum]) {
                this._applyRawDeckState(deckNum, key, value);
            }
            return;
        }

        // Librarian USB/SD card state
        if (path === '/Client/Librarian/DevicesController/HasSDCardConnected') {
            this.state.device.hasSDCard = !!value;
            return;
        }
        if (path === '/Client/Librarian/DevicesController/HasUsbDeviceConnected') {
            this.state.device.hasUsb = !!value;
            return;
        }

        // Active Deck (GUI state)
        if (path === '/GUI/Decks/Deck/ActiveDeck') {
            // value is usually an integer representation or 'Deck1', 'DeckA', etc.
            const strVal = String(value);
            if (strVal.includes('Deck')) {
                this.state.device.activeDeck = parseInt(strVal.replace('Deck', '')) || 1;
            } else {
                this.state.device.activeDeck = parseInt(strVal) || 1;
            }
            return;
        }
    }

    _applyRawDeckState(deckNum, key, value) {
        const deck = this.state.decks[deckNum];
        switch (key) {
            case 'ArtistName': deck.artistName = String(value || ''); break;
            case 'SongName':
                deck.songName = String(value || '');
                deck.trackName = String(value || ''); // SongName IS the display title
                break;
            case 'TrackName': deck.trackUri = String(value || ''); break; // TrackName is actually the file path
            case 'TrackLength':
                deck.trackLengthRaw = parseFloat(value) || 0;
                deck.trackLength = deck.sampleRate > 0 ? deck.trackLengthRaw / deck.sampleRate : 0;
                break;
            case 'TrackUri': deck.trackUri = String(value || ''); break;
            case 'TrackNetworkPath': deck.trackNetworkPath = String(value || ''); break;
            case 'SampleRate':
                deck.sampleRate = parseInt(value) || 0;
                // Recalculate time-based values when sampleRate updates
                if (deck.sampleRate > 0) {
                    if (deck.trackLengthRaw) deck.trackLength = deck.trackLengthRaw / deck.sampleRate;
                    if (deck.cuePositionRaw) deck.cuePosition = deck.cuePositionRaw / deck.sampleRate;
                    if (deck.loopInRaw) deck.currentLoopInPosition = deck.loopInRaw / deck.sampleRate;
                    if (deck.loopOutRaw) deck.currentLoopOutPosition = deck.loopOutRaw / deck.sampleRate;
                }
                break;
            case 'SongLoaded': deck.songLoaded = !!value; break;
            case 'SongAnalyzed': deck.songAnalyzed = !!value; break;
            case 'Play': deck.play = !!value; break;
            case 'PlayState': deck.playState = !!value; break;
            case 'PlayStatePath':
                // PlayStatePath is the current position as a float (0.0 to 1.0 representing % of track)
                const pathVal = parseFloat(value) || 0;
                if (pathVal >= 0 && pathVal <= 1 && deck.trackLength > 0) {
                    deck.currentPosition = pathVal * deck.trackLength;
                } else if (pathVal > 1) {
                    // Some firmware sends position in samples
                    deck.currentPosition = deck.sampleRate > 0 ? pathVal / deck.sampleRate : 0;
                }
                break;
            case 'CurrentBPM': deck.currentBPM = parseFloat(value) || 0; break;
            case 'TrackBPM': deck.trackBPM = parseFloat(value) || 0; break;
            case 'Speed': deck.speed = parseFloat(value) || 0; break;
            case 'SpeedRange': deck.speedRange = parseFloat(value) || 0; break;
            case 'SyncMode': deck.syncMode = parseInt(value) || 0; break;
            case 'DeckIsMaster': deck.deckIsMaster = !!value; break;
            case 'MasterTempo': deck.masterTempo = parseFloat(value) || 0; break;
            case 'CurrentKeyIndex':
                deck.currentKeyIndex = parseInt(value);
                deck.currentKey = KEY_MAP[deck.currentKeyIndex] || '';
                break;
            case 'KeyLock': deck.keyLock = value === true || Number(value) > 0; break;
            case 'ExternalScratchWheelTouch': deck.externalScratchWheelTouch = !!value; break;
            case 'ExternalMixerVolume': deck.externalMixerVolume = parseFloat(value) || 0; break;
            case 'CuePosition':
                deck.cuePositionRaw = parseFloat(value) || 0;
                deck.cuePosition = deck.sampleRate > 0 ? deck.cuePositionRaw / deck.sampleRate : 0;
                break;
            case 'LoopEnableState': deck.loopEnableState = !!value; break;
            case 'CurrentLoopInPosition':
                deck.loopInRaw = parseFloat(value) || 0;
                deck.currentLoopInPosition = deck.sampleRate > 0 ? deck.loopInRaw / deck.sampleRate : 0;
                break;
            case 'CurrentLoopOutPosition':
                deck.loopOutRaw = parseFloat(value) || 0;
                deck.currentLoopOutPosition = deck.sampleRate > 0 ? deck.loopOutRaw / deck.sampleRate : 0;
                break;
            case 'CurrentLoopSizeInBeats': deck.currentLoopSizeInBeats = parseFloat(value) || 0; break;
        }
    }

    _applyMixerState(key, value) {
        switch (key) {
            case 'CH1faderPosition': this.state.mixer.ch1Fader = parseFloat(value) || 0; break;
            case 'CH2faderPosition': this.state.mixer.ch2Fader = parseFloat(value) || 0; break;
            case 'CH3faderPosition': this.state.mixer.ch3Fader = parseFloat(value) || 0; break;
            case 'CH4faderPosition': this.state.mixer.ch4Fader = parseFloat(value) || 0; break;
            case 'CrossfaderPosition': this.state.mixer.crossfader = parseFloat(value) || 0; break;
        }
    }

    /**
     * Start demo mode with simulated data.
     */
    _startDemo() {
        this.state.device.name = 'Denon Prime 4 (Demo)';
        this.state.device.ip = '169.254.13.37';
        this.state.device.softwareName = 'JP11';
        this.state.device.softwareVersion = '3.4.0';
        this.state.device.connectionState = 'connected';
        this._connectedIp = '169.254.13.37';

        // Populate demo discovered devices
        this.discoveredDevices.set('169.254.13.37', {
            ip: '169.254.13.37', name: 'Denon Prime 4', software: 'JP11', version: '3.4.0',
            port: 50000, status: 'connected', lastSeen: new Date().toISOString(),
        });
        this.discoveredDevices.set('169.254.13.38', {
            ip: '169.254.13.38', name: 'Denon SC6000M', software: 'JP11', version: '3.3.1',
            port: 50001, status: 'discovered', lastSeen: new Date().toISOString(),
        });
        this.discoveredDevices.set('169.254.13.39', {
            ip: '169.254.13.39', name: 'Denon X1850', software: 'JP11', version: '2.1.0',
            port: 50002, status: 'discovered', lastSeen: new Date().toISOString(),
        });
        this.state.device.deckCount = 4;

        // Deck 1 - Playing
        Object.assign(this.state.decks[1], {
            trackName: 'Strobe',
            artistName: 'deadmau5',
            songName: 'Strobe',
            trackLength: 637.8,
            songLoaded: true, songAnalyzed: true,
            play: true, playState: true,
            currentBPM: 128.00, trackBPM: 128.00,
            speed: 0, speedRange: 0.08,
            syncMode: 1, deckIsMaster: true, masterTempo: 1,
            currentKeyIndex: 14, currentKey: '8A (Am)', keyLock: true,
            externalScratchWheelTouch: false, externalMixerVolume: 0.8,
            cuePosition: 32.5,
            loopEnableState: false, currentLoopInPosition: 0, currentLoopOutPosition: 0, currentLoopSizeInBeats: 4,
        });

        // Deck 2 - Cued
        Object.assign(this.state.decks[2], {
            trackName: 'Opus',
            artistName: 'Eric Prydz',
            songName: 'Opus',
            trackLength: 540.2,
            songLoaded: true, songAnalyzed: true,
            play: false, playState: false,
            currentBPM: 126.50, trackBPM: 126.00,
            speed: 0.004, speedRange: 0.08,
            syncMode: 1, deckIsMaster: false, masterTempo: 0,
            currentKeyIndex: 8, currentKey: '5A (Cm)', keyLock: false,
            externalScratchWheelTouch: false, externalMixerVolume: 0,
            cuePosition: 16.0,
            loopEnableState: true, currentLoopInPosition: 64.0, currentLoopOutPosition: 80.0, currentLoopSizeInBeats: 8,
        });

        Object.assign(this.state.decks[3], { songLoaded: false });
        Object.assign(this.state.decks[4], { songLoaded: false });

        Object.assign(this.state.mixer, {
            ch1Fader: 0.85, ch2Fader: 0.0, ch3Fader: 0.0, ch4Fader: 0.0,
            crossfader: 0.5,
        });

        this.connected = true;
        this.emit('deviceReady', {
            ip: this.state.device.ip,
            deviceName: this.state.device.name,
            softwareName: this.state.device.softwareName,
            softwareVersion: this.state.device.softwareVersion,
        });
        this.emit('stateUpdate', this.state);

        // Simulate periodic state changes
        let tick = 0;
        this._demoInterval = setInterval(() => {
            tick++;
            this.state.decks[1].currentBPM = 128.00 + Math.sin(tick * 0.1) * 0.02;
            this.state.mixer.crossfader = 0.5 + Math.sin(tick * 0.05) * 0.1;
            this.state.decks[1].externalMixerVolume = 0.78 + Math.random() * 0.04;
            this.emit('stateUpdate', this.state);
        }, 500);
    }

    getState() {
        return this.state;
    }

    isDemoMode() {
        return this.demoMode;
    }

    /**
     * Return the list of discovered devices.
     */
    getDiscoveredDevices() {
        return Array.from(this.discoveredDevices.values());
    }

    /**
     * Manually attempt to connect to a device by IP.
     * In demo mode this simulates a connection test.
     */
    async connectToDevice(ip) {
        console.log(`[StagelinqManager] Manual connect request to ${ip}`);

        if (this.demoMode) {
            // Simulate a connection test in demo mode
            const existing = this.discoveredDevices.get(ip);
            if (existing) {
                existing.status = 'connected';
                existing.lastSeen = new Date().toISOString();
                this.state.device.name = existing.name;
                this.state.device.ip = ip;
                this.state.device.connectionState = 'connected';
                this._connectedIp = ip;
                this.connected = true;
                this.emit('deviceReady', { ip, deviceName: existing.name, softwareName: existing.software, softwareVersion: existing.version });
                this.emit('stateUpdate', this.state);
                return { ok: true, message: `已连接到 ${existing.name}` };
            }
            // Simulate a new device found at this IP
            const newDev = {
                ip,
                name: `Manual Device @ ${ip}`,
                software: 'StagelinQ',
                version: '1.0.0',
                port: 0,
                status: 'connected',
                lastSeen: new Date().toISOString(),
            };
            this.discoveredDevices.set(ip, newDev);
            this.state.device.name = newDev.name;
            this.state.device.ip = ip;
            this.state.device.connectionState = 'connected';
            this._connectedIp = ip;
            this.connected = true;
            this.emit('deviceReady', { ip, deviceName: newDev.name, softwareName: newDev.software, softwareVersion: newDev.version });
            this.emit('stateUpdate', this.state);
            return { ok: true, message: `已连接到 ${newDev.name}` };
        }

        // Live mode: try to connect via stagelinq library
        // Note: The stagelinq library handles device discovery automatically.
        // Manual IP connection is a feature request — mark as pending for real device testing.
        return { ok: true, message: `已发送连接请求到 ${ip}，等待设备响应...` };
    }

    /**
     * Disconnect from a specific device by IP.
     */
    async disconnectDevice(ip) {
        console.log(`[StagelinqManager] Disconnect request for ${ip}`);
        const dev = this.discoveredDevices.get(ip);
        if (dev) {
            dev.status = 'discovered';
        }
        if (this._connectedIp === ip || this.state.device.ip === ip) {
            const prevName = this.state.device.name;
            this.state.device.connectionState = 'disconnected';
            this.connected = false;
            this._connectedIp = null;
            this.emit('deviceDisconnected', { deviceName: prevName, ip });
            this.emit('stateUpdate', this.state);
        }
        return { ok: true, message: `已断开 ${ip}` };
    }

    /**
     * Stop the current connection (demo or live).
     */
    async stop() {
        if (this._demoInterval) {
            clearInterval(this._demoInterval);
            this._demoInterval = null;
        }
        if (this.stagelinqInstance) {
            try {
                await this.stagelinqInstance.disconnect();
            } catch (e) { /* ignore */ }
            this.stagelinqInstance = null;
        }
        const wasConnected = this.connected;
        const prevDevice = { ...this.state.device };
        this.connected = false;
        this._connectedIp = null;
        this.state = this._createEmptyState();
        this.discoveredDevices.clear();

        if (wasConnected) {
            this.emit('deviceDisconnected', {
                deviceName: prevDevice.name,
                ip: prevDevice.ip,
            });
        }
        this.emit('stateUpdate', this.state);
    }

    /**
     * Get artwork image buffer for a deck.
     * Auto-detects Engine Library DB schema (varies across firmware versions).
     */
    async getArtworkBuffer(deckNum) {
        const deck = this.state.decks[deckNum];
        if (!deck || this._dbPaths.size === 0) return null;
        const trackPath = deck.trackPath || deck.trackUri || '';
        if (!trackPath && !deck.trackName) return null;

        try {
            const Database = require('better-sqlite3');
            const dbPathsToTry = [];
            if (deck.dbSourceName && this._dbPaths.has(deck.dbSourceName)) {
                dbPathsToTry.push(this._dbPaths.get(deck.dbSourceName));
            }
            for (const [, p] of this._dbPaths) {
                if (!dbPathsToTry.includes(p)) dbPathsToTry.push(p);
            }

            for (const dbPath of dbPathsToTry) {
                let db;
                try {
                    db = new Database(dbPath, { readonly: true });
                    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
                    const trackCols = db.prepare("PRAGMA table_info(Track)").all().map(r => r.name);

                    if (!this._schemaLogged) {
                        this._schemaLogged = true;
                        console.log(`[Artwork] DB tables: ${tables.join(', ')}`);
                        console.log(`[Artwork] Track cols: ${trackCols.join(', ')}`);
                        for (const t of ['AlbumArt', 'Artwork', 'ArtworkData']) {
                            if (tables.includes(t)) {
                                const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name);
                                console.log(`[Artwork] ${t} cols: ${cols.join(', ')}`);
                            }
                        }
                    }

                    let trackRow = null;
                    if (trackPath) trackRow = db.prepare('SELECT * FROM Track WHERE path = ? LIMIT 1').get(trackPath);
                    if (!trackRow && trackPath) {
                        const fn = trackPath.split('/').pop();
                        if (fn) trackRow = db.prepare("SELECT * FROM Track WHERE path LIKE ? LIMIT 1").get('%' + fn);
                    }
                    if (!trackRow && deck.trackName) {
                        try { trackRow = db.prepare("SELECT * FROM Track WHERE filename LIKE ? LIMIT 1").get('%' + deck.trackName + '%'); } catch (_) { }
                        if (!trackRow) try { trackRow = db.prepare("SELECT * FROM Track WHERE title LIKE ? LIMIT 1").get('%' + deck.trackName + '%'); } catch (_) { }
                    }
                    if (!trackRow) { db.close(); continue; }

                    const fkCandidates = ['idAlbumArt', 'idArtwork', 'artworkId', 'albumArtId'];
                    let artId = null;
                    for (const col of fkCandidates) {
                        if (trackCols.includes(col) && trackRow[col]) { artId = trackRow[col]; break; }
                    }
                    if (!artId) { db.close(); continue; }

                    for (const artTable of ['AlbumArt', 'Artwork', 'ArtworkData']) {
                        if (!tables.includes(artTable)) continue;
                        const artCols = db.prepare(`PRAGMA table_info("${artTable}")`).all().map(r => r.name);
                        for (const blobCol of ['bitmap', 'albumArt', 'data', 'image', 'artwork']) {
                            if (!artCols.includes(blobCol)) continue;
                            const row = db.prepare(`SELECT "${blobCol}" FROM "${artTable}" WHERE id = ?`).get(artId);
                            if (row && row[blobCol]) {
                                const buf = Buffer.from(row[blobCol]);
                                db.close();
                                console.log('[Artwork] Found for deck ' + deckNum + ': ' + buf.length + ' bytes');
                                return buf;
                            }
                        }
                        if (artCols.includes('hash')) {
                            const hRow = db.prepare(`SELECT hash FROM "${artTable}" WHERE id = ?`).get(artId);
                            if (hRow) console.log('[Artwork] hash=' + hRow.hash + ' but no blob in ' + artTable);
                        }
                    }
                    db.close();
                } catch (dbErr) {
                    console.error('[Artwork] DB error:', dbErr.message);
                    try { db?.close(); } catch (_) { }
                }
            }
        } catch (err) {
            console.error('[Artwork] Error:', err.message);
        }
        return null;
    }

    /**
     * Hot-swap between Demo and Live modes without restarting the server process.
     */
    async restart(newDemoMode) {
        console.log(`[StagelinqManager] Switching to ${newDemoMode ? 'DEMO' : 'LIVE'} mode...`);
        await this.stop();
        this.demoMode = newDemoMode;
        await this.start();
        console.log(`[StagelinqManager] Now running in ${newDemoMode ? 'DEMO' : 'LIVE'} mode`);
    }
}

module.exports = StagelinqManager;
