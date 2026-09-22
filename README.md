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
3. El panel lateral puntúa cada candidata con el motor heurístico (sujeto, palabras clave, formato/aspect ratio, planos, colores, año, resolución, popularidad, posición) y ordena por puntuación.
4. Se descarga **solo la ganadora** con el nombre `001_<búsqueda>.jpg`, numerada 001, 002, 003…
5. Un **dHash** descarta imágenes duplicadas entre escenas (historial en `chrome.storage.session`, limpiado al cerrar el panel).
6. Al terminar, las imágenes de la tanda se empaquetan en un **ZIP**.

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

## ✅ Requisitos

- Chrome / Chromium (funciona con Edge, Brave, Opera, etc.).
- Permisos declarados en el manifest: `downloads`, `storage`, `sidePanel`, `unlimitedStorage`.
- **No** usa frameworks ni librerías externas: todo es JavaScript nativo con las APIs de Chrome (JSZip solo para el empaquetado final).