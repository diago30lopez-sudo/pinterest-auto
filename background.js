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