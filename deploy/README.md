# Guia de despliegue en la EC2 de AWS

Presupuestos: Ubuntu/Debian en la EC2, nginx ya sirviendo `thinc.site`
(Iot Energy), y una instancia con IP publica asociada al dominio.

## 1. DNS

Crea un registro A en tu DNS (Route53 o el que uses):

```
garaje.thinc.site  A  <IP_PUBLICA_EC2>
```

Espera a que propague (nslookup garaje.thinc.site).

## 2. Certificado SSL (Let's Encrypt)

```bash
sudo apt update && sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d garaje.thinc.site
```

> Este certificado sirve tanto para la web (443) como para el broker MQTT
> (8883), porque ambos usan `garaje.thinc.site`.

## 3. Node.js y el servidor

```bash
# Instalar Node 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Copiar el proyecto
sudo mkdir -p /opt/garage-control
sudo cp -r <ruta>/GarageControl/server /opt/garage-control/
sudo cp -r <ruta>/GarageControl/web /opt/garage-control/

sudo chown -R www-data:www-data /opt/garage-control

cd /opt/garage-control/server
sudo npm install --omit=dev

# Configuracion
sudo -u www-data cp .env.example .env
sudo nano .env
#   JWT_SECRET=una-clave-larga-y-aleatoria
#   ADMIN_INITIAL_PIN=1234   <- se usa solo la 1a vez, cambialo despues
```

## 4. Broker Mosquitto

```bash
sudo apt install -y mosquitto mosquitto-clients
sudo cp /opt/garage-control/server/mosquitto/garaje.conf /etc/mosquitto/conf.d/garaje.conf
sudo mosquitto_passwd -c /etc/mosquitto/garaje.passwd esp8266
sudo systemctl restart mosquitto
sudo systemctl enable mosquitto
```

## 5. Servicio systemd

```bash
sudo cp <ruta>/deploy/garaje-node.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now garaje-node
sudo systemctl status garaje-node
```

## 6. nginx (subdominio)

```bash
sudo cp <ruta>/deploy/nginx-garaje.conf /etc/nginx/sites-available/garaje.thinc.site
sudo ln -s /etc/nginx/sites-available/garaje.thinc.site /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 7. Firewall / Security Group

En el Security Group de la EC2 abre:

| Puerto | Uso |
|--------|-----|
| 80     | Redireccion a HTTPS |
| 443    | Web PWA |
| 8883   | MQTT TLS (ESP8266) |

## 8. Subir el firmware al ESP8266

Edita `firmware/garage_relay/garage_relay.ino`:

- `WIFI_SSID` / `WIFI_PASS` (tu red local)
- `MQTT_USER` / `MQTT_PASS` (el usuario `esp8266` creado en el paso 4)
- `USE_TLS` = 1

Compila y sube con Arduino IDE (placa NodeMCU 1.0 / Wemos D1 mini).
Abre el monitor serie (115200 baud) para ver la IP y los mensajes.

## 9. Prueba final

1. Abre `https://garaje.thinc.site` desde el celular.
2. Entra con `admin` y el PIN inicial.
3. Cambia el PIN del admin (Administracion > Usuarios).
4. Verifica en el monitor serie que el ESP8266 recibe los comandos.

## Notas

- **Zona horaria:** los horarios por usuario se evaluan con la hora del
  servidor. Ajusta la zona con `sudo timedatectl set-timezone America/Mexico_City`
  (o tu zona) o define `TZ` en el `.env`.
- **Instalar como PWA:** en el navegador del celular usa "Agregar a
  pantalla de inicio" / "Instalar app".
- **Seguridad:** nunca expongas el puerto 1883 del Mosquitto. El 8883 exige
  usuario, clave y TLS. Considera activar las ACL (ver
  `server/mosquitto/README.md`).
