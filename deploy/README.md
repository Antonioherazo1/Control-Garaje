# Guia de despliegue en la EC2 de AWS

Presupuestos: Ubuntu/Debian en la EC2, nginx ya sirviendo `thinc.site`
(Iot Energy), y una instancia con IP publica asociada al dominio.
El proyecto se baja por git a `/opt/Control-Garaje`.

## 1. DNS

Crea un registro A en tu DNS (Route53 o el que uses):

```
garaje.thinc.site  A  <IP_PUBLICA_EC2>
```

Espera a que propague (nslookup garaje.thinc.site).

## 2. Clonar el proyecto

```bash
cd /opt
sudo apt install -y git
sudo git clone https://github.com/Antonioherazo1/Control-Garaje.git
cd /opt/Control-Garaje
```

Para futuras actualizaciones: `sudo git pull` dentro de la carpeta.

## 3. Certificado SSL (Let's Encrypt)

Primero un bloque HTTP minimo en nginx para que certbot valide el dominio:

```bash
sudo tee /etc/nginx/sites-available/garaje.thinc.site <<'EOF'
server {
    listen 80;
    server_name garaje.thinc.site;
    root /var/www/html;
}
EOF
sudo ln -s /etc/nginx/sites-available/garaje.thinc.site /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo apt update && sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d garaje.thinc.site
```

> El mismo certificado sirve para la web (443) y para el broker MQTT (8883),
> porque ambos usan `garaje.thinc.site`.
> En el paso 7 se reemplaza este bloque por el definitivo (con proxy a Node).

## 4. Node.js y el servidor

```bash
# Instalar Node 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

cd /opt/Control-Garaje/server
sudo npm install --omit=dev
sudo chown -R www-data:www-data /opt/Control-Garaje

# Configuracion
sudo -u www-data cp .env.example .env
sudo nano .env
#   JWT_SECRET=una-clave-larga-y-aleatoria
#   ADMIN_INITIAL_PIN=1234   <- se usa solo la 1a vez, cambialo despues
#   MQTT_URL=mqtt://127.0.0.1:1884   (ya viene por defecto)
```

## 5. Broker Mosquitto (contenedor aislado)

La EC2 ya tiene un broker para Iot Energy, pero es anonimo y sin TLS, por lo
que el garaje usa un contenedor Mosquitto separado (1884 local + 8883 TLS).

```bash
cd /opt/Control-Garaje/server/mosquitto

# Certificados (se copian de los de certbot)
sudo mkdir -p certs
sudo cp /etc/letsencrypt/live/garaje.thinc.site/fullchain.pem certs/
sudo cp /etc/letsencrypt/live/garaje.thinc.site/privkey.pem certs/
sudo chmod 644 certs/privkey.pem

# Usuario del ESP8266 (te pedira una clave; guardala)
sudo docker run --rm --entrypoint mosquitto_passwd -v "$(pwd)":/cfg eclipse-mosquitto:2 -c -b /cfg/garaje.passwd esp8266 'TU_CLAVE'
sudo chmod 644 garaje.passwd

# Levantar el contenedor
sudo docker compose -f docker-compose.garaje.yml up -d
sudo docker ps | grep garage_mosquitto
```

## 6. Servicio systemd

```bash
sudo cp /opt/Control-Garaje/deploy/garaje-node.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now garaje-node
sudo systemctl status garaje-node
```

## 7. nginx (bloque definitivo)

```bash
sudo cp /opt/Control-Garaje/deploy/nginx-garaje.conf /etc/nginx/sites-available/garaje.thinc.site
sudo nginx -t && sudo systemctl reload nginx
```

## 8. Firewall / Security Group

En el Security Group de la EC2 abre:

| Puerto | Uso |
|--------|-----|
| 80     | Renovacion de certificados (HTTP) |
| 443    | Web PWA |
| 8883   | MQTT TLS (ESP8266) |

## 9. Subir el firmware al ESP8266

Edita `firmware/garage_relay/garage_relay.ino`:

- `WIFI_SSID` / `WIFI_PASS` (tu red local)
- `MQTT_HOST` = `garaje.thinc.site` (ya viene)
- `MQTT_PORT` = `8883` (ya viene)
- `MQTT_USER` / `MQTT_PASS` (el usuario `esp8266` creado en el paso 5)
- `USE_TLS` = 1 (ya viene)

Compila y sube con Arduino IDE (placa NodeMCU 1.0 / Wemos D1 mini).
Abre el monitor serie (115200 baud) para ver la IP y los mensajes.

## 10. Prueba final

1. Abre `https://garaje.thinc.site` desde el celular.
2. Entra con `admin` y el PIN inicial.
3. Cambia el PIN del admin (Administracion > Usuarios).
4. Verifica en el monitor serie que el ESP8266 recibe los comandos.

## Notas

- **Zona horaria:** los horarios por usuario se evaluan con la hora del
  servidor. Ajusta la zona con `sudo timedatectl set-timezone America/Mexico_City`
  (o tu zona) o define `TZ` en el `.env`.
- **Renovacion del certificado:** al renovar (certbot renew), vuelve a copiar
  los certs al broker y reinicia el contenedor (ver `server/mosquitto/README.md`).
- **Instalar como PWA:** en el navegador del celular usa "Agregar a
  pantalla de inicio" / "Instalar app".
- **Seguridad:** el 8883 exige usuario, clave y TLS. El listener local 1884
  no se expone. Considera activar las ACL (ver `server/mosquitto/README.md`).
