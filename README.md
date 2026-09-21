# 🖼️ Pinterest Auto-Descargador IA

Extensión de Chrome (Manifest V3) que busca imágenes en Pinterest y usa **Gemini 2.0 Flash** para elegir la mejor coincidencia de cada escena de un guion, descargando solo la imagen ganadora con el nombre de la escena. Se abre como **panel lateral** (side panel) al hacer clic en el icono.

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
2. La extensión abre una búsqueda en Pinterest por cada escena y espera dinámicamente (MutationObserver, timeout 15 s) a que carguen las imágenes.
3. Extrae las **primeras 8 imágenes candidatas** (ancho mínimo 512 px). Si en 15 s no hay al menos 4, la escena falla y se continúa.
4. Envía las miniaturas a **Gemini 2.0 Flash**, que elige el índice que mejor coincide con la búsqueda.
5. Descarga **solo la ganadora** en la carpeta indicada, con el nombre `Escena_N_<búsqueda>.jpg`.

## 📦 Archivos

```
pinterest-auto/
├── manifest.json      # Configuración de la extensión (MV3)
├── sidepanel.html     # Interfaz del panel lateral (ancho fluido)
├── sidepanel.css      # Estilos dark mode
├── sidepanel.js       # Lógica del panel (parseo + comunicación)
├── background.js      # El cerebro: pestañas, Gemini y descargas
├── content.js         # Extracción de imágenes dentro de Pinterest
└── icon.png           # Icono 128x128
```

## 🚀 Cómo cargar la extensión en Chrome

1. **Abre Chrome** y ve a `chrome://extensions`.
2. Activa el **"Modo desarrollador"** (interruptor en la esquina superior derecha).
3. Pulsa el botón **"Cargar descomprimida"**.
4. Selecciona la carpeta **`pinterest-auto`** (la que contiene el `manifest.json`).
5. Debería aparecer **"Pinterest Auto-Descargador IA"** en la lista.
6. Fija el icono en tu barra de Chrome (clic en la pieza de puzzle → anclar).
7. Haz clic en el icono 🖼️ y se abrirá el **panel lateral** con la aplicación.

## ▶️ Cómo usar

1. **Pega** tu guion en el área de texto grande.
2. Introduce tu **API Key de Gemini** (se guarda en el almacenamiento local de la extensión y no se vuelve a pedir).
3. Escribe el **nombre de la carpeta destino** (se crea en tu carpeta de descargas).
4. Pulsa **🚀 COMENZAR**.
5. Observa el progreso en el log en vivo. Puedes pulsar **⏹ Detener** en cualquier momento.
6. Las descargas empiezan en `Descargas/<carpeta>/Escena_N_<búsqueda>.jpg`.

## 🧪 Consejos

- Asegúrate de estar **con sesión iniciada en Pinterest** para mejores resultados.
- Si una escena falla (sin candidatas o error de Gemini), se registra el error y **continúa con la siguiente**.
- La espera de imágenes usa un **MutationObserver** con timeout de **15 s**; si no hay al menos 4 candidatas, la escena se omite.
- La extensión espera **1,5 s** entre escenas para no saturar el sistema.

## ✅ Requisitos

- Chrome / Chromium (funciona con Edge, Brave, Opera, etc.).
- Una API Key gratuita de [Google AI Studio](https://aistudio.google.com/apikey).
- **No** usa frameworks ni librerías externas: todo es JavaScript nativo con las APIs de Chrome.