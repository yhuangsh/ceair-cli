const SessionManager = require('./src/session');
const { displayFlights } = require('./src/display');

async function main() {
  const session = new SessionManager();
  await session.load();
  const api = session.api;

  // Test: search SHA→BJS for 2026-05-24 (Sunday)
  const result = await api.searchFlights({
    depCity: 'SHA', arrCity: 'BJS', depDate: '2026-05-24', adult: 1,
  });

  if (result.resultCode !== 'S200') {
    console.log('Search failed:', result.resultCode, result.resultMsg);
    await session.cleanup();
    return;
  }

  const items = result.data?.flightItems || [];
  console.log(`Found ${items.length} flightItems`);
  
  // Check flight numbers and dates
  for (const item of items) {
    const segs = item.flightInfos?.[0]?.flightSegments || [];
    for (const seg of segs) {
      const no = (seg.carrierCode || seg.airlineCode || '') + seg.flightNo;
      console.log(`  ${no}  ${seg.orgTime}→${seg.destTime}  date=${seg.fltDate}`);
      if (no === 'MU5127') {
        console.log(`  ^^^ FOUND MU5127! date=${seg.fltDate} expected=2026-05-24`);
      }
    }
  }
  
  // Also check displayFlights
  const flights = displayFlights(result);
  const mu5127 = flights.find(f => f.flightNo === 'MU5127');
  if (mu5127) {
    console.log(`\nMU5127 flightItemIndex=${mu5127.flightItemIndex}, depDate=${mu5127.depDate}`);
    console.log(`  Price options: ${mu5127.priceOptions.length}`);
    for (const p of mu5127.priceOptions) {
      console.log(`    ${p.brand} (${p.cabin}) ¥${p.price}`);
    }
  } else {
    console.log('\nMU5127 not found in display results');
  }

  await session.cleanup();
}

main().catch(console.error);
