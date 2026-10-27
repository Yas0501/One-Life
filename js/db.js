/* ==========================================================================
   One Life — capa de datos con Supabase
   Expone window.db con todo lo que la app necesita: cuentas, perfil,
   pesos, actividades, sugerencias y métricas del administrador.

   Todas las funciones son async y lanzan un Error con un mensaje en
   español si algo falla, así que se usan con try/catch:

     try {
       await db.signIn(email, password);
     } catch (err) {
       formAlert(form, err.message);
     }

   Requiere, en este orden, antes de app.js:
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"></script>
     <script src="js/config.js"></script>
     <script src="js/db.js"></script>
   ========================================================================== */
(() => {
  'use strict';

  const cfg = window.ONE_LIFE_CONFIG || {};
  const configured = Boolean(window.supabase && cfg.supabaseUrl && cfg.supabaseKey && !cfg.supabaseUrl.includes('TU-PROYECTO'));

  if (!configured) {
    console.warn('[One Life] Supabase no está configurado. Revisa js/config.js.');
    window.db = { ready: false };
    return;
  }

  const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    // PKCE: los enlaces de los correos vuelven con ?code=... y no pisan las rutas #/... de la app
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  });

  /* ------------------------------------------------------------------
     Errores: traduce los mensajes de Supabase a algo entendible
     ------------------------------------------------------------------ */
  const ERRORS = [
    [/invalid login credentials/i, 'Correo o contraseña incorrectos.'],
    [/user already registered|already been registered/i, 'Ya existe una cuenta con este correo. Inicia sesión.'],
    [/email not confirmed/i, 'Confirma tu correo: te enviamos un enlace al registrarte.'],
    [/password should be at least/i, 'La contraseña es demasiado corta.'],
    [/same.*password|new password should be different/i, 'La nueva contraseña debe ser distinta de la actual.'],
    [/rate limit|too many requests|security purposes/i, 'Demasiados intentos. Espera un momento y vuelve a intentarlo.'],
    [/jwt expired|refresh token|session.*missing|not authenticated/i, 'Tu sesión expiró. Vuelve a iniciar sesión.'],
    [/acceso denegado|permission denied|42501/i, 'No tienes permiso para hacer esto.'],
    [/duplicate key.*weight_records/i, 'Ya tienes un registro de peso ese día.'],
    // Mensajes que lanzan los triggers de supabase/schema.sql
    [/database error saving new user|terminos_no_aceptados/i, 'Para crear tu cuenta debes aceptar los Términos y condiciones y la Política de privacidad.'],
    [/demasiados_mensajes/i, 'Enviaste varios mensajes seguidos. Espera unos minutos antes de mandar otro.'],
    [/violates check constraint/i, 'Alguno de los datos está fuera del rango permitido.'],
    [/failed to fetch|network/i, 'No hay conexión con el servidor. Revisa tu internet.'],
  ];

  function fail(error, fallback = 'Ocurrió un error inesperado. Inténtalo de nuevo.') {
    const raw = error?.message || error?.error_description || String(error || '');
    const match = ERRORS.find(([re]) => re.test(raw) || re.test(error?.code || ''));
    const err = new Error(match ? match[1] : fallback);
    err.cause = error;
    console.error('[One Life]', error);
    throw err;
  }

  /** Ejecuta una consulta de Supabase y devuelve data o lanza un error en español. */
  async function run(promise) {
    const { data, error } = await promise;
    if (error) fail(error);
    return data;
  }

  async function requireUser() {
    const { data: { user } } = await client.auth.getUser();
    if (!user) fail({ message: 'not authenticated' });
    return user;
  }

  /* ------------------------------------------------------------------
     Conversión entre el formato de la app y el de la base de datos
     ------------------------------------------------------------------ */
  const profileFromRow = (row, email) => ({
    id: row.id,
    name: row.name,
    email,
    role: row.role,
    createdAt: row.created_at,
    notifications: row.notifications,
    profile: {
      age: row.age,
      sex: row.sex || '',
      height: row.height_cm === null ? null : Number(row.height_cm),
      weight: row.weight_kg === null ? null : Number(row.weight_kg),
      goal: row.goal,
      target: row.target_kg === null ? null : Number(row.target_kg),
      level: row.level,
      minutesGoal: row.minutes_goal,
    },
  });

  const PROFILE_FIELDS = {
    name: 'name', age: 'age', sex: 'sex', height: 'height_cm', weight: 'weight_kg',
    goal: 'goal', target: 'target_kg', level: 'level', minutesGoal: 'minutes_goal',
    notifications: 'notifications',
  };

  const recordFromRow = (r) => ({ id: r.id, date: r.date, weight: Number(r.weight_kg), height: Number(r.height_cm), bmi: Number(r.bmi) });
  const activityFromRow = (a) => ({ id: a.id, date: a.date, type: a.type, minutes: a.minutes, steps: a.steps, kcal: a.kcal, created: a.created_at });

  /* ------------------------------------------------------------------
     API pública
     ------------------------------------------------------------------ */
  window.db = {
    ready: true,
    client, // acceso directo por si necesitas algo que no esté aquí

    /* ---------- Cuentas ---------- */
    /**
     * consent = { terms: true, privacy: true, version: '1.0' }
     * El trigger handle_new_user rechaza el registro si falta alguno de los dos.
     */
    async signUp(name, email, password, consent = {}) {
      const data = await run(client.auth.signUp({
        email,
        password,
        options: {
          // Lo usa el trigger handle_new_user para crear el perfil y guardar la aceptación
          data: {
            name,
            accepted_terms: consent.terms === true,
            accepted_privacy: consent.privacy === true,
            legal_version: consent.version || '',
          },
          emailRedirectTo: `${location.origin}${location.pathname}#/acceso`,
        },
      }));
      // Con "Confirm email" activado, Supabase no da error si el correo ya existe
      // (para no revelar qué correos están registrados): devuelve un usuario sin identidades.
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        throw new Error('Ya existe una cuenta con este correo. Inicia sesión.');
      }
      // Si "Confirm email" está activado, no hay sesión hasta confirmar el correo.
      return { user: data.user, needsConfirmation: !data.session };
    },

    async signIn(email, password) {
      const data = await run(client.auth.signInWithPassword({ email, password }));
      // Registro del acceso para las métricas (si falla, no bloquea el login).
      await client.from('login_events').insert({ user_agent: navigator.userAgent.slice(0, 200) });
      return data.user;
    },

    async signOut() {
      await run(client.auth.signOut());
    },

    async getSession() {
      const { data } = await client.auth.getSession();
      return data.session;
    },

    /** Avisa cuando la sesión cambia (login, logout, expiración, otra pestaña). */
    onAuthChange(callback) {
      return client.auth.onAuthStateChange((event, session) => callback(event, session));
    },

    async sendPasswordReset(email) {
      await run(client.auth.resetPasswordForEmail(email, {
        redirectTo: `${location.origin}${location.pathname}#/app/perfil?tab=seguridad`,
      }));
    },

    /** Supabase no pide la contraseña actual; la comprobamos antes iniciando sesión con ella. */
    async changePassword(currentPassword, newPassword) {
      const user = await requireUser();
      const { error } = await client.auth.signInWithPassword({ email: user.email, password: currentPassword });
      if (error) throw new Error('La contraseña actual no es correcta.');
      await run(client.auth.updateUser({ password: newPassword }));
    },

    /** Tras abrir el enlace de "recuperar contraseña" ya hay sesión: basta con fijar la nueva. */
    async setNewPassword(newPassword) {
      await run(client.auth.updateUser({ password: newPassword }));
    },

    /** Últimos inicios de sesión propios (el primero es el actual). */
    async recentLogins(limit = 2) {
      const rows = await run(client.from('login_events').select('created_at').order('created_at', { ascending: false }).limit(limit));
      return rows.map((r) => r.created_at);
    },

    /** Borra la cuenta propia (o, siendo admin, la de otra persona). */
    async deleteAccount(userId) {
      const { data, error } = await client.functions.invoke('delete-user', { body: userId ? { user_id: userId } : {} });
      if (error) {
        // Si la función respondió con un error, su mensaje viene en el cuerpo de la respuesta.
        let message = '';
        try { message = (await error.context.json()).error; } catch { /* sin cuerpo JSON */ }
        if (message) throw new Error(message);
        fail(error, 'No se pudo eliminar la cuenta.');
      }
      if (!userId) await client.auth.signOut();
      return data;
    },

    /* ---------- Perfil ---------- */
    async getMe() {
      const user = await requireUser();
      const row = await run(client.from('profiles').select('*').eq('id', user.id).single());
      return profileFromRow(row, user.email);
    },

    /** Recibe campos con nombres de la app: { name, age, sex, height, weight, goal, target, level, minutesGoal, notifications } */
    async updateProfile(changes) {
      const user = await requireUser();
      const row = {};
      Object.entries(changes).forEach(([key, value]) => {
        if (!(key in PROFILE_FIELDS)) return;
        row[PROFILE_FIELDS[key]] = value === '' ? null : value;
      });
      const updated = await run(client.from('profiles').update(row).eq('id', user.id).select().single());
      return profileFromRow(updated, user.email);
    },

    /* ---------- Historial de peso ---------- */
    async listRecords() {
      const rows = await run(client.from('weight_records').select('*').order('date', { ascending: true }));
      return rows.map(recordFromRow);
    },

    /** Crea o reemplaza el registro de esa fecha. */
    async upsertRecord({ date, weight, height }) {
      const row = await run(client
        .from('weight_records')
        .upsert({ date, weight_kg: weight, height_cm: height }, { onConflict: 'user_id,date' })
        .select()
        .single());
      return recordFromRow(row);
    },

    async deleteRecord(id) {
      await run(client.from('weight_records').delete().eq('id', id));
    },

    /* ---------- Actividad ---------- */
    async listActivities({ sinceDays = 90 } = {}) {
      const since = new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 10);
      const rows = await run(client
        .from('activities')
        .select('*')
        .gte('date', since)
        .order('date', { ascending: false })
        .order('created_at', { ascending: false }));
      return rows.map(activityFromRow);
    },

    async addActivity({ date, type, minutes, steps = 0, kcal = 0 }) {
      const row = await run(client.from('activities').insert({ date, type, minutes, steps, kcal }).select().single());
      return activityFromRow(row);
    },

    async deleteActivity(id) {
      await run(client.from('activities').delete().eq('id', id));
    },

    /* ---------- Sugerencias y comentarios ---------- */
    /**
     * Cualquiera puede enviar (con o sin sesión), pero nadie puede leerlas
     * salvo el administrador. Por eso no se pide la fila de vuelta (.select()).
     * row = { name, email, kind, rating, message }
     */
    async sendFeedback(row) {
      await run(client.from('feedback').insert({
        name: row.name,
        email: row.email,
        kind: row.kind,
        rating: row.rating || null,
        message: row.message,
      }));
    },

    /* ---------- Administrador ---------- */
    async isAdmin() {
      const { data, error } = await client.rpc('is_admin');
      return !error && data === true;
    },

    admin: {
      /** { usuarios, nuevos_30_dias, activos_7_dias, inicios_sesion_total, inicios_sesion_hoy,
            con_registro_de_peso, peso_promedio, imc_promedio, edad_promedio, minutos_promedio_semana } */
      metrics: () => run(client.rpc('admin_metrics')),

      /** [{ categoria, orden, usuarios }] */
      bmiDistribution: () => run(client.rpc('admin_bmi_distribution')),

      /** [{ dia, inicios, usuarios }] */
      loginsPerDay: (dias = 30) => run(client.rpc('admin_logins_per_day', { dias })),

      /** [{ id, name, email, role, created_at, last_sign_in_at, weight_kg, bmi, logins }] */
      listUsers: () => run(client.rpc('admin_list_users')),

      deleteUser: (userId) => window.db.deleteAccount(userId),

      async setRole(userId, role) {
        await run(client.from('profiles').update({ role }).eq('id', userId));
      },

      /** [{ id, name, email, kind, rating, message, status, created_at, user_id }] */
      listFeedback: (limit = 100) => run(client
        .from('feedback')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit)),

      async setFeedbackStatus(id, status) {
        await run(client.from('feedback').update({ status }).eq('id', id));
      },

      async deleteFeedback(id) {
        await run(client.from('feedback').delete().eq('id', id));
      },

    },
  };
})();
