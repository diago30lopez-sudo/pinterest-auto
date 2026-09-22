// ============================================================
// BACKGROUND.JS - v6
// Fetch directo a Pinterest + selección heurística (sin IA)
// El sidepanel pide las candidatas de cada escena y decide
// la ganadora con el motor heurístico duplicado en su contexto.
// ============================================================

const MAX_CANDIDATAS = 25;

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

chrome.runtime.onMessage.addListener((mensaje, sender, sendResponse) => {
  if (!mensaje || typeof mensaje !== "object") return;
  if (mensaje.tipo === "obtenerCandidatas") {
    buscarImagenesPinterest(mensaje.busqueda)
      .then((candidatas) => sendResponse({ candidatas }))
      .catch((error) => sendResponse({ candidatas: [], error: error.message }));
    return true;
  }
});

// ========== PINTEREST ==========

async function buscarImagenesPinterest(query) {
  try {
    const candidatas = await fetchPinterestApi(query);
    if (candidatas.length > 0) return candidatas;
  } catch (e) {
    console.warn(`API Pinterest falló (${e.message}). Probando SSR...`);
  }

  try {
    const candidatas = await fetchPinterestSSR(query);
    if (candidatas.length > 0) return candidatas;
  } catch (e) {
    console.warn(`Fallback SSR falló: ${e.message}`);
  }

  return [];
}

async function fetchPinterestApi(query) {
  const sourceUrl = `/search/pins/?q=${encodeURIComponent(query)}`;

  const dataObj = {
    options: { query: query, scope: "pins", bookmarks: [""], page_size: 25 },
    context: {}
  };

  const params = new URLSearchParams({
    source_url: sourceUrl,
    data: JSON.stringify(dataObj),
    _: Date.now().toString()
  });

  const url = `https://www.pinterest.com/resource/BaseSearchResource/get/?${params.toString()}`;

  const resp = await fetchConReintentos(url, {
    method: "GET",
    credentials: "include",
    headers: {
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "X-Pinterest-PWS-Handler": "www/search/[scope].js",
      "X-Requested-With": "XMLHttpRequest",
      "X-Pinterest-Source-Url": sourceUrl
    }
  });

  if (!resp.ok) {
    const detalle = await resp.text().catch(() => "");
    throw new Error(`Pinterest HTTP ${resp.status}: ${detalle.slice(0, 200)}`);
  }

  const json = await resp.json();
  const results = json?.resource_response?.data?.results || [];
  return procesarResultadosPinterest(results);
}

async function fetchPinterestSSR(query) {
  const url = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`;

  const resp = await fetchConReintentos(url, {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const html = await resp.text();
  const match = html.match(/<script id="__PWS_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!match) throw new Error("__PWS_DATA__ no encontrado");

  const pwsData = JSON.parse(match[1]);
  const resources = pwsData?.props?.initialReduxState?.resources?.BaseSearchResource || {};

  let results = [];
  for (const key in resources) {
    if (resources[key]?.data?.results) {
      results = resources[key].data.results;
      break;
    }
  }

  return procesarResultadosPinterest(results);
}

function procesarResultadosPinterest(results) {
  const candidatas = [];

  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "story") continue;
    if (!item.images) continue;

    const imgs = item.images;
    const porNombre = (n) => imgs[n]?.url || null;

    const thumb = porNombre("736x") || porNombre("474x") || porNombre("236x") || porNombre("170x");
    if (!thumb) continue;

    const fullChain = [
      porNombre("orig"),
      porNombre("1200x"),
      porNombre("736x"),
      porNombre("474x")
    ].filter(Boolean);

    if (fullChain.length === 0) continue;

    // Extraer metadatos para el heurístico
    const metadata = item.metadata || item.pin_metadata || {};
    const richSummary = item.rich_summary || metadata.rich_summary || {};

    candidatas.push({
      id: item.id || item.pin_id || null,
      thumb: thumb,
      fullChain: fullChain,
      title: item.title || item.grid_title || metadata.title || "",
      alt_text: item.alt_text || item.auto_alt_text || metadata.alt_text || "",
      description: item.description || metadata.description || richSummary.display_description || "",
      board_name: item.board?.name || item.board_name || metadata.board?.name || "",
      link: item.link || metadata.link || "",
      saves: Number(item.repin_count || item.save_count || item.aggregated_pin_data?.aggregated_stats?.saves || 0),
      reactions: Number(item.reaction_count || item.aggregated_pin_data?.aggregated_stats?.reactions || 0),
      dominant_color: item.dominant_color || metadata.dominant_color || null,
      // Guardar TODAS las variantes con sus dimensiones para el aspect ratio
      images: imgs
    });

    if (candidatas.length >= MAX_CANDIDATAS) break;
  }

  return candidatas;
}

// ========== UTILIDADES ==========

async function fetchConReintentos(url, opciones = {}, maxIntentos = 3) {
  let esperaMs = 1000;
  let ultimoError = null;

  for (let i = 0; i < maxIntentos; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(url, { ...opciones, signal: controller.signal });
      clearTimeout(timer);

      if ((res.status === 429 || (res.status >= 500 && res.status < 600)) && i < maxIntentos - 1) {
        await esperar(esperaMs);
        esperaMs *= 2;
        continue;
      }
      return res;
    } catch (e) {
      ultimoError = e;
      if (i === maxIntentos - 1) throw e;
      await esperar(esperaMs);
      esperaMs *= 2;
    }
  }

  throw ultimoError || new Error("Fallaron los reintentos.");
}

function esperar(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ============================================================
// MOTOR HEURÍSTICO AVANZADO v2 (fases + BM25-lite + cobertura)
// ============================================================
const STOPWORDS = new Set([
  "a","al","ante","bajo","cabe","con","contra","de","del","desde","durante",
  "el","la","las","los","en","entre","hacia","hasta","para","por","segun","según",
  "sin","sobre","tras","y","o","u","e","un","una","unos","unas","que","como","muy",
  "esta","este","estas","estos",
  "a","an","the","with","from","for","in","on","at","to","of","and","or","by","as",
  "into","near","over","under","this","that"]);
const ALIASES = new Map([
  ["spiderman","spiderman"],["spider-man","spiderman"],["spider man","spiderman"],
  ["primer plano","closeup"],["primerisimo plano","closeup"],["primerísimo plano","closeup"],
  ["close up","closeup"],["close-up","closeup"],["closeup","closeup"],
  ["plano medio","mediumshot"],["medium shot","mediumshot"],
  ["medium close up","mediumshot"],["medium close-up","mediumshot"],
  ["cuerpo entero","fullbody"],["cuerpo completo","fullbody"],["plano entero","fullbody"],
  ["full body","fullbody"],["full-body","fullbody"],["full length","fullbody"],
  ["plano general","wideshot"],["plano abierto","wideshot"],["wide shot","wideshot"],["long shot","wideshot"],
  ["atardecer","sunset"],["sunset","sunset"],["amanecer","sunrise"],["sunrise","sunrise"],
  ["lluvia","rain"],["rain","rain"],["montaña","mountain"],["montana","mountain"],["mountain","mountain"],
  ["gato","cat"],["cat","cat"],["perro","dog"],["dog","dog"],
  ["negro","black"],["negra","black"],["black","black"],
  ["verde","green"],["green","green"],["blanco","white"],["blanca","white"],["white","white"],
  ["azul","blue"],["blue","blue"],["rojo","red"],["roja","red"],["red","red"],
  ["futurista","futuristic"],["futuristic","futuristic"],
  ["cinematografico","cinematic"],["cinematográfica","cinematic"],["cinematográfico","cinematic"],["cinematic","cinematic"],
  ["dramatico","dramatic"],["dramática","dramatic"],["dramático","dramatic"],["dramatic","dramatic"],
  ["acuarela","watercolor"],["watercolor","watercolor"]]);
const FORMAT_REGEX = /\b(\d{1,2})\s*[:x]\s*(\d{1,2})\b/i;
const COLOR_WORDS = new Map([
  ["rojo","red"],["roja","red"],["rojos","red"],["rojas","red"],["red","red"],
  ["azul","blue"],["azules","blue"],["blue","blue"],
  ["verde","green"],["verdes","green"],["green","green"],
  ["blanco","white"],["blanca","white"],["blancos","white"],["blancas","white"],["white","white"],
  ["negro","black"],["negra","black"],["negros","black"],["negras","black"],["black","black"],
  ["amarillo","yellow"],["amarilla","yellow"],["yellow","yellow"],
  ["naranja","orange"],["orange","orange"],
  ["morado","purple"],["morada","purple"],["violeta","purple"],["violet","purple"],["purple","purple"],
  ["rosa","pink"],["rosado","pink"],["rosada","pink"],["pink","pink"],
  ["gris","gray"],["grises","gray"],["gray","gray"],["grey","gray"]]);
const SHOT_PATTERNS = [
  ["closeup", ["primer plano","primerisimo plano","primerísimo plano","close up","close-up","closeup"]],
  ["mediumshot", ["plano medio","medium shot","medium close up","medium close-up"]],
  ["fullbody", ["cuerpo entero","cuerpo completo","plano entero","full body","full-body","full length"]],
  ["wideshot", ["plano general","plano abierto","wide shot","long shot"]]];
const DESCRIPTORS = new Set([
  "dramatic","cinematic","futuristic","nostalgic","melancholic","realistic","surreal","epic",
  "sad","happy","dark","mysterious","emotional","romantic","professional","watercolor","anime"]);
function quitarAcentos(texto) {
  return String(texto ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "");
}
function normalizar(texto) {
  return quitarAcentos(texto).toLowerCase()
    .replace(/[|_/]+/g, " ")
    .replace(/[^\p{L}\p{N}\s:-]/gu, " ")
    .replace(/\s+/g, " ").trim();
}
function compactar(texto) { return normalizar(texto).replace(/[\s-]/g, ""); }
function tokens(texto) { return normalizar(texto).replace(/-/g, " ").split(/\s+/).filter(Boolean); }
function canonicalizarToken(token) {
  const n = normalizar(token);
  if (ALIASES.has(n)) return ALIASES.get(n);
  const c = compactar(n);
  if (ALIASES.has(c)) return ALIASES.get(c);
  return c;
}
function extraerFormato(busqueda) {
  const match = normalizar(busqueda).match(FORMAT_REGEX);
  if (!match) return null;
  const w = Number(match[1]), h = Number(match[2]);
  if (!w || !h) return null;
  return { width: w, height: h, ratio: w / h };
}
function obtenerRatio(candidata) {
  const variantes = [];
  const images = candidata?.images;
  if (images && typeof images === "object") {
    for (const item of Object.values(images)) {
      if (item && Number(item.width) > 0 && Number(item.height) > 0) {
        variantes.push({ width: Number(item.width), height: Number(item.height) });
      }
    }
  }
  if (Array.isArray(candidata?.fullChain)) {
    for (const item of candidata.fullChain) {
      if (item && typeof item === "object" && Number(item.width) > 0 && Number(item.height) > 0) {
        variantes.push({ width: Number(item.width), height: Number(item.height) });
      }
    }
  }
  if (!variantes.length) return null;
  const ratios = variantes.map(v => v.width / v.height).sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  if (ratios.length % 2 === 0) return (ratios[mid - 1] + ratios[mid]) / 2;
  return ratios[mid];
}
function errorRatio(candidata, formato) {
  if (!formato) return 0;
  const ratio = obtenerRatio(candidata);
  if (!ratio) return Infinity;
  return Math.abs(ratio - formato.ratio) / formato.ratio;
}
function obtenerMayorResolucion(candidata) {
  const variantes = [];
  if (candidata?.images && typeof candidata.images === "object") {
    for (const item of Object.values(candidata.images)) {
      if (!item) continue;
      const w = Number(item.width) || 0, h = Number(item.height) || 0;
      if (w > 0 && h > 0) variantes.push({ width: w, height: h });
    }
  }
  if (Array.isArray(candidata?.fullChain)) {
    for (const item of candidata.fullChain) {
      if (item && typeof item === "object") {
        const w = Number(item.width) || 0, h = Number(item.height) || 0;
        if (w > 0 && h > 0) variantes.push({ width: w, height: h });
      }
    }
  }
  if (!variantes.length) return null;
  return variantes.reduce((best, c) => (c.width * c.height > best.width * best.height ? c : best));
}
function obtenerCampos(candidata) {
  return [
    { nombre: "title", peso: 1.00, valor: candidata?.title || "" },
    { nombre: "alt_text", peso: 0.95, valor: candidata?.alt_text || "" },
    { nombre: "description", peso: 0.75, valor: candidata?.description || "" },
    { nombre: "board_name", peso: 0.50, valor: candidata?.board_name || "" },
    { nombre: "link", peso: 0.25, valor: candidata?.link || "" }
  ].filter(x => x.valor);
}
function extraerPlanos(busqueda) {
  const texto = normalizar(busqueda);
  const encontrados = [];
  for (const [id, patterns] of SHOT_PATTERNS) {
    for (const pattern of patterns) {
      if (texto.includes(normalizar(pattern))) { encontrados.push(id); break; }
    }
  }
  return encontrados;
}
function extraerColores(busqueda) {
  const resultado = [];
  for (const token of tokens(busqueda)) {
    const key = quitarAcentos(token).toLowerCase();
    if (COLOR_WORDS.has(key)) {
      const color = COLOR_WORDS.get(key);
      if (!resultado.includes(color)) resultado.push(color);
    }
  }
  return resultado;
}
function extraerAnios(busqueda) {
  return [...new Set(String(busqueda).match(/\b(?:19|20)\d{2}\b/g) || [])];
}
function extraerTerminos(busqueda) {
  const texto = normalizar(busqueda);
  const terms = [];
  for (const token of tokens(texto)) {
    if (!token) continue;
    if (token.length <= 1 || STOPWORDS.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    const c = canonicalizarToken(token);
    if (c && !terms.includes(c)) terms.push(c);
  }
  return terms;
}
function inferirSujeto(busqueda) {
  const firstPart = String(busqueda).split(/[,;]+/)[0].trim();
  const beforeAttribute = firstPart.split(/\b(con|with|wearing|usando|lleva|que lleva)\b/i)[0];
  const resultado = [];
  for (const rawToken of tokens(beforeAttribute)) {
    const canonical = canonicalizarToken(rawToken);
    if (!canonical) continue;
    if (STOPWORDS.has(quitarAcentos(rawToken).toLowerCase())) continue;
    if (COLOR_WORDS.has(quitarAcentos(rawToken).toLowerCase())) continue;
    if (DESCRIPTORS.has(canonical)) continue;
    resultado.push(canonical);
    if (resultado.length >= 3) break;
  }
  return resultado;
}
const PERFIL_CACHE = new Map();
function analizarBusqueda(busqueda) {
  const key = String(busqueda);
  if (PERFIL_CACHE.has(key)) return PERFIL_CACHE.get(key);
  const formato = extraerFormato(busqueda);
  const sujeto = inferirSujeto(busqueda);
  const perfil = {
    raw: busqueda,
    formato,
    sujeto,
    terminos: extraerTerminos(busqueda),
    planos: extraerPlanos(busqueda),
    colores: extraerColores(busqueda),
    anios: extraerAnios(busqueda)
  };
  perfil.keywordTokens = perfil.terminos.filter(t => !perfil.sujeto.includes(t));
  if (PERFIL_CACHE.size > 200) PERFIL_CACHE.delete(PERFIL_CACHE.keys().next().value);
  PERFIL_CACHE.set(key, perfil);
  return perfil;
}
function campoContieneTermino(campo, termino) {
  const texto = normalizar(campo);
  const terminoNormal = normalizar(termino);
  if (!texto || !terminoNormal) return false;
  if (texto.includes(terminoNormal)) return true;
  const tC = compactar(texto), qC = compactar(termino);
  if (qC.length >= 4 && tC.includes(qC)) return true;
  const tokensCampo = tokens(texto).map(canonicalizarToken);
  const canon = canonicalizarToken(termino);
  return tokensCampo.includes(canon);
}
function mejorMatchTermino(campos, termino) {
  let best = 0;
  for (const campo of campos) {
    if (campoContieneTermino(campo.valor, termino)) best = Math.max(best, campo.peso);
  }
  return best;
}
function colorDominante(hex) {
  if (typeof hex !== "string") return null;
  let value = hex.trim();
  if (value.startsWith("#")) value = value.slice(1);
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  if (max < 45) return "black";
  if (max > 235 && delta < 30) return "white";
  if (delta < 25) return "gray";
  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * (((b - r) / delta) + 2);
    else hue = 60 * (((r - g) / delta) + 4);
  }
  if (hue < 0) hue += 360;
  if (hue < 15 || hue >= 345) return "red";
  if (hue < 45) return "orange";
  if (hue < 70) return "yellow";
  if (hue < 170) return "green";
  if (hue < 200) return "cyan";
  if (hue < 260) return "blue";
  if (hue < 300) return "purple";
  return "pink";
}
function scorePopularidad(c) {
  const s = Math.max(0, Number(c?.saves) || 0);
  const r = Math.max(0, Number(c?.reactions) || 0);
  return Math.min(5, Math.log10(1 + s)) + Math.min(3, Math.log10(1 + r));
}
function scorePosicion(index) {
  if (!Number.isFinite(index) || index < 0) return 0;
  return Math.max(0, 6 - Math.min(index, 6));
}
function scoreResolucion(c) {
  const max = obtenerMayorResolucion(c);
  if (!max) return -10;
  const longest = Math.max(max.width, max.height);
  if (longest < 480) return -20;
  if (longest < 736) return -8;
  if (longest < 1200) return 3;
  if (longest < 1600) return 6;
  return 9;
}
function scoreUrl(c) {
  const url = String(c?.link || "").toLowerCase();
  for (const w of ["watermark","preview","sample","stock-photo","stockphoto"]) {
    if (url.includes(w)) return -12;
  }
  return 0;
}
function puntuarCandidata(busqueda, candidata) {
  const perfil = analizarBusqueda(busqueda);
  const campos = obtenerCampos(candidata);
  let score = 0;
  if (perfil.formato) {
    const error = errorRatio(candidata, perfil.formato);
    if (error <= 0.025) score += 120;
    else if (error <= 0.075) score += 55;
    else if (error <= 0.15) score -= 30;
    else score -= 110;
  }
  if (perfil.sujeto.length > 0) {
    let encontrados = 0;
    for (const t of perfil.sujeto) {
      const m = mejorMatchTermino(campos, t);
      if (m > 0) encontrados += m;
    }
    const coverage = encontrados / perfil.sujeto.length;
    score += 70 * coverage;
    if (coverage === 0) score -= 40;
  }
  if (perfil.keywordTokens.length) {
    let matched = 0;
    for (const t of perfil.keywordTokens) {
      const m = mejorMatchTermino(campos, t);
      if (m > 0) matched += m;
    }
    const coverage = matched / perfil.keywordTokens.length;
    score += Math.min(50, coverage * 50);
  }
  for (const anio of perfil.anios) {
    const m = mejorMatchTermino(campos, anio);
    if (m > 0) score += 20 * m;
    else score -= 5;
  }
  for (const plano of perfil.planos) {
    let found = false;
    for (const [id, patterns] of SHOT_PATTERNS) {
      if (id !== plano) continue;
      for (const p of patterns) {
        if (mejorMatchTermino(campos, p) > 0) { found = true; break; }
      }
    }
    if (found) score += 25;
    else score -= 8;
  }
  const dominant = colorDominante(candidata?.dominant_color);
  if (dominant && perfil.colores.length && perfil.colores.includes(dominant)) score += 6;
  score += scoreResolucion(candidata);
  score += scorePopularidad(candidata);
  score += scorePosicion(candidata?._searchIndex);
  score += scoreUrl(candidata);
  if (!candidata?.title && !candidata?.alt_text && !candidata?.description) score -= 10;
  return Math.round(score * 100) / 100;
}
function elegirMejor(busqueda, candidatas) {
  if (!Array.isArray(candidatas) || candidatas.length === 0) return -1;
  const perfil = analizarBusqueda(busqueda);
  const preparadas = candidatas.map((c, i) => ({
    candidata: { ...c, _searchIndex: i },
    index: i,
    ratioError: perfil.formato ? errorRatio(c, perfil.formato) : 0
  }));
  let grupo = preparadas;
  if (perfil.formato) {
    const exactas = preparadas.filter(x => x.ratioError <= 0.025);
    const cercanas = preparadas.filter(x => x.ratioError <= 0.075);
    if (exactas.length) grupo = exactas;
    else if (cercanas.length) grupo = cercanas;
  }
  let mejor = grupo[0], mejorScore = -Infinity;
  for (const item of grupo) {
    const score = puntuarCandidata(busqueda, item.candidata);
    if (score > mejorScore) { mejorScore = score; mejor = item; continue; }
    if (score === mejorScore && item.ratioError < mejor.ratioError) { mejor = item; continue; }
    if (score === mejorScore && item.index < mejor.index) { mejor = item; }
  }
  return mejor.index;
}

// ============================================================
// Limpieza de hashes al cerrar el panel
// ============================================================

async function limpiarHashes() {
  await chrome.storage.session.remove("hashesVistos");
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "sidepanel") {
    port.onDisconnect.addListener(async () => {
      await limpiarHashes();
      console.log("Panel cerrado. Historial de hashes limpiado.");
    });
  }
});