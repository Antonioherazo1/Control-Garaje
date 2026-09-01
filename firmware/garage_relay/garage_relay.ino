/*
 * GarageControl - Firmware ESP8266
 * Control de 2 portones con modulo de rele via MQTT.
 *
 * HISTORIAL DE VERSIONES
 * ─────────────────────────────────────────────────────────────
 * v0.1  16/08/2026 15:00  Versión inicial
 * v0.2  16/08/2026 21:00  Simplificación de canales (2 rele)
 * v0.3  17/08/2026 08:00  Pulso corto 400ms
 * v2.0  17/08/2026 12:00  Estabilidad WiFi/MQTT no-bloqueante
 * v2.1  17/08/2026 14:00  Fix underflow pulsos de rele
 * v2.2  01/09/2026        WiFi persistente + reset por comando
 *
 * v3.0  01/09/2026        Multi-WiFi + clave en EEPROM
 *   - Soporta HASTA 5 redes WiFi guardadas en la flash (EEPROM).
 *   - El ESP se conecta a la primera red disponible de la lista.
 *   - La clave MQTT se almacena en EEPROM, NO hardcodeada en el codigo.
 *   - Portal web de configuracion en el ESP: sin redes, abre AP
 *     "GarageControl" con pagina en http://192.168.4.1 para guardar la
 *     primera red. Con red, misma pagina en la IP local del ESP.
 *   - Comandos MQTT para gestionar la config:
 *       "garaje/setup/cmd" -> "mqtt:<user>:<pass>"  (ajusta credenciales MQTT)
 *                             "wifi:<ssid>:<pass>"  (agrega/actualiza una red)
 *                             "obs"                 (imprime toda la config serial)
 *       "garaje/wifi/cmd"   -> "reset"  (borra TODAS las redes)
 *                              "forget:<ssid>"  (borra una red puntual)
 *   - Boton FLASH (GPIO0) al encender: borra config y abre portal AP.
 * ─────────────────────────────────────────────────────────────
 *
 * Conexion:
 *   CH1 = D1 (GPIO5)  -> Porton 1 (Abatible)
 *   CH2 = D5 (GPIO14) -> Porton 2 (Reja Corrediza)
 *   D6  (GPIO12)      -> salida de prueba
 *
 * Almacenamiento en EEPROM (flash), layout:
 *   0x00  magic[2]  ("GW")
 *   0x02  mqttUser[32] + NULL
 *   0x22  mqttPass[32] + NULL
 *   0x42  redCount (1 byte)
 *   0x43  redes: Max 5 * bloque de 96 bytes =
 *          [ssid[32]+NULL][pass[32]+NULL][guardado byte]
 *   (total maximo ~527 bytes, dentro de los 4096 típicos)
 *
 * Librerias (Arduino IDE):
 *   - ESP8266 Boards (nucleo 2.7+)
 *   - PubSubClient by Nick O'Leary (2.8+)
 *   - ESP8266WebServer (incluida con el nucleo)
 *
 * Portal web de configuracion:
 *   Sin redes guardadas, el ESP abre un punto de acceso "GarageControl"
 *   (clave 12345678). Conectate a el y abre http://192.168.4.1 : verás
 *   un formularlo para guardar tu PRIMERA red WiFi.
 *   Con red guardada, la misma pagina esta disponible en la IP local del ESP
 *   para administrar redes sin necesitar MQTT.
 *
 * LED onboard (D4):
 *   2 parpadeos = WiFi conectado
 *   3 parpadeos = MQTT conectado
 *   1 parpadeo  = salida activada
 */

#include <ESP8266WiFi.h>
#include <DNSServer.h>
#include <ESP8266WebServer.h>
#include <EEPROM.h>
#include <PubSubClient.h>

/* =================== CONFIG =================== */

const char* MQTT_HOST = "garaje.thinc.site";
const uint16_t MQTT_PORT = 8883;
const char* MQTT_PREFIX = "garaje";

#define USE_TLS 1
#define DEVICE_NAME "esp8266-garaje"
#define AP_NAME     "GarageControl"
#define AP_PASS     "12345678"

const uint8_t RELAY_PINS[2] = { 5, 14 }; // D1, D5
const uint8_t TEST_PIN = 12;              // D6
const uint8_t RELAY_ACTIVE = LOW;

const unsigned long PULSE_MS = 400;
const unsigned long TEST_PULSE_MS = 400;
const unsigned long MIN_GAP_MS = 500;
const unsigned long STATUS_INTERVAL_MS = 30000;
const unsigned long WIFI_RESTART_MS = 120000;

// Credenciales por defecto (solo la primera vez; luego se leen de EEPROM).
// La clave MQTT real se configura via EEPROM/portal; no se incluye en el codigo.
const char* DFLT_MQTT_USER = "esp8266";
const char* DFLT_MQTT_PASS = "";
const char* DFLT_SSID = "";
const char* DFLT_PASS = "";

// Multi-red
#define MAX_NETWORKS 5
#define SSID_LEN  32
#define PASS_LEN  32
#define MQTT_USER_LEN 32
#define MQTT_PASS_LEN 32

// EEPROM offsets
#define EEPROM_SIZE 1024
#define MAGIC_OFFSET      0
#define MQTT_USER_OFFSET  2
#define MQTT_PASS_OFFSET  34
#define NET_COUNT_OFFSET  66
#define NETWORKS_OFFSET   67
#define NET_BLOCK_SIZE    96

/* ============================================== */

#if USE_TLS
#include <WiFiClientSecure.h>
WiFiClientSecure net;
#else
WiFiClient net;
#endif
PubSubClient mqtt(net);

// Servidor web de configuracion (portal AP / pagina local)
ESP8266WebServer webServer(80);
DNSServer dnsServer;
bool apActive = false;

// --- Config en RAM ---
char mqttUser[MQTT_USER_LEN] = "";
char mqttPass[MQTT_PASS_LEN] = "";
struct Net { char ssid[SSID_LEN]; char pass[PASS_LEN]; bool set; };
Net networks[MAX_NETWORKS];
uint8_t netCount = 0;

// --- Pulsos ---
unsigned long pulseEnd[2] = { 0, 0 };
bool pulsing[2] = { false, false };
unsigned long testPulseEnd = 0;
bool testPulsing = false;
unsigned long lastPulseAt = 0;
unsigned long lastStatusAt = 0;

// --- WiFi reconexion ---
unsigned long wifiLostAt = 0;
unsigned long lastWifiRetry = 0;
bool forceApAfterTimeout = false;
uint8_t wifiScanIdx = 0;
bool scanningNetworks = false;

// --- MQTT reconexion ---
unsigned long lastMqttAttempt = 0;
unsigned long mqttBackoffMs = 0;

// --- LED no bloqueante ---
int ledTarget = 0;
int ledDone = 0;
bool ledOn = false;
unsigned long ledToggleAt = 0;
int ledOnMs = 150;
int ledOffMs = 150;

/* =================== EEPROM =================== */

void eepromWriteStr(int offset, const char* s, int maxLen) {
  int i = 0;
  while (s[i] && i < maxLen - 1) { EEPROM.write(offset + i, s[i]); i++; }
  EEPROM.write(offset + i, 0);
}

void eepromReadStr(int offset, char* out, int maxLen) {
  for (int i = 0; i < maxLen; i++) {
    char c = EEPROM.read(offset + i);
    if (c == 0) { out[i] = 0; return; }
    out[i] = c;
  }
  out[maxLen - 1] = 0;
}

void loadConfig() {
  // Verificar magic
  if (EEPROM.read(MAGIC_OFFSET) == 'G' && EEPROM.read(MAGIC_OFFSET + 1) == 'W') {
    eepromReadStr(MQTT_USER_OFFSET, mqttUser, MQTT_USER_LEN);
    eepromReadStr(MQTT_PASS_OFFSET, mqttPass, MQTT_PASS_LEN);
    netCount = EEPROM.read(NET_COUNT_OFFSET);
    if (netCount > MAX_NETWORKS) netCount = 0;
    for (int i = 0; i < MAX_NETWORKS; i++) networks[i].set = false;
    for (int i = 0; i < netCount; i++) {
      int o = NETWORKS_OFFSET + i * NET_BLOCK_SIZE;
      eepromReadStr(o, networks[i].ssid, SSID_LEN);
      eepromReadStr(o + SSID_LEN, networks[i].pass, PASS_LEN);
      networks[i].set = EEPROM.read(o + SSID_LEN + PASS_LEN) == 1;
    }
    if (mqttUser[0] == 0) strncpy(mqttUser, DFLT_MQTT_USER, MQTT_USER_LEN - 1);
    if (mqttPass[0] == 0) strncpy(mqttPass, DFLT_MQTT_PASS, MQTT_PASS_LEN - 1);
  } else {
    // Primera vez: usar defaults
    strncpy(mqttUser, DFLT_MQTT_USER, MQTT_USER_LEN - 1);
    strncpy(mqttPass, DFLT_MQTT_PASS, MQTT_PASS_LEN - 1);
    netCount = 0;
    for (int i = 0; i < MAX_NETWORKS; i++) networks[i].set = false;
    // Guardar magic + credenciales default
    EEPROM.write(MAGIC_OFFSET, 'G');
    EEPROM.write(MAGIC_OFFSET + 1, 'W');
    eepromWriteStr(MQTT_USER_OFFSET, mqttUser, MQTT_USER_LEN);
    eepromWriteStr(MQTT_PASS_OFFSET, mqttPass, MQTT_PASS_LEN);
    saveNetworksToEeprom();
    EEPROM.commit();
  }
}

void saveNetworksToEeprom() {
  EEPROM.write(NET_COUNT_OFFSET, netCount);
  for (int i = 0; i < MAX_NETWORKS; i++) {
    int o = NETWORKS_OFFSET + i * NET_BLOCK_SIZE;
    if (networks[i].set) {
      eepromWriteStr(o, networks[i].ssid, SSID_LEN);
      eepromWriteStr(o + SSID_LEN, networks[i].pass, PASS_LEN);
      EEPROM.write(o + SSID_LEN + PASS_LEN, 1);
    } else {
      EEPROM.write(o, 0);
      EEPROM.write(o + SSID_LEN, 0);
      EEPROM.write(o + SSID_LEN + PASS_LEN, 0);
    }
  }
  EEPROM.commit();
}

void saveMqttToEeprom() {
  eepromWriteStr(MQTT_USER_OFFSET, mqttUser, MQTT_USER_LEN);
  eepromWriteStr(MQTT_PASS_OFFSET, mqttPass, MQTT_PASS_LEN);
  EEPROM.commit();
}

// Agrega o actualiza una red. Devuelve true si cambio algo.
bool addNetwork(const char* ssid, const char* pass) {
  if (strlen(ssid) == 0) return false;
  for (int i = 0; i < netCount; i++) {
    if (strcmp(networks[i].ssid, ssid) == 0) {
      // Actualizar clave existente
      strncpy(networks[i].pass, pass, PASS_LEN - 1);
      networks[i].pass[PASS_LEN - 1] = 0;
      networks[i].set = true;
      saveNetworksToEeprom();
      return true;
    }
  }
  if (netCount < MAX_NETWORKS) {
    Net* n = &networks[netCount];
    strncpy(n->ssid, ssid, SSID_LEN - 1);
    n->ssid[SSID_LEN - 1] = 0;
    strncpy(n->pass, pass, PASS_LEN - 1);
    n->pass[PASS_LEN - 1] = 0;
    n->set = true;
    netCount++;
    saveNetworksToEeprom();
    return true;
  }
  return false; // lista llena
}

void forgetNetwork(const char* ssid) {
  for (int i = 0; i < netCount; i++) {
    if (strcmp(networks[i].ssid, ssid) == 0) {
      for (int j = i; j < netCount - 1; j++) networks[j] = networks[j + 1];
      netCount--;
      networks[netCount].set = false;
      networks[netCount].ssid[0] = 0;
      networks[netCount].pass[0] = 0;
      saveNetworksToEeprom();
      return;
    }
  }
}

void clearAllNetworks() {
  netCount = 0;
  for (int i = 0; i < MAX_NETWORKS; i++) {
    networks[i].set = false;
    networks[i].ssid[0] = 0;
    networks[i].pass[0] = 0;
  }
  saveNetworksToEeprom();
}

/* =================== LED =================== */

void ledBlinkStart(int n, int ms) {
  ledTarget = n;
  ledDone = 0;
  ledOnMs = ms;
  ledOffMs = ms;
  ledOn = false;
  ledToggleAt = millis();
}

void ledLoop() {
  if (ledDone >= ledTarget) return;
  if ((long)(millis() - ledToggleAt) < 0) return;
  if (!ledOn) {
    digitalWrite(2, LOW);
    ledOn = true;
    ledToggleAt = millis() + ledOnMs;
  } else {
    digitalWrite(2, HIGH);
    ledOn = false;
    ledDone++;
    if (ledDone < ledTarget) ledToggleAt = millis() + ledOffMs;
  }
}

/* =================== Reles =================== */

void setRelay(uint8_t idx, bool on) {
  digitalWrite(RELAY_PINS[idx], on ? RELAY_ACTIVE : !RELAY_ACTIVE);
}

bool startPulse(uint8_t idx) {
  if ((unsigned long)(millis() - lastPulseAt) < MIN_GAP_MS) return false;
  pulseEnd[idx] = millis() + PULSE_MS;
  pulsing[idx] = true;
  lastPulseAt = millis();
  setRelay(idx, true);
  Serial.printf("[relay] pulso canal %u\n", idx);
  ledBlinkStart(1, 150);
  return true;
}

void handleDoorCmd(uint8_t door, String action) {
  uint8_t idx;
  if (door == 1) idx = 0;
  else if (door == 2) idx = 1;
  else return;
  Serial.printf("[cmd] porton %u -> %s\n", door, action.c_str());
  startPulse(idx);
}

void handleTestCmd() {
  Serial.println("[test] pulso de prueba: LED + D6");
  testPulsing = true;
  testPulseEnd = millis() + TEST_PULSE_MS;
  digitalWrite(TEST_PIN, RELAY_ACTIVE);
  ledBlinkStart(1, 150);
}

/* =================== MQTT =================== */

void publishStatus(bool online) {
  String topic = String(MQTT_PREFIX) + "/device/status";
  if (online) {
    String payload = String("{\"status\":\"online\",\"name\":\"") + DEVICE_NAME +
                     "\",\"ip\":\"" + WiFi.localIP().toString() +
                     "\",\"ssid\":\"" + String(WiFi.SSID()) +
                     "\",\"rssi\":" + WiFi.RSSI() +
                     ",\"networks\":" + netCount +
                     ",\"uptime\":" + (millis() / 1000) + "}";
    mqtt.publish(topic.c_str(), payload.c_str(), true);
  } else {
    mqtt.publish(topic.c_str(), "{\"status\":\"offline\"}", true);
  }
}

// Publica la lista de SSIDs guardados (sin claves) para que el dashboard
// pueda mostrarlos. Formato JSON: {"networks":["<ssid>",...]}
void publishNetworks() {
  String payload = "{\"networks\":[";
  for (int i = 0; i < netCount; i++) {
    if (!networks[i].set) continue;
    if (payload.length() > 13) payload += ",";
    payload += "\"";
    payload += networks[i].ssid;
    payload += "\"";
  }
  payload += "]}";
  String topic = String(MQTT_PREFIX) + "/device/networks";
  mqtt.publish(topic.c_str(), payload.c_str(), true);
}

bool connectMqtt() {
  if (mqtt.connected()) return true;
  Serial.printf("[mqtt] intentando conexion (rc=%d)...\n", mqtt.state());
  String clientId = String(DEVICE_NAME) + "-" + String(ESP.getChipId(), HEX);
  String willTopic = String(MQTT_PREFIX) + "/device/status";
  if (mqtt.connect(clientId.c_str(), mqttUser, mqttPass,
                   willTopic.c_str(), 1, true, "{\"status\":\"offline\"}", true)) {
    Serial.println("[mqtt] conectado");
    mqtt.subscribe((String(MQTT_PREFIX) + "/door/1/cmd").c_str());
    mqtt.subscribe((String(MQTT_PREFIX) + "/door/2/cmd").c_str());
    mqtt.subscribe((String(MQTT_PREFIX) + "/test/cmd").c_str());
    mqtt.subscribe((String(MQTT_PREFIX) + "/wifi/cmd").c_str());
    mqtt.subscribe((String(MQTT_PREFIX) + "/setup/cmd").c_str());
    publishStatus(true);
    publishNetworks();
    ledBlinkStart(3, 150);
    return true;
  }
  Serial.printf("[mqtt] fallo, rc=%d\n", mqtt.state());
  return false;
}

void handleSetupCmd(String msg) {
  if (msg.startsWith("mqtt:")) {
    String rest = msg.substring(5);
    int colon = rest.indexOf(':');
    if (colon > 0) {
      strncpy(mqttUser, rest.substring(0, colon).c_str(), MQTT_USER_LEN - 1);
      mqttUser[MQTT_USER_LEN - 1] = 0;
      strncpy(mqttPass, rest.substring(colon + 1).c_str(), MQTT_PASS_LEN - 1);
      mqttPass[MQTT_PASS_LEN - 1] = 0;
      saveMqttToEeprom();
      Serial.println("[setup] credenciales MQTT actualizadas");
      ESP.restart();
    }
  } else if (msg.startsWith("wifi:")) {
    String rest = msg.substring(5);
    int colon = rest.indexOf(':');
    if (colon > 0) {
      String ssid = rest.substring(0, colon);
      String pass = rest.substring(colon + 1);
      if (addNetwork(ssid.c_str(), pass.c_str())) {
        Serial.printf("[setup] red '%s' guardada\n", ssid.c_str());
        // desconectar y re-conectar a la nueva lista
        WiFi.disconnect();
        wifiLostAt = 0;
      } else {
        Serial.println("[setup] lista de redes llena (" + String(MAX_NETWORKS) + ")");
      }
    }
  } else if (msg == "obs") {
    Serial.println("== CONFIG ==");
    Serial.print("mqttUser: "); Serial.println(mqttUser);
    Serial.print("networks: "); Serial.println(netCount);
    for (int i = 0; i < netCount; i++)
      Serial.printf("  %d: %s / %s\n", i, networks[i].ssid, networks[i].pass);
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int len) {
  String msg;
  for (unsigned int i = 0; i < len; i++) msg += (char)payload[i];
  String t = String(topic);

  String base = String(MQTT_PREFIX) + "/door/";
  if (t == base + "1/cmd") handleDoorCmd(1, msg);
  else if (t == base + "2/cmd") handleDoorCmd(2, msg);
  else if (t == String(MQTT_PREFIX) + "/test/cmd") handleTestCmd();
  else if (t == String(MQTT_PREFIX) + "/setup/cmd") handleSetupCmd(msg);
  else if (t == String(MQTT_PREFIX) + "/wifi/cmd") {
    if (msg == "reset") {
      Serial.println("[wifi] borrando TODAS las redes");
      clearAllNetworks();
      delay(500);
      ESP.restart();
    } else if (msg.startsWith("forget:")) {
      String ssid = msg.substring(7);
      forgetNetwork(ssid.c_str());
      Serial.printf("[wifi] red '%s' olvidada\n", ssid.c_str());
    }
  }
}

/* =================== WiFi multi-red =================== */

// Devuelve el indice de la red actualmente conectada, o -1
int currentNetworkIdx() {
  String ssid = WiFi.SSID();
  for (int i = 0; i < netCount; i++)
    if (strcmp(networks[i].ssid, ssid.c_str()) == 0) return i;
  return -1;
}

// Intenta conectarse a la red[num]. No bloqueante.
void wifiConnectTo(int num) {
  if (num < 0 || num >= netCount || !networks[num].set) return;
  Serial.printf("[wifi] intentando red %d/%d: '%s'\n", num, netCount, networks[num].ssid);
  WiFi.disconnect();
  delay(50);
  WiFi.mode(WIFI_STA);
  WiFi.begin(networks[num].ssid, networks[num].pass);
}

bool haveNetworks() {
  for (int i = 0; i < netCount; i++) if (networks[i].set) return true;
  return false;
}

// Busca y conecta a la primera red guardada que este disponible.
// Hace un escaneo previo de redes para no intentar conectarse a una que no existe.
void tryConnectAny() {
  if (netCount == 0) return;

  // Escanear las redes visibles para saber cual de las guardadas existe.
  Serial.println("[wifi] escaneando redes visibles...");
  int n = WiFi.scanNetworks();
  Serial.printf("[wifi] se vieron %d redes\n", n);

  // Construir lista de SSIDs visibles (sin claves)
  String visible[MAX_NETWORKS];
  int visibleCount = 0;
  Serial.println("[wifi] redes visibles:");
  for (int i = 0; i < n && visibleCount < MAX_NETWORKS; i++) {
    String s = WiFi.SSID(i);
    Serial.printf("  - '%s'\n", s.c_str());
    bool dup = false;
    for (int j = 0; j < visibleCount; j++) if (visible[j] == s) dup = true;
    if (!dup) visible[visibleCount++] = s;
  }
  WiFi.scanDelete(); // liberar buffer del escaneo

  // Probar primero las redes guardadas que aparecen visibles, por señal.
  for (int v = 0; v < visibleCount; v++) {
    for (int i = 0; i < netCount; i++) {
      if (!networks[i].set) continue;
      if (strcmp(networks[i].ssid, visible[v].c_str()) == 0) {
        // Red guardada y visible -> conectar
        wifiConnectTo(i);
        unsigned long t0 = millis();
        while ((long)(millis() - t0) < 8000 && WiFi.status() != WL_CONNECTED) {
          delay(100);
          yield();
        }
        if (WiFi.status() == WL_CONNECTED) {
          Serial.printf("[wifi] conectado a '%s'\n", networks[i].ssid);
          return;
        }
      }
    }
  }

  // Ninguna red guardada conecto (posiblemente las guardadas no estan visibles
  // o fallaron). Dejamos que el loop siga intentando reconectarse.
  Serial.println("[wifi] ninguna red guardada disponible ahora");
}

/* =================== WEB CONFIG (AP / pagina local) =================== */

String webPage(bool saved) {
  String html = "<!DOCTYPE html><html lang=es><head><meta charset=utf-8>"
    "<meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>GarageControl - Config</title>"
    "<style>body{font-family:system-ui;max-width:480px;margin:20px auto;padding:0 16px}"
    "h1{font-size:1.3rem}label{display:block;margin:10px 0 4px;font-weight:bold}"
    "input{width:100%;padding:10px;border:1px solid #bbb;border-radius:6px;box-sizing:border-box}"
    "button{width:100%;padding:12px;margin-top:18px;background:#2563eb;border:0;border-radius:6px;color:#fff;font-size:1rem}"
    ".ok{color:#16a34a;font-weight:bold}.err{color:#dc2626;font-weight:bold}</style></head><body>";
  if (saved) {
    html += "<h1>Configurado</h1><p class=ok>Red guardada. Reconectando...</p>";
  } else {
    html += "<h1>Configura red WiFi</h1>"
      "<form method=post action='/save'>"
      "<label>Red WiFi (SSID)</label><input name=ssid required>"
      "<label>Clave</label><input type=password name=pass required>"
      "<button type=submit>Guardar y conectar</button></form>";
  }
  html += "</body></html>";
  return html;
}

void handleWebRoot() {
  webServer.send(200, "text/html", webPage(false));
}

void handleWebSave() {
  String ssid = webServer.arg("ssid");
  String pass = webServer.arg("pass");
  ssid.trim();
  pass.trim();
  Serial.printf("[web] guardando red '%s'\n", ssid.c_str());
  if (ssid.length() == 0 || pass.length() == 0) {
    webServer.send(200, "text/html", "<h1>Error: faltan datos.</h1>");
    return;
  }
  bool ok = addNetwork(ssid.c_str(), pass.c_str());
  webServer.send(200, "text/html", webPage(ok));
  if (ok) {
    Serial.println("[web] red guardada; reiniciando para conectar");
    delay(800);
    ESP.restart();
  }
}

void startWebServer() {
  webServer.on("/", HTTP_GET, handleWebRoot);
  webServer.on("/save", HTTP_POST, handleWebSave);
  webServer.begin();
}

// Abre el punto de acceso de configuracion manualmente.
void openConfigAP() {
  Serial.println("[wifi] abriendo AP de configuracion");
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_NAME, AP_PASS);
  apActive = true;
  dnsServer.start(53, "*", WiFi.softAPIP());
  ledBlinkStart(6, 120);
}

/* =================== SETUP =================== */

void setup() {
  Serial.begin(115200);
  Serial.println("\nGarageControl ESP8266 v3.0 iniciando...");
  EEPROM.begin(EEPROM_SIZE);
  loadConfig();

  for (uint8_t i = 0; i < 2; i++) {
    pinMode(RELAY_PINS[i], OUTPUT);
    setRelay(i, false);
  }
  pinMode(TEST_PIN, OUTPUT);
  digitalWrite(TEST_PIN, !RELAY_ACTIVE);
  pinMode(2, OUTPUT);
  digitalWrite(2, HIGH);
  pinMode(0, INPUT_PULLUP); // Botón FLASH

  // Detección del botón FLASH con debounce. Debido a que el ESP8266 entra en
  // modo de descarga (bootloader) si GPIO0 está en LOW AL ENCENDER, este botón
  // solo se puede usar correctamente si se presiona DESPUÉS de que el firmware
  // ya arrancó (unos 500ms-1s después de darle electricidad), o vía reset.
  // Para detectarlo de forma fiable, muestreamos durante la primera ventana
  // del setup (el firmware ya está corriendo en ese punto).
  unsigned long btnT0 = millis();
  bool btnPressed = false;
  while ((long)(millis() - btnT0) < 400) {
    if (digitalRead(0) == LOW) { btnPressed = true; break; }
    delay(10);
  }
  if (btnPressed) {
    // Confirmar que siga presionado 100ms mas (debounce antirrebote)
    delay(100);
    if (digitalRead(0) == LOW) {
      Serial.println("[wifi] boton FLASH: borrando TODA la config");
      ledBlinkStart(6, 100);
      clearAllNetworks();
    }
  }

  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  WiFi.setOutputPower(15);

  if (haveNetworks() && !btnPressed) {
    // Conectar a la primera red guardada disponible
    tryConnectAny();
  } else {
    // Sin redes (o botón FLASH): abrir AP con pagina web para configurar.
    // Nota: si hubo redes y el botón las borró, o si no hay redes, abrimos AP.
    if (btnPressed) Serial.println("[setup] boton FLASH detectado; abriendo AP de config");
    else Serial.println("[wifi] sin redes guardadas; abriendo AP de configuracion");
    openConfigAP();
  }

  // El servidor web siempre esta activo:
  //   - En AP: pagina de configuracion de primera red.
  //   - En STA: pagina de administracion disponible en la IP local del ESP.
  startWebServer();

  Serial.print("[wifi] IP: ");
  Serial.println(WiFi.localIP());
  if (WiFi.status() == WL_CONNECTED) ledBlinkStart(2, 150);

#if USE_TLS
  net.setInsecure();
#endif

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  connectMqtt();
  lastStatusAt = millis();
}

/* =================== LOOP =================== */

void loop() {
  unsigned long now = millis();

  // --- Servidores web/DNS (portal config o pagina local) ---
  // Cuando NO hay redes (modo AP), atendemos el portal de configuracion.
  // Cuando hay redes y estamos en STA, la pagina sigue disponible en la IP
  // local del ESP para administrar redes sin MQTT.
  if (apActive) {
    dnsServer.processNextRequest();
    webServer.handleClient();
  } else if (WiFi.status() == WL_CONNECTED) {
    webServer.handleClient();
  }

  // --- WiFi: reconexion no bloqueante ---
  if (WiFi.status() != WL_CONNECTED && netCount > 0) {
    if (wifiLostAt == 0) {
      wifiLostAt = now;
      lastWifiRetry = 0;
      Serial.println("[wifi] perdido, reconectando...");
    }
    if ((unsigned long)(now - lastWifiRetry) > 8000) {
      lastWifiRetry = now;
      // Cada 8s, hacer un escaneo y probar a conectarse a una red guardada
      // visible. Esto es mas robusto que solo WiFi.reconnect().
      int cur = currentNetworkIdx();
      if (cur < 0) {
        // No estamos en ninguna red guardada: intentar conectar a cualquiera
        // disponible (escanea y conecta).
        tryConnectAny();
      } else if (netCount > 1) {
        // Estamos rotando: probar la siguiente red de la lista.
        int nxt = (cur + 1) % netCount;
        wifiConnectTo(nxt);
      } else {
        WiFi.reconnect();
      }
    }
    // Despues de un tiempo sin red, abrir el AP de configuracion para que el
    // usuario pueda inscribir una red nueva (sin depender del boton FLASH).
    if ((unsigned long)(now - wifiLostAt) > 45000 && !apActive) {
      Serial.println("[wifi] 45s sin red; abriendo AP de configuracion");
      openConfigAP();
      forceApAfterTimeout = true;
      wifiLostAt = 0;
    }
  } else if (WiFi.status() == WL_CONNECTED) {
    wifiLostAt = 0;
  }

  // --- MQTT: reconexion con backoff exponencial ---
  if (WiFi.status() == WL_CONNECTED) {
    if (!mqtt.connected()) {
      if ((unsigned long)(now - lastMqttAttempt) >= mqttBackoffMs) {
        lastMqttAttempt = now;
        if (mqttBackoffMs == 0) mqttBackoffMs = 2000;
        else mqttBackoffMs = mqttBackoffMs * 2;
        if (mqttBackoffMs > 30000) mqttBackoffMs = 30000;
        connectMqtt();
      }
    } else {
      mqtt.loop();
      if (mqttBackoffMs > 0) mqttBackoffMs = 0;
    }
  }

  // --- Pulsos de relé ---
  for (uint8_t i = 0; i < 2; i++)
    if (pulsing[i] && (long)(now - pulseEnd[i]) >= 0) {
      pulsing[i] = false;
      setRelay(i, false);
    }

  // --- Pulso de prueba ---
  if (testPulsing && (long)(now - testPulseEnd) >= 0) {
    testPulsing = false;
    digitalWrite(TEST_PIN, !RELAY_ACTIVE);
  }

  // --- Estado periodico ---
  if ((unsigned long)(now - lastStatusAt) >= STATUS_INTERVAL_MS) {
    lastStatusAt = now;
    if (mqtt.connected()) publishStatus(true);
  }

  // --- LED no bloqueante ---
  ledLoop();

  ESP.wdtFeed();
}