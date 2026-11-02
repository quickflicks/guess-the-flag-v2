'use strict';

/* Integrity checks for the country dataset + matching helpers. Run: npm run validate */

const fs = require('fs');
const path = require('path');
const { normalize, matchTyped } = require('./matching');

const COUNTRIES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'countries.json'), 'utf8'));

const REGIONS = new Set(['africa', 'asia', 'europe', 'northamerica', 'southamerica', 'oceania']);
const CODE_RE = /^[a-z]{2}$/;

const errors = [];
const warn = (m) => console.log('WARN:', m);
const fail = (m) => { errors.push(m); };

let total = 0;
const perRegion = {};
const seenNames = new Set();
const seenCodes = new Set();

for (const c of COUNTRIES) {
  total++;
  if (!c.name || typeof c.name !== 'string') fail(`bad name: ${JSON.stringify(c)}`);
  if (!CODE_RE.test(c.code)) fail(`bad code: ${c.code} (${c.name})`);
  if (!REGIONS.has(c.region)) fail(`bad region: ${c.region} (${c.name})`);
  if (!c.capital || typeof c.capital !== 'string') fail(`missing capital: ${c.name}`);
  if (!(typeof c.population === 'number' && c.population > 0)) fail(`bad population: ${c.name}`);
  if (![1, 2, 3, 4].includes(c.tier)) fail(`bad tier: ${c.tier} (${c.name})`);
  if (seenNames.has(c.name)) fail(`duplicate name: ${c.name}`);
  if (seenCodes.has(c.code)) fail(`duplicate code: ${c.code}`);
  seenNames.add(c.name);
  seenCodes.add(c.code);
  perRegion[c.region] = (perRegion[c.region] || 0) + 1;
}

const tierCount = {};
for (const c of COUNTRIES) tierCount[c.tier] = (tierCount[c.tier] || 0) + 1;

// Matching helper sanity checks
const cases = [
  ['usa', 'United States', true],
  ['  U.S.A.  ', 'United States', true],
  ['Burma', 'Myanmar', true],
  ['MYANMAR', 'Myanmar', true],
  ["Côte d'Ivoire", 'Ivory Coast', true],
  ['Timor Leste', 'Timor-Leste', true],
  ['Swaziland', 'Eswatini', true],
  ['myanmar1', 'Myanmar', false],
  ['', 'France', false],
  ['france', 'France', true],
  ['UK', 'United Kingdom', true],
];
for (const [input, name, expected] of cases) {
  const got = matchTyped(input, name);
  if (got !== expected) fail(`matchTyped('${input}','${name}') = ${got}, expected ${expected}`);
}

console.log(`Countries: ${total}`);
console.log('Per region:', JSON.stringify(perRegion));
console.log('Per tier:  ', JSON.stringify(tierCount));
for (const r of REGIONS) if ((perRegion[r] || 0) < 8) fail(`region ${r} has too few countries (${perRegion[r] || 0})`);

if (errors.length) {
  console.error('\nFAILED:');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}
console.log('\nAll dataset + matching checks passed.');
