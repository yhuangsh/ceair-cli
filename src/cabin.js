/**
 * Cabin class resolution — maps friendly names to airline codes.
 *
 * Accepts:
 *   Full names:   economy, business, first, premium
 *   Short codes:  Y, C, J, F, W
 *   Chinese:      经济, 经济舱, 商务, 商务舱, 头等, 头等舱, 超级经济
 *   Mixed:        经济舱/Y, business/C
 *
 * All comparisons are case-insensitive.
 */

/** Canonical cabin classes */
const CABIN_CLASSES = {
  economy:  { codes: ['Y'], label: '经济舱', aliases: ['economy', 'econ', 'y', '经济', '经济舱'] },
  premium:  { codes: ['W'], label: '超级经济舱', aliases: ['premium', 'premium-economy', 'w', '超级经济', '超级经济舱', '超经'] },
  business: { codes: ['C', 'J'], label: '公务舱', aliases: ['business', 'biz', 'c', 'j', '商务', '商务舱', '公务', '公务舱'] },
  first:    { codes: ['F'], label: '头等舱', aliases: ['first', 'f', '头等', '头等舱'] },
};

/**
 * Resolve a user-supplied cabin string to a canonical class key.
 * Returns 'economy' | 'premium' | 'business' | 'first' or null.
 */
function resolveCabinClass(input) {
  if (!input) return 'economy'; // default
  const s = String(input).trim().toLowerCase();

  for (const [key, cls] of Object.entries(CABIN_CLASSES)) {
    if (cls.aliases.some(a => a.toLowerCase() === s)) return key;
    if (cls.codes.some(c => c.toLowerCase() === s)) return key;
  }
  return null;
}

/**
 * Get the airline search code for a cabin class.
 * Used by `searchFlights` — returns 'Y', 'C', 'F', or 'W'.
 */
function cabinSearchCode(input) {
  const cls = resolveCabinClass(input);
  if (!cls) return '';
  return CABIN_CLASSES[cls].codes[0];
}

/**
 * Get a display label for a cabin class.
 */
function cabinLabel(input) {
  const cls = resolveCabinClass(input);
  if (!cls) return String(input);
  return CABIN_CLASSES[cls].label;
}

/**
 * Find the index of a cabin option in a flight's priceOptions array.
 *
 * @param {string} input - User-supplied cabin name/code
 * @param {Array} priceOptions - Flight's priceOptions from displayFlights()
 * @returns {{ index: number, option: object } | null}
 *
 * Matching priority:
 *   1. Exact numeric index (legacy: --cabin 0, --cabin 1)
 *   2. Exact cabin code match (e.g. "V", "C0")
 *   3. Canonical class match via cabinType (Y→economy, J→business, F→first)
 *   4. Brand name substring match (e.g. "经济" matches "经济舱")
 */
function resolveCabinIndex(input, priceOptions) {
  if (!priceOptions || priceOptions.length === 0) return null;

  // 1. Legacy numeric index
  const num = parseInt(input, 10);
  if (!isNaN(num) && String(num) === String(input).trim()) {
    if (num >= 0 && num < priceOptions.length) {
      return { index: num, option: priceOptions[num] };
    }
    return null;
  }

  const cls = resolveCabinClass(input);

  // 2. Exact cabin code match (e.g. "V", "C", "Y")
  const upper = String(input).trim().toUpperCase();
  const codeMatch = priceOptions.findIndex(p =>
    p.cabin?.toUpperCase() === upper
  );
  if (codeMatch >= 0) return { index: codeMatch, option: priceOptions[codeMatch] };

  // 3. Canonical class → match by cabinType
  if (cls) {
    const { codes } = CABIN_CLASSES[cls];
    const typeMatch = priceOptions.findIndex(p =>
      codes.includes(p.cabinType?.toUpperCase()) ||
      codes.includes(p.cabin?.toUpperCase())
    );
    if (typeMatch >= 0) return { index: typeMatch, option: priceOptions[typeMatch] };
  }

  // 4. Brand name substring
  const label = cls ? CABIN_CLASSES[cls].label : upper;
  const brandMatch = priceOptions.findIndex(p =>
    p.brand?.includes(label) || label.includes(p.brand || '')
  );
  if (brandMatch >= 0) return { index: brandMatch, option: priceOptions[brandMatch] };

  return null;
}

module.exports = { resolveCabinClass, cabinSearchCode, cabinLabel, resolveCabinIndex, CABIN_CLASSES };
