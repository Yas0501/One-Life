// =====================================================================
// One Life — Edge Function "delete-user"
//
// Borra una cuenta de Supabase Auth (y, por "on delete cascade", su
// perfil, pesos, actividades y accesos).
//
//   - Sin user_id en el cuerpo  → la persona borra SU PROPIA cuenta.
//   - Con user_id de otra persona → solo lo permite si quien llama es admin.
//
// Necesita la clave service_role, por eso vive en el servidor y nunca
// en la página. Supabase la inyecta sola como SUPABASE_SERVICE_ROLE_KEY.
//
// Desde la app:
//   await supabase.functions.invoke('delete-user', { body: { user_id } })
// =====================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Debes iniciar sesión' }, 401);

  const url = Deno.env.get('SUPABASE_URL')!;

  // Cliente "como la persona que llama": respeta sus permisos y RLS.
  const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userError } = await caller.auth.getUser();
  if (userError || !user) return json({ error: 'Sesión no válida o expirada' }, 401);

  let body: { user_id?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // Cuerpo vacío: se interpreta como "borrar mi cuenta".
  }

  const targetId = body.user_id ?? user.id;
  if (typeof targetId !== 'string' || !UUID_RE.test(targetId)) {
    return json({ error: 'El identificador de usuario no es válido' }, 400);
  }

  // Cliente con privilegios totales: solo se usa después de comprobar permisos.
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  if (targetId !== user.id) {
    const { data: isAdmin, error: adminError } = await caller.rpc('is_admin');
    if (adminError || isAdmin !== true) {
      return json({ error: 'Solo un administrador puede eliminar otras cuentas' }, 403);
    }

    const { data: target, error: targetError } = await admin
      .from('profiles')
      .select('role')
      .eq('id', targetId)
      .maybeSingle();
    if (targetError) return json({ error: targetError.message }, 500);
    if (!target) return json({ error: 'La cuenta no existe' }, 404);
    if (target.role === 'admin') {
      return json({ error: 'Quita primero el rol de administrador a esa cuenta' }, 400);
    }
  } else {
    // Evita quedarse sin ningún administrador por accidente.
    const { data: me } = await admin.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (me?.role === 'admin') {
      const { count } = await admin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'admin');
      if ((count ?? 0) <= 1) {
        return json({ error: 'Eres el único administrador. Nombra otro antes de borrar tu cuenta' }, 400);
      }
    }
  }

  const { error } = await admin.auth.admin.deleteUser(targetId);
  if (error) return json({ error: error.message }, 400);

  return json({ ok: true, deleted: targetId });
});
