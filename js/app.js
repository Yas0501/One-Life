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
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const escapeHTML = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const round1 = (n) => Math.round(n * 10) / 10;
  const fmt = (n, d = 1) => Number(n).toLocaleString('es', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtInt = (n) => Math.round(n).toLocaleString('es');

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

  const MEALS = [
    { type: 'desayuno', name: 'Avena con frutos rojos y chía', kcal: 320, min: 10, tags: ['Alto en fibra'], desc: 'Avena cocida, frutos rojos, semillas de chía y canela.' },
    { type: 'desayuno', name: 'Tostada integral con aguacate y huevo', kcal: 380, min: 10, tags: ['Proteína'], desc: 'Pan integral, medio aguacate, huevo pochado y tomate.' },
    { type: 'desayuno', name: 'Yogur griego con nueces y miel', kcal: 290, min: 5, tags: ['Proteína'], desc: 'Yogur griego natural, nueces troceadas y un hilo de miel.' },
    { type: 'desayuno', name: 'Batido verde de espinaca y plátano', kcal: 240, min: 5, tags: ['Ligero'], desc: 'Espinaca, plátano, leche vegetal y linaza molida.' },
    { type: 'almuerzo', name: 'Pollo a la plancha con quinoa', kcal: 520, min: 25, tags: ['Proteína', 'Bajo en grasa'], desc: 'Pechuga a la plancha, quinoa y verduras salteadas.' },
    { type: 'almuerzo', name: 'Ensalada mediterránea con garbanzos', kcal: 430, min: 15, tags: ['Vegano', 'Alto en fibra'], desc: 'Garbanzos, pepino, tomate, aceitunas y aceite de oliva.' },
    { type: 'almuerzo', name: 'Salmón al horno con camote', kcal: 580, min: 30, tags: ['Omega 3'], desc: 'Salmón, camote asado y espárragos con limón.' },
    { type: 'almuerzo', name: 'Bowl de arroz integral y frijoles', kcal: 490, min: 20, tags: ['Vegano'], desc: 'Arroz integral, frijoles negros, maíz y pico de gallo.' },
    { type: 'cena', name: 'Crema de calabaza con semillas', kcal: 280, min: 25, tags: ['Ligero'], desc: 'Calabaza, cebolla, caldo de verduras y pepitas tostadas.' },
    { type: 'cena', name: 'Tortilla de claras con champiñones', kcal: 260, min: 10, tags: ['Proteína', 'Ligero'], desc: 'Claras, champiñones, espinaca y queso fresco.' },
    { type: 'cena', name: 'Pescado blanco con ensalada tibia', kcal: 340, min: 20, tags: ['Bajo en grasa'], desc: 'Filete de pescado blanco, hojas verdes y verduras asadas.' },
    { type: 'cena', name: 'Wrap integral de pavo y vegetales', kcal: 410, min: 10, tags: ['Proteína'], desc: 'Tortilla integral, pavo, lechuga, zanahoria y hummus.' },
    { type: 'snack', name: 'Manzana con crema de cacahuate', kcal: 190, min: 2, tags: ['Saciante'], desc: 'Una manzana en gajos con una cucharada de crema de cacahuate.' },
    { type: 'snack', name: 'Hummus con bastones de zanahoria', kcal: 160, min: 5, tags: ['Vegano'], desc: 'Tres cucharadas de hummus con zanahoria y pepino.' },
    { type: 'snack', name: 'Puñado de almendras', kcal: 150, min: 1, tags: ['Grasas saludables'], desc: 'Unas 25 g de almendras naturales.' },
    { type: 'snack', name: 'Queso cottage con piña', kcal: 170, min: 3, tags: ['Proteína'], desc: 'Media taza de cottage con piña natural.' },
  ];
  const MEAL_LABEL = { desayuno: 'Desayuno', almuerzo: 'Almuerzo', cena: 'Cena', snack: 'Snack' };

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
    admin: 'Administración',
  };

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

  const passwordRules = (pw) => ({
    length: pw.length >= 8,
    upper: /[A-ZÁÉÍÓÚÑ]/.test(pw),
    lower: /[a-záéíóúñ]/.test(pw),
    number: /\d/.test(pw),
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
    const [me, history, activities, logins, isAdmin] = await Promise.all([
      db.getMe(),
      db.listRecords(),
      db.listActivities({ sinceDays: 365 }),
      db.recentLogins(2).catch(() => []),
      db.isAdmin(),
    ]);
    state.user = { ...me, history, activities, previousLogin: logins[1] || null };
    state.isAdmin = isAdmin;
    $('#nav-admin').hidden = !isAdmin;
  }

  function clearLocalState() {
    state.user = null;
    state.isAdmin = false;
    state.recovery = false;
    $('#nav-admin').hidden = true;
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
      showApp(view, params);
      return;
    }

    if (parts[0] === 'acceso') {
      if (user) { location.replace('#/app/resumen'); return; }
      showPublic('acceso');
      setAuthTab(params.get('modo') === 'registro' ? 'registro' : 'login');
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
    document.title = name === 'acceso' ? 'Acceso — One Life' : 'One Life — Conoce tu peso, cuida tu vida';
    if (name === 'acceso') window.scrollTo(0, 0);
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
    window.scrollTo(0, 0);
    renderShell();
    RENDER[view]?.(params);
  }

  /* ------------------------------------------------------------------
     Sitio público: navegación
     ------------------------------------------------------------------ */
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-scroll]');
    if (!a) return;
    e.preventDefault();
    const target = a.dataset.scroll;
    const go = () => {
      const el = target === 'top' ? null : document.getElementById(target);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    if (!location.hash.startsWith('#/inicio') && location.hash !== '') {
      location.hash = '#/inicio';
      setTimeout(go, 50);
    } else go();
    closePublicMenu();
  });

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
  window.addEventListener('scroll', () => { toTop.hidden = window.scrollY < 600; }, { passive: true });
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
    const rules = passwordRules(e.target.value);
    const score = Object.values(rules).filter(Boolean).length;
    $('.strength', e.target.form).dataset.level = e.target.value ? score : 0;
    $$('#reg-password-rules li').forEach((li) => li.classList.toggle('is-ok', rules[li.dataset.rule]));
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
      terms: form.terms.checked ? '' : 'Debes aceptar para continuar.',
    };
    if (!applyErrors(form, errors) || !requireDb(form)) return;

    const btn = $('button[type="submit"]', form);
    btn.dataset.busy = 'Creando cuenta…';
    await withBusy(btn, async () => {
      let result;
      try {
        result = await db.signUp(name, email, password);
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

  function lineChart(host, points, { unit = '', band = null, goal = null, height = 240, label = '', decimals = 1 } = {}) {
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
    const x = (iso) => (t1 === t0 ? (SVG_W + pad.l - pad.r) / 2 : pad.l + (SVG_W - pad.l - pad.r) * ((parseISO(iso).getTime() - t0) / (t1 - t0)));
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - min) / (max - min));

    let svg = `<svg viewBox="0 0 ${SVG_W} ${H}" role="img" aria-label="${escapeHTML(label)}">`;
    for (let i = 0; i <= 4; i++) {
      const v = min + ((max - min) * i) / 4;
      svg += `<line class="grid-line" x1="${pad.l}" x2="${SVG_W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>`;
      svg += `<text class="axis-label" x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v, decimals === 0 || max - min >= 10 ? 0 : 1)}</text>`;
    }
    if (band) {
      const top = y(Math.min(band[1], max)), bot = y(Math.max(band[0], min));
      if (bot > top) {
        svg += `<rect class="band" x="${pad.l}" y="${top}" width="${SVG_W - pad.l - pad.r}" height="${bot - top}"/>`;
        svg += `<text class="band-label" x="${SVG_W - pad.r - 6}" y="${top + 14}" text-anchor="end">Rango saludable</text>`;
      }
    }
    if (goal) {
      svg += `<line class="goal-line" x1="${pad.l}" x2="${SVG_W - pad.r}" y1="${y(goal)}" y2="${y(goal)}"/>`;
      svg += `<text class="band-label" x="${SVG_W - pad.r - 6}" y="${y(goal) - 6}" text-anchor="end">Objetivo ${fmt(goal)} ${unit}</text>`;
    }
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    svg += `<path class="line" d="${d}"/>`;
    points.forEach((p, i) => {
      const last = i === points.length - 1;
      svg += `<circle class="dot${last ? ' dot--last' : ''}" cx="${x(p.date)}" cy="${y(p.value)}" r="${last ? 5 : 3.5}"><title>${fmtDate(p.date, { day: 'numeric', month: 'long', year: 'numeric' })}: ${fmt(p.value, decimals)} ${unit}</title></circle>`;
    });
    const lp = points.at(-1);
    const lx = x(lp.date);
    svg += `<text class="value-label" x="${lx}" y="${y(lp.value) - 12}" text-anchor="${lx > SVG_W - 60 ? 'end' : 'middle'}">${fmt(lp.value, decimals)}</text>`;
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

  RENDER.plan = () => {
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
      });
      const sum = list.reduce((s, m) => s + m.kcal, 0);
      note = cal
        ? `Este menú suma ${fmtInt(sum)} kcal de tus ${fmtInt(cal.target)} kcal. Completa con fruta, verdura y porciones de cereal según tu hambre.`
        : `Este menú suma ${fmtInt(sum)} kcal.`;
    } else {
      list = MEALS.filter((m) => m.type === mealTab);
    }
    $('#plan-tab-note').textContent = note;
    $('#plan-meals').innerHTML = list.map((m) => `
      <article class="meal">
        <div class="meal__plate">
          <span class="meal__type">${MEAL_LABEL[m.type]}</span>
          <span class="meal__kcal">${m.kcal}<small> kcal</small></span>
        </div>
        <div class="meal__body">
          <h3>${m.name}</h3>
          <p>${m.desc}</p>
          <div class="meal__meta"><span><i class="fa-regular fa-clock" aria-hidden="true"></i> ${m.min} min</span>${cal ? `<span>${Math.round((m.kcal / cal.target) * 100)} % del día</span>` : ''}</div>
          <div class="tags">${m.tags.map((t) => `<span class="tag">${t}</span>`).join('')}</div>
        </div>
      </article>`).join('');
  }

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

  /* ---------- Administración ---------- */
  const adminState = { users: [], range: 30, query: '' };

  RENDER.admin = () => { loadAdmin(); };

  async function loadAdmin() {
    const errorBox = $('#admin-error');
    errorBox.hidden = true;
    $('#admin-tiles').innerHTML = Array.from({ length: 8 }, () => '<article class="tile tile--loading"><span class="tile__label">Cargando…</span><span class="tile__value">—</span></article>').join('');
    try {
      const [metrics, dist, logins, users] = await Promise.all([
        db.admin.metrics(),
        db.admin.bmiDistribution(),
        db.admin.loginsPerDay(adminState.range),
        db.admin.listUsers(),
      ]);
      renderAdminMetrics(metrics);
      renderAdminDistribution(dist);
      renderAdminLogins(logins);
      adminState.users = users;
      renderAdminUsers();
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
    const host = $('#admin-logins-chart');
    const points = rows.map((r) => ({ date: String(r.dia).slice(0, 10), value: Number(r.inicios) }));
    if (!points.some((p) => p.value)) {
      emptyState(host, 'fa-right-to-bracket', 'No hubo inicios de sesión en este periodo.');
      return;
    }
    lineChart(host, points, { label: 'Inicios de sesión por día', decimals: 0, height: 240 });
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
      return `<tr>
        <td><strong>${escapeHTML(u.name)}</strong>${isMe ? ' <span class="badge badge--sm">Tú</span>' : ''}</td>
        <td>${escapeHTML(u.email)}</td>
        <td><span class="badge badge--sm${isAdmin ? ' badge--accent' : ''}">${isAdmin ? 'Admin' : 'Usuario'}</span></td>
        <td>${fmtStamp(u.created_at)}</td>
        <td>${u.last_sign_in_at ? fmtDateTime(u.last_sign_in_at) : 'Nunca'}</td>
        <td>${fmtInt(Number(u.logins))}</td>
        <td>${bmi ? `${fmt(bmi)} <span class="muted">· ${bmiCategory(bmi).label}</span>` : '—'}</td>
        <td class="row-actions">
          <button class="icon-btn" data-admin-role="${u.id}" ${isMe ? 'disabled title="No puedes cambiar tu propio rol"' : ''}
            aria-label="${isAdmin ? 'Quitar rol de administrador a' : 'Hacer administrador a'} ${escapeHTML(u.name)}"
            title="${isAdmin ? 'Quitar rol de administrador' : 'Hacer administrador'}">
            <i class="fa-solid ${isAdmin ? 'fa-user-minus' : 'fa-user-shield'}" aria-hidden="true"></i></button>
          <button class="icon-btn icon-btn--danger" data-admin-delete="${u.id}" ${isMe || isAdmin ? `disabled title="${isMe ? 'Borra tu cuenta desde Perfil y ajustes' : 'Quita primero el rol de administrador'}"` : 'title="Eliminar cuenta"'}
            aria-label="Eliminar la cuenta de ${escapeHTML(u.name)}"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
        </td>
      </tr>`;
    }).join('') : '<tr><td colspan="8" class="muted">Ningún usuario coincide con la búsqueda.</td></tr>';
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
  const AUTO_REVEAL = '.section-head > *, .split > *, .feature, .steps li, .accordion details, .cta-band__inner > *, .hero__stats > div, .footer__inner > *, .auth__box, .auth__art';

  const revealObserver = !reduceMotion && 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        el.classList.add('is-visible');
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
  const navSections = ['imc', 'funciones', 'faq'];
  window.addEventListener('scroll', () => {
    topnav.classList.toggle('is-scrolled', window.scrollY > 8);
    let current = 'top';
    navSections.forEach((id) => {
      const el = document.getElementById(id);
      if (el && el.getBoundingClientRect().top < window.innerHeight * 0.4) current = id;
    });
    $$('.topnav__group--center .navlink').forEach((a) => a.classList.toggle('is-active', a.dataset.scroll === current));
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
