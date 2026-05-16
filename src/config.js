/**
 * Configuration management for ceair-cli
 * Config file: ~/.config/ceair-cli/config.json
 */

const fs = require('fs');
const { CONFIG_FILE, DATA_DIR, ensureDir, migrate } = require('./paths');

const DEFAULT_CONFIG = {
  // Default passenger (most frequent traveler)
  passenger: {
    name: null,
    idType: null,
    idNo: null,
    phone: null,
  },
  // Default contact (usually same as passenger)
  contact: {
    name: null,
    phone: null,
  },
  // Default search preferences
  search: {
    adults: 1,
    children: 0,
    cabin: 'Y',
  },
};

function loadConfig() {
  migrate();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    }
  } catch {
    // ignore parse errors
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config) {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

function getConfig(key) {
  const config = loadConfig();
  if (!key) return config;

  // Support dot notation: "passenger.name"
  const parts = key.split('.');
  let val = config;
  for (const part of parts) {
    val = val?.[part];
  }
  return val;
}

function setConfig(key, value) {
  const config = loadConfig();

  // Support dot notation
  const parts = key.split('.');
  let target = config;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!target[parts[i]]) target[parts[i]] = {};
    target = target[parts[i]];
  }

  // Try to parse JSON values (booleans, short numbers)
  // But keep long strings that look like phone/ID numbers as strings
  let parsed = value;
  if (/^\d{1,15}$/.test(value)) {
    // Short number (safe integer range) → parse as number
    try { parsed = JSON.parse(value); } catch {}
  } else if (value === 'true' || value === 'false') {
    parsed = value === 'true';
  }

  target[parts[parts.length - 1]] = parsed;
  saveConfig(config);
  return config;
}

module.exports = { loadConfig, saveConfig, getConfig, setConfig, CONFIG_FILE };
