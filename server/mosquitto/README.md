# Broker MQTT (Mosquitto)

## Instalacion en la EC2 (Debian/Ubuntu)

```bash
sudo apt update && sudo apt install -y mosquitto mosquitto-clients

# Copia la config
sudo cp GarageControl/server/mosquitto/garaje.conf /etc/mosquitto/conf.d/garaje.conf

# Crea el archivo de passwords (un usuario para el ESP8266)
sudo mosquitto_passwd -c /etc/mosquitto/garaje.passwd esp8266
# Te pedira una clave; guardala para el firmware.

sudo systemctl restart mosquitto
sudo systemctl enable mosquitto
```

> Requiere el certificado Let's Encrypt de `garaje.thinc.site` en
> `/etc/letsencrypt/live/garaje.thinc.site/`. Ver `deploy/README.md`.

## Verificacion rapida

```bash
# En la EC2
mosquitto_sub -h 127.0.0.1 -t 'garaje/#' -v

# Desde tu PC (remplaza <clave>):
mosquitto_pub -h garaje.thinc.site -p 8883 --cafile /etc/letsencrypt/live/garaje.thinc.site/fullchain.pem -u esp8266 -P <clave> -t 'garaje/door/1/cmd' -m 'open'
```

## Topics usados

| Topic                      | Direccion         | Payload                          |
|----------------------------|-------------------|----------------------------------|
| `garaje/door/1/cmd`        | server -> ESP8266 | `open` o `close`                 |
| `garaje/door/2/cmd`        | server -> ESP8266 | `open` o `close`                 |
| `garaje/emergency/cmd`     | server -> ESP8266 | `stop` o `reset`                 |
| `garaje/device/status`     | ESP8266 -> server | JSON (retained) / `offline` (LWT)|
| `garaje/door/<n>/state`    | ESP8266 -> server | `open`, `closed`, `unknown`      |

## Seguridad recomendada (opcional)

Si quieres que solo el ESP8266 pueda publicar estados y el server solo comandos,
anade ACL:

```ini
# /etc/mosquitto/conf.d/garaje-acl.conf
acl_file /etc/mosquitto/garaje.acl
```

```text
# /etc/mosquitto/garaje.acl
user esp8266
topic write garaje/door/1/state
topic write garaje/door/2/state
topic write garaje/device/status
topic read garaje/door/1/cmd
topic read garaje/door/2/cmd
topic read garaje/emergency/cmd

user garaje-server
topic write garaje/door/1/cmd
topic write garaje/door/2/cmd
topic write garaje/emergency/cmd
topic read garaje/device/status
topic read garaje/door/1/state
topic read garaje/door/2/state
topic read garaje/emergency/cmd
```

Si usas ACL, crea tambien el usuario del servidor con `mosquitto_passwd`
y ponlo en el `.env` del servidor (`MQTT_USERNAME` / `MQTT_PASSWORD`).
