#!/usr/bin/env node
/**
 * CEAir Booking CLI
 * Search, login, and book flights on China Eastern Airlines from the command line.
 *
 * Uses Playwright browser to bypass WAF/bot protection.
 * Login opens a visible browser window for CAPTCHA verification.
 */

const { Command } = require('commander');
const inquirer = require('inquirer');
const chalk = require('chalk');
const ora = require('ora');
const SessionManager = require('../src/session');
const { resolveCity, getCityName, listCities } = require('../src/cities');
const { displayFlights, displayBookingResult, displayUpcomingTrips, formatDate } = require('../src/display');

const program = new Command();

// ─── Search Command ──────────────────────────────────────────────

program
  .command('search <from> <to> <date>')
  .description('Search flights (e.g. search SHA BJS 2025-06-15)')
  .option('-r, --return <retDate>', 'Return date (for round-trip)')
  .option('-a, --adults <num>', 'Number of adults', '1')
  .option('-c, --children <num>', 'Number of children', '0')
  .option('--cabin <class>', 'Cabin class: Y(经济) C(商务) F(头等)', 'Y')
  .addHelpText('after', `\nExamples:\n  $ ceair-cli search SHA BJS 2025-06-15\n  $ ceair-cli search 上海 北京 2025-06-15 --cabin C\n  $ ceair-cli search SHA BJS 2025-06-15 -r 2025-06-20\n\nUse \"ceair-cli cities\" to see all supported city codes.`)
  .action(async (from, to, date, opts) => {
    const depCity = resolveCity(from);
    const arrCity = resolveCity(to);

    if (!depCity) {
      console.log(chalk.red(`无法识别出发城市: ${from}`));
      console.log(chalk.gray('使用 "ceair-cli cities" 查看支持的城市列表'));
      return;
    }
    if (!arrCity) {
      console.log(chalk.red(`无法识别到达城市: ${to}`));
      return;
    }

    const depDate = new Date(date);
    if (isNaN(depDate.getTime())) {
      console.log(chalk.red(`无效日期: ${date}，请使用 YYYY-MM-DD 格式`));
      return;
    }

    const session = new SessionManager();
    const spinner = ora('正在搜索航班...').start();

    try {
      const result = await session.api.searchFlights({
        depCity,
        arrCity,
        depDate: date,
        retDate: opts.return,
        adult: parseInt(opts.adults),
        child: parseInt(opts.children),
        cabin: opts.cabin,
      });

      spinner.stop();

      console.log(
        chalk.bold(
          `\n${getCityName(depCity)} → ${getCityName(arrCity)}  ${formatDate(date)}`
        )
      );
      if (opts.return) {
        console.log(chalk.bold(`返程: ${formatDate(opts.return)}`));
      }
      console.log(chalk.gray('─'.repeat(50)));

      displayFlights(result);
    } catch (err) {
      spinner.fail('搜索失败');
      console.error(chalk.red(err.message));
    } finally {
      await session.cleanup();
    }
  });

// ─── Login Command ───────────────────────────────────────────────

program
  .command('login')
  .description('Login to China Eastern Airlines via QR code, SMS, or password\n\n' +
    '  qrcode   Scan QR in terminal (recommended, headless)\n' +
    '  sms      Phone verification (opens browser for CAPTCHA)\n' +
    '  password Account + password (opens browser for CAPTCHA)\n\n' +
    '  Session saved to ~/.config/ceair-cli/browser-state.json')
  .option('-m, --method <type>', 'Login method: qrcode, sms, or password')
  .addHelpText('after', '\nExamples:\n  $ ceair-cli login --method qrcode\n  $ ceair-cli login -m sms')
  .action(async (opts) => {
    const session = new SessionManager();

    // Check existing session
    try {
      const restored = await session.load();
      if (restored) {
        console.log(chalk.green('✓ 已有有效登录会话，无需重新登录。'));
        console.log(chalk.gray('  如需切换账号，请先执行 ceair logout'));
        await session.cleanup();
        return;
      }
    } catch {
      // Session check failed, proceed with login
    }

    let loginMethod = opts.method;
    if (!loginMethod || !['sms', 'password', 'qrcode'].includes(loginMethod)) {
      const answer = await inquirer.prompt([
        {
          type: 'list',
          name: 'loginMethod',
          message: '选择登录方式:',
          choices: [
            { name: '📱 二维码扫码登录 (推荐 — 无需验证码)', value: 'qrcode' },
            { name: '📲 手机验证码登录', value: 'sms' },
            { name: '🔑 账号密码登录 (会员卡号/手机号/邮箱)', value: 'password' },
          ],
        },
      ]);
      loginMethod = answer.loginMethod;
    }

    try {
      let result;

      if (loginMethod === 'qrcode') {
        // ─── QR Code Login ─────────────────────────────
        const qrcode = require('qrcode-terminal');

        // Step 1: Get UUID from SSO (via the SSO page's Vue component)
        const uuidSpinner = ora('正在获取二维码...').start();
        await session.api._ensureBrowser(true);

        // Navigate to SSO login page and use the component's API wrapper
        await session.api.page.goto(
          'https://sso.ceair.com/new/login?type=ffp&lang=zh_CNY',
          { waitUntil: 'domcontentloaded', timeout: 30000 }
        );
        await session.api.page.waitForTimeout(5000);

        // Get UUID and ssouserid from the running component
        const { uuid } = await session.api.page.evaluate(() => {
          const app = document.querySelector('#app').__vue__;
          function findComponent(comp, depth = 0) {
            if (depth > 10) return null;
            if (comp.$options?.methods?.getUUID) return comp;
            for (const child of comp.$children || []) {
              const found = findComponent(child, depth + 1);
              if (found) return found;
            }
            return null;
          }
          const login = findComponent(app);
          return { uuid: login.uuid };
        });

        if (!uuid) {
          uuidSpinner.fail('获取二维码失败');
          await session.cleanup();
          return;
        }
        uuidSpinner.stop();

        // Step 2: Display QR code in terminal
        const qrContent = `uuid=${uuid}`;
        console.log(chalk.bold('\n请使用 东方航空APP 扫描以下二维码登录：\n'));
        qrcode.generate(qrContent, { small: true });
        console.log(chalk.gray(`\n二维码内容: ${qrContent}`));
        console.log(chalk.gray('有效期 2 分钟，过期请重新执行 ceair-cli login\n'));

        // Step 3: Capture ssouserid header from the component's polling,
        //         then do our own polling with raw fetch.
        const pollSpinner = ora('等待扫码... (0s / 120s)').start();
        const startTime = Date.now();
        const TIMEOUT_MS = 120_000;
        const POLL_MS = 3000;
        let scanned = false;
        let loginDone = false;

        // Capture ssouserid from the component's own polling requests
        // The component starts polling isconfirmbyscan after UUID is generated
        // We try to capture ssouserid from those requests, but if not available
        // we fall back to the component's own polling
        let ssouserid = null;
        const captureHandler = async (req) => {
          if (req.url().includes('isconfirmbyscan') && !ssouserid) {
            ssouserid = req.headers()['ssouserid'];
          }
        };
        session.api.page.on('request', captureHandler);

        // Wait up to 10s for the component to fire a poll and capture ssouserid
        for (let wait = 0; wait < 10 && !ssouserid; wait++) {
          await session.api.page.waitForTimeout(1000);
        }

        if (ssouserid) {
          // Got ssouserid — stop component timer and do our own polling
          session.api.page.off('request', captureHandler);
          await session.api.page.evaluate(() => {
            const app = document.querySelector('#app').__vue__;
            function findComponent(comp, depth = 0) {
              if (depth > 10) return null;
              if (comp.$options?.methods?.getUUID) return comp;
              for (const child of comp.$children || []) {
                const found = findComponent(child, depth + 1);
                if (found) return found;
              }
              return null;
            }
            const login = findComponent(app);
            if (login) {
              clearInterval(login.scanrecur);
              clearTimeout(login.scanrecur);
            }
          });
        } else {
          // No ssouserid — let the component poll itself and watch for cookies
          pollSpinner.text = '等待扫码... (组件轮询模式)';
        }

        // Our own polling loop with the captured ssouserid
        while (Date.now() - startTime < TIMEOUT_MS) {
          const pollResult = await session.api.page.evaluate(async ({ uuid, ssouserid }) => {
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
            pollSpinner.fail('二维码已过期，请重新执行 ceair-cli login');
            break;
          }

          if (content.isLogin) {
            loginDone = true;
            pollSpinner.text = '正在建立会话...';

            // Navigate to main site to establish session cookies (with retries)
            let navOk = false;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                await session.api.page.goto('https://www.ceair.com/zh/cny/home', {
                  waitUntil: 'domcontentloaded',
                  timeout: 30000,
                });
                await session.api.page.waitForTimeout(4000);
                // Check if Nuxt loaded (WAF didn't block)
                const hasNuxt = await session.api.page.evaluate(() => !!window.$nuxt);
                if (hasNuxt) { navOk = true; break; }
              } catch {}
              await session.api.page.waitForTimeout(2000);
            }

            await session.save();
            pollSpinner.succeed(chalk.green('✓ 扫码登录成功！'));
            if (!navOk) {
              console.log(chalk.yellow('  ⚠ 主页加载被WAF拦截，会话可能不稳定。如遇问题请重新登录。'));
            }

            try {
              const check = await session.api.checkToken();
              if (check.data) {
                const name =
                  check.data.name || check.data.userName || check.data.memberName;
                if (name) console.log(chalk.white(`  用户: ${name}`));
                if (check.data.ffpCardNo)
                  console.log(chalk.white(`  会员卡号: ${check.data.ffpCardNo}`));
              }
            } catch {}
            break;
          }

          if (content.isScan && !scanned) {
            scanned = true;
            pollSpinner.text = chalk.cyan('✋ 已扫描！请在手机上点击「确认登录」...');
          } else if (!scanned) {
            pollSpinner.text = `等待扫码... (${elapsed}s / 120s)`;
          }

          await new Promise((r) => setTimeout(r, POLL_MS));
        }

        if (!loginDone && !scanned) {
          pollSpinner.fail('登录超时，请重新执行 ceair-cli login');
        }

        await session.cleanup();
        return;
      }

      // ─── SMS / Password Login ──────────────────────
      if (loginMethod === 'sms') {
        result = await session.api.interactiveSmsLogin();
      } else {
        result = await session.api.interactivePasswordLogin();
      }

      if (result.success) {
        await session.save();
        console.log(chalk.green(`\n✓ ${result.message}`));

        // Try to get user info
        try {
          const check = await session.api.checkToken();
          if (check.data) {
            const name =
              check.data.name || check.data.userName || check.data.memberName;
            if (name) {
              console.log(chalk.white(`  用户: ${name}`));
            }
            if (check.data.ffpCardNo) {
              console.log(
                chalk.white(`  会员卡号: ${check.data.ffpCardNo}`)
              );
            }
          }
        } catch {
          // ignore
        }
      } else {
        console.log(chalk.yellow(`\n${result.message}`));
      }
    } catch (err) {
      console.error(chalk.red('登录出错:'), err.message);
    } finally {
      await session.cleanup();
    }
  });

// ─── Book Command ────────────────────────────────────────────────

program
  .command('book')
  .description('Book a flight\n\n' +
    '  Params resolved: CLI flags > config file > interactive prompt\n\n' +
    '  Set config defaults:\n' +
    '    ceair-cli config set passenger.name 张三\n' +
    '    ceair-cli config set passenger.phone 13800138000')
  .option('-f, --from <city>', 'Departure city (code or name, e.g. SHA, 上海)')
  .option('-t, --to <city>', 'Arrival city (code or name, e.g. BJS, 北京)')
  .option('-d, --date <date>', 'Departure date (YYYY-MM-DD)')
  .option('-a, --adults <num>', 'Number of adults', parseInt)
  .option('--flight <index>', 'Flight index from search results (0-based)', parseInt)
  .option('--cabin <index>', 'Cabin/brand index (0-based)', parseInt)
  .option('-p, --passenger <name>', 'Passenger name (must match saved passenger)')
  .option('--passenger-id <idNo>', 'Passenger ID number')
  .option('--passenger-phone <phone>', 'Passenger phone number')
  .option('--contact-name <name>', 'Contact person name')
  .option('--contact-phone <phone>', 'Contact person phone')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--config <path>', 'Config file path')
  .addHelpText('after', `\nExamples:\n  # Fully interactive:\n  $ ceair-cli book\n\n  # With route, pick flight interactively:\n  $ ceair-cli book -f SHA -t BJS -d 2025-06-15\n\n  # Fully specified (zero prompts):\n  $ ceair-cli book -f SHA -t BJS -d 2025-06-15 --flight 0 --cabin 0 \\\n      -p 张三 --passenger-id 110101199001011234 --passenger-phone 13800138000 -y\n\n  # With config defaults for passenger:\n  $ ceair-cli config set passenger.name 张三\n  $ ceair-cli book -f SHA -t BJS -d 2025-06-15 --flight 0 --cabin 0 -y\n\nTip: Run \"ceair-cli search\" first to see flight indices, then use --flight and --cabin.`)
  .action(async (opts) => {
    const { loadConfig } = require('./config');
    const session = new SessionManager();
    let restored = false;

    try {
      restored = await session.load();
    } catch {
      // not logged in
    }

    if (!restored) {
      console.log(chalk.yellow('请先登录: ceair-cli login'));
      await session.cleanup();
      return;
    }

    try {
      // Load config for defaults
      const config = loadConfig();

      // Resolve each param: CLI flag > config > interactive prompt
      const fields = {};

      // ─── Origin/Destination/Date ───
      fields.from = opts.from || config.defaults?.from;
      fields.to = opts.to || config.defaults?.to;
      fields.date = opts.date || config.defaults?.date;
      fields.adults = opts.adults || config.search?.adults || 1;

      const missing = [];
      if (!fields.from) missing.push({ type: 'input', name: 'from', message: '出发城市 (代码或名称):', validate: v => resolveCity(v) !== null || '未识别该城市' });
      if (!fields.to) missing.push({ type: 'input', name: 'to', message: '到达城市 (代码或名称):', validate: v => resolveCity(v) !== null || '未识别该城市' });
      if (!fields.date) missing.push({ type: 'input', name: 'date', message: '出发日期 (YYYY-MM-DD):', validate: v => !isNaN(new Date(v).getTime()) || '无效日期' });

      if (missing.length > 0) {
        const answers = await inquirer.prompt(missing);
        Object.assign(fields, answers);
      }

      const depCity = resolveCity(fields.from);
      const arrCity = resolveCity(fields.to);
      if (!depCity || !arrCity) {
        console.log(chalk.red('无法识别城市代码'));
        await session.cleanup(); return;
      }

      // ─── Search ───
      const spinner = ora('搜索航班中...').start();
      const result = await session.api.searchFlights({
        depCity, arrCity, depDate: fields.date, adult: fields.adults,
      });
      spinner.stop();

      console.log(chalk.bold(`\n${getCityName(depCity)} → ${getCityName(arrCity)}  ${formatDate(fields.date)}`));
      console.log(chalk.gray('─'.repeat(50)));

      const flights = displayFlights(result);
      if (flights.length === 0) { await session.cleanup(); return; }

      // ─── Flight selection ───
      let flightIndex = opts.flight;
      if (flightIndex == null) {
        const answer = await inquirer.prompt([{
          type: 'input', name: 'flightIndex',
          message: `选择航班序号 (0-${flights.length - 1}):`,
          validate: v => { const n = parseInt(v); return (n >= 0 && n < flights.length) || `请输入 0 到 ${flights.length - 1}`; },
        }]);
        flightIndex = parseInt(answer.flightIndex);
      } else if (flightIndex < 0 || flightIndex >= flights.length) {
        console.log(chalk.red(`航班序号 ${flightIndex} 超出范围 (0-${flights.length - 1})`));
        await session.cleanup(); return;
      }

      const selectedFlight = flights[flightIndex];
      console.log(chalk.cyan(`\n已选: ${selectedFlight.flightNo} ${selectedFlight.depTime}→${selectedFlight.arrTime}`));

      // ─── Cabin selection ───
      let cabinIdx = opts.cabin;
      let selectedBrand = null;
      if (selectedFlight.priceOptions.length === 0) {
        console.log(chalk.red('该航班无可用舱位'));
        await session.cleanup(); return;
      } else if (selectedFlight.priceOptions.length === 1) {
        selectedBrand = selectedFlight.priceOptions[0];
        cabinIdx = 0;
      } else if (cabinIdx != null) {
        if (cabinIdx < 0 || cabinIdx >= selectedFlight.priceOptions.length) {
          console.log(chalk.red(`舱位序号 ${cabinIdx} 超出范围`));
          await session.cleanup(); return;
        }
        selectedBrand = selectedFlight.priceOptions[cabinIdx];
      } else {
        const answer = await inquirer.prompt([{
          type: 'list', name: 'brandIndex', message: '选择舱位/品牌:',
          choices: selectedFlight.priceOptions.map((p, i) => ({
            name: `${p.brand} (${p.cabin}) - ¥${p.price}`, value: i,
          })),
        }]);
        cabinIdx = answer.brandIndex;
        selectedBrand = selectedFlight.priceOptions[answer.brandIndex];
      }

      // ─── Passenger ───
      const pax = {
        name: opts.passenger || config.passenger?.name,
        idType: opts.passengerId ? 'NI' : config.passenger?.idType,
        idNo: opts.passengerId || config.passenger?.idNo,
        phone: opts.passengerPhone || config.passenger?.phone,
      };

      const paxMissing = [];
      if (!pax.name) paxMissing.push({ type: 'input', name: 'name', message: '乘机人姓名:', validate: v => v.trim() ? true : '请输入姓名' });
      if (!pax.idNo) paxMissing.push({ type: 'input', name: 'idNo', message: '证件号码:', validate: v => v.trim() ? true : '请输入证件号' });
      if (!pax.phone) paxMissing.push({ type: 'input', name: 'phone', message: '手机号码:', validate: v => /^1\d{10}$/.test(v.trim()) || '请输入正确的手机号' });

      if (paxMissing.length > 0) {
        const answers = await inquirer.prompt(paxMissing);
        Object.assign(pax, answers);
      }
      if (!pax.idType) pax.idType = 'NI';

      // ─── Contact ───
      const contact = {
        name: opts.contactName || config.contact?.name || pax.name,
        phone: opts.contactPhone || config.contact?.phone || pax.phone,
      };

      const contactMissing = [];
      if (!contact.name) contactMissing.push({ type: 'input', name: 'name', message: '联系人姓名:', default: pax.name });
      if (!contact.phone) contactMissing.push({ type: 'input', name: 'phone', message: '手机号码:', default: pax.phone, validate: v => /^1\d{10}$/.test(v.trim()) || '请输入正确的手机号' });

      if (contactMissing.length > 0) {
        const answers = await inquirer.prompt(contactMissing);
        Object.assign(contact, answers);
      }

      // Find cabin index in flight data
      const flightItem = result.data?.flightItems?.[flightIndex];
      let realCabinIdx = 0;
      if (flightItem) {
        realCabinIdx = flightItem.cabinInfoDescs?.findIndex(c => c.ccode === selectedBrand.cabin);
        if (realCabinIdx < 0) realCabinIdx = 0;
      }

      // ─── Confirm ───
      console.log(chalk.bold('\n═══ 订单确认 ═══'));
      console.log(chalk.white(`航班: ${selectedFlight.flightNo} ${getCityName(depCity)}→${getCityName(arrCity)}`));
      console.log(chalk.white(`日期: ${formatDate(fields.date)}`));
      console.log(chalk.white(`舱位: ${selectedBrand.brand} (${selectedBrand.cabin})`));
      console.log(chalk.white(`价格: ¥${selectedBrand.price}`));
      console.log(chalk.white(`乘机人: ${pax.name} (${pax.idNo})`));
      console.log(chalk.white(`联系人: ${contact.name} ${contact.phone}`));

      if (!opts.yes) {
        const { confirmBook } = await inquirer.prompt([{
          type: 'confirm', name: 'confirmBook', message: '确认提交订单?', default: false,
        }]);
        if (!confirmBook) { console.log(chalk.yellow('已取消。')); await session.cleanup(); return; }
      }

      // ─── Submit ───
      const bookSpinner = ora('正在提交订单...').start();
      const bookingResult = await session.api.createBooking({
        searchResult: result,
        flightIndex,
        cabinIndex: realCabinIdx,
        passenger: pax,
        contact,
      });
      bookSpinner.stop();

      displayBookingResult(bookingResult);
      await session.save();
    } catch (err) {
      console.error(chalk.red('订票过程出错:'), err.message);
    } finally {
      await session.cleanup();
    }
  });

// ─── Orders Command ──────────────────────────────────────────────

program
  .command('orders')
  .description('List orders with full flight details\n\n' +
    '  Upcoming/active orders show:\n' +
    '    Passenger name, ticket number\n' +
    '    Flight number, times, terminals, aircraft\n' +
    '    Seat / check-in status\n' +
    '    Cabin class, meal, baggage\n\n' +
    '  Use --all for historical/cancelled orders.')
  .option('-a, --all', 'Show all orders including past and cancelled')
  .option('-p, --page <num>', 'Page number', '1')
  .addHelpText('after', '\nExamples:\n  $ ceair-cli orders\n  $ ceair-cli orders --all\n  $ ceair-cli orders --page 2')
  .action(async (opts) => {
    const session = new SessionManager();
    try {
      const restored = await session.load();
      if (!restored) {
        console.log(chalk.yellow('请先登录: ceair-cli login'));
        await session.cleanup();
        return;
      }

      const spinner = ora('查询订单...').start();
      const result = await session.api.queryOrderList({ page: parseInt(opts.page) });
      spinner.stop();

      if (!result?.data) {
        console.log(chalk.red('查询失败:'), result?.resultMsg || '未知错误');
        await session.cleanup();
        return;
      }

      const orders = result.data.list || [];
      if (!orders.length) {
        console.log(chalk.gray('暂无订单记录'));
        await session.cleanup();
        return;
      }

      const today = new Date().toISOString().substring(0, 10);

      // Separate future active orders from the rest
      const futureActive = [];
      const other = [];
      for (const o of orders) {
        const seg = o.segList?.[0];
        const depDate = seg?.deptDtStr?.substring(0, 10);
        const isActive = o.orderStatus === '10050' || o.orderStatus === '10054';
        const isFuture = depDate && depDate >= today;
        if ((isActive && isFuture) || (isActive && o.orderStatus === '10050')) {
          futureActive.push(o);
        } else {
          other.push(o);
        }
      }

      // Fetch details for future active orders
      if (futureActive.length > 0) {
        console.log(chalk.bold.green('\n  ╔══════════════════════════════════════╗'));
        console.log(chalk.bold.green('  ║       即将出行 / 待处理订单          ║'));
        console.log(chalk.bold.green('  ╚══════════════════════════════════════╝'));

        for (const order of futureActive) {
          const detailSpinner = ora(`加载 ${order.tradeOrderNo}...`).start();
          const detail = await session.api.getOrderDetail(order.tradeOrderNo).catch(() => null);
          detailSpinner.stop();

          const passengers = [];
          if (detail?.data?.passengerTabList) {
            for (const tab of detail.data.passengerTabList) {
              const pax = {
                passenger: tab.passenger,
                segments: [],
                seatInfo: null,
                buttons: tab.buttonList || [],
              };
              for (const trip of tab.tripList || []) {
                for (const seg of trip.segmentList || []) {
                  pax.segments.push(seg);
                }
                // Check seat info
                if (trip.seatList?.length > 0) {
                  const seatNames = trip.seatList
                    .filter(s => s.seatNo)
                    .map(s => `${s.seatNo}(${s.seatRow || ''})`);
                  if (seatNames.length) pax.seatInfo = seatNames.join(', ');
                }
              }
              passengers.push(pax);
            }
          }

          displayUpcomingTrips([{
            tradeOrderNo: order.tradeOrderNo,
            orderStatus: order.orderStatus,
            price: order.price,
            orderInfoDetail: detail?.data?.orderInfoDetail,
            passengers,
          }]);
        }
      }

      // Show other orders (compact list)
      if (opts.all && other.length > 0) {
        console.log(chalk.bold('\n  历史订单:\n'));
        const statusMap = {
          '10050': chalk.yellow('⏳ 待支付'),
          '10054': chalk.green('🎫 已出票'),
          '10056': chalk.gray('✗ 已取消'),
          '10062': chalk.green('✓ 已完成'),
          '10098': chalk.blue('🔄 处理中'),
        };
        for (const order of other) {
          const status = statusMap[order.orderStatus] || chalk.white(order.orderStatus || '--');
          const seg = order.segList?.[0];
          const route = seg ? `${seg.dptCityName || seg.dptCityCode || '?'} → ${seg.arrCityName || seg.arrCityCode || '?'}` : '';
          const date = seg?.deptDtStr || '';
          console.log(
            chalk.cyan(`  ${order.tradeOrderNo || '--'}`) +
            `  ¥${order.price || '--'}  ` +
            status
          );
          if (route || date) {
            console.log(chalk.gray(`    ${route}  ${date}`));
          }
          console.log();
        }
      } else if (!opts.all) {
        console.log(chalk.gray('  (使用 --all 查看历史/已取消订单)'));
      }

      console.log(chalk.gray(`\n  共 ${result.data.total || orders.length} 条 (第 ${opts.page} 页)`));
    } catch (err) {
      console.error(chalk.red('查询出错:'), err.message);
    } finally {
      await session.cleanup();
    }
  });

// ─── Cancel Command ─────────────────────────────────────────────

program
  .command('cancel <orderNo>')
  .description('Cancel an unpaid order\n\n' +
    '  <orderNo> is the tradeOrderNo from \"ceair-cli orders\".\n' +
    '  Only unpaid orders (待支付) can be cancelled.\n' +
    '  Unpaid orders auto-cancel when payment countdown expires.')
  .addHelpText('after', '\nExample:\n  $ ceair-cli cancel 123456789012345678')
  .action(async (orderNo) => {
    const session = new SessionManager();
    try {
      const restored = await session.load();
      if (!restored) {
        console.log(chalk.yellow('请先登录: ceair-cli login'));
        await session.cleanup();
        return;
      }

      const { confirmCancel } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirmCancel',
          message: `确认取消订单 ${orderNo}?`,
          default: false,
        },
      ]);

      if (!confirmCancel) {
        console.log(chalk.yellow('已取消。'));
        await session.cleanup();
        return;
      }

      const spinner = ora('取消订单中...').start();
      const result = await session.api.cancelOrder(orderNo);
      spinner.stop();

      if (result.resultCode === 'S200' || result.resultCode === 'A200') {
        console.log(chalk.green(`✓ 订单 ${orderNo} 已取消`));
      } else {
        console.log(chalk.red('取消失败:'), result.resultMsg || `错误码 ${result.resultCode}`);
      }
    } catch (err) {
      console.error(chalk.red('取消出错:'), err.message);
    } finally {
      await session.cleanup();
    }
  });

// ─── Config Command ─────────────────────────────────────────────

program
  .command('config <action> [key] [value]')
  .description('Manage configuration defaults\n\n' +
    '  Config: ~/.config/ceair-cli/config.json\n\n' +
    '  Actions:\n' +
    '    list    Show all config values\n' +
    '    get     Get a value (dot notation)\n' +
    '    set     Set a value (dot notation)\n' +
    '    path    Print config file path\n\n' +
    '  Keys:\n' +
    '    passenger.name     Default passenger name\n' +
    '    passenger.idNo     Default passenger ID\n' +
    '    passenger.phone    Default passenger phone\n' +
    '    search.adults      Default adults (1)\n' +
    '    search.cabin       Default cabin (Y/C/F)')
  .addHelpText('after', '\nExamples:\n  $ ceair-cli config list\n  $ ceair-cli config set passenger.name 张三\n  $ ceair-cli config set passenger.phone 13800138000\n  $ ceair-cli config set passenger.idNo 110101199001011234\n  $ ceair-cli config get passenger.name')
  .action(async (action, key, value) => {
    const { loadConfig, setConfig, CONFIG_FILE } = require('./config');

    if (action === 'list' || action === 'show') {
      const config = loadConfig();
      console.log(chalk.bold('Config file:'), chalk.gray(CONFIG_FILE));
      console.log();
      const flat = flatten(config);
      for (const [k, v] of Object.entries(flat)) {
        if (v != null) {
          console.log(chalk.cyan(`  ${k} = `) + chalk.white(v));
        }
      }
      return;
    }

    if (action === 'get') {
      if (!key) {
        console.log(chalk.yellow('Usage: ceair config get <key>  (e.g. passenger.name)'));
        return;
      }
      const config = loadConfig();
      const val = key.split('.').reduce((o, k) => o?.[k], config);
      if (val != null) {
        console.log(typeof val === 'object' ? JSON.stringify(val, null, 2) : val);
      } else {
        console.log(chalk.gray('(not set)'));
      }
      return;
    }

    if (action === 'set') {
      if (!key || value === undefined) {
        console.log(chalk.yellow('Usage: ceair-cli config set <key> <value>  (e.g. passenger.name 张三)'));
        return;
      }
      const config = setConfig(key, value);
      console.log(chalk.green(`✓ ${key} = ${value}`));
      return;
    }

    if (action === 'path') {
      console.log(CONFIG_FILE);
      return;
    }

    console.log(chalk.yellow('Unknown action. Use: list, get, set, path'));
  });

function flatten(obj, prefix = '') {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(result, flatten(v, key));
    } else {
      result[key] = v;
    }
  }
  return result;
}

// ─── Status / Logout / Cities ────────────────────────────────────

program
  .command('status')
  .description('Check current login status and session validity')
  .action(async () => {
    const session = new SessionManager();
    try {
      const restored = await session.load();
      if (restored) {
        console.log(chalk.green('✓ 已登录'));
        const info = session.userInfo;
        if (info) {
          if (info.name) console.log(chalk.white(`  用户: ${info.name}`));
          if (info.cardNo) console.log(chalk.white(`  会员卡号: ${info.cardNo}`));
        }
      } else {
        console.log(chalk.yellow('未登录'));
        console.log(chalk.gray('使用 "ceair-cli login" 登录'));
      }
    } catch {
      console.log(chalk.yellow('未登录'));
    } finally {
      await session.cleanup();
    }
  });

program
  .command('logout')
  .description('Logout and clear saved session')
  .action(async () => {
    const session = new SessionManager();
    try {
      await session.logout();
    } catch {
      // ignore
    } finally {
      await session.cleanup();
    }
    console.log(chalk.green('已登出，会话已清除。'));
  });

program
  .command('cities')
  .description('List supported city/airport codes for search and booking')
  .option('-f, --filter <keyword>', 'Filter by city name or code')
  .addHelpText('after', '\nExamples:\n  $ ceair-cli cities\n  $ ceair-cli cities --filter 北京\n  $ ceair-cli cities -f SHA')
  .action((opts) => {
    const cities = listCities();
    const filtered = opts.filter
      ? cities.filter(
          (c) =>
            c.name.includes(opts.filter) ||
            c.code.toLowerCase().includes(opts.filter.toLowerCase())
        )
      : cities;

    console.log(chalk.bold('支持的城市/机场代码:\n'));
    for (const city of filtered) {
      console.log(
        chalk.cyan(`  ${city.code.padEnd(4)}`) +
          chalk.white(`${city.name}`) +
          chalk.gray(`  ${city.airports.join(', ')}`)
      );
    }
    console.log(chalk.gray(`\n共 ${filtered.length} 个城市`));
  });

// ─── Main ────────────────────────────────────────────────────────

program
  .name('ceair-cli')
  .description(
    '中国东方航空 CLI - 搜索航班、登录账号、在线订票\n' +
    'China Eastern Airlines CLI - Search, Login & Book\n\n' +
    'Quick start:\n' +
    '  1. ceair-cli login --method qrcode\n' +
    '  2. ceair-cli search SHA BJS 2025-06-15\n' +
    '  3. ceair-cli book -f SHA -t BJS -d 2025-06-15 --flight 0 --cabin 0 -y\n\n' +
    'Config defaults:\n' +
    '  ceair-cli config set passenger.name 张三\n' +
    '  ceair-cli config set passenger.phone 13800138000\n' +
    '  ceair-cli config set passenger.idNo 110101199001011234'
  )
  .version('2.0.0')
  .parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
