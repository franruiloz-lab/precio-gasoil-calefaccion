/**
 * Script de actualización automática de precios de Gasóleo C.
 *
 * Fuente: API REST del Ministerio para la Transición Ecológica (MITECO)
 * https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/
 *
 * Estrategia:
 * 1. Obtiene el precio real de Gasóleo C de las estaciones que lo venden (~11 estaciones)
 * 2. Obtiene precios de Gasóleo A de todas las estaciones (~12.000) para calcular variaciones regionales
 * 3. Aplica el ratio GOC/GOA a las medias regionales de GOA para estimar GOC por CCAA
 * 4. Calcula variaciones semanales y mensuales comparando con datos anteriores
 * 5. Actualiza precios.json e historico.json
 */

import { readFileSync, writeFileSync } from 'fs';
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

const REGION_SLUGS = Object.values(CCAA_MAP);

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

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
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

async function fetchGasoleoAByRegion() {
  console.log('Fetching Gasóleo A prices (all stations)...');
  const data = await fetchJSON(API_ALL);
  const stations = data.ListaEESSPrecio || [];
  console.log(`  Total stations: ${stations.length}`);

  const byRegion = {};
  for (const slug of REGION_SLUGS) {
    byRegion[slug] = [];
  }

  for (const s of stations) {
    const slug = CCAA_MAP[s.IDCCAA];
    if (!slug) continue;
    const price = parseSpanishFloat(s['Precio Gasoleo A']);
    if (!isNaN(price) && price > 0) {
      byRegion[slug].push(price);
    }
  }

  return byRegion;
}

function calculateRegionalPrices(gocStations, goaByRegion) {
  // National GOC average from direct data
  const gocPrices = gocStations.map(s => s.price);
  const gocNational = gocPrices.reduce((a, b) => a + b, 0) / gocPrices.length;

  // National GOA average
  const allGoaPrices = Object.values(goaByRegion).flat();
  const goaNational = allGoaPrices.reduce((a, b) => a + b, 0) / allGoaPrices.length;

  // Ratio GOC/GOA
  const ratio = gocNational / goaNational;
  console.log(`  GOC national avg: ${gocNational.toFixed(3)} €/L (${gocPrices.length} stations)`);
  console.log(`  GOA national avg: ${goaNational.toFixed(3)} €/L (${allGoaPrices.length} stations)`);
  console.log(`  Ratio GOC/GOA: ${ratio.toFixed(4)}`);

  // Calculate regional GOC estimates
  const regiones = {};
  for (const slug of REGION_SLUGS) {
    const goaPrices = goaByRegion[slug];
    if (goaPrices.length === 0) {
      // Fallback to national average
      regiones[slug] = {
        precioMedio: round3(gocNational),
        precioMin: round3(gocNational * 0.9),
        precioMax: round3(gocNational * 1.1)
      };
      continue;
    }

    const goaRegionalAvg = goaPrices.reduce((a, b) => a + b, 0) / goaPrices.length;
    const goaRegionalMin = Math.min(...goaPrices);
    const goaRegionalMax = Math.max(...goaPrices);

    // Use percentile 10 and 90 for min/max to avoid outliers
    const sorted = [...goaPrices].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.1)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];

    regiones[slug] = {
      precioMedio: round3(goaRegionalAvg * ratio),
      precioMin: round3(p10 * ratio),
      precioMax: round3(p90 * ratio)
    };
  }

  // National stats using percentiles too
  const sortedAll = [...allGoaPrices].sort((a, b) => a - b);
  const p10All = sortedAll[Math.floor(sortedAll.length * 0.1)];
  const p90All = sortedAll[Math.floor(sortedAll.length * 0.9)];

  const nacional = {
    precioMedio: round3(gocNational),
    precioMin: round3(p10All * ratio),
    precioMax: round3(p90All * ratio)
  };

  return { nacional, regiones };
}

function addVariations(newPrices, oldPrices, historico) {
  const currentMonth = getCurrentMonth();
  const lastMonthDate = new Date();
  lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);
  const lastMonth = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;

  // Find last month's entry in historico
  const lastMonthEntry = historico.meses.find(m => m.fecha === lastMonth);

  // Weekly variation = new price - old price (from precios.json)
  // Monthly variation = new price - last month's historico entry
  const oldNacional = oldPrices?.nacional?.precioMedio;
  const lastMonthNacional = lastMonthEntry?.nacional;

  newPrices.nacional.variacionSemanal = oldNacional
    ? round3(newPrices.nacional.precioMedio - oldNacional)
    : 0;
  newPrices.nacional.variacionMensual = lastMonthNacional
    ? round3(newPrices.nacional.precioMedio - lastMonthNacional)
    : 0;

  for (const slug of REGION_SLUGS) {
    const oldRegion = oldPrices?.regiones?.[slug]?.precioMedio;
    const lastMonthRegion = lastMonthEntry?.[slug];

    newPrices.regiones[slug].variacionSemanal = oldRegion
      ? round3(newPrices.regiones[slug].precioMedio - oldRegion)
      : 0;
    newPrices.regiones[slug].variacionMensual = lastMonthRegion
      ? round3(newPrices.regiones[slug].precioMedio - lastMonthRegion)
      : 0;
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
    // Update existing month entry
    historico.meses[existingIdx] = entry;
  } else {
    // Add new month
    historico.meses.push(entry);
  }

  // Keep only last 24 months
  if (historico.meses.length > 24) {
    historico.meses = historico.meses.slice(-24);
  }

  historico.lastUpdated = getToday();
  return historico;
}

async function main() {
  console.log(`\n=== Actualización de precios: ${getToday()} ===\n`);

  // Load existing data
  const oldPrices = JSON.parse(readFileSync(join(DATA_DIR, 'precios.json'), 'utf-8'));
  const historico = JSON.parse(readFileSync(join(DATA_DIR, 'historico.json'), 'utf-8'));

  // Fetch fresh data from MITECO API
  const [gocStations, goaByRegion] = await Promise.all([
    fetchGasoleoCPrices(),
    fetchGasoleoAByRegion()
  ]);

  if (gocStations.length === 0) {
    console.error('ERROR: No Gasóleo C stations found. API might be down. Skipping update.');
    process.exit(1);
  }

  // Calculate new prices
  console.log('\nCalculating regional prices...');
  const newPrices = calculateRegionalPrices(gocStations, goaByRegion);

  // Add variations comparing to old data
  addVariations(newPrices, oldPrices, historico);

  // Build final precios.json
  const preciosOutput = {
    lastUpdated: getToday(),
    source: 'Ministerio para la Transición Ecológica y el Reto Demográfico',
    sourceUrl: 'https://geoportalgasolineras.es',
    nacional: newPrices.nacional,
    regiones: newPrices.regiones
  };

  // Update historico
  const updatedHistorico = updateHistorico(historico, newPrices);

  // Write files
  writeFileSync(
    join(DATA_DIR, 'precios.json'),
    JSON.stringify(preciosOutput, null, 2) + '\n',
    'utf-8'
  );
  writeFileSync(
    join(DATA_DIR, 'historico.json'),
    JSON.stringify(updatedHistorico, null, 2) + '\n',
    'utf-8'
  );

  console.log('\n=== Results ===');
  console.log(`Nacional: ${newPrices.nacional.precioMedio} €/L (sem: ${newPrices.nacional.variacionSemanal >= 0 ? '+' : ''}${newPrices.nacional.variacionSemanal}, mes: ${newPrices.nacional.variacionMensual >= 0 ? '+' : ''}${newPrices.nacional.variacionMensual})`);
  for (const slug of REGION_SLUGS) {
    const r = newPrices.regiones[slug];
    console.log(`  ${slug}: ${r.precioMedio} €/L`);
  }
  console.log('\nFiles updated: precios.json, historico.json');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
