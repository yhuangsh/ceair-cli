/**
 * Session Manager
 * Persists login sessions using Playwright browser state.
 * Checks validity via the Nuxt store's isLogin flag (not the checkToken API,
 * which is unreliable).
 */

const fs = require('fs');
const { STATE_FILE, migrate } = require('./paths');
const CeairApi = require('./api');

class SessionManager {
  constructor() {
    this.api = new CeairApi();
  }

  /**
   * Load a previously saved session and check validity.
   * Uses the Nuxt store's isLogin state — more reliable than the checkToken API.
   * @returns {boolean} whether a valid session was restored
   */
  async load() {
    // Migrate from legacy locations if needed
    migrate();

    if (!fs.existsSync(STATE_FILE)) {
      return false;
    }
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      if (!data.cookies || data.cookies.length === 0) {
        this._deleteState();
        return false;
      }

      // Quick check: must have login cookies
      const hasLoginCookie = data.cookies.some(
        (c) => c.name === 'ceair.login.token' || c.name === 'com.ceair.cesso'
      );
      if (!hasLoginCookie) {
        this._deleteState();
        return false;
      }

      // Restore browser with the saved state and check Nuxt store
      await this.api._ensureNuxtReady();

      const isLogin = await this.api.page.evaluate(() => {
        const store = window.$nuxt && window.$nuxt.$store;
        return store && store.state && store.state.user && store.state.user.isLogin === true;
      });

      if (isLogin) {
        // Also get user info
        const userInfo = await this.api.page.evaluate(() => {
          const user = window.$nuxt.$store.state.user.user || {};
          return {
            name: user.userName || user.name || user.memberName,
            cardNo: user.ffpCardNo,
          };
        });
        this._userInfo = userInfo;
        return true;
      }

      // Session expired
      await this.api.close();
      this.api = new CeairApi();
      this._deleteState();
      return false;
    } catch {
      this._deleteState();
      return false;
    }
  }

  /**
   * Get the user info from the last load() call
   */
  get userInfo() {
    return this._userInfo || null;
  }

  /**
   * Save current browser state to disk
   */
  async save() {
    await this.api.saveState();
  }

  /**
   * Delete saved state file
   */
  _deleteState() {
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
    }
  }

  /**
   * Logout and clean up
   */
  async logout() {
    try {
      await this.api._ensureBrowser();
      await this.api.logout();
    } catch {
      // ignore
    }
    await this.api.close();
    this._deleteState();
    this.api = new CeairApi();
  }

  /**
   * Clean up browser resources (call at end of CLI invocation)
   */
  async cleanup() {
    await this.api.close();
  }
}

module.exports = SessionManager;
