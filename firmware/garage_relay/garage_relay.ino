/*
 * GarageControl - Firmware ESP8266
 * Control de 2 portones con modulo de rele de 4 canales via MQTT.
 *
 * Conexion:
 *   CH1 = D1 (GPIO5)  -> Abrir  Porton 1
 *   CH2 = D2 (GPIO4)  -> Cerrar Porton 1
 *   CH3 = D5 (GPIO14) -> Abrir  Porton 2
 *   CH4 = D6 (GPIO12) -> Cerrar Porton 2
 *
 * Librerias (Arduino IDE):
 *   - ESP8266 Boards (nucleo 2.7+)
 *   - PubSubClient by Nick O'Leary (2.8+)
 */

#include <ESP8266WiFi.h>
#include <PubSubClient.h>

/* =================== CONFIG =================== */

const char* WIFI_SSID = "TU_WIFI";
const char* WIFI_PASS = "TU_CLAVE_WIFI";

const char* MQTT_HOST = "garaje.thinc.site";
const uint16_t MQTT_PORT = 8883;
const char* MQTT_USER = "esp8266";
const char* MQTT_PASS = "TU_CLAVE_MQTT";
const char* MQTT_PREFIX = "garaje";

#define USE_TLS 1   // 1 = conexion cifrada (recomendado), 0 = sin cifrar
#define DEVICE_NAME "esp8266-garaje"

const uint8_t RELAY_PINS[4] = { D1, D2, D5, D6 };
const uint8_t RELAY_ACTIVE = LOW; // LOW = modulo optoacoplado, HIGH = otros

const unsigned long PULSE_MS = 1000;      // duracion del pulso (ms)
const unsigned long MIN_GAP_MS = 2000;    // min. entre pulsos (ms)
const unsigned long EMERGENCY_LOCK_MS = 30000; // bloqueo tras emergencia (ms)
const unsigned long STATUS_INTERVAL_MS = 30000; // estado periodico (ms)

/* Sensores de posicion (OPCIONAL, futuro):
   Descomenta estas lineas y conecta finales de carrera / sensores magneticos.
#define SENSOR_DOOR1_OPEN  D7
#define SENSOR_DOOR1_CLOSE D8
#define SENSOR_DOOR2_OPEN  D3
#define SENSOR_DOOR2_CLOSE D4
#define SENSOR_PULL_MODE   INPUT_PULLUP
*/

/* ============================================== */

#if USE_TLS
#include <WiFiClientSecure.h>
WiFiClientSecure net;
#else
WiFiClient net;
#endif
PubSubClient mqtt(net);

unsigned long pulseEnd[4] = { 0, 0, 0, 0 };
bool pulsing[4] = { false, false, false, false };
unsigned long lastPulseAt = 0;
unsigned long emergencyUntil = 0;
bool emergencyLocked = false;
unsigned long lastStatusAt = 0;

void setRelay(uint8_t idx, bool on) {
  digitalWrite(RELAY_PINS[idx], on ? RELAY_ACTIVE : !RELAY_ACTIVE);
}

void stopAll() {
  for (uint8_t i = 0; i < 4; i++) {
    pulsing[i] = false;
    setRelay(i, false);
  }
}

bool startPulse(uint8_t idx) {
  if (emergencyLocked) return false;
  if ((unsigned long)(millis() - lastPulseAt) < MIN_GAP_MS) return false;
  pulseEnd[idx] = millis() + PULSE_MS;
  pulsing[idx] = true;
  lastPulseAt = millis();
  setRelay(idx, true);
  Serial.printf("[relay] pulso canal %u\n", idx);
  return true;
}

void handleDoorCmd(uint8_t door, String action) {
  uint8_t idx;
  if (action == "open") idx = (door - 1) * 2;     // CH1 o CH3
  else if (action == "close") idx = (door - 1) * 2 + 1; // CH2 o CH4
  else return;
  Serial.printf("[cmd] porton %u -> %s\n", door, action.c_str());
  startPulse(idx);
}

void mqttCallback(char* topic, byte* payload, unsigned int len) {
  String msg;
  for (unsigned int i = 0; i < len; i++) msg += (char)payload[i];
  String t = String(topic);

  String base = String(MQTT_PREFIX) + "/door/";
  if (t == base + "1/cmd") handleDoorCmd(1, msg);
  else if (t == base + "2/cmd") handleDoorCmd(2, msg);
  else if (t == String(MQTT_PREFIX) + "/emergency/cmd") {
    if (msg == "stop") {
      Serial.println("[cmd] EMERGENCIA: detener todo");
      emergencyLocked = true;
      emergencyUntil = millis();
      stopAll();
    } else if (msg == "reset") {
      emergencyLocked = false;
      Serial.println("[cmd] emergencia restablecida");
    }
  }
}

void publishStatus(bool online) {
  String topic = String(MQTT_PREFIX) + "/device/status";
  if (online) {
    String payload = String("{\"status\":\"online\",\"name\":\"") + DEVICE_NAME +
                     "\",\"ip\":\"" + WiFi.localIP().toString() +
                     "\",\"rssi\":" + WiFi.RSSI() +
                     ",\"uptime\":" + (millis() / 1000) + "}";
    mqtt.publish(topic.c_str(), payload.c_str(), true);
  } else {
    mqtt.publish(topic.c_str(), "{\"status\":\"offline\"}", true);
  }
}

bool connectMqtt() {
  if (mqtt.connected()) return true;
  String clientId = String(DEVICE_NAME) + "-" + String(ESP.getChipId(), HEX);
  String willTopic = String(MQTT_PREFIX) + "/device/status";
  if (mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASS,
                   willTopic.c_str(), 1, true, "{\"status\":\"offline\"}")) {
    Serial.println("[mqtt] conectado");
    mqtt.subscribe((String(MQTT_PREFIX) + "/door/1/cmd").c_str());
    mqtt.subscribe((String(MQTT_PREFIX) + "/door/2/cmd").c_str());
    mqtt.subscribe((String(MQTT_PREFIX) + "/emergency/cmd").c_str());
    publishStatus(true);
    return true;
  }
  Serial.printf("[mqtt] fallo de conexion, rc=%d\n", mqtt.state());
  return false;
}

void setup() {
  Serial.begin(115200);
  Serial.println("\nGarageControl ESP8266 iniciando...");

  for (uint8_t i = 0; i < 4; i++) {
    pinMode(RELAY_PINS[i], OUTPUT);
    setRelay(i, false);
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("[wifi] conectando");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.print("\n[wifi] IP: ");
  Serial.println(WiFi.localIP());

#if USE_TLS
  net.setInsecure(); // cifra la conexion; para verificar el certificado ver ca_cert.h
#endif

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  connectMqtt();
  lastStatusAt = millis();
}

void loop() {
  // Reconnectar WiFi
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.print("[wifi] reconectando");
    unsigned long t0 = millis();
    while (WiFi.status() != WL_CONNECTED && (unsigned long)(millis() - t0) < 15000) {
      delay(400);
      Serial.print(".");
    }
    Serial.println();
  }

  if (!mqtt.connected()) {
    connectMqtt();
    delay(1000);
  } else {
    mqtt.loop();
  }

  // Mantener pulsos (no bloqueante)
  unsigned long now = millis();
  for (uint8_t i = 0; i < 4; i++) {
    if (pulsing[i] && (unsigned long)(now - pulseEnd[i]) >= PULSE_MS) {
      pulsing[i] = false;
      setRelay(i, false);
    }
  }

  // Fin de bloqueo por emergencia
  if (emergencyLocked && (unsigned long)(now - emergencyUntil) >= EMERGENCY_LOCK_MS) {
    emergencyLocked = false;
    Serial.println("[sys] bloqueo de emergencia finalizado");
  }

  // Estado periodico
  if ((unsigned long)(now - lastStatusAt) >= STATUS_INTERVAL_MS) {
    lastStatusAt = now;
    publishStatus(true);
  }

  ESP.wdtFeed();
}
