/*
 * TEST v5: conecta a red abierta (clave vacia) o protegida.
 * El numero de parpadeos indica el estado de WiFi:
 *   - 3 parpadeos lentos = CONECTADO (muestra la IP por serial)
 *   - 2 parpadeos = no encuentra la red (SSID mal o banda 5 GHz)
 *   - 5 parpadeos = autenticacion rechazada (clave/seguridad)
 *   - 7 parpadeos = se desconecto tras conectar
 *   - otro numero N = estado N-1 (por serial se imprime el codigo exacto)
 */
#include <ESP8266WiFi.h>

const char* WIFI_SSID = "Herazo87";  // SSID del hotspot
const char* WIFI_PASS = "";          // VACIO si la red no tiene clave

void blink(int n, int ms) {
  for (int i = 0; i < n; i++) {
    digitalWrite(2, LOW);
    delay(ms);
    digitalWrite(2, HIGH);
    delay(ms);
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println();
  Serial.printf("TEST: reset: %s\n", ESP.getResetReason().c_str());
  Serial.println("TEST: arranco");
  pinMode(2, OUTPUT);
  digitalWrite(2, HIGH);
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setOutputPower(0);
  Serial.printf("TEST: conectando a %s (con clave: %s)\n",
                WIFI_SSID, strlen(WIFI_PASS) ? "si" : "no");
  if (strlen(WIFI_PASS) == 0) {
    WiFi.begin(WIFI_SSID);
  } else {
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && (unsigned long)(millis() - t0) < 20000) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();
}

void loop() {
  int st = WiFi.status();
  if (st == WL_CONNECTED) {
    Serial.println("TEST: IP " + WiFi.localIP().toString());
    blink(3, 150);
    delay(2000);
  } else {
    Serial.printf("TEST: estado %d\n", st);
    blink(st + 1, 300);
    delay(2500);
  }
}
