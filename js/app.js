/* ==========================================================================
   One Life — lógica de la aplicación
   SPA con rutas por hash. Cuentas y datos en Supabase a través de window.db
   (js/db.js). El navegador solo guarda preferencias locales (recordarme,
   inactividad, intentos fallidos).
   ========================================================================== */
(() => {
  'use strict';

  /* ------------------------------------------------------------------
     Utilidades
     ------------------------------------------------------------------ */
  // El scroll lo gestiona la app: el navegador no debe restaurar posiciones viejas al cambiar de vista
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const escapeHTML = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const round1 = (n) => Math.round(n * 10) / 10;
  const fmt = (n, d = 1) => Number(n).toLocaleString('es', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtInt = (n) => Math.round(n).toLocaleString('es');
  const fmtNum = (n) => Number(n).toLocaleString('es', { maximumFractionDigits: 1 });

  const todayISO = () => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  };
  const isoDaysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  };
  const parseISO = (iso) => new Date(`${iso}T00:00:00`);
  const fmtDate = (iso, opts = { day: 'numeric', month: 'short' }) => parseISO(iso).toLocaleDateString('es', opts);
  const fmtDateTime = (ts) => new Date(ts).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' });
  const fmtStamp = (ts) => new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });

  /** Convierte texto a número aceptando coma decimal. Devuelve NaN si no es un número limpio. */
  const parseNum = (value) => {
    const s = String(value ?? '').trim().replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
    return Number(s);
  };

  /* ------------------------------------------------------------------
     Almacenamiento local: solo preferencias de este navegador
     ------------------------------------------------------------------ */
  const storage = (() => {
    const available = (area) => {
      try {
        const k = '__ol_test__';
        area.setItem(k, '1');
        area.removeItem(k);
        return true;
      } catch { return false; }
    };
    const hasLocal = available(window.localStorage);
    const hasSession = available(window.sessionStorage);
    const memory = new Map();

    const area = (persist) => (persist ? (hasLocal ? localStorage : null) : (hasSession ? sessionStorage : null));

    return {
      ok: hasLocal,
      get(key, fallback, persist = true) {
        try {
          const a = area(persist);
          const raw = a ? a.getItem(key) : memory.get(key);
          return raw ? JSON.parse(raw) : fallback;
        } catch { return fallback; }
      },
      set(key, value, persist = true) {
        try {
          const raw = JSON.stringify(value);
          const a = area(persist);
          if (a) a.setItem(key, raw); else memory.set(key, raw);
          return true;
        } catch { return false; }
      },
      remove(key) {
        try { localStorage.removeItem(key); } catch { /* sin acceso */ }
        try { sessionStorage.removeItem(key); } catch { /* sin acceso */ }
        memory.delete(key);
      },
    };
  })();

  const KEYS = {
    attempts: 'ol.attempts',      // intentos fallidos por correo
    feedbackAt: 'ol.feedbackAt',  // último mensaje de contacto enviado (anti-spam local)
    remember: 'ol.remember',      // "Recordarme" marcado
    alive: 'ol.alive',            // sessionStorage: la pestaña sigue abierta
    lastActive: 'ol.lastActive',  // última interacción, para el cierre por inactividad
  };

  const db = window.db || { ready: false };

  /* ------------------------------------------------------------------
     Datos de dominio
     ------------------------------------------------------------------ */
  const BMI_CATS = [
    { key: 'bajo', label: 'Bajo peso', min: 0, max: 18.5, range: '< 18.5',
      msg: 'Tu peso está por debajo del rango saludable. Prioriza comidas nutritivas y densas en energía y consulta a un profesional si has perdido peso sin buscarlo.' },
    { key: 'normal', label: 'Peso normal', min: 18.5, max: 25, range: '18.5 – 24.9',
      msg: '¡Vas por buen camino! Tu IMC está en el rango saludable. Mantén tus buenos hábitos de alimentación y actividad.' },
    { key: 'sobrepeso', label: 'Sobrepeso', min: 25, max: 30, range: '25 – 29.9',
      msg: 'Tu IMC está ligeramente por encima del rango saludable. Pequeños cambios constantes en alimentación y movimiento marcan la diferencia.' },
    { key: 'ob1', label: 'Obesidad I', min: 30, max: 35, range: '30 – 34.9',
      msg: 'Tu IMC indica obesidad grado I. Te recomendamos combinar un plan de alimentación con actividad regular y apoyo profesional.' },
    { key: 'ob2', label: 'Obesidad II', min: 35, max: 40, range: '35 – 39.9',
      msg: 'Tu IMC indica obesidad grado II. Es importante contar con seguimiento médico para definir un plan seguro.' },
    { key: 'ob3', label: 'Obesidad III', min: 40, max: Infinity, range: '≥ 40',
      msg: 'Tu IMC indica obesidad grado III. Consulta con un profesional de salud: un acompañamiento especializado es clave.' },
  ];

  const ACTIVITY_LEVELS = { sedentario: 1.2, ligero: 1.375, moderado: 1.55, intenso: 1.725 };
  const LEVEL_LABEL = { sedentario: 'Sedentario', ligero: 'Ligero', moderado: 'Moderado', intenso: 'Intenso' };
  const GOAL_LABEL = { perder: 'Perder peso', mantener: 'Mantener peso', ganar: 'Ganar masa' };

  const ACTIVITY_TYPES = [
    { key: 'caminata', label: 'Caminata', met: 3.5, icon: 'fa-person-walking' },
    { key: 'correr', label: 'Correr', met: 9.8, icon: 'fa-person-running' },
    { key: 'ciclismo', label: 'Ciclismo', met: 7.5, icon: 'fa-person-biking' },
    { key: 'natacion', label: 'Natación', met: 6, icon: 'fa-person-swimming' },
    { key: 'fuerza', label: 'Entrenamiento de fuerza', met: 5, icon: 'fa-dumbbell' },
    { key: 'yoga', label: 'Yoga / estiramientos', met: 2.5, icon: 'fa-spa' },
    { key: 'hiit', label: 'HIIT', met: 8, icon: 'fa-bolt' },
    { key: 'baile', label: 'Baile', met: 5, icon: 'fa-music' },
  ];

  /* Recetas: viven en la tabla "meals" de Supabase (el administrador las edita) y se cargan al iniciar sesión. */
  let MEALS = [];
  const MEAL_LABEL = { desayuno: 'Desayuno', almuerzo: 'Almuerzo', cena: 'Cena', snack: 'Snack' };
  /** La imagen puede ser el ID de una foto de Unsplash (photo-…) o un enlace https completo. */
  const isUnsplash = (img) => /^photo-/.test(img);
  const mealImage = (m, w = 640) => (isUnsplash(m.img) ? `https://images.unsplash.com/${m.img}?auto=format&fit=crop&w=${w}&q=70` : m.img);

  /** Tarjeta de comida (la misma en el plan, en el panel de administración y en su vista previa). */
  function mealCardHTML(m, cal, { tag = 'a' } = {}) {
    const attrs = tag === 'a' ? ` href="#/app/plan?receta=${encodeURIComponent(m.id)}" aria-label="Ver la receta: ${escapeHTML(m.name)}"` : '';
    return `
      <${tag} class="meal"${attrs}>
        <div class="meal__media">
          <img src="${escapeHTML(mealImage(m, 480))}" alt="" loading="lazy" decoding="async" width="480" height="360" data-fallback>
          <span class="meal__type">${MEAL_LABEL[m.type] || ''}</span>
          <span class="meal__kcal">${fmtInt(m.kcal || 0)}<small> kcal</small></span>
        </div>
        <div class="meal__body">
          <h3>${escapeHTML(m.name)}</h3>
          <p>${escapeHTML(m.desc)}</p>
          <div class="meal__meta"><span><i class="fa-regular fa-clock" aria-hidden="true"></i> ${m.min || 0} min</span>${cal ? `<span>${Math.round((m.kcal / cal.target) * 100)} % del día</span>` : ''}</div>
          <div class="tags">${m.tags.map((t) => `<span class="tag">${escapeHTML(t)}</span>`).join('')}</div>
          ${tag === 'a' ? '<span class="meal__cta">Ver receta <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></span>' : ''}
        </div>
      </${tag}>`;
  }

  const EXERCISES = {
    bajo: [
      { icon: 'fa-dumbbell', name: 'Fuerza con peso corporal', meta: '25 min · Nivel medio' },
      { icon: 'fa-spa', name: 'Yoga', meta: '25 min · Relajación' },
      { icon: 'fa-person-walking', name: 'Caminata', meta: '30 min · Nivel bajo' },
      { icon: 'fa-child-reaching', name: 'Pilates', meta: '30 min · Nivel bajo' },
    ],
    normal: [
      { icon: 'fa-person-running', name: 'Carrera suave', meta: '30 min · Nivel medio' },
      { icon: 'fa-bolt', name: 'HIIT', meta: '15 min · Nivel alto' },
      { icon: 'fa-dumbbell', name: 'Fuerza con pesas', meta: '40 min · Nivel medio' },
      { icon: 'fa-person-biking', name: 'Ciclismo', meta: '45 min · Nivel medio' },
    ],
    sobrepeso: [
      { icon: 'fa-person-walking', name: 'Caminata rápida', meta: '40 min · Nivel bajo' },
      { icon: 'fa-person-biking', name: 'Bicicleta estática', meta: '30 min · Nivel medio' },
      { icon: 'fa-person-swimming', name: 'Natación', meta: '30 min · Nivel medio' },
      { icon: 'fa-dumbbell', name: 'Fuerza en circuito', meta: '30 min · Nivel medio' },
    ],
    obesidad: [
      { icon: 'fa-person-walking', name: 'Caminata a ritmo cómodo', meta: '20–30 min · Nivel bajo' },
      { icon: 'fa-person-swimming', name: 'Aquagym', meta: '30 min · Bajo impacto' },
      { icon: 'fa-person-biking', name: 'Bicicleta estática suave', meta: '20 min · Nivel bajo' },
      { icon: 'fa-chair', name: 'Movilidad en silla', meta: '15 min · Bajo impacto' },
    ],
  };

  const ARTICLES = [
    { id: 'imc', icon: 'fa-scale-balanced', title: '¿Qué es el IMC?', summary: 'Cómo se calcula y qué significa tu resultado.',
      body: `<p>El índice de masa corporal (IMC) divide tu peso en kilogramos entre el cuadrado de tu altura en metros. Es una forma rápida y gratuita de estimar si tu peso está en un rango saludable para tu estatura.</p>
             <p>La Organización Mundial de la Salud clasifica el resultado en seis categorías, desde bajo peso (menos de 18.5) hasta obesidad grado III (40 o más). El rango considerado saludable va de 18.5 a 24.9.</p>
             <ul><li>Se aplica a adultos de 18 años o más.</li><li>Es igual para hombres y mujeres.</li><li>Es un indicador de riesgo, no un diagnóstico.</li></ul>` },
    { id: 'limites', icon: 'fa-circle-exclamation', title: 'Lo que el IMC no mide', summary: 'Músculo, grasa y distribución corporal.',
      body: `<p>El IMC no distingue entre masa muscular y grasa, ni indica dónde se acumula la grasa. Por eso una persona muy musculosa puede tener un IMC alto sin exceso de grasa.</p>
             <ul><li>Deportistas y personas con mucha masa muscular.</li><li>Embarazo y lactancia.</li><li>Personas mayores, que pierden músculo con la edad.</li><li>Niños y adolescentes, que usan percentiles.</li></ul>
             <p>Complementa tu IMC con la circunferencia de cintura y, si es posible, con una valoración profesional.</p>` },
    { id: 'nutricion', icon: 'fa-carrot', title: 'Nutrición saludable', summary: 'Guías, consejos y la base de un buen plato.',
      body: `<p>Un plato equilibrado tiene la mitad de verduras y frutas, un cuarto de proteína y un cuarto de cereales integrales o tubérculos, con una porción pequeña de grasas saludables.</p>
             <ul><li>Al menos 5 porciones de frutas y verduras al día.</li><li>Prefiere integrales a refinados.</li><li>Limita bebidas azucaradas y ultraprocesados.</li><li>Cocina en casa siempre que puedas: controlas porciones e ingredientes.</li></ul>` },
    { id: 'ejercicio', icon: 'fa-person-running', title: 'Ejercicio físico', summary: 'Cuánto moverte y cómo empezar.',
      body: `<p>La OMS recomienda a los adultos entre 150 y 300 minutos de actividad moderada por semana, o entre 75 y 150 de actividad intensa, más dos días de fortalecimiento muscular.</p>
             <ul><li>Empieza con 10 minutos y suma poco a poco.</li><li>Elige actividades que disfrutes: la constancia gana.</li><li>Si tienes una condición médica, consulta antes de iniciar.</li></ul>` },
    { id: 'descanso', icon: 'fa-droplet', title: 'Hidratación y descanso', summary: 'Dos hábitos que influyen en tu peso.',
      body: `<p>Dormir poco altera las hormonas del hambre y la saciedad, y se asocia con mayor riesgo de aumento de peso. Los adultos necesitan entre 7 y 9 horas de sueño.</p>
             <p>El agua no adelgaza por sí sola, pero sustituir bebidas azucaradas por agua reduce calorías. Bebe con regularidad y aumenta la cantidad si haces ejercicio o hace calor.</p>` },
    { id: 'mental', icon: 'fa-brain', title: 'Salud mental', summary: 'La relación entre emociones y alimentación.',
      body: `<p>El estrés, la ansiedad o la tristeza pueden cambiar la forma en que comemos. Reconocer el hambre emocional es el primer paso para gestionarla.</p>
             <ul><li>Pregúntate si tienes hambre física antes de comer.</li><li>Busca alternativas: caminar, respirar, hablar con alguien.</li><li>Evita las dietas extremas: aumentan la ansiedad y el efecto rebote.</li><li>Si la comida te genera angustia, pide ayuda profesional.</li></ul>` },
    { id: 'habitos', icon: 'fa-seedling', title: 'Hábitos sostenibles', summary: 'Pequeños cambios, grandes resultados.',
      body: `<p>Los cambios que duran son los que puedes mantener. Elige un hábito, hazlo fácil y repítelo hasta que sea automático antes de añadir otro.</p>
             <ul><li>Pésate una vez por semana, a la misma hora.</li><li>Prepara tus comidas con anticipación.</li><li>Registra tu actividad: lo que se mide, mejora.</li><li>Celebra el progreso, no solo la meta.</li></ul>` },
    { id: 'faq', icon: 'fa-circle-question', title: 'Preguntas frecuentes', summary: 'Resuelve tus dudas más comunes.',
      body: `<p><strong>¿Cada cuánto debo calcular mi IMC?</strong> Una vez por semana es suficiente; el peso varía a diario por agua y digestión.</p>
             <p><strong>¿Cuánto peso es seguro perder?</strong> Entre 0.5 y 1 kg por semana es un ritmo seguro para la mayoría de los adultos.</p>
             <p><strong>¿Por qué cambian mis calorías objetivo?</strong> Se recalculan cuando actualizas tu peso, nivel de actividad u objetivo.</p>
             <p><strong>¿Puedo borrar mis datos?</strong> Sí, desde Perfil y ajustes → Seguridad → Eliminar cuenta.</p>` },
  ];

  const VIEW_TITLES = {
    resumen: 'Tu resumen de hoy',
    calculadora: 'Calculadora IMC',
    plan: 'Plan de alimentación',
    actividad: 'Actividad física',
    progreso: 'Tu progreso',
    informacion: 'Información',
    perfil: 'Perfil y ajustes',
    sugerencias: 'Sugerencias',
    admin: 'Administración',
  };

  /** Versión de los Términos y la Política que se guarda al aceptar. */
  const LEGAL_VERSION = '1.0';
  const LEGAL_TITLES = { terminos: 'Términos y condiciones', privacidad: 'Política de privacidad y seguridad' };

  /* ------------------------------------------------------------------
     Cálculos de salud
     ------------------------------------------------------------------ */
  const calcBMI = (weightKg, heightCm) => weightKg / ((heightCm / 100) ** 2);
  const bmiCategory = (bmi) => BMI_CATS.find((c) => bmi >= c.min && bmi < c.max) || BMI_CATS[BMI_CATS.length - 1];
  const healthyRange = (heightCm) => {
    const m2 = (heightCm / 100) ** 2;
    return [round1(18.5 * m2), round1(24.9 * m2)];
  };
  const exerciseGroup = (bmi) => {
    if (!bmi) return 'normal';
    const k = bmiCategory(bmi).key;
    return k.startsWith('ob') ? 'obesidad' : k;
  };

  /** Calorías objetivo con Mifflin-St Jeor. Devuelve null si faltan datos. */
  const calcCalories = (p) => {
    if (!p.weight || !p.height || !p.age) return null;
    const base = 10 * p.weight + 6.25 * p.height - 5 * p.age;
    const bmr = p.sex === 'm' ? base + 5 : p.sex === 'f' ? base - 161 : base - 78;
    const tdee = bmr * (ACTIVITY_LEVELS[p.level] || 1.2);
    const minimum = p.sex === 'm' ? 1500 : 1200;
    let target = tdee;
    if (p.goal === 'perder') target = Math.max(tdee - 450, minimum);
    if (p.goal === 'ganar') target = tdee + 300;
    target = Math.round(target / 10) * 10;
    const protein = Math.round(p.weight * (p.goal === 'ganar' ? 1.8 : 1.6));
    const fat = Math.round((target * 0.28) / 9);
    const carbs = Math.max(0, Math.round((target - protein * 4 - fat * 9) / 4));
    return { bmr: Math.round(bmr), tdee: Math.round(tdee), target, protein, fat, carbs };
  };

  const activityKcal = (met, minutes, weight) => Math.round((met * 3.5 * (weight || 70) / 200) * minutes);

  /* ------------------------------------------------------------------
     Validación
     ------------------------------------------------------------------ */
  const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const RE_NAME = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ' -]+$/;

  /** true si hay tres dígitos seguidos consecutivos, subiendo o bajando (123, 987). */
  const hasDigitSequence = (pw) => {
    for (let i = 0; i < pw.length - 2; i += 1) {
      const chunk = pw.slice(i, i + 3);
      if (!/^\d{3}$/.test(chunk)) continue;
      const [a, b, c] = [...chunk].map(Number);
      if (b - a === c - b && Math.abs(b - a) === 1) return true;
    }
    return false;
  };
  /** true si el mismo dígito aparece tres veces seguidas (111, 000). */
  const hasDigitRepeat = (pw) => /(\d)\1\1/.test(pw);
  const COMMON_PASSWORD_WORDS = ['password', 'contrasena', 'contraseña', 'qwerty', 'onelife', 'one life', 'abc123', 'admin', 'iloveyou', 'bienvenido'];

  const passwordRules = (pw) => ({
    length: pw.length >= 8,
    upper: /[A-ZÁÉÍÓÚÑ]/.test(pw),
    lower: /[a-záéíóúñ]/.test(pw),
    number: /\d/.test(pw),
    sequence: !hasDigitSequence(pw),
    repeat: !hasDigitRepeat(pw),
  });

  const validate = {
    name(v) {
      const s = v.trim().replace(/\s+/g, ' ');
      if (!s) return 'Escribe tu nombre.';
      if (s.length < 2) return 'El nombre debe tener al menos 2 caracteres.';
      if (s.length > 40) return 'El nombre no puede superar 40 caracteres.';
      if (!RE_NAME.test(s)) return 'Usa solo letras, espacios, apóstrofos o guiones.';
      return '';
    },
    email(v) {
      const s = v.trim();
      if (!s) return 'Escribe tu correo electrónico.';
      if (/\s/.test(s)) return 'El correo no puede contener espacios.';
      if (!s.includes('@')) return 'Al correo le falta el símbolo @.';
      if (!RE_EMAIL.test(s)) return 'Revisa el formato del correo (ejemplo: nombre@dominio.com).';
      if (s.length > 80) return 'El correo es demasiado largo.';
      return '';
    },
    newPassword(v, email = '') {
      if (!v) return 'Crea una contraseña.';
      if (/\s/.test(v)) return 'La contraseña no puede contener espacios.';
      const r = passwordRules(v);
      if (!r.length) return 'La contraseña debe tener al menos 8 caracteres.';
      if (!r.upper || !r.lower) return 'Combina mayúsculas y minúsculas.';
      if (!r.number) return 'Incluye al menos un número.';
      if (!r.sequence) return 'No uses números consecutivos como 123 o 987.';
      if (!r.repeat) return 'No repitas el mismo número tres veces seguidas (como 111).';
      if (COMMON_PASSWORD_WORDS.some((w) => v.toLowerCase().includes(w))) return 'Evita palabras muy comunes como «password», «qwerty» u «onelife».';
      const user = email.split('@')[0].toLowerCase();
      if (user.length >= 3 && v.toLowerCase().includes(user)) return 'La contraseña no debe contener tu correo.';
      return '';
    },
    weight(v, { required = true } = {}) {
      if (String(v).trim() === '') return required ? 'Escribe tu peso.' : '';
      const n = parseNum(v);
      if (Number.isNaN(n)) return 'El peso debe ser un número (ejemplo: 70.5).';
      if (n <= 0) return 'El peso debe ser mayor que cero.';
      if (n > 1000) return 'Parece que escribiste el peso en gramos o libras. Usa kilogramos.';
      if (n < 20 || n > 350) return 'Ingresa un peso entre 20 y 350 kg.';
      return '';
    },
    height(v, { required = true } = {}) {
      if (String(v).trim() === '') return required ? 'Escribe tu altura.' : '';
      const n = parseNum(v);
      if (Number.isNaN(n)) return 'La altura debe ser un número (ejemplo: 175).';
      if (n <= 0) return 'La altura debe ser mayor que cero.';
      if (n < 3) return `Parece que la escribiste en metros. Escríbela en centímetros (ejemplo: ${Math.round(n * 100)}).`;
      if (n < 50 || n > 250) return 'Ingresa una altura entre 50 y 250 cm.';
      return '';
    },
    age(v, { required = true } = {}) {
      if (String(v).trim() === '') return required ? 'Escribe tu edad.' : '';
      const n = parseNum(v);
      if (Number.isNaN(n) || !Number.isInteger(n)) return 'La edad debe ser un número entero.';
      if (n < 2) return 'El IMC no se usa en menores de 2 años.';
      if (n > 120) return 'Ingresa una edad válida (máximo 120).';
      return '';
    },
    date(v, { maxDaysBack = 3650 } = {}) {
      if (!v) return 'Selecciona una fecha.';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(parseISO(v).getTime())) return 'La fecha no es válida.';
      if (v > todayISO()) return 'La fecha no puede estar en el futuro.';
      if (v < isoDaysAgo(maxDaysBack)) return 'La fecha es demasiado antigua.';
      return '';
    },
  };

  /* Errores por campo */
  const setError = (input, msg) => {
    const errEl = document.getElementById(`${input.id}-error`);
    if (msg) {
      input.setAttribute('aria-invalid', 'true');
      if (errEl) errEl.textContent = msg;
    } else {
      input.removeAttribute('aria-invalid');
      if (errEl) errEl.textContent = '';
    }
  };
  const clearForm = (form) => {
    $$('[aria-invalid]', form).forEach((el) => setError(el, ''));
    $$('.field__error', form).forEach((el) => { el.textContent = ''; });
    formAlert(form, '');
  };
  const formAlert = (form, msg, type = 'error') => {
    const el = $('.form-alert', form);
    if (!el) return;
    el.hidden = !msg;
    el.textContent = msg;
    el.classList.toggle('form-alert--success', type === 'success');
  };
  /** Aplica un mapa {campo: mensaje} y enfoca el primer error. Devuelve true si no hay errores. */
  const applyErrors = (form, errors) => {
    let first = null;
    Object.entries(errors).forEach(([name, msg]) => {
      const input = form.elements[name];
      if (!input || input instanceof RadioNodeList) return;
      setError(input, msg);
      if (msg && !first) first = input;
    });
    if (first) first.focus();
    return !first;
  };
  /* Al escribir de nuevo en un campo con error, el error desaparece */
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.matches?.('[aria-invalid="true"]')) setError(t, '');
    if (t.form) {
      const alert = $('.form-alert', t.form);
      if (alert && !alert.classList.contains('form-alert--success') && !t.form.dataset.locked) alert.hidden = true;
    }
  });

  /** Deshabilita el botón y muestra un indicador mientras dura una operación con el servidor. */
  async function withBusy(btn, task) {
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> ${btn.dataset.busy || 'Guardando…'}`;
    try {
      return await task();
    } finally {
      btn.innerHTML = label;
      btn.removeAttribute('aria-busy');
      if (!btn.closest('form')?.dataset.locked) btn.disabled = false;
    }
  }

  /* ------------------------------------------------------------------
     Toasts y diálogo de confirmación
     ------------------------------------------------------------------ */
  function toast(msg, type = 'info', ms = 4200) {
    const icons = { info: 'fa-circle-info', success: 'fa-circle-check', error: 'fa-triangle-exclamation' };
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = `<i class="fa-solid ${icons[type]}" aria-hidden="true"></i><span>${escapeHTML(msg)}</span>`;
    $('#toasts').append(el);
    setTimeout(() => {
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 220);
    }, ms);
  }

  function confirmDialog({ title, body, confirmLabel = 'Confirmar', requireText = '', requireLabel = '' }) {
    const dlg = $('#confirm-dialog');
    $('#confirm-title').textContent = title;
    $('#confirm-body').textContent = body;
    $('#confirm-ok').textContent = confirmLabel;
    const wrap = $('#confirm-input-wrap');
    const input = $('#confirm-input');
    wrap.hidden = !requireText;
    input.value = '';
    $('#confirm-input-label').textContent = requireLabel;
    const ok = $('#confirm-ok');
    ok.disabled = Boolean(requireText);
    input.oninput = () => { ok.disabled = input.value.trim().toLowerCase() !== requireText.toLowerCase(); };

    return new Promise((resolve) => {
      if (typeof dlg.showModal !== 'function') {
        resolve(window.confirm(`${title}\n\n${body}`));
        return;
      }
      // Se responde desde el propio botón: el evento "close" no siempre llega
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        if (dlg.open) dlg.close();
        resolve(value);
      };
      $('form', dlg).onsubmit = (e) => {
        e.preventDefault();
        finish(e.submitter?.value === 'ok' && !ok.disabled);
      };
      dlg.oncancel = (e) => { e.preventDefault(); finish(false); }; // tecla Escape
      dlg.onclose = () => finish(false);
      dlg.showModal();
      (requireText ? input : ok).focus();
    });
  }

  /* ------------------------------------------------------------------
     Sesión y datos del usuario (Supabase)
     ------------------------------------------------------------------ */
  const SESSION_IDLE_MS = 30 * 60 * 1000;
  const MAX_ATTEMPTS = 5;
  const LOCK_MS = 60 * 1000;

  /** Copia en memoria de los datos del usuario, cargada desde Supabase al iniciar sesión. */
  const state = { user: null, isAdmin: false, recovery: false, loggingOut: false };
  const currentUser = () => state.user;

  async function loadUserData() {
    const [me, history, activities, logins, isAdmin, meals] = await Promise.all([
      db.getMe(),
      db.listRecords(),
      db.listActivities({ sinceDays: 365 }),
      db.recentLogins(2).catch(() => []),
      db.isAdmin(),
      db.listMeals().catch(() => null),
    ]);
    if (meals) MEALS = meals;
    state.user = { ...me, history, activities, previousLogin: logins[1] || null };
    state.isAdmin = isAdmin;
    $('#nav-admin').hidden = !isAdmin;
    // El administrador recibe las sugerencias: su enlace lleva a la bandeja, no al formulario de envío
    $('#nav-feedback').setAttribute('href', isAdmin ? '#/app/admin?tab=sugerencias' : '#/app/sugerencias');
    $('#nav-feedback-label').textContent = isAdmin ? 'Sugerencias recibidas' : 'Sugerencias';
    if (isAdmin) watchFeedback();
  }

  function clearLocalState() {
    state.user = null;
    state.isAdmin = false;
    state.recovery = false;
    $('#nav-admin').hidden = true;
    $('#nav-feedback').setAttribute('href', '#/app/sugerencias');
    $('#nav-feedback-label').textContent = 'Sugerencias';
    stopFeedbackWatch();
    setFeedbackBadge(0);
  }

  /** Marca la sesión como activa en este navegador (para "Recordarme" e inactividad). */
  function markSessionStart(remember) {
    storage.set(KEYS.remember, Boolean(remember));
    storage.set(KEYS.alive, true, false);
    storage.set(KEYS.lastActive, Date.now());
  }

  /* Guardados: escriben en Supabase y actualizan la copia en memoria */
  async function saveRecord({ date, weight, height }) {
    const rec = await db.upsertRecord({ date, weight: round1(weight), height });
    const u = state.user;
    const existed = u.history.some((r) => r.date === date);
    u.history = [...u.history.filter((r) => r.date !== date), rec].sort((a, b) => a.date.localeCompare(b.date));
    return existed ? 'updated' : 'created';
  }

  async function saveProfile(changes) {
    const me = await db.updateProfile(changes);
    Object.assign(state.user, { name: me.name, role: me.role, notifications: me.notifications, profile: me.profile });
  }

  /* Bloqueo tras intentos fallidos (complementa el límite del servidor) */
  const getAttempt = (email) => storage.get(KEYS.attempts, {})[email] || { count: 0, until: 0 };
  const setAttempt = (email, data) => {
    const all = storage.get(KEYS.attempts, {});
    if (data) all[email] = data; else delete all[email];
    storage.set(KEYS.attempts, all);
  };

  async function logout(reason) {
    state.loggingOut = true;
    try { await db.signOut(); } catch { /* la sesión local se limpia igual */ }
    state.loggingOut = false;
    clearLocalState();
    if (reason === 'idle') toast('Tu sesión se cerró por inactividad. Vuelve a iniciar sesión.', 'info', 6000);
    else if (reason !== 'silent') toast('Sesión cerrada. ¡Hasta pronto!', 'success');
    location.hash = '#/acceso';
  }

  /* Cierre por inactividad */
  let lastTouch = 0;
  const touchSession = () => {
    const now = Date.now();
    if (!state.user || now - lastTouch < 15000) return;
    lastTouch = now;
    storage.set(KEYS.lastActive, now);
  };
  ['click', 'keydown', 'scroll', 'touchstart'].forEach((ev) => window.addEventListener(ev, touchSession, { passive: true }));
  setInterval(() => {
    if (state.user && Date.now() - storage.get(KEYS.lastActive, Date.now()) > SESSION_IDLE_MS) logout('idle');
  }, 20000);

  /* Cambios de sesión que no inicia esta pestaña: otra pestaña, expiración, enlace de recuperación */
  function handleAuthEvent(event) {
    if (event === 'PASSWORD_RECOVERY') {
      state.recovery = true;
      if (state.user) location.hash = '#/app/perfil?tab=seguridad';
    }
    if (event === 'SIGNED_OUT' && state.user && !state.loggingOut) {
      clearLocalState();
      toast('Tu sesión terminó (se cerró en otra pestaña o expiró).', 'info', 6000);
      if (location.hash.startsWith('#/app')) location.hash = '#/acceso';
    }
  }

  /* ------------------------------------------------------------------
     Router
     ------------------------------------------------------------------ */
  const parseHash = () => {
    const raw = location.hash.replace(/^#\/?/, '') || 'inicio';
    const [path, query = ''] = raw.split('?');
    return { parts: path.split('/').filter(Boolean), params: new URLSearchParams(query) };
  };

  /** Pantalla visible ('inicio', 'acceso', 'app:plan'…): si no cambia, no se toca el scroll. */
  let currentScreen = '';
  let previousScreen = '';
  function enterScreen(name) {
    if (name === currentScreen) return false;
    previousScreen = currentScreen;
    currentScreen = name;
    $$('dialog[open]').forEach((d) => d.close());
    window.scrollTo(0, 0);

    return true;
  }

  function route() {
    const { parts, params } = parseHash();
    const user = currentUser();

    if (parts[0] === 'app') {
      const view = VIEW_TITLES[parts[1]] ? parts[1] : 'resumen';
      if (!user) {
        const label = VIEW_TITLES[view] || 'esta sección';
        toast(`Inicia sesión para acceder a ${label.toLowerCase()}.`, 'info');
        location.replace(`#/acceso?next=${view}`);
        return;
      }
      if (view === 'admin' && !state.isAdmin) {
        toast('Esa sección es solo para administradores.', 'error');
        location.replace('#/app/resumen');
        return;
      }
      if (view === 'sugerencias' && state.isAdmin) {
        location.replace('#/app/admin?tab=sugerencias');
        return;
      }
      showApp(view, params);
      return;
    }

    if (parts[0] === 'acceso') {
      if (user) { location.replace('#/app/resumen'); return; }
      showPublic('acceso');
      setAuthTab(params.get('modo') === 'registro' ? 'registro' : 'login');
      return;
    }

    if (parts[0] === 'terminos' || parts[0] === 'privacidad') {
      showPublic(parts[0]);
      return;
    }

    if (parts[0] !== 'inicio') { location.replace('#/inicio'); return; }
    showPublic('inicio');
  }

  function showPublic(name) {
    $('#public').hidden = false;
    $('#app').hidden = true;
    $$('[data-public-view]').forEach((v) => { v.hidden = v.dataset.publicView !== name; });
    closePublicMenu();
    document.title = name === 'acceso' ? 'Acceso — One Life'
      : LEGAL_TITLES[name] ? `${LEGAL_TITLES[name]} — One Life`
        : 'One Life — Conoce tu peso, cuida tu vida';
    enterScreen(name);
    onScroll();
    if (name === 'acceso') authArt.start();
  }



  function showApp(view, params) {
    $('#public').hidden = true;
    $('#app').hidden = false;
    $$('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
    $$('.sidenav a').forEach((a) => {
      const active = a.dataset.nav === view;
      a.classList.toggle('is-active', active);
      if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('#page-title').textContent = VIEW_TITLES[view];
    document.title = `${VIEW_TITLES[view]} — One Life`;
    closeSidebar();
    const changed = enterScreen(`app:${view}`);
    renderShell();
    RENDER[view]?.(params, { changed });
  }

  /* ------------------------------------------------------------------
     Sitio público: navegación
     ------------------------------------------------------------------ */
  /** Desplaza hasta una sección descontando la barra fija, para que el título no quede tapado. */
  function scrollToSection(id, smooth = true) {
    const el = id === 'top' ? null : document.getElementById(id);
    const offset = ($('#topnav')?.offsetHeight || 0) + 12;
    const top = el ? el.getBoundingClientRect().top + window.scrollY - offset : 0;
    const instant = !smooth || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: Math.max(0, top), behavior: instant ? 'auto' : 'smooth' });
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-scroll]');
    if (!a) return;
    e.preventDefault();
    const target = a.dataset.scroll;
    $$('dialog[open]').forEach((d) => d.close());
    closePublicMenu();
    if (currentScreen !== 'inicio') {
      // Primero se muestra el inicio (sin animar desde arriba) y luego se baja a la sección
      location.hash = '#/inicio';
      requestAnimationFrame(() => requestAnimationFrame(() => scrollToSection(target, false)));
    } else {
      scrollToSection(target);
    }
  });

  /* Volver desde Términos / Privacidad a la pantalla anterior */
  $$('[data-legal-back]').forEach((btn) => btn.addEventListener('click', () => {
    if (previousScreen) history.back();
    else location.hash = '#/inicio';
  }));

  const publicMenuBtn = $('#public-menu-btn');
  function closePublicMenu() {
    $('#public-menu').hidden = true;
    publicMenuBtn.setAttribute('aria-expanded', 'false');
  }
  publicMenuBtn.addEventListener('click', () => {
    const open = $('#public-menu').hidden;
    $('#public-menu').hidden = !open;
    publicMenuBtn.setAttribute('aria-expanded', String(open));
  });

  /* Botón volver arriba */
  const toTop = $('#to-top');
  toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

  /* ------------------------------------------------------------------
     Acceso: pestañas, contraseñas, registro e inicio de sesión
     ------------------------------------------------------------------ */
  function setAuthTab(tab) {
    const isLogin = tab === 'login';
    $('#login-form').hidden = !isLogin;
    $('#register-form').hidden = isLogin;
    $('#tab-login').classList.toggle('is-active', isLogin);
    $('#tab-register').classList.toggle('is-active', !isLogin);
    $('#tab-login').setAttribute('aria-selected', String(isLogin));
    $('#tab-register').setAttribute('aria-selected', String(!isLogin));
  }
  $$('[data-auth-tab]').forEach((btn) => btn.addEventListener('click', () => {
    const tab = btn.dataset.authTab;
    const { params } = parseHash();
    if (tab === 'registro') params.set('modo', 'registro'); else params.delete('modo');
    const q = params.toString();
    history.replaceState(null, '', `#/acceso${q ? `?${q}` : ''}`);
    setAuthTab(tab);
  }));

  $$('[data-toggle-password]').forEach((btn) => btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.togglePassword);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
    btn.innerHTML = `<i class="fa-solid ${show ? 'fa-eye-slash' : 'fa-eye'}" aria-hidden="true"></i>`;
  }));

  /* Aviso de Bloq Mayús */
  $$('[data-caps-for]').forEach((hint) => {
    const input = document.getElementById(hint.dataset.capsFor);
    const check = (e) => { if (e.getModifierState) hint.hidden = !e.getModifierState('CapsLock'); };
    input.addEventListener('keyup', check);
    input.addEventListener('keydown', check);
    input.addEventListener('blur', () => { hint.hidden = true; });
  });

  /* Medidor de fuerza en registro */
  $('#reg-password').addEventListener('input', (e) => {
    const value = e.target.value;
    const rules = passwordRules(value);
    const passed = Object.values(rules).filter(Boolean).length;
    const total = Object.keys(rules).length;
    // 4 barras: solo se llena del todo si se cumplen todas las reglas
    const level = !value ? 0 : passed === total ? 4 : Math.min(3, Math.max(1, Math.floor((passed / total) * 4)));
    $('.strength', e.target.form).dataset.level = level;
    $$('#reg-password-rules li').forEach((li) => li.classList.toggle('is-ok', Boolean(value) && rules[li.dataset.rule]));
  });

  /* Validación al salir de un campo */
  const blurValidators = {
    'reg-name': (v) => validate.name(v),
    'reg-email': (v) => validate.email(v),
    'login-email': (v) => (v.trim() ? validate.email(v) : ''),
    'reg-confirm': (v) => (v && v !== $('#reg-password').value ? 'Las contraseñas no coinciden.' : ''),
    'bmi-weight': (v) => (v.trim() ? validate.weight(v) : ''),
    'bmi-height': (v) => (v.trim() ? validate.height(v) : ''),
    'bmi-age': (v) => (v.trim() ? validate.age(v) : ''),
  };
  Object.entries(blurValidators).forEach(([id, fn]) => {
    document.getElementById(id)?.addEventListener('blur', (e) => setError(e.target, fn(e.target.value)));
  });

  /** Si Supabase no está configurado, avisa en el formulario y devuelve false. */
  function requireDb(form) {
    if (db.ready) return true;
    formAlert(form, 'La app aún no está conectada a la base de datos. Configura tus datos de Supabase en js/config.js.');
    return false;
  }

  $('#forgot-btn').addEventListener('click', async () => {
    const form = $('#login-form');
    clearForm(form);
    const email = form.email.value.trim().toLowerCase();
    const err = validate.email(email);
    if (err) {
      setError(form.email, err === 'Escribe tu correo electrónico.' ? 'Escribe tu correo y vuelve a pulsar «¿Olvidaste tu contraseña?».' : err);
      form.email.focus();
      return;
    }
    if (!requireDb(form)) return;
    const btn = $('#forgot-btn');
    btn.dataset.busy = 'Enviando…';
    await withBusy(btn, async () => {
      try {
        await db.sendPasswordReset(email);
        // Mensaje neutro: no revela si el correo tiene cuenta
        formAlert(form, `Si ${email} tiene una cuenta, recibirás un correo con un enlace para crear una contraseña nueva.`, 'success');
      } catch (e) {
        formAlert(form, e.message);
      }
    });
  });

  let lockTimer = null;
  function showLock(form, email) {
    const { until } = getAttempt(email);
    const btn = $('button[type="submit"]', form);
    clearInterval(lockTimer);
    const tick = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(lockTimer);
        delete form.dataset.locked;
        btn.disabled = false;
        formAlert(form, 'Ya puedes intentarlo de nuevo.', 'success');
        return;
      }
      btn.disabled = true;
      form.dataset.locked = '1';
      formAlert(form, `Demasiados intentos fallidos. Por seguridad, espera ${left} s antes de volver a intentarlo.`);
    };
    tick();
    lockTimer = setInterval(tick, 1000);
  }

  function registerFailedAttempt(form, email) {
    const attempt = getAttempt(email);
    const count = (attempt.until && attempt.until <= Date.now() ? 0 : attempt.count) + 1;
    if (count >= MAX_ATTEMPTS) {
      setAttempt(email, { count, until: Date.now() + LOCK_MS });
      showLock(form, email);
      return;
    }
    setAttempt(email, { count, until: 0 });
    const left = MAX_ATTEMPTS - count;
    formAlert(form, `Correo o contraseña incorrectos. Te ${left === 1 ? 'queda 1 intento' : `quedan ${left} intentos`} antes de un bloqueo temporal.`);
    form.password.value = '';
    form.password.focus();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (form.dataset.locked) return;
    clearForm(form);
    const email = form.email.value.trim().toLowerCase();
    const password = form.password.value;

    const ok = applyErrors(form, {
      email: validate.email(email),
      password: password ? '' : 'Escribe tu contraseña.',
    });
    if (!ok || !requireDb(form)) return;

    const attempt = getAttempt(email);
    if (attempt.until > Date.now()) { showLock(form, email); return; }

    const btn = $('button[type="submit"]', form);
    btn.dataset.busy = 'Entrando…';
    await withBusy(btn, async () => {
      try {
        await db.signIn(email, password);
      } catch (err) {
        if (/incorrectos/.test(err.message)) registerFailedAttempt(form, email);
        else formAlert(form, err.message);
        return;
      }
      setAttempt(email, null);
      markSessionStart(form.remember.checked);
      try {
        await loadUserData();
      } catch (err) {
        formAlert(form, `Iniciaste sesión, pero no pudimos cargar tus datos: ${err.message}`);
        await db.signOut().catch(() => {});
        return;
      }
      form.reset();
      const next = parseHash().params.get('next');
      toast(`¡Bienvenido de nuevo, ${state.user.name.split(' ')[0]}!`, 'success');
      location.hash = `#/app/${VIEW_TITLES[next] ? next : 'resumen'}`;
    });
  });

  $('#register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    clearForm(form);
    const name = form.name.value.trim().replace(/\s+/g, ' ');
    const email = form.email.value.trim().toLowerCase();
    const password = form.password.value;

    const errors = {
      name: validate.name(name),
      email: validate.email(email),
      password: validate.newPassword(password, email),
      confirm: !form.confirm.value ? 'Confirma tu contraseña.' : form.confirm.value !== password ? 'Las contraseñas no coinciden.' : '',
      terms: form.terms.checked ? '' : 'Debes aceptar los Términos y condiciones.',
      privacy: form.privacy.checked ? '' : 'Debes aceptar la Política de privacidad y seguridad.',
    };
    if (!applyErrors(form, errors) || !requireDb(form)) return;

    const btn = $('button[type="submit"]', form);
    btn.dataset.busy = 'Creando cuenta…';
    await withBusy(btn, async () => {
      let result;
      try {
        result = await db.signUp(name, email, password, {
          terms: form.terms.checked,
          privacy: form.privacy.checked,
          version: LEGAL_VERSION,
        });
      } catch (err) {
        if (/Ya existe/.test(err.message)) setError(form.email, err.message);
        else formAlert(form, err.message);
        return;
      }
      form.reset();
      $('.strength', form).dataset.level = 0;
      $$('#reg-password-rules li').forEach((li) => li.classList.remove('is-ok'));

      if (result.needsConfirmation) {
        history.replaceState(null, '', '#/acceso');
        setAuthTab('login');
        const login = $('#login-form');
        login.email.value = email;
        formAlert(login, `Te enviamos un correo a ${email}. Abre el enlace para confirmar tu cuenta y luego inicia sesión.`, 'success');
        return;
      }

      markSessionStart(false);
      try {
        await loadUserData();
      } catch (err) {
        formAlert(form, `Tu cuenta se creó, pero no pudimos cargar tus datos: ${err.message}`);
        return;
      }
      toast(`Cuenta creada. ¡Bienvenido a One Life, ${name.split(' ')[0]}!`, 'success');
      location.hash = '#/app/resumen';
    });
  });

  /* ------------------------------------------------------------------
     Shell de la app
     ------------------------------------------------------------------ */
  const initials = (name) => name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  function renderShell() {
    const u = currentUser();
    if (!u) return;
    const binds = { name: u.name, firstName: u.name.split(' ')[0], email: u.email, initials: initials(u.name) };
    $$('[data-bind]').forEach((el) => { el.textContent = binds[el.dataset.bind] ?? ''; });
    const label = new Date().toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
    $('#today-label').textContent = label;
  }

  const sidebar = $('#sidebar');
  function openSidebar() {
    sidebar.classList.add('is-open');
    $('#scrim').hidden = false;
    $('#sidebar-open').setAttribute('aria-expanded', 'true');
  }
  function closeSidebar() {
    sidebar.classList.remove('is-open');
    $('#scrim').hidden = true;
    $('#sidebar-open').setAttribute('aria-expanded', 'false');
  }
  $('#sidebar-open').addEventListener('click', openSidebar);
  $('#sidebar-close').addEventListener('click', closeSidebar);
  $('#scrim').addEventListener('click', closeSidebar);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });

  $$('[data-action="logout"]').forEach((b) => b.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Cerrar sesión', body: '¿Quieres cerrar tu sesión en este dispositivo?', confirmLabel: 'Cerrar sesión' });
    if (ok) logout();
  }));

  /* Helpers de perfil */
  const profileComplete = (p) => Boolean(p.age && p.sex && p.height && p.weight);
  const latestRecord = (u) => u.history.at(-1) || null;
  const currentBMI = (u) => {
    const p = u.profile;
    if (p.weight && p.height) return round1(calcBMI(p.weight, p.height));
    const r = latestRecord(u);
    return r ? r.bmi : null;
  };
  const minutesOn = (u, iso) => u.activities.filter((a) => a.date === iso).reduce((s, a) => s + a.minutes, 0);

  /* ------------------------------------------------------------------
     Gráficas SVG
     ------------------------------------------------------------------ */
  const SVG_W = 600;

  function emptyState(host, icon, text, actionHTML = '') {
    host.innerHTML = `<div class="empty"><i class="fa-solid ${icon}" aria-hidden="true"></i><p>${text}</p>${actionHTML}</div>`;
  }

  function barChart(host, data, { goal = 0, unit = 'min' } = {}) {
    const H = 220, pad = { t: 24, r: 8, b: 28, l: 8 };
    const max = Math.max(goal, ...data.map((d) => d.value), 10) * 1.15;
    const slot = (SVG_W - pad.l - pad.r) / data.length;
    const bw = Math.min(44, slot * 0.56);
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
    let svg = `<svg viewBox="0 0 ${SVG_W} ${H}" role="img" aria-label="Minutos de actividad por día">`;
    if (goal) {
      svg += `<line class="goal-line" x1="${pad.l}" x2="${SVG_W - pad.r}" y1="${y(goal)}" y2="${y(goal)}"/>`;
      svg += `<text class="axis-label" x="${SVG_W - pad.r}" y="${y(goal) - 6}" text-anchor="end">Meta ${goal} ${unit}</text>`;
    }
    data.forEach((d, i) => {
      const x = pad.l + slot * i + (slot - bw) / 2;
      const top = y(d.value);
      const h = Math.max(d.value ? 2 : 0, H - pad.b - top);
      const cls = d.today ? 'bar bar--today' : d.value >= goal && goal ? 'bar bar--met' : 'bar';
      svg += `<rect class="${cls}" x="${x}" y="${H - pad.b - h}" width="${bw}" height="${h}"><title>${escapeHTML(d.full)}: ${d.value} ${unit}</title></rect>`;
      if (d.value) svg += `<text class="value-label" x="${x + bw / 2}" y="${H - pad.b - h - 6}" text-anchor="middle">${d.value}</text>`;
      svg += `<text class="axis-label" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${escapeHTML(d.label)}</text>`;
    });
    host.innerHTML = `${svg}<line class="grid-line" x1="${pad.l}" x2="${SVG_W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}"/></svg>`;
  }

  function lineChart(host, points, { unit = '', band = null, goal = null, height = 240, label = '', decimals = 1, width = SVG_W } = {}) {
    const H = height, pad = { t: 20, r: 20, b: 30, l: 44 };
    const values = points.map((p) => p.value);
    const extra = [...(band || []), ...(goal ? [goal] : [])];
    let min = Math.min(...values, ...extra), max = Math.max(...values, ...extra);
    if (max - min < 2) { min -= 1; max += 1; }
    const span = max - min;
    min -= span * 0.12; max += span * 0.12;
    if (decimals === 0) min = Math.max(0, min);
    const t0 = parseISO(points[0].date).getTime();
    const t1 = parseISO(points.at(-1).date).getTime();
    const x = (iso) => (t1 === t0 ? (width + pad.l - pad.r) / 2 : pad.l + (width - pad.l - pad.r) * ((parseISO(iso).getTime() - t0) / (t1 - t0)));
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - min) / (max - min));

    let svg = `<svg viewBox="0 0 ${width} ${H}" role="img" aria-label="${escapeHTML(label)}">`;
    for (let i = 0; i <= 4; i++) {
      const v = min + ((max - min) * i) / 4;
      svg += `<line class="grid-line" x1="${pad.l}" x2="${width - pad.r}" y1="${y(v)}" y2="${y(v)}"/>`;
      svg += `<text class="axis-label" x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v, decimals === 0 || max - min >= 10 ? 0 : 1)}</text>`;
    }
    if (band) {
      const top = y(Math.min(band[1], max)), bot = y(Math.max(band[0], min));
      if (bot > top) {
        svg += `<rect class="band" x="${pad.l}" y="${top}" width="${width - pad.l - pad.r}" height="${bot - top}"/>`;
        svg += `<text class="band-label" x="${width - pad.r - 6}" y="${top + 14}" text-anchor="end">Rango saludable</text>`;
      }
    }
    if (goal) {
      svg += `<line class="goal-line" x1="${pad.l}" x2="${width - pad.r}" y1="${y(goal)}" y2="${y(goal)}"/>`;
      svg += `<text class="band-label" x="${width - pad.r - 6}" y="${y(goal) - 6}" text-anchor="end">Objetivo ${fmt(goal)} ${unit}</text>`;
    }
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    svg += `<path class="line" pathLength="2000" d="${d}"/>`; // misma longitud que el trazo animado en CSS
    points.forEach((p, i) => {
      const last = i === points.length - 1;
      svg += `<circle class="dot${last ? ' dot--last' : ''}" cx="${x(p.date)}" cy="${y(p.value)}" r="${last ? 5 : 3.5}"><title>${fmtDate(p.date, { day: 'numeric', month: 'long', year: 'numeric' })}: ${fmt(p.value, decimals)} ${unit}</title></circle>`;
    });
    const lp = points.at(-1);
    const lx = x(lp.date);
    svg += `<text class="value-label" x="${lx}" y="${y(lp.value) - 12}" text-anchor="${lx > width - 60 ? 'end' : 'middle'}">${fmt(lp.value, decimals)}</text>`;
    // Etiquetas del eje X: primera, media y última
    const ticks = points.length > 2 ? [points[0], points[Math.floor(points.length / 2)], lp] : points;
    [...new Set(ticks)].forEach((p, i, arr) => {
      const anchor = arr.length === 1 ? 'middle' : i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle';
      svg += `<text class="axis-label" x="${x(p.date)}" y="${H - 8}" text-anchor="${anchor}">${fmtDate(p.date)}</text>`;
    });
    host.innerHTML = `${svg}</svg>`;
  }

  const weekData = (u) => Array.from({ length: 7 }, (_, i) => {
    const iso = isoDaysAgo(6 - i);
    const d = parseISO(iso);
    return {
      label: d.toLocaleDateString('es', { weekday: 'short' }).replace('.', ''),
      full: d.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' }),
      value: minutesOn(u, iso),
      today: i === 6,
    };
  });

  /* ------------------------------------------------------------------
     Vistas
     ------------------------------------------------------------------ */
  const RENDER = {};

  /* ---------- Resumen ---------- */
  RENDER.resumen = () => {
    const u = currentUser();
    const p = u.profile;
    $('#profile-banner').hidden = profileComplete(p);

    const bmi = currentBMI(u);
    $('#dash-bmi').textContent = bmi ? fmt(bmi) : '—';
    const cat = bmi ? bmiCategory(bmi) : null;
    $('#dash-bmi-cat').textContent = cat ? cat.label : 'Sin cálculo aún';
    $('#dash-bmi-cat').classList.toggle('is-accent', Boolean(cat));

    const weight = p.weight || latestRecord(u)?.weight;
    $('#dash-weight').innerHTML = weight ? `${fmt(weight)}<small>kg</small>` : '—';
    if (u.history.length >= 2) {
      const delta = round1(u.history.at(-1).weight - u.history[0].weight);
      $('#dash-weight-delta').textContent = `${delta > 0 ? '+' : ''}${fmt(delta)} kg desde tu primer registro`;
    } else {
      $('#dash-weight-delta').textContent = weight ? 'Sigue registrando tu peso' : 'Registra tu peso';
    }

    const cal = calcCalories(p);
    $('#dash-kcal').textContent = cal ? fmtInt(cal.target) : '—';
    $('#dash-kcal-meta').textContent = cal ? `kcal / día · ${GOAL_LABEL[p.goal].toLowerCase()}` : 'Completa tu perfil';

    const goal = p.minutesGoal || 30;
    const today = minutesOn(u, todayISO());
    $('#dash-minutes').textContent = today;
    $('#dash-minutes-meta').textContent = today >= goal ? `¡Meta de ${goal} min cumplida!` : `de ${goal} min`;
    $('#dash-ring').setAttribute('stroke-dasharray', `${clamp((today / goal) * 100, 0, 100)} 100`);

    const week = weekData(u);
    if (week.some((d) => d.value)) barChart($('#dash-week-chart'), week, { goal });
    else emptyState($('#dash-week-chart'), 'fa-person-running', 'Aún no registras actividad esta semana.', '<a href="#/app/actividad" class="btn btn--ghost btn--sm">Registrar actividad</a>');

    if (u.history.length >= 2) {
      lineChart($('#dash-bmi-chart'), u.history.slice(-12).map((r) => ({ date: r.date, value: r.bmi })), { band: [18.5, 24.9], height: 220, label: 'Evolución del IMC' });
    } else {
      emptyState($('#dash-bmi-chart'), 'fa-chart-line', 'Necesitas al menos dos registros para ver tu evolución.', '<a href="#/app/calculadora" class="btn btn--ghost btn--sm">Calcular IMC</a>');
    }

    const steps = [
      { done: profileComplete(p), text: 'Completa tu perfil', href: '#/app/perfil' },
      { done: u.history.length > 0, text: 'Calcula y guarda tu IMC', href: '#/app/calculadora' },
      { done: today > 0, text: 'Registra tu actividad de hoy', href: '#/app/actividad' },
      { done: Boolean(p.target), text: 'Define tu peso objetivo', href: '#/app/perfil?tab=objetivos' },
    ];
    $('#dash-steps').innerHTML = steps.map((s) => `
      <li class="${s.done ? 'is-done' : ''}">
        <i class="fa-${s.done ? 'solid fa-circle-check' : 'regular fa-circle'}" aria-hidden="true"></i>
        <span>${s.text}</span>
        ${s.done ? '<span class="sr-only">completado</span>' : `<a href="${s.href}" class="btn btn--link btn--xs">Ir <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a>`}
      </li>`).join('');
  };

  /* ---------- Calculadora ---------- */
  let lastBMI = null;
  $('#bmi-scale').innerHTML = BMI_CATS.map((c) => `<li data-cat="${c.key}"><span>${c.label}</span><span>${c.range}</span></li>`).join('');

  RENDER.calculadora = () => {
    const u = currentUser();
    const f = $('#bmi-form');
    const p = u.profile;
    // Rellena con el perfil solo si el formulario está vacío
    if (!f.weight.value && p.weight) f.weight.value = p.weight;
    if (!f.height.value && p.height) f.height.value = p.height;
    if (!f.age.value && p.age) f.age.value = p.age;
    if (!f.sex.value && p.sex) f.sex.value = p.sex;
  };

  $('#bmi-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    clearForm(f);
    const ok = applyErrors(f, {
      weight: validate.weight(f.weight.value),
      height: validate.height(f.height.value),
      age: validate.age(f.age.value),
      sex: f.sex.value ? '' : 'Selecciona una opción.',
    });
    if (!ok) { formAlert(f, 'Revisa los campos marcados para poder calcular tu IMC.'); return; }

    const weight = parseNum(f.weight.value);
    const height = parseNum(f.height.value);
    const age = parseNum(f.age.value);
    const bmi = calcBMI(weight, height);

    if (bmi < 10 || bmi > 80) {
      formAlert(f, `El resultado (${fmt(bmi)}) no es realista. Comprueba que el peso esté en kg y la altura en cm.`);
      setError(f.weight, ' ');
      setError(f.height, ' ');
      return;
    }

    lastBMI = { weight, height, age, sex: f.sex.value, bmi: round1(bmi) };
    showBMIResult(lastBMI);
  });

  $('#bmi-form').addEventListener('reset', (e) => {
    clearForm(e.currentTarget);
    lastBMI = null;
    $('#bmi-body').hidden = true;
    $('#bmi-empty').hidden = false;
    $$('#bmi-scale li').forEach((li) => li.classList.remove('is-active'));
  });

  function showBMIResult({ weight, height, age, bmi }) {
    const cat = bmiCategory(bmi);
    $('#bmi-empty').hidden = true;
    $('#bmi-body').hidden = false;
    $('#bmi-value').textContent = fmt(bmi);
    // El arco del gauge cubre el 75 % del círculo y representa IMC 10–45
    const pct = clamp((bmi - 10) / 35, 0, 1) * 75;
    $('#bmi-gauge').setAttribute('stroke-dasharray', `${pct} 100`);
    $('#bmi-cat').textContent = cat.label;
    $('#bmi-msg').textContent = cat.msg;

    const [lo, hi] = healthyRange(height);
    $('#bmi-range').textContent = `${fmt(lo)} – ${fmt(hi)} kg`;
    let diff = 'Estás dentro del rango';
    if (weight < lo) diff = `${fmt(lo - weight)} kg por debajo`;
    if (weight > hi) diff = `${fmt(weight - hi)} kg por encima`;
    $('#bmi-diff').textContent = diff;

    const warn = $('#bmi-warning');
    if (age < 18) {
      warn.hidden = false;
      warn.textContent = 'Tienes menos de 18 años: la clasificación adulta no aplica. Consulta las tablas de percentiles por edad y sexo con un profesional de salud.';
    } else if (age >= 65) {
      warn.hidden = false;
      warn.textContent = 'A partir de los 65 años, un IMC algo más alto (hasta 27) puede considerarse adecuado. Coméntalo con tu médico.';
    } else {
      warn.hidden = true;
    }
    $$('#bmi-scale li').forEach((li) => li.classList.toggle('is-active', li.dataset.cat === cat.key));
    $('#bmi-save').disabled = false;
  }

  $('#bmi-save').addEventListener('click', async (e) => {
    if (!lastBMI) return;
    const data = lastBMI;
    const btn = e.currentTarget;
    let result;
    const saved = await withBusy(btn, async () => {
      try {
        result = await saveRecord({ date: todayISO(), weight: data.weight, height: data.height });
        await saveProfile({ weight: round1(data.weight), height: data.height, age: data.age, sex: data.sex });
        return true;
      } catch (err) {
        toast(err.message, 'error');
        return false;
      }
    });
    if (!saved) return;
    toast(result === 'updated' ? 'Actualizamos tu registro de hoy.' : 'IMC guardado en tu progreso.', 'success');
    btn.disabled = true;
  });

  /* ---------- Plan de alimentación ---------- */
  let mealTab = 'recomendado';

  RENDER.plan = (params, { changed = true } = {}) => {
    // Abrir o cerrar una receta solo cambia el ?receta= de la URL: no se vuelve a dibujar el plan
    const recipeId = params?.get('receta');
    if (!changed) {
      if (recipeId) openRecipe(recipeId); else closeRecipe();
      return;
    }
    if (recipeId) requestAnimationFrame(() => openRecipe(recipeId));
    const u = currentUser();
    const p = u.profile;
    const cal = calcCalories(p);

    if (cal) {
      $('#plan-kcal').textContent = fmtInt(cal.target);
      $('#plan-kcal-explain').textContent = `Metabolismo basal ${fmtInt(cal.bmr)} kcal × actividad ${LEVEL_LABEL[p.level].toLowerCase()} = ${fmtInt(cal.tdee)} kcal. Objetivo: ${GOAL_LABEL[p.goal].toLowerCase()}.`;
      const total = cal.protein * 4 + cal.carbs * 4 + cal.fat * 9;
      const rows = [
        ['Proteína', cal.protein, cal.protein * 4],
        ['Carbohidratos', cal.carbs, cal.carbs * 4],
        ['Grasas', cal.fat, cal.fat * 9],
      ];
      $('#plan-macros').innerHTML = rows.map(([name, g, kcal]) => `
        <div class="macro">
          <span>${name}</span>
          <div class="macro__bar" role="img" aria-label="${name}: ${Math.round((kcal / total) * 100)} %"><span style="width:${(kcal / total) * 100}%"></span></div>
          <span class="macro__val">${g} g<small>${Math.round((kcal / total) * 100)} %</small></span>
        </div>`).join('');
    } else {
      $('#plan-kcal').textContent = '—';
      $('#plan-kcal-explain').innerHTML = 'Completa tu edad, sexo, altura y peso en <a href="#/app/perfil" class="link">tu perfil</a> para calcular tus calorías.';
      emptyState($('#plan-macros'), 'fa-chart-pie', 'Tus macronutrientes aparecerán cuando completes tu perfil.');
    }
    renderMeals(cal, p.goal);
  };

  function renderMeals(cal, goal) {
    let list;
    let note = '';
    if (mealTab === 'recomendado') {
      // Una comida por tipo: la más ligera para perder, la más energética para ganar, la intermedia para mantener
      list = ['desayuno', 'almuerzo', 'cena', 'snack'].map((type) => {
        const opts = MEALS.filter((m) => m.type === type).sort((a, b) => a.kcal - b.kcal);
        if (goal === 'perder') return opts[0];
        if (goal === 'ganar') return opts.at(-1);
        return opts[Math.floor(opts.length / 2)];
      }).filter(Boolean); // un tipo sin recetas simplemente no aparece
      const sum = list.reduce((s, m) => s + m.kcal, 0);
      note = cal
        ? `Este menú suma ${fmtInt(sum)} kcal de tus ${fmtInt(cal.target)} kcal. Completa con fruta, verdura y porciones de cereal según tu hambre.`
        : `Este menú suma ${fmtInt(sum)} kcal.`;
    } else {
      list = MEALS.filter((m) => m.type === mealTab);
    }
    $('#plan-tab-note').textContent = note;
    if (!list.length) {
      emptyState($('#plan-meals'), 'fa-bowl-food', 'Todavía no hay recetas en esta sección.');
      return;
    }
    $('#plan-meals').innerHTML = list.map((m) => mealCardHTML(m, cal)).join('');
  }

  /* ---------- Receta detallada ---------- */
  const recipeDialog = $('#recipe-dialog');

  function openRecipe(id) {
    const m = MEALS.find((x) => x.id === id);
    if (!m) {
      toast('No encontramos esa receta.', 'error');
      location.replace('#/app/plan');
      return;
    }
    const cal = calcCalories(currentUser().profile);
    const siblings = MEALS.filter((x) => x.type === m.type);
    const i = siblings.indexOf(m);
    const prev = siblings[(i - 1 + siblings.length) % siblings.length];
    const next = siblings[(i + 1) % siblings.length];
    $('#recipe-body').innerHTML = `
      <div class="recipe__hero">
        <img src="${escapeHTML(mealImage(m, 1200))}" alt="${escapeHTML(m.name)}" decoding="async" data-fallback>
        <button type="button" class="icon-btn" data-close-recipe aria-label="Cerrar receta"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
        <div class="recipe__hero-text">
          <span class="badge badge--accent">${MEAL_LABEL[m.type]}</span>
          <h2 class="h-md" id="recipe-title">${escapeHTML(m.name)}</h2>
        </div>
        ${isUnsplash(m.img) ? '<a class="recipe__credit" href="https://unsplash.com/" target="_blank" rel="noopener noreferrer">Foto: Unsplash</a>' : ''}
      </div>
      <div class="recipe__content">
        <div class="recipe__facts">
          <div><strong>${m.kcal}</strong><span>kcal</span></div>
          <div><strong>${m.min}</strong><span>minutos</span></div>
          <div><strong>${fmtNum(m.macros.p)} g</strong><span>proteína</span></div>
          <div><strong>${cal ? `${Math.round((m.kcal / cal.target) * 100)} %` : '1'}</strong><span>${cal ? 'de tu día' : 'porción'}</span></div>
        </div>
        <p class="muted">${escapeHTML(m.desc)} Carbohidratos: ${fmtNum(m.macros.c)} g · Grasas: ${fmtNum(m.macros.f)} g.</p>
        <div class="recipe__cols">
          <div>
            <h3>Ingredientes</h3>
            <ul class="recipe__ingredients">
              ${m.ingredients.map((ing) => `<li><label><input type="checkbox"><span>${escapeHTML(ing)}</span></label></li>`).join('')}
            </ul>
          </div>
          <div>
            <h3>Preparación</h3>
            <ol class="recipe__steps">${m.steps.map((s) => `<li><span>${escapeHTML(s)}</span></li>`).join('')}</ol>
          </div>
        </div>
        ${m.tip ? `<p class="recipe__tip"><i class="fa-solid fa-lightbulb" aria-hidden="true"></i><span><strong>Consejo:</strong> ${escapeHTML(m.tip)}</span></p>` : ''}
        <div class="tags">${m.tags.map((t) => `<span class="tag">${escapeHTML(t)}</span>`).join('')}</div>
        ${siblings.length > 1 ? `<div class="recipe__nav">
          <a class="btn btn--ghost btn--sm" href="#/app/plan?receta=${encodeURIComponent(prev.id)}"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> ${escapeHTML(prev.name)}</a>
          <a class="btn btn--ghost btn--sm" href="#/app/plan?receta=${encodeURIComponent(next.id)}">${escapeHTML(next.name)} <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a>
        </div>` : ''}
      </div>`;
    recipeDialog.scrollTop = 0;
    if (!recipeDialog.open) recipeDialog.showModal();
    $('[data-close-recipe]', recipeDialog).focus();
  }

  function closeRecipe() {
    if (recipeDialog.open) recipeDialog.close();
  }

  // Al cerrar (botón, Escape o clic fuera) se quita ?receta= de la URL
  recipeDialog.addEventListener('close', () => {
    if (parseHash().params.has('receta')) location.replace('#/app/plan');
  });
  recipeDialog.addEventListener('click', (e) => {
    if (e.target === recipeDialog || e.target.closest('[data-close-recipe]')) closeRecipe();
  });

  // Si una foto no carga, se muestra un fondo verde con un icono en su lugar
  document.addEventListener('error', (e) => {
    if (e.target.tagName === 'IMG' && e.target.hasAttribute('data-fallback')) e.target.parentElement.classList.add('is-broken');
  }, true);

  $('#plan-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-meal]');
    if (!btn) return;
    mealTab = btn.dataset.meal;
    selectTab($('#plan-tabs'), btn);
    const u = currentUser();
    renderMeals(calcCalories(u.profile), u.profile.goal);
  });

  function selectTab(group, btn) {
    $$('.tab', group).forEach((t) => {
      t.classList.toggle('is-active', t === btn);
      t.setAttribute('aria-selected', String(t === btn));
    });
  }

  /* ---------- Actividad física ---------- */
  $('#act-type').innerHTML = `<option value="">Selecciona una actividad</option>${ACTIVITY_TYPES.map((t) => `<option value="${t.key}">${t.label}</option>`).join('')}`;

  RENDER.actividad = () => {
    const u = currentUser();
    const p = u.profile;
    const form = $('#activity-form');
    if (!form.date.value) form.date.value = todayISO();
    form.date.max = todayISO();

    const goal = p.minutesGoal || 30;
    const todays = u.activities.filter((a) => a.date === todayISO());
    const minutes = todays.reduce((s, a) => s + a.minutes, 0);
    const steps = todays.reduce((s, a) => s + (a.steps || 0), 0);
    const kcal = todays.reduce((s, a) => s + a.kcal, 0);
    $('#act-minutes').textContent = minutes;
    $('#act-goal').textContent = `de ${goal} min`;
    $('#act-ring').setAttribute('stroke-dasharray', `${clamp((minutes / goal) * 100, 0, 100)} 100`);
    $('#act-steps').textContent = fmtInt(steps);
    $('#act-km').textContent = `${fmt(steps * 0.00075)} km`;
    $('#act-kcal').textContent = `${fmtInt(kcal)} kcal`;

    const week = weekData(u);
    if (week.some((d) => d.value)) barChart($('#act-week-chart'), week, { goal });
    else emptyState($('#act-week-chart'), 'fa-chart-column', 'Registra tu primera actividad para ver tu semana.');

    const recent = [...u.activities]
      .sort((a, b) => b.date.localeCompare(a.date) || String(b.created).localeCompare(String(a.created)))
      .slice(0, 8);
    $('#act-log').innerHTML = recent.length ? recent.map((a) => {
      const t = ACTIVITY_TYPES.find((x) => x.key === a.type) || ACTIVITY_TYPES[0];
      return `<li>
        <i class="fa-solid ${t.icon}" aria-hidden="true"></i>
        <div><strong>${t.label}</strong><span>${fmtDate(a.date, { weekday: 'short', day: 'numeric', month: 'short' })} · ${a.minutes} min${a.steps ? ` · ${fmtInt(a.steps)} pasos` : ''} · ${a.kcal} kcal</span></div>
        <button class="icon-btn" data-del-activity="${a.id}" aria-label="Eliminar ${t.label} del ${fmtDate(a.date)}"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
      </li>`;
    }).join('') : '<li class="muted">Sin registros todavía.</li>';

    const bmi = currentBMI(u);
    const group = exerciseGroup(bmi);
    $('#act-rec-cat').textContent = bmi ? bmiCategory(bmi).label : 'General';
    $('#act-recommended').innerHTML = EXERCISES[group].map((x) => `
      <li><i class="fa-solid ${x.icon}" aria-hidden="true"></i><div><strong>${x.name}</strong><span>${x.meta}</span></div></li>`).join('')
      + (bmi ? '' : '<li class="muted">Calcula tu IMC para recibir ejercicios adaptados.</li>');
  };

  $('#activity-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    clearForm(f);
    const minutes = parseNum(f.minutes.value);
    const stepsRaw = f.steps.value.trim();
    const steps = stepsRaw ? parseNum(stepsRaw) : 0;

    const errors = {
      type: f.type.value ? '' : 'Selecciona el tipo de actividad.',
      minutes: !f.minutes.value.trim() ? 'Escribe cuántos minutos.'
        : (Number.isNaN(minutes) || !Number.isInteger(minutes)) ? 'Los minutos deben ser un número entero.'
        : minutes < 1 ? 'Debe ser al menos 1 minuto.'
        : minutes > 600 ? 'Máximo 600 minutos por registro.' : '',
      steps: !stepsRaw ? ''
        : (Number.isNaN(steps) || !Number.isInteger(steps) || steps < 0) ? 'Los pasos deben ser un número entero positivo.'
        : steps > 100000 ? 'Máximo 100 000 pasos por registro.' : '',
      date: validate.date(f.date.value, { maxDaysBack: 90 }),
    };
    if (!errors.minutes && !errors.date) {
      const dayTotal = minutesOn(currentUser(), f.date.value) + minutes;
      if (dayTotal > 960) errors.minutes = `Con este registro sumarías ${dayTotal} min ese día. Revisa los datos.`;
    }
    if (!applyErrors(f, errors)) return;

    const type = ACTIVITY_TYPES.find((t) => t.key === f.type.value);
    const u = currentUser();
    const saved = await withBusy($('button[type="submit"]', f), async () => {
      try {
        const activity = await db.addActivity({
          type: type.key, minutes, steps, date: f.date.value,
          kcal: activityKcal(type.met, minutes, u.profile.weight),
        });
        u.activities.unshift(activity);
        return true;
      } catch (err) {
        formAlert(f, err.message);
        return false;
      }
    });
    if (!saved) return;
    toast(`${type.label}: ${minutes} min registrados.`, 'success');
    f.reset();
    f.date.value = todayISO();
    RENDER.actividad();
  });

  $('#act-log').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-del-activity]');
    if (!btn) return;
    const ok = await confirmDialog({ title: 'Eliminar actividad', body: '¿Seguro que quieres eliminar este registro?', confirmLabel: 'Eliminar' });
    if (!ok) return;
    const id = Number(btn.dataset.delActivity);
    try {
      await db.deleteActivity(id);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    const u = currentUser();
    u.activities = u.activities.filter((a) => a.id !== id);
    toast('Actividad eliminada.', 'info');
    RENDER.actividad();
  });

  /* ---------- Progreso ---------- */
  const progState = { range: 7, metric: 'bmi' };

  RENDER.progreso = () => {
    const u = currentUser();
    const form = $('#record-form');
    if (!form.date.value) form.date.value = todayISO();
    form.date.max = todayISO();

    const all = u.history;
    const from = progState.range ? isoDaysAgo(progState.range - 1) : '0000-00-00';
    const inRange = all.filter((r) => r.date >= from);
    const chart = $('#prog-chart');
    const isBMI = progState.metric === 'bmi';

    if (!all.length) {
      emptyState(chart, 'fa-chart-line', 'Aún no tienes registros. Guarda tu IMC desde la calculadora o añade tu peso abajo.',
        '<button type="button" class="btn btn--ghost btn--sm" id="load-sample">Cargar datos de ejemplo</button>');
    } else if (!inRange.length) {
      emptyState(chart, 'fa-calendar-xmark', 'No hay registros en este periodo. Prueba con un rango más amplio.');
    } else {
      lineChart(chart, inRange.map((r) => ({ date: r.date, value: isBMI ? r.bmi : r.weight })), {
        unit: isBMI ? '' : 'kg',
        band: isBMI ? [18.5, 24.9] : (u.profile.height ? healthyRange(u.profile.height) : null),
        goal: !isBMI && u.profile.target ? u.profile.target : null,
        height: 300,
        label: isBMI ? 'Evolución del IMC' : 'Evolución del peso',
      });
    }

    const first = inRange[0], last = inRange.at(-1);
    const dW = first && last && inRange.length > 1 ? round1(last.weight - first.weight) : null;
    const dB = first && last && inRange.length > 1 ? round1(last.bmi - first.bmi) : null;
    const target = u.profile.target;
    const sign = (n) => (n > 0 ? '+' : '');
    const stats = [
      { label: 'Cambio de peso', value: dW === null ? '—' : `${sign(dW)}${fmt(dW)}<small> kg</small>`, accent: true },
      { label: 'Cambio de IMC', value: dB === null ? '—' : `${sign(dB)}${fmt(dB)}` },
      { label: 'Registros', value: inRange.length },
      { label: 'Para tu objetivo', value: target && last ? `${fmt(Math.abs(last.weight - target))}<small> kg</small>` : '—' },
    ];
    $('#prog-stats').innerHTML = stats.map((s) => `
      <div class="stat${s.accent ? ' stat--accent' : ''}"><span class="stat__value">${s.value}</span><span class="stat__label">${s.label}</span></div>`).join('');

    $('#rec-count').textContent = `${all.length} ${all.length === 1 ? 'registro' : 'registros'}`;
    $('#rec-table').innerHTML = all.length ? [...all].reverse().map((r) => `
      <tr>
        <td>${fmtDate(r.date, { day: 'numeric', month: 'short', year: 'numeric' })}</td>
        <td>${fmt(r.weight)} kg</td>
        <td>${fmt(r.bmi)}</td>
        <td><button class="icon-btn" data-del-record="${r.id}" data-date="${r.date}" aria-label="Eliminar registro del ${fmtDate(r.date)}"><i class="fa-solid fa-trash" aria-hidden="true"></i></button></td>
      </tr>`).join('') : '<tr><td colspan="4" class="muted">Sin registros.</td></tr>';
  };

  $('#prog-range').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-range]');
    if (!btn) return;
    progState.range = Number(btn.dataset.range);
    selectTab($('#prog-range'), btn);
    RENDER.progreso();
  });
  $('#prog-metric').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-metric]');
    if (!btn) return;
    progState.metric = btn.dataset.metric;
    selectTab($('#prog-metric'), btn);
    RENDER.progreso();
  });

  $('#record-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    clearForm(f);
    const u = currentUser();
    if (!u.profile.height) {
      formAlert(f, 'Para calcular el IMC de cada registro necesitamos tu altura. Agrégala en tu perfil.');
      return;
    }
    if (!applyErrors(f, { weight: validate.weight(f.weight.value), date: validate.date(f.date.value) })) return;

    const weight = parseNum(f.weight.value);
    const date = f.date.value;
    const prev = u.history.filter((r) => r.date < date).at(-1);
    if (prev) {
      const days = Math.max(1, (parseISO(date) - parseISO(prev.date)) / 86400000);
      if (Math.abs(weight - prev.weight) / days > 2) {
        const ok = await confirmDialog({
          title: '¿El peso es correcto?',
          body: `Es un cambio de ${fmt(Math.abs(weight - prev.weight))} kg respecto a tu registro del ${fmtDate(prev.date)}. Un cambio tan rápido es poco habitual.`,
          confirmLabel: 'Sí, guardar',
        });
        if (!ok) { f.weight.focus(); return; }
      }
    }
    if (u.history.some((r) => r.date === date)) {
      const ok = await confirmDialog({ title: 'Ya tienes un registro ese día', body: '¿Quieres reemplazarlo por el nuevo peso?', confirmLabel: 'Reemplazar' });
      if (!ok) return;
    }

    const saved = await withBusy($('button[type="submit"]', f), async () => {
      try {
        await saveRecord({ date, weight, height: u.profile.height });
        const latest = u.history.at(-1);
        if (latest.weight !== u.profile.weight) await saveProfile({ weight: latest.weight });
        return true;
      } catch (err) {
        formAlert(f, err.message);
        return false;
      }
    });
    if (!saved) return;
    toast('Registro guardado.', 'success');
    f.reset();
    f.date.value = todayISO();
    RENDER.progreso();
  });

  $('#rec-table').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-del-record]');
    if (!btn) return;
    const ok = await confirmDialog({ title: 'Eliminar registro', body: `¿Eliminar el registro del ${fmtDate(btn.dataset.date, { day: 'numeric', month: 'long' })}?`, confirmLabel: 'Eliminar' });
    if (!ok) return;
    const id = Number(btn.dataset.delRecord);
    try {
      await db.deleteRecord(id);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    const u = currentUser();
    u.history = u.history.filter((r) => r.id !== id);
    toast('Registro eliminado.', 'info');
    RENDER.progreso();
  });

  /* Datos de ejemplo para explorar la vista (se guardan en tu cuenta y se pueden borrar) */
  document.addEventListener('click', async (e) => {
    if (e.target.id !== 'load-sample') return;
    const btn = e.target;
    const u = currentUser();
    const h = u.profile.height || 172;
    const start = u.profile.weight || 82;
    const ok = await withBusy(btn, async () => {
      try {
        for (let i = 0; i < 12; i++) {
          const w = start + 3.2 - i * 0.32 + Math.sin(i * 1.7) * 0.4;
          await saveRecord({ date: isoDaysAgo((11 - i) * 8), weight: w, height: h });
        }
        for (let i = 0; i < 6; i++) {
          const t = ACTIVITY_TYPES[i % 4];
          const minutes = 20 + ((i * 13) % 35);
          u.activities.unshift(await db.addActivity({
            type: t.key, minutes, steps: t.key === 'caminata' ? minutes * 110 : 0,
            date: isoDaysAgo(i + 1), kcal: activityKcal(t.met, minutes, start),
          }));
        }
        await saveProfile({ height: h, weight: u.history.at(-1).weight });
        return true;
      } catch (err) {
        toast(err.message, 'error');
        return false;
      }
    });
    if (!ok) return;
    toast('Cargamos datos de ejemplo. Puedes borrarlos desde el historial.', 'info');
    progState.range = 0;
    selectTab($('#prog-range'), $('#prog-range [data-range="0"]'));
    RENDER.progreso();
  });

  /* ---------- Información ---------- */
  RENDER.informacion = (params) => {
    const u = currentUser();
    const bmi = currentBMI(u);
    const box = $('#info-personal');
    if (bmi) {
      const cat = bmiCategory(bmi);
      const range = u.profile.height ? healthyRange(u.profile.height) : null;
      box.innerHTML = `
        <span class="tile__label">Tu IMC en contexto</span>
        <h2 class="h-md">${fmt(bmi)} · ${cat.label}</h2>
        <p>${cat.msg}</p>
        ${range ? `<p class="caption">Para tu altura de ${u.profile.height} cm, el rango de peso saludable es ${fmt(range[0])} – ${fmt(range[1])} kg.</p>` : ''}`;
    } else {
      box.innerHTML = `
        <span class="tile__label">Tu IMC en contexto</span>
        <h2 class="h-md">Aún no conocemos tu IMC</h2>
        <p>Calcúlalo para ver aquí una lectura personalizada de tu resultado.</p>
        <a href="#/app/calculadora" class="btn btn--primary btn--sm" style="justify-self:start">Calcular IMC</a>`;
    }
    $('#info-grid').innerHTML = ARTICLES.map((a) => `
      <button type="button" class="info-card" data-article="${a.id}" aria-controls="info-article">
        <i class="fa-solid ${a.icon}" aria-hidden="true"></i>
        <h3>${a.title}</h3>
        <p>${a.summary}</p>
        <span>Leer más <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></span>
      </button>`).join('');
    const open = params?.get('articulo');
    if (open) openArticle(open, false); else $('#info-article').hidden = true;
  };

  function openArticle(id, focus = true) {
    const a = ARTICLES.find((x) => x.id === id);
    const panel = $('#info-article');
    if (!a) { panel.hidden = true; return; }
    $$('.info-card').forEach((c) => c.classList.toggle('is-active', c.dataset.article === id));
    panel.innerHTML = `<h2 class="h-md">${a.title}</h2>${a.body}<button type="button" class="btn btn--ghost" id="close-article">Cerrar artículo</button>`;
    panel.hidden = false;
    if (focus) { panel.focus(); panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }
  $('#info-grid').addEventListener('click', (e) => {
    const card = e.target.closest('[data-article]');
    if (card) openArticle(card.dataset.article);
  });
  $('#info-article').addEventListener('click', (e) => {
    if (e.target.id !== 'close-article') return;
    $('#info-article').hidden = true;
    $$('.info-card').forEach((c) => c.classList.remove('is-active'));
  });

  /* ---------- Perfil y ajustes ---------- */
  function setProfileTab(tab) {
    const btn = $(`#profile-tabs [data-ptab="${tab}"]`) || $('#profile-tabs [data-ptab="perfil"]');
    selectTab($('#profile-tabs'), btn);
    $$('[data-ppanel]').forEach((p) => { p.hidden = p.dataset.ppanel !== btn.dataset.ptab; });
  }
  $('#profile-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ptab]');
    if (btn) setProfileTab(btn.dataset.ptab);
  });

  function fillProfileForms() {
    const u = currentUser();
    const p = u.profile;
    const pf = $('#profile-form');
    clearForm(pf);
    pf.name.value = u.name;
    pf.email.value = u.email;
    pf.age.value = p.age ?? '';
    pf.sex.value = p.sex || '';
    pf.height.value = p.height ?? '';
    pf.weight.value = p.weight ?? '';

    const gf = $('#goals-form');
    clearForm(gf);
    $$('input[name="goal"]', gf).forEach((r) => { r.checked = r.value === p.goal; });
    gf.target.value = p.target ?? '';
    gf.minutesGoal.value = p.minutesGoal ?? 30;
    gf.level.value = p.level || 'ligero';
    $('#gl-warning').hidden = true;

    const nf = $('#notif-form');
    Object.entries(u.notifications || {}).forEach(([k, v]) => { if (nf.elements[k]) nf.elements[k].checked = v; });

    const pw = $('#password-form');
    clearForm(pw);
    pw.reset();
    // Tras abrir el enlace de recuperación no se pide la contraseña actual
    $('#pw-current-field').hidden = state.recovery;
    $('#pw-recovery-note').hidden = !state.recovery;
    $('#sec-last').textContent = u.previousLogin ? fmtDateTime(u.previousLogin) : 'Este es tu primer acceso';
    $('#sec-created').textContent = fmtDateTime(u.createdAt);
  }

  function renderProfileSummary() {
    const u = currentUser();
    const p = u.profile;
    const bmi = currentBMI(u);
    const cal = calcCalories(p);
    const items = [
      ['fa-scale-balanced', bmi ? `IMC ${fmt(bmi)} · ${bmiCategory(bmi).label}` : 'IMC sin calcular'],
      ['fa-bullseye', `${GOAL_LABEL[p.goal]}${p.target ? ` · ${fmt(p.target)} kg` : ''}`],
      ['fa-fire', cal ? `${fmtInt(cal.target)} kcal diarias` : 'Calorías pendientes'],
      ['fa-person-running', `${p.minutesGoal || 30} min de actividad al día`],
      ['fa-gauge', `Nivel ${LEVEL_LABEL[p.level].toLowerCase()}`],
    ];
    if (state.isAdmin) items.push(['fa-shield-halved', 'Cuenta de administrador']);
    $('#profile-summary').innerHTML = items.map(([icon, text]) => `<li><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${escapeHTML(text)}</span></li>`).join('');
  }

  RENDER.perfil = (params) => {
    fillProfileForms();
    renderProfileSummary();
    setProfileTab(params?.get('tab') || 'perfil');
  };

  $$('[data-reset-form]').forEach((b) => b.addEventListener('click', () => {
    fillProfileForms();
    toast('Cambios descartados.', 'info');
  }));

  $('#profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    clearForm(f);
    const ok = applyErrors(f, {
      name: validate.name(f.name.value),
      age: validate.age(f.age.value, { required: false }),
      height: validate.height(f.height.value, { required: false }),
      weight: validate.weight(f.weight.value, { required: false }),
    });
    if (!ok) { formAlert(f, 'Revisa los campos marcados.'); return; }

    const age = f.age.value.trim() ? parseNum(f.age.value) : null;
    const height = f.height.value.trim() ? parseNum(f.height.value) : null;
    const weight = f.weight.value.trim() ? round1(parseNum(f.weight.value)) : null;

    if (height && weight) {
      const bmi = calcBMI(weight, height);
      if (bmi < 10 || bmi > 80) {
        formAlert(f, 'La combinación de peso y altura da un IMC irreal. Comprueba las unidades (kg y cm).');
        return;
      }
    }

    const u = currentUser();
    const weightChanged = weight && weight !== u.profile.weight;
    let recordAdded = false;
    const saved = await withBusy($('button[type="submit"]', f), async () => {
      try {
        await saveProfile({ name: f.name.value.trim().replace(/\s+/g, ' '), age, sex: f.sex.value, height, weight });
        if (weightChanged && height) { await saveRecord({ date: todayISO(), weight, height }); recordAdded = true; }
        return true;
      } catch (err) {
        formAlert(f, err.message);
        return false;
      }
    });
    if (!saved) return;
    renderShell();
    renderProfileSummary();
    formAlert(f, recordAdded ? 'Perfil actualizado. También guardamos tu nuevo peso en tu progreso.' : 'Perfil actualizado.', 'success');
    toast('Cambios guardados.', 'success');
  });

  $('#goals-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    clearForm(f);
    const u = currentUser();
    const goal = f.goal.value || 'mantener';
    const minutes = parseNum(f.minutesGoal.value);
    const errors = {
      target: validate.weight(f.target.value, { required: false }),
      minutesGoal: !f.minutesGoal.value.trim() ? 'Escribe tu meta diaria.'
        : (Number.isNaN(minutes) || !Number.isInteger(minutes)) ? 'Debe ser un número entero.'
        : minutes < 10 || minutes > 300 ? 'Elige una meta entre 10 y 300 minutos.' : '',
    };
    const target = f.target.value.trim() ? round1(parseNum(f.target.value)) : null;
    const w = u.profile.weight;
    if (!errors.target && target && w) {
      if (goal === 'perder' && target >= w) errors.target = `Para perder peso, el objetivo debe ser menor a tu peso actual (${fmt(w)} kg).`;
      if (goal === 'ganar' && target <= w) errors.target = `Para ganar masa, el objetivo debe ser mayor a tu peso actual (${fmt(w)} kg).`;
    }
    if (!applyErrors(f, errors)) return;

    const warn = $('#gl-warning');
    warn.hidden = true;
    if (target && u.profile.height) {
      const tb = calcBMI(target, u.profile.height);
      if (tb < 18.5) { warn.hidden = false; warn.textContent = `Tu peso objetivo equivale a un IMC de ${fmt(tb)}, por debajo del rango saludable. Te recomendamos revisarlo con un profesional.`; }
      else if (tb >= 30) { warn.hidden = false; warn.textContent = `Tu peso objetivo equivale a un IMC de ${fmt(tb)}. Considera una meta dentro del rango saludable.`; }
    }

    const saved = await withBusy($('button[type="submit"]', f), async () => {
      try {
        await saveProfile({ goal, target, minutesGoal: minutes, level: f.level.value });
        return true;
      } catch (err) {
        formAlert(f, err.message);
        return false;
      }
    });
    if (!saved) return;
    renderProfileSummary();
    formAlert(f, 'Objetivos guardados. Tu plan de alimentación se actualizó.', 'success');
    toast('Objetivos guardados.', 'success');
  });

  $('#notif-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const notifications = {};
    ['weighIn', 'activity', 'tips', 'security'].forEach((k) => { notifications[k] = f.elements[k].checked; });
    await withBusy($('button[type="submit"]', f), async () => {
      try {
        await saveProfile({ notifications });
        toast('Preferencias de notificación guardadas.', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  $('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    clearForm(f);
    const u = currentUser();
    const recovery = state.recovery;
    const errors = {
      current: recovery || f.current.value ? '' : 'Escribe tu contraseña actual.',
      password: validate.newPassword(f.password.value, u.email),
      confirm: !f.confirm.value ? 'Confirma la nueva contraseña.' : f.confirm.value !== f.password.value ? 'Las contraseñas no coinciden.' : '',
    };
    if (!recovery && !errors.password && f.password.value === f.current.value) errors.password = 'La nueva contraseña debe ser distinta de la actual.';
    if (!applyErrors(f, errors)) return;

    const saved = await withBusy($('button[type="submit"]', f), async () => {
      try {
        if (recovery) await db.setNewPassword(f.password.value);
        else await db.changePassword(f.current.value, f.password.value);
        return true;
      } catch (err) {
        if (/actual no es correcta/.test(err.message)) applyErrors(f, { current: err.message });
        else formAlert(f, err.message);
        return false;
      }
    });
    if (!saved) return;
    state.recovery = false;
    f.reset();
    $('#pw-current-field').hidden = false;
    $('#pw-recovery-note').hidden = true;
    formAlert(f, 'Contraseña actualizada correctamente.', 'success');
    toast('Contraseña actualizada.', 'success');
  });

  $('#delete-account').addEventListener('click', async (e) => {
    const btn = e.currentTarget; // tras un await, e.currentTarget ya es null
    const u = currentUser();
    const ok = await confirmDialog({
      title: 'Eliminar cuenta',
      body: 'Se borrarán tu perfil, tu historial de peso y tus actividades. Esta acción no se puede deshacer.',
      confirmLabel: 'Eliminar definitivamente',
      requireText: u.email,
      requireLabel: `Escribe ${u.email} para confirmar`,
    });
    if (!ok) return;
    const deleted = await withBusy(btn, async () => {
      try {
        state.loggingOut = true;
        await db.deleteAccount();
        return true;
      } catch (err) {
        toast(err.message, 'error', 6000);
        return false;
      } finally {
        state.loggingOut = false;
      }
    });
    if (!deleted) return;
    setAttempt(u.email, null);
    clearLocalState();
    toast('Tu cuenta fue eliminada.', 'info');
    location.hash = '#/inicio';
  });

  /* ---------- Sugerencias ---------- */
  RENDER.sugerencias = () => {
    const form = $('[data-feedback="app"] form');
    if (form) prefillFeedback(form);
  };

  /* ---------- Administración ---------- */
  const adminState = { users: [], range: 30, query: '', feedback: [], fbStatus: 'todas', tab: 'resumen', stat: 'weight_kg' };

  RENDER.admin = (params) => {
    showAdminTab(params?.get('tab') || 'resumen');
    loadAdmin();
  };

  function showAdminTab(tab) {
    const btn = $(`[data-admin-tab="${tab}"]`) || $('[data-admin-tab="resumen"]');
    adminState.tab = btn.dataset.adminTab;
    selectTab($('#admin-tabs'), btn);
    $$('[data-admin-panel]').forEach((p) => { p.hidden = p.dataset.adminPanel !== adminState.tab; });
    renderAdminCharts();
  }

  /* Las gráficas se dibujan al ancho real: solo se puede medir con su pestaña visible */
  function renderAdminCharts() {
    if (adminState.tab === 'resumen' && adminState.logins) renderAdminLogins(adminState.logins);
    if (adminState.tab === 'estadisticas' && adminState.users.length) renderAdminStats();
    if (adminState.tab === 'comidas') renderAdminMeals();
  }

  let adminResizeTimer = 0;
  let adminLastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth === adminLastWidth) return; // en celular la barra del navegador también dispara "resize"
    adminLastWidth = window.innerWidth;
    clearTimeout(adminResizeTimer);
    adminResizeTimer = setTimeout(() => {
      if (!$('[data-view="admin"]').hidden) renderAdminCharts();
    }, 150);
  });

  /* Aviso de sugerencias nuevas: menú lateral, pestaña y resumen */
  const FEEDBACK_CHECK_MS = 60 * 1000;
  let feedbackTimer = 0;
  let feedbackCount = null;

  function setFeedbackBadge(count) {
    feedbackCount = count;
    const label = count > 99 ? '99+' : String(count);
    ['#nav-feedback-count', '#admin-tab-feedback-count'].forEach((sel) => {
      const el = $(sel);
      el.hidden = !count;
      el.textContent = label;
      el.setAttribute('aria-label', `${count} sin leer`);
    });
    $('#admin-fb-notice').hidden = !count;
    $('#admin-fb-notice-text').textContent = count === 1 ? 'Tienes 1 sugerencia nueva por leer.' : `Tienes ${count} sugerencias nuevas por leer.`;
  }

  async function checkFeedback() {
    if (document.hidden) return;
    try {
      const count = await db.admin.newFeedbackCount();
      const arrived = feedbackCount !== null && count > feedbackCount;
      setFeedbackBadge(count);
      if (!arrived) return;
      toast('Llegó una sugerencia nueva.', 'info');
      if (!$('[data-view="admin"]').hidden) {
        adminState.feedback = await db.admin.listFeedback();
        renderAdminFeedback();
      }
    } catch { /* se reintenta en la siguiente comprobación */ }
  }

  function watchFeedback() {
    stopFeedbackWatch();
    checkFeedback();
    feedbackTimer = setInterval(checkFeedback, FEEDBACK_CHECK_MS);
  }
  function stopFeedbackWatch() {
    clearInterval(feedbackTimer);
    feedbackTimer = 0;
    feedbackCount = null;
  }

  async function loadAdmin() {
    const errorBox = $('#admin-error');
    errorBox.hidden = true;
    $('#admin-tiles').innerHTML = Array.from({ length: 8 }, () => '<article class="tile tile--loading"><span class="tile__label">Cargando…</span><span class="tile__value">—</span></article>').join('');
    try {
      const [metrics, dist, logins, users, feedback] = await Promise.all([
        db.admin.metrics(),
        db.admin.bmiDistribution(),
        db.admin.loginsPerDay(adminState.range),
        db.admin.listUsers(),
        db.admin.listFeedback(),
      ]);
      renderAdminMetrics(metrics);
      renderAdminDistribution(dist);
      renderAdminLogins(logins);
      adminState.users = users;
      renderAdminUsers();
      renderAdminCharts();
      adminState.feedback = feedback;
      renderAdminFeedback();
    } catch (err) {
      errorBox.hidden = false;
      errorBox.textContent = `No se pudieron cargar las métricas: ${err.message}`;
      $('#admin-tiles').innerHTML = '';
    }
  }

  const pct = (part, total) => (total ? `${Math.round((part / total) * 100)} %` : '0 %');
  const orDash = (v, render) => (v === null || v === undefined ? '—' : render(v));

  function renderAdminMetrics(m) {
    const tiles = [
      { label: 'Usuarios', value: fmtInt(m.usuarios), meta: `+${fmtInt(m.nuevos_30_dias)} en los últimos 30 días` },
      { label: 'Activos (7 días)', value: fmtInt(m.activos_7_dias), meta: `${pct(m.activos_7_dias, m.usuarios)} del total` },
      { label: 'Inicios de sesión hoy', value: fmtInt(m.inicios_sesion_hoy), meta: `${fmtInt(m.inicios_sesion_total)} en total` },
      { label: 'Con registro de peso', value: fmtInt(m.con_registro_de_peso), meta: `${pct(m.con_registro_de_peso, m.usuarios)} de los usuarios` },
      { label: 'Peso promedio', value: orDash(m.peso_promedio, (v) => `${fmt(v)}<small>kg</small>`), meta: 'Último registro de cada persona' },
      { label: 'IMC promedio', value: orDash(m.imc_promedio, (v) => fmt(v)), meta: m.imc_promedio ? bmiCategory(m.imc_promedio).label : 'Sin datos', accent: Boolean(m.imc_promedio) },
      { label: 'Edad promedio', value: orDash(m.edad_promedio, (v) => `${fmt(v, 0)}<small>años</small>`), meta: 'Perfiles con edad' },
      { label: 'Actividad semanal', value: orDash(m.minutos_promedio_semana, (v) => `${fmtInt(v)}<small>min</small>`), meta: 'Promedio por persona activa' },
    ];
    $('#admin-tiles').innerHTML = tiles.map((t) => `
      <article class="tile">
        <span class="tile__label">${t.label}</span>
        <span class="tile__value">${t.value}</span>
        <span class="tile__meta${t.accent ? ' is-accent' : ''}">${escapeHTML(t.meta)}</span>
      </article>`).join('');
  }

  function renderAdminDistribution(rows) {
    const total = rows.reduce((s, r) => s + Number(r.usuarios), 0);
    const max = Math.max(1, ...rows.map((r) => Number(r.usuarios)));
    if (!total) {
      emptyState($('#admin-dist'), 'fa-chart-bar', 'Aún nadie ha registrado su peso.');
      return;
    }
    $('#admin-dist').innerHTML = rows.map((r) => {
      const n = Number(r.usuarios);
      return `<li>
        <span class="dist__label">${escapeHTML(r.categoria)}</span>
        <div class="dist__bar" role="img" aria-label="${escapeHTML(r.categoria)}: ${n} personas"><span style="width:${(n / max) * 100}%"></span></div>
        <span class="dist__value">${n}<small>${pct(n, total)}</small></span>
      </li>`;
    }).join('');
  }

  function renderAdminLogins(rows) {
    adminState.logins = rows;
    const host = $('#admin-logins-chart');
    if (!host.clientWidth) return; // pestaña oculta: se dibuja al mostrarla
    const points = rows.map((r) => ({ date: String(r.dia).slice(0, 10), value: Number(r.inicios) }));
    if (!points.some((p) => p.value)) {
      emptyState(host, 'fa-right-to-bracket', 'No hubo inicios de sesión en este periodo.');
      return;
    }
    lineChart(host, points, { label: 'Inicios de sesión por día', decimals: 0, height: 240, width: host.clientWidth });
    const total = points.reduce((s, p) => s + p.value, 0);
    $('#admin-logins-total').textContent = `${fmtInt(total)} en ${points.length} días`;
  }

  function renderAdminUsers() {
    const q = adminState.query.trim().toLowerCase();
    const me = currentUser();
    const list = adminState.users.filter((u) => !q || u.name.toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q));
    $('#admin-user-count').textContent = `${list.length} de ${adminState.users.length}`;
    $('#admin-users').innerHTML = list.length ? list.map((u) => {
      const isMe = u.id === me.id;
      const isAdmin = u.role === 'admin';
      const bmi = u.bmi === null ? null : Number(u.bmi);
      const status = accountStatus(u);
      return `<tr>
        <td class="cell-name"><strong>${escapeHTML(u.name)}</strong>${isMe ? ' <span class="badge badge--sm">Tú</span>' : ''}</td>
        <td class="cell-email">${escapeHTML(u.email)}</td>
        <td data-label="Estado"><span class="badge badge--sm ${status.cls}">${status.label}</span></td>
        <td data-label="Rol"><span class="badge badge--sm${isAdmin ? ' badge--accent' : ''}">${isAdmin ? 'Admin' : 'Usuario'}</span></td>
        <td data-label="Peso">${u.weight_kg === null ? '—' : `${fmt(Number(u.weight_kg))} kg`}</td>
        <td data-label="IMC">${bmi ? `${fmt(bmi)} <span class="muted">· ${bmiCategory(bmi).label}</span>` : '—'}</td>
        <td data-label="Último acceso">${u.last_sign_in_at ? fmtDateTime(u.last_sign_in_at) : 'Nunca'}</td>
        <td class="row-actions">
          <button class="icon-btn" data-admin-view="${u.id}" title="Ver ficha" aria-label="Ver la ficha de ${escapeHTML(u.name)}"><i class="fa-solid fa-eye" aria-hidden="true"></i></button>
          <button class="icon-btn" data-admin-role="${u.id}" ${isMe ? 'disabled title="No puedes cambiar tu propio rol"' : ''}
            aria-label="${isAdmin ? 'Quitar rol de administrador a' : 'Hacer administrador a'} ${escapeHTML(u.name)}"
            title="${isAdmin ? 'Quitar rol de administrador' : 'Hacer administrador'}">
            <i class="fa-solid ${isAdmin ? 'fa-user-minus' : 'fa-user-shield'}" aria-hidden="true"></i></button>
          <button class="icon-btn icon-btn--danger" data-admin-delete="${u.id}" ${isMe || isAdmin ? `disabled title="${isMe ? 'Borra tu cuenta desde Perfil y ajustes' : 'Quita primero el rol de administrador'}"` : 'title="Eliminar cuenta"'}
            aria-label="Eliminar la cuenta de ${escapeHTML(u.name)}"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
        </td>
      </tr>`;
    }).join('') : '<tr class="row-empty"><td colspan="8" class="muted">Ningún usuario coincide con la búsqueda.</td></tr>';
  }

  $('#admin-search').addEventListener('input', (e) => {
    adminState.query = e.target.value;
    renderAdminUsers();
  });

  $('#admin-refresh').addEventListener('click', (e) => {
    withBusy(e.currentTarget, loadAdmin);
  });

  $('#admin-range').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-days]');
    if (!btn) return;
    adminState.range = Number(btn.dataset.days);
    selectTab($('#admin-range'), btn);
    try {
      renderAdminLogins(await db.admin.loginsPerDay(adminState.range));
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#admin-users').addEventListener('click', async (e) => {
    const delBtn = e.target.closest('[data-admin-delete]');
    const roleBtn = e.target.closest('[data-admin-role]');
    const viewBtn = e.target.closest('[data-admin-view]');
    if (viewBtn) openUserDetail(viewBtn.dataset.adminView);
    if (delBtn) {
      const user = adminState.users.find((u) => u.id === delBtn.dataset.adminDelete);
      if (!user) return;
      const ok = await confirmDialog({
        title: 'Eliminar cuenta',
        body: `Se borrará la cuenta de ${user.name} con todo su historial de peso y actividad. No se puede deshacer.`,
        confirmLabel: 'Eliminar cuenta',
        requireText: user.email,
        requireLabel: `Escribe ${user.email} para confirmar`,
      });
      if (!ok) return;
      try {
        await db.admin.deleteUser(user.id);
      } catch (err) {
        toast(err.message, 'error', 6000);
        return;
      }
      toast(`La cuenta de ${user.name} fue eliminada.`, 'success');
      loadAdmin();
    }
    if (roleBtn) {
      const user = adminState.users.find((u) => u.id === roleBtn.dataset.adminRole);
      if (!user) return;
      const makeAdmin = user.role !== 'admin';
      const ok = await confirmDialog({
        title: makeAdmin ? 'Hacer administrador' : 'Quitar rol de administrador',
        body: makeAdmin
          ? `${user.name} podrá ver las métricas y los datos de todas las personas, y eliminar cuentas.`
          : `${user.name} dejará de tener acceso al panel de administración.`,
        confirmLabel: makeAdmin ? 'Hacer administrador' : 'Quitar rol',
      });
      if (!ok) return;
      try {
        await db.admin.setRole(user.id, makeAdmin ? 'admin' : 'user');
      } catch (err) {
        toast(err.message, 'error');
        return;
      }
      toast(makeAdmin ? `${user.name} ahora es administrador.` : `${user.name} ya no es administrador.`, 'success');
      loadAdmin();
    }
  });

  /* Pestañas del panel */
  $('#admin-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-admin-tab]');
    if (!btn) return;
    showAdminTab(btn.dataset.adminTab);
    history.replaceState(null, '', `#/app/admin?tab=${adminState.tab}`);
  });

  /* Estado de la cuenta */
  function accountStatus(u) {
    if (!u.email_confirmed_at) return { label: 'Sin confirmar', cls: 'badge--warn' };
    if (!u.last_sign_in_at) return { label: 'Nunca entró', cls: 'badge--plain' };
    const days = (Date.now() - new Date(u.last_sign_in_at).getTime()) / 86400000;
    return days <= 30 ? { label: 'Activo', cls: 'badge--accent' } : { label: 'Inactivo', cls: 'badge--plain' };
  }

  /* Crear cuenta */
  const createUserDialog = $('#create-user-dialog');
  const createUserForm = $('#create-user-form');

  $('#admin-create-open').addEventListener('click', () => {
    createUserForm.reset();
    clearForm(createUserForm);
    createUserDialog.showModal();
    createUserForm.elements.name.focus();
  });

  createUserDialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-dialog]')) createUserDialog.close();
  });

  createUserForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = createUserForm;
    clearForm(f);
    const name = f.elements.name.value.trim().replace(/\s+/g, ' ');
    const email = f.elements.email.value.trim().toLowerCase();
    const password = f.elements.password.value;
    const valid = applyErrors(f, {
      name: validate.name(name),
      email: validate.email(email),
      password: validate.newPassword(password, email),
      consent: f.elements.consent.checked ? '' : 'Marca esta casilla para crear la cuenta.',
    });
    if (!valid) return;
    await withBusy($('#create-user-submit'), async () => {
      try {
        await db.admin.createUser({ name, email, password });
      } catch (err) {
        if (/Ya existe/.test(err.message)) setError(f.elements.email, err.message);
        else formAlert(f, err.message);
        return;
      }
      createUserDialog.close();
      toast(`Cuenta creada para ${name}.`, 'success');
      await loadAdmin();
    });
  });

  /* Ficha de una persona: estado, datos y evolución del peso */
  const userDialog = $('#user-dialog');
  userDialog.addEventListener('click', (e) => {
    if (e.target === userDialog || e.target.closest('[data-close-dialog]')) userDialog.close();
  });

  const SEX_LABEL = { m: 'Hombre', f: 'Mujer', x: 'Otro' };

  async function openUserDetail(id) {
    const u = adminState.users.find((x) => x.id === id);
    if (!u) return;
    const status = accountStatus(u);
    const bmi = u.bmi === null ? null : Number(u.bmi);
    const weights = adminStatValues('weight_kg');
    const zone = u.weight_kg !== null && weights.length ? iqrZone(Number(u.weight_kg), describeValues(weights)) : null;
    const rows = [
      ['Estado', `<span class="badge badge--sm ${status.cls}">${status.label}</span>`],
      ['Rol', u.role === 'admin' ? 'Administrador' : 'Usuario'],
      ['Alta', fmtStamp(u.created_at)],
      ['Último acceso', u.last_sign_in_at ? fmtDateTime(u.last_sign_in_at) : 'Nunca'],
      ['Inicios de sesión', fmtInt(Number(u.logins))],
      ['Edad', u.age === null ? '—' : `${u.age} años`],
      ['Sexo', SEX_LABEL[u.sex] || '—'],
      ['Altura', u.height_cm === null ? '—' : `${fmt(Number(u.height_cm), 0)} cm`],
      ['Último peso', u.weight_kg === null ? '—' : `${fmt(Number(u.weight_kg))} kg · ${fmtDate(String(u.weight_date).slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' })}`],
      ['IMC', bmi ? `${fmt(bmi)} · ${bmiCategory(bmi).label}` : '—'],
      ['Peso frente al grupo', zone ? `${zone.label}${zone.outlier ? ' (valor atípico)' : ''}` : '—'],
    ];
    $('#user-dialog-title').textContent = u.name;
    $('#user-dialog-body').innerHTML = `
      <p class="muted">${escapeHTML(u.email)}</p>
      <dl class="user-detail__list">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
      <h3 class="h-xs">Evolución del peso</h3>
      <div class="chart" id="user-dialog-chart"><p class="caption muted">Cargando…</p></div>`;
    userDialog.showModal();
    const host = $('#user-dialog-chart');
    try {
      const records = await db.admin.userWeights(id);
      if (!records.length) {
        emptyState(host, 'fa-weight-scale', 'Esta persona aún no ha registrado su peso.');
        return;
      }
      lineChart(host, records.map((r) => ({ date: r.date, value: Number(r.weight_kg) })), { unit: 'kg', height: 220, label: `Evolución del peso de ${u.name}`, width: host.clientWidth });
    } catch (err) {
      host.innerHTML = `<p class="caption muted">${escapeHTML(err.message)}</p>`;
    }
  }

  /* Estadísticas: media aritmética y cuartiles de todas las personas registradas */
  const STAT_INFO = {
    weight_kg: { label: 'Peso', unit: 'kg' },
    bmi: { label: 'IMC', unit: '' },
  };
  const adminStatValues = (key) => adminState.users.filter((u) => u[key] !== null).map((u) => Number(u[key]));

  /** Cuantil por interpolación lineal (igual que percentile_cont de Postgres). */
  const quantile = (sorted, q) => {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  };

  function describeValues(values) {
    const v = [...values].sort((a, b) => a - b);
    const q1 = quantile(v, 0.25);
    const q3 = quantile(v, 0.75);
    const iqr = q3 - q1;
    const low = q1 - 1.5 * iqr;
    const high = q3 + 1.5 * iqr;
    const inside = v.filter((x) => x >= low && x <= high);
    return {
      n: v.length, mean: v.reduce((s, x) => s + x, 0) / v.length, median: quantile(v, 0.5),
      min: v[0], max: v[v.length - 1], q1, q3, iqr, low, high,
      whiskerLow: inside[0], whiskerHigh: inside[inside.length - 1],
    };
  }

  const IQR_ZONES = ['Por debajo de Q1', 'Entre Q1 y la mediana', 'Entre la mediana y Q3', 'Por encima de Q3'];
  function iqrZone(x, s) {
    const index = x < s.q1 ? 0 : x <= s.median ? 1 : x <= s.q3 ? 2 : 3;
    return { index, label: IQR_ZONES[index], outlier: x < s.low || x > s.high };
  }

  function renderAdminStats() {
    const key = adminState.stat;
    const { label, unit } = STAT_INFO[key];
    const people = adminState.users.filter((u) => u[key] !== null);
    const suffix = unit ? ` ${unit}` : '';
    const val = (n) => `${fmt(n)}${suffix}`;
    const total = adminState.users.length;
    $('#admin-stat-title').textContent = `${label}: media y rango intercuartílico`;
    if (!people.length) {
      $('#admin-stat-tiles').innerHTML = '';
      $('#admin-stat-reading').textContent = '';
      $('#admin-stat-zones').innerHTML = '';
      $('#admin-stat-table').innerHTML = '';
      $('#admin-boxplot-legend').hidden = true;
      emptyState($('#admin-boxplot'), 'fa-chart-simple', 'Aún nadie ha registrado su peso.');
      return;
    }
    $('#admin-boxplot-legend').hidden = false;
    const s = describeValues(people.map((u) => Number(u[key])));
    const outliers = people.filter((u) => iqrZone(Number(u[key]), s).outlier).length;
    const small = unit ? `<small>${unit}</small>` : '';
    const tiles = [
      { label: 'Media aritmética', value: `${fmt(s.mean)}${small}`, meta: `${fmtInt(s.n)} de ${fmtInt(total)} personas con datos` },
      { label: 'Mediana', value: `${fmt(s.median)}${small}`, meta: 'Valor del centro' },
      { label: 'Rango intercuartílico', value: `${fmt(s.iqr)}${small}`, meta: `Q1 ${fmt(s.q1)} a Q3 ${fmt(s.q3)}` },
      { label: 'Valores atípicos', value: fmtInt(outliers), meta: `Fuera de ${fmt(s.low)} a ${fmt(s.high)}` },
    ];
    $('#admin-stat-tiles').innerHTML = tiles.map((t) => `
      <article class="tile">
        <span class="tile__label">${t.label}</span>
        <span class="tile__value">${t.value}</span>
        <span class="tile__meta">${escapeHTML(t.meta)}</span>
      </article>`).join('');

    const position = s.mean < s.q1 ? 'por debajo del rango intercuartílico'
      : s.mean > s.q3 ? 'por encima del rango intercuartílico' : 'dentro del rango intercuartílico';
    const gap = s.mean - s.median;
    const skew = Math.abs(gap) < 0.05 ? 'Coincide con la mediana: los datos están equilibrados.'
      : gap > 0 ? 'Está sobre la mediana: los valores altos la empujan hacia arriba.'
        : 'Está bajo la mediana: los valores bajos la empujan hacia abajo.';
    const few = s.n < 4 ? ' Con menos de 4 personas los cuartiles orientan poco.' : '';
    $('#admin-stat-reading').textContent = `La media (${val(s.mean)}) está ${position} (${val(s.q1)} a ${val(s.q3)}). ${skew}${few}`;

    boxPlot($('#admin-boxplot'), people.map((u) => ({ name: u.name, value: Number(u[key]) })), s, { label, unit });

    const counts = IQR_ZONES.map(() => 0);
    people.forEach((u) => { counts[iqrZone(Number(u[key]), s).index] += 1; });
    const maxCount = Math.max(1, ...counts);
    $('#admin-stat-zones').innerHTML = IQR_ZONES.map((z, i) => `<li>
        <span class="dist__label">${z}</span>
        <div class="dist__bar" role="img" aria-label="${z}: ${counts[i]} personas"><span style="width:${(counts[i] / maxCount) * 100}%"></span></div>
        <span class="dist__value">${counts[i]}<small>${pct(counts[i], s.n)}</small></span>
      </li>`).join('');

    $('#admin-stat-table').innerHTML = [
      ['Personas con datos', fmtInt(s.n)], ['Mínimo', val(s.min)], ['Q1 (cuartil 1)', val(s.q1)], ['Mediana', val(s.median)],
      ['Media aritmética', val(s.mean)], ['Q3 (cuartil 3)', val(s.q3)], ['Máximo', val(s.max)],
      ['Rango intercuartílico', val(s.iqr)], ['Límite inferior', val(s.low)], ['Límite superior', val(s.high)],
    ].map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`).join('');
  }

  /** Diagrama de caja horizontal: caja Q1-Q3, mediana, media y un punto por persona. */
  function boxPlot(host, points, s, { label, unit }) {
    const W = Math.max(280, host.clientWidth || SVG_W);
    const H = 252;
    const pad = { l: 24, r: 24 };
    let lo = s.min;
    let hi = s.max;
    if (hi - lo < 2) { lo -= 1; hi += 1; }
    const margin = (hi - lo) * 0.06;
    lo -= margin;
    hi += margin;
    const x = (v) => pad.l + (W - pad.l - pad.r) * ((v - lo) / (hi - lo));
    const boxY = 74;
    const boxH = 44;
    const midY = boxY + boxH / 2;
    const dotsY = 166;
    const axisY = 218;
    const suffix = unit ? ` ${unit}` : '';
    const n1 = (v) => `${fmt(v)}${suffix}`;

    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHTML(`${label}: media ${n1(s.mean)}, mediana ${n1(s.median)}, Q1 ${n1(s.q1)}, Q3 ${n1(s.q3)}, ${s.n} personas`)}">`;
    // Marcas del eje en números redondos
    const step = [0.5, 1, 2, 5, 10, 20, 50, 100].find((c) => (hi - lo) / c <= 6) || 100;
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      svg += `<line class="grid-line" x1="${x(v)}" x2="${x(v)}" y1="${boxY - 10}" y2="${axisY}"/>`;
      svg += `<text class="axis-label" x="${x(v)}" y="${axisY + 18}" text-anchor="middle">${fmt(v, step < 1 ? 1 : 0)}</text>`;
    }
    // Bigotes
    svg += `<line class="box-whisker" x1="${x(s.whiskerLow)}" x2="${x(s.q1)}" y1="${midY}" y2="${midY}"/>`;
    svg += `<line class="box-whisker" x1="${x(s.q3)}" x2="${x(s.whiskerHigh)}" y1="${midY}" y2="${midY}"/>`;
    [s.whiskerLow, s.whiskerHigh].forEach((v) => { svg += `<line class="box-whisker" x1="${x(v)}" x2="${x(v)}" y1="${midY - 8}" y2="${midY + 8}"/>`; });
    // Caja y mediana
    svg += `<rect class="box-iqr" x="${x(s.q1)}" y="${boxY}" width="${Math.max(2, x(s.q3) - x(s.q1))}" height="${boxH}" rx="4"><title>50 % central: ${n1(s.q1)} a ${n1(s.q3)}</title></rect>`;
    svg += `<line class="box-median" x1="${x(s.median)}" x2="${x(s.median)}" y1="${boxY}" y2="${boxY + boxH}"><title>Mediana: ${n1(s.median)}</title></line>`;
    // Media
    const mx = x(s.mean);
    svg += `<path class="box-mean" d="M${mx} ${midY - 8}L${mx + 8} ${midY}L${mx} ${midY + 8}L${mx - 8} ${midY}Z"><title>Media aritmética: ${n1(s.mean)}</title></path>`;
    // Etiquetas de Q1, mediana y Q3: si se tocan, suben a otra fila
    const rowEnds = [-Infinity, -Infinity, -Infinity];
    const labelW = 86;
    [['Q1', s.q1], ['Mediana', s.median], ['Q3', s.q3]].forEach(([name, v]) => {
      const lx = clamp(x(v), pad.l + labelW / 2, W - pad.r - labelW / 2);
      const row = rowEnds.findIndex((end) => lx - labelW / 2 >= end);
      rowEnds[row] = lx + labelW / 2;
      svg += `<text class="box-label" x="${lx}" y="${boxY - 14 - row * 16}" text-anchor="middle">${name} ${fmt(v)}</text>`;
    });
    svg += `<text class="box-label box-label--mean" x="${clamp(mx, pad.l + 44, W - pad.r - 44)}" y="${boxY + boxH + 18}" text-anchor="middle">Media ${fmt(s.mean)}</text>`;
    // Un punto por persona, en cuatro alturas para que no se tapen
    points.forEach((p, i) => {
      const out = p.value < s.low || p.value > s.high;
      const cy = dotsY + (i % 4) * 11;
      svg += `<g><title>${escapeHTML(p.name)}: ${n1(p.value)}${out ? ' (atípico)' : ''}</title><circle class="box-hit" cx="${x(p.value)}" cy="${cy}" r="10"/><circle class="${out ? 'box-dot box-dot--out' : 'box-dot'}" cx="${x(p.value)}" cy="${cy}" r="4.5"/></g>`;
    });
    host.innerHTML = `${svg}</svg>`;
  }

  $('#admin-stat-metric').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-stat]');
    if (!btn) return;
    adminState.stat = btn.dataset.stat;
    selectTab($('#admin-stat-metric'), btn);
    renderAdminStats();
  });

  /* ---------- Comidas recomendadas: agregar, editar y eliminar ---------- */
  const mealState = { filter: 'todas', editing: null };

  function renderAdminMeals() {
    const list = mealState.filter === 'todas' ? MEALS : MEALS.filter((m) => m.type === mealState.filter);
    const counts = Object.keys(MEAL_LABEL).map((t) => {
      const n = MEALS.filter((m) => m.type === t).length;
      return `${n} ${MEAL_LABEL[t].toLowerCase()}${n === 1 ? '' : 's'}`;
    });
    $('#admin-meal-count').textContent = `${MEALS.length} recetas · ${counts.join(' · ')}`;
    const host = $('#admin-meals');
    if (!list.length) {
      host.innerHTML = '';
      emptyState(host, 'fa-bowl-food', 'No hay recetas en esta sección. Agrega la primera.');
      return;
    }
    host.innerHTML = list.map((m) => `
      <div class="admin-meal">
        ${mealCardHTML(m, null, { tag: 'div' })}
        <div class="admin-meal__actions">
          <button type="button" class="btn btn--ghost btn--sm" data-meal-view="${escapeHTML(m.id)}"><i class="fa-solid fa-eye" aria-hidden="true"></i> Ver</button>
          <button type="button" class="btn btn--ghost btn--sm" data-meal-edit="${escapeHTML(m.id)}"><i class="fa-solid fa-pen" aria-hidden="true"></i> Editar</button>
          <button type="button" class="icon-btn icon-btn--danger" data-meal-delete="${escapeHTML(m.id)}" title="Eliminar" aria-label="Eliminar ${escapeHTML(m.name)}"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
        </div>
      </div>`).join('');
  }

  $('#admin-meal-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-meal-type]');
    if (!btn) return;
    mealState.filter = btn.dataset.mealType;
    selectTab($('#admin-meal-filter'), btn);
    renderAdminMeals();
  });

  const mealDialog = $('#meal-dialog');
  const mealForm = $('#meal-form');

  /** "Pollo a la plancha" → "pollo-a-la-plancha" (sin repetir uno que ya existe) */
  function mealSlug(name) {
    const base = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '') || 'receta';
    const root = base.length >= 3 ? base : `receta-${base}`;
    let id = root;
    for (let n = 2; MEALS.some((m) => m.id === id); n += 1) id = `${root}-${n}`;
    return id;
  }

  const lines = (v) => v.split('\n').map((x) => x.trim()).filter(Boolean);

  /** Lee el formulario y lo convierte en una receta con el formato de la app */
  function readMealForm() {
    const f = mealForm.elements;
    const num = (el) => (el.value.trim() === '' ? NaN : parseNum(el.value));
    return {
      id: mealState.editing || '',
      type: f.type.value,
      name: f.name.value.trim().replace(/\s+/g, ' '),
      kcal: num(f.kcal),
      min: num(f.minutes),
      macros: { p: num(f.protein), c: num(f.carbs), f: num(f.fat) },
      desc: f.desc.value.trim().replace(/\s+/g, ' '),
      img: f.image.value.trim(),
      tags: f.tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      ingredients: lines(f.ingredients.value),
      steps: lines(f.steps.value),
      tip: f.tip.value.trim(),
    };
  }

  // Mismas reglas que la tabla "meals" de la base de datos
  function validateMeal(m) {
    const between = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
    const tooLong = (arr, max) => arr.some((x) => x.length > max);
    return {
      name: m.name.length < 3 ? 'Escribe un nombre de al menos 3 caracteres.' : m.name.length > 80 ? 'Máximo 80 caracteres.' : '',
      type: MEAL_LABEL[m.type] ? '' : 'Elige el tipo de comida.',
      kcal: between(m.kcal, 20, 2000) && Number.isInteger(m.kcal) ? '' : 'Un número entero entre 20 y 2000.',
      minutes: between(m.min, 1, 240) && Number.isInteger(m.min) ? '' : 'Un número entero entre 1 y 240.',
      protein: between(m.macros.p, 0, 300) ? '' : 'Entre 0 y 300 g.',
      carbs: between(m.macros.c, 0, 300) ? '' : 'Entre 0 y 300 g.',
      fat: between(m.macros.f, 0, 300) ? '' : 'Entre 0 y 300 g.',
      desc: m.desc.length < 10 ? 'Escribe una descripción de al menos 10 caracteres.' : m.desc.length > 200 ? 'Máximo 200 caracteres.' : '',
      image: /^(photo-[A-Za-z0-9-]+|https:\/\/[^\s"<>]+)$/.test(m.img) && m.img.length <= 500 ? '' : 'Pega un enlace que empiece con https:// (o el ID photo-… de Unsplash).',
      tags: m.tags.length > 5 ? 'Máximo 5 etiquetas.' : tooLong(m.tags, 24) ? 'Cada etiqueta puede tener hasta 24 caracteres.' : '',
      ingredients: !m.ingredients.length ? 'Escribe al menos un ingrediente.' : m.ingredients.length > 25 ? 'Máximo 25 ingredientes.' : tooLong(m.ingredients, 150) ? 'Cada ingrediente puede tener hasta 150 caracteres.' : '',
      steps: !m.steps.length ? 'Escribe al menos un paso.' : m.steps.length > 20 ? 'Máximo 20 pasos.' : tooLong(m.steps, 400) ? 'Cada paso puede tener hasta 400 caracteres.' : '',
      tip: m.tip.length > 300 ? 'Máximo 300 caracteres.' : '',
    };
  }

  function renderMealPreview() {
    const m = readMealForm();
    const preview = {
      ...m,
      name: m.name || 'Nombre de la receta',
      desc: m.desc || 'La descripción corta aparece aquí.',
      kcal: Number.isFinite(m.kcal) ? m.kcal : 0,
      min: Number.isFinite(m.min) ? m.min : 0,
      img: m.img || 'photo-',
    };
    $('#meal-preview').innerHTML = mealCardHTML(preview, null, { tag: 'div' });
  }

  function openMealEditor(id = null) {
    const m = id ? MEALS.find((x) => x.id === id) : null;
    mealState.editing = m ? m.id : null;
    mealForm.reset();
    clearForm(mealForm);
    $('#meal-dialog-title').textContent = m ? 'Editar receta' : 'Agregar receta';
    $('#meal-submit').textContent = m ? 'Guardar cambios' : 'Agregar receta';
    const f = mealForm.elements;
    if (m) {
      f.name.value = m.name;
      f.type.value = m.type;
      f.kcal.value = m.kcal;
      f.minutes.value = m.min;
      f.protein.value = m.macros.p;
      f.carbs.value = m.macros.c;
      f.fat.value = m.macros.f;
      f.desc.value = m.desc;
      f.image.value = m.img;
      f.tags.value = m.tags.join(', ');
      f.ingredients.value = m.ingredients.join('\n');
      f.steps.value = m.steps.join('\n');
      f.tip.value = m.tip || '';
    } else if (mealState.filter !== 'todas') {
      f.type.value = mealState.filter;
    }
    renderMealPreview();
    mealDialog.showModal();
    mealDialog.scrollTop = 0;
    f.name.focus();
  }

  $('#admin-meal-add').addEventListener('click', () => openMealEditor());
  mealForm.addEventListener('input', renderMealPreview);
  mealForm.addEventListener('change', renderMealPreview);
  mealDialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-dialog]')) mealDialog.close();
  });

  mealForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearForm(mealForm);
    const m = readMealForm();
    if (!applyErrors(mealForm, validateMeal(m))) return;
    const isNew = !mealState.editing;
    if (isNew) m.id = mealSlug(m.name);
    await withBusy($('#meal-submit'), async () => {
      try {
        await db.admin.saveMeal(m, { isNew });
        MEALS = await db.listMeals();
      } catch (err) {
        formAlert(mealForm, err.message);
        return;
      }
      mealDialog.close();
      renderAdminMeals();
      toast(isNew ? `Se agregó «${m.name}» al plan de alimentación.` : `Se guardaron los cambios de «${m.name}».`, 'success');
    });
  });

  $('#admin-meals').addEventListener('click', async (e) => {
    const view = e.target.closest('[data-meal-view]');
    const editBtn = e.target.closest('[data-meal-edit]');
    const delBtn = e.target.closest('[data-meal-delete]');
    if (view) openRecipe(view.dataset.mealView);
    if (editBtn) openMealEditor(editBtn.dataset.mealEdit);
    if (!delBtn) return;
    const m = MEALS.find((x) => x.id === delBtn.dataset.mealDelete);
    if (!m) return;
    const left = MEALS.filter((x) => x.type === m.type).length - 1;
    const ok = await confirmDialog({
      title: 'Eliminar receta',
      body: `«${m.name}» dejará de aparecer en el plan de alimentación de todas las personas. No se puede deshacer.${left ? '' : ` Es la única receta de ${MEAL_LABEL[m.type].toLowerCase()}: esa sección quedará vacía.`}`,
      confirmLabel: 'Eliminar receta',
    });
    if (!ok) return;
    try {
      await db.admin.deleteMeal(m.id);
      MEALS = MEALS.filter((x) => x.id !== m.id);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    renderAdminMeals();
    toast(`Se eliminó «${m.name}».`, 'success');
  });

  const FB_STATUS_LABEL = { nuevo: 'Nueva', leido: 'Leída', resuelto: 'Resuelta' };
  const FB_KIND_LABEL = { sugerencia: 'Sugerencia', comentario: 'Comentario', problema: 'Problema', otro: 'Otro' };

  function renderAdminFeedback() {
    const all = adminState.feedback;
    const fresh = all.filter((f) => f.status === 'nuevo').length;
    setFeedbackBadge(fresh);
    $('#admin-fb-count').textContent = `${fresh} ${fresh === 1 ? 'nueva' : 'nuevas'} · ${all.length} en total`;
    const list = adminState.fbStatus === 'todas' ? all : all.filter((f) => f.status === adminState.fbStatus);
    const host = $('#admin-feedback');
    if (!list.length) {
      host.innerHTML = `<li class="empty"><i class="fa-solid fa-inbox" aria-hidden="true"></i><span>${all.length ? 'No hay mensajes con este estado.' : 'Aún no ha llegado ninguna sugerencia.'}</span></li>`;
      return;
    }
    host.innerHTML = list.map((f) => {
      const stars = f.rating ? `<span class="fb-item__stars" aria-label="${f.rating} de 5 estrellas">${'★'.repeat(f.rating)}${'☆'.repeat(5 - f.rating)}</span>` : '';
      const subject = encodeURIComponent(`One Life: tu ${FB_KIND_LABEL[f.kind].toLowerCase()}`);
      return `<li class="fb-item is-${f.status}">
        <div class="fb-item__head">
          <strong>${escapeHTML(f.name)}</strong>
          <span>${escapeHTML(f.email)}</span>
          <span class="badge badge--sm">${FB_KIND_LABEL[f.kind] || escapeHTML(f.kind)}</span>
          ${stars}
          <span>${fmtDateTime(f.created_at)}</span>
          <span class="badge badge--sm${f.status === 'nuevo' ? ' badge--accent' : ''}">${FB_STATUS_LABEL[f.status]}</span>
        </div>
        <p class="fb-item__msg">${escapeHTML(f.message)}</p>
        <div class="row-actions">
          ${f.status !== 'leido' ? `<button class="btn btn--ghost btn--sm" data-fb-status="leido" data-fb-id="${f.id}"><i class="fa-solid fa-envelope-open" aria-hidden="true"></i> Marcar leída</button>` : ''}
          ${f.status !== 'resuelto' ? `<button class="btn btn--ghost btn--sm" data-fb-status="resuelto" data-fb-id="${f.id}"><i class="fa-solid fa-check" aria-hidden="true"></i> Resuelta</button>` : ''}
          <a class="btn btn--ghost btn--sm" href="mailto:${encodeURIComponent(f.email)}?subject=${subject}"><i class="fa-solid fa-reply" aria-hidden="true"></i> Responder</a>
          <button class="icon-btn icon-btn--danger" data-fb-delete="${f.id}" aria-label="Eliminar el mensaje de ${escapeHTML(f.name)}" title="Eliminar"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
        </div>
      </li>`;
    }).join('');
  }

  $('#admin-fb-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-status]');
    if (!btn) return;
    adminState.fbStatus = btn.dataset.status;
    selectTab($('#admin-fb-filter'), btn);
    renderAdminFeedback();
  });

  $('#admin-feedback').addEventListener('click', async (e) => {
    const statusBtn = e.target.closest('[data-fb-status]');
    const delBtn = e.target.closest('[data-fb-delete]');
    if (statusBtn) {
      const id = Number(statusBtn.dataset.fbId);
      const status = statusBtn.dataset.fbStatus;
      try {
        await db.admin.setFeedbackStatus(id, status);
      } catch (err) {
        toast(err.message, 'error');
        return;
      }
      const item = adminState.feedback.find((f) => f.id === id);
      if (item) item.status = status;
      renderAdminFeedback();
    }
    if (delBtn) {
      const id = Number(delBtn.dataset.fbDelete);
      const item = adminState.feedback.find((f) => f.id === id);
      const ok = await confirmDialog({
        title: 'Eliminar mensaje',
        body: `Se borrará el mensaje de ${item?.name || 'esta persona'}. No se puede deshacer.`,
        confirmLabel: 'Eliminar',
      });
      if (!ok) return;
      try {
        await db.admin.deleteFeedback(id);
      } catch (err) {
        toast(err.message, 'error');
        return;
      }
      adminState.feedback = adminState.feedback.filter((f) => f.id !== id);
      renderAdminFeedback();
      toast('Mensaje eliminado.', 'success');
    }
  });

  /* ------------------------------------------------------------------
     Contacto: formulario de sugerencias y comentarios
     Se dibuja en dos sitios (sitio público y app) con el mismo código.
     ------------------------------------------------------------------ */
  const FEEDBACK_KINDS = [
    { key: 'sugerencia', label: 'Sugerencia', icon: 'fa-lightbulb' },
    { key: 'comentario', label: 'Comentario', icon: 'fa-comment' },
    { key: 'problema', label: 'Problema', icon: 'fa-bug' },
    { key: 'otro', label: 'Otro', icon: 'fa-ellipsis' },
  ];
  const RATING_TEXT = ['', 'Muy mala', 'Mala', 'Regular', 'Buena', 'Excelente'];
  const FB_MIN = 10;
  const FB_MAX = 1000;
  const FB_COOLDOWN_MS = 60 * 1000;

  function feedbackFormHTML(p) {
    const kinds = FEEDBACK_KINDS.map((k) => `
      <label><input type="radio" name="kind" value="${k.key}"><span><i class="fa-solid ${k.icon}" aria-hidden="true"></i>${k.label}</span></label>`).join('');
    const stars = [5, 4, 3, 2, 1].map((n) => `
      <input type="radio" name="rating" id="${p}-r${n}" value="${n}"><label for="${p}-r${n}" title="${n} de 5" aria-label="${n} de 5 estrellas"><i class="fa-solid fa-star" aria-hidden="true"></i></label>`).join('');
    return `
      <form class="fb-form" id="${p}-form" novalidate>
        <div class="fb-form__head">
          <h3 class="h-md">Envíanos tu mensaje</h3>
          <p class="muted">Todos los campos son obligatorios salvo la calificación.</p>
        </div>
        <div class="form-alert" role="alert" hidden></div>
        <div class="form-row">
          <div class="field">
            <label for="${p}-name">Nombre</label>
            <input id="${p}-name" name="name" autocomplete="name" maxlength="40" placeholder="Tu nombre" aria-describedby="${p}-name-error">
            <span class="field__error" id="${p}-name-error"></span>
          </div>
          <div class="field">
            <label for="${p}-email">Correo electrónico</label>
            <input id="${p}-email" name="email" type="email" autocomplete="email" maxlength="120" placeholder="tu@correo.com" aria-describedby="${p}-email-error">
            <span class="field__error" id="${p}-email-error"></span>
          </div>
        </div>
        <fieldset class="field">
          <legend>¿Qué quieres enviarnos?</legend>
          <div class="kind-picker" id="${p}-kind" role="radiogroup" aria-describedby="${p}-kind-error">${kinds}</div>
          <span class="field__error" id="${p}-kind-error"></span>
        </fieldset>
        <div class="field">
          <span class="label-like" id="${p}-rating-label">¿Cómo calificas One Life? <span class="optional">(opcional)</span></span>
          <div class="rating-row">
            <div class="stars" role="radiogroup" aria-labelledby="${p}-rating-label">${stars}</div>
            <span class="caption muted" data-rating-text></span>
          </div>
        </div>
        <div class="field">
          <label for="${p}-message">Mensaje</label>
          <textarea id="${p}-message" name="message" maxlength="${FB_MAX}" rows="5" placeholder="Cuéntanos con detalle: qué te gustaría, qué pasó o qué opinas." aria-describedby="${p}-message-error ${p}-message-count"></textarea>
          <div class="field__foot">
            <span class="field__error" id="${p}-message-error"></span>
            <span class="counter" id="${p}-message-count">0 / ${FB_MAX}</span>
          </div>
        </div>
        <div class="hp-field" aria-hidden="true">
          <label for="${p}-website">Deja este campo vacío</label>
          <input id="${p}-website" name="website" tabindex="-1" autocomplete="off">
        </div>
        <div class="field">
          <label class="check"><input type="checkbox" id="${p}-consent" name="consent" aria-describedby="${p}-consent-error"> <span>Acepto que One Life use estos datos solo para responderme, según la <button type="button" class="link" data-legal="privacidad" data-legal-check="${p}-consent">Política de privacidad</button>.</span></label>
          <span class="field__error" id="${p}-consent-error"></span>
        </div>
        <button type="submit" class="btn btn--primary btn--block" data-busy="Enviando…"><i class="fa-solid fa-paper-plane" aria-hidden="true"></i> Enviar mensaje</button>
      </form>`;
  }

  function prefillFeedback(form) {
    const u = currentUser();
    if (!u) return;
    if (!form.name.value) form.name.value = u.name;
    if (!form.email.value) form.email.value = u.email;
  }

  function mountFeedback(host, p) {
    host.innerHTML = feedbackFormHTML(p);
    const form = $('form', host);
    const counter = $(`#${p}-message-count`);
    const picker = $(`#${p}-kind`);
    prefillFeedback(form);

    form.message.addEventListener('input', () => {
      const n = form.message.value.trim().length;
      counter.textContent = `${n} / ${FB_MAX}`;
      counter.classList.toggle('is-near', n >= FB_MAX * 0.9 && n <= FB_MAX);
      counter.classList.toggle('is-over', n > FB_MAX);
    });
    form.addEventListener('change', (e) => {
      if (e.target.name === 'rating') $('[data-rating-text]', form).textContent = RATING_TEXT[e.target.value];
      if (e.target.name === 'kind') {
        picker.removeAttribute('aria-invalid');
        $(`#${p}-kind-error`).textContent = '';
      }
    });
    form.name.addEventListener('blur', () => { if (form.name.value.trim()) setError(form.name, validate.name(form.name.value)); });
    form.email.addEventListener('blur', () => { if (form.email.value.trim()) setError(form.email, validate.email(form.email.value)); });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearForm(form);
      picker.removeAttribute('aria-invalid');

      // Campo trampa: las personas no lo ven; si viene lleno, es un bot. Se finge éxito.
      if (form.website.value) { showFeedbackSuccess(host, p); return; }

      const name = form.name.value.trim().replace(/\s+/g, ' ');
      const email = form.email.value.trim().toLowerCase();
      const kind = form.kind.value;
      const message = form.message.value.trim();
      const links = (message.match(/https?:\/\/|www\./gi) || []).length;

      let messageError = '';
      if (!message) messageError = 'Escribe tu mensaje.';
      else if (message.length < FB_MIN) messageError = `Cuéntanos un poco más (mínimo ${FB_MIN} caracteres).`;
      else if (message.length > FB_MAX) messageError = `El mensaje no puede superar ${FB_MAX} caracteres.`;
      else if (links > 2) messageError = 'Incluye como máximo 2 enlaces.';
      else if (/(.)\1{9,}/.test(message)) messageError = 'Parece que el mensaje tiene caracteres repetidos de más.';

      const kindError = kind ? '' : 'Elige el tipo de mensaje.';
      $(`#${p}-kind-error`).textContent = kindError;
      if (kindError) picker.setAttribute('aria-invalid', 'true');

      const ok = applyErrors(form, {
        name: validate.name(name),
        email: validate.email(email),
        message: messageError,
        consent: form.consent.checked ? '' : 'Debes aceptar para que podamos responderte.',
      });
      if (!ok || kindError) {
        if (ok && kindError) $('input', picker).focus();
        return;
      }

      const wait = FB_COOLDOWN_MS - (Date.now() - storage.get(KEYS.feedbackAt, 0));
      if (wait > 0) {
        formAlert(form, `Acabas de enviar un mensaje. Espera ${Math.ceil(wait / 1000)} s antes de mandar otro.`);
        return;
      }
      if (!requireDb(form)) return;

      const btn = $('button[type="submit"]', form);
      await withBusy(btn, async () => {
        try {
          await db.sendFeedback({ name, email, kind, rating: Number(form.rating.value) || null, message });
        } catch (err) {
          formAlert(form, err.message);
          return;
        }
        storage.set(KEYS.feedbackAt, Date.now());
        showFeedbackSuccess(host, p);
      });
    });
  }

  function showFeedbackSuccess(host, p) {
    host.innerHTML = `
      <div class="fb-success" role="status">
        <i class="fa-solid fa-check" aria-hidden="true"></i>
        <h3 class="h-md">¡Gracias por escribirnos!</h3>
        <p class="muted">Recibimos tu mensaje. Si necesita respuesta, te escribiremos al correo que nos dejaste.</p>
        <button type="button" class="btn btn--ghost" data-fb-again>Enviar otro mensaje</button>
      </div>`;
    $('[data-fb-again]', host).addEventListener('click', () => {
      mountFeedback(host, p);
      $('input', host).focus();
    });
  }

  $$('[data-feedback]').forEach((host) => mountFeedback(host, host.dataset.feedback === 'app' ? 'fba' : 'fbp'));

  // Correo de contacto opcional (js/config.js → contactEmail)
  const contactEmail = (window.ONE_LIFE_CONFIG || {}).contactEmail;
  if (contactEmail && RE_EMAIL.test(contactEmail)) {
    const card = $('#contact-email');
    card.href = `mailto:${contactEmail}`;
    $('[data-bind-contact-email]', card).textContent = contactEmail;
    card.hidden = false;
  }

  /* ------------------------------------------------------------------
     Términos y Política: diálogo de lectura y aceptación
     ------------------------------------------------------------------ */
  const legalDialog = $('#legal-dialog');
  const legalBody = $('#legal-dialog-body');
  const legalAccept = $('#legal-accept');
  let legalCheckId = '';

  function checkLegalRead() {
    const atEnd = legalBody.scrollTop + legalBody.clientHeight >= legalBody.scrollHeight - 24;
    if (atEnd) {
      legalAccept.disabled = false;
      $('#legal-dialog-hint').hidden = true;
    }
  }

  function openLegal(doc, checkId) {
    if (typeof legalDialog.showModal !== 'function') { location.hash = `#/${doc}`; return; }
    legalCheckId = checkId || '';
    $('#legal-dialog-title').textContent = LEGAL_TITLES[doc];
    legalBody.innerHTML = $(`#legal-${doc}`).innerHTML;
    legalAccept.hidden = !legalCheckId;
    legalAccept.disabled = true;
    $('#legal-dialog-hint').hidden = !legalCheckId;
    legalDialog.showModal();
    legalBody.scrollTop = 0;
    legalBody.focus();
    requestAnimationFrame(checkLegalRead);
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-legal]');
    if (!btn) return;
    e.preventDefault();
    const fallback = { terminos: 'reg-terms', privacidad: 'reg-privacy' };
    const checkId = btn.dataset.legalCheck || (btn.closest('#register-form') ? fallback[btn.dataset.legal] : '');
    openLegal(btn.dataset.legal, checkId);
  });
  legalBody.addEventListener('scroll', checkLegalRead, { passive: true });
  legalAccept.addEventListener('click', () => {
    const box = document.getElementById(legalCheckId);
    if (box) {
      box.checked = true;
      setError(box, '');
    }
    legalDialog.close();
    box?.focus();
  });
  legalDialog.addEventListener('click', (e) => {
    if (e.target === legalDialog || e.target.closest('[data-close-dialog]')) legalDialog.close();
  });

  /* ------------------------------------------------------------------
     Panel visual del acceso (solo decorativo)
     - Profundidad 3D que sigue al ratón (solo con ratón, no en pantallas táctiles)
     - Corazón animado de LottieFiles, cargado solo al abrir el acceso
     - Fondo interactivo de Unicorn Studio si hay unicornProjectId en js/config.js
     Si algo externo falla, queda la versión estática: el formulario no depende de esto.
     ------------------------------------------------------------------ */
  const AUTH_ART = {
    lottieModule: 'https://cdn.jsdelivr.net/npm/@lottiefiles/dotlottie-wc@0.9.28/+esm',
    lottieSrc: 'https://assets-v2.lottiefiles.com/a/56dd16a4-1151-11ee-867b-e386a9d6429e/201nM9rDZ8.lottie',
    unicornScript: 'https://cdn.jsdelivr.net/gh/hiunicornstudio/unicornstudio.js@v2.3.0/dist/unicornStudio.umd.js',
  };

  const authArt = (() => {
    const art = $('#auth-art');
    let started = false;
    const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function enableDepth() {
      if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches || calm()) return;
      let queued = false;
      let x = 0;
      let y = 0;
      art.addEventListener('pointermove', (e) => {
        const r = art.getBoundingClientRect();
        x = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
        y = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          art.style.setProperty('--tx', x.toFixed(3));
          art.style.setProperty('--ty', y.toFixed(3));
        });
      });
      art.addEventListener('pointerleave', () => {
        art.style.setProperty('--tx', 0);
        art.style.setProperty('--ty', 0);
      });
    }

    async function loadLottie() {
      if (calm()) return;
      const host = $('#auth-lottie');
      try {
        await import(AUTH_ART.lottieModule);
        const player = document.createElement('dotlottie-wc');
        player.setAttribute('src', AUTH_ART.lottieSrc);
        player.setAttribute('autoplay', '');
        player.setAttribute('loop', '');
        host.append(player);
        // Se oculta el icono estático solo cuando la animación ya se dibujó
        for (let i = 0; i < 30; i += 1) {
          await new Promise((r) => setTimeout(r, 100));
          if (player.dotLottie?.isLoaded) { host.classList.add('is-animated'); return; }
        }
        player.remove();
      } catch {
        /* Sin conexión con el CDN: se queda el corazón 3D estático */
      }
    }

    function loadUnicorn() {
      const id = String((window.ONE_LIFE_CONFIG || {}).unicornProjectId || '').trim();
      if (!id || !/^[A-Za-z0-9_-]{6,80}$/.test(id) || calm() || window.innerWidth < 960) return;
      const run = () => window.UnicornStudio.addScene({
        elementId: 'auth-unicorn',
        projectId: id,
        fps: 60,
        scale: 0.75, // menos píxeles = más fluido; sube a 1 si lo quieres más nítido
        dpi: 1.5,
        lazyLoad: true,
      }).then(() => art.classList.add('has-unicorn'))
        .catch((err) => console.warn('[One Life] Unicorn Studio no cargó; se usa el fondo CSS.', err));
      if (window.UnicornStudio) { run(); return; }
      const script = document.createElement('script');
      script.src = AUTH_ART.unicornScript;
      script.async = true;
      script.onload = run;
      script.onerror = () => console.warn('[One Life] No se pudo descargar Unicorn Studio; se usa el fondo CSS.');
      document.head.append(script);
    }

    return {
      start() {
        if (started || !art) return;
        started = true;
        enableDepth();
        loadLottie();
        loadUnicorn();
      },
    };
  })();

  /* ------------------------------------------------------------------
     Animaciones de entrada (sitio público)
     ------------------------------------------------------------------ */
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** Divide un título en palabras animables, conservando los <br>. */
  function splitWords(el) {
    let i = 0;
    [...el.childNodes].forEach((node) => {
      if (node.nodeType !== Node.TEXT_NODE) return;
      const frag = document.createDocumentFragment();
      node.textContent.split(/(\s+)/).forEach((part) => {
        if (!part) return;
        if (/^\s+$/.test(part)) { frag.append(part); return; }
        const span = document.createElement('span');
        span.className = 'word';
        span.textContent = part;
        span.style.setProperty('--d', `${0.12 + i++ * 0.07}s`);
        frag.append(span);
      });
      node.replaceWith(frag);
    });
  }

  function countUp(el) {
    const target = Number(el.dataset.count);
    const suffix = el.dataset.suffix || '';
    const start = performance.now();
    const dur = 1400;
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - (1 - t) ** 3;
      el.textContent = `${Math.round(target * eased)}${suffix}`;
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Bloques que aparecen al entrar en pantalla, escalonados dentro de su contenedor
  const AUTO_REVEAL = '.section-head > *, .split > *, .feature, .steps li, .accordion details, .contact-card, .contact__form, .cta-band__inner > *, .hero__stats > div, .footer__inner > *, .auth__box, .auth__art';

  const revealObserver = !reduceMotion && 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        el.classList.add('is-visible');
        // Terminada la entrada se quita el filtro: así el scroll no tiene que repintarlo
        el.addEventListener('transitionend', (ev) => { if (ev.target === el) el.classList.add('is-done'); }, { once: false });
        $$('[data-count]', el).forEach(countUp);
        revealObserver.unobserve(el);
      });
    }, { threshold: 0.1 })
    : null;

  function setupReveal() {
    $$('[data-split]').forEach(splitWords);
    $$(AUTO_REVEAL).forEach((el) => {
      if (el.hasAttribute('data-reveal')) return;
      el.setAttribute('data-reveal', '');
      const index = [...el.parentElement.children].indexOf(el);
      el.style.setProperty('--d', `${Math.min(index, 6) * 0.08}s`);
    });
    $$('[data-reveal]').forEach((el) => {
      if (revealObserver) revealObserver.observe(el);
      else el.classList.add('is-visible');
    });
  }

  /* Encabezado translúcido al hacer scroll y enlace activo según la sección */
  const topnav = $('#topnav');
  const navSections = ['imc', 'funciones', 'faq', 'contacto'];
  const navLinks = $$('.topnav__group--center .navlink');
  function onScroll() {
    const y = window.scrollY;
    toTop.hidden = y < 600;
    topnav.classList.toggle('is-scrolled', y > 8);
    let current = currentScreen === 'inicio' ? 'top' : '';
    if (current) navSections.forEach((id) => {

      const el = document.getElementById(id);
      if (el && el.getBoundingClientRect().top < window.innerHeight * 0.4) current = id;
    });
    navLinks.forEach((a) => a.classList.toggle('is-active', a.dataset.scroll === current));
  }
  // Una sola medición por fotograma: el scroll no se traba aunque el evento llegue muchas veces
  let scrollQueued = false;
  window.addEventListener('scroll', () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; onScroll(); });
  }, { passive: true });


  /* ------------------------------------------------------------------
     Arranque
     ------------------------------------------------------------------ */
  async function bootstrap() {
    setupReveal();
    if (!storage.ok) $('#storage-warning').hidden = false;

    if (!db.ready) {
      $('#config-warning').hidden = false;
    } else {
      db.onAuthChange((event) => {
        // Supabase recomienda no hacer otras llamadas dentro del callback
        setTimeout(() => handleAuthEvent(event), 0);
      });
      try {
        // Llegar desde un enlace de correo (?code=...) cuenta como sesión nueva y activa
        if (new URLSearchParams(location.search).has('code')) markSessionStart(storage.get(KEYS.remember, false));
        const session = await db.getSession();
        if (session) {
          const idle = Date.now() - storage.get(KEYS.lastActive, 0) > SESSION_IDLE_MS;
          const forgotten = !storage.get(KEYS.remember, false) && !storage.get(KEYS.alive, false, false);
          if (idle || forgotten) {
            // Sin "Recordarme" la sesión no sobrevive a cerrar el navegador
            state.loggingOut = true;
            await db.signOut().catch(() => {});
            state.loggingOut = false;
            if (idle && storage.get(KEYS.lastActive, 0)) toast('Tu sesión se cerró por inactividad. Vuelve a iniciar sesión.', 'info', 6000);
          } else {
            await loadUserData();
            storage.set(KEYS.alive, true, false);
          }
        }
      } catch (err) {
        toast(`No pudimos conectar con el servidor: ${err.message}`, 'error', 7000);
      }
    }

    $('#boot').hidden = true;
    window.addEventListener('hashchange', route);
    if (state.user && state.recovery) location.hash = '#/app/perfil?tab=seguridad';
    route();
  }

  bootstrap();
})();
