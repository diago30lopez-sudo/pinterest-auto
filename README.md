# 🖼️ Pinterest Auto-Descargador IA

Extensión de Chrome que busca imágenes en Pinterest para escenas de video, aplica filtros avanzados y las descarga renombradas automáticamente.

## 🚀 Instalación

1. Descarga el repositorio como ZIP o clónalo con `git clone`.
2. Abre `chrome://extensions` en Chrome.
3. Activa "Modo de desarrollador" (arriba a la derecha).
4. Pulsa "Cargar descomprimida".
5. Selecciona la carpeta del proyecto.

## ⚙️ Uso

1. Abre el panel lateral de la extensión (icono en la barra).
2. Pega tu guion de escenas en el área de texto.
3. Elige carpeta de destino.
4. Pulsa **COMENZAR**.
5. Al terminar, aparece un modal con el resumen. Las imágenes quedan en la carpeta elegida + un ZIP.

## 📝 Formato del guion

```
ESCENA #1
VOZ EN OFF: "..."
DURACIÓN ESTIMADA: X segundos
BÚSQUEDA DE IMAGEN (Google/Pinterest): "texto de búsqueda, 16:9"
```

La extensión detecta automáticamente `ESCENA #N` y `BÚSQUEDA DE IMAGEN: "..."`.

## 🧠 Cómo funciona

Por cada escena:

1. **Triple búsqueda en Pinterest** por escena (3 queries) con `16:9` al final, fusionadas y deduplicadas por URL:
   - `[búsqueda] movie still 16:9`
   - `[búsqueda] film frame cinematic scene 16:9`
   - `[búsqueda] live action production still 16:9`
2. **Limpieza de la query** antes de buscar: se quitan palabras que atraen material de IA (`concepto`, `key art`, `character poster`, `fan art`, `arte digital`, `épica`, `AI`, `midjourney`, `4K`…) respetando acentos y sin comerse palabras que las contengan (`Loki` intacto, `casa` intacto).
3. **Filtros locales en cascada**:
   - URL de generador de IA (midjourney, dalle, etc.)
   - URL sospechosa (youtube.com, imdb.com, etc.)
   - Blacklist de boards/dominios de IA
   - Metadatos con señales IA
   - Metadatos de póster
   - Aspect ratio (0.65 - 2.4)
4. **Heurístico avanzado** elige TOP 10 candidatas.
5. **Anti-duplicados multi-hash**: pHash + aHash + dHash + URL + pin_id + título.
6. **Validación visual en 4 señales, en este orden** (Canvas puro; Tesseract va el último a propósito, porque cuesta 1-2 s por imagen):
   1. `detectGraphicText` — estructura tipográfica: mide la forma del texto (bandas de bordes verticales/horizontales, contraste por bandas, cobertura y peakedness). Caza títulos con glow, logos y tipografías de película donde Tesseract no llega.
   2. `detectPosterLayout` — composición: aspecto vertical + densidad de "créditos" en la franja inferior + concentración en el tercio superior.
   3. `tieneTextoEnImagen` — Tesseract, **solo si la imagen pasó las dos anteriores y la Fase 1 detectó zonas de texto**.
   4. `detectAILikeSignals` — piel plástica (bloques de rango de grises muy estrecho pero no planos) + fondo de estudio (las 4 esquinas del mismo color).
7. **Zonas dudosas**: entre el umbral de duda y el de rechazo, la imagen **no se descarga**. Va a `Revisar sospechosas` con el detalle de qué señal la marcó.
8. **Cascada de emergencia**: si nada pasa los filtros, se usa la mejor heurística (y también va a revisión manual).

### Umbrales de detección

| Señal | Dudosa | Rechazo |
| ----- | ------ | ------- |
| Texto visual (bandas de bordes) | ≥ 0.55 | ≥ 0.80 |
| Composición de póster | ≥ 0.55 | ≥ 0.78 |
| OCR (Tesseract) | ≥ 20 | ≥ 40 |
| IA-like (piel plástica) | ≥ 0.50 | ≥ 0.72 |

Viven en `RULES` (`sidepanel.js`) y el panel "🔬 Umbrales de detección" los refleja desde ahí, así que no hay números escritos a mano en dos sitios. En el caso de IA-like, `cornerUniformity` es 0/1: para llegar a 0.72 hacen falta las dos señales a la vez, nunca una sola.

## 📦 Versiones

### v1.0.0 — Versión base

- Búsqueda en Pinterest vía endpoint interno (`BaseSearchResource/get/`).
- Algoritmo heurístico con análisis de sujeto, franquicia, plano, colores, popularidad.
- Anti-duplicados por dHash + aHash + ColorHash.
- Selección de carpeta con File System Access API.
- Numeración de archivos (`001_...jpg`, `002_...jpg`).
- Botón Cancelar.
- ZIP final con todas las imágenes.
- **Sin filtros de IA ni OCR**: los resultados dependían solo del heurístico.

### v1.1.0 — Filtros reforzados + Revisión manual

- **Filtros anti-póster / anti-IA / anti-texto** ampliados en metadatos y URL.
- **Filtro de aspect ratio** estricto (< 0.65 o > 2.4 rechazados).
- **Sistema de revisión manual** con botón naranja y contador.
- **Vista de 4 variantes** por escena dudosa con botones refrescar/saltar.
- **Lote de escenas para revisión** máximo 10 (configurable).
- **Búsquedas degradadas** automáticas si Pinterest devuelve 0 candidatas.
- **Input de archivo `.txt` / `.md`** para cargar guiones.
- **Modal de completado** al terminar el proceso.

### v1.2.0 — OCR ultra robusto + Eliminación de IA visual

- **Eliminada la integración con FreeLLMAPI** (daba 429/503 constantes y activaba cooldowns de 60s).
- **OCR en 2 fases**:
  - Fase 1: detección visual barata de zonas con texto (`detectarRegionesSospechosas`).
  - Fase 2: Tesseract OCR con escala adaptativa (3.0x / 2.0x / 1.5x / 1.0x según tamaño).
- **Dos versiones de preprocesamiento**: gris-contraste + binarizada con umbral adaptativo.
- **Doble PSM**: PSM 11 (sparse) sobre gris-contraste, PSM 6 (block) sobre binarizada si confianza baja.
- **Scoring ponderado** (no binario) con reglas acumulativas:
  - Palabras prohibidas exactas: +100
  - Palabras prohibidas contenidas: +60
  - Años (1900-2099): +40
  - Mayúsculas de 4+ letras (sobre texto original): +25
  - Bounding box > 30% del ancho: +25
  - 3+ palabras alineadas horizontalmente: +20
  - \>15 palabras detectadas: +50
  - **Umbral de rechazo: score ≥ 100**
- **Anti-duplicados mejorado**: historial total (no solo las últimas 8).
- **Comparación por pin_id y URL exacta** además de hashes.
- **Blacklist de boards/dominios** de IA en `blacklist_ia.json`.
- **Fix mayúsculas**: verificar sobre texto original (evita falsos positivos como `Hello` → `HELLO`).
- **Sin dependencias de APIs externas de IA**: solo Tesseract (local).
- **Sin cooldowns ni rate limits**: proceso ~2x más rápido que v1.1.0.

### v1.3.0 — Detección de texto/póster en Canvas + triple búsqueda

- **4 detectores estructurales** que no leen letras, miden la forma (`detectGraphicText`, `detectPosterLayout`, `detectAILikeSignals`, `detectarRegionesSospechosas`).
- **Orden deliberado**: texto → póster → Tesseract → IA-like. Tesseract (~1-2 s) solo se lanza si la imagen pasa las dos señales baratas y hay zonas de texto en la Fase 1.
- **Un único bitmap por candidata** (`obtenerBitmap`): los tres detectores comparten la imagen descargada en lugar de pedirla cada uno.
- **`detectGraphicText` recalibrado**: el umbral por percentil absoluto (p82) marcaba como texto un degradado liso, porque garantiza que ~18% de los píxeles supere el umbral. Ahora los umbrales de borde son relativos a la mediana y al p95 de cada imagen, más una penalización por textura uniforme y una comprobación de localización (mediana de las 3 bandas), de modo que un título grande y localizado sube a ~0.89-0.94 y un degradado se queda en ~0.01.
- **OCR con umbral 40 en vez de 100**, con zona dudosa desde 20 (antes cualquier cosa por debajo de 100 pasaba sin avisar).
- **Zonas dudosas** por señal: la imagen no se descarga y pasa a `Revisar sospechosas` con el motivo.
- **Triple búsqueda** por escena con `movie still` / `film frame cinematic scene` / `live action production still`, fusionada con `Promise.all` y deduplicada por URL.
- **Limpieza de query** con lista de palabras de IA, `quitarPalabra` con límites Unicode (`\p{L}`/`\p{N}`, sensible a acentos) y connector cleanup para no dejar comas ni conectores colgando.
- **Panel "🔬 Umbrales de detección"** en `sidepanel.html`, alimentado desde `RULES`.

## 🛠️ Requisitos técnicos

- Google Chrome (o Edge/Brave basado en Chromium).
- Nada más. Tesseract.js viene incluido en el proyecto.
- No requiere Node.js, Python ni servidores externos.

## 📊 Rendimiento

- **Tiempo por escena**: 8-15 segundos.
- **Procesamiento de 276 escenas**: ~1h 30min.
- **Detección de texto (OCR)**: ~85-90 % de imágenes con texto visible.
- **Falsos positivos**: ajustables según el umbral de scoring.

## ⚠️ Limitaciones conocidas

- **Texto muy estilizado** con glow/gótico puede no ser detectado.
- **Texto pequeño** (< 10px de altura) puede no ser detectado.
- **Texto rotado** más de 15° puede fallar.
- **Pinterest puede cambiar el endpoint interno** sin aviso (hay fallback SSR).
- No se pueden descargar vídeos, solo imágenes.

## 📄 Licencia

Uso personal. Consulta los Términos de Servicio de Pinterest antes de redistribuir.

## 🐛 Reportar bugs

Abre un issue en el repositorio con:

- Log completo de la consola del service worker.
- Captura del error.
- Versión de Chrome.