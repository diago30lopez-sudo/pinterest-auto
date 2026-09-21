// ============================================================
// BACKGROUND.JS - v5
// Fetch directo a Pinterest + selección heurística (sin IA)
// ============================================================

importScripts(chrome.runtime.getURL("jszip.min.js"));

const PAUSA_ENTRE_ESCENAS_MS = 1500;
const MAX_CANDIDATAS = 25;

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

let detenerSolicitado = false;

chrome.runtime.onMessage.addListener((mensaje, sender, sendResponse) => {
  if (!mensaje || typeof mensaje !== "object") return;
  if (mensaje.tipo === "iniciar") {
    detenerSolicitado = false;
    processAllScenes(mensaje.escenas, mensaje.carpeta)
      .catch((error) => enviarLog("Error fatal: " + error.message, "error"))
      .finally(() => chrome.runtime.sendMessage({ tipo: "fin" }).catch(() => {}));
    return true;
  }
  if (mensaje.tipo === "detener") {
    detenerSolicitado = true;
    chrome.runtime.sendMessage({ tipo: "detenido" }).catch(() => {});
    return true;
  }
});

async function processAllScenes(escenas, carpeta) {
  const total = escenas.length;
  let descargadas = 0;

  enviarLog(`Iniciando procesamiento de ${total} escena(s).`, "info");

  for (let i = 0; i < escenas.length; i++) {
    if (detenerSolicitado) {
      enviarLog("Cancelado por el usuario.", "warn");
      break;
    }

    const escena = escenas[i];
    chrome.runtime.sendMessage({ tipo: "progreso", actual: i + 1, total }).catch(() => {});
    enviarLog(`--------- ESCENA ${escena.numero}/${total} ---------`, "info");
    enviarLog(`Búsqueda: "${escena.busqueda}"`, "info");

    try {
      const candidatas = await buscarImagenesPinterest(escena.busqueda);

      if (candidatas.length === 0) {
        enviarLog(`Sin imágenes para la escena ${escena.numero}. Se omite.`, "error");
        continue;
      }

      enviarLog(`Candidatas extraídas: ${candidatas.length}`, "info");
      const { indice, hash } = await elegirMejorSinDuplicados(escena.busqueda, candidatas);

      if (indice === -1) {
        enviarLog(`⚠️ Todas las candidatas de la escena ${escena.numero} ya fueron usadas en escenas anteriores. Se omite.`, "warn");
        continue;
      }

      const exito = await descargarGanadoraConHash(candidatas[indice], escena, carpeta, hash);
      if (exito) descargadas++;
    } catch (error) {
      if (error && error.message === "Cancelado por el usuario.") {
        enviarLog("Cancelado por el usuario.", "warn");
        break;
      }
      enviarLog(`Error en escena ${escena.numero}: ${error.message}`, "error");
    }

    if (i < escenas.length - 1 && !detenerSolicitado) {
      await esperar(PAUSA_ENTRE_ESCENAS_MS);
    }
  }

  enviarLog(`Proceso completado: ${descargadas}/${total} imágenes.`, "info");

  if (descargadas > 0) {
    await empaquetarEnZip(escenas, carpeta);
  }
}

// ========== PINTEREST ==========

async function buscarImagenesPinterest(query) {
  if (detenerSolicitado) throw new Error("Cancelado por el usuario.");

  try {
    const candidatas = await fetchPinterestApi(query);
    if (detenerSolicitado) throw new Error("Cancelado por el usuario.");
    if (candidatas.length > 0) return candidatas;
  } catch (e) {
    if (e && e.message === "Cancelado por el usuario.") throw e;
    enviarLog(`API Pinterest falló (${e.message}). Probando SSR...`, "warn");
  }

  if (detenerSolicitado) throw new Error("Cancelado por el usuario.");

  try {
    const candidatas = await fetchPinterestSSR(query);
    if (detenerSolicitado) throw new Error("Cancelado por el usuario.");
    if (candidatas.length > 0) return candidatas;
  } catch (e) {
    if (e && e.message === "Cancelado por el usuario.") throw e;
    enviarLog(`Fallback SSR falló: ${e.message}`, "error");
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
      // Nuevos campos para el heurístico:
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

// ========== DESCARGA con cadena de fallbacks ==========

async function descargarGanadoraConHash(ganadora, escena, carpeta, hash) {
  if (!ganadora || !ganadora.fullChain || ganadora.fullChain.length === 0) {
    throw new Error("Imagen ganadora no disponible.");
  }

  const numeroStr = String(escena.numero).padStart(3, "0");
  const nombreLimpio = `${numeroStr}_${escena.busqueda}`
    .replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 60) || "escena";

  let ultimoError = null;

  for (let i = 0; i < ganadora.fullChain.length; i++) {
    if (detenerSolicitado) throw new Error("Cancelado por el usuario.");

    try {
      await chrome.downloads.download({
        url: ganadora.fullChain[i],
        filename: `${carpeta}/${nombreLimpio}.jpg`,
        conflictAction: "uniquify"
      });
      if (hash) await registrarHash(hash);
      enviarLog(`[Escena ${escena.numero}] ✅ ${nombreLimpio}.jpg`, "info");
      return true;
    } catch (err) {
      ultimoError = err;
      enviarLog(`Variante ${i + 1} falló. Probando siguiente...`, "warn");
    }
  }

  throw ultimoError || new Error("Todas las variantes fallaron.");
}

async function empaquetarEnZip(escenas, carpeta) {
  enviarLog("📦 Empaquetando imágenes en ZIP...", "info");
  try {
    const zip = new JSZip();
    const nombreZip = `${carpeta}.zip`;

    for (const escena of escenas) {
      const numeroStr = String(escena.numero).padStart(3, "0");
      const nombreArchivo = `${numeroStr}_${escena.busqueda}`
        .replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 60);

      const busqueda = await chrome.downloads.search({
        filenameRegex: nombreArchivo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ".*\\.jpg$",
        limit: 5
      });

      if (busqueda.length > 0) {
        const archivo = busqueda[0];
        const url = "file://" + archivo.filename.replace(/\\/g, "/");
        try {
          const resp = await fetch(url);
          const blob = await resp.blob();
          zip.file(`${numeroStr}_${escena.busqueda}.jpg`, blob);
        } catch (e) {
          enviarLog(`No se pudo leer ${nombreArchivo}: ${e.message}`, "warn");
        }
      }
    }

    const blobZip = await zip.generateAsync({ type: "blob" });
    const urlBlob = URL.createObjectURL(blobZip);
    await chrome.downloads.download({
      url: urlBlob,
      filename: nombreZip,
      saveAs: false
    });
    enviarLog(`✅ ZIP generado: ${nombreZip}`, "info");
  } catch (error) {
    enviarLog(`Error generando ZIP: ${error.message}`, "error");
  }
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

function enviarLog(mensaje, nivel = "info") {
  chrome.runtime.sendMessage({ tipo: "log", mensaje, nivel }).catch(() => {});
}

// ============================================================
// MÓDULO HEURÍSTICO DE SELECCIÓN DE IMAGEN
// ============================================================

const STOPWORDS = new Set([
  "a","al","ante","bajo","con","contra","de","del","desde","durante","el","la","las","los",
  "en","entre","hacia","hasta","para","por","segun","sin","sobre","tras","y","o","u","e",
  "un","una","unos","unas","que","como","muy","más","mas",
  "a","an","the","with","from","for","in","on","at","to","of","and","or","by","as","into",
  "near","over","under"]);

const FORMAT_REGEX = /\b(\d{1,2})\s*[:x]\s*(\d{1,2})\b/i;

const SHOT_GROUPS = [
  { id: "closeup", patterns: ["primer plano","primerisimo plano","primerísimo plano","close up","close-up","closeup"] },
  { id: "medium", patterns: ["plano medio","medium shot","medium close up","medium close-up"] },
  { id: "fullbody", patterns: ["cuerpo entero","plano entero","cuerpo completo","full body","full-body","full length","full-length"] },
  { id: "american", patterns: ["plano americano","american shot","cowboy shot"] },
  { id: "wide", patterns: ["plano general","plano abierto","wide shot","long shot","wide angle","wide-angle"] },
  { id: "aerial", patterns: ["vista aerea","vista aérea","plano aereo","plano aéreo","aerial view","drone view","overhead"] },
  { id: "portrait", patterns: ["retrato","portrait"] }
];

const DESCRIPTOR_WORDS = new Set([
  "dramatico","dramática","dramático","epico","épica","épico","triste","tristeza",
  "melancolico","melancólica","melancolico","feliz","alegre","romantico","romántica","romántico",
  "nostalgico","nostálgica","nostálgico","oscuro","oscura","sombrio","sombría","sombrío",
  "misterioso","misteriosa","tenso","tensa","heroico","heroica","cinematografico","cinematográfica",
  "cinematográfico","realista","surrealista","futurista","elegante","poderoso","poderosa",
  "intenso","intensa","emocional","impactante","nocturno","nocturna","atardecer","amanecer",
  "noche","dia","día","lluvia","lluvioso","lluviosa","nieve","nevado","fuego","neon","neón",
  "llamas","humo","niebla"]);

const COLOR_WORDS = new Map([
  ["rojo","red"],["roja","red"],["rojos","red"],["rojas","red"],
  ["azul","blue"],["azules","blue"],
  ["verde","green"],["verdes","green"],
  ["amarillo","yellow"],["amarilla","yellow"],["amarillos","yellow"],["amarillas","yellow"],
  ["naranja","orange"],["naranjas","orange"],
  ["morado","purple"],["morada","purple"],["violeta","purple"],["violetas","purple"],
  ["rosa","pink"],["rosado","pink"],["rosada","pink"],
  ["negro","black"],["negra","black"],["negros","black"],["negras","black"],
  ["blanco","white"],["blanca","white"],["blancos","white"],["blancas","white"],
  ["gris","gray"],["grises","gray"],
  ["dorado","gold"],["dorada","gold"],
  ["plateado","silver"],["plateada","silver"]]);

const KNOWN_ENTITIES = [
  "marvel","dc","disney","pixar","nintendo","pokemon","pokémon","sony","playstation","xbox",
  "warner","warner bros","star wars","harry potter","lord of the rings","game of thrones",
  "the last of us","mario","zelda","fortnite","minecraft","netflix","dreamworks"];

function quitarAcentos(texto) {
  return String(texto ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function normalizarTexto(texto) {
  return quitarAcentos(texto).toLowerCase()
    .replace(/[|_/]+/g, " ")
    .replace(/[^\p{L}\p{N}:x\-\s]/gu, " ")
    .replace(/\s+/g, " ").trim();
}

function normalizarTokens(texto) {
  return normalizarTexto(texto).replace(/-/g, " ").split(/\s+/).filter(Boolean);
}

function compacto(texto) {
  return normalizarTexto(texto).replace(/[^\p{L}\p{N}]/gu, "");
}

function stemPalabra(palabra) {
  let p = quitarAcentos(String(palabra ?? "").toLowerCase());
  if (p.length <= 4) return p;
  if (p.endsWith("es") && p.length > 5) p = p.slice(0, -2);
  else if (p.endsWith("s") && p.length > 4) p = p.slice(0, -1);
  if (p.endsWith("as") || p.endsWith("os")) p = p.slice(0, -2);
  else if (p.endsWith("a") || p.endsWith("o")) p = p.slice(0, -1);
  return p;
}

function contieneTermino(texto, termino) {
  const textoNorm = normalizarTexto(texto);
  const terminoNorm = normalizarTexto(termino);
  if (!textoNorm || !terminoNorm) return false;
  if (textoNorm.includes(terminoNorm)) return true;

  if (terminoNorm.includes(" ") || terminoNorm.includes("-")) {
    const cTexto = compacto(texto);
    const cTermino = compacto(termino);
    if (cTermino.length >= 4 && cTexto.includes(cTermino)) return true;
  }

  const tokensTexto = normalizarTokens(texto);
  const stemTermino = stemPalabra(terminoNorm);
  return tokensTexto.some(token => stemPalabra(token) === stemTermino);
}

function extraerFormato(busqueda) {
  const match = normalizarTexto(busqueda).match(FORMAT_REGEX);
  if (!match) return null;
  const w = Number(match[1]), h = Number(match[2]);
  if (!w || !h) return null;
  return { width: w, height: h, ratio: w / h, texto: `${w}:${h}` };
}

function extraerPlanos(busqueda) {
  const texto = normalizarTexto(busqueda);
  const encontrados = [];
  for (const grupo of SHOT_GROUPS) {
    if (grupo.patterns.some(p => texto.includes(normalizarTexto(p)))) {
      encontrados.push(grupo.id);
    }
  }
  return encontrados;
}

function extraerColores(busqueda) {
  const tokens = normalizarTokens(busqueda);
  const colores = [];
  for (const token of tokens) {
    const color = COLOR_WORDS.get(quitarAcentos(token));
    if (color && !colores.includes(color)) colores.push(color);
  }
  return colores;
}

function extraerDescriptores(busqueda) {
  const tokens = normalizarTokens(busqueda);
  const encontrados = [];
  for (const token of tokens) {
    const limpio = quitarAcentos(token);
    if (DESCRIPTOR_WORDS.has(token) || DESCRIPTOR_WORDS.has(limpio)) {
      if (!encontrados.includes(limpio)) encontrados.push(limpio);
    }
  }
  return encontrados;
}

function extraerAnios(busqueda) {
  return [...new Set(String(busqueda ?? "").match(/\b(?:19|20)\d{2}\b/g) || [])];
}

function extraerEntidadesMayusculas(busqueda) {
  const texto = String(busqueda ?? "");
  const regex = /\b(?:[A-ZÁÉÍÓÚÜÑ][\p{L}\p{N}'’-]*)(?:\s+(?:[A-ZÁÉÍÓÚÜÑ][\p{L}\p{N}'’-]*)){0,4}\b/gu;
  const encontrados = texto.match(regex) || [];
  return encontrados.map(x => x.trim()).filter(x => {
    const n = normalizarTexto(x);
    return n.length >= 2 && !STOPWORDS.has(n);
  });
}

function extraerEntidadesConocidas(busqueda) {
  const texto = normalizarTexto(busqueda);
  const encontrados = [];
  for (const entidad of KNOWN_ENTITIES) {
    if (texto.includes(normalizarTexto(entidad))) encontrados.push(entidad);
  }
  return encontrados;
}

function inferirSujeto(busqueda, entidades) {
  const original = String(busqueda ?? "").trim();
  const primeraParte = original.split(/[,;]+/)[0].trim();
  const primeraNorm = normalizarTexto(primeraParte);

  for (const entidad of entidades) {
    const e = normalizarTexto(entidad);
    if (primeraNorm.startsWith(e) && e.split(/\s+/).length <= 3) return entidad;
  }

  const sinAtributos = primeraParte.replace(/\b(con|wearing|lleva|usando|que lleva)\b.*$/i, "");
  const tokens = normalizarTokens(sinAtributos);
  const resultado = [];
  for (const token of tokens) {
    const limpio = quitarAcentos(token);
    if (STOPWORDS.has(limpio) || DESCRIPTOR_WORDS.has(limpio) || COLOR_WORDS.has(limpio)) break;
    if (/^\d+$/.test(limpio)) break;
    resultado.push(token);
    if (resultado.length >= 3) break;
  }
  return resultado.join(" ");
}

function analizarBusqueda(busqueda) {
  const formato = extraerFormato(busqueda);
  const planos = extraerPlanos(busqueda);
  const colores = extraerColores(busqueda);
  const descriptores = extraerDescriptores(busqueda);
  const anios = extraerAnios(busqueda);

  const entidades = [...extraerEntidadesMayusculas(busqueda), ...extraerEntidadesConocidas(busqueda)];
  const entidadesUnicas = [];
  for (const entidad of entidades) {
    const key = compacto(entidad);
    if (key.length >= 2 && !entidadesUnicas.some(x => compacto(x) === key)) {
      entidadesUnicas.push(entidad);
    }
  }

  const sujeto = inferirSujeto(busqueda, entidadesUnicas);

  const tokens = normalizarTokens(busqueda);
  const reservados = new Set();
  for (const token of normalizarTokens(sujeto)) reservados.add(stemPalabra(token));
  for (const entidad of entidadesUnicas) for (const token of normalizarTokens(entidad)) reservados.add(stemPalabra(token));
  for (const color of colores) for (const palabra of normalizarTokens(color)) reservados.add(stemPalabra(palabra));
  for (const descriptor of descriptores) reservados.add(stemPalabra(descriptor));

  const keywords = [];
  for (const token of tokens) {
    const stem = stemPalabra(token);
    if (token.length < 2) continue;
    if (STOPWORDS.has(stem)) continue;
    if (/^\d+$/.test(token)) continue;
    if (/^\d+$/.test(token.replace(/[:x]/g, ""))) continue;
    if (reservados.has(stem)) continue;
    if (!keywords.includes(stem)) keywords.push(stem);
  }

  return { raw: busqueda, formato, planos, colores, descriptores, anios, sujeto, entidades: entidadesUnicas, keywords };
}

function obtenerCamposTexto(candidata) {
  const metadata = candidata?.metadata || {};
  const richDescription = candidata?.rich_summary?.display_description || metadata?.rich_summary?.display_description || "";

  return [
    { nombre: "title", peso: 1.00, valor: candidata?.title || metadata?.title || "" },
    { nombre: "alt_text", peso: 0.90, valor: candidata?.alt_text || metadata?.alt_text || "" },
    { nombre: "description", peso: 0.75, valor: candidata?.description || metadata?.description || richDescription || "" },
    { nombre: "board", peso: 0.55, valor: candidata?.board_name || metadata?.board_name || "" },
    { nombre: "link", peso: 0.35, valor: candidata?.link || metadata?.link || "" }
  ].filter(c => c.valor).map(c => ({ ...c, normalizado: normalizarTexto(c.valor) }));
}

function obtenerVariantes(candidata) {
  const variantes = [];
  const images = candidata?.images;
  if (images && typeof images === "object") {
    for (const [key, item] of Object.entries(images)) {
      if (!item?.url) continue;
      variantes.push({
        url: item.url,
        width: Number(item.width) || 0,
        height: Number(item.height) || 0,
        key
      });
    }
  }
  if (variantes.length === 0 && Array.isArray(candidata?.fullChain)) {
    for (const item of candidata.fullChain) {
      if (typeof item === "string") variantes.push({ url: item, width: 0, height: 0 });
      else if (item && typeof item === "object") variantes.push({ url: item.url || "", width: Number(item.width) || 0, height: Number(item.height) || 0, key: item.key || "" });
    }
  }
  return variantes;
}

function obtenerVarianteMayor(candidata) {
  const variantes = obtenerVariantes(candidata).filter(v => v.width > 0 && v.height > 0);
  if (variantes.length === 0) return null;
  variantes.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  return variantes[0];
}

function obtenerRatioCandidata(candidata) {
  const variantes = obtenerVariantes(candidata).filter(v => v.width > 0 && v.height > 0);
  if (!variantes.length) return null;
  const ratios = variantes.map(v => v.width / v.height).filter(Number.isFinite).sort((a, b) => a - b);
  if (!ratios.length) return null;
  const mitad = Math.floor(ratios.length / 2);
  if (ratios.length % 2 === 0) return (ratios[mitad - 1] + ratios[mitad]) / 2;
  return ratios[mitad];
}

function clasificarRatio(candidata, formato) {
  if (!formato) return -1;
  const ratio = obtenerRatioCandidata(candidata);
  if (!ratio) return -1;
  const errorRelativo = Math.abs(ratio - formato.ratio) / formato.ratio;
  if (errorRelativo <= 0.025) return 2;
  if (errorRelativo <= 0.075) return 1;
  return 0;
}

function parsearColorHex(color) {
  if (typeof color !== "string") return null;
  let hex = color.trim();
  if (hex.startsWith("#")) hex = hex.slice(1);
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
}

function rgbAHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * (((b - r) / d) + 2);
    else h = 60 * (((r - g) / d) + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

function familiaColorDominante(hex) {
  const rgb = parsearColorHex(hex);
  if (!rgb) return null;
  const { h, s, v } = rgbAHsv(rgb.r, rgb.g, rgb.b);
  if (v < 0.16) return "black";
  if (v > 0.92 && s < 0.12) return "white";
  if (s < 0.12) return "gray";
  if (h < 15 || h >= 345) return "red";
  if (h < 45) return "orange";
  if (h < 70) return "yellow";
  if (h < 170) return "green";
  if (h < 200) return "cyan";
  if (h < 260) return "blue";
  if (h < 300) return "purple";
  return "pink";
}

function puntuarColor(candidata, coloresQuery) {
  if (!coloresQuery.length) return 0;
  const dominante = familiaColorDominante(candidata?.dominant_color);
  if (!dominante) return 0;
  return coloresQuery.includes(dominante) ? 6 : 0;
}

function mejorPesoCampo(campos, termino) {
  let mejor = 0;
  for (const campo of campos) {
    if (contieneTermino(campo.valor, termino)) mejor = Math.max(mejor, campo.peso);
  }
  return mejor;
}

function puntuarPopularidad(candidata) {
  const saves = Number(candidata?.saves) || 0;
  const reactions = Number(candidata?.reactions) || 0;
  const savesScore = Math.min(1, Math.log10(1 + saves) / 5);
  const reactionsScore = Math.min(1, Math.log10(1 + reactions) / 5);
  return savesScore * 5 + reactionsScore * 3;
}

function puntuarPosicion(candidata) {
  const index = Number(candidata?._searchIndex ?? candidata?.searchIndex ?? candidata?.rank);
  if (!Number.isFinite(index) || index < 0) return 0;
  return Math.max(0, 8 - Math.min(index, 7));
}

function puntuarResolucion(candidata) {
  const mejor = obtenerVarianteMayor(candidata);
  if (!mejor) return -5;
  const maxDim = Math.max(mejor.width, mejor.height);
  const minDim = Math.min(mejor.width, mejor.height);
  if (minDim < 512) return -12;
  if (maxDim >= 1600) return 10;
  if (maxDim >= 1200) return 8;
  if (maxDim >= 900) return 6;
  return 3;
}

function puntuarCandidata(busqueda, candidata) {
  const perfil = analizarBusqueda(busqueda);
  const campos = obtenerCamposTexto(candidata);

  let score = 0;

  const categoriaRatio = clasificarRatio(candidata, perfil.formato);
  if (categoriaRatio === 2) score += 100;
  else if (categoriaRatio === 1) score += 40;
  else if (categoriaRatio === 0) score -= 80;

  if (perfil.sujeto) {
    const peso = mejorPesoCampo(campos, perfil.sujeto);
    if (peso > 0) score += 55 * peso;
    else score -= 20;
  }

  const entidadesVistas = new Set();
  for (const entidad of perfil.entidades) {
    const key = compacto(entidad);
    if (entidadesVistas.has(key)) continue;
    entidadesVistas.add(key);
    const peso = mejorPesoCampo(campos, entidad);
    if (peso > 0) score += 24 * peso;
  }

  for (const anio of perfil.anios) {
    const peso = mejorPesoCampo(campos, anio);
    if (peso > 0) score += 18 * peso;
    else score -= 5;
  }

  for (const shotId of perfil.planos) {
    const grupo = SHOT_GROUPS.find(g => g.id === shotId);
    if (!grupo) continue;
    let match = false, mejorPeso = 0;
    for (const pattern of grupo.patterns) {
      const peso = mejorPesoCampo(campos, pattern);
      if (peso > 0) { match = true; mejorPeso = Math.max(mejorPeso, peso); }
    }
    if (match) score += 25 * mejorPeso;
    else score -= 6;
  }

  let keywordScore = 0;
  for (const keyword of perfil.keywords) {
    const peso = mejorPesoCampo(campos, keyword);
    if (peso > 0) keywordScore += 6 * peso;
  }
  score += Math.min(48, keywordScore);

  for (const descriptor of perfil.descriptores) {
    const peso = mejorPesoCampo(campos, descriptor);
    if (peso > 0) score += 4 * peso;
  }

  score += puntuarColor(candidata, perfil.colores);
  score += puntuarResolucion(candidata);
  score += puntuarPopularidad(candidata);
  score += puntuarPosicion(candidata);

  return Math.round(score * 100) / 100;
}

function elegirMejor(busqueda, candidatas) {
  if (!Array.isArray(candidatas) || candidatas.length === 0) return -1;

  const perfil = analizarBusqueda(busqueda);

  let indices = candidatas.map((_, i) => i);

  if (perfil.formato) {
    const exactos = [], cercanos = [];
    for (const i of indices) {
      const categoria = clasificarRatio(candidatas[i], perfil.formato);
      if (categoria === 2) exactos.push(i);
      else if (categoria === 1) cercanos.push(i);
    }
    if (exactos.length > 0) indices = exactos;
    else if (cercanos.length > 0) indices = cercanos;
  }

  let mejorIndice = indices[0];
  let mejorScore = -Infinity;

  for (const i of indices) {
    const candidataConRank = { ...candidatas[i], _searchIndex: i };
    const score = puntuarCandidata(busqueda, candidataConRank);
    if (score > mejorScore) { mejorScore = score; mejorIndice = i; }
  }

  return mejorIndice;
}

async function elegirMejorSinDuplicados(busqueda, candidatas) {
  if (!Array.isArray(candidatas) || candidatas.length === 0) return { indice: -1, hash: null };

  const conScore = candidatas.map((c, i) => ({
    indice: i,
    score: puntuarCandidata(busqueda, { ...c, _searchIndex: i })
  }));
  conScore.sort((a, b) => b.score - a.score);

  for (const { indice } of conScore) {
    if (detenerSolicitado) throw new Error("Cancelado por el usuario.");
    try {
      const hash = await calcularDHash(candidatas[indice].thumb);
      const duplicada = await esDuplicado(hash);
      if (!duplicada) {
        return { indice, hash };
      }
    } catch (e) {
      if (e && e.message === "Cancelado por el usuario.") throw e;
      return { indice, hash: null };
    }
  }

  return { indice: -1, hash: null };
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

const UMBRAL_DUPLICADO = 8;

async function esDuplicado(hash) {
  const { hashesVistos = [] } = await chrome.storage.session.get("hashesVistos");
  for (const prev of hashesVistos) {
    if (hammingDistance(hash, prev) <= UMBRAL_DUPLICADO) return true;
  }
  return false;
}

async function registrarHash(hash) {
  const { hashesVistos = [] } = await chrome.storage.session.get("hashesVistos");
  hashesVistos.push(hash);
  await chrome.storage.session.set({ hashesVistos });
}

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