#!/usr/bin/env bash
echo "--- tools en imagen ---"
which mosquitto_sub mosquitto_pub 2>/dev/null
docker exec garage_mosquitto sh -c 'which mosquitto_sub mosquitto_pub' 2>&1
echo "--- passwd users (nombres) ---"
docker exec garage_mosquitto sh -c 'cut -d: -f1 /mosquitto/config/garaje.passwd' 2>&1
echo "--- pub con cada usuario (probar sub en paralelo) ---"
docker exec garage_mosquitto mosquitto_pub -h 127.0.0.1 -p 1883 -t '_diag/x' -m 'z' -u garaje-server -P "$(grep -oP '(?<=MQTT_PASSWORD=).*' /opt/Control-Garaje/server/.env)" 2>&1
echo "pub exit: $?"