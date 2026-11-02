'use strict';

/**
 * Fuzzy-tolerant text matching for "type the country name" (Expert) mode.
 * Handles: case, accents (Côte d'Ivoire), apostrophes, hyphens, extra spaces,
 * and common alternative spellings ("Burma" -> "Myanmar").
 */

const ALIASES = {
  'United States': ['usa', 'united states of america', 'america', 'us', 'murica'],
  'United Kingdom': ['uk', 'great britain', 'britain', 'england'],
  'United Arab Emirates': ['uae', 'emirates', 'the emirates'],
  'Ivory Coast': ["cote d'ivoire", 'cote divoire', 'ivory coast'],
  'DR Congo': ['drc', 'democratic republic of the congo', 'dr congo', 'congo kinshasa', 'zaire'],
  'Republic of the Congo': ['congo', 'congo brazzaville', 'republic of congo'],
  'Vatican City': ['vatican', 'holy see'],
  'Czechia': ['czech republic', 'czech'],
  'Myanmar': ['burma'],
  'Eswatini': ['swaziland'],
  'Cabo Verde': ['cape verde'],
  'Timor-Leste': ['east timor', 'easttimor'],
  'Micronesia': ['federated states of micronesia', 'fsm'],
  'North Macedonia': ['macedonia'],
  'Russia': ['russian federation'],
  'Bahamas': ['the bahamas'],
  'Gambia': ['the gambia'],
  'Netherlands': ['holland'],
  'South Korea': ['korea south', 'republic of korea'],
  'North Korea': ['dprk', 'korea north', 'democratic peoples republic of korea'],
  'Saint Kitts and Nevis': ['st kitts and nevis', 'saint kitts', 'st kitts'],
  'Saint Lucia': ['st lucia'],
  'Saint Vincent and the Grenadines': ['st vincent', 'st vincent and the grenadines'],
  'Trinidad and Tobago': ['trinidad'],
  'Antigua and Barbuda': ['antigua'],
  'Bosnia and Herzegovina': ['bosnia'],
};

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')      // strip diacritics: Côte -> cote
    .replace(/[\u2018\u2019'`’]/g, '')    // strip apostrophes
    .replace(/[^a-z0-9]+/g, ' ')          // non-alphanumerics -> spaces
    .replace(/\s+/g, ' ')
    .trim();
}

// Key = normalized string with all spaces removed, so "U.S.A." -> "usa" works.
function normalizeKey(value) {
  return normalize(value).replace(/\s+/g, '');
}

// Precompute the alias lookup: canonical name -> Set of accepted forms
// (both the spaced and the squashed key variant).
const ALIAS_LOOKUP = new Map();
for (const [canonical, list] of Object.entries(ALIASES)) {
  const forms = new Set([normalize(canonical), normalizeKey(canonical)]);
  for (const alias of list) {
    forms.add(normalize(alias));
    forms.add(normalizeKey(alias));
  }
  ALIAS_LOOKUP.set(canonical, forms);
}

/**
 * @param {string} input  raw user input
 * @param {string} countryName  canonical country name
 * @returns {boolean}
 */
function matchTyped(input, countryName) {
  const v = normalize(input);
  if (!v) return false;
  const k = normalizeKey(input);
  const forms = ALIAS_LOOKUP.get(countryName);
  if (forms) return forms.has(v) || forms.has(k);
  return v === normalize(countryName) || k === normalizeKey(countryName);
}

module.exports = { normalize, matchTyped, ALIASES };
