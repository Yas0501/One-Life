/* ==========================================================================
   One Life — configuración de Supabase (proyecto "One-Life")
   Valores tomados de: Supabase → Project Settings → API Keys.

   La clave "anon" es PÚBLICA: está pensada para ir en la página y puede
   subirse a GitHub. Lo que protege los datos son las políticas RLS de
   supabase/schema.sql. NUNCA pongas aquí la clave "service_role" / "secret".
   ========================================================================== */
window.ONE_LIFE_CONFIG = {
  supabaseUrl: 'https://ivcrurxrxdmjuxpgjash.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml2Y3J1cnhyeGRtanV4cGdqYXNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI5NjQxNjMsImV4cCI6MjEwODU0MDE2M30.RN5x45FBf-peoO7pNr4fciHntBJYNPMxPQiJbYlV0lE',

  // Correo de contacto que se muestra en la sección Contacto (déjalo vacío para ocultarlo).
  contactEmail: '',

  // Fondo interactivo de Unicorn Studio para la página de acceso (opcional).
  // Pega aquí el ID de tu proyecto publicado (Export → Embed). Vacío = fondo verde animado con CSS.
  unicornProjectId: '',
};
