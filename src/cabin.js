/**
 * Cabin class resolution — maps friendly names to airline cabin types.
 *
 * Accepts:
 *   Full names:   economy, business, first, premium
 *   Short codes:  Y, C, J, F, W
 *   Chinese:      经济, 经济舱, 商务, 商务舱, 头等, 头等舱, 超级经济
 *   Mixed:        经济舱/Y, business/C
 *
 * All comparisons are case-insensitive.
 *
 * Note on fare subclass codes (V, Z, I, etc.):
 *   These are internal airline booking class codes within a cabin.
 *   For example: Y=economy, V=discounted economy, Z=another economy fare bucket.
 *   Users should never need to know these — they select cabin CLASS only.
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
 * Find the index of a cabin option in a flight's priceOptions array.
 *
 * @param {string} input - User-supplied cabin name/code
 * @param {Array} priceOptions - Flight's priceOptions from displayFlights()
 * @returns {{ index: number, option: object } | null}
 *
 * Matching priority:
 *   1. Canonical class match via cabinType (Y→economy, J→business, F→first)
 *   2. Brand name substring match (e.g. "经济" matches "经济舱")
 */
function resolveCabinIndex(input, priceOptions) {
  if (!priceOptions || priceOptions.length === 0) return null;

  const cls = resolveCabinClass(input);
  if (!cls) return null;

  // 1. Match by cabinType (ctype)
  const { codes } = CABIN_CLASSES[cls];
  const typeMatch = priceOptions.findIndex(p =>
    codes.includes(p.cabinType?.toUpperCase())
  );
  if (typeMatch >= 0) return { index: typeMatch, option: priceOptions[typeMatch] };

  // 2. Brand name substring
  const label = CABIN_CLASSES[cls].label;
  const brandMatch = priceOptions.findIndex(p =>
    p.brand?.includes(label) || label.includes(p.brand || '')
  );
  if (brandMatch >= 0) return { index: brandMatch, option: priceOptions[brandMatch] };

  return null;
}

module.exports = { resolveCabinClass, cabinSearchCode, cabinLabel, resolveCabinIndex, classFromCtype, CABIN_CLASSES };
