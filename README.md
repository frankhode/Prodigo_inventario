# Pródigo · Inventario

App web en español para registrar objetos desde el teléfono. Primera versión orientada a máquinas de escribir: tomar una foto, completar unos datos y guardar la ficha en un inventario central.

## Qué permite

- Crear, consultar, editar y eliminar fichas con códigos automáticos (`PRO-00001`).
- Guardar marca, modelo, fecha, tipo, destino y notas. Solo marca y destino son obligatorios.
- Consignar fechas abiertas, aproximadas o por intervalo: `ca. 1930`, `1950–1960`, `1954`.
- Elegir o escribir tipos nuevos; las marcas y tipos ya registrados aparecen como sugerencias.
- Asignar el destino **Museo**, **Tienda** u **Otros**, sin preselección automática.
- Tomar fotos con la cámara del teléfono o elegirlas de la galería. Hasta cinco fotos por objeto; la primera es la portada. Se reducen a un máximo de 1600 px y se guardan como JPEG.
- Buscar por código, marca, modelo, fecha, tipo, notas o destino; filtrar por destino y ordenar.
- Exportar metadatos a CSV con separador `;`, compatible con Excel. **El CSV no incluye los archivos de las fotografías ni es una copia de seguridad completa.**
- Proteger fichas y fotos con una contraseña compartida. Las sesiones duran siete días.
- Detectar ediciones simultáneas para evitar sobrescribir cambios de otro dispositivo.

Los datos se guardan en el servidor, no en el almacenamiento del navegador. La app necesita conexión con ese servidor para abrir y guardar el inventario. No incluye sincronización sin conexión.

## Instalación rápida

Requiere **Node.js 24 o superior**. No usa paquetes externos, servicios de pago ni una base de datos aparte. No es una aplicación PHP: no alcanza con copiarla a `htdocs` de XAMPP.

```bash
git clone https://github.com/frankhode/Prodigo_inventario.git
cd Prodigo_inventario
npm start
```

1. Abrí `http://localhost:3000` en la computadora donde lo iniciaste.
2. La consola muestra un **código de instalación de un solo uso**. Pegalo en el formulario inicial y elegí una contraseña de al menos diez caracteres.
3. Los siguientes accesos piden únicamente esa contraseña. Podés compartirla con las personas que carguen el inventario; todas tienen los mismos permisos.

El código de instalación cambia si reiniciás el servidor antes de completar el primer acceso. Después de configurarlo ya no se muestra. Las contraseñas se guardan mediante scrypt con una sal aleatoria; no se guardan en texto plano.

### Usarlo desde el teléfono

Con la computadora y el teléfono en la misma red Wi-Fi, abrí en el teléfono `http://IP-DE-LA-COMPUTADORA:3000`, por ejemplo `http://192.168.1.20:3000`. La computadora debe seguir encendida y el firewall debe permitir el puerto 3000 en la red local. `localhost` en el teléfono apunta al propio teléfono.

El botón **Tomar foto** utiliza el selector de cámara del sistema (`capture="environment"`); el comportamiento depende del navegador. **Elegir fotos** permite usar la galería. Si el navegador no decodifica una imagen HEIC/HEIF, la app pide una versión JPEG, PNG o WebP.

Podés agregar la página a la pantalla de inicio desde el navegador. El manifiesto ofrece apertura independiente cuando el navegador lo admite; no añade funcionamiento sin conexión.

## Configuración y publicación

Copiá `.env.example` como `.env` para cambiar el puerto o la carpeta de datos. `npm start` lee ese archivo automáticamente.

| Variable | Valor inicial | Uso |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Interfaz de escucha. |
| `PORT` | `3000` | Puerto del servidor. |
| `DATA_DIR` | `./data` junto al código | Carpeta persistente para SQLite y fotos. |
| `PUBLIC_ORIGIN` | Origen HTTP del servidor | URL externa exacta, sin barra final, cuando se usa un proxy HTTPS. |
| `SECURE_COOKIE` | `false` | Usar `true` cuando la URL pública tiene HTTPS. |

Para acceso por Internet, alojá el proceso Node detrás de HTTPS, configurá `PUBLIC_ORIGIN=https://tu-dominio` y `SECURE_COOKIE=true`, y asegurá un disco persistente para `DATA_DIR`. El proceso debe reiniciarse automáticamente con el sistema o el servicio de hosting. No lo publiques en un alojamiento estático ni en GitHub Pages: necesita ejecutar Node y escribir archivos. La contraseña y los datos no se suben al repositorio.

### Docker

```bash
docker build -t prodigo-inventario .
docker run -d --name prodigo --restart unless-stopped \
  -p 3000:3000 -v prodigo-data:/app/data prodigo-inventario
docker logs prodigo
```

Consultá los logs para obtener el código del primer acceso. Para publicar detrás de HTTPS, agregá las variables `PUBLIC_ORIGIN` y `SECURE_COOKIE=true` al contenedor. Conservá siempre el volumen `prodigo-data`.

## Copias de seguridad

La carpeta `data/` contiene `inventory.sqlite` y `photos/`. SQLite puede mantener además archivos `inventory.sqlite-wal` y `inventory.sqlite-shm` durante la ejecución.

1. Detené la aplicación (`Ctrl+C`, o `docker stop prodigo`).
2. Copiá **toda la carpeta de datos** o respaldá el volumen Docker completo.
3. Iniciá nuevamente la aplicación.

Para restaurar, con el servidor detenido, reemplazá la carpeta de datos por la copia completa y volvé a iniciar. La copia incluye contraseña y sesiones; tratala como información privada. No respaldes solo el CSV ni copies únicamente el `.sqlite` mientras el servidor está escribiendo.

Si olvidás la contraseña, una persona con acceso al servidor puede detenerlo, hacer una copia completa y borrar las filas de las tablas `settings` y `sessions` usando una herramienta SQLite. Al reiniciar aparece un nuevo código de instalación; las fichas y fotografías permanecen.

## Desarrollo y verificación

```bash
npm test
```

Las pruebas usan un servidor real y una carpeta temporal: instalación, autenticación, validación, fotografías, altas y cambios, conflictos entre ediciones, exportación CSV, persistencia después de reiniciar, eliminación y cierre de sesión. No tocan el inventario de uso diario.

Estructura: `server.js` sirve la API y el frontend; `public/` contiene la interfaz adaptable a teléfonos; `test/` contiene las pruebas. No hay paso de compilación.

Esta primera versión utiliza una contraseña compartida y un solo inventario. No incluye cuentas individuales, permisos diferenciados, historial de cambios ni lectura automática de datos a partir de las fotos.

