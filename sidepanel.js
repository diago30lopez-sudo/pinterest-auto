// Lógica del panel lateral: parseo del guion y comunicación con el background.

// Elementos del DOM
const guionTextarea = document.getElementById("guion");
const carpetaInput = document.getElementById("carpeta");
const btnIniciar = document.getElementById("btnIniciar");
const btnDetener = document.getElementById("btnDetener");
const logDiv = document.getElementById("log");
const progresoDiv = document.getElementById("progreso");
const barraRelleno = document.getElementById("barraRelleno");
const textoProgreso = document.getElementById("textoProgreso");

// Estado de la ejecución
let ejecutando = false;

// Regex para parsear el guion: captura nº de escena y búsqueda entre comillas
// Acepta comillas rectas (") o curvas (\u201C \u201D) para mayor robustez.
const REGEX_GUION = /ESCENA\s*#?(\d+).*?BÚSQUEDA\s+DE\s+IMAGEN.*?:\s*["\u201C\u201D]*\s*(.+?)\s*["\u201C\u201D]/gis;

// Agrega una línea de texto al cuadro de log con autoscroll
function agregarLog(mensaje, tipo = "info") {
  const linea = document.createElement("div");
  linea.className = tipo;
  linea.textContent = `[${new Date().toLocaleTimeString()}] ${mensaje}`;
  logDiv.appendChild(linea);
  logDiv.scrollTop = logDiv.scrollHeight; // autoscroll
}

// Actualiza la barra de progreso con el número de escena actual
function actualizarProgreso(actual, total) {
  progresoDiv.classList.add("visible");
  textoProgreso.textContent = `Escena ${actual}/${total}`;
  const porcentaje = total > 0 ? (actual / total) * 100 : 0;
  barraRelleno.style.width = porcentaje + "%";
}

// Al pulsar COMENZAR se valida el guion y se envían las escenas al background
btnIniciar.addEventListener("click", async () => {
  const guion = guionTextarea.value.trim();
  const carpeta = carpetaInput.value.trim() || "pinterest_descargas";

  // Validación mínima antes de arrancar
  if (!guion) {
    agregarLog("El guion está vacío.", "error");
    return;
  }

  // Parsea el guion extrayendo todas las escenas
  const escenas = [];
  let coincidencia;
  while ((coincidencia = REGEX_GUION.exec(guion)) !== null) {
    escenas.push({
      numero: parseInt(coincidencia[1], 10),
      busqueda: coincidencia[2],
    });
  }

  if (escenas.length === 0) {
    agregarLog("No se encontraron escenas. Revisa el formato del guion.", "error");
    return;
  }

  agregarLog(`Guion parseado: ${escenas.length} escena(s).`, "info");
  actualizarProgreso(0, escenas.length);

  ejecutando = true;
  btnIniciar.disabled = true;
  btnDetener.hidden = false;
  logDiv.innerHTML = ""; // limpia logs anteriores
  actualizarProgreso(0, escenas.length);

  try {
    // Envía la tarea al service worker del background
    await chrome.runtime.sendMessage({ tipo: "iniciar", escenas, carpeta });
  } catch (error) {
    agregarLog("Error al iniciar el proceso: " + error.message, "error");
    estadoDetenido();
  }
});

// Al pulsar DETENER se avisa al background para cortar el bucle
btnDetener.addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ tipo: "detener" });
  } catch (error) {
    console.error("Error enviando señal de detención:", error);
  }
});

// Escucha los mensajes que envía el background para actualizar la interfaz en vivo
chrome.runtime.onMessage.addListener((mensaje) => {
  if (!mensaje || typeof mensaje !== "object") return;

  switch (mensaje.tipo) {
    case "log":
      agregarLog(mensaje.mensaje, mensaje.nivel || "info");
      break;
    case "progreso":
      actualizarProgreso(mensaje.actual, mensaje.total);
      break;
    case "fin":
      agregarLog("==============================", "info");
      agregarLog("PROCESO TERMINADO.", "info");
      estadoDetenido();
      break;
    case "detenido":
      agregarLog("PROCESO DETENIDO por el usuario.", "warn");
      estadoDetenido();
      break;
  }
});

// Restaura la interfaz al estado inicial tras terminar/detener
function estadoDetenido() {
  ejecutando = false;
  btnIniciar.disabled = false;
  btnDetener.hidden = true;
}

// Conexión persistente con el background para detectar cierre del panel
const puerto = chrome.runtime.connect({ name: "sidepanel" });
puerto.onDisconnect.addListener(() => {
  console.log("Panel lateral cerrado.");
});