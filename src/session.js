/**
 * Session Manager
 * Persists login sessions using Playwright browser state.
 * Checks validity via Nuxt store isLogin (with retry) + checkToken API fallback.
 * Does NOT delete state on failed load — only on explicit logout.
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
   * Uses Nuxt store isLogin with hydration retry + checkToken API fallback.
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

      // Restore browser with the saved state and check login validity.
      // We use TWO checks: (1) wait for Nuxt store hydration, (2) checkToken API.
      // We do NOT delete state on failure — instead, keep the state file so the
      // user can retry. Only delete on explicit logout.
      await this.api._ensureNuxtReady();

      // Wait for Nuxt store to hydrate (isLogin may be false during initial render)
      let isLogin = false;
      for (let i = 0; i < 3; i++) {
        isLogin = await this.api.page.evaluate(() => {
          const store = window.$nuxt && window.$nuxt.$store;
          return store && store.state && store.state.user && store.state.user.isLogin === true;
        });
        if (isLogin) break;
        await this.api.page.waitForTimeout(3000);
      }

      // Also verify via the checkToken API (more reliable than store state)
      if (!isLogin) {
        try {
          const tokenResult = await this.api.checkToken();
          if (tokenResult.resultCode === 'S200' || tokenResult.resultCode === 'A200') {
            isLogin = true;
          }
        } catch {
          // API call failed — session may be expired
        }
      }

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

      // Session expired — but DON'T delete the state file.
      // The user may want to retry, and the file helps diagnose issues.
      // State is only deleted on explicit logout.
      await this.api.close();
      this.api = new CeairApi();
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
      // Clear localStorage before API call (removes cached user data)
      await this.api.page.evaluate(() => {
        try { localStorage.clear(); } catch {}
        try { sessionStorage.clear(); } catch {}
      });
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
