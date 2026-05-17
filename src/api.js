/**
 * CEAir API Client using Playwright
 *
 * Uses a browser to interact with China Eastern Airlines.
 * The SSO login requires Aliyun CAPTCHA verification, so we use
 * a visible browser window for login to let the user solve the CAPTCHA.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { STATE_FILE, DATA_DIR, ensureDir } = require('./paths');

const BASE_URL = 'https://www.ceair.com';
const SSO_URL = 'https://sso.ceair.com';
const SSO_API = '/mumember/api/sso';

class CeairApi {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this._ready = false;
  }

  async _ensureBrowser(headless = true) {
    if (this._ready && this.context) return;

    this.browser = await chromium.launch({
      headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-infobars',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    // Try to restore state
    let storageState = undefined;
    if (fs.existsSync(STATE_FILE)) {
      try {
        storageState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      } catch {
        // ignore
      }
    }

    this.context = await this.browser.newContext({
      storageState,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
    });

    this.page = await this.context.newPage();

    this._ready = true;
  }

  /**
   * Make an API request through the browser context (bypasses WAF)
   */
  async _apiRequest(url, body = null, method = 'POST') {
    await this._ensureBrowser();

    const response = await this.page.evaluate(
      async ({ url, body, method }) => {
        const options = {
          method,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/plain, */*',
          },
          credentials: 'include',
        };
        if (body) {
          options.body = JSON.stringify(body);
        }
        const resp = await fetch(url, options);
        const text = await resp.text();
        try {
          return JSON.parse(text);
        } catch {
          return { _raw: text, status: resp.status };
        }
      },
      { url, body, method }
    );

    return response;
  }

  // ─── Session Management ────────────────────────────────────────

  async saveState() {
    if (!this.context) return;
    ensureDir();
    const state = await this.context.storageState();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), {
      mode: 0o600,
    });
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      this._ready = false;
    }
  }

  // ─── Authentication ────────────────────────────────────────────

  /**
   * Interactive SMS login via the SSO page with CAPTCHA support.
   * Opens a visible browser window for the user to:
   * 1. Enter their phone number
   * 2. Solve the Aliyun CAPTCHA
   * 3. Enter the received SMS code
   *
   * Returns the login result.
   */
  async interactiveSmsLogin() {
    // Launch visible browser
    if (this.browser) {
      await this.browser.close();
      this._ready = false;
    }

    this.browser = await chromium.launch({
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    this.context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1000, height: 750 },
      locale: 'zh-CN',
    });

    this.page = await this.context.newPage();

    // Navigate to the SMS login page
    await this.page.goto(`${SSO_URL}/new/login?type=mobile&lang=zh_CNY`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await this.page.waitForTimeout(3000);

    // Wait for the login to complete by monitoring the page for cookies
    // The SSO page sets cookies and redirects on successful login
    console.log(
      '\n📱 浏览器窗口已打开。请在浏览器中：'
    );
    console.log('   1. 输入手机号码');
    console.log('   2. 完成验证码验证');
    console.log('   3. 点击获取验证码');
    console.log('   4. 输入收到的短信验证码');
    console.log('   5. 点击立即登录\n');

    // Wait for navigation away from the login page (successful login redirects)
    try {
      await this.page.waitForURL(
        (url) => !url.toString().includes('sso.ceair.com/new/login'),
        { timeout: 120000 } // 2 minutes
      );
    } catch {
      // Timeout - check if we got the login cookie anyway
      const cookies = await this.context.cookies();
      const hasLoginToken = cookies.some(
        (c) => c.name === 'ceair.login.token'
      );
      if (!hasLoginToken) {
        return {
          success: false,
          message: '登录超时，请重试',
        };
      }
    }

    // Login succeeded - check for the login cookie
    await this.page.waitForTimeout(2000);

    // Navigate to main site to establish session cookies
    await this.page.goto(`${BASE_URL}/zh/cny/home`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await this.page.waitForTimeout(3000);

    // Check for login cookies
    const cookies = await this.context.cookies();
    const loginCookie = cookies.find(
      (c) =>
        c.name === 'ceair.login.token' ||
        c.name === 'com.ceair.cesso' ||
        c.name === 'login_user_info_key'
    );

    if (loginCookie) {
      return {
        success: true,
        message: '登录成功',
      };
    }

    // Also check via the checkToken API
    try {
      const checkResult = await this._apiRequest(
        `${BASE_URL}/portal/v3/member/newCheckToken`,
        {}
      );
      if (checkResult.resultCode === 'A200') {
        return {
          success: true,
          message: '登录成功',
          user: checkResult.data,
        };
      }
    } catch {
      // ignore
    }

    return {
      success: false,
      message: '登录似乎未完成，请重试',
    };
  }

  /**
   * QR Code login — no CAPTCHA needed, no visible browser needed.
   *
   * Flow:
   *   1. POST /mumember/api/sso/qrcode/uuid  → get UUID
   *   2. Display QR code in terminal (content = "uuid=" + UUID)
   *   3. Poll  /mumember/api/sso/login/isconfirmbyscan
   *        isScan: true  → user scanned, waiting for confirm
   *        isLogin: true  → user confirmed, login success
   *   4. On success, redirect to www.ceair.com to establish session cookies
   *
   * @param {function} onScan    called when user scans the QR
   * @param {function} onWaiting called every poll tick
   * @returns {{ success: boolean, message: string }}
   */
  async qrCodeLogin(onScan, onWaiting) {
    await this._ensureBrowser(true); // headless is fine for QR login

    // 1. Get UUID
    const uuidResult = await this.page.evaluate(async () => {
      const resp = await fetch('/mumember/api/sso/qrcode/uuid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        credentials: 'include',
        body: 'salesChannel=7690',
      });
      return await resp.json();
    });

    // If SSO page isn't the current origin, use full URL
    let uuid;
    if (uuidResult.resultCode === 'A200') {
      uuid = uuidResult.resultContent;
    } else {
      // Need to navigate to SSO first to get proper cookies
      await this.page.goto(`${SSO_URL}/new/login?type=ffp&lang=zh_CNY`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await this.page.waitForTimeout(2000);

      const retry = await this.page.evaluate(async () => {
        const resp = await fetch('/mumember/api/sso/qrcode/uuid', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          credentials: 'include',
          body: 'salesChannel=7690',
        });
        return await resp.json();
      });

      if (retry.resultCode !== 'A200') {
        return { success: false, message: `获取二维码失败: ${retry.resultMsg}`, uuid: null };
      }
      uuid = retry.resultContent;
    }

    // 2. Poll for scan confirmation
    const TIMEOUT_MS = 120_000; // 2 min
    const POLL_INTERVAL_MS = 3000;
    const startTime = Date.now();
    let scanned = false;

    while (Date.now() - startTime < TIMEOUT_MS) {
      if (onWaiting) onWaiting();

      const pollResult = await this.page.evaluate(async (uuid) => {
        const resp = await fetch('/mumember/api/sso/login/isconfirmbyscan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ uuid, salesChannel: '7690' }),
        });
        return await resp.json();
      }, uuid);

      if (pollResult.resultCode !== 'A200') {
        if (pollResult.resultCode === '-100') {
          return { success: false, message: '二维码已过期，请重新获取', uuid };
        }
        // Transient error, keep polling
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }

      const content = pollResult.resultContent || {};

      if (content.isScanExpire) {
        return { success: false, message: '二维码已过期，请重新获取', uuid };
      }

      if (content.isLogin) {
        // Login confirmed in APP — now navigate to main site to pick up cookies
        // The SSO callback sets cookies on www.ceair.com via redirect
        await this.page.goto(`${BASE_URL}/zh/cny/home`, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await this.page.waitForTimeout(3000);

        // Verify login
        const cookies = await this.context.cookies();
        const hasToken = cookies.some(
          (c) =>
            c.name === 'ceair.login.token' ||
            c.name === 'com.ceair.cesso' ||
            c.name === 'login_user_info_key'
        );

        if (hasToken) {
          const userData = content;
          return {
            success: true,
            message: '登录成功',
            uuid,
            user: userData,
          };
        }

        // If no cookie yet, try checking via API
        try {
          const check = await this._apiRequest(
            `${BASE_URL}/portal/v3/member/newCheckToken`,
            {}
          );
          if (check.resultCode === 'A200') {
            return {
              success: true,
              message: '登录成功',
              uuid,
              user: check.data || content,
            };
          }
        } catch {
          // ignore
        }

        return { success: false, message: '登录Cookie获取失败，请重试', uuid };
      }

      if (content.isScan && !scanned) {
        scanned = true;
        if (onScan) onScan();
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    return { success: false, message: '登录超时，请重试', uuid };
  }

  /**
   * Interactive password login via the SSO page with CAPTCHA support.
   */
  async interactivePasswordLogin() {
    // Same approach but with FFP login type
    if (this.browser) {
      await this.browser.close();
      this._ready = false;
    }

    this.browser = await chromium.launch({
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    this.context = await this.browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1000, height: 750 },
      locale: 'zh-CN',
    });

    this.page = await this.context.newPage();

    await this.page.goto(`${SSO_URL}/new/login?type=ffp&lang=zh_CNY`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await this.page.waitForTimeout(3000);

    console.log(
      '\n🔑 浏览器窗口已打开。请在浏览器中：'
    );
    console.log('   1. 输入登录名 (手机号/证件号/邮箱/12位会员卡号)');
    console.log('   2. 输入密码');
    console.log('   3. 完成验证码验证');
    console.log('   4. 点击立即登录\n');

    try {
      await this.page.waitForURL(
        (url) => !url.toString().includes('sso.ceair.com/new/login'),
        { timeout: 120000 }
      );
    } catch {
      const cookies = await this.context.cookies();
      const hasLoginToken = cookies.some(
        (c) => c.name === 'ceair.login.token'
      );
      if (!hasLoginToken) {
        return { success: false, message: '登录超时，请重试' };
      }
    }

    await this.page.waitForTimeout(2000);
    await this.page.goto(`${BASE_URL}/zh/cny/home`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await this.page.waitForTimeout(3000);

    const cookies = await this.context.cookies();
    const loginCookie = cookies.find(
      (c) =>
        c.name === 'ceair.login.token' ||
        c.name === 'com.ceair.cesso' ||
        c.name === 'login_user_info_key'
    );

    if (loginCookie) {
      return { success: true, message: '登录成功' };
    }

    try {
      const checkResult = await this._apiRequest(
        `${BASE_URL}/portal/v3/member/newCheckToken`,
        {}
      );
      if (checkResult.resultCode === 'A200') {
        return { success: true, message: '登录成功', user: checkResult.data };
      }
    } catch {}

    return { success: false, message: '登录似乎未完成，请重试' };
  }

  async checkToken() {
    return this._apiRequest(
      `${BASE_URL}/portal/v3/member/newCheckToken`,
      {}
    );
  }

  async logout() {
    return this._apiRequest(
      `${BASE_URL}/portal/v3/member/clear/token`,
      {}
    );
  }

  // ─── Flight Search ─────────────────────────────────────────────

  /**
   * Ensure the homepage is loaded and Nuxt is ready.
   * The WAF allows the homepage through, which sets fresh challenge cookies.
   * We need Nuxt's $http client to make API calls that bypass the WAF.
   */
  async _ensureNuxtReady() {
    await this._ensureBrowser();

    // Check if Nuxt is already loaded and we're on the homepage
    const currentUrl = this.page.url();
    const onHomepage = currentUrl.includes('ceair.com/zh/cny/home') ||
                       (currentUrl.match(/ceair\.com\/?$/) != null);

    if (onHomepage) {
      const hasNuxt = await this.page.evaluate(() => !!window.$nuxt);
      if (hasNuxt) return;
    }

    // Navigate to homepage and wait for Nuxt
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.page.goto(`${BASE_URL}/zh/cny/home`, {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        await this.page.waitForTimeout(8000);

        const ready = await this.page.evaluate(() => !!window.$nuxt);
        if (ready) return;

        await this.page.waitForTimeout(10000);
        const retry = await this.page.evaluate(() => !!window.$nuxt);
        if (retry) return;
      } catch {
        // ignore timeout, retry
      }
    }
    throw new Error('WAF拦截：无法加载东航网站，请稍后重试');
  }

  /**
   * Search flights by simulating user interaction on the homepage.
   * Fills the search form, clicks search, captures the S200 API response.
   */
  async searchFlights(params) {
    const {
      depCity,
      arrCity,
      depDate,
      retDate,
      tripType = retDate ? 'RT' : 'OW',
      adult = 1,
      child = 0,
      infant = 0,
      cabinLevel = '',
    } = params;

    const { getCityName } = require('./cities');
    const depCityName = getCityName(depCity).replace(/\(.*\)/, '');
    const arrCityName = getCityName(arrCity).replace(/\(.*\)/, '');

    await this._ensureNuxtReady();

    // Dismiss cookie consent and remove modal overlays
    try {
      await this.page.locator('button:has-text("同意")').click({ timeout: 2000 });
    } catch {}
    await this.page.evaluate(() => {
      document.querySelectorAll(
        '.ceair-modal-wrap, .v-transfer-dom, .ceair-mask, .ceair-modal'
      ).forEach((el) => el.remove());
    });
    await this.page.waitForTimeout(300);

    // Fill departure and destination (type to trigger Vue autocomplete)
    const cityInputs = await this.page.locator('input.ceair-input__inner_homesearch').all();
    if (cityInputs.length >= 2) {
      const depInput = cityInputs[0];
      const currentDep = await depInput.inputValue();
      if (!currentDep.includes(depCityName)) {
        await depInput.click({ force: true });
        await depInput.fill('');
        await depInput.type(depCityName, { delay: 80 });
        await this.page.waitForTimeout(1200);
        await this.page.keyboard.press('ArrowDown');
        await this.page.waitForTimeout(200);
        await this.page.keyboard.press('Enter');
        await this.page.waitForTimeout(500);
      }

      const destInput = cityInputs[1];
      await destInput.click({ force: true });
      await destInput.fill('');
      await destInput.type(arrCityName, { delay: 80 });
      await this.page.waitForTimeout(1200);
      await this.page.keyboard.press('ArrowDown');
      await this.page.waitForTimeout(200);
      await this.page.keyboard.press('Enter');
      await this.page.waitForTimeout(500);
    }

    // ─── Fill departure date ───────────────────────────────
    // The form defaults to today; we must set the requested date.
    try {
      await this.page.evaluate((dateStr) => {
        // Strategy 1: Find date input by placeholder/class and set value
        const candidates = document.querySelectorAll(
          'input[placeholder*="日期"], input[placeholder*="出发"], ' +
          '.ceair-date-editor input, .ceair-input__inner_homesearch[type="text"]'
        );
        for (const input of candidates) {
          const rect = input.getBoundingClientRect();
          if (rect.width < 10) continue; // skip hidden
          // Remove readonly if present
          input.removeAttribute('readonly');
          const nativeSetter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype, 'value'
          ).set;
          nativeSetter.call(input, dateStr);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }

        // Strategy 2: Find Vue date picker component and set its value
        const allEls = document.querySelectorAll('[class*="date"], [class*="picker"]');
        for (const el of allEls) {
          const vue = el.__vue__;
          if (vue && typeof vue.$emit === 'function') {
            vue.$emit('input', dateStr);
            vue.$emit('change', dateStr);
            return true;
          }
        }
        return false;
      }, depDate);
      await this.page.waitForTimeout(300);
    } catch {
      // Date filling failed — search may use today's date
    }

    // Listen for S200 on the network
    let networkResolve;
    const networkPromise = new Promise((r) => { networkResolve = r; });
    let captured = false;
    const handler = async (resp) => {
      if (captured) return;
      const url = resp.url();
      if (url.includes('briefInfo')) {
        try {
          const text = await resp.text();
          const json = JSON.parse(text);
          if (json.resultCode === 'S200') {
            captured = true;
            this.page.off('response', handler);
            networkResolve(json);
          } else {
            // Return non-S200 responses too (e.g. 231002 = no flights, 232007 = error)
            // The caller can handle these appropriately
            captured = true;
            this.page.off('response', handler);
            networkResolve(json);
          }
        } catch {}
      }
    };
    this.page.on('response', handler);

    // Click search
    const searchBtn = this.page.locator('button.submit-btn:has-text("搜索")').first();
    const searchBtnVisible = await searchBtn.isVisible().catch(() => false);
    if (!searchBtnVisible) {
      this.page.off('response', handler);
      return { resultCode: 'SEARCH_TIMEOUT', resultMsg: '搜索按钮不可见 — 可能不在首页或页面未加载完成' };
    }
    await searchBtn.click({ force: true });

    // Wait for either:
    //   (A) S200 response captured via network listener
    //   (B) Page navigated to /shopping/ — then wait for S200 on the new page
    //   (C) Timeout
    //
    // Key fix: the S200 response may arrive DURING navigation (before or after).
    // The page.on('response') handler survives navigation in Playwright,
    // so networkPromise should resolve regardless.
    //
    // But sometimes the response arrives and is captured by the browser's
    // internal fetch, not as a network event visible to Playwright.
    // In that case, after navigation, we check the Vuex store directly.
    const result = await Promise.race([
      // (A) S200 from network listener (works for same-page AJAX)
      networkPromise,

      // (B) Page navigated to /shopping/ — S200 may have already arrived
      //     during navigation. Check Vuex store for cached results.
      (async () => {
        try {
          await this.page.waitForURL('**/shopping/**', { timeout: 15000 });
          // Navigation happened. The S200 may have been captured already
          // by the network handler (networkPromise will resolve soon),
          // OR it may be in the Vuex store.
          const navResult = await Promise.race([
            networkPromise,
            // Check Vuex store for cached flight data
            (async () => {
              // Wait a moment for Nuxt to hydrate on the new page
              await this.page.waitForTimeout(5000);
              const storeData = await this.page.evaluate(() => {
                const store = window.$nuxt?.$store;
                const flight = store?.state?.flight;
                const keys = flight ? Object.keys(flight) : [];
                const hasNuxt = !!window.$nuxt;
                const hasStore = !!store;
                const hasFlight = !!flight;
                const flightKeys = keys.join(',');
                const itemsCount = flight?.flightItems?.length || flight?.briefInfo?.data?.flightItems?.length || 0;
                if (itemsCount > 0) {
                  const items = flight.flightItems || flight.briefInfo?.data?.flightItems;
                  return {
                    resultCode: 'S200',
                    data: { flightItems: items },
                    _debug: { hasNuxt, hasStore, hasFlight, flightKeys, itemsCount },
                  };
                }
                return { _debug: { hasNuxt, hasStore, hasFlight, flightKeys, itemsCount } };
              });
              if (storeData?.resultCode === 'S200') return storeData;
              // Still nothing — wait more for network
              return networkPromise;
            })(),
            new Promise((r) => setTimeout(() => r(null), 15000)),
          ]);
          this.page.off('response', handler);
          return navResult;
        } catch { return null; }
      })(),

      // (C) Timeout
      new Promise((r) => setTimeout(() => {
        try { this.page?.off('response', handler); } catch {}
        r(null);
      }, 35000)),
    ]);

    if (!result) {
      return { resultCode: 'SEARCH_TIMEOUT', resultMsg: '搜索超时，请稍后重试' };
    }
    return result;
  }

  // ─── Booking ───────────────────────────────────────────────────

  /**
   * Click-based booking flow: navigates the real website like a human user.
   *
   * Steps:
   *   1. searchFlights (click-based) → captures S200 response with flightItems
   *   2. Click cabin price on the chosen flight
   *   3. Click "选购" button that appears
   *   4. On booking-new page: select passenger, fill contact, submit
   *   5. Capture the booking API response
   *
   * @param {Object} params
   * @param {Object} params.searchResult  - The S200 search response
   * @param {number} params.flightIndex   - Index into flightItems[]
   * @param {number} params.cabinIndex   - Index into cabinInfoDescs[] for the chosen flight
   * @param {Object} params.passenger    - { name, idType, idNo, gender, birthday, phone, email, nationality }
   * @param {Object} params.contact      - { name, phone }
   * @returns {Object} booking API response
   */
  async createBooking(params) {
    const {
      searchResult,
      flightItemIndex = 0,
      cabinIndex = 0,
      passenger,
      contact,
    } = params;

    const page = this.page;

    // We should already be on the shopping page after searchFlights
    // Step 1: Dismiss modals, click the cabin price for the chosen flight
    await this._dismissModals();

    // Find all cabin price elements (cabin-level-item cabin-select pointer)
    // Each flight card has cabinInfoDescs.length price elements
    const flightItems = searchResult?.data?.flightItems || [];
    if (flightItemIndex >= flightItems.length) {
      throw new Error(`航班序号 ${flightItemIndex} 超出范围`);
    }

    // Calculate correct DOM offset by summing cabin counts of all preceding flights
    let targetCabinOffset = 0;
    for (let i = 0; i < flightItemIndex; i++) {
      targetCabinOffset += flightItems[i].cabinInfoDescs?.length || 1;
    }
    targetCabinOffset += cabinIndex;

    // Scroll the target flight into view (approximate)
    await page.evaluate((idx) => {
      const btns = document.querySelectorAll('.cabin-select.pointer');
      if (btns[idx]) btns[idx].scrollIntoView({ block: 'center' });
    }, targetCabinOffset);
    await page.waitForTimeout(500);

    // Click the target cabin price
    const priceButtons = await page.locator('.cabin-select.pointer').all();
    if (targetCabinOffset >= priceButtons.length) {
      throw new Error('无法定位到所选航班的价格按钮');
    }

    await priceButtons[targetCabinOffset].click({ force: true });
    await page.waitForResponse(
      (resp) => resp.url().includes('fareDetail'),
      { timeout: 15000 }
    ).catch(() => {});
    await page.waitForTimeout(2000);

    // Step 2: Click "选购" button that appeared after the price click
    const selectBtn = page.locator('.fare-btn-txt').first();
    const selectVisible = await selectBtn.isVisible().catch(() => false);
    if (!selectVisible) {
      // Maybe the price click selected a different cabin; try again
      // Dismiss modals first
      await this._dismissModals();
      await priceButtons[targetCabinOffset].click({ force: true });
      await page.waitForResponse(
        (resp) => resp.url().includes('fareDetail'),
        { timeout: 15000 }
      ).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Step 2: Navigate to booking-new via onClickConfirm (not regular click)
    // Regular Playwright click doesn't trigger the Vue event chain
    await page.evaluate(() => {
      const btn = document.querySelector('.fare-btn-txt');
      if (btn && btn.__vue__) {
        btn.__vue__.$parent.onClickConfirm(btn.__vue__.$parent.item);
      }
    });
    await page.waitForTimeout(4000);
    await this._dismissModals();

    // Step 3: Select passenger from saved list
    const savedPaxBtns = await page.locator('.booking-passenger').all();
    let paxSelected = false;
    for (const btn of savedPaxBtns) {
      const text = await btn.textContent();
      if (text?.includes(passenger.name)) {
        await btn.click({ force: true });
        paxSelected = true;
        break;
      }
    }
    if (!paxSelected) {
      throw new Error(`未找到乘机人 "${passenger.name}"，请先在东方航空APP中添加`);
    }
    await page.waitForTimeout(800);

    // Step 4: Click 下一步 (passenger step)
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('button')).find(b =>
        b.textContent?.trim() === '下一步' && !b.disabled && b.getBoundingClientRect().width > 0
      )?.click();
    });
    await page.waitForTimeout(2000);

    // Step 5: Handle lithium battery safety notice modal
    await page.evaluate(() => {
      document.querySelectorAll('[class*="modal"]').forEach(modal => {
        if (modal.getBoundingClientRect().width < 100 || !modal.textContent?.includes('锂电池')) return;
        modal.querySelectorAll('input[type="checkbox"]').forEach(cb => { if (!cb.checked) cb.click(); });
        modal.querySelectorAll('[class*="agree"], [class*="check"]').forEach(el => el.click());
        modal.querySelectorAll('button').forEach(btn => {
          const t = btn.textContent?.trim();
          if ((t?.includes('确定') || t?.includes('同意')) && btn.getBoundingClientRect().width > 0) btn.click();
        });
      });
    });
    await page.waitForTimeout(1000);

    // Step 6: Click second 下一步 → navigates to addServices
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'))
        .filter(b => b.textContent?.trim() === '下一步' && !b.disabled && b.getBoundingClientRect().width > 0);
      if (btns.length > 0) btns[btns.length - 1].click();
    });
    await page.waitForTimeout(5000);

    // Step 7: On addServices page — set contact and submit
    const currentRoute = await page.evaluate(() => window.$nuxt?.$route?.name);
    if (currentRoute !== 'addServices') {
      throw new Error('未能进入增值服务页面，请重试');
    }

    // Set contact info in Vuex state
    await page.evaluate((contactInfo) => {
      const store = window.$nuxt.$store;
      const flight = store.state.flight;
      const contact = {
        id: 0, userId: 0, name: contactInfo.name,
        mobile: contactInfo.phone, email: null, versionNum: null,
      };
      flight.selectContact = contact;
      flight.contactParam = {
        contactName: contactInfo.name,
        contactMobile: contactInfo.phone,
        contactMobCountry: '86',
      };
    }, { name: passenger.name, phone: passenger.phone || contact?.phone || '' });

    // Listen for the booking API response
    let bookingResponse = null;
    const responseHandler = async (resp) => {
      if (resp.url() === 'https://www.ceair.com/portal/v3/booking/') {
        bookingResponse = await resp.json().catch(() => null);
      }
    };
    page.on('response', responseHandler);

    // Call submit() on the addServices component
    await page.evaluate(() => {
      const nuxt = window.$nuxt;
      for (const record of nuxt.$route.matched) {
        for (const inst of Object.values(record.instances || {})) {
          if (inst?.$options?.name === 'add-services') {
            try { inst.submit(); } catch (e) { /* submit handles its own errors */ }
            return;
          }
        }
      }
    });

    // Wait for booking API response
    await page.waitForTimeout(8000);
    page.off('response', responseHandler);

    return bookingResponse;
  }

  /**
   * Dismiss all modal overlays
   */
  async _dismissModals() {
    await this.page.evaluate(() => {
      document.querySelectorAll(
        '.ceair-modal-wrap, .v-transfer-dom, .ceair-mask, .ceair-modal'
      ).forEach((el) => el.remove());
    });
  }

  async getPayUrl(orderNo) {
    return this._apiRequest(`${BASE_URL}/portal/ordertype/getPayUrl`, {
      orderNo,
    });
  }

  async queryOrderList(params = {}) {
    await this._ensureBrowser();
    return this.page.evaluate(async (p) => {
      const http = window.$nuxt?.$http;
      if (!http?.order?.getAllOrderList) {
        return { resultCode: 'ERROR', resultMsg: 'no $http.order' };
      }
      return http.order.getAllOrderList({ page: 1, pageSize: 10, ...p });
    }, params);
  }

  /**
   * Get full order detail (passengers, segments, seats, etc.)
   */
  async getOrderDetail(tradeOrderNo) {
    await this._ensureBrowser();
    return this.page.evaluate(async (tradeOrderNo) => {
      const http = window.$nuxt?.$http;
      if (!http?.order?.getTicketDetail301) {
        return { resultCode: 'ERROR', resultMsg: 'no detail API' };
      }
      return http.order.getTicketDetail301({ orderNo: tradeOrderNo });
    }, tradeOrderNo);
  }

  /**
   * Cancel an unpaid order
   * Retries with fresh Nuxt loading if the first attempt fails.
   */
  async cancelOrder(tradeOrderNo) {
    await this._ensureBrowser();

    const attemptCancel = async () => {
      return this.page.evaluate(async (tradeOrderNo) => {
        const http = window.$nuxt?.$http;
        if (!http?.order?.cancelTicketOrder) {
          return { resultCode: 'ERROR', resultMsg: 'no cancel API' };
        }
        return http.order.cancelTicketOrder({ tradeOrderNo, orderType: 'AT' });
      }, tradeOrderNo);
    };

    // First attempt
    let result = await attemptCancel();

    // If failed (no Nuxt or WAF blocked), reload and retry
    if (result.resultCode === 'ERROR' || result.resultCode === 'FETCH_ERROR') {
      await this._ensureNuxtReady();
      result = await attemptCancel();
    }

    return result;
  }
}

module.exports = CeairApi;
