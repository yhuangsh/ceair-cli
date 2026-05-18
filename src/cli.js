#!/usr/bin/env node
/**
 * CEAir Booking CLI
 * Search, book, and manage flights on China Eastern Airlines from the terminal.
 *
 * Session model:
 *   ceair-cli session start   →  launch browser + QR login
 *   ceair-cli search/book/…   →  reuse running browser
 *   ceair-cli session stop    →  kill browser
 */

const { Command } = require('commander');
const inquirer = require('inquirer');
const chalk = require('chalk');
const ora = require('ora');
const qrcode = require('qrcode-terminal');
const CeairApi = require('../src/api');
const pool = require('../src/browser-pool');
const { resolveCity, getCityName, listCities } = require('../src/cities');
const { displayFlights, displayBookingResult, displayUpcomingTrips, formatDate } = require('../src/display');

const program = new Command();

// ─── Helper: get connected API, or error if no session ──────────

function requireApi() {
  const api = new CeairApi();
  return api;
}

// ─── Session Handlers ───────────────────────────────────────────

async function sessionStart(opts) {
  try {
    const { running } = await pool.status();
    if (running) {
      console.log(chalk.yellow('Session already active. Run `ceair-cli session stop` first to restart.'));
      return;
    }
  } catch {
    // ignore
  }

  const spinner = ora('启动浏览器...').start();

  let wsEndpoint;
  try {
    ({ wsEndpoint } = await pool.launch());
  } catch (err) {
    spinner.fail(err.message);
    return;
  }
  spinner.succeed('浏览器已启动');

  // Connect for login
  const browser = await require('playwright').chromium.connectOverCDP(wsEndpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0];

  // Navigate to SSO login page
  const uuidSpinner = ora('正在获取二维码...').start();
  await page.goto(
    'https://sso.ceair.com/new/login?type=ffp&lang=zh_CNY',
    { waitUntil: 'domcontentloaded', timeout: 30000 }
  );
  await page.waitForTimeout(5000);

  // Wait for the SSO Vue component to mount (retry up to 15s)
  let uuid = null;
  for (let attempt = 0; attempt < 10 && !uuid; attempt++) {
    uuid = await page.evaluate(() => {
      const app = document.querySelector('#app');
      if (!app?.__vue__) return null;
      function findComponent(comp, depth = 0) {
        if (depth > 10) return null;
        if (comp.$options?.methods?.getUUID) return comp;
        for (const child of comp.$children || []) {
          const found = findComponent(child, depth + 1);
          if (found) return found;
        }
        return null;
      }
      const login = findComponent(app.__vue__);
      return login?.uuid || null;
    });
    if (!uuid) await page.waitForTimeout(1500);
  }

  if (!uuid) {
    uuidSpinner.fail('获取二维码失败');
    await pool.kill();
    return;
  }
  uuidSpinner.stop();

  const qrContent = `uuid=${uuid}`;
  console.log(chalk.bold('\n请使用 东方航空APP 扫描以下二维码登录：\n'));
  qrcode.generate(qrContent, { small: true });
  console.log(chalk.gray(`\n二维码内容: ${qrContent}`));
  console.log(chalk.gray('有效期 2 分钟，过期请重新执行 ceair-cli session start\n'));

  const pollSpinner = ora('等待扫码... (0s / 120s)').start();
  const startTime = Date.now();
  const TIMEOUT_MS = 120_000;
  const POLL_MS = 3000;
  let scanned = false;
  let loginDone = false;

  let ssouserid = null;
  const captureHandler = (req) => {
    if (req.url().includes('isconfirmbyscan') && !ssouserid) {
      ssouserid = req.headers()['ssouserid'];
    }
  };
  page.on('request', captureHandler);

  for (let wait = 0; wait < 10 && !ssouserid; wait++) {
    await page.waitForTimeout(1000);
  }

  if (ssouserid) {
    page.off('request', captureHandler);
    await page.evaluate(() => {
      const app = document.querySelector('#app');
      if (!app?.__vue__) return;
      function findComponent(comp, depth = 0) {
        if (depth > 10) return null;
        if (comp.$options?.methods?.getUUID) return comp;
        for (const child of comp.$children || []) {
          const found = findComponent(child, depth + 1);
          if (found) return found;
        }
        return null;
      }
      try {
        const login = findComponent(app.__vue__);
        if (login) {
          clearInterval(login.scanrecur);
          clearTimeout(login.scanrecur);
        }
      } catch {}
    }).catch(() => {});
  }

  while (Date.now() - startTime < TIMEOUT_MS) {
    const pollResult = await page.evaluate(async ({ uuid, ssouserid }) => {
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
      pollSpinner.fail('二维码已过期，请重新执行 ceair-cli session start');
      break;
    }

    if (content.isLogin) {
      loginDone = true;
      pollSpinner.text = '正在建立会话...';

      let navOk = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await page.goto('https://www.ceair.com/zh/cny/home', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
          await page.waitForTimeout(4000);
          const hasNuxt = await page.evaluate(() => !!window.$nuxt);
          if (hasNuxt) { navOk = true; break; }
        } catch {}
        await page.waitForTimeout(2000);
      }

      pollSpinner.succeed(chalk.green('✓ 扫码登录成功！'));
      if (!navOk) {
        console.log(chalk.yellow('  ⚠ 主页加载被WAF拦截，会话可能不稳定。'));
      }

      let userName = null;
      let userCard = null;
      try {
        const api = new CeairApi();
        api.browser = browser;
        api.context = context;
        api.page = page;
        const check = await api._apiRequest(
          'https://www.ceair.com/portal/v3/member/newCheckToken', {}
        );
        if (check.data) {
          userName = check.data.name || check.data.userName || check.data.memberName;
          userCard = check.data.ffpCardNo;
        }
      } catch {}

      if (userName) console.log(chalk.white(`  用户: ${userName}`));
      if (userCard) console.log(chalk.white(`  会员卡号: ${userCard}`));

      pool.setUser({ name: userName, cardNo: userCard });

      console.log(chalk.gray('\n浏览器会话已启动。使用以下命令操作：'));
      console.log(chalk.cyan('  ceair-cli search SHA BJS 2026-06-15'));
      console.log(chalk.cyan('  ceair-cli book -f SHA -t BJS -d 2026-06-15 --flight-no MU5101 --cabin 0 -y'));
      console.log(chalk.cyan('  ceair-cli orders'));
      console.log(chalk.gray('\n完成后执行 ceair-cli session stop 关闭浏览器。'));

      // Disconnect without killing the browser.
      // browser.close() sends Browser.close via CDP which kills Chromium.
      // Instead, remove listeners and exit the Node process.
      // With proc.unref(), the child Chromium process survives.
      browser._connection.removeAllListeners();
      process.exit(0);
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
    pollSpinner.fail('登录超时，请重新执行 ceair-cli session start');
    await pool.kill();
    return;
  }

  // Login timed out or QR expired — kill browser
  if (!loginDone) {
    await pool.kill();
  }
  process.exit(loginDone ? 0 : 1);
}

async function sessionStop() {
  const { running } = await pool.status();
  if (!running) {
    console.log(chalk.yellow('No active session.'));
    return;
  }
  const spinner = ora('正在关闭浏览器...').start();
  await pool.kill();
  spinner.succeed(chalk.green('✓ 浏览器会话已关闭'));
}

async function sessionStatus() {
  const { running, info } = await pool.status();
  if (!running) {
    console.log(chalk.yellow('No active session.'));
    console.log(chalk.gray('Run `ceair-cli session start` to start one.'));
    return;
  }
  console.log(chalk.green('✓ Session active'));
  if (info?.startedAt) console.log(chalk.white(`  Started: ${info.startedAt}`));
  if (info?.pid) console.log(chalk.white(`  PID: ${info.pid}`));
  if (info?.user?.name) console.log(chalk.white(`  User: ${info.user.name}`));
  if (info?.user?.cardNo) console.log(chalk.white(`  Card: ${info.user.cardNo}`));
  console.log(chalk.white(`  Endpoint: ${info.wsEndpoint}`));
}

// ─── Session Command ────────────────────────────────────────────

program
  .command('session <action>')
  .description('Manage browser session\n\n' +
    '  start    Launch browser and login via QR code\n' +
    '  stop     Kill the browser session\n' +
    '  status   Show session info')
  .addHelpText('after', '\nExamples:\n  $ ceair-cli session start\n  $ ceair-cli session status\n  $ ceair-cli session stop')
  .action(async (action, opts) => {
    if (action === 'start') {
      await sessionStart(opts);
    } else if (action === 'stop') {
      await sessionStop();
    } else if (action === 'status') {
      await sessionStatus();
    } else {
      console.log(chalk.yellow(`Unknown action: ${action}`));
      console.log(chalk.gray('Use: start, stop, status'));
    }
  });

// ─── Search Command ──────────────────────────────────────────────

program
  .command('search <from> <to> <date>')
  .description('Search flights (e.g. search SHA BJS 2025-06-15)')
  .option('-r, --return <retDate>', 'Return date (for round-trip)')
  .option('-a, --adults <num>', 'Number of adults', '1')
  .option('-c, --children <num>', 'Number of children', '0')
  .option('--cabin <class>', 'Cabin class: Y(经济) C(商务) F(头等)', 'Y')
  .addHelpText('after', `\nExamples:\n  $ ceair-cli search SHA BJS 2025-06-15\n  $ ceair-cli search 上海 北京 2025-06-15 --cabin C\n  $ ceair-cli search SHA BJS 2025-06-15 -r 2025-06-20\n\nUse "ceair-cli cities" to see all supported city codes.`)
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

    const api = requireApi();
    const spinner = ora('正在搜索航班...').start();

    try {
      const result = await api.searchFlights({
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
      api.disconnect();
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
  .option('--flight-no <flightNo>', 'Flight number to match (e.g. MU5101, CA8358)')
  .option('--cabin <index>', 'Cabin/brand index (0-based)', parseInt)
  .option('-p, --passenger <name>', 'Passenger name (must match saved passenger)')
  .option('--passenger-id <idNo>', 'Passenger ID number')
  .option('--passenger-phone <phone>', 'Passenger phone number')
  .option('--contact-name <name>', 'Contact person name')
  .option('--contact-phone <phone>', 'Contact person phone')
  .option('-y, --yes', 'Skip confirmation prompt')
  .option('--config <path>', 'Config file path')
  .addHelpText('after', `\nExamples:\n  # Fully interactive:\n  $ ceair-cli book\n\n  # With route, pick flight interactively:\n  $ ceair-cli book -f SHA -t BJS -d 2026-06-15\n\n  # Match by flight number (zero prompts for flight):\n  $ ceair-cli book -f SHA -t BJS -d 2026-06-15 --flight-no MU5101 --cabin 0 -y\n\n  # Fully specified:\n  $ ceair-cli book -f SHA -t BJS -d 2026-06-15 --flight-no MU5101 --cabin 0 \\\n      -p 张三 --passenger-id 110101199001011234 --passenger-phone 13800138000 -y\n\n  # With config defaults for passenger:\n  $ ceair-cli config set passenger.name 张三\n  $ ceair-cli book -f SHA -t BJS -d 2026-06-15 --flight-no MU5101 --cabin 0 -y`)
  .action(async (opts) => {
    const { loadConfig } = require('./config');
    const api = requireApi();

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
        return;
      }

      // ─── Search ───
      const spinner = ora('搜索航班中...').start();
      const result = await api.searchFlights({
        depCity, arrCity, depDate: fields.date, adult: fields.adults,
      });
      spinner.stop();

      console.log(chalk.bold(`\n${getCityName(depCity)} → ${getCityName(arrCity)}  ${formatDate(fields.date)}`));
      console.log(chalk.gray('─'.repeat(50)));

      const flights = displayFlights(result);
      if (flights.length === 0) return;

      // ─── Flight selection ───
      let selectedFlight = null;

      if (opts.flightNo) {
        const normalizedFlightNo = opts.flightNo.toUpperCase().replace(/\s+/g, '');
        selectedFlight = flights.find(
          f => f.flightNo.toUpperCase().replace(/\s+/g, '') === normalizedFlightNo
        );
        if (!selectedFlight) {
          console.log(chalk.red(`未找到航班号 ${opts.flightNo}。请检查航班号或使用交互模式选择。`));
          console.log(chalk.gray('可用航班:'));
          for (const f of flights) {
            console.log(chalk.gray(`  [${f.index}] ${f.flightNo} ${f.depTime}→${f.arrTime}`));
          }
          return;
        }
        console.log(chalk.cyan(`\n匹配到: [${selectedFlight.index}] ${selectedFlight.flightNo} ${selectedFlight.depTime}→${selectedFlight.arrTime}`));
      } else {
        const answer = await inquirer.prompt([{
          type: 'list', name: 'flightIndex', message: '选择航班:',
          choices: flights.map(f => ({
            name: `${f.flightNo}  ${f.depTime}→${f.arrTime}  ¥${f.lowestPrice || '--'}`,
            value: f.index,
          })),
        }]);
        selectedFlight = flights[answer.flightIndex];
        console.log(chalk.cyan(`\n已选: ${selectedFlight.flightNo} ${selectedFlight.depTime}→${selectedFlight.arrTime}`));
      }

      // ─── Cabin selection ───
      let cabinIdx = opts.cabin;
      let selectedBrand = null;
      if (selectedFlight.priceOptions.length === 0) {
        console.log(chalk.red('该航班无可用舱位'));
        return;
      } else if (selectedFlight.priceOptions.length === 1) {
        selectedBrand = selectedFlight.priceOptions[0];
        cabinIdx = 0;
      } else if (cabinIdx != null) {
        if (cabinIdx < 0 || cabinIdx >= selectedFlight.priceOptions.length) {
          console.log(chalk.red(`舱位序号 ${cabinIdx} 超出范围`));
          return;
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

      // Find cabin index in flight data using flightItemIndex
      const flightItem = result.data?.flightItems?.[selectedFlight.flightItemIndex];
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

      // Safety check
      const verifyItem = result.data?.flightItems?.[selectedFlight.flightItemIndex];
      if (verifyItem) {
        const verifySeg = verifyItem.flightInfos?.[0]?.flightSegments?.[0];
        if (verifySeg) {
          const verifyNo = (verifySeg.carrierCode || verifySeg.airlineCode || '') + verifySeg.flightNo;
          if (verifyNo !== selectedFlight.flightNo) {
            console.log(chalk.yellow(`\n⚠ 警告: API数据中航班号 ${verifyNo} 与所选 ${selectedFlight.flightNo} 不匹配！`));
            if (!opts.yes) {
              const { forceContinue } = await inquirer.prompt([{
                type: 'confirm', name: 'forceContinue', message: '航班号不匹配，仍要继续?', default: false,
              }]);
              if (!forceContinue) { console.log(chalk.yellow('已取消。')); return; }
            }
          }
        }
      }

      if (!opts.yes) {
        const { confirmBook } = await inquirer.prompt([{
          type: 'confirm', name: 'confirmBook', message: '确认提交订单?', default: false,
        }]);
        if (!confirmBook) { console.log(chalk.yellow('已取消。')); return; }
      }

      // ─── Submit ───
      const bookSpinner = ora('正在提交订单...').start();
      const bookingResult = await api.createBooking({
        searchResult: result,
        flightItemIndex: selectedFlight.flightItemIndex,
        cabinIndex: realCabinIdx,
        passenger: pax,
        contact,
      });
      bookSpinner.stop();

      displayBookingResult(bookingResult);
    } catch (err) {
      console.error(chalk.red('订票过程出错:'), err.message);
    } finally {
      api.disconnect();
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
    const api = requireApi();
    try {
      const spinner = ora('查询订单...').start();
      const result = await api.queryOrderList({ page: parseInt(opts.page) });
      spinner.stop();

      if (!result?.data) {
        console.log(chalk.red('查询失败:'), result?.resultMsg || '未知错误');
        return;
      }

      const orders = result.data.list || [];
      if (!orders.length) {
        console.log(chalk.gray('暂无订单记录'));
        return;
      }

      const today = new Date().toISOString().substring(0, 10);

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

      if (futureActive.length > 0) {
        console.log(chalk.bold.green('\n  ╔══════════════════════════════════════╗'));
        console.log(chalk.bold.green('  ║       即将出行 / 待处理订单          ║'));
        console.log(chalk.bold.green('  ╚══════════════════════════════════════╝'));

        for (const order of futureActive) {
          const detailSpinner = ora(`加载 ${order.tradeOrderNo}...`).start();
          const detail = await api.getOrderDetail(order.tradeOrderNo).catch(() => null);
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
      api.disconnect();
    }
  });

// ─── Cancel Command ─────────────────────────────────────────────

program
  .command('cancel <orderNo>')
  .description('Cancel an unpaid order\n\n' +
    '  <orderNo> is the tradeOrderNo from "ceair-cli orders".\n' +
    '  Only unpaid orders (待支付) can be cancelled.')
  .addHelpText('after', '\nExample:\n  $ ceair-cli cancel 123456789012345678')
  .action(async (orderNo) => {
    const api = requireApi();
    try {
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
        return;
      }

      const spinner = ora('取消订单中...').start();
      const result = await api.cancelOrder(orderNo);
      spinner.stop();

      if (result.resultCode === 'S200' || result.resultCode === 'A200') {
        console.log(chalk.green(`✓ 订单 ${orderNo} 已取消`));
      } else {
        console.log(chalk.red('取消失败:'), result.resultMsg || `错误码 ${result.resultCode}`);
      }
    } catch (err) {
      console.error(chalk.red('取消出错:'), err.message);
    } finally {
      api.disconnect();
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
      setConfig(key, value);
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

// ─── Cities Command ──────────────────────────────────────────────

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
    '中国东方航空 CLI - 搜索航班、在线订票\n' +
    'China Eastern Airlines CLI - Search & Book\n\n' +
    'Quick start:\n' +
    '  1. ceair-cli session start       # 启动浏览器并登录\n' +
    '  2. ceair-cli search SHA BJS 2026-06-15\n' +
    '  3. ceair-cli book -f SHA -t BJS -d 2026-06-15 --flight-no MU5101 --cabin 0 -y\n' +
    '  4. ceair-cli session stop        # 关闭浏览器\n\n' +
    'Config defaults:\n' +
    '  ceair-cli config set passenger.name 张三\n' +
    '  ceair-cli config set passenger.phone 13800138000\n' +
    '  ceair-cli config set passenger.idNo 110101199001011234'
  )
  .version(require('../package.json').version)
  .parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
