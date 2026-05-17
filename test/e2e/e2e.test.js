/**
 * End-to-end tests against the real ceair.com website.
 *
 * If no session exists, triggers QR code login automatically —
 * scan with 东方航空APP when prompted.
 *
 * Run:
 *   npm run test:e2e
 *
 * Tests are read-only — no orders are created or cancelled.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const qrcode = require('qrcode-terminal');
const chalk = require('chalk');
const ora = require('ora');

const CeairApi = require('../../src/api');
const SessionManager = require('../../src/session');
const { displayFlights, formatDate } = require('../../src/display');
const { resolveCity, getCityName } = require('../../src/cities');

// Configurable departure date: CEAIR_E2E_DATE=2026-06-15 npm run test:e2e
// Defaults to 7 days from today. If set explicitly, tests fail when no flights found.
// If auto-generated, tests will try additional dates before failing.
const E2E_EXPLICIT_DATE = !!process.env.CEAIR_E2E_DATE;
const E2E_DEPARTURE_DATE = process.env.CEAIR_E2E_DATE || (() => {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().substring(0, 10);
})();

// Fallback dates to try if the primary date has no flights (auto-generated only)
function* dateCandidates(primaryDate) {
  yield primaryDate;
  if (E2E_EXPLICIT_DATE) return; // human picked this date, don't override
  const d = new Date(primaryDate);
  for (const offset of [14, 3, 10, 21]) {
    d.setDate(d.getDate() + offset - 7); // relative offsets from original
    yield d.toISOString().substring(0, 10);
    d.setDate(d.getDate() - offset + 7); // reset
  }
}

const STATE_FILE = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'ceair-cli', 'browser-state.json'
);

let api = null;
let session = null;

// ─── Before: load or login ──────────────────────────────────────

before(async () => {
  session = new SessionManager();

  // Try loading existing session
  let loaded = false;
  if (fs.existsSync(STATE_FILE)) {
    try { loaded = await session.load(); } catch { loaded = false; }
  }

  if (!loaded) {
    // No valid session — do QR login
    console.log(chalk.yellow('\nNo valid session found. Starting QR login...\n'));

    const loginApi = session.api;
    await loginApi._ensureBrowser(true);

    // Navigate to SSO page and extract UUID from Vue component
    const spinner = ora('Getting QR code...').start();
    await loginApi.page.goto(
      'https://sso.ceair.com/new/login?type=ffp&lang=zh_CNY',
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );
    // Wait for Vue to hydrate
    await loginApi.page.waitForTimeout(6000);

    const uuidData = await loginApi.page.evaluate(() => {
      const app = document.querySelector('#app');
      if (!app || !app.__vue__) return { uuid: null };
      function findComponent(comp, depth = 0) {
        if (!comp || depth > 10) return null;
        if (comp.$options?.methods?.getUUID) return comp;
        for (const child of comp.$children || []) {
          const found = findComponent(child, depth + 1);
          if (found) return found;
        }
        return null;
      }
      const login = findComponent(app.__vue__);
      return { uuid: login?.uuid || null };
    });

    const { uuid } = uuidData;

    if (!uuid) {
      spinner.fail('Failed to get QR code');
      throw new Error('Could not get QR UUID from SSO page');
    }
    spinner.stop();

    // Display QR in terminal
    const qrContent = `uuid=${uuid}`;
    console.log(chalk.bold('\n请使用 东方航空APP 扫描以下二维码登录：\n'));
    qrcode.generate(qrContent, { small: true });
    console.log(chalk.gray(`\nQR content: ${qrContent}`));
    console.log(chalk.gray('Expires in 2 minutes.\n'));

    // Poll for scan confirmation
    const pollSpinner = ora('Waiting for scan... (0s / 120s)').start();
    const startTime = Date.now();
    const TIMEOUT_MS = 120_000;
    const POLL_MS = 3000;
    let scanned = false;
    let loginDone = false;

    // Capture ssouserid from component polling
    let ssouserid = null;
    const captureHandler = (req) => {
      if (req.url().includes('isconfirmbyscan') && !ssouserid) {
        ssouserid = req.headers()['ssouserid'];
      }
    };
    loginApi.page.on('request', captureHandler);

    for (let wait = 0; wait < 10 && !ssouserid; wait++) {
      await loginApi.page.waitForTimeout(1000);
    }

    if (ssouserid) {
      loginApi.page.off('request', captureHandler);
      await loginApi.page.evaluate(() => {
        const app = document.querySelector('#app');
        if (!app || !app.__vue__) return;
        function findComponent(comp, depth = 0) {
          if (!comp || depth > 10) return null;
          if (comp.$options?.methods?.getUUID) return comp;
          for (const child of comp.$children || []) {
            const found = findComponent(child, depth + 1);
            if (found) return found;
          }
          return null;
        }
        const login = findComponent(app.__vue__);
        if (login) {
          clearInterval(login.scanrecur);
          clearTimeout(login.scanrecur);
        }
      });
    }

    while (Date.now() - startTime < TIMEOUT_MS) {
      const pollResult = await loginApi.page.evaluate(async ({ uuid, ssouserid }) => {
        try {
          const resp = await fetch('/mumember/api/sso/login/isconfirmbyscan', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'ssouserid': ssouserid || '',
              'currencycode': 'CNY',
              'languagecode': 'zh',
            },
            credentials: 'include',
            body: JSON.stringify({ uuid, salesChannel: '7690' }),
          });
          return await resp.json();
        } catch (e) {
          return { resultCode: 'FETCH_ERROR', resultMsg: e.message };
        }
      }, { uuid, ssouserid });

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const content = pollResult?.resultContent || {};

      if (content.isScanExpire || pollResult?.resultCode === '-100') {
        pollSpinner.fail('QR code expired');
        throw new Error('QR code expired — run tests again');
      }

      if (content.isLogin) {
        loginDone = true;
        pollSpinner.text = 'Establishing session...';

        let navOk = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await loginApi.page.goto('https://www.ceair.com/zh/cny/home', {
              waitUntil: 'domcontentloaded', timeout: 30000,
            });
            await loginApi.page.waitForTimeout(4000);
            const hasNuxt = await loginApi.page.evaluate(() => !!window.$nuxt);
            if (hasNuxt) { navOk = true; break; }
          } catch {}
          await loginApi.page.waitForTimeout(2000);
        }

        await session.save();
        pollSpinner.succeed(chalk.green('✓ QR login successful!'));

        if (!navOk) {
          console.log(chalk.yellow('  ⚠ Homepage blocked by WAF, session may be unstable.'));
        }

        try {
          const check = await loginApi.checkToken();
          if (check.data) {
            const name = check.data.name || check.data.userName || check.data.memberName;
            if (name) console.log(chalk.white(`  User: ${name}`));
            if (check.data.ffpCardNo) console.log(chalk.white(`  Card: ${check.data.ffpCardNo}`));
          }
        } catch {}
        break;
      }

      if (content.isScan && !scanned) {
        scanned = true;
        pollSpinner.text = chalk.cyan('✋ Scanned! Tap confirm on your phone...');
      } else if (!scanned) {
        pollSpinner.text = `Waiting for scan... (${elapsed}s / 120s)`;
      }

      await new Promise(r => setTimeout(r, POLL_MS));
    }

    if (!loginDone) {
      pollSpinner.fail('Login timed out');
      throw new Error('Login timed out — run tests again');
    }
  }

  // At this point we must have a working session
  api = session.api;

  // After QR login, the page is on the SSO domain.
  // _ensureNuxtReady will navigate to homepage and wait for Nuxt.
  await api._ensureNuxtReady();

  // Verify login
  const isLogin = await api.page.evaluate(() =>
    window.$nuxt?.$store?.state?.user?.isLogin === true
  );
  if (!isLogin) {
    throw new Error('Login succeeded but session is invalid — try running again');
  }
});

after(async () => {
  if (session) await session.cleanup();
});

// ═══════════════════════════════════════════════════════════════════
// Session
// ═══════════════════════════════════════════════════════════════════

describe('Session', () => {

  it('Nuxt is loaded with $store', async () => {
    const hasNuxt = await api.page.evaluate(() => !!window.$nuxt);
    assert.ok(hasNuxt, '$nuxt should exist');

    const hasStore = await api.page.evaluate(() =>
      !!window.$nuxt?.$store?.state
    );
    assert.ok(hasStore, '$nuxt.$store.state should exist');
  });

  it('checkToken API returns a valid response', async () => {
    const result = await api.checkToken();
    // checkToken is unreliable (often returns A403 for idle sessions)
    // Just verify it responds, not that it succeeds
    assert.ok(result.resultCode, 'Should return a resultCode');
    assert.ok(['A200', 'A403', 'T200'].includes(result.resultCode),
      `Unexpected resultCode: ${result.resultCode}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Flight search
// ═══════════════════════════════════════════════════════════════════

describe('Search flights', () => {

  it('search returns S200 with flights', async () => {
    const routes = [
      { from: 'SHA', to: 'BJS' },
      { from: 'SHA', to: 'CTU' },
      { from: 'SHA', to: 'CAN' },
      { from: 'BJS', to: 'CTU' },
      { from: 'BJS', to: 'CAN' },
    ];

    let result = null;
    let usedDate = null;

    for (const date of dateCandidates(E2E_DEPARTURE_DATE)) {
      for (const route of routes) {
        const attempt = await api.searchFlights({
          depCity: route.from, arrCity: route.to, depDate: date, adult: 1,
        });

        if (attempt.resultCode === 'S200' && attempt.data?.flightItems?.length > 0) {
          result = attempt;
          usedDate = date;
          break;
        }

        await api._ensureNuxtReady();
      }
      if (result) break;
    }

    assert.ok(result, `No flights found on any route/date (tried around ${E2E_DEPARTURE_DATE})`);
    if (usedDate !== E2E_DEPARTURE_DATE) {
      console.log(chalk.gray(`  Note: primary date ${E2E_DEPARTURE_DATE} had no flights, used ${usedDate}`));
    }

    const items = result.data?.flightItems;
    assert.ok(Array.isArray(items), 'data.flightItems should be array');
    assert.ok(items.length > 0, 'Should return at least 1 flight');

    // Stash for next tests
    global._searchResult = result;

    for (const item of items) {
      const segs = item.flightInfos?.[0]?.flightSegments;
      assert.ok(segs?.length > 0, 'Each item should have segments');
      assert.ok(segs[0].carrierCode, 'Segment should have carrierCode');
      assert.ok(segs[0].flightNo, 'Segment should have flightNo');
    }
  });

  it('displayFlights returns flightItemIndex for every flight', async () => {
    const result = global._searchResult;
    assert.ok(result, 'Previous search should have a result');

    const flights = displayFlights(result);
    assert.ok(flights.length > 0, 'Should display flights');

    const flightItems = result.data?.flightItems || [];
    for (const f of flights) {
      assert.ok(f.flightItemIndex !== undefined,
        `${f.flightNo} missing flightItemIndex`);
      assert.ok(f.flightItemIndex < flightItems.length,
        `${f.flightNo} flightItemIndex ${f.flightItemIndex} >= ${flightItems.length}`);
      assert.ok(f.flightNo, 'Should have flightNo');
      assert.ok(f.depTime, 'Should have depTime');
      assert.ok(f.arrTime, 'Should have arrTime');
    }
  });

  it('flightItemIndex correctly maps back to the source flightItem', async () => {
    const result = global._searchResult;
    assert.ok(result, 'Previous search should have a result');

    const flights = displayFlights(result);
    const flightItems = result.data?.flightItems || [];

    for (const f of flights) {
      const source = flightItems[f.flightItemIndex];
      assert.ok(source, `flightItem at index ${f.flightItemIndex} should exist`);

      const sourceSeg = source.flightInfos?.[0]?.flightSegments?.[0];
      assert.ok(sourceSeg, `Source segment should exist at index ${f.flightItemIndex}`);
      const sourceNo = (sourceSeg.carrierCode || '') + sourceSeg.flightNo;
      assert.equal(f.flightNo, sourceNo,
        `Display flightNo ${f.flightNo} should match source ${sourceNo}`);
    }
  });

  it('second search returns a valid response with flights', async () => {
    await api._ensureNuxtReady();

    const routes = [
      { from: 'SHA', to: 'CTU' },
      { from: 'SHA', to: 'CAN' },
      { from: 'BJS', to: 'CTU' },
      { from: 'BJS', to: 'CAN' },
    ];

    let result = null;
    for (const date of dateCandidates(E2E_DEPARTURE_DATE)) {
      for (const route of routes) {
        const attempt = await api.searchFlights({
          depCity: route.from, arrCity: route.to, depDate: date, adult: 1,
        });

        if (attempt.resultCode === 'S200' && attempt.data?.flightItems?.length > 0) {
          result = attempt;
          break;
        }

        await api._ensureNuxtReady();
      }
      if (result) break;
    }

    assert.ok(result, `No flights found on any route/date for second search`);

    const items = result.data?.flightItems;
    assert.ok(Array.isArray(items), 'data.flightItems should be array');
    assert.ok(items.length > 0, 'Should have at least 1 flight');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Orders
// ═══════════════════════════════════════════════════════════════════

describe('Orders', () => {

  it('queryOrderList returns success with a list', async () => {
    // Navigate back to homepage first (search may have left us on /shopping/)
    await api._ensureNuxtReady();

    const result = await api.queryOrderList({ page: 1 });
    assert.ok(['A200', 'T200', 'S200'].includes(result.resultCode),
      `Expected success code, got ${result.resultCode}: ${result.resultMsg}`);
    assert.ok(result.data, 'Should return data');
    assert.ok(Array.isArray(result.data.list), 'data.list should be array');
  });

  it('order items have required fields', async () => {
    const result = await api.queryOrderList({ page: 1 });
    const orders = result.data?.list || [];

    if (orders.length === 0) {
      // No orders is valid — just verify the structure
      assert.ok(true, 'No orders, structure valid');
      return;
    }

    for (const order of orders) {
      assert.ok(order.tradeOrderNo, 'Order should have tradeOrderNo');
      assert.ok(order.orderStatus, 'Order should have orderStatus');
    }
  });

  it('getOrderDetail works for an existing order', async () => {
    const listResult = await api.queryOrderList({ page: 1 });
    const orders = listResult.data?.list || [];

    if (orders.length === 0) {
      assert.ok(true, 'No orders to test detail');
      return;
    }

    const orderNo = orders[0].tradeOrderNo;
    const detail = await api.getOrderDetail(orderNo);

    assert.ok(detail, 'Should return a result');
    assert.ok(detail.resultCode, 'Should have resultCode');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Session persistence
// ═══════════════════════════════════════════════════════════════════

describe('Session persistence', () => {

  it('save + load roundtrip works', async () => {
    await api._ensureNuxtReady();
    await api.saveState();

    assert.ok(fs.existsSync(STATE_FILE), 'State file should exist');
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    assert.ok(state.cookies?.length > 0, 'Should have cookies');

    const hasLoginCookie = state.cookies.some(c =>
      c.name === 'ceair.login.token' || c.name === 'com.ceair.cesso'
    );
    assert.ok(hasLoginCookie, 'Should have login cookie');

    // Load with a fresh SessionManager
    const session2 = new SessionManager();
    const loaded = await session2.load();
    assert.ok(loaded, 'Fresh SessionManager should load the saved session');

    const info = session2.userInfo;
    assert.ok(info?.name, 'Should have user name');
    await session2.cleanup();
  });
});
