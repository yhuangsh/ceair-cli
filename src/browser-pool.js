/**
 * Browser Pool — manages a single persistent Chromium instance.
 *
 * Spawns Chromium with --remote-debugging-port and reconnects via CDP.
 * The browser stays alive between CLI commands.
 *
 * State file: ~/.config/ceair-cli/browser.json
 *   { wsEndpoint, pid, startedAt, user }
 */

const { chromium } = require('playwright');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DATA_DIR, ensureDir } = require('./paths');

const BROWSER_FILE = path.join(DATA_DIR, 'browser.json');

const BROWSER_ARGS = [
  '--headless=new',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-infobars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
];

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

class BrowserPool {
  /**
   * Connect to the running browser and return { browser, context, page }.
   * Throws if no browser is running.
   */
  async connect() {
    const info = this._readInfo();
    if (!info?.wsEndpoint) {
      throw new Error('No active session. Run `ceair-cli session start` first.');
    }

    let browser;
    try {
      browser = await chromium.connectOverCDP(info.wsEndpoint);
    } catch {
      // Browser died — clean up stale info
      this._deleteInfo();
      throw new Error('Browser session died. Run `ceair-cli session start` to restart.');
    }

    const contexts = browser.contexts();
    if (contexts.length === 0) {
      browser.close();
      this._deleteInfo();
      throw new Error('Browser has no context. Run `ceair-cli session start` to restart.');
    }

    const context = contexts[0];
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    return { browser, context, page };
  }

  /**
   * Disconnect from the browser WITHOUT killing it.
   * Call this at the end of every CLI command.
   * browser.close() on a CDP-connected browser just disconnects.
   */
  disconnect(browser) {
    try {
      browser.close();
    } catch {
      // already gone, fine
    }
  }

  /**
   * Launch a new Chromium process with remote debugging.
   * Saves wsEndpoint for future reconnects.
   * @returns {{ browser, context, page, wsEndpoint }}
   */
  async launch() {
    // Check if already running
    const existing = this._readInfo();
    if (existing?.wsEndpoint) {
      try {
        const b = await chromium.connectOverCDP(existing.wsEndpoint);
        b.close();
        throw new Error(
          'Session already active. Run `ceair-cli session stop` first to restart.'
        );
      } catch (err) {
        if (err.message.includes('Session already active')) throw err;
        this._deleteInfo();
      }
    }

    ensureDir();

    const browserPath = chromium.executablePath();

    // Spawn Chromium with --remote-debugging-port=0 (auto-assign port)
    const proc = execFile(browserPath, [...BROWSER_ARGS, '--remote-debugging-port=0'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Don't let the child process keep Node alive
    proc.unref();
    proc.stdout.unref();
    proc.stderr.unref();

    // Read wsEndpoint from stderr
    const wsEndpoint = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error('Browser launch timed out'));
      }, 15000);

      proc.stderr.on('data', (data) => {
        const match = data.toString().match(/DevTools listening on (ws:\/\/.+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to launch browser: ${err.message}`));
      });

      proc.on('exit', (code) => {
        clearTimeout(timeout);
        if (code) reject(new Error(`Browser exited with code ${code}`));
      });
    });

    // Connect and set up context
    const browser = await chromium.connectOverCDP(wsEndpoint);
    let context = browser.contexts()[0];
    if (!context) {
      context = await browser.newContext({
        userAgent: USER_AGENT,
        viewport: { width: 1280, height: 800 },
        locale: 'zh-CN',
      });
    }
    const page = context.pages()[0] || await context.newPage();

    // Save info for reconnects
    this._saveInfo({
      wsEndpoint,
      pid: proc.pid,
      startedAt: new Date().toISOString(),
      user: null,
    });

    // Disconnect (first command will reconnect)
    browser.close();

    return { wsEndpoint };
  }

  /**
   * Kill the running browser process and delete the info file.
   */
  async kill() {
    const info = this._readInfo();
    if (info?.pid) {
      try {
        process.kill(info.pid, 'SIGKILL');
      } catch {
        // already dead
      }
    }
    this._deleteInfo();
  }

  /**
   * Check if a browser is running.
   * @returns {{ running: boolean, info: object|null }}
   */
  async status() {
    const info = this._readInfo();
    if (!info?.wsEndpoint) return { running: false, info: null };

    try {
      const browser = await chromium.connectOverCDP(info.wsEndpoint);
      browser.close();
      return { running: true, info };
    } catch {
      return { running: false, info };
    }
  }

  /**
   * Update the user field in the info file.
   */
  setUser(user) {
    const info = this._readInfo();
    if (info) {
      info.user = user;
      this._saveInfo(info);
    }
  }

  // ─── Private ──────────────────────────────────────────────────

  _readInfo() {
    try {
      if (fs.existsSync(BROWSER_FILE)) {
        return JSON.parse(fs.readFileSync(BROWSER_FILE, 'utf-8'));
      }
    } catch {
      // corrupt file
    }
    return null;
  }

  _saveInfo(info) {
    ensureDir();
    fs.writeFileSync(BROWSER_FILE, JSON.stringify(info, null, 2), { mode: 0o600 });
  }

  _deleteInfo() {
    try {
      if (fs.existsSync(BROWSER_FILE)) fs.unlinkSync(BROWSER_FILE);
    } catch {
      // ignore
    }
  }
}

module.exports = new BrowserPool();
