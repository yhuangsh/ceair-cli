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
 *   ~/.ceair-booking/browser-state.json → ~/.config/ceair-cli/browser-state.json
 *   ~/.ceair-booking/config.json         → ~/.config/ceair-cli/config.json
 *   ~/.config/ceair/config.json          → ~/.config/ceair-cli/config.json
 */
function migrate() {
  const legacyPaths = [
    path.join(os.homedir(), '.ceair-booking'),
    path.join(XDG_CONFIG, 'ceair'),
  ];

  for (const oldDir of legacyPaths) {
    for (const file of ['browser-state.json', 'config.json']) {
      const oldPath = path.join(oldDir, file);
      const newPath = path.join(DATA_DIR, file);
      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
        ensureDir();
        fs.copyFileSync(oldPath, newPath);
      }
    }
  }
}

module.exports = { DATA_DIR, CONFIG_FILE, STATE_FILE, ensureDir, migrate };
