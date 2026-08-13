# GarageControl

Control de 2 portones de garaje desde el celular (PWA), usando un
**ESP8266 + modulo de rele de 4 canales** y MQTT a traves de una **EC2 de AWS**.

## Arquitectura

```
[PWA en el celular] --> HTTPS --> nginx (garaje.thinc.site)
                                     |
                               [Node.js API] --MQTT--> [Mosquitto broker] <--TLS:8883--
                                     |                                       |
                            [users/PIN/historial]                     [ESP8266 en tu WiFi]
                                                                            |
                                                                   [Relé 4 canales]
                                                                          |
                                                             [Portón 1] [Portón 2]
```

El ESP8266 se conecta hacia afuera (a la EC2), asi no necesita IP publica
ni reenvio de puertos: funciona desde tu WiFi de casa y se controla desde
cualquier lugar.

## Estructura

```
server/        API Node.js (Express + MQTT) y config del broker Mosquitto
web/           PWA: login PIN, 4 botones, emergencia, historial, admin
firmware/      Codigo Arduino del ESP8266
deploy/        nginx, systemd y guia de instalacion en la EC2
```

## Cableado del rele (4 canales)

| Canal | Pin ESP8266  | Uso            |
|-------|--------------|----------------|
| CH1   | D1 (GPIO5)  | Abrir  Porton 1|
| CH2   | D2 (GPIO4)  | Cerrar Porton 1|
| CH3   | D5 (GPIO14) | Abrir  Porton 2|
| CH4   | D6 (GPIO12) | Cerrar Porton 2|

Cada boton de la app activa su rele por **1 segundo** (pulso) y lo apaga,
igual que presionar el mando. La mayoria de los modulos de rele
optoacoplados se activan con nivel **LOW** (configurable en el firmware
con `RELAY_ACTIVE`).

> El rele funciona como un interruptor en serie con el pulsador del motor:
> conecta el comun (COM) a un borne del pulsador y el NO al otro. Prueba
> siempre con el porton a la vista y con el control manual funcionando.

## Seguridad

- Login con PIN (hashed con scrypt) + token JWT.
- Admin + usuarios fijos con permisos: **puertas permitidas**, **horarios**
  y **tope de usos por dia**.
- **PIN temporal** expirable para invitados (generado por el admin).
- **Parada de emergencia** (bloquea ambos motores 30 s).
- **Historial** de todos los accesos e intentos.
- MQTT con TLS y credenciales (el broker publico no permite anonimos).

## Puertas / estados

El control hoy es por pulsos (sin sensores). El diseno de topics ya
contempla `garaje/door/<n>/state` para cuando conectes finales de carrera o
sensores magneticos; ver seccion de sensores en el firmware.

## Puesta en marcha rapida

1. **Local (solo la app):** `cd server && npm install && cp .env.example .env`,
   arranca Mosquitto local (o ajusta `MQTT_URL`) y `npm start`. Abre
   `http://localhost:3000`. Entra con `admin` / PIN del `.env`.
2. **Produccion:** sigue `deploy/README.md` (DNS, certbot, mosquitto,
   systemd, nginx) y sube el firmware (`firmware/garage_relay/`).

## Temas MQTT

| Topic                      | Direccion         | Payload                          |
|----------------------------|-------------------|----------------------------------|
| `garaje/door/1/cmd`        | server -> ESP8266 | `open` o `close`                 |
| `garaje/door/2/cmd`        | server -> ESP8266 | `open` o `close`                 |
| `garaje/emergency/cmd`     | server -> ESP8266 | `stop` o `reset`                 |
| `garaje/device/status`     | ESP8266 -> server | JSON (retained) / `offline` (LWT)|
| `garaje/door/<n>/state`    | ESP8266 -> server | `open`, `closed`, `unknown`      |
