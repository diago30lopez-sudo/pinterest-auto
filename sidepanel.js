// ============================================================
// SIDEPANEL.JS - v7
// Bucle principal local: pide candidatas al background, elige
// la ganadora con heurístico + ratio estricto + triple hash
// anti-duplicados + anti-pancartas + anti-IA + fallbacks.
// Carpeta personalizada con File System Access API + IndexedDB.
// ============================================================

// ---------- Elementos del DOM ----------
const logDiv = document.getElementById("log");
const progresoDiv = document.getElementById("progreso");
const barraRelleno = document.getElementById("barraRelleno");
const textoProgreso = document.getElementById("textoProgreso");

// ---------- Log y progreso ----------
function log(mensaje, tipo = "info") {
  const linea = document.createElement("div");
  linea.className = tipo;
  linea.textContent = `[${new Date().toLocaleTimeString()}] ${mensaje}`;
  logDiv.appendChild(linea);
  logDiv.scrollTop = logDiv.scrollHeight; // autoscroll
}

function actualizarProgreso(actual, total) {
  progresoDiv.classList.add("visible");
  textoProgreso.textContent = `Escena ${actual}/${total}`;
  const porcentaje = total > 0 ? (actual / total) * 100 : 0;
  barraRelleno.style.width = porcentaje + "%";
}

// ---------- Parseo del guion: captura nº de escena y búsqueda ----------
// Acepta comillas rectas (") o curvas (\u201C \u201D) para mayor robustez.
const REGEX_ESCENAS = /ESCENA\s*#?(\d+).*?BÚSQUEDA\s+DE\s+IMAGEN.*?:\s*["\u201C\u201D]*\s*(.+?)\s*["\u201C\u201D]/gis;

function parsearGuion(guion) {
  const escenas = [];
  let coincidencia;
  while ((coincidencia = REGEX_ESCENAS.exec(guion)) !== null) {
    escenas.push({
      numero: parseInt(coincidencia[1], 10),
      busqueda: coincidencia[2],
    });
  }
  return escenas;
}

// ============================================================
// CARPETA PERSONALIZADA (File System Access API + IndexedDB)
// ============================================================

let carpetaElegidaHandle = null;

document.getElementById("btn_elegir_carpeta").addEventListener("click", async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    carpetaElegidaHandle = handle;
    document.getElementById("ruta_carpeta_seleccionada").textContent = handle.name + "/";
    // Guardar el handle en IndexedDB para persistir entre sesiones
    await guardarHandleEnIDB(handle);
    console.log("Carpeta elegida:", handle.name);
  } catch (e) {
    if (e.name !== "AbortError") console.error("Error al elegir carpeta:", e);
  }
});

document.getElementById("btn_limpiar_carpeta").addEventListener("click", async () => {
  carpetaElegidaHandle = null;
  document.getElementById("ruta_carpeta_seleccionada").textContent = "Descargas/pinterest_descargas/";
  await borrarHandleDeIDB();
});

// Persistencia con IndexedDB (FileSystemDirectoryHandle no se puede guardar en chrome.storage)
function abrirIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("pinterest_auto", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("handles");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function guardarHandleEnIDB(handle) {
  const db = await abrirIDB();
  const tx = db.transaction("handles", "readwrite");
  tx.objectStore("handles").put(handle, "carpetaDescarga");
}

async function borrarHandleDeIDB() {
  const db = await abrirIDB();
  const tx = db.transaction("handles", "readwrite");
  tx.objectStore("handles").delete("carpetaDescarga");
}

async function cargarHandleDeIDB() {
  const db = await abrirIDB();
  return new Promise((resolve) => {
    const tx = db.transaction("handles", "readonly");
    const req = tx.objectStore("handles").get("carpetaDescarga");
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

// Al arrancar el panel, intentar recuperar el handle
(async () => {
  const handle = await cargarHandleDeIDB();
  if (handle) {
    // Verificar permiso; si no lo tiene, pedirlo silenciosamente
    const permiso = await handle.queryPermission({ mode: "readwrite" });
    if (permiso === "granted") {
      carpetaElegidaHandle = handle;
      document.getElementById("ruta_carpeta_seleccionada").textContent = handle.name + "/";
    }
  }
})();

// Función para guardar un blob en la carpeta elegida (o Descargas por fallback)
async function guardarArchivo(filename, blob) {
  if (carpetaElegidaHandle) {
    try {
      const fileHandle = await carpetaElegidaHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { ok: true, ruta: carpetaElegidaHandle.name + "/" + filename };
    } catch (e) {
      console.error("Error guardando en carpeta elegida:", e);
      // Fallback a Descargas
    }
  }
  // Fallback: chrome.downloads
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({
    url: url,
    filename: "pinterest_descargas/" + filename,
    conflictAction: "uniquify",
    saveAs: false
  });
  return { ok: true, ruta: "Descargas/pinterest_descargas/" + filename };
}

// ============================================================
// MOTOR HEURÍSTICO AVANZADO v2 (fases + BM25-lite + cobertura)
// (Duplicado: el sidepanel no puede llamar funciones del SW)
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
function ratioAceptable(candidata) {
  const ratio = obtenerRatio(candidata);
  if (!ratio) return false;
  return ratio >= 0.75 && ratio <= 2.2;
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
// FASE 1 (heurístico): devuelve los índices TOP 10 ordenados
// ============================================================
function elegirTop10(busqueda, candidatas) {
  if (!Array.isArray(candidatas) || candidatas.length === 0) return [];
  const perfil = analizarBusqueda(busqueda);
  const preparadas = candidatas.map((c, i) => ({
    candidata: { ...c, _searchIndex: i },
    index: i,
    ratioError: perfil.formato ? errorRatio(c, perfil.formato) : 0
  }));
  // Filtro por ratio
  let grupo = preparadas;
  if (perfil.formato) {
    const exactas = preparadas.filter(x => x.ratioError <= 0.025);
    const cercanas = preparadas.filter(x => x.ratioError <= 0.075);
    if (exactas.length) grupo = exactas;
    else if (cercanas.length) grupo = cercanas;
  }
  // Calcular scores
  const conScore = grupo.map(item => ({
    ...item,
    score: puntuarCandidata(busqueda, item.candidata)
  }));
  // Ordenar descendente
  conScore.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.ratioError !== b.ratioError) return a.ratioError - b.ratioError;
    return a.index - b.index;
  });
  // Devolver los 10 primeros índices del array original
  return conScore.slice(0, 10).map(item => item.index);
}

// Devuelve candidatas ya ordenadas por score (para la revisión manual,
// donde interesa un conjunto amplio de variantes y no solo 10)
function rankearCandidatas(busqueda, candidatas, limite = 40) {
  if (!Array.isArray(candidatas) || candidatas.length === 0) return [];
  const perfil = analizarBusqueda(busqueda);
  const preparadas = candidatas.map((c, i) => ({
    candidata: c,
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
  grupo.forEach(x => { x.score = puntuarCandidata(busqueda, x.candidata); });
  grupo.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.ratioError !== b.ratioError) return a.ratioError - b.ratioError;
    return a.index - b.index;
  });
  return grupo.slice(0, limite).map(x => x.candidata);
}

// ============================================================
// Filtro local de imágenes generadas por IA (heurístico previo)
// ============================================================
function esProbablementeIA(candidata) {
  const url = (candidata.thumb || "").toLowerCase();
  const titulo = (candidata.title || "").toLowerCase();
  const alt = (candidata.alt_text || "").toLowerCase();
  const desc = (candidata.description || "").toLowerCase();
  const board = (candidata.board_name || "").toLowerCase();
  const textoTotal = `${titulo} ${alt} ${desc} ${board}`;

  const señalesIA = [
    "ai generated", "ai-generated", "aiart", "ai art",
    "midjourney", "dall-e", "dalle", "stable diffusion", "stablediffusion",
    "generated by ai", "ia generada", "generado por ia",
    "artificial intelligence", "neural",
    "prompt:", "negative prompt",
    "digital art ai", "ai illustration", "ai digital",
    "novelai", "leonardo ai", "copilot image"
  ];

  for (const señal of señalesIA) {
    if (textoTotal.includes(señal)) return true;
  }
  // Detección por patrón de board_name típico de IA
  if (board.includes("ai") && board.length < 15) return true;
  return false;
}

// ============================================================
// Filtro local de pancartas/afiches (heurístico previo, versión agresiva)
// ============================================================
function esProbablementePancarta(candidata) {
  const texto = `${candidata.title || ""} ${candidata.alt_text || ""} ${candidata.description || ""} ${candidata.board_name || ""}`.toLowerCase();
  const señalesDuras = [
    "trailer", "teaser", "official trailer", "official teaser",
    "movie poster", "film poster", "póster oficial", "poster oficial",
    "movie promo", "promotional", "promocional",
    "release date", "in theaters", "now playing", "coming soon",
    "fan poster", "fan made poster", "concept poster",
    "marvel studios", "dc studios", "warner bros", "walt disney",
    "pixar animation", "sony pictures", "universal pictures",
    "paramount pictures", "20th century", "hbo max", "netflix original",
    "typography", "text overlay", "with text", "con texto",
    "quote poster", "minimalist poster", "logo", "watermark",
    "title card", "subtitle", "subtitled",
    "thumbnail", "youtube thumbnail", "hd wallpaper with text"
  ];
  for (const s of señalesDuras) {
    if (texto.includes(s)) return true;
  }
  if (/\b(19|20)\d{2}\b.*\bposter\b/i.test(texto)) return true;
  if (/\bposter\b.*\b(19|20)\d{2}\b/i.test(texto)) return true;
  const board = (candidata.board_name || "").toLowerCase();
  const boardsSospechosos = [
    "trailers", "movie posters", "film posters", "cinema",
    "movie news", "upcoming movies", "marvel posters", "dc posters"
  ];
  for (const b of boardsSospechosos) {
    if (board.includes(b)) return true;
  }
  return false;
}

// ============================================================
// Filtro por URL sospechosa (pósters de IMDb, TMDB, YouTube, etc.)
// ============================================================
function urlSospechosa(candidata) {
  const url = (candidata.link || candidata.thumb || "").toLowerCase();
  const dominiosSospechosos = [
    "youtube.com", "youtu.be",
    "imdb.com",
    "themoviedb.org", "tmdb.org",
    "rottentomatoes.com",
    "marvel.com", "dc.com", "disney.com",
    "warnerbros.com", "sonypictures.com",
    "collider.com", "screenrant.com", "ign.com",
    "cinema.com", "sensacine.com"
  ];
  for (const d of dominiosSospechosos) {
    if (url.includes(d)) return true;
  }
  if (/poster|\/trailer\/|\/promo\//.test(url)) return true;
  return false;
}

// ============================================================
// TRIPLE HASH: dHash + aHash + ColorHash para anti-duplicados
// ============================================================

// dHash: detecta similitud estructural (encuadre)
async function calcularDHash(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(9, 8);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, 9, 8);
  const data = ctx.getImageData(0, 0, 9, 8).data;
  const grises = [];
  for (let i = 0; i < data.length; i += 4) {
    grises.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }
  let bits = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const idx = y * 9 + x;
      bits += (grises[idx] < grises[idx + 1]) ? "1" : "0";
    }
  }
  let hash = "";
  for (let i = 0; i < 64; i += 4) {
    hash += parseInt(bits.substring(i, i + 4), 2).toString(16);
  }
  return hash;
}

// aHash: detecta similitud de luminancia (misma imagen con diferente color)
async function calcularAHash(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(8, 8);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, 8, 8);
  const data = ctx.getImageData(0, 0, 8, 8).data;
  const grises = [];
  for (let i = 0; i < data.length; i += 4) {
    grises.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }
  const promedio = grises.reduce((a, b) => a + b, 0) / grises.length;
  let bits = "";
  for (const g of grises) bits += (g > promedio) ? "1" : "0";
  let hash = "";
  for (let i = 0; i < 64; i += 4) {
    hash += parseInt(bits.substring(i, i + 4), 2).toString(16);
  }
  return hash;
}

// ColorHash: histograma de color simplificado (4x4x4 = 64 bins)
async function calcularColorHash(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(32, 32);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, 32, 32);
  const data = ctx.getImageData(0, 0, 32, 32).data;
  const bins = new Array(64).fill(0);
  for (let i = 0; i < data.length; i += 4) {
    const r = Math.floor(data[i] / 64);
    const g = Math.floor(data[i + 1] / 64);
    const b = Math.floor(data[i + 2] / 64);
    const bin = r * 16 + g * 4 + b;
    bins[bin]++;
  }
  return bins;
}

function hammingDistance(h1, h2) {
  if (!h1 || !h2 || h1.length !== h2.length) return 999;
  let d = 0;
  for (let i = 0; i < h1.length; i++) {
    let bits = parseInt(h1[i], 16) ^ parseInt(h2[i], 16);
    while (bits) { d += bits & 1; bits >>= 1; }
  }
  return d;
}

function colorDistance(bins1, bins2) {
  if (!bins1 || !bins2) return 999;
  let sum = 0;
  const total1 = bins1.reduce((a, b) => a + b, 0) || 1;
  const total2 = bins2.reduce((a, b) => a + b, 0) || 1;
  for (let i = 0; i < bins1.length; i++) {
    sum += Math.abs(bins1[i] / total1 - bins2[i] / total2);
  }
  return sum / 2; // 0 = idénticos, 1 = totalmente distintos
}

// Compara una candidata contra todo el historial usando triple hash
function esSimilarAHistorial(hashesVistos) {
  return async function(hashesActuales) {
    if (!hashesActuales) return false;
    for (const prev of hashesVistos) {
      if (!prev) continue;
      const dD = hammingDistance(hashesActuales.dHash, prev.dHash);
      const dA = hammingDistance(hashesActuales.aHash, prev.aHash);
      const dC = colorDistance(hashesActuales.colorHash, prev.colorHash);
      // Reglas más estrictas:
      // - Si dHash muy parecido (≤ 5) → duplicado estructural
      // - Si aHash muy parecido (≤ 5) Y color similar (≤ 0.15) → duplicado visual
      // - Si color muy parecido (≤ 0.10) Y dHash parecido (≤ 8) → duplicado
      if (dD <= 5) return true;
      if (dA <= 5 && dC <= 0.15) return true;
      if (dC <= 0.10 && dD <= 8) return true;
    }
    return false;
  };
}

// Calcula los 3 hashes de una candidata
async function calcularHashtriple(url) {
  const [dHash, aHash, colorHash] = await Promise.all([
    calcularDHash(url).catch(() => null),
    calcularAHash(url).catch(() => null),
    calcularColorHash(url).catch(() => null)
  ]);
  if (!dHash || !aHash || !colorHash) return null;
  return { dHash, aHash, colorHash };
}

// ============================================================
// FASE 2: VERIFICACIÓN VISUAL CON FREELMAPI
// ============================================================

function urlMiniatura236x(url) {
  // Si es una URL de pinimg, forzar la versión /236x/ para ahorrar ancho de banda.
  return String(url || "").replace(/\/i\.pinimg\.com\/[^/]+\//i, "/i.pinimg.com/236x/");
}

// ============================================================
// MODO SILENCIOSO
// No escribe trazas internas salvo que se active MODO_SILENCIOSO = false.
// La verificación visual con IA viene ACTIVADA por defecto.
// ============================================================
const MODO_SILENCIOSO = true;
function logSilencioso(...args) {
  if (MODO_SILENCIOSO) return;
  console.log(...args);
}

async function obtenerConfigFreeLLM() {
  const data = await chrome.storage.local.get([
    "freellmApiUrl", "freellmApiKey", "freellmModel", "usarVisionIA", "modoRapido"
  ]);
  return {
    url: (data.freellmApiUrl || "http://localhost:3001/v1").replace(/\/$/, ""),
    key: data.freellmApiKey || "",
    model: data.freellmModel || "minicpm-v-4.6",
    // Sin preferencia guardada se asume activada; "Modo rápido" la apaga
    activo: data.usarVisionIA !== false && !data.modoRapido
  };
}

async function descargarComoBase64(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const blob = await resp.blob();
  const mimeType = blob.type || "image/jpeg";
  const data = await new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => resolve(lector.result.split(",")[1]);
    lector.onerror = () => reject(new Error("Error blob a base64"));
    lector.readAsDataURL(blob);
  });
  return { data, mimeType };
}

async function elegirConVisionIA(busqueda, candidatasTop10) {
  const config = await obtenerConfigFreeLLM();
  if (!config.activo || !config.key) {
    return { indice: 0, motivo: "IA desactivada" };
  }
  // Descargar las 10 miniaturas en paralelo
  const imagenes = [];
  for (const cand of candidatasTop10) {
    try {
      const base64 = await descargarComoBase64(urlMiniatura236x(cand.thumb));
      imagenes.push({
        type: "image_url",
        image_url: { url: `data:${base64.mimeType};base64,${base64.data}` }
      });
    } catch (e) {
      // Si una imagen falla, se ignora
    }
  }
  if (imagenes.length === 0) {
    return { indice: -1, motivo: "No se pudieron descargar miniaturas" };
  }
  const prompt = `Eres un director de arte. Selecciona la mejor imagen para una escena de video.
Texto de la escena: "${busqueda}"

REGLAS DE RECHAZO ABSOLUTO (descarta la imagen si cumple CUALQUIERA):
❌ Póster promocional de película/serie (título, logos, créditos, "MARVEL STUDIOS").
❌ Thumbnail de YouTube (texto grande, flechas, logos, "TRAILER", "UPDATE").
❌ Texto superpuesto en cualquier parte: fechas, títulos, marcas de agua.
❌ Imagen generada por IA (estilo Midjourney/DALL-E: piel plástica, manos deformes, iluminación irreal, composición "perfecta").
❌ Orientación vertical extrema (9:16 tipo story).
❌ Capturas de pantalla con interfaz o subtítulos.

PREFERENCIAS:
✅ Fotogramas reales de películas/series (aspecto cinematográfico natural).
✅ Fotografía profesional.
✅ Composiciones limpias sin texto.
✅ Relación de aspecto horizontal (16:9) o cuadrada.

Analiza estas ${imagenes.length} imágenes (índices 0 a ${imagenes.length - 1}):
${imagenes.map((_, i) => `[${i}]`).join(" ")}

Responde SOLO con el número del índice ganador (ejemplo: 3).
Si NINGUNA cumple, responde exactamente: "NINGUNA".`;
  const cuerpo = {
    model: config.model,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        ...imagenes
      ]
    }],
    max_tokens: 10,
    temperature: 0
  };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const resp = await fetch(`${config.url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + config.key
      },
      body: JSON.stringify(cuerpo),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      return { indice: -1, motivo: `HTTP ${resp.status}` };
    }
    const json = await resp.json();
    const texto = (json.choices?.[0]?.message?.content || "").trim();
    // Rechazo absoluto: la IA no acepta ninguna de las candidatas
    if (/NINGUNA/i.test(texto)) {
      return { indice: -1, motivo: "NINGUNA" };
    }
    const match = texto.match(/\d+/);
    if (!match) {
      return { indice: -1, motivo: `Respuesta ilegible: ${texto}` };
    }
    const idx = parseInt(match[0], 10);
    if (idx < 0 || idx >= candidatasTop10.length) {
      return { indice: -1, motivo: `Índice inválido: ${texto}` };
    }
    return { indice: idx, motivo: "OK" };
  } catch (e) {
    return { indice: -1, motivo: e.message };
  }
}

// ============================================================
// FREELMAPI: CONFIGURACIÓN EN EL PANEL (guardar/cargar/probar)
// ============================================================

(async () => {
  const data = await chrome.storage.local.get([
    "freellmApiUrl", "freellmApiKey", "freellmModel", "usarVisionIA", "modoRapido"
  ]);
  if (data.freellmApiUrl) document.getElementById("freellm_url").value = data.freellmApiUrl;
  if (data.freellmApiKey) document.getElementById("freellm_key").value = data.freellmApiKey;
  if (data.freellmModel) document.getElementById("freellm_model").value = data.freellmModel;
  // Sin preferencia guardada => IA activada por defecto
  document.getElementById("usar_vision_ia").checked = data.usarVisionIA !== false;
  document.getElementById("modo_rapido").checked = !!data.modoRapido;
})();

["freellm_url", "freellm_key", "freellm_model"].forEach(id => {
  document.getElementById(id).addEventListener("change", async (e) => {
    const map = {
      freellm_url: "freellmApiUrl",
      freellm_key: "freellmApiKey",
      freellm_model: "freellmModel"
    };
    await chrome.storage.local.set({ [map[id]]: e.target.value });
  });
});

document.getElementById("usar_vision_ia").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ usarVisionIA: e.target.checked });
});

document.getElementById("modo_rapido").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ modoRapido: e.target.checked });
});

document.getElementById("btn_probar_freellm").addEventListener("click", async () => {
  const url = document.getElementById("freellm_url").value.replace(/\/$/, "");
  const key = document.getElementById("freellm_key").value;
  const status = document.getElementById("freellm_status");
  const select = document.getElementById("freellm_modelos");
  status.textContent = "Probando...";
  status.style.color = "#888";
  try {
    const resp = await fetch(`${url}/models`, {
      headers: key ? { "Authorization": "Bearer " + key } : {}
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const modelos = (json.data || []).map(m => m.id);
    if (modelos.length) {
      select.innerHTML = "";
      for (const id of modelos) {
        const opcion = document.createElement("option");
        opcion.value = id;
        opcion.textContent = id;
        select.appendChild(opcion);
      }
      select.style.display = "block";
      select.value = document.getElementById("freellm_model").value;
      status.textContent = `✅ Conectado. ${modelos.length} modelos disponibles. Elige uno abajo.`;
    } else {
      select.style.display = "none";
      status.textContent = "✅ Conectado. La API no devolvió modelos.";
    }
    status.style.color = "#4ade80";
  } catch (e) {
    select.style.display = "none";
    status.textContent = `❌ Error: ${e.message}`;
    status.style.color = "#f87171";
  }
});

document.getElementById("freellm_modelos").addEventListener("change", async (e) => {
  document.getElementById("freellm_model").value = e.target.value;
  await chrome.storage.local.set({ freellmModel: e.target.value });
});

// ============================================================
// Empaquetado ZIP de las imágenes descargadas en esta tanda
// ============================================================

let archivosDescargados = [];
let escenasProcesoActual = [];

async function empaquetarEnZip(escenas) {
  if (!archivosDescargados.length) return;
  log("📦 Empaquetando imágenes en ZIP...");
  try {
    const zip = new JSZip();
    for (const item of archivosDescargados) {
      zip.file(item.nombre, item.blob);
    }
    const blobZip = await zip.generateAsync({ type: "blob" });
    const urlBlob = URL.createObjectURL(blobZip);
    await chrome.downloads.download({
      url: urlBlob,
      filename: "pinterest_descargas.zip",
      conflictAction: "overwrite",
      saveAs: false
    });
    log(`✅ ZIP generado: pinterest_descargas.zip (${archivosDescargados.length} imágenes)`);
  } catch (error) {
    log(`Error generando ZIP: ${error.message}`, "error");
  }
}

// ============================================================
// BÚSQUEDA (única fuente: Pinterest)
// ============================================================
async function buscarEnTodasLasFuentes(busqueda) {
  log(`🔍 Buscando en Pinterest...`);
  const candidatas = await chrome.runtime.sendMessage({
    tipo: "obtenerCandidatas",
    busqueda: busqueda
  }).then(r => r?.candidatas || []).catch(() => []);
  log(`  → Pinterest: ${candidatas.length} candidatas`);
  return candidatas;
}

// ============================================================
// Fallback en cascada: garantiza que nunca quede escena vacía
// ============================================================

async function elegirGanadoraConFallbacks(busqueda, candidatas, hashesVistos) {
  // Acumula si la IA descartó TODAS las candidatas en algún nivel.
  // Si la escena se resuelve en un nivel posterior, da igual: el usuario
  // tiene una imagen válida y no necesita revisar.
  const cascada = { rechazoAbsoluto: false };
  // NIVEL 1: filtros completos + IA + anti-duplicados
  let resultado = await intentarElegir(busqueda, candidatas, hashesVistos, {
    estado: cascada,
    usarIA: true,
    filtrarPancartas: true,
    filtrarIA: true,
    filtrarUrlSospechosas: true,
    antiDuplicados: true,
    ratioEstricto: true
  });
  if (resultado) return { ...resultado, nivel: 1 };
  // NIVEL 2: sin filtro anti-IA + anti-duplicados relajado
  log("⚠️ Nivel 1 falló. Reintentando sin filtro anti-IA...");
  resultado = await intentarElegir(busqueda, candidatas, hashesVistos, {
    estado: cascada,
    usarIA: true,
    filtrarPancartas: true,
    filtrarIA: false,
    filtrarUrlSospechosas: true,
    antiDuplicados: true,
    ratioEstricto: true
  });
  if (resultado) return { ...resultado, nivel: 2 };
  // NIVEL 3: sin anti-duplicados, sin pancartas, sin URLs sospechosas
  log("⚠️ Nivel 2 falló. Reintentando sin anti-duplicados...");
  resultado = await intentarElegir(busqueda, candidatas, hashesVistos, {
    estado: cascada,
    usarIA: true,
    filtrarPancartas: false,
    filtrarIA: false,
    filtrarUrlSospechosas: false,
    antiDuplicados: false,
    ratioEstricto: true
  });
  if (resultado) return { ...resultado, nivel: 3 };
  // NIVEL 4: solo heurístico, todo permitido, la mejor que haya
  log("⚠️ Nivel 3 falló. Usando la mejor heurística sin filtros...");
  const top = elegirTop10(busqueda, candidatas);
  if (top.length === 0) return null;
  return { candidata: candidatas[top[0]], nivel: 4, hash: null, iaOk: false, rechazoAbsoluto: cascada.rechazoAbsoluto };
}

async function intentarElegir(busqueda, candidatasOriginales, hashesVistos, opciones) {
  let candidatas = [...candidatasOriginales];
  if (opciones.ratioEstricto) {
    candidatas = candidatas.filter(c => ratioAceptable(c));
  }
  if (opciones.filtrarPancartas) {
    candidatas = candidatas.filter(c => !esProbablementePancarta(c));
  }
  if (opciones.filtrarUrlSospechosas) {
    candidatas = candidatas.filter(c => !urlSospechosa(c));
  }
  if (opciones.filtrarIA) {
    candidatas = candidatas.filter(c => !esProbablementeIA(c));
  }
  if (candidatas.length === 0) return null;
  const top10 = elegirTop10(busqueda, candidatas);
  if (top10.length === 0) return null;
  let indiceGanador = top10[0];
  // IA visual si está activa
  const config = await obtenerConfigFreeLLM();
  let iaOk = true;
  let rechazoAbsoluto = false;
  if (opciones.usarIA && config.activo) {
    const top10Cands = top10.map(i => candidatas[i]);
    const resIA = await elegirConVisionIA(busqueda, top10Cands);
    if (resIA.motivo === "OK") {
      indiceGanador = top10[resIA.indice];
    } else {
      iaOk = false;
      // La IA descartó TODAS las candidatas: no hay nada aceptable aquí,
      // se baja al siguiente nivel de la cascada en vez de forzar una.
      if (resIA.motivo === "NINGUNA") rechazoAbsoluto = true;
      logSilencioso(`IA: ${resIA.motivo}`);
    }
  }
  if (rechazoAbsoluto) {
    if (opciones.estado) opciones.estado.rechazoAbsoluto = true;
    return null;
  }
  // Anti-duplicados
  if (opciones.antiDuplicados) {
    for (const idx of top10) {
      const cand = candidatas[idx];
      const hashtriple = await calcularHashtriple(cand.thumb).catch(() => null);
      if (hashtriple && await esSimilarAHistorial(hashesVistos)(hashtriple)) continue;
      return { candidata: cand, hash: hashtriple, iaOk };
    }
    return null;
  }
  // Sin anti-duplicados: devolver la ganadora directa
  const cand = candidatas[indiceGanador];
  const hashtriple = await calcularHashtriple(cand.thumb).catch(() => null);
  return { candidata: cand, hash: hashtriple, iaOk };
}

// ============================================================
// MEJORA 1: DUPLICADOS VISUALES CON IA
// El dHash no detecta "casi la misma" imagen (mismo personaje, mismo fondo
// con distinto encuadre, mismo fotograma con filtro de color). La IA compara
// las candidatas nuevas contra las últimas imágenes ya descargadas.
// Devuelve { indicesValidos, razones } o null si no se puede usar la IA.
// ============================================================
async function hayDuplicadoVisualConIA(candidatas, hashesVistos, escenaNumero) {
  const config = await obtenerConfigFreeLLM();
  if (!config.activo || !config.key) {
    return null; // sin IA se queda el comportamiento local por hash
  }
  // 1. Miniaturas de las top 5 candidatas nuevas
  const imagenes = [];
  for (let i = 0; i < Math.min(5, candidatas.length); i++) {
    try {
      const b64 = await descargarComoBase64(candidatas[i].thumb);
      imagenes.push({
        type: "image_url",
        image_url: { url: `data:${b64.mimeType};base64,${b64.data}` }
      });
    } catch (e) { /* skip */ }
  }
  if (imagenes.length === 0) return null;
  // 2. Miniaturas de las últimas 8 imágenes ya descargadas
  const imagenesAnteriores = [];
  for (const h of hashesVistos.slice(-8)) {
    if (h.thumb) {
      try {
        const b64 = await descargarComoBase64(h.thumb);
        imagenesAnteriores.push({
          type: "image_url",
          image_url: { url: `data:${b64.mimeType};base64,${b64.data}` }
        });
      } catch (e) { /* skip */ }
    }
  }
  if (imagenesAnteriores.length === 0) return null; // primera escena
  const prompt = `Analiza las primeras ${imagenes.length} imágenes (NUEVAS) y compáralas con las últimas ${imagenesAnteriores.length} (YA USADAS).

TAREA 1 - Detectar duplicados:
Una imagen NUEVA es DUPLICADA si:
- Es la misma escena exacta que una anterior.
- Es el mismo personaje en el mismo encuadre con mínimas variaciones (color, zoom, filtro).
- Es una variante visual de la misma foto base.

NO es duplicada si:
- Es la misma persona pero en pose/escena diferente.
- Es el mismo personaje en contexto distinto.

TAREA 2 - Detectar contenido prohibido:
Descarta una imagen NUEVA si:
- Es un póster promocional de película/serie (con título, logos, créditos).
- Tiene texto superpuesto grande ("TRAILER", "UPDATE", fechas, títulos).
- Es un thumbnail de YouTube.
- Parece generada por IA (estilo Midjourney/DALL-E, anatomía incorrecta, brillos irreales, piel artificial).

Responde con JSON:
{
  "indicesValidos": [0, 2, 3],
  "razones": {"1": "duplicada con anterior", "4": "póster con texto"}
}
Si ninguna es válida: {"indicesValidos": [], "razones": {...}}.`;
  const body = {
    model: config.model,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "text", text: "--- IMÁGENES NUEVAS ---" },
        ...imagenes,
        { type: "text", text: "--- IMÁGENES YA USADAS ---" },
        ...imagenesAnteriores
      ]
    }],
    max_tokens: 200,
    temperature: 0
  };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    const resp = await fetch(`${config.url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + config.key
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const json = await resp.json();
    const texto = (json.choices?.[0]?.message?.content || "").trim();
    const m = texto.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const resultado = JSON.parse(m[0]);
    if (!Array.isArray(resultado.indicesValidos)) return null;
    const descartadas = [...imagenes.keys()].filter(i => !resultado.indicesValidos.includes(i));
    if (descartadas.length) {
      const detalle = descartadas.map(i => `${i}: ${resultado.razones?.[i] || "descartada"}`).join(", ");
      log(`🖼️ Escena ${escenaNumero}: IA descarta ${descartadas.length} (${detalle})`);
    }
    return resultado;
  } catch (e) {
    logSilencioso("IA duplicados falló:", e);
    return null;
  }
}

// ============================================================
// TRIPLE CAPA DE FILTROS IA
//   Capa 1: duplicados visuales (dHash + aHash + ColorHash)
//   Capa 2: pósters y material de promoción
//   Capa 3: imágenes generadas por IA
// Devuelve las tres capas evaluadas para poder registrar el descarte.
// ============================================================
async function evaluarCapasFiltro(candidata, hashesVistos) {
  const capas = {
    duplicadoVisual: await esSimilarAHistorial(hashesVistos)(await calcularHashtriple(candidata.thumb).catch(() => null)),
    poster: esProbablementePancarta(candidata),
    generadaIA: esProbablementeIA(candidata)
  };
  capas.limpia = !capas.duplicadoVisual && !capas.poster && !capas.generadaIA;
  return capas;
}

// ============================================================
// SISTEMA DE REVISIÓN MANUAL
// ============================================================

// Umbral y límite de revisión manual
const MAX_REVISION_PENDIENTE = 50;
const VARIANTES_POR_REVISION = 4;
const CLAVE_LIMITE_REVISION = "limiteRevisionManual";

// Escenas que acabaron sin imagen, disponible para la vista de revisión
let escenasFallidas = [];
// Números de escena ya resueltos (para el chequeo de cobertura final)
let numerosDescargados = new Set();

let estadoRevision = {
  pendientes: [],   // [{ numero, busqueda, candidatas, cursor, score, sinCandidatas }]
  indiceActual: 0,  // qué escena está viendo el usuario
  selecciones: {},   // { numeroEscena: { candidata, busqueda } }
  saltadas: []       // escenas que el usuario saltó explícitamente
};

function mostrarBotonRevisar() {
  const btn = document.getElementById("btn_revisar");
  if (!estadoRevision.pendientes.length) { btn.style.display = "none"; return; }
  document.getElementById("contador_revision").textContent = estadoRevision.pendientes.length;
  btn.style.display = "block";
}

// Ruido que Pinterest no entiende y solo restringe la búsqueda
const RUIDO_BUSQUEDA = new Set([
  "aprox", "aproximadamente", "min", "max", "seg", "minutos", "segundos",
  "res", "fullhd", "hd", "4k", "print", "jpeg", "png", "jpg", "version",
  "primer", "plano", "primer plano", "closeup", "close", "up", "fondo"
]);

function esPalabraUtil(palabra) {
  if (!palabra || palabra.length < 3) return false;
  if (palabra.includes(":")) return false;              // descarta "16:9", "00:45"
  if (/\d/.test(palabra)) return false;                 // descarta "2024", "xmen2"
  if (STOPWORDS.has(palabra)) return false;
  if (RUIDO_BUSQUEDA.has(palabra)) return false;
  return true;
}

// Cuántas palabras significativas se conservan por segmento
const PALABRAS_POR_SEGMENTO = 2;      // cuando hay 2 segmentos
const PALABRAS_SEGMENTO_UNICO = 3;    // cuando solo hay 1 segmento

// Degrada una búsqueda demasiado restrictiva conservando las franquicias:
//   1. fuera comillas y paréntesis (incluido lo que hay dentro)
//   2. fuera ratios/tiempos sueltos ("16:9", "00:45")
//   3. divide por comas y se queda con los 2 primeros segmentos
//   4. de cada segmento toma las primeras 2-3 palabras significativas
//   5. concatena
function degradarBusqueda(busqueda) {
  if (!busqueda) return "";
  let texto = busqueda.replace(/\([^)]*\)/g, " ")
    .replace(/["'\u201c\u201d\u00ab\u00bb]/g, " ");
  texto = texto.replace(/\b\d+:\d+\b/g, " ");
  const segmentos = texto.split(",").map(s => s.trim()).filter(Boolean).slice(0, 2);
  const limite = segmentos.length > 1 ? PALABRAS_POR_SEGMENTO : PALABRAS_SEGMENTO_UNICO;
  const palabras = [];
  for (const segmento of segmentos) {
    palabras.push(...segmento.split(/\s+/).filter(esPalabraUtil).slice(0, limite));
  }
  return palabras.join(" ").trim();
}

function pintarVariantes(escena) {
  const grid = document.getElementById("revision_imagenes");
  grid.innerHTML = "";
  document.getElementById("revision_acciones").style.display = "flex";
  const pool = escena.candidatas;
  const inicio = (escena.cursor || 0) % pool.length;
  const top = [];
  for (let k = 0; k < Math.min(VARIANTES_POR_REVISION, pool.length); k++) {
    top.push(pool[(inicio + k) % pool.length]);
  }
  top.forEach((cand, i) => {
    const celda = document.createElement("div");
    celda.style.cssText = "position: relative;";
    const img = document.createElement("img");
    img.src = cand.thumb;
    img.style.cssText = "width: 100%; height: 100px; object-fit: cover; cursor: pointer; border: 2px solid transparent; border-radius: 4px;";
    img.title = `Opción ${i + 1}`;
    img.addEventListener("click", () => seleccionarVariante(cand, i));
    const badge = document.createElement("span");
    badge.textContent = `${i + 1}`;
    badge.style.cssText = "position: absolute; top: 4px; left: 4px; background: rgba(0,0,0,.7); color: #fff; font-size: 10px; padding: 1px 5px; border-radius: 3px;";
    celda.appendChild(img);
    celda.appendChild(badge);
    grid.appendChild(celda);
  });
}

// Sin candidatas tras los 3 intentos: input manual + saltar
function pintarSinCandidatas(escena) {
  const grid = document.getElementById("revision_imagenes");
  grid.innerHTML = "";
  document.getElementById("revision_acciones").style.display = "none";

  const aviso = document.createElement("div");
  aviso.style.cssText = "grid-column: 1/3; font-size: 12px; color: #ffb300; margin-bottom: 8px;";
  aviso.textContent = "⚠️ No se encontraron imágenes para esta búsqueda.";
  grid.appendChild(aviso);

  const input = document.createElement("input");
  input.type = "text";
  input.value = escena.busqueda;
  input.placeholder = "Edita la búsqueda y pulsa Enter";
  input.style.cssText = "grid-column: 1/3; width: 100%; padding: 6px; margin-bottom: 6px; box-sizing: border-box;";
  grid.appendChild(input);

  const ejecutar = async () => {
    const nuevo = input.value.trim();
    if (!nuevo) return;
    escena.busqueda = nuevo;
    log(`🔍 Escena ${escena.numero}: buscando "${nuevo}"...`);
    const encontradas = await buscarEnTodasLasFuentes(nuevo);
    aplicarResultadoBusqueda(escena, encontradas, nuevo, "búsqueda manual");
  };
  input.addEventListener("keydown", e => { if (e.key === "Enter") ejecutar(); });

  const fila = document.createElement("div");
  fila.style.cssText = "grid-column: 1/3; display: flex; gap: 6px;";
  const btnBuscar = document.createElement("button");
  btnBuscar.type = "button";
  btnBuscar.textContent = "🔍 Buscar";
  btnBuscar.style.cssText = "flex: 1; padding: 8px; font-size: 12px;";
  btnBuscar.addEventListener("click", ejecutar);
  const btnOmitir = document.createElement("button");
  btnOmitir.type = "button";
  btnOmitir.textContent = "⏭️ Saltar";
  btnOmitir.style.cssText = "flex: 1; padding: 8px; font-size: 12px;";
  btnOmitir.addEventListener("click", () => {
    if (!escenasFallidas.includes(escena.numero)) escenasFallidas.push(escena.numero);
    log(`❌ Escena ${escena.numero} descartada por el usuario: sin imagen.`);
    estadoRevision.selecciones[escena.numero] = null;
    estadoRevision.indiceActual++;
    abrirRevision();
  });
  fila.appendChild(btnBuscar);
  fila.appendChild(btnOmitir);
  grid.appendChild(fila);
}

function aplicarResultadoBusqueda(escena, candidatas, textoUsado, origen) {
  if (!candidatas || candidatas.length === 0) {
    escena.sinCandidatas = true;
    pintarSinCandidatas(escena);
    return;
  }
  const filtradas = candidatas.filter(c => ratioAceptable(c) && !esProbablementePancarta(c) && !urlSospechosa(c));
  const pool = filtradas.length ? filtradas : candidatas;
  escena.candidatas = rankearCandidatas(escena.busqueda, pool);
  escena.cursor = 0;
  escena.sinCandidatas = false;
  if (textoUsado !== escena.busqueda) {
    log(`⚠️ Escena ${escena.numero}: búsqueda degradada a "${textoUsado}".`);
  }
  log(`✅ Escena ${escena.numero}: ${candidatas.length} candidatas (${origen}).`);
  pintarVariantes(escena);
}

// Cascata de 3 intentos para escenas que volvieron sin candidatas
async function recuperarCandidatas(escena) {
  const grid = document.getElementById("revision_imagenes");
  grid.innerHTML = "";
  document.getElementById("revision_acciones").style.display = "none";
  const aviso = document.createElement("div");
  aviso.style.cssText = "grid-column: 1/3; font-size: 12px; color: #888;";
  aviso.textContent = "Buscando candidatas alternativas...";
  grid.appendChild(aviso);

  // Intento 1: búsqueda original
  log(`⚠️ Escena ${escena.numero}: sin candidatas. Reintentando con búsqueda original...`);
  let r = await buscarEnTodasLasFuentes(escena.busqueda);
  if (r.length > 0) {
    aplicarResultadoBusqueda(escena, r, escena.busqueda, "búsqueda original");
    return;
  }

  // Intento 2: búsqueda degradada
  const degradada = degradarBusqueda(escena.busqueda);
  if (degradada && degradada !== escena.busqueda) {
    log(`⚠️ Escena ${escena.numero}: sigue sin candidatas. Degradando búsqueda a "${degradada}"...`);
    r = await buscarEnTodasLasFuentes(degradada);
    if (r.length > 0) {
      escena.busqueda = degradada;
      aplicarResultadoBusqueda(escena, r, degradada, "búsqueda degradada");
      return;
    }
  }

  // Intento 3: campo manual
  log(`⚠️ Escena ${escena.numero}: los 3 intentos fallaron. Requiere búsqueda manual.`);
  pintarSinCandidatas(escena);
}

function abrirRevision() {
  if (estadoRevision.indiceActual >= estadoRevision.pendientes.length) {
    cerrarRevision();
    return;
  }
  const escena = estadoRevision.pendientes[estadoRevision.indiceActual];
  if (!escena) { cerrarRevision(); return; }
  document.getElementById("vista_revision").style.display = "block";
  document.getElementById("revision_progreso").textContent =
    `${estadoRevision.indiceActual + 1}/${estadoRevision.pendientes.length}`;
  document.getElementById("revision_busqueda").textContent =
    `Escena ${escena.numero}: "${escena.busqueda}"`;

  if (escena.sinCandidatas || !escena.candidatas.length) {
    recuperarCandidatas(escena);
    return;
  }
  pintarVariantes(escena);
}

function seleccionarVariante(candidata, indice) {
  const escena = estadoRevision.pendientes[estadoRevision.indiceActual];
  if (!escena) return;
  estadoRevision.selecciones[escena.numero] = { candidata, busqueda: escena.busqueda };
  log(`✅ Escena ${escena.numero}: seleccionada variante ${indice + 1}.`);
  estadoRevision.indiceActual++;
  abrirRevision();
}

document.getElementById("btn_revisar").addEventListener("click", () => {
  estadoRevision.indiceActual = 0;
  abrirRevision();
});

document.getElementById("revision_refrescar").addEventListener("click", async () => {
  const escena = estadoRevision.pendientes[estadoRevision.indiceActual];
  if (!escena) return;
  log(`🔄 Buscando más opciones para escena ${escena.numero}...`);
  // Pinterest puede devolver resultados ligeramente distintos: se fusionan
  // con los ya conocidos y luego el cursor avanza para mostrar variantes nuevas.
  const nuevas = await buscarEnTodasLasFuentes(escena.busqueda);
  const filtradas = nuevas.filter(c => ratioAceptable(c) && !esProbablementePancarta(c) && !urlSospechosa(c));
  const candidatasNuevas = filtradas.length ? filtradas : nuevas;
  const yaVistas = new Set(escena.candidatas.map(c => (c.fullChain?.[0] || c.thumb || "").split("?")[0]));
  const nuevasUtiles = candidatasNuevas.filter(c => !yaVistas.has((c.fullChain?.[0] || c.thumb || "").split("?")[0]));
  const combinado = [...escena.candidatas, ...nuevasUtiles];
  escena.candidatas = rankearCandidatas(escena.busqueda, combinado);
  escena.cursor = (escena.cursor + VARIANTES_POR_REVISION) % Math.max(escena.candidatas.length, 1);
  abrirRevision();
});

document.getElementById("revision_saltar").addEventListener("click", () => {
  const escena = estadoRevision.pendientes[estadoRevision.indiceActual];
  if (escena) {
    log(`⏭️ Escena ${escena.numero} saltada por el usuario.`);
    estadoRevision.saltadas.push(escena.numero);
    if (escena.sinCandidatas && !escenasFallidas.includes(escena.numero)) {
      escenasFallidas.push(escena.numero);
    }
    delete estadoRevision.selecciones[escena.numero];
  }
  estadoRevision.indiceActual++;
  abrirRevision();
});

document.getElementById("cerrar_revision").addEventListener("click", cerrarRevision);

function cerrarRevision() {
  document.getElementById("vista_revision").style.display = "none";
  const completada = estadoRevision.indiceActual >= estadoRevision.pendientes.length;
  if (completada) {
    document.getElementById("btn_revisar").style.display = "none";
  }
  descargarSeleccionesRevisadas();
}

async function descargarSeleccionesRevisadas() {
  // Las descartadas se guardan como null y no deben intentar descargarse
  const selecciones = Object.entries(estadoRevision.selecciones).filter(([, v]) => v);
  if (selecciones.length === 0) {
    if (estadoRevision.indiceActual >= estadoRevision.pendientes.length) {
      verificarCobertura(escenasProcesoActual, "revisión manual");
      if (escenasFallidas.length > 0) {
        log(`❌ Escenas sin imagen: ${escenasFallidas.join(", ")}`);
      }
      estadoRevision = { pendientes: [], indiceActual: 0, selecciones: {}, saltadas: [] };
    }
    return;
  }
  log(`⬇️ Descargando ${selecciones.length} imágenes seleccionadas...`);
  const { hashesVistos = [] } = await chrome.storage.session.get("hashesVistos");
  let nuevasParaZip = 0;
  for (const [numero, sel] of selecciones) {
    try {
      const cand = sel.candidata;
      const blob = await (await fetch(cand.fullChain[0])).blob();
      const numStr = String(numero).padStart(3, "0");
      const nombreLimpio = `${numStr}_${sel.busqueda || cand.title || "escena"}`
        .replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) + ".jpg";
      const r = await guardarArchivo(nombreLimpio, blob);
      // Se suman al conjunto para que el ZIP las incluya
      archivosDescargados.push({ nombre: nombreLimpio, blob });
      numerosDescargados.add(Number(numero));
      nuevasParaZip++;
      const hash = await calcularHashtriple(cand.thumb).catch(() => null);
      if (hash) hashesVistos.push({ ...hash, thumb: cand.thumb });
      log(`✅ ${r.ruta}`);
    } catch (e) {
      log(`❌ Error descargando escena ${numero}: ${e.message}`);
    }
  }
  await chrome.storage.session.set({ hashesVistos });
  estadoRevision.selecciones = {};
  log(`✅ Revisión completada.`);
  // Regenerar el ZIP solo si se ha añadido algo nuevo
  if (nuevasParaZip > 0) {
    await empaquetarEnZip(escenasProcesoActual);
  } else {
    log("ℹ️ Sin nuevas imágenes seleccionadas: el ZIP no se modifica.");
  }
  if (estadoRevision.indiceActual >= estadoRevision.pendientes.length) {
    if (estadoRevision.saltadas.length) {
      log(`⚠️ Escenas sin imagen (saltadas): ${estadoRevision.saltadas.join(", ")}`);
    }
    verificarCobertura(escenasProcesoActual, "revisión manual");
    if (escenasFallidas.length > 0) {
      log(`❌ Escenas sin imagen: ${escenasFallidas.join(", ")}`);
    }
    estadoRevision = { pendientes: [], indiceActual: 0, selecciones: {}, saltadas: [] };
  }
}

// ---------- MEJORA 3: cargar guion desde archivo .txt / .md ----------
document.getElementById("archivo_guion").addEventListener("change", async (e) => {
  const archivo = e.target.files && e.target.files[0];
  if (!archivo) return;
  if (!/\.(txt|md|markdown)$/i.test(archivo.name)) {
    document.getElementById("nombre_archivo").textContent = "❌ solo .txt o .md";
    log(`❌ Archivo no válido: ${archivo.name}. Se requiere .txt o .md.`, "error");
    e.target.value = "";
    return;
  }
  const texto = await archivo.text();
  document.getElementById("input_guion").value = texto;
  document.getElementById("nombre_archivo").textContent =
    `✅ ${archivo.name} (${(archivo.size / 1024).toFixed(1)} KB)`;
  const escenas = parsearGuion(texto);
  if (escenas.length > 0) {
    log(`📄 Guion cargado: ${escenas.length} escenas detectadas.`);
  } else {
    log(`⚠️ El archivo no tiene escenas con el formato esperado.`);
  }
});

document.getElementById("limpiar_guion").addEventListener("click", () => {
  document.getElementById("input_guion").value = "";
  document.getElementById("nombre_archivo").textContent = "";
  document.getElementById("archivo_guion").value = "";
});

// ---------- Límite de revisión manual (configurable) ----------
const inputLimite = document.getElementById("input_limite_revision");
async function cargarLimiteRevision() {
  const guardado = await chrome.storage.local.get(CLAVE_LIMITE_REVISION);
  const valor = guardado[CLAVE_LIMITE_REVISION] || MAX_REVISION_PENDIENTE;
  inputLimite.value = valor;
  return valor;
}
function limiteRevisionEfectivo() {
  const v = parseInt(inputLimite.value, 10);
  if (!Number.isFinite(v)) return MAX_REVISION_PENDIENTE;
  return Math.min(Math.max(v, 5), 200);
}
inputLimite.addEventListener("change", async () => {
  const v = limiteRevisionEfectivo();
  inputLimite.value = v;
  await chrome.storage.local.set({ [CLAVE_LIMITE_REVISION]: v });
  log(`⚙️ Límite de revisión manual: ${v} escenas.`);
});
cargarLimiteRevision().catch(() => {});

// ============================================================
// VERIFICACIÓN DE COBERTURA
// ============================================================
function verificarCobertura(escenas, momento) {
  const numerosEsperados = escenas.map(e => e.numero);
  // Escenas ya resueltas (automáticas + auto-desbordadas + revisadas)
  const resueltas = new Set(numerosDescargados);
  // Escanas que aún esperan decisión manual: no cuentan como fallo
  const enRevision = new Set(
    estadoRevision.pendientes
      .filter(p => !estadoRevision.selecciones[p.numero])
      .map(p => p.numero)
  );
  const faltantes = numerosEsperados.filter(n => !resueltas.has(n) && !enRevision.has(n));

  if (faltantes.length > 0) {
    log(`❌ ALERTA: ${faltantes.length} escenas sin imagen: ${faltantes.join(", ")}`);
    log(`Estas escenas NO se descargaron. Revísalas manualmente.`);
    return false;
  }
  const extras = [...enRevision].filter(n => numerosEsperados.includes(n));
  if (extras.length > 0) {
    log(`✅ Sin escenas perdidas (${momento}). ${resueltas.size} descargadas, ${extras.length} aún en revisión manual.`);
  } else {
    log(`✅ Cobertura completa: ${numerosEsperados.length}/${numerosEsperados.length} escenas con imagen.`);
  }
  return true;
}

// ============================================================
// BUCLE PRINCIPAL
// ============================================================

let detenerSolicitado = false;

document.getElementById("btn_comenzar").addEventListener("click", async () => {
  const guion = document.getElementById("input_guion").value;
  const escenas = parsearGuion(guion);
  if (escenas.length === 0) { alert("No se encontraron escenas."); return; }
  detenerSolicitado = false;
  document.getElementById("btn_cancelar").style.display = "inline-block";
  document.getElementById("btn_comenzar").style.display = "none";
  let descargadas = 0;
  archivosDescargados = [];
  escenasProcesoActual = escenas;
  escenasFallidas = [];
  numerosDescargados = new Set();
  estadoRevision = { pendientes: [], indiceActual: 0, selecciones: {}, saltadas: [] };
  document.getElementById("btn_revisar").style.display = "none";
  document.getElementById("vista_revision").style.display = "none";
  const hashes = (await chrome.storage.session.get("hashesVistos")).hashesVistos || [];
  for (let i = 0; i < escenas.length; i++) {
    if (detenerSolicitado) { log("Cancelado."); break; }
    actualizarProgreso(i + 1, escenas.length);
    const escena = escenas[i];
    log(`--------- ESCENA ${escena.numero}/${escenas.length} ---------`);
    log(`Búsqueda: "${escena.busqueda}"`);
    try {
      // Búsqueda en Pinterest (fuente única)
      let candidatas = await buscarEnTodasLasFuentes(escena.busqueda);
      if (candidatas.length === 0) {
        log(`⚠️ Escena ${escena.numero}: sin candidatas. Va a revisión manual con búsqueda alternativa.`);
        estadoRevision.pendientes.push({
          numero: escena.numero,
          busqueda: escena.busqueda,
          candidatas: [],
          cursor: 0,
          score: 0,
          sinCandidatas: true
        });
        continue;
      }
      log(`Candidatas: ${candidatas.length}`);
      // Filtros estrictos en cascada antes del heurístico
      let candidatasValidas = candidatas.filter(c =>
        ratioAceptable(c) &&
        !esProbablementePancarta(c) &&
        !urlSospechosa(c) &&
        !esProbablementeIA(c)
      );
      if (candidatasValidas.length === 0) {
        log(`⚠️ Filtros estrictos sin resultados. Relajando...`);
        candidatasValidas = candidatas.filter(c => ratioAceptable(c));
      }
      if (candidatasValidas.length === 0) {
        candidatasValidas = candidatas;
      }
      log(`✅ ${candidatasValidas.length}/${candidatas.length} pasan los filtros`);
      candidatas = candidatasValidas;
      const resultadoInicial = await elegirGanadoraConFallbacks(escena.busqueda, candidatas, hashes);

      // MEJORA 1: la IA visual compara las candidatas nuevas contra las últimas
      // imágenes ya descargadas para cazar "casi duplicados" que el dHash no ve.
      const duplicados = await hayDuplicadoVisualConIA(candidatas, hashes, escena.numero);
      let resultado = resultadoInicial;
      if (duplicados) {
        const indiceGanadora = candidatas.indexOf(resultadoInicial?.candidata);
        const noValidas = indiceGanadora < 0 || !duplicados.indicesValidos.includes(indiceGanadora);
        if (noValidas) {
          const sustituta = duplicados.indicesValidas
            .map(i => candidatas[i])
            .find(c => c && ratioAceptable(c) && !esProbablementePancarta(c));
          if (sustituta) {
            if (resultadoInicial) log(`🔄 Escena ${escena.numero}: IA cambia la ganadora por una no duplicada.`);
            resultado = {
              candidata: sustituta,
              nivel: resultadoInicial ? resultadoInicial.nivel : 1,
              hash: await calcularHashtriple(sustituta.thumb).catch(() => null),
              iaOk: true
            };
          } else if (duplicados.indicesValidas.length === 0) {
            resultado = null; // ninguna utilizable -> revisión manual
          }
        }
      }

      // Criterio de revisión (MEJORA 2): solo cuando no hay nada rescued.
      if (!resultado) {
        const motivo = duplicados && duplicados.indicesValidos.length === 0
          ? "la IA descartó todas las candidatas"
          : "el heurístico no encontró ninguna que pase los filtros duros";
        log(`⚠️ Escena ${escena.numero}: va a revisión manual porque ${motivo}.`);
        estadoRevision.pendientes.push({
          numero: escena.numero,
          busqueda: escena.busqueda,
          candidatas: rankearCandidatas(escena.busqueda, candidatas),
          cursor: 0,
          score: 0
        });
        continue; // NO se descarga ahora
      }
      log(`✅ Escena ${escena.numero}: elegida por nivel ${resultado.nivel}`);
      // Triple capa: deja constancia de qué capas rozan la imagen ganadora
      const capas = await evaluarCapasFiltro(resultado.candidata, hashes);
      if (!capas.limpia) {
        const marcas = [];
        if (capas.duplicadoVisual) marcas.push("casi-duplicada");
        if (capas.poster) marcas.push("póster");
        if (capas.generadaIA) marcas.push("IA-generada");
        log(`🖼️ Escena ${escena.numero}: la elegida roza ${marcas.join(", ")}.`);
      }
      // Descargar la ganadora
      const urlFull = resultado.candidata.fullChain[0];
      const blob = await (await fetch(urlFull)).blob();
      const numStr = String(escena.numero).padStart(3, "0");
      const nombreLimpio = `${numStr}_${escena.busqueda}`.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) + ".jpg";
      const guardarResultado = await guardarArchivo(nombreLimpio, blob);
      archivosDescargados.push({ nombre: nombreLimpio, blob });
      numerosDescargados.add(escena.numero);
      if (resultado.hash) {
        hashes.push({ ...resultado.hash, thumb: resultado.candidata.thumb });
        await chrome.storage.session.set({ hashesVistos: hashes });
      }
      descargadas++;
      log(`✅ ${guardarResultado.ruta}`);
    } catch (e) {
      log(`❌ Error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  // Resolución de excedentes: las escenas sin candidatas tienen prioridad
  // ABSOLUTA (fuera del tope). El resto se ordena por score: las peores pasan a
  // revisión manual hasta el límite configurado y las demás se auto-resuelven.
  const limite = limiteRevisionEfectivo();
  const sinCandidatas = estadoRevision.pendientes.filter(p => p.sinCandidatas);
  const normales = estadoRevision.pendientes.filter(p => !p.sinCandidatas);
  normales.sort((a, b) => a.score - b.score);
  if (sinCandidatas.length) {
    log(`🔎 ${sinCandidatas.length} escena(s) sin candidatas: prioridad de revisión, no cuentan para el límite de ${limite}.`);
  }
  if (normales.length > limite) {
    const excedente = normales.splice(limite);
    log(`⚠️ ${excedente.length} escenas dudosas exceden el límite de revisión (${limite}): se resuelven automáticamente.`);
    for (const pendiente of excedente) {
      const cand = pendiente.candidatas[0];
      if (!cand) {
        log(`❌ Escena ${pendiente.numero}: sin candidatas para resolver. Se registra en fallos.`);
        escenasFallidas.push(pendiente.numero);
        continue;
      }
      try {
        const blob = await (await fetch(cand.fullChain[0])).blob();
        const numStr = String(pendiente.numero).padStart(3, "0");
        const nombreLimpio = `${numStr}_${pendiente.busqueda}`.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) + ".jpg";
        const guardarResultado = await guardarArchivo(nombreLimpio, blob);
        archivosDescargados.push({ nombre: nombreLimpio, blob });
        numerosDescargados.add(pendiente.numero);
        const hash = await calcularHashtriple(cand.thumb).catch(() => null);
        if (hash) {
          hashes.push({ ...hash, thumb: cand.thumb });
          await chrome.storage.session.set({ hashesVistos: hashes });
        }
        descargadas++;
        log(`⚠️ Escena ${pendiente.numero} resuelta automáticamente por exceder límite de revisión.`);
        log(`✅ ${guardarResultado.ruta} (resuelta automáticamente)`);
      } catch (e) {
        log(`❌ Error en escena ${pendiente.numero}: ${e.message}`);
        escenasFallidas.push(pendiente.numero);
      }
    }
  }
  // Reordenar: primero las sin candidatas, luego el resto por score
  estadoRevision.pendientes = [...sinCandidatas, ...normales];
  if (estadoRevision.pendientes.length > 0) {
    mostrarBotonRevisar();
    log(`🖐️ ${estadoRevision.pendientes.length} escenas esperan revisión manual al terminar.`);
  }
  verificarCobertura(escenas, "fin del proceso");
  if (escenasFallidas.length > 0) {
    log(`❌ Escenas sin imagen: ${escenasFallidas.join(", ")}`);
  }
  log(`Proceso completado: ${descargadas}/${escenas.length}`);
  document.getElementById("btn_cancelar").style.display = "none";
  document.getElementById("btn_comenzar").style.display = "inline-block";
  // Empaquetar en ZIP
  if (descargadas > 0) await empaquetarEnZip(escenas);
});

document.getElementById("btn_cancelar").addEventListener("click", () => {
  detenerSolicitado = true;
  log("Cancelación solicitada...");
});

// ---------- Conexión persistente con el background ----------
// El SW limpia los hashes cuando este puerto se desconecta (panel cerrado).
const puerto = chrome.runtime.connect({ name: "sidepanel" });
puerto.onDisconnect.addListener(() => {
  if (MODO_SILENCIOSO) return;
  console.log("Panel lateral cerrado.");
});