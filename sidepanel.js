// ============================================================
// SIDEPANEL.JS - v6
// Bucle principal local: pide candidatas al background, elige
// la ganadora con el heurístico duplicado, descarga y empaqueta.
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
// dHash: detección de imágenes duplicadas
// ============================================================

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

function hammingDistance(h1, h2) {
  if (h1.length !== h2.length) return 999;
  let d = 0;
  for (let i = 0; i < h1.length; i++) {
    let bits = parseInt(h1[i], 16) ^ parseInt(h2[i], 16);
    while (bits) { d += bits & 1; bits >>= 1; }
  }
  return d;
}

async function esDuplicado(hash) {
  const { hashesVistos = [] } = await chrome.storage.session.get("hashesVistos");
  for (const prev of hashesVistos) {
    if (hammingDistance(hash, prev) <= 8) return true;
  }
  return false;
}

async function registrarHash(hash) {
  const { hashesVistos = [] } = await chrome.storage.session.get("hashesVistos");
  hashesVistos.push(hash);
  await chrome.storage.session.set({ hashesVistos });
}

function esDuplicadoEnLista(hash, lista) {
  for (const prev of lista) {
    let dist = 0;
    for (let i = 0; i < hash.length; i++) {
      let bits = parseInt(hash[i], 16) ^ parseInt(prev[i], 16);
      while (bits) { dist += bits & 1; bits >>= 1; }
    }
    if (dist <= 8) return true;
  }
  return false;
}

// ============================================================
// Empaquetado ZIP de las imágenes descargadas en esta tanda
// ============================================================

let archivosDescargados = [];

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
      saveAs: false
    });
    log("✅ ZIP generado: pinterest_descargas.zip");
  } catch (error) {
    log(`Error generando ZIP: ${error.message}`, "error");
  }
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
  const hashes = (await chrome.storage.session.get("hashesVistos")).hashesVistos || [];
  for (let i = 0; i < escenas.length; i++) {
    if (detenerSolicitado) { log("Cancelado."); break; }
    actualizarProgreso(i + 1, escenas.length);
    const escena = escenas[i];
    log(`--------- ESCENA ${escena.numero}/${escenas.length} ---------`);
    log(`Búsqueda: "${escena.busqueda}"`);
    try {
      const resp = await chrome.runtime.sendMessage({ tipo: "obtenerCandidatas", busqueda: escena.busqueda });
      const candidatas = resp?.candidatas || [];
      if (candidatas.length === 0) { log(`Sin candidatas. Se omite.`); continue; }
      log(`Candidatas: ${candidatas.length}`);
      // Buscar la mejor que NO sea duplicada
      const ordenadas = candidatas
        .map((c, idx) => ({ idx, score: puntuarCandidata(escena.busqueda, { ...c, _searchIndex: idx }) }))
        .sort((a, b) => b.score - a.score);
      let elegida = null;
      for (const { idx } of ordenadas) {
        const hash = await calcularDHash(candidatas[idx].thumb).catch(() => null);
        if (hash && esDuplicadoEnLista(hash, hashes)) continue;
        elegida = { candidata: candidatas[idx], hash };
        break;
      }
      if (!elegida) { log(`⚠️ Todas las candidatas ya fueron usadas.`); continue; }
      // Descargar la ganadora
      const urlFull = elegida.candidata.fullChain[0];
      const blob = await (await fetch(urlFull)).blob();
      const numStr = String(escena.numero).padStart(3, "0");
      const nombreLimpio = `${numStr}_${escena.busqueda}`.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) + ".jpg";
      const resultado = await guardarArchivo(nombreLimpio, blob);
      archivosDescargados.push({ nombre: nombreLimpio, blob });
      if (elegida.hash) { hashes.push(elegida.hash); await chrome.storage.session.set({ hashesVistos: hashes }); }
      descargadas++;
      log(`✅ ${resultado.ruta}`);
    } catch (e) {
      log(`❌ Error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
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
  console.log("Panel lateral cerrado.");
});