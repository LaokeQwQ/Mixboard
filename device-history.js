/**
 * Device History Manager
 * Persists discovered StagelinQ devices for auto-reconnection.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'device-history.json');

class DeviceHistory {
  constructor() {
    this.devices = [];
    this._ensureDataDir();
    this._load();
  }

  _ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  _load() {
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
        this.devices = JSON.parse(raw);
      }
    } catch (err) {
      console.warn('[DeviceHistory] Failed to load history:', err.message);
      this.devices = [];
    }
  }

  _save() {
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(this.devices, null, 2), 'utf-8');
    } catch (err) {
      console.error('[DeviceHistory] Failed to save history:', err.message);
    }
  }

  /**
   * Add or update a device in history.
   */
  upsert(deviceInfo) {
    const { ip, deviceName, softwareName, softwareVersion } = deviceInfo;
    const idx = this.devices.findIndex(d => d.ip === ip && d.deviceName === deviceName);
    const entry = {
      ip,
      deviceName,
      softwareName: softwareName || '',
      softwareVersion: softwareVersion || '',
      lastSeen: new Date().toISOString(),
      autoConnect: true,
    };
    if (idx >= 0) {
      this.devices[idx] = { ...this.devices[idx], ...entry };
    } else {
      entry.firstSeen = entry.lastSeen;
      this.devices.push(entry);
    }
    this._save();
    return this.devices;
  }

  /**
   * Check if a device is in history and marked for auto-connect.
   */
  shouldAutoConnect(ip, deviceName) {
    const d = this.devices.find(d => d.ip === ip && d.deviceName === deviceName);
    return d ? d.autoConnect : false;
  }

  /**
   * Toggle auto-connect for a device.
   */
  setAutoConnect(ip, deviceName, value) {
    const d = this.devices.find(d => d.ip === ip && d.deviceName === deviceName);
    if (d) {
      d.autoConnect = value;
      this._save();
    }
  }

  /**
   * Remove a device from history.
   */
  remove(ip, deviceName) {
    this.devices = this.devices.filter(d => !(d.ip === ip && d.deviceName === deviceName));
    this._save();
  }

  /**
   * Get all devices.
   */
  getAll() {
    return this.devices;
  }
}

module.exports = DeviceHistory;
