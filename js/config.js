/* ==========================================================================
   One Life — configuración de Supabase
   Copia estos dos valores desde: Supabase → Project Settings → API Keys
   (o "Connect" en la parte superior del panel del proyecto).

   La clave "anon" / "publishable" es PÚBLICA: está pensada para ir en la
   página. Lo que protege los datos son las políticas RLS de schema.sql.
   NUNCA pongas aquí la clave "service_role" / "secret".
   ========================================================================== */
window.ONE_LIFE_CONFIG = {
  supabaseUrl: 'https://ivcrurxrxdmjuxpgjash.supabase.co',
  supabaseKey: 'sb_publishable_rcb6Qqhe1vznrP8sfQ9HTQ_2Z1ABNXf',
};
