/**
 * CEAir API Client using Playwright
 *
 * Connects to the persistent browser managed by BrowserPool.
 * No browser launch/close — that's handled by session start/stop.
 */

const path = require('path');
const fs = require('fs');
const pool = require('./browser-pool');

const BASE_URL = 'https://www.ceair.com';
const SSO_URL = 'https://sso.ceair.com';
const SSO_API = '/mumember/api/sso';

class CeairApi {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  /**
   * Connect to the persistent browser.
   * Throws if no session is active.
   */
  async connect() {
    const { browser, context, page } = await pool.connect();
    this.browser = browser;
    this.context = context;
    this.page = page;
  }

  /**
   * Disconnect from the browser (keeps it alive).
   * Call at the end of every CLI command.
   */
  disconnect() {
    if (this.browser) {
      pool.disconnect(this.browser);
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }

  /**
   * Make an API request through the browser context (bypasses WAF).
   * Auto-connects if needed.
   */
  async _apiRequest(url, body = null, method = 'POST') {
    await this.connect();

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

  // ─── Authentication ────────────────────────────────────────────

  async checkToken() {
    return this._apiRequest(
      `${BASE_URL}/portal/v3/member/newCheckToken`,
      {}
    );
  }

  // ─── Homepage / Nuxt ──────────────────────────────────────────

  /**
   * Ensure the homepage is loaded and Nuxt is ready.
   */
  async _ensureNuxtReady() {
    await this.connect();

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

  // ─── Flight Search ─────────────────────────────────────────────

  /**
   * Search flights by simulating user interaction on the homepage.
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
    const dateSet = await this.page.evaluate((dateStr) => {
      // Strategy 1: Set date via the CeairForm model (most reliable)
      const forms = document.querySelectorAll('form, .ceair-form');
      for (const form of forms) {
        let el = form;
        for (let i = 0; i < 5; i++) {
          const vue = el.__vue__;
          if (vue?.model?.datePicker) {
            const dp = vue.model.datePicker;
            if (dp.selectRangeDateValue) {
              dp.selectRangeDateValue.goDate = dateStr;
            }
            if (dp.singleValue !== undefined) {
              dp.singleValue = dateStr;
            }
            return 'form-model';
          }
          el = el.parentElement;
          if (!el) break;
        }
      }

      // Strategy 2: Find datePicker component and set its data
      const inputs = document.querySelectorAll('input.ceair-input__inner');
      for (const input of inputs) {
        if (input.classList.contains('ceair-input__inner_homesearch')) continue;
        if (input.type !== 'text') continue;
        if (input.getBoundingClientRect().width < 100) continue;
        let el = input.parentElement;
        for (let i = 0; i < 10; i++) {
          const vue = el?.__vue__;
          if (vue?.$options?.methods?.sendValue) {
            vue.selectDateValue = dateStr;
            if (vue.selectRangeDateValue) {
              vue.selectRangeDateValue.goDate = dateStr;
            }
            vue.$emit('input', dateStr);
            vue.$emit('change', dateStr);
            if (typeof vue.sendValue === 'function') vue.sendValue(dateStr);
            return 'datepicker-component';
          }
          el = el?.parentElement;
          if (!el) break;
        }
      }

      return 'failed';
    }, depDate);

    // Verify the date was actually set
    await this.page.waitForTimeout(500);
    const dateVerified = await this.page.evaluate(() => {
      const forms = document.querySelectorAll('form, .ceair-form');
      for (const form of forms) {
        let el = form;
        for (let i = 0; i < 5; i++) {
          const vue = el.__vue__;
          if (vue?.model?.datePicker) {
            const dp = vue.model.datePicker;
            return {
              goDate: dp.selectRangeDateValue?.goDate,
              singleValue: dp.singleValue,
            };
          }
          el = el.parentElement;
          if (!el) break;
        }
      }
      return null;
    });

    if (dateVerified && dateVerified.goDate !== depDate && dateVerified.singleValue !== depDate) {
      console.warn(`Date fill failed: requested=${depDate}, goDate=${dateVerified.goDate}, singleValue=${dateVerified.singleValue}`);
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

    const result = await Promise.race([
      networkPromise,

      (async () => {
        try {
          await this.page.waitForURL('**/shopping/**', { timeout: 15000 });
          const navResult = await Promise.race([
            networkPromise,
            (async () => {
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
              return networkPromise;
            })(),
            new Promise((r) => setTimeout(() => r(null), 15000)),
          ]);
          this.page.off('response', handler);
          return navResult;
        } catch { return null; }
      })(),

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
    await this._dismissModals();

    // Wait for shopping page cabin elements to render (may need a moment)
    try {
      await page.waitForSelector('.cabin-level-item', { timeout: 15000 });
    } catch {
      // If no cabin items, we may have navigated away — try going back to shopping
      throw new Error('购物页面未加载，请重新搜索后重试');
    }

    const flightItems = searchResult?.data?.flightItems || [];
    if (flightItemIndex >= flightItems.length) {
      throw new Error(`航班序号 ${flightItemIndex} 超出范围`);
    }

    // Verify the flight at flightItemIndex matches what we expect
    const expectedFlight = flightItems[flightItemIndex];
    const expectedSeg = expectedFlight.flightInfos?.[0]?.flightSegments?.[0];
    const expectedFlightNo = expectedSeg
      ? (expectedSeg.carrierCode || expectedSeg.airlineCode || '') + expectedSeg.flightNo
      : null;

    // Calculate correct DOM offset for the cabin price button.
    // The DOM has .cabin-level-item elements per flight, including unavailable
    // slots (ptr=false). We must count .pointer elements in the DOM, not
    // cabinInfoDescs from the API, because the counts differ.
    // Strategy: find the Nth flight's cabin area, then click the Mth .pointer
    // within that flight.
    const domOffset = await page.evaluate(({ flightItemIndex, cabinIndex }) => {
      // Each flight has a container with flight number text.
      // Walk all .cabin-level-item elements and group them by flight.
      const allItems = document.querySelectorAll('.cabin-level-item');
      let currentFlightIdx = -1;
      let lastFlightNo = null;
      let ptrCountInCurrentFlight = 0;
      let targetButtonIdx = -1;
      let globalPtrIdx = 0;
      const debug = [];

      for (const item of allItems) {
        // Detect flight boundary: walk up to find flight number
        let flightNo = null;
        let el = item;
        for (let d = 0; d < 20; d++) {
          el = el.parentElement;
          if (!el) break;
          const spans = el.querySelectorAll('span');
          for (const s of spans) {
            if (s.textContent?.match(/^[A-Z]{2}\d{3,4}$/)) {
              flightNo = s.textContent.trim();
              break;
            }
          }
          if (flightNo) break;
        }

        if (flightNo !== lastFlightNo) {
          if (currentFlightIdx >= flightItemIndex - 1 && currentFlightIdx <= flightItemIndex + 1) {
            debug.push({fi: currentFlightIdx, fn: lastFlightNo, ptrs: ptrCountInCurrentFlight});
          }
          currentFlightIdx++;
          lastFlightNo = flightNo;
          ptrCountInCurrentFlight = 0;
        }

        const isPointer = item.classList.contains('pointer');
        if (!isPointer) continue;

        if (currentFlightIdx === flightItemIndex) {
          if (ptrCountInCurrentFlight === cabinIndex) {
            targetButtonIdx = globalPtrIdx;
            break;
          }
          ptrCountInCurrentFlight++;
        }
        globalPtrIdx++;
      }
      // Add last flight
      debug.push({fi: currentFlightIdx, fn: lastFlightNo, ptrs: ptrCountInCurrentFlight});

      return { targetButtonIdx, debug, totalItems: allItems.length };
    }, { flightItemIndex, cabinIndex });

    console.error('[booking] DOM scan result:', JSON.stringify(domOffset));

    if (domOffset.targetButtonIdx < 0) {
      throw new Error(`无法定位到航班 ${expectedFlightNo} 的第 ${cabinIndex} 个舱位按钮`);
    }

    // Verify we're on the right search results page
    const currentUrl = page.url();
    const expectedDate = expectedSeg?.fltDate || '';
    const urlHasCorrectDate = currentUrl.includes(expectedDate) ||
      await page.evaluate((d) => {
        const sq = window.$nuxt?.$store?.state?.flight?.searchFlightQuery;
        return sq?.date === d;
      }, expectedDate);

    const domVerified = await page.evaluate((expectedFlightNo) => {
      const allText = document.body.innerText;
      const noSpace = allText.includes(expectedFlightNo);
      const withSpace = allText.includes(
        expectedFlightNo.replace(/^([A-Z]+)(\d+)$/, '$1 $2')
      );
      return { noSpace, withSpace, hasExpected: noSpace || withSpace };
    }, expectedFlightNo);

    if (!domVerified.hasExpected && !urlHasCorrectDate) {
      throw new Error(
        `页面验证失败：未找到航班 ${expectedFlightNo}，URL=${currentUrl}。` +
        `搜索结果可能已过期，请重新搜索。`
      );
    }

    // Scroll the target flight into view
    await page.evaluate((idx) => {
      const btns = document.querySelectorAll('.cabin-select.pointer');
      if (btns[idx]) btns[idx].scrollIntoView({ block: 'center' });
    }, domOffset.targetButtonIdx);
    await page.waitForTimeout(500);

    // Click the target cabin price
    const priceButtons = await page.locator('.cabin-select.pointer').all();
    if (domOffset.targetButtonIdx >= priceButtons.length) {
      throw new Error('无法定位到所选航班的价格按钮');
    }

    await priceButtons[domOffset.targetButtonIdx].click({ force: true });
    await page.waitForResponse(
      (resp) => resp.url().includes('fareDetail'),
      { timeout: 15000 }
    ).catch(() => {});
    await page.waitForTimeout(2000);

    // Click "选购" button
    const selectBtn = page.locator('.fare-btn-txt').first();
    const selectVisible = await selectBtn.isVisible().catch(() => false);
    if (!selectVisible) {
      await this._dismissModals();
      await priceButtons[domOffset.targetButtonIdx].click({ force: true });
      await page.waitForResponse(
        (resp) => resp.url().includes('fareDetail'),
        { timeout: 15000 }
      ).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Navigate to booking-new via onClickConfirm
    await page.evaluate(() => {
      const btn = document.querySelector('.fare-btn-txt');
      if (btn && btn.__vue__) {
        btn.__vue__.$parent.onClickConfirm(btn.__vue__.$parent.item);
      }
    });
    await page.waitForTimeout(4000);
    await this._dismissModals();

    // Step 3: Select passenger
    await page.waitForTimeout(2000);

    let savedPaxBtns = await page.locator('.booking-passenger').all();
    if (savedPaxBtns.length === 0) {
      savedPaxBtns = await page.locator('[class*="passenger"][class*="card"], [class*="passenger"][class*="item"], [class*="pax-"]').all();
    }
    if (savedPaxBtns.length === 0) {
      const nameElements = await page.locator(`text=${passenger.name}`).all();
      for (const el of nameElements) {
        const box = await el.boundingBox();
        if (box && box.width > 50) {
          await el.click({ force: true });
          savedPaxBtns = [el];
          break;
        }
      }
    }

    let paxSelected = false;
    for (const btn of savedPaxBtns) {
      const text = await btn.textContent();
      if (text?.includes(passenger.name)) {
        await btn.click({ force: true });
        paxSelected = true;
        break;
      }
    }

    if (!paxSelected && savedPaxBtns.length > 0) {
      await savedPaxBtns[0].click({ force: true });
      paxSelected = true;
    }
    if (!paxSelected) {
      throw new Error(`未找到乘机人 "${passenger.name}"，请先在东方航空APP中添加`);
    }
    await page.waitForTimeout(800);

    // Step 4: Click 下一步
    await page.evaluate(() => {
      Array.from(document.querySelectorAll('button')).find(b =>
        b.textContent?.trim() === '下一步' && !b.disabled && b.getBoundingClientRect().width > 0
      )?.click();
    });
    await page.waitForTimeout(2000);

    // Step 5: Handle lithium battery safety modal
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

    // Step 6: Click second 下一步 → addServices
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

    await page.evaluate((paxInfo) => {
      const store = window.$nuxt.$store;
      const flight = store.state.flight;
      const contact = {
        id: 0, userId: 0, name: paxInfo.name,
        mobile: paxInfo.phone, email: null, versionNum: null,
      };
      flight.selectContact = contact;
      flight.contactParam = {
        contactName: paxInfo.name,
        contactMobile: paxInfo.phone,
        contactMobCountry: '86',
      };
      const existingPax = flight.selectPassengers;
      const paxParam = flight.passengerParam?.paxs?.[0];
      if (!existingPax || !existingPax[0]?.certNo) {
        flight.selectPassengers = [{
          id: paxParam?.favorPaxIdDtoList?.[0]?.id || 0,
          userId: 0,
          name: paxInfo.name,
          certType: 'NI',
          certNo: paxInfo.idNo || paxParam?.certNo || '',
          certValidity: paxParam?.certValidity || '',
          birthday: paxParam?.birthday || '',
          mobile: paxInfo.phone,
          email: paxParam?.email || null,
          nationality: paxParam?.nationality || 'CN',
          gender: paxParam?.gender || '',
          firstName: paxParam?.firstName || '',
          lastName: paxParam?.lastName || '',
          firstNameEn: paxParam?.firstNameEn || '',
          lastNameEn: paxParam?.lastNameEn || '',
        }];
      }
    }, { name: passenger.name, phone: passenger.phone || contact?.phone || '', idNo: passenger.idNo });

    // Listen for the booking API response
    let bookingResponse = null;
    const responseHandler = async (resp) => {
      if (resp.url() === 'https://www.ceair.com/portal/v3/booking/') {
        bookingResponse = await resp.json().catch(() => null);
      }
    };
    page.on('response', responseHandler);

    const addServicesRoute = await page.evaluate(() => window.$nuxt?.$route?.name);
    if (addServicesRoute !== 'addServices') {
      throw new Error('未能进入增值服务页面，请重试');
    }

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

  async queryOrderList(params = {}) {
    await this.connect();
    return this.page.evaluate(async (p) => {
      const http = window.$nuxt?.$http;
      if (!http?.order?.getAllOrderList) {
        return { resultCode: 'ERROR', resultMsg: 'no $http.order' };
      }
      return http.order.getAllOrderList({ page: 1, pageSize: 10, ...p });
    }, params);
  }

  async getOrderDetail(tradeOrderNo) {
    await this.connect();
    return this.page.evaluate(async (tradeOrderNo) => {
      const http = window.$nuxt?.$http;
      if (!http?.order?.getTicketDetail301) {
        return { resultCode: 'ERROR', resultMsg: 'no detail API' };
      }
      return http.order.getTicketDetail301({ orderNo: tradeOrderNo });
    }, tradeOrderNo);
  }

  async cancelOrder(tradeOrderNo) {
    await this.connect();

    const attemptCancel = async () => {
      return this.page.evaluate(async (tradeOrderNo) => {
        const http = window.$nuxt?.$http;
        if (!http?.order?.cancelTicketOrder) {
          return { resultCode: 'ERROR', resultMsg: 'no cancel API' };
        }
        return http.order.cancelTicketOrder({ tradeOrderNo, orderType: 'AT' });
      }, tradeOrderNo);
    };

    let result = await attemptCancel();

    if (result.resultCode === 'ERROR' || result.resultCode === 'FETCH_ERROR') {
      await this._ensureNuxtReady();
      result = await attemptCancel();
    }

    return result;
  }
}

module.exports = CeairApi;
