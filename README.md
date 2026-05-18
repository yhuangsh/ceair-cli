# ceair-cli

中国东方航空命令行工具 — 搜索航班、登录账号、在线订票

China Eastern Airlines CLI — search, book, and manage flights from the terminal.

## Features

- 🔍 **Flight Search** — Search domestic flights with real-time pricing
- 🔐 **QR Login** — Scan QR code in terminal, no CAPTCHA needed
- 🎫 **Book Flights** — Create unpaid orders via CLI flags, config, or interactive prompts
- 📋 **Order Details** — View upcoming trips with seat, check-in, baggage info
- ⚙️ **Configurable** — Set passenger defaults, skip prompts

## Install

```bash
# Install globally from GitHub
npm install -g yhuangsh/ceair-cli

# Or clone and link
git clone https://github.com/yhuangsh/ceair-cli.git
cd ceair-cli
npm install
npm link
```

Chromium is auto-installed on first `npm install` via Playwright.

## Quick Start

```bash
# 1. Start a browser session (scans QR code to login)
ceair-cli session start

# 2. Search
ceair-cli search SHA BJS 2026-06-15

# 3. Book (match by flight number, zero prompts)
ceair-cli book -f SHA -t BJS -d 2026-06-15 --flight-no MU5101 --cabin economy -y

# 4. Check upcoming trips
ceair-cli orders

# 5. Stop the browser when done
ceair-cli session stop
```

## Commands

### `ceair-cli search <from> <to> <date>`

Search flights. Cities can be codes or Chinese names.

```bash
ceair-cli search SHA BJS 2026-06-15
ceair-cli search 上海 北京 2026-06-15 --cabin business
ceair-cli search SHA CAN 2026-06-15 --return 2026-06-20
```

### `ceair-cli session`

Manage persistent browser sessions via CDP.

```bash
ceair-cli session start   # Launch Chromium, QR login, keep browser alive
ceair-cli session status  # Show session info (PID, user, endpoint)
ceair-cli session stop    # Kill browser process
```

All other commands require an active session. The browser persists across commands — zero startup overhead per invocation.

### `ceair-cli book`

Book a flight. Params resolved: **CLI flags > config file > interactive prompt**.

```bash
# Fully interactive
ceair-cli book

# With route, pick flight interactively
ceair-cli book -f SHA -t BJS -d 2026-06-15

# Match by flight number (recommended)
ceair-cli book -f SHA -t BJS -d 2026-06-15 --flight-no MU5101 --cabin economy -y

# Fully specified with config defaults
ceair-cli book -f SHA -t BJS -d 2026-06-15 --flight-no MU5101 --cabin economy \
  -p 张三 --passenger-id 110101199001011234 --passenger-phone 13800138000 -y
```

### `ceair-cli orders`

List upcoming trips with full detail (passenger, ticket number, seat, check-in status, baggage).

```bash
ceair-cli orders           # Upcoming/active orders
ceair-cli orders --all     # Include historical/cancelled
```

### `ceair-cli config`

Manage defaults in `~/.config/ceair-cli/config.json`.

```bash
ceair-cli config set passenger.name 张三
ceair-cli config set passenger.phone 13800138000
ceair-cli config set passenger.idNo 110101199001011234
ceair-cli config list
```

### Other commands

```bash
ceair-cli status            # Check login status
ceair-cli cancel <orderNo>  # Cancel unpaid order
ceair-cli session stop      # Close browser session
ceair-cli cities            # List supported city codes
```

## Supported Cities

Run `ceair-cli cities` for the full list. Major cities:

| Code | City | Airports |
|------|------|----------|
| SHA | 上海 | PVG(浦东), SHA(虹桥) |
| BJS | 北京 | PEK(首都), PKX(大兴) |
| CAN | 广州 | CAN(白云) |
| CTU | 成都 | CTU(天府), TFU(双流) |
| SZX | 深圳 | SZX(宝安) |

## How It Works

Uses [Playwright](https://playwright.dev/) Chromium to bypass China Eastern's WAF/bot protection. The browser loads the real website, and the CLI interacts with the Vue.js SPA components directly — form clicks trigger search, Vue methods handle booking navigation.

Orders are created in **unpaid** state. Complete payment on the [CEAir website](https://www.ceair.com) or app. Customer service: **95530**.

### Known Limitations

- **Non-MU booking**: ✅ Fixed in v1.3.1. All airlines (CA, CZ, FM, HO, KN) can now be booked. The DOM cabin button uses cabin class type (Y/W/J/F) instead of fare subclass index.
- **Cancel order**: Some orders (e.g., already ticketed) return A500 from the API — cancel via the website instead.

### Bug History

| Bug | Description | Fixed |
|-----|-------------|-------|
| #1 | Cabin offset calculated wrong for variable cabin counts | v1.1.0 |
| #2 | Date picker not filling for future months | v1.1.0 |
| #3 | Non-MU flights: DOM cabin button mismatch | v1.3.1 |
| #4 | cancelOrder fails on ERROR/FETCH_ERROR | v1.1.0 |
| #5 | localStorage/sessionStorage not cleared on logout | v1.1.0 |
| #6 | DOM cabin offset uses API counts — booked wrong cabin (¥4,180 instead of ¥550) | v1.2.0 |

### v1.3.0 Changes

- **Session model**: `login`/`logout` → `session start`/`stop` with persistent CDP browser
- **Cabin selection**: `--cabin` accepts class names (economy/business/first/premium, picks cheapest) and fare subclass codes (V/K/I, exact match)
- **Cancel `-y` flag**: `ceair-cli cancel <orderNo> -y` skips confirm prompt
- **Session start fix**: race condition on login redirect no longer crashes

## Architecture

```
src/
├── cli.js          # CLI commands (Commander.js)
├── api.js          # Playwright browser automation
├── browser-pool.js # Browser session management (CDP)
├── config.js       # User config (~/.config/ceair-cli/)
├── paths.js        # Shared paths + migration
├── cities.js       # City/airport code mapping
└── display.js      # Terminal output formatting
```

## Development Wiki

Internal reverse-engineering docs (API structures, WAF bypass, booking flow) are in a separate private repo:

```bash
git clone https://github.com/yhuangsh/ceair-cli-wiki.git llm-wiki
```

## Testing

```bash
npm test                # Unit tests (19 tests)
npm run test:e2e        # E2E against real ceair.com (requires QR login)
```

E2E tests try multiple routes and dates to find available flights. Override the default date:

```bash
CEAIR_E2E_DATE=2026-06-15 npm run test:e2e
```

## License

MIT
