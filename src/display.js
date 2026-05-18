/**
 * Flight display and formatting utilities
 */

const chalk = require('chalk');
const { getCityName } = require('./cities');

function _log(...args) {
  if (process.env.CEAIR_SILENT !== '1') console.log(...args);
}

/**
 * Format and display flight search results
 * Handles the new API response format: resultCode "S200", data.flightItems
 */
function displayFlights(flightData) {
  if (!flightData) {
    _log(chalk.red('搜索失败: 无返回数据'));
    return [];
  }

  // Handle WAF block or search timeout
  if (flightData.resultCode === 'WAF_BLOCKED' || flightData.resultCode === 'SEARCH_TIMEOUT') {
    _log(chalk.red(`搜索失败: ${flightData.resultMsg || '请求超时，请稍后重试'}`));
    return [];
  }

  // Handle specific no-flights error codes (normal outcome, not an error)
  const noFlightsCodes = ['232007', '231002'];
  if (noFlightsCodes.includes(flightData.resultCode)) {
    _log(chalk.yellow('未找到符合条件的航班。'));
    _log(chalk.gray('  ' + (flightData.resultMsg || '请更换日期后重新查询，或致电95530咨询办理。')));
    return [];
  }

  // New API format: S200 with flightItems
  if (flightData.resultCode === 'S200') {
    const data = flightData.data || {};
    const flightItems = data.flightItems || [];

    if (!flightItems.length) {
      _log(chalk.yellow('未找到符合条件的航班。'));
      return [];
    }

    return displayNewFormat(flightItems);
  }

  // Legacy format: A200 with tripList
  if (flightData.resultCode === 'A200') {
    const { tripList = [] } = flightData.data || {};
    if (!tripList.length) {
      _log(chalk.yellow('未找到符合条件的航班。'));
      return [];
    }
    return displayLegacyFormat(tripList);
  }

  // Unknown error
  _log(
    chalk.red('搜索失败:'),
    flightData.resultMsg || `错误码 ${flightData.resultCode || '未知'}`
  );
  return [];
}

/**
 * Display flights in the new S200/flightItems format
 */
function displayNewFormat(flightItems) {
  const flights = [];
  let index = 0;

  for (let fii = 0; fii < flightItems.length; fii++) {
    const item = flightItems[fii];
    for (const fi of item.flightInfos || []) {
      for (const seg of fi.flightSegments || []) {
        const depTime = seg.orgTime || '--:--';
        const arrTime = seg.destTime || '--:--';
        const duration = seg.fltSpanTime; // minutes
        const flightNo = (seg.carrierCode || seg.airlineCode || '') + seg.flightNo;
        const depAirport = seg.orgShortName || seg.orgName || '';
        const arrAirport = seg.destShortName || seg.destName || '';
        const depTerminal = seg.depTerm || '';
        const arrTerminal = seg.arriTerm || '';
        const aircraft = seg.icaoType || seg.planeType || '';
        const durationStr = duration
          ? `${Math.floor(duration / 60)}h${(duration % 60).toString().padStart(2, '0')}m`
          : '--';
        const stopInfo = seg.stopNum ? ` (经停${seg.stopNum}次)` : '';

        // Get cabin/price info from cabinInfoDescs
        const priceOptions = [];
        let lowestPrice = null;

        for (const cabin of item.cabinInfoDescs || []) {
          for (const fare of cabin.fareInfoDescList || []) {
            if (fare.paxType === 'ADT' || !fare.paxType) {
              const price = parseFloat(fare.lprice || fare.totalPrice || 0);
              if (price > 0) {
                if (lowestPrice === null || price < lowestPrice) {
                  lowestPrice = price;
                }
                priceOptions.push({
                  brand: cabin.cabinLevelName || cabin.ccode,
                  cabin: cabin.ccode,
                  cabinType: cabin.ctype, // Y=economy, J=business, F=first
                  price,
                  tax: parseFloat(fare.taxPrice || 0),
                  totalPrice: parseFloat(fare.totalPrice || 0),
                });
              }
            }
          }
        }

        const flightInfo = {
          index: index++,
          flightItemIndex: fii,
          flightNo,
          depTime,
          arrTime,
          depDate: seg.fltDate,
          arrDate: seg.arriDate || seg.fltDate,
          duration,
          durationStr,
          depAirport,
          arrAirport,
          depTerminal,
          arrTerminal,
          aircraft,
          stopInfo,
          lowestPrice,
          priceOptions,
          depCode: seg.orgCode,
          arrCode: seg.destCode,
          raw: {
            flightItem: item,
            segment: seg,
          },
        };

        flights.push(flightInfo);

        // Display
        const priceStr = lowestPrice
          ? chalk.green(`¥${lowestPrice}`)
          : chalk.gray('已售罄');
        const wifiIcon = seg.wifiOpenStatus ? ' 📶' : '';
        _log(
          chalk.white(`[${index - 1}] `) +
            chalk.cyan(`${flightNo}`) +
            '  ' +
            chalk.white(`${depTime}`) +
            chalk.gray(' → ') +
            chalk.white(`${arrTime}`) +
            chalk.gray(`  ${durationStr}`) +
            chalk.gray(`${stopInfo}`) +
            '  ' +
            priceStr +
            chalk.gray(wifiIcon)
        );
        _log(
          chalk.gray(
            `     ${depAirport}${depTerminal} → ${arrAirport}${arrTerminal}  ${aircraft}`
          )
        );

        if (priceOptions.length > 0) {
          const priceLine = priceOptions
            .map((p) => `${p.brand}(${p.cabin}) ¥${p.price}(含税¥${p.totalPrice})`)
            .join(' | ');
          _log(chalk.gray(`     ${priceLine}`));
        }
        _log();
      }
    }
  }

  return flights;
}

/**
 * Display flights in the legacy A200/tripList format
 */
function displayLegacyFormat(tripList) {
  const flights = [];
  let index = 0;
  let tripIdx = 0;

  for (const trip of tripList) {
    const currentTripIdx = tripIdx++;
    for (const segment of trip.segmentList || []) {
      for (const flight of segment.flightList || []) {
        const depInfo = flight.depInfo || {};
        const arrInfo = flight.arrInfo || {};
        const brandList = flight.brandList || [];

        const depTime = depInfo.time || '--:--';
        const arrTime = arrInfo.time || '--:--';
        const duration = flight.flyTime || '--';
        const flightNo = flight.flightNo || '';

        let lowestPrice = null;
        const priceOptions = [];

        for (const brand of brandList) {
          const price = brand.adultPrice?.totalPrice;
          if (price) {
            const p = parseFloat(price);
            if (lowestPrice === null || p < lowestPrice) lowestPrice = p;
            priceOptions.push({
              brand: brand.brandName || brand.cabin,
              cabin: brand.cabin,
              price: p,
            });
          }
        }

        const flightInfo = {
          index: index++,
          flightItemIndex: currentTripIdx,
          flightNo,
          depTime,
          arrTime,
          duration,
          lowestPrice,
          priceOptions,
          raw: flight,
        };
        flights.push(flightInfo);

        const priceStr = lowestPrice
          ? chalk.green(`¥${lowestPrice}`)
          : chalk.gray('已售罄');
        _log(
          chalk.white(`[${index - 1}] `) +
            chalk.cyan(`${flightNo}`) +
            '  ' +
            chalk.white(`${depTime}`) +
            chalk.gray(' → ') +
            chalk.white(`${arrTime}`) +
            chalk.gray(`  ${duration}`) +
            '  ' +
            priceStr
        );
        if (priceOptions.length > 0) {
          const priceLine = priceOptions
            .map((p) => `${p.brand}(${p.cabin}) ¥${p.price}(含税¥${p.totalPrice})`)
            .join(' | ');
          _log(chalk.gray(`     ${priceLine}`));
        }
        _log();
      }
    }
  }

  return flights;
}

/**
 * Display booking result
 */
function displayBookingResult(result) {
  if (!result) {
    _log(chalk.red('订票请求失败'));
    return;
  }

  if (result.resultCode === 'A200' || result.resultCode === 'S200') {
    // Booking API returns fields directly (not nested in data)
    const orderNo = result.orderNo || result.data?.orderNo || '';
    const pnrNo = result.pnrNo || '';
    const totalPrice = result.totalPrice || result.data?.totalPrice || '';
    const currency = result.currency || 'CNY';
    const segments = result.airSegSummaryList || [];
    const passengers = result.passengerSummaryList || [];
    const contactName = result.contactName || '';
    const contactMobile = result.contactMobile || '';

    _log(chalk.green('\n  ✈ 订单创建成功！\n'));
    if (orderNo) {
      _log(chalk.white(`  订单号:   ${chalk.bold(orderNo)}`));
    }
    if (pnrNo) {
      _log(chalk.white(`  PNR:     ${pnrNo}`));
    }
    if (segments.length) {
      for (const seg of segments) {
        const dep = seg.departAirport || '';
        const arr = seg.arriveAirport || '';
        const date = seg.departDate || '';
        _log(chalk.white(`  航段:     ${dep} → ${arr}  ${date}`));
      }
    }
    if (totalPrice) {
      _log(chalk.white(`  总价:     ${currency === 'CNY' ? '¥' : currency + ' '}${totalPrice}`));
    }
    if (passengers.length) {
      _log(chalk.white(`  乘机人:   ${passengers.map(p => p.name || p.passengerName).join(', ')}`));
    }
    if (contactName) {
      _log(chalk.white(`  联系人:   ${contactName} ${contactMobile}`));
    }
    _log(chalk.yellow('\n  ⚠ 请尽快完成支付，超时订单将自动取消'));
    _log(chalk.blue('  https://www.ceair.com/zh/cny/home'));
    _log(chalk.gray('  客服电话: 95530\n'));
  } else {
    _log(
      chalk.red('订票失败:'),
      result.resultMsg || `错误码 ${result.resultCode}`
    );
  }
}

/**
 * Format date for display
 */
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 周${weekdays[d.getDay()]}`;
}

/**
 * Display upcoming trips with full detail
 */
function displayUpcomingTrips(trips) {
  if (!trips || !trips.length) {
    _log(chalk.gray('  暂无即将出行的航班'));
    return;
  }

  for (const trip of trips) {
    const { tradeOrderNo, orderStatus, price, orderInfoDetail, passengers } = trip;

    const statusMap = {
      '10050': chalk.yellow('⏳ 待支付'),
      '10054': chalk.green('🎫 已出票'),
      '10056': chalk.gray('✗ 已取消'),
      '10062': chalk.green('✓ 已完成'),
      '10098': chalk.blue('🔄 处理中'),
    };
    const status = statusMap[orderStatus] || chalk.white(orderStatus);

    _log(chalk.bold.cyan(`\n  ═══ ${tradeOrderNo} ═══`) + `  ${status}`);

    for (const pax of passengers) {
      const p = pax.passenger;
      const seg = pax.segments?.[0];

      // Passenger line
      const tktNo = p.tktNoList?.[0] || '--';
      _log(
        chalk.white(`  ✈ ${p.fullName}`) +
        chalk.gray(`  ${tktNo}`) +
        chalk.gray(`  (${p.passengerType === 'ADT' ? '成人' : p.passengerType})`)
      );

      if (seg) {
        // Flight info
        const airline = seg.airline || '';
        const fltNo = seg.fltNo || '';
        const depDate = seg.fltDate || '';
        const depTime = seg.depTime || '';
        const arrTime = seg.arrTime || '';
        const depAirport = seg.deptAptShortName || seg.deptAptName || '';
        const arrAirport = seg.arrAptShortName || seg.arrAptName || '';
        const depTerm = seg.depTerm || '';
        const arrTerm = seg.arrTerm || '';
        const duration = seg.duration ? `${Math.floor(seg.duration / 60)}h${(seg.duration % 60).toString().padStart(2, '0')}m` : '--';
        const aircraft = seg.equipmentIcao || seg.equipment || '';
        const cabin = seg.cabinCode || '';
        const cabinClass = seg.cabinClass === 'Y' ? '经济舱' : seg.cabinClass === 'J' ? '商务舱' : seg.cabinClass === 'F' ? '头等舱' : '';
        const meal = seg.mealTypeDetail || '';
        const baggage = seg.baggageInfoList?.find(b => b.baggageType === '0')?.baggageWeight || '';

        _log(
          chalk.cyan(`    ${airline}${fltNo}`) +
          chalk.white(`  ${depDate}`) +
          chalk.white(`  ${depTime} → ${arrTime}`) +
          chalk.gray(`  ${duration}`)
        );
        _log(
          chalk.gray(`    ${depAirport}${depTerm} → ${arrAirport}${arrTerm}`) +
          chalk.gray(`  ${aircraft}`)
        );

        // Seat / Check-in
        const seatInfo = pax.seatInfo;
        const airportTime = seg.airportTimeList?.[0];
        if (seatInfo) {
          _log(chalk.green(`    座位: ${seatInfo}`));
        } else {
          _log(chalk.gray(`    座位: 未选座`));
        }
        if (airportTime?.boardingTime && airportTime.boardingTime !== '--') {
          _log(chalk.white(`    登机时间: ${airportTime.boardingTime}`));
        }
        if (seg.segStatus) {
          const segStatusMap = {
            'OPEN FOR USE': chalk.green('有效'),
            'CHECKED IN': chalk.green('已值机'),
            'BOARDED': chalk.green('已登机'),
            'USED': chalk.gray('已使用'),
          };
          _log(chalk.gray(`    状态: ${segStatusMap[seg.segStatus] || seg.segStatus}`));
        }

        // Cabin, meal, baggage
        const extras = [];
        if (cabinClass) extras.push(cabinClass + (cabin ? `(${cabin})` : ''));
        if (meal) extras.push(meal);
        if (baggage) extras.push(`托运${baggage}`);
        if (extras.length) {
          _log(chalk.gray(`    ${extras.join(' | ')}`));
        }

        // Check-in / seat button status
        const seatBtn = pax.buttons?.find(b => b.type === 'SEAT');
        if (seatBtn) {
          if (seatBtn.state === 'normal') {
            _log(chalk.green(`    ✓ 可选座值机`));
          } else if (seatBtn.message) {
            _log(chalk.gray(`    选座: ${seatBtn.message}`));
          }
        }
      }
    }

    // Price
    if (price) {
      _log(chalk.white(`  价格: ¥${price}`));
    }
    if (orderInfoDetail?.countDownTime > 0) {
      const mins = Math.floor(orderInfoDetail.countDownTime / 60);
      _log(chalk.yellow(`  ⏳ 支付倒计时: ${mins}分钟`));
    }
  }
  _log();
}

module.exports = { displayFlights, displayBookingResult, displayUpcomingTrips, formatDate };
