/*
 * TEST de serial + flash (SIN WiFi).
 * Si el serial funciona y el chip arranca, veras "SERIAL OK" y los tamanos.
 */
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("SERIAL OK");
  Serial.printf("Flash configurado: %u KB\n", ESP.getFlashChipSize() / 1024);
  Serial.printf("Flash REAL por chip id: %u KB\n", ESP.getFlashChipRealSize() / 1024);
}

void loop() {
  delay(1000);
}
