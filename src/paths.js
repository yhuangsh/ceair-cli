/**
 * Shared paths for ceair-cli
 * All user data lives under ~/.config/ceair-cli/ (XDG convention)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const XDG_CONFIG = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const DATA_DIR = path.join(XDG_CONFIG, 'ceair-cli');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Legacy state file (kept for migration check)
const STATE_FILE = path.join(DATA_DIR, 'browser-state.json');

/**
 * Ensure the data directory exists
 */
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Migrate from legacy locations:
 *   ~/.ceair-booking/ → ~/.config/ceair-cli/
 *   ~/.config/ceair/   → ~/.config/ceair-cli/
 * Only migrates config.json (browser-state.json is no longer used).
 */
function migrate() {
  const legacyPaths = [
    path.join(os.homedir(), '.ceair-booking'),
    path.join(XDG_CONFIG, 'ceair'),
  ];

  for (const oldDir of legacyPaths) {
    const oldConfig = path.join(oldDir, 'config.json');
    const newConfig = CONFIG_FILE;
    if (fs.existsSync(oldConfig) && !fs.existsSync(newConfig)) {
      ensureDir();
      fs.copyFileSync(oldConfig, newConfig);
    }
  }
}

module.exports = { DATA_DIR, CONFIG_FILE, STATE_FILE, ensureDir, migrate };
