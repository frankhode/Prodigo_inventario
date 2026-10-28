# Pródigo · Inventario

Inventario inicial de hasta unos 5.000 objetos, pensado para cargar desde el teléfono. App estática con Supabase para usuarios, metadatos y fotografías. El código queda en GitHub; las fichas y fotos quedan en Supabase.

## Carga

Seis pasos: **foto y objeto → marca → modelo → fecha → tipo → destino y revisión**.

- Una única foto por ficha, comprimida en el teléfono a JPEG de hasta **150 KiB**, con lado mayor inicial de hasta 1.200 px. Si hace falta, reduce calidad y dimensiones para cumplir el límite. Se puede reemplazar al editar.
- **Tomar foto** abre una vista de cámara dentro de la página, solicita la trasera con video limitado a 1.280 px por lado y 15 fps, sin audio, y captura directamente al tamaño reducido. Evita abrir primero una foto de cámara de resolución completa. Requiere permitir la cámara en el navegador. La cámara se libera al capturar, cancelar u ocultar la página; también si el permiso llega después de cancelar. Como alternativas quedan la galería y **Usar cámara del teléfono**, que abre la cámara nativa y puede consumir más memoria. Las fotos de galería liberan su imagen decodificada y el canvas al terminar.
- Clases iniciales: **Máquina de escribir, Fotografía y Velador**. El combo permite agregar otras.
- Marcas propias de cada clase de objeto; modelos asociados a la marca. Ambos pueden quedar vacíos cuando no corresponden.
- Fecha de texto libre, de fabricación, toma u otro momento asociado al objeto: `1930`, `ca. 1930`, `15/06/1950`, `1930–1940`. La columna interna y la clave JSON conservan el nombre `manufacture_date` para mantener compatibilidad con las fichas existentes; la interfaz y el CSV muestran **Fecha**.
- Tipos propios de cada clase; para máquinas de escribir: **Portátil / Escritorio**. Se pueden agregar tipos nuevos.
- Destino obligatorio: **Museo / Tienda / Otros**, sin preselección.
- Notas opcionales. Las opciones nuevas se incorporan al guardar la ficha y quedan disponibles para los demás usuarios.

Cada objeto recibe un identificador permanente como **P000001**, asignado por una secuencia central de PostgreSQL. No depende de marca, clase ni destino. Admite hasta P999999; puede haber saltos por operaciones fallidas, pero no se repiten números. El UUID interno permite reintentar un alta cuya respuesta se perdió sin duplicarla.

## Usuarios y trabajo simultáneo

Acceso individual por **usuario o correo y contraseña**. Usuarios previstos: **aleProdigo, franProdigo y maxiProdigo**. Los nombres no distinguen mayúsculas/minúsculas. La app no solicita tokens de GitHub ni guarda contraseñas. Las sesiones las gestiona el SDK oficial de Supabase. El acceso por correo sigue disponible aunque todavía no se haya publicado la función de acceso por usuario.

Todos los integrantes habilitados comparten el inventario y pueden editarlo. Se guarda el usuario creador y el último editor. La app está diseñada para tres teléfonos y puede admitir más: PostgreSQL asigna los números y serializa las ediciones de una misma ficha. Si otra persona guardó primero, se rechaza la revisión antigua y se conservan los datos en el formulario. Copialos antes de cerrar la ficha, actualizá y volvé a editar. El listado se actualiza al regresar a la app, cada minuto si está visible y sin ficha abierta, o con **Actualizar**.

Los usuarios nuevos requieren una membresía en `inventory_members`, creada manualmente para Fran o automáticamente al canjear las invitaciones de Ale y Maxi. Tener una cuenta Supabase Auth no alcanza para leer o modificar el inventario. No hay registro público desde la app. Los nombres de usuario se resuelven exclusivamente en una Edge Function: no se publica un listado que los vincule con correos.

## Configuración

### 1. Crear el proyecto gratuito

En [Supabase](https://supabase.com/), crear un proyecto **Free**. El uso previsto no requiere contratar un plan. Los límites del proveedor pueden cambiar: revisar su [página de precios](https://supabase.com/pricing).

Con el plan actual, 5.000 fotos de 150 KiB ocupan como máximo unos 732 MiB, antes de considerar archivos huérfanos o reemplazos pendientes de limpieza. El plan incluye 1 GB de archivos, 500 MB de base y cuotas mensuales de transferencia. Un proyecto gratuito puede pausarse tras una semana de inactividad y no incluye respaldos automáticos. Hacer copias periódicas; una descarga completa de fotos también consume transferencia.

### 2. Crear la base y las reglas de acceso

En **SQL Editor**, ejecutar una vez el contenido de:

[`supabase/migrations/202610280001_inventory.sql`](supabase/migrations/202610280001_inventory.sql)

El script está pensado para un proyecto nuevo. Crea las tablas, la secuencia, el guardado transaccional y un bucket privado `inventory-photos` limitado a JPEG de 150 KiB. Habilita RLS. Los navegadores no pueden escribir directamente las tablas: usan una función que comprueba permisos, campos y revisión de la ficha.

### 3. Crear y habilitar las cuentas

En **Authentication → Users**, crear las cuentas por correo y contraseña, marcando el correo como confirmado si se crea manualmente. Mantener las altas públicas desactivadas hasta instalar la validación de invitaciones del apartado 3c. Para recuperar acceso, la persona administradora gestiona la cuenta desde Supabase; esta versión no incluye recuperación de contraseña en la interfaz.

Por cada persona, copiar su UUID de Authentication y ejecutar (reemplazando los valores del ejemplo):

```sql
insert into public.inventory_members(user_id, display_name)
values ('UUID-DE-AUTHENTICATION', 'Nombre de la persona');
```

Para quitar acceso al inventario:

```sql
delete from public.inventory_members where user_id = 'UUID-DE-AUTHENTICATION';
```

Las fotos ya abiertas mediante un enlace firmado pueden seguir disponibles hasta que expire ese enlace, como máximo una hora.

### 3b. Activar los nombres de usuario

Después de la primera migración, ejecutar una sola vez en SQL Editor:

[`supabase/migrations/202610280002_usernames.sql`](supabase/migrations/202610280002_usernames.sql)

Agrega nombres únicos a las membresías existentes y vincula **franProdigo** con la cuenta de Fran ya configurada. Conserva sus contraseña, UUID y fichas. Los nombres no son contraseñas ni conceden acceso por sí solos.

Ale y Maxi crearán sus cuentas desde sus enlaces de alta, con sus propios correos y contraseñas. No hace falta conocer sus correos ni crearlos desde el panel; ver **3c**. Fran conserva su cuenta existente.

Publicar la función **super-responder** desde **Edge Functions → Deploy a new function → Via Editor**:

1. El proyecto actual la publicó con el nombre `super-responder`; conservar ese nombre. El código fuente se mantiene en la carpeta `inventory-login`.
2. Reemplazar el ejemplo del editor con el contenido completo de [`supabase/functions/inventory-login/index.js`](supabase/functions/inventory-login/index.js). Es JavaScript compatible con el archivo `index.ts` del editor; no requiere archivos auxiliares ni imports.
3. Publicar la función y, en su configuración, dejar **Verify JWT** desactivado: el visitante aún no tiene sesión. La función comprueba el usuario y la contraseña con Supabase Auth antes de emitir una sesión.
4. Los secretos del proyecto se obtienen dentro del runtime de Supabase, desde `SUPABASE_SECRET_KEYS` y `SUPABASE_PUBLISHABLE_KEYS`; admite las variables anteriores como respaldo. No copiarlos al navegador ni al repositorio. No se necesita pegar una clave secreta en el código.

La función acepta solicitudes del origen `https://frankhode.github.io` y de localhost:3000 para desarrollo. Para otro alojamiento, definir `INVENTORY_ALLOWED_ORIGINS` en los secretos de la función como lista de orígenes separados por coma. CORS no reemplaza la comprobación de contraseña. Los intentos de acceso se validan en Supabase Auth y se conservan sus respuestas de límite de intentos. Los usuarios desconocidos y las contraseñas incorrectas dan el mismo mensaje genérico; las respuestas no se almacenan en caché.

Si se usa la CLI, `supabase/config.toml` ya declara el entrypoint y `verify_jwt = false`. Desplegar con `supabase functions deploy super-responder --project-ref TU-PROJECT-REF`. No es necesario instalar la integración de Supabase en ChatGPT para realizar estos pasos desde el panel.

### 3c. Primer ingreso de Ale y Maxi

La app incluye **Crear mi cuenta**. Cada persona registra su correo y elige una contraseña de al menos diez caracteres. Su enlace de un solo uso ya selecciona el nombre correspondiente; no puede usar el enlace de la otra persona.

1. Mantener **Allow new users to sign up** desactivado mientras se instala la validación.
2. Ejecutar una sola vez en SQL Editor [`supabase/migrations/202610280003_self_registration.sql`](supabase/migrations/202610280003_self_registration.sql). Los resultados muestran dos filas con los enlaces de alta para **aleProdigo** y **maxiProdigo**. Guardar esos enlaces y compartir cada uno solo con la persona correspondiente, una vez publicada la app. No se necesita conocer sus correos. Los enlaces apuntan a la dirección prevista de GitHub Pages y funcionarán después de publicarla.
3. Después de que el SQL termine correctamente, activar **Allow new users to sign up** en **Authentication → Sign In / Providers** y guardar. El registro sigue restringido por la base: cada nueva cuenta necesita una de las dos invitaciones válidas. Las cuentas sin código, con código vencido, consumido o de otro nombre se rechazan en la propia transacción de Supabase Auth.
4. Mantener **Confirm email** desactivado si se desea el ingreso inmediato elegido para este inventario. Si se activa, cada persona deberá confirmar su correo antes de entrar.
5. Publicar la app. Al abrir su enlace, Ale/Maxi verán el formulario de primer ingreso. Después podrán entrar con usuario o correo y contraseña, sin volver a usar el enlace.

El alta usa el servicio nativo de Supabase Auth. La función `super-responder` ya publicada sigue atendiendo el login por nombre; no necesita cambios para el registro. Los triggers de la tercera migración crean automáticamente la membresía y consumen la invitación en la misma transacción. Si falla el alta, no se consume el código. No se guardan contraseñas en el SQL ni en la app. Los códigos se generan dentro del proyecto, se guardan como hashes y se quitan de los metadatos del usuario.

Las invitaciones vencen a los 30 días. Para reemplazar un enlace pendiente, ejecutar desde SQL Editor:

```sql
select * from public.create_inventory_invite('aleProdigo');
```

El resultado da el nombre y el nuevo código; el anterior deja de funcionar. Puede usarse en **Crear mi cuenta**, pegando el código, o reconstruirse el enlace con `#alta=aleProdigo&codigo=CODIGO`. Repetir con `maxiProdigo` si corresponde. Una cuenta ya registrada no admite otra invitación; su contraseña se gestiona desde Authentication. Las altas desde el panel también pasan por esta validación: este proyecto está dedicado a las tres cuentas del inventario.

### 4. Conectar la app

En el diálogo **Connect** o **Settings → API Keys**, obtener la URL del proyecto y su **publishable key** (`sb_publishable_…`). Completar `public/config.js`:

```js
globalThis.PRODIGO_CONFIG = Object.freeze({
  supabaseUrl: 'https://TU-PROYECTO.supabase.co',
  loginFunction: 'super-responder',
  publishableKey: 'sb_publishable_…'
});
```

Estos dos valores son públicos: la protección real son las sesiones y las reglas RLS. **Nunca usar `sb_secret_…` ni `service_role` en este archivo, en el navegador o en GitHub.** La aplicación rechaza esas claves. No hacen falta claves secretas para operar esta app.

Hasta completar la configuración, la app muestra una pantalla de preparación, sin inventario ficticio.

## Probar y publicar

Requiere Node.js 22 o superior para desarrollar; el sitio publicado no necesita Node ni una computadora encendida.

```bash
npm ci
npm test
npm run build
npm start
```

Abrir `http://localhost:3000`. El servidor solo entrega el contenido de `dist/`. Las fotos del teléfono necesitan un navegador que decodifique su formato; para HEIC no compatible, usar JPEG. La toma de foto real depende del navegador y debe comprobarse en cada teléfono.

Para alojar gratuitamente en GitHub Pages:

1. Incorporar los cambios y la configuración pública a `main`.
2. En **Settings → Pages**, seleccionar **GitHub Actions**.
3. Cada actualización de `main` ejecuta **Publicar en GitHub Pages** automáticamente. También puede iniciarse desde **Actions → Publicar en GitHub Pages → Run workflow**, eligiendo `main`.
4. Abrir la URL HTTPS de Pages desde los teléfonos. Las rutas son relativas, compatibles con `/Prodigo_inventario/`.

El workflow publica al actualizar `main` o por ejecución manual, después de superar las pruebas y la compilación. No se crea un proyecto de pago ni se publica al abrir un PR. La app necesita conexión a Supabase; no incluye captura sin conexión. Se puede agregar a la pantalla de inicio, pero no es una app offline.

## Exportación y migración futura

Las exportaciones incluyen **todo el inventario cargado**, aunque haya filtros activos:

- **CSV:** compatible con Excel, separador `;`. Incluye identificador, clase, marca, modelo, año, tipo, destino, notas, nombre de la foto, fechas y UUID de creador/editor. Las celdas que podrían ejecutarse como fórmulas se protegen al exportar.
- **JSON:** conserva UUID, identificador legible, revisión, fechas, autores, vocabularios y rutas de las fotos. No incluye los archivos fotográficos.
- **Respaldo con fotos:** ZIP con CSV, JSON y `fotos/P000001.jpg`, etc. Si no se puede descargar alguna foto, se incluye `FOTOS_FALTANTES.txt` y se informa que el respaldo está incompleto.

En navegadores con escritura directa a disco, el respaldo se genera como un ZIP. En teléfonos y otros navegadores, se divide en partes de hasta 200 fotos para no agotar la memoria: presionar **Descargar parte…** hasta completar todas. Cada parte incluye el inventario completo en JSON/CSV; reunir las carpetas `fotos/` para recuperar todas las imágenes. Mantener la página abierta y hacer el respaldo grande preferentemente desde una computadora. Los respaldos contienen datos del inventario y deben guardarse en un lugar adecuado.

Los cambios guardados durante un respaldo pueden requerir otro respaldo posterior. No hay restauración automática ni importación en esta versión; el formato exportado permite desarrollar la migración al sistema formal conservando los identificadores.

## Verificación

`npm test` ejecuta las migraciones SQL reales en PostgreSQL embebido (PGlite), con esquemas mínimos para simular Supabase Auth y Storage. Comprueba permisos —incluso ante privilegios por defecto amplios—, secuencia central, tres usuarios, nombres únicos privados, altas por invitación y su consumo atómico, reintentos de altas, conflictos de revisión, clases y vocabularios nuevos, fotos privadas y exportaciones. También prueba el manejador real de la Edge Function con respuestas HTTP controladas: resolución privada del nombre, validación de contraseña, errores genéricos, límite de intentos, CORS y límites de entrada.

Esto no reemplaza una prueba en un proyecto Supabase real: quedan por comprobar autenticación alojada, políticas con Storage real, tres teléfonos concurrentes y la cámara física. La compilación incluye el SDK de Supabase y la librería ZIP localmente; no descarga código de terceros al abrir la app.

## Versión anterior

La primera versión con Node/SQLite queda en el historial de Git, en el commit `7e49673025563f81a98cc0ebabdc8fb753881be7`. Esta versión no lee ni borra la antigua carpeta `data/`; si se usó el prototipo, conservarla antes de cambiar. La migración automática desde SQLite no está incluida.

## Editar y borrar registros

Cada tarjeta muestra **Editar ficha**. Al abrirla, se pueden modificar los datos o reemplazar la foto y terminar con **Guardar cambios**. Se conserva el identificador.

Para habilitar **Borrar registro** en un proyecto existente, ejecutar una vez en SQL Editor [supabase/migrations/202610280004_delete_items.sql](supabase/migrations/202610280004_delete_items.sql). No modifica registros existentes. Los tres integrantes habilitados pueden borrar fichas de cualquier integrante; se exige confirmar el código y se rechaza el borrado si otra persona editó una revisión más reciente. El borrado es definitivo y los identificadores no se reutilizan. Los vocabularios compartidos se conservan. La foto se limpia mediante Storage después de confirmar el borrado de la ficha; si esa limpieza falla, se informa que el archivo quedó pendiente. Las copias exportadas previamente conservan sus datos.
