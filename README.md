# 🖼️ Pinterest Auto-Descargador IA

Extensión de Chrome (Manifest V3) que busca imágenes en Pinterest y usa un **motor heurístico avanzado** (fases + BM25-lite + cobertura de términos) para elegir la mejor coincidencia de cada escena de un guion, descargando solo la imagen ganadora con el nombre de la escena. Se abre como **panel lateral** (side panel) al hacer clic en el icono.

## 🔧 Qué hace

1. Pegas un guion con múltiples escenas en el formato:
   ```
   ESCENA 1
   EL VIAJERO CAMINA POR LA CALLE
   BÚSQUEDA DE IMAGEN: "un hombre caminando en la ciudad"

   ESCENA 2
   ...
   BÚSQUEDA DE IMAGEN: "atardecer en la playa"
   ```
2. Por cada escena, el background pide hasta **25 candidatas** a Pinterest (API + fallback SSR).
3. El panel lateral puntúa cada candidata con el motor heurístico (sujeto, palabras clave, formato/aspect ratio, planos, colores, año, resolución, popularidad, posición) y ordena por puntuación (Fase 1: **TOP 10**).
4. *(Opcional)* Si activas la **verificación visual con IA**, las 10 mejores pasan a una Fase 2 que envía las miniaturas a **FreeLLMAPI** (modelo de visión barato y rápido, p. ej. MiniCPM-V 4.6) para que elija la coincidencia visual real.
5. Se descarga **solo la ganadora** con el nombre `001_<búsqueda>.jpg`, numerada 001, 002, 003…
6. Un **dHash** descarta imágenes duplicadas entre escenas (historial en `chrome.storage.session`, limpiado al cerrar el panel).
7. Un filtro local previo descarta candidatas con señales de **imagen generada por IA** (midjourney, dalle, stable diffusion…).
8. Al terminar, las imágenes de la tanda se empaquetan en un **ZIP**.

## 📁 Carpeta de destino

- Por defecto se guarda en **Descargas/pinterest_descargas/**.
- Con el botón **"📁 Elegir carpeta de destino"** eliges una carpeta cualquiera mediante el File System Access API (`showDirectoryPicker`); el handle se persiste en **IndexedDB** para conservarla entre sesiones.
- El botón **"Restablecer a Descargas"** vuelve al destino por defecto.
- Si al guardar en la carpeta elegida ocurre un error, se hace **fallback automático a Descargas**.

## 📦 Archivos

```
pinterest-auto/
├── manifest.json      # Configuración de la extensión (MV3)
├── sidepanel.html     # Interfaz del panel lateral
├── sidepanel.css      # Estilos dark mode
├── sidepanel.js       # Bucle principal, heurístico y descarga local
├── background.js      # Fetch de Pinterest + heurístico (obtenerCandidatas)
├── jszip.min.js       # Generación del ZIP final
└── icon.png           # Icono 128x128
```

## 🚀 Cómo cargar la extensión en Chrome

1. **Abre Chrome** y ve a `chrome://extensions`.
2. Activa el **"Modo desarrollador"** (interruptor en la esquina superior derecha).
3. Pulsa el botón **"Cargar descomprimida"**.
4. Selecciona la carpeta **`pinterest-auto`** (la que contiene el `manifest.json`).
5. Fija el icono en tu barra de Chrome (clic en la pieza de puzzle → anclar).
6. Haz clic en el icono 🖼️ y se abrirá el **panel lateral** con la aplicación.

## ▶️ Cómo usar

1. **Pega** tu guion en el área de texto grande.
2. (Opcional) Pulsa **📁 Elegir carpeta de destino** para fijar una carpeta propia.
3. Pulsa **🚀 COMENZAR**.
4. Observa el progreso en el log en vivo. Puedes pulsar **⏹ Cancelar** en cualquier momento.

## 🧪 Consejos

- Asegúrate de estar **con sesión iniciada en Pinterest** para mejores resultados.
- Si una escena falla (sin candidatas), se registra el error y **continúa con la siguiente**.
- La extensión espera **1,5 s** entre escenas para no saturar el sistema.
- Las imágenes duplicadas entre escenas se saltan automáticamente.

## 🧠 Verificación Visual con IA (FreeLLMAPI — opcional)

La extensión usa una **arquitectura de 2 fases**: primero el heurístico ordena las candidatas y devuelve las 10 mejores; si activas la IA, un modelo de visión (multi-modal, barato y rápido) revisa las 10 miniaturas y confirma cuál encaja de verdad con la descripción (ideal para casos donde el texto menciona algo visual específico, p. ej. "Tío Ben" frente a "Ned"). Si la IA falla, se usa el resultado heurístico.

### Instalación de FreeLLMAPI

1. **Descarga e instala FreeLLMAPI** desde su repositorio oficial.
2. **Configura las API keys** de los proveedores que quieras usar (Google AI Studio, ModelScope, etc.).
3. **Prioriza el modelo MiniCPM-V 4.6** en la cadena de ruteo (o cualquier modelo multimodal de bajo costo).
4. **Arranca el servidor** en `http://localhost:3001`.

### Configuración en la extensión

1. Abre la sección **"🧠 Verificación Visual con IA"** en el panel lateral.
2. Pega la **URL** (`http://localhost:3001/v1`), la **key** (si FreeLLMAPI la requiere) y el **modelo** (`minicpm-v-4.6`).
3. Pulsa **"Probar conexión"**; verás la lista de modelos disponibles y podrás elegir uno del desplegable.
4. Activa el checkbox **"Usar verificación visual"**.
5. Procesa el guion normalmente.

### Seguridad

- Si no confías en FreeLLMAPI, deja el checkbox desactivado: la extensión funcionará **solo con el heurístico**.
- Las imágenes se envían al endpoint configurado, así que debe ser un **endpoint propio o de confianza**.
- El filtro de imágenes IA es heurístico (por texto). Para detección robusta necesitarías metadatos **C2PA** o una API dedicada (Sightengine, Hive); esta heurística cubre ~60-70 % de los casos.

## ✅ Requisitos

- Chrome / Chromium (funciona con Edge, Brave, Opera, etc.).
- Permisos declarados en el manifest: `downloads`, `storage`, `sidePanel`, `unlimitedStorage`, `http://localhost/*`, `http://127.0.0.1/*` (para FreeLLMAPI local).
- **No** usa frameworks ni librerías externas: todo es JavaScript nativo con las APIs de Chrome (JSZip solo para el empaquetado final).
- *(Opcional)* **FreeLLMAPI** corriendo en local si quieres la verificación visual.