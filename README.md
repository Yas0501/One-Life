
One Life
Aplicación web para conocer tu índice de masa corporal (IMC) y cuidar tu peso: calculadora, plan de alimentación, registro de actividad física, progreso con gráficas, artículos de salud y un panel de administración con métricas de todos los usuarios.

Tecnologías
HTML, CSS y JavaScript sin frameworks ni compilación.
Supabase: base de datos PostgreSQL, cuentas (Auth), seguridad por fila (RLS) y una Edge Function.
Estructura
index.html                         Página (sitio público + app)
css/styles.css                     Estilos
js/config.js                       URL y clave pública de Supabase
js/db.js                           Capa de datos (cuentas, perfil, pesos, actividad, admin)
js/app.js                          Lógica de la app
supabase/schema.sql                Tablas, seguridad y métricas (se ejecuta en el SQL Editor)
supabase/functions/delete-user/    Función del servidor para borrar cuentas
SUPABASE.md                        Guía paso a paso de Supabase
Ejecutar en local
Abre la carpeta con cualquier servidor estático, por ejemplo:

npx http-server -p 5180
y entra en http://localhost:5180.

Publicar
Sirve la carpeta tal cual en GitHub Pages, Vercel o Netlify. Después, en Supabase → Authentication → URL Configuration, pon la dirección publicada como Site URL y agrégala a Redirect URLs.

Seguridad
js/config.js solo contiene la clave pública (anon). Es seguro subirla: los datos los protegen las políticas RLS.
La clave service_role nunca va en el código. La Edge Function la recibe de Supabase automáticamente.
One Life es una herramienta informativa y no sustituye el consejo médico profesional.
