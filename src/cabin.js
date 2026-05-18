/**
 * Cabin class resolution — maps friendly names to airline cabin types.
 *
 * Two kinds of input:
 *
 *   Cabin class (picks cheapest within class):
 *     economy, business, first, premium, Y, C, J, F, W,
 *     经济舱, 商务舱, 头等舱, 超级经济舱, etc.
 *
 *   Fare subclass (picks exact booking class):
 *     V, Z, K, I, etc. — airline fare booking codes.
 *     Different subclasses within the same cabin have different
 *     prices, change/refund rules, and mileage earning rates.
 *     AI agents and power users can specify these directly.
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
 * Check if input is a fare subclass code (e.g. V, Z, K, I).
 * Fare subclasses are 1-2 letter codes that are NOT canonical class aliases.
 * For example: V=discounted economy, I=discounted business.
 */
function isFareSubclass(input) {
  if (!input) return false;
  const s = String(input).trim().toUpperCase();
  // Canonical class codes are NOT fare subclasses
  if (['Y', 'C', 'J', 'F', 'W'].includes(s)) return false;
  // 1-2 letter codes that aren't canonical aliases
  return /^[A-Z]\d?$/.test(s);
}

/**
 * Map a ctype code to a canonical class key.
 * ctype is the airline's cabin type field: Y=economy, J=business, F=first, W=premium.
 */
function classFromCtype(ctype) {
  if (!ctype) return null;
  const upper = ctype.toUpperCase();
  for (const [key, cls] of Object.entries(CABIN_CLASSES)) {
    if (cls.codes.includes(upper)) return key;
  }
  return null;
}

/**
 * Find the best matching cabin option in a flight's priceOptions array.
 *
 * @param {string} input - User-supplied cabin name/code/subclass
 * @param {Array} priceOptions - Flight's priceOptions from displayFlights()
 * @returns {{ index: number, option: object } | null}
 *
 * Resolution strategy:
 *   1. Exact fare subclass match: --cabin V → option where ccode=V
 *   2. Cabin class (cheapest): --cabin economy → cheapest option with ctype=Y
 *   3. Brand name substring fallback
 */
function resolveCabinIndex(input, priceOptions) {
  if (!priceOptions || priceOptions.length === 0) return null;

  const upper = String(input).trim().toUpperCase();

  // 1. Exact fare subclass match (V, K, I, Z, etc.)
  const codeMatch = priceOptions.findIndex(p =>
    p.cabin?.toUpperCase() === upper
  );
  if (codeMatch >= 0) return { index: codeMatch, option: priceOptions[codeMatch] };

  // 2. Cabin class → pick cheapest within that class
  const cls = resolveCabinClass(input);
  if (cls) {
    const { codes } = CABIN_CLASSES[cls];
    // Find all options in this cabin class
    const matches = [];
    for (let i = 0; i < priceOptions.length; i++) {
      const p = priceOptions[i];
      if (codes.includes(p.cabinType?.toUpperCase())) {
        matches.push({ index: i, option: p, price: p.price || Infinity });
      }
    }
    if (matches.length > 0) {
      // Pick the cheapest
      matches.sort((a, b) => a.price - b.price);
      return { index: matches[0].index, option: matches[0].option };
    }
  }

  // 3. Brand name substring
  const label = cls ? CABIN_CLASSES[cls].label : upper;
  const brandMatch = priceOptions.findIndex(p =>
    p.brand?.includes(label) || label.includes(p.brand || '')
  );
  if (brandMatch >= 0) return { index: brandMatch, option: priceOptions[brandMatch] };

  return null;
}

module.exports = { resolveCabinClass, cabinSearchCode, cabinLabel, resolveCabinIndex, classFromCtype, isFareSubclass, CABIN_CLASSES };
