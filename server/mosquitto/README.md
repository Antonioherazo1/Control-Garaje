# Broker MQTT del garaje (Mosquitto en Docker)

Broker **separado e aislado** del que usa Iot Energy (`energy_iot_mosquitto`,
que es anonimo y sin TLS, por eso NO se usa para el garaje).

## Levantarlo en la EC2

Requisito previo: el certificado Let's Encrypt de `garaje.thinc.site`
(ver `deploy/README.md`, pasos 1-2).

```bash
cd /opt/Control-Garaje/server/mosquitto

# 1) Certificados (se copian de los de certbot)
sudo mkdir -p certs
sudo cp /etc/letsencrypt/live/garaje.thinc.site/fullchain.pem certs/
sudo cp /etc/letsencrypt/live/garaje.thinc.site/privkey.pem certs/
sudo chmod 644 certs/privkey.pem

# 2) Usuario del ESP8266 (te pide una clave; guardala)
sudo docker run --rm --entrypoint mosquitto_passwd -v "$(pwd)":/cfg eclipse-mosquitto:2 -c -b /cfg/garaje.passwd esp8266 'TU_CLAVE'

# 3) Levantar el contenedor
sudo docker compose -f docker-compose.garaje.yml up -d
sudo docker ps | grep garage_mosquitto
```

## Puertos

| Puerto | Exposicion      | Uso                          |
|--------|-----------------|------------------------------|
| 1884   | 127.0.0.1 (local) | Servidor Node (`MQTT_URL=mqtt://127.0.0.1:1884`) |
| 8883   | Publico (TLS)   | ESP8266 (`garaje.thinc.site:8883`) |

## Verificacion rapida

```bash
# Local (sin TLS)
mosquitto_pub -h 127.0.0.1 -p 1884 -t 'garaje/test' -m 'ok'

# Publico con TLS y credenciales (desde tu PC con el cert)
mosquitto_pub --cafile fullchain.pem -h garaje.thinc.site -p 8883 -u esp8266 -P TU_CLAVE -t 'garaje/test' -m 'ok'
```

> Nota: `certs/` es una copia del certificado de certbot. Despues de renovar
> el certificado, vuelve a copiar ambos archivos y reinicia el contenedor.

## Renovacion del certificado (recordatorio)

```bash
sudo certbot renew
cd /opt/Control-Garaje/server/mosquitto
sudo cp /etc/letsencrypt/live/garaje.thinc.site/fullchain.pem certs/
sudo cp /etc/letsencrypt/live/garaje.thinc.site/privkey.pem certs/
sudo chmod 644 certs/privkey.pem
sudo docker compose -f docker-compose.garaje.yml restart
```

## Seguridad adicional (opcional)

Para que el ESP8266 solo pueda publicar estados y el server solo comandos,
agrega ACL al broker. En `garaje.conf`:

```ini
acl_file /mosquitto/config/garaje.acl
```

```text
# garaje.acl
user esp8266
topic write garaje/door/1/state
topic write garaje/door/2/state
topic write garaje/device/status
topic read garaje/door/1/cmd
topic read garaje/door/2/cmd
topic read garaje/emergency/cmd
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

Si usas ACL, crea tambien el usuario `garaje-server` con `mosquitto_passwd`
y pon sus credenciales en el `.env` del servidor
(`MQTT_USERNAME` / `MQTT_PASSWORD`).
