/**
 * Script de actualización automática de precios de Gasóleo C.
 *
 * Fuente: API REST del Ministerio para la Transición Ecológica (MITECO)
 * https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/
 *
 * Estrategia:
 * 1. Obtiene el precio real de Gasóleo C de las estaciones que lo venden (~11 estaciones)
 * 2. Obtiene precios de Gasóleo A de todas las estaciones (~12.000) para calcular variaciones regionales
 * 3. Aplica el ratio GOC/GOA a las medias regionales y provinciales de GOA
 * 4. Calcula variaciones semanales y mensuales comparando con datos anteriores
 * 5. Actualiza precios.json, precios-provincias.json e historico.json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'src', 'data');

const API_BASE = 'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes';
const API_ALL = `${API_BASE}/EstacionesTerrestres/`;
const API_GOC = `${API_BASE}/EstacionesTerrestres/FiltroProducto/7`;

const CCAA_MAP = {
  '01': 'andalucia',
  '02': 'aragon',
  '03': 'asturias',
  '04': 'islas-baleares',
  '05': 'islas-canarias',
  '06': 'cantabria',
  '07': 'castilla-la-mancha',
  '08': 'castilla-y-leon',
  '09': 'cataluna',
  '10': 'comunidad-valenciana',
  '11': 'extremadura',
  '12': 'galicia',
  '13': 'madrid',
  '14': 'murcia',
  '15': 'navarra',
  '16': 'pais-vasco',
  '17': 'la-rioja'
};

const PROVINCIA_MAP = {
  '01': 'araba-alava', '02': 'albacete', '03': 'alicante', '04': 'almeria',
  '05': 'avila', '06': 'badajoz', '07': 'islas-baleares', '08': 'barcelona',
  '09': 'burgos', '10': 'caceres', '11': 'cadiz', '12': 'castellon',
  '13': 'ciudad-real', '14': 'cordoba', '15': 'a-coruna', '16': 'cuenca',
  '17': 'girona', '18': 'granada', '19': 'guadalajara', '20': 'gipuzkoa',
  '21': 'huelva', '22': 'huesca', '23': 'jaen', '24': 'leon',
  '25': 'lleida', '26': 'la-rioja', '27': 'lugo', '28': 'madrid',
  '29': 'malaga', '30': 'murcia', '31': 'navarra', '32': 'ourense',
  '33': 'asturias', '34': 'palencia', '35': 'las-palmas', '36': 'pontevedra',
  '37': 'salamanca', '38': 'santa-cruz-de-tenerife', '39': 'cantabria',
  '40': 'segovia', '41': 'sevilla', '42': 'soria', '43': 'tarragona',
  '44': 'teruel', '45': 'toledo', '46': 'valencia', '47': 'valladolid',
  '48': 'bizkaia', '49': 'zamora', '50': 'zaragoza'
};

const REGION_SLUGS = Object.values(CCAA_MAP);
const PROVINCIA_SLUGS = Object.values(PROVINCIA_MAP);

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function parseSpanishFloat(str) {
  if (!str || str.trim() === '') return NaN;
  return parseFloat(str.replace(',', '.'));
}

function getToday() {
  return new Date().toISOString().split('T')[0];
}

function getCurrentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function fetchJSON(url, retries = 3, delayMs = 5000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    const isServerError = res.status >= 500 && res.status < 600;
    if (isServerError && attempt < retries) {
      console.warn(`  HTTP ${res.status} on attempt ${attempt}/${retries}, retrying in ${delayMs / 1000}s...`);
      await new Promise(r => setTimeout(r, delayMs));
      continue;
    }
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
}

async function fetchGasoleoCPrices() {
  console.log('Fetching Gasóleo C prices...');
  const data = await fetchJSON(API_GOC);
  const stations = data.ListaEESSPrecio || [];

  const prices = [];
  for (const s of stations) {
    const price = parseSpanishFloat(s.PrecioProducto);
    if (!isNaN(price) && price > 0) {
      prices.push({ price, ccaa: CCAA_MAP[s.IDCCAA], provincia: s.Provincia });
    }
  }

  console.log(`  Found ${prices.length} stations with Gasóleo C prices`);
  return prices;
}

async function fetchAllStations() {
  console.log('Fetching all stations...');
  const data = await fetchJSON(API_ALL);
  const stations = data.ListaEESSPrecio || [];
  console.log(`  Total stations: ${stations.length}`);
  return stations;
}

function groupByRegionAndProvince(stations) {
  const byRegion = {};
  const byProvince = {};

  for (const slug of REGION_SLUGS) byRegion[slug] = [];
  for (const slug of PROVINCIA_SLUGS) byProvince[slug] = [];

  for (const s of stations) {
    const price = parseSpanishFloat(s['Precio Gasoleo A']);
    if (isNaN(price) || price <= 0) continue;

    const regionSlug = CCAA_MAP[s.IDCCAA];
    if (regionSlug) byRegion[regionSlug].push(price);

    const provSlug = PROVINCIA_MAP[s.IDProvincia];
    if (provSlug) byProvince[provSlug].push(price);
  }

  return { byRegion, byProvince };
}

function calculatePricesFromGoA(goaPrices, ratio) {
  if (goaPrices.length === 0) return null;

  const avg = goaPrices.reduce((a, b) => a + b, 0) / goaPrices.length;
  const sorted = [...goaPrices].sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];

  return {
    precioMedio: round3(avg * ratio),
    precioMin: round3(p10 * ratio),
    precioMax: round3(p90 * ratio)
  };
}

function calculateAllPrices(gocStations, byRegion, byProvince) {
  const gocPrices = gocStations.map(s => s.price);
  const gocNational = gocPrices.reduce((a, b) => a + b, 0) / gocPrices.length;

  const allGoaPrices = Object.values(byRegion).flat();
  const goaNational = allGoaPrices.reduce((a, b) => a + b, 0) / allGoaPrices.length;

  const ratio = gocNational / goaNational;
  console.log(`  GOC national avg: ${gocNational.toFixed(3)} €/L (${gocPrices.length} stations)`);
  console.log(`  GOA national avg: ${goaNational.toFixed(3)} €/L (${allGoaPrices.length} stations)`);
  console.log(`  Ratio GOC/GOA: ${ratio.toFixed(4)}`);

  // Regional prices
  const regiones = {};
  for (const slug of REGION_SLUGS) {
    const result = calculatePricesFromGoA(byRegion[slug], ratio);
    regiones[slug] = result || {
      precioMedio: round3(gocNational),
      precioMin: round3(gocNational * 0.9),
      precioMax: round3(gocNational * 1.1)
    };
  }

  // Provincial prices
  const provincias = {};
  for (const slug of PROVINCIA_SLUGS) {
    const result = calculatePricesFromGoA(byProvince[slug], ratio);
    if (result) {
      provincias[slug] = result;
    }
  }

  // National
  const sortedAll = [...allGoaPrices].sort((a, b) => a - b);
  const nacional = {
    precioMedio: round3(gocNational),
    precioMin: round3(sortedAll[Math.floor(sortedAll.length * 0.1)] * ratio),
    precioMax: round3(sortedAll[Math.floor(sortedAll.length * 0.9)] * ratio)
  };

  return { nacional, regiones, provincias, ratio };
}

function addVariations(newPrices, oldPrices, historico) {
  const lastMonthDate = new Date();
  lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);
  const lastMonth = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;
  const lastMonthEntry = historico.meses.find(m => m.fecha === lastMonth);

  const oldNacional = oldPrices?.nacional?.precioMedio;
  const lastMonthNacional = lastMonthEntry?.nacional;

  newPrices.nacional.variacionSemanal = oldNacional
    ? round3(newPrices.nacional.precioMedio - oldNacional) : 0;
  newPrices.nacional.variacionMensual = lastMonthNacional
    ? round3(newPrices.nacional.precioMedio - lastMonthNacional) : 0;

  for (const slug of REGION_SLUGS) {
    const oldRegion = oldPrices?.regiones?.[slug]?.precioMedio;
    const lastMonthRegion = lastMonthEntry?.[slug];
    newPrices.regiones[slug].variacionSemanal = oldRegion
      ? round3(newPrices.regiones[slug].precioMedio - oldRegion) : 0;
    newPrices.regiones[slug].variacionMensual = lastMonthRegion
      ? round3(newPrices.regiones[slug].precioMedio - lastMonthRegion) : 0;
  }
}

function addProvinciaVariations(newProvincias, oldProvincias) {
  for (const slug of PROVINCIA_SLUGS) {
    if (!newProvincias[slug]) continue;
    const oldPrice = oldProvincias?.[slug]?.precioMedio;
    newProvincias[slug].variacionSemanal = oldPrice
      ? round3(newProvincias[slug].precioMedio - oldPrice) : 0;
  }
}

function updateHistorico(historico, newPrices) {
  const currentMonth = getCurrentMonth();
  const existingIdx = historico.meses.findIndex(m => m.fecha === currentMonth);

  const entry = { fecha: currentMonth, nacional: newPrices.nacional.precioMedio };
  for (const slug of REGION_SLUGS) {
    entry[slug] = newPrices.regiones[slug].precioMedio;
  }

  if (existingIdx >= 0) {
    historico.meses[existingIdx] = entry;
  } else {
    historico.meses.push(entry);
  }

  if (historico.meses.length > 24) {
    historico.meses = historico.meses.slice(-24);
  }

  historico.lastUpdated = getToday();
  return historico;
}

async function main() {
  console.log(`\n=== Actualización de precios: ${getToday()} ===\n`);

  const oldPrices = JSON.parse(readFileSync(join(DATA_DIR, 'precios.json'), 'utf-8'));
  const historico = JSON.parse(readFileSync(join(DATA_DIR, 'historico.json'), 'utf-8'));

  const oldProvPath = join(DATA_DIR, 'precios-provincias.json');
  const oldProvincias = existsSync(oldProvPath)
    ? JSON.parse(readFileSync(oldProvPath, 'utf-8')).provincias || {}
    : {};

  // Fetch fresh data
  const [gocStations, allStations] = await Promise.all([
    fetchGasoleoCPrices(),
    fetchAllStations()
  ]);

  if (gocStations.length === 0) {
    console.error('ERROR: No Gasóleo C stations found. API might be down. Skipping update.');
    process.exit(1);
  }

  const { byRegion, byProvince } = groupByRegionAndProvince(allStations);

  console.log('\nCalculating prices...');
  const { nacional, regiones, provincias } = calculateAllPrices(gocStations, byRegion, byProvince);
  const newPrices = { nacional, regiones };

  addVariations(newPrices, oldPrices, historico);
  addProvinciaVariations(provincias, oldProvincias);

  // Write precios.json
  writeFileSync(
    join(DATA_DIR, 'precios.json'),
    JSON.stringify({
      lastUpdated: getToday(),
      source: 'Ministerio para la Transición Ecológica y el Reto Demográfico',
      sourceUrl: 'https://geoportalgasolineras.es',
      nacional: newPrices.nacional,
      regiones: newPrices.regiones
    }, null, 2) + '\n',
    'utf-8'
  );

  // Write precios-provincias.json
  writeFileSync(
    join(DATA_DIR, 'precios-provincias.json'),
    JSON.stringify({
      lastUpdated: getToday(),
      provincias
    }, null, 2) + '\n',
    'utf-8'
  );

  // Update historico
  const updatedHistorico = updateHistorico(historico, newPrices);
  writeFileSync(
    join(DATA_DIR, 'historico.json'),
    JSON.stringify(updatedHistorico, null, 2) + '\n',
    'utf-8'
  );

  console.log('\n=== Results ===');
  console.log(`Nacional: ${nacional.precioMedio} €/L`);
  console.log(`Regiones: ${Object.keys(regiones).length}`);
  console.log(`Provincias: ${Object.keys(provincias).length}`);
  console.log('\nFiles updated: precios.json, precios-provincias.json, historico.json');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
