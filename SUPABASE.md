
Guía de Supabase para One Life
Esta guía te lleva desde cero hasta tener One Life conectada a una base de datos real, con una cuenta de administrador capaz de ver métricas y borrar cuentas.

Archivos que vas a usar:

Archivo	Para qué sirve
supabase/schema.sql	Crea las tablas, la seguridad (usuario / admin) y las métricas. Se pega en Supabase.
supabase/functions/delete-user/index.ts	Función del servidor para borrar cuentas de forma segura.
js/config.js	Aquí pegas la URL y la clave pública de tu proyecto.
js/db.js	Funciones listas para usar desde la app: db.signIn(), db.upsertRecord(), db.admin.metrics()…
0. Qué es Supabase (en 2 minutos)
Supabase te da, sin montar un servidor:

Una base de datos PostgreSQL. Son tablas como las de Excel: cada tabla es una hoja (profiles, weight_records…), cada fila es un registro y cada columna es un dato (peso, fecha…).
Auth (cuentas). Registro, inicio de sesión, contraseñas cifradas, confirmación de correo y recuperación de contraseña. Las cuentas viven en una tabla interna llamada auth.users.
RLS (Row Level Security, seguridad por fila). Son reglas dentro de la base de datos que dicen quién puede ver o cambiar cada fila. Por ejemplo: "cada usuario solo ve sus pesos; el admin ve todos". Aunque alguien manipule la página, la base de datos no le entrega lo que no le corresponde.
Edge Functions. Pequeños programas que corren en el servidor de Supabase. Los usamos para borrar cuentas, porque eso requiere una clave secreta.
Las dos claves (muy importante)
Clave	Nombre en el panel	¿Puede ir en la página?
Pública	anon o publishable (empieza por eyJ… o sb_publishable_…)	Sí. Está hecha para eso. RLS es lo que protege los datos.
Secreta	service_role o secret (empieza por eyJ… o sb_secret_…)	Nunca. Ni en la página ni en GitHub. Salta todas las reglas de seguridad.
1. Crear tu proyecto
Entra en supabase.com → Start your project e inicia sesión con tu cuenta de GitHub.
New project:
Name: one-life
Database Password: pulsa Generate a password y guárdala en un gestor de contraseñas. No la necesitarás en la app, pero sí si algún día te conectas directo a la base.
Region: la más cercana a tus usuarios (por ejemplo East US si estás en México o Latinoamérica).
Pulsa Create new project y espera 1 o 2 minutos.
2. Copiar la URL y la clave pública
En tu proyecto, pulsa Connect (arriba) o ve a Project Settings → API Keys / Data API.
Copia:
Project URL → algo como https://abcdxyz.supabase.co
anon public o publishable key
Pégalas en js/config.js:
window.ONE_LIFE_CONFIG = {
  supabaseUrl: 'https://abcdxyz.supabase.co',
  supabaseKey: 'eyJhbGciOi...',   // la clave PÚBLICA
};
3. Crear las tablas, la seguridad y las métricas
En el menú izquierdo abre SQL Editor → New query.
Abre supabase/schema.sql, copia todo y pégalo.
Pulsa Run (o Ctrl + Enter). Debe aparecer Success. No rows returned.
Ve a Table Editor: verás profiles, weight_records, activities y login_events, todas con la etiqueta RLS enabled.
Si lo ejecutas dos veces no pasa nada: el archivo está preparado para eso.

Qué hace cada parte del archivo
1. Tablas

Tabla	Guarda	Detalle útil
profiles	Nombre, rol (user/admin), edad, sexo, altura, peso, objetivos, notificaciones	Su id es el mismo que el de la cuenta en auth.users
weight_records	Historial de peso	El IMC se calcula solo (columna generada). Solo puede haber un registro por persona y día.
activities	Actividad física	Solo acepta tipos válidos y de 1 a 600 minutos
login_events	Cada inicio de sesión	Base de la métrica "cuántos han iniciado sesión"
Las reglas check (...) repiten en la base de datos las mismas validaciones que ya hace la página. Aunque alguien se salte el formulario, no puede guardar, por ejemplo, un peso de 5000 kg.

on delete cascade significa que, al borrar una cuenta, se borran solos su perfil, pesos, actividades y accesos.

2. Funciones auxiliares

is_admin(): responde true si quien consulta es admin. Las políticas la usan para no repetir la misma condición en todas partes y para evitar un error clásico de Supabase: infinite recursion detected in policy.
handle_new_user(): cuando alguien se registra, crea su fila en profiles con el nombre que puso en el formulario.
protect_profile(): impide que un usuario se ponga role = 'admin' a sí mismo editando su perfil.
3. Seguridad por fila (RLS)

Tabla	Ver	Crear	Editar	Borrar
profiles	propio o admin	(automático al registrarse)	propio o admin	(solo con la función delete-user)
weight_records	propio o admin	propio	propio	propio o admin
activities	propio o admin	propio	—	propio o admin
login_events	propio o admin	propio	—	—
4. Métricas del administrador

Son funciones y no vistas, porque una vista normal ignora RLS y cualquiera podría leerla. Cada una comprueba primero que quien la llama sea admin; si no, responde Acceso denegado.

Función	Devuelve
admin_metrics()	Usuarios totales, nuevos en 30 días, activos en 7 días, inicios de sesión (total y hoy), peso promedio, IMC promedio, edad promedio y minutos de actividad promedio por semana
admin_bmi_distribution()	Cuántas personas hay en cada categoría de IMC, según su último peso
admin_logins_per_day(30)	Inicios de sesión y usuarios distintos por día (los días sin accesos aparecen con 0)
admin_list_users()	Tabla de usuarios: nombre, correo, rol, fecha de alta, último acceso, último peso, IMC y número de accesos
4. Configurar las cuentas (Auth)
En Authentication:

Sign In / Providers → Email: déjalo activado.

Confirm email: mientras desarrollas puedes desactivarlo para registrarte sin revisar el correo. Actívalo antes de publicar.
URL Configuration:

Site URL: la dirección donde publiques la app (por ejemplo https://tu-usuario.github.io/one-life/).
Redirect URLs: agrega también http://localhost:5180/** para tus pruebas locales.
Sin esto, los enlaces de confirmación y de recuperación de contraseña no te devolverán a la app.

Emails → Templates (opcional): traduce al español los correos de confirmación y recuperación.

Rate Limits: ya trae límites contra ataques de fuerza bruta, que complementan el bloqueo de 5 intentos que tiene la app.

El servidor de correo gratuito de Supabase envía pocos correos por hora y está pensado para pruebas. Para producción, configura uno propio (Resend, SendGrid…) en Authentication → Emails → SMTP Settings.

5. Conectar la página
La app ya está conectada. index.html carga, en este orden, el cliente de Supabase, tu configuración, la capa de datos y la app:

<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"></script>
<script src="js/config.js"></script>
<script src="js/db.js"></script>
<script src="js/app.js"></script>
Lo único que tienes que hacer es pegar tus datos en js/config.js (paso 2). Mientras sigan los valores de ejemplo, la página muestra arriba el aviso "La app no está conectada a la base de datos" y los formularios de acceso explican qué falta.

Para probar la conexión sin usar los formularios, abre la página, pulsa F12 → Console y escribe:

db.ready                                                    // true si config.js está bien
await db.signUp('Ana López', 'ana@correo.com', 'Segura123') // crea la cuenta
await db.signIn('ana@correo.com', 'Segura123')              // inicia sesión
await db.getMe()                                            // tu perfil
await db.updateProfile({ age: 29, sex: 'f', height: 168, weight: 64 })
await db.upsertRecord({ date: '2026-10-25', weight: 64, height: 168 })
await db.listRecords()                                      // verás el IMC calculado por la base
Después revisa Table Editor → weight_records: tu registro está ahí.

Cómo usa app.js la base de datos
Al iniciar sesión, app.js descarga tu perfil, tu historial de peso y tus actividades y los mantiene en memoria para que las pantallas respondan al instante. Cada vez que guardas o borras algo, primero lo escribe en Supabase y solo si sale bien actualiza la pantalla. Si falla (sin internet, un dato fuera de rango, la sesión expiró…), verás el mensaje en español en el formulario y no se pierde nada.

En el navegador solo quedan preferencias locales: si marcaste Recordarme, la hora de tu última actividad (para cerrar la sesión tras 30 minutos) y el contador de intentos fallidos.

Ejemplo, el inicio de sesión:

try {
  await db.signIn(email, password);   // Supabase verifica la contraseña
  await loadUserData();               // perfil, pesos y actividades
  location.hash = '#/app/resumen';
} catch (err) {
  formAlert(form, err.message);       // "Correo o contraseña incorrectos.", etc.
}
Qué llamada hace cada acción de la app:

Acción en la app	Llamada
Crear cuenta	db.signUp(name, email, password) (si devuelve needsConfirmation: true, muestra "revisa tu correo")
Cerrar sesión	db.signOut()
¿Hay sesión?	db.getSession() y db.onAuthChange(...)
Olvidé mi contraseña	db.sendPasswordReset(email)
Cambiar contraseña	db.changePassword(actual, nueva)
Leer / guardar perfil	db.getMe() / db.updateProfile({...})
Guardar IMC o peso	db.upsertRecord({ date, weight, height })
Historial	db.listRecords() / db.deleteRecord(id)
Actividad	db.listActivities() / db.addActivity({...}) / db.deleteActivity(id)
Eliminar mi cuenta	db.deleteAccount()
6. Crear tu cuenta de administrador
One Life usa una lista de correos de administrador (tabla admin_emails):

Quien se registra con un correo de la lista entra directamente como admin.
Si esa cuenta ya existía, se le asciende en el momento en que agregas el correo.
No se guarda ninguna contraseña en el código ni en la base: la eliges tú al registrarte.
La tabla tiene RLS sin políticas, así que nadie puede leerla ni cambiarla desde la app. Solo se gestiona desde el SQL Editor.
En el proyecto One-Life ya está configurado tu correo como admin predeterminado.

Abre la app, ve a Crear cuenta y regístrate con ese correo y la contraseña que quieras.
Para agregar otro administrador más adelante, ejecuta en SQL Editor:
insert into public.admin_emails (email) values ('otro_correo@ejemplo.com') on conflict do nothing;
También puedes hacerlo desde la propia app: Administración → Usuarios → Hacer administrador.

Inicia sesión. En la barra lateral aparecerá Administración, con:

8 tarjetas: usuarios, activos en 7 días, inicios de sesión de hoy, cuántos registraron su peso, peso promedio, IMC promedio, edad promedio y minutos de actividad por semana.
Gráfica de inicios de sesión por día, de los últimos 7, 30 o 90 días.
Personas por categoría de IMC.
Tabla de usuarios con buscador. En cada fila puedes hacer o quitar administrador y eliminar la cuenta; para eliminarla tienes que escribir el correo de esa persona.
No puedes eliminarte a ti mismo desde ahí (se hace en Perfil y ajustes → Seguridad), ni eliminar a otro administrador sin quitarle antes el rol. Esto lo vuelve a comprobar la función delete-user en el servidor.

Eliminar cuentas necesita que la función delete-user esté publicada (paso 7).

También puedes comprobarlo desde la consola del navegador con tu sesión iniciada:

await db.isAdmin()                // true
await db.admin.metrics()          // { usuarios: 1, peso_promedio: 64, ... }
await db.admin.bmiDistribution()
await db.admin.loginsPerDay(30)
await db.admin.listUsers()
Con una cuenta normal, esas mismas llamadas responden No tienes permiso para hacer esto. Así compruebas que la seguridad funciona.

No escribas el correo ni la contraseña del admin en el código. El rol se asigna en la base de datos, que es el único lugar donde nadie más puede cambiarlo.

Activa también la verificación en dos pasos en tu cuenta de Supabase (Account → Security).

7. Publicar la función para borrar cuentas
Hay dos formas. Elige una.

Opción A — Desde el panel (la más fácil)
Edge Functions → Deploy a new function → Via Editor.
Nombre: delete-user (exactamente así).
Borra el código de ejemplo, pega el contenido de supabase/functions/delete-user/index.ts y pulsa Deploy function.
Opción B — Con la terminal (Supabase CLI)
npx supabase login
npx supabase link --project-ref TU_PROJECT_REF
npx supabase functions deploy delete-user
TU_PROJECT_REF es la parte abcdxyz de tu URL https://abcdxyz.supabase.co.

No tienes que configurar ninguna clave: Supabase entrega sola a la función SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY.

Prueba (como admin, en la consola):

const usuarios = await db.admin.listUsers();
await db.admin.deleteUser(usuarios[1].id);   // borra a otra persona (no admin)
Qué comprueba la función antes de borrar:

que haya una sesión válida;
si se pide borrar a otra persona, que quien llama sea admin;
que no se borre a otro admin (primero hay que quitarle el rol);
que el único admin no pueda borrarse a sí mismo y dejar la app sin administrador.
8. Errores comunes
Mensaje	Causa	Solución
Supabase no está configurado en la consola	config.js sigue con TU-PROYECTO o falta un <script>	Pega tus datos y revisa el orden de los scripts
Invalid API key	Copiaste mal la clave o pegaste la secreta	Usa la anon / publishable
La consulta devuelve [] aunque hay datos	RLS: no hay sesión o la fila es de otra persona	Inicia sesión primero (db.signIn)
infinite recursion detected in policy	Una política de profiles consulta profiles directamente	Usa public.is_admin(), como en schema.sql
Email not confirmed	Está activado Confirm email	Confirma desde el correo o desactívalo mientras desarrollas
No llega el correo	Límite del servidor de correo gratuito	Espera, o configura tu propio SMTP
Acceso denegado en las métricas	La cuenta no es admin	Ejecuta el update ... set role = 'admin'
El enlace del correo lleva a localhost:3000	Site URL sin configurar	Ver paso 4, punto 2
Function not found	La función no se llama exactamente delete-user	Vuelve a publicarla con ese nombre
9. Lista de seguridad antes de publicar
 RLS activado en las 4 tablas (Table Editor muestra RLS enabled).
 En la página y en GitHub solo está la clave pública.
 Confirm email activado.
 Site URL y Redirect URLs apuntan a tu dominio real.
 Probaste que una cuenta normal no puede leer las métricas ni los datos de otros.
 Tu cuenta admin tiene una contraseña única y 2FA en Supabase.
 Aviso de privacidad visible al registrarse (el peso y el IMC son datos de salud).
10. Siguientes pasos
Ya hecho: la app guarda todo en Supabase y tiene la sección Administración.

Lo que queda:

Probar con tu proyecto real: pasos 1 a 7, de principio a fin, con dos cuentas (tú como admin y otra normal).
Recuperación de contraseña: el botón ¿Olvidaste tu contraseña? envía el correo, y el enlace abre Perfil y ajustes → Seguridad para escribir la nueva contraseña sin pedir la anterior. Pruébalo después de configurar las Redirect URLs (paso 4). El enlace debe abrirse en el mismo navegador donde lo pediste.
Alertas de seguridad: avisar por correo de un inicio de sesión desde un dispositivo nuevo, usando login_events.user_agent.
