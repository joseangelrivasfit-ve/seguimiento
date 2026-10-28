/* Seguimiento de pacientes: web del paciente (versión 2).
 *
 * Dos reportes por separado, porque el EVA del día siguiente solo se conoce al día siguiente:
 *   - Sesión (tipo "sesion"): duración, RPE y EVA durante la sesión. Semáforo provisional.
 *   - Mañana (tipo "manana"): EVA del día siguiente y rigidez, enlazado a la última sesión. Semáforo confirmado.
 * La marca y los umbrales vienen de config.js y, si existen, de la hoja Config del Sheet (el Sheet manda). */
(function (root) {
  'use strict';

  /* ===================================================================
   * 1. LÓGICA PURA (carga, ACWR, semáforo). Se puede probar sin navegador.
   * =================================================================== */

  var DEFAULTS = {
    dias_minimos_acwr: 7,
    eva_durante_amarillo: 4,
    eva_durante_rojo: 8,
    eva_dia_siguiente_rojo: 3,
    acwr_bajo: 0.8,
    acwr_amarillo: 1.3,
    acwr_rojo: 1.5,
    rigidez_es_roja: 'SI'
  };
  var DIAS_ENLACE = 3; // la mañana se enlaza a la última sesión de hasta 3 días atrás

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function stamp(d) { return ymd(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function parseYmd(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2], 12, 0, 0); }
  function addDays(s, n) { var d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
  function diffDays(a, b) { return Math.round((parseYmd(a) - parseYmd(b)) / 86400000); }
  function shortDate(s) { var p = String(s).split('-'); return p[2] + '/' + p[1]; }
  function num(v, d) {
    var n = parseFloat(String(v === null || v === undefined ? '' : v).replace(',', '.'));
    return isFinite(n) ? n : d;
  }
  function round(n, dec) { var f = Math.pow(10, dec); return Math.round(n * f) / f; }

  function thresholds(cfg) {
    var t = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      if (typeof DEFAULTS[k] === 'number') t[k] = num(cfg && cfg[k], DEFAULTS[k]);
      else t[k] = (cfg && cfg[k] !== undefined && cfg[k] !== '') ? String(cfg[k]).trim().toUpperCase() : DEFAULTS[k];
    });
    return t;
  }

  function isMorning(r) { return r.tipo === 'manana'; }

  function reportLoad(r) {
    if (isMorning(r)) return 0;
    return num(r.ua, num(r.duracion_min, 0) * num(r.rpe, 0));
  }

  function dailyLoads(reports) {
    var by = {};
    reports.forEach(function (r) {
      if (!r.fecha) return;
      by[r.fecha] = (by[r.fecha] || 0) + reportLoad(r);
    });
    return by;
  }

  /* ACWR = carga media de los últimos 7 días / carga media de los últimos 28 días, contados hacia atrás
   * desde "today". Los días sin sesión cuentan como 0. Con menos de 28 días de historia, el promedio
   * crónico usa solo los días transcurridos desde el primer reporte. */
  function acwrInfo(reports, today, th) {
    var by = dailyLoads(reports);
    var dates = Object.keys(by).filter(function (d) { return d <= today; }).sort();
    if (!dates.length) return { ready: false, daysHist: 0, acwr: null, acute: 0, chronic: 0 };
    var daysHist = diffDays(today, dates[0]) + 1;
    if (daysHist < th.dias_minimos_acwr) return { ready: false, daysHist: daysHist, acwr: null, acute: 0, chronic: 0 };
    var n = Math.min(28, daysHist), sumC = 0, sumA = 0;
    for (var i = 0; i < n; i++) {
      var l = by[addDays(today, -i)] || 0;
      sumC += l;
      if (i < 7) sumA += l;
    }
    var chronic = sumC / n;
    var acute = sumA / Math.min(7, n);
    return {
      ready: true, daysHist: daysHist,
      acute: acute, chronic: chronic,
      acwr: chronic > 0 ? round(acute / chronic, 2) : null
    };
  }

  function acwrZone(v, th) {
    if (v === null || v === undefined) return null;
    if (v < th.acwr_bajo) return 'low';
    if (v < th.acwr_amarillo) return 'ok';
    if (v <= th.acwr_rojo) return 'caution';
    return 'peak';
  }

  function painScore(during, next) { return round(0.4 * during + 0.6 * next, 1); }

  /* r: { dolor_durante, dolor_dia_siguiente, rigidez: 'SI'|'NO' }; acwr: número redondeado o null.
   * Cada EVA se compara por separado con su propio umbral. */
  function classify(r, acwr, th) {
    var during = num(r.dolor_durante, 0);
    var next = num(r.dolor_dia_siguiente, 0);
    var stiff = String(r.rigidez).toUpperCase() === 'SI';
    var rigRed = th.rigidez_es_roja !== 'NO';
    var hasAcwr = acwr !== null && acwr !== undefined;

    var red = during >= th.eva_durante_rojo || next >= th.eva_dia_siguiente_rojo ||
      (stiff && rigRed) || (hasAcwr && acwr > th.acwr_rojo);
    var yellow = during >= th.eva_durante_amarillo || next > 0 ||
      (stiff && !rigRed) || (hasAcwr && acwr >= th.acwr_amarillo);
    var level = red ? 2 : (yellow ? 1 : 0);

    var cause = null;
    if (level === 2) {
      if (during >= th.eva_durante_rojo) cause = 'during';
      else if (next >= th.eva_dia_siguiente_rojo || (stiff && rigRed)) cause = 'nextday';
      else cause = 'acwr';
    }

    var reasons = [];
    if (during >= th.eva_durante_rojo) reasons.push({ code: 'during_red', v: during });
    else if (during >= th.eva_durante_amarillo) reasons.push({ code: 'during_yellow', v: during });
    if (next >= th.eva_dia_siguiente_rojo) reasons.push({ code: 'next_red', v: next });
    else if (next > 0) reasons.push({ code: 'next_yellow', v: next });
    if (stiff) reasons.push({ code: 'stiff' });
    if (hasAcwr && acwr > th.acwr_rojo) reasons.push({ code: 'acwr_red', v: acwr });
    else if (hasAcwr && acwr >= th.acwr_amarillo) reasons.push({ code: 'acwr_yellow', v: acwr });
    else if (hasAcwr && acwr < th.acwr_bajo) reasons.push({ code: 'acwr_low', v: acwr });

    return {
      level: level,
      key: ['ok', 'warn', 'bad'][level],
      label: ['VERDE', 'AMARILLO', 'ROJO'][level],
      cause: cause,
      reasons: reasons
    };
  }

  /* Mayor EVA durante registrado en las sesiones de una fecha. */
  function maxDuring(reports, fecha) {
    var m = 0;
    reports.forEach(function (r) {
      if (!isMorning(r) && r.fecha === fecha) m = Math.max(m, num(r.dolor_durante, 0));
    });
    return m;
  }

  /* Última sesión (reporte nuevo "sesion") anterior a hoy y de hasta maxBack días atrás. */
  function linkedSession(reports, today, maxBack) {
    var best = null;
    reports.forEach(function (r) {
      if (r.tipo !== 'sesion' || !r.fecha || r.fecha >= today) return;
      if (diffDays(today, r.fecha) > maxBack) return;
      if (!best || r.fecha > best) best = r.fecha;
    });
    return best ? { fecha: best, during: maxDuring(reports, best) } : null;
  }

  /* Sesión recién guardada: el EVA del día siguiente aún no existe, así que el semáforo es provisional.
   * "reports" debe incluir el propio registro. */
  function evaluateSession(rec, reports, th) {
    var info = acwrInfo(reports, rec.fecha, th);
    var cls = classify({ dolor_durante: rec.dolor_durante, dolor_dia_siguiente: 0, rigidez: 'NO' }, info.acwr, th);
    return { info: info, cls: cls, zone: acwrZone(info.acwr, th), provisional: true, during: num(rec.dolor_durante, 0), score: null, link: null };
  }

  /* Chequeo de la mañana: junta el EVA del día siguiente con el EVA durante de la sesión enlazada.
   * El ACWR es el de la fecha de esa sesión, que es la carga que provocó la respuesta. */
  function evaluateMorning(rec, link, reports, th) {
    var during = link ? link.during : 0;
    var info = acwrInfo(reports, link ? link.fecha : rec.fecha, th);
    var cls = classify({ dolor_durante: during, dolor_dia_siguiente: rec.dolor_dia_siguiente, rigidez: rec.rigidez }, info.acwr, th);
    return {
      info: info, cls: cls, zone: acwrZone(info.acwr, th), provisional: false,
      during: during, score: painScore(during, num(rec.dolor_dia_siguiente, 0)), link: link
    };
  }

  var logic = {
    DEFAULTS: DEFAULTS, DIAS_ENLACE: DIAS_ENLACE, thresholds: thresholds, dailyLoads: dailyLoads, acwrInfo: acwrInfo,
    acwrZone: acwrZone, classify: classify, painScore: painScore, maxDuring: maxDuring, linkedSession: linkedSession,
    evaluateSession: evaluateSession, evaluateMorning: evaluateMorning,
    ymd: ymd, addDays: addDays, diffDays: diffDays, reportLoad: reportLoad
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = logic;
  if (typeof document === 'undefined') return;

  /* ===================================================================
   * 2. TEXTOS (es / en)
   * =================================================================== */

  var I18N = {
    es: {
      tab_program: 'Mi programa', tab_report: 'Reporte de hoy',
      hello: 'Hola, {name}', program_title: 'Tu programa',
      program_hint: 'RPE es el esfuerzo percibido de 0 a 10. EVA máx es el dolor máximo permitido durante el ejercicio.',
      program_empty: 'Tu fisioterapeuta aún no ha cargado tu programa.',
      ex_of: '{i} de {n}', series: 'Series', reps: 'Reps', rpe: 'RPE', eva: 'EVA máx', rest: 'Descanso',
      note: 'Nota', novideo: 'Sin video', video_error: 'No se pudo cargar el video',
      report_title: 'Reporte de hoy',
      morning_title: 'Cómo amaneciste hoy', session_title: 'Después de entrenar',
      morning_about: 'Sobre tu sesión del {date}: dolor durante {v}/10.',
      morning_nolink: 'No hay una sesión registrada en los últimos 3 días. Cuéntanos igual cómo amaneciste.',
      session_about: 'Cuéntanos tu sesión apenas termines. El dolor del día siguiente lo registras mañana, en "Cómo amaneciste hoy".',
      pending: 'Pendiente', done_chip: 'Hecho',
      duration: 'Duración (min)', effort: 'Esfuerzo de la sesión (RPE)',
      pain_during: 'Dolor durante o justo después (EVA 0 a 10)',
      pain_next: 'Puntos de dolor por encima de lo habitual',
      pain_next_hint: '0 es igual o mejor que tu dolor de siempre por las mañanas.',
      stiffness: 'Rigidez matutina claramente mayor',
      save_session: 'Guardar sesión', save_morning: 'Guardar cómo amanecí',
      redo: 'Corregir mi respuesta', another: 'Añadir otra sesión de hoy',
      badge_ok: 'Seguro / Verde', badge_warn: 'Precaución / Amarillo', badge_bad: 'Alerta / Rojo',
      ok_t: 'Carga y respuesta óptimas', ok_d: 'Tu tendón está tolerando bien el trabajo. Sigue con tu programa tal como está.',
      warn_t: 'Zona de cuidado', warn_d: 'No aumentes las cargas en la próxima sesión. Mantén el volumen hasta volver al verde.',
      bad_during_t: 'Revisa el ejercicio', bad_during_d: 'El dolor durante la sesión fue muy alto. Avisa a tu fisio antes de la próxima sesión para revisar la técnica o el rango de movimiento.',
      bad_nextday_t: 'Tu tendón protestó hoy', bad_nextday_d: 'Amaneciste con más dolor o rigidez. Baja el volumen o la intensidad en la próxima sesión y cuéntale a tu fisio cómo sigues.',
      bad_acwr_t: 'Subiste la carga muy rápido', bad_acwr_d: 'Esta semana hiciste bastante más que tu promedio. Reduce la carga en la próxima sesión para evitar una recaída.',
      provisional: 'Semáforo provisional: mañana, cuando cuentes cómo amaneciste, queda confirmado.',
      r_during_red: 'Dolor durante la sesión: {v}/10, muy alto.',
      r_during_yellow: 'Dolor durante la sesión: {v}/10.',
      r_next_red: 'Al amanecer, {v} puntos por encima de lo habitual.',
      r_next_yellow: 'Al amanecer, {v} punto(s) por encima de lo habitual.',
      r_stiff: 'Rigidez matutina aumentada.',
      r_acwr_red: 'ACWR {v}: pico de carga reciente.',
      r_acwr_yellow: 'ACWR {v}: carga en zona de precaución.',
      r_acwr_low: 'ACWR {v}: carga reciente baja respecto a tu base.',
      m_acwr: 'ACWR (7 / 28 días)', m_pain: 'Puntaje de dolor', m_during: 'EVA durante',
      z_low: 'Subcarga', z_ok: 'Zona óptima', z_caution: 'Precaución', z_peak: 'Pico de carga',
      acwr_wait: 'Se calcula tras {min} días de registro. Llevas {n}.',
      saved_ok: 'Guardado en el historial de tu fisio.', saved_pending: 'Sin conexión: se enviará cuando vuelva internet.',
      saved_demo: 'Modo demo: solo se guarda en este dispositivo.',
      wa_btn: 'Enviar a mi fisio por WhatsApp',
      wa_hint: 'Se abrirá WhatsApp con el mensaje listo. Pulsa enviar para que tu fisio lo reciba.',
      history_title: 'Últimos 14 días', legend_load: 'Carga (UA)', legend_during: 'EVA durante', legend_next: 'EVA día siguiente',
      hist_title: 'Últimos reportes', hist_session: 'Sesión', hist_morning: 'Mañana', hist_stiff: 'rigidez',
      chart_label: 'Gráfica de carga diaria y de los dos EVA de los últimos 14 días',
      no_token_t: 'Falta tu enlace', no_token_d: 'Abre el enlace personal que te envió tu fisioterapeuta.',
      invalid_t: 'Enlace no válido', invalid_d: 'Pídele a tu fisioterapeuta que te reenvíe tu enlace.',
      net_t: 'No se pudo cargar tu programa', net_d: 'Revisa tu conexión e inténtalo de nuevo.', retry: 'Reintentar',
      demo_banner: 'Modo demo: datos de ejemplo.', offline_banner: 'Sin conexión: mostrando la última versión guardada.',
      loading: 'Cargando…', err_required: 'Escribe la duración y el esfuerzo de la sesión.',
      invalid_duration: 'La duración debe estar entre 1 y 600 minutos.',
      wa_title_s: 'REPORTE DE SESIÓN', wa_title_m: 'REPORTE DE LA MAÑANA', wa_about: 'Sobre la sesión del {date}', wa_nolink: 'Sin sesión reciente',
      wa_load: 'Carga de la sesión', wa_pain_s: 'Dolor durante el ejercicio', wa_pain_m: 'Semáforo del dolor (ponderado)',
      wa_load2: 'Métricas de control de carga', wa_concl_s: 'Conclusión provisional', wa_concl_m: 'Conclusión del sistema',
      wa_patient: 'Paciente', wa_duration: 'Duración', wa_effort: 'Esfuerzo (RPE)', wa_ua: 'Carga',
      wa_during: 'Durante el ejercicio', wa_next: 'Al día siguiente (sobre basal)', wa_stiff: 'Rigidez matutina aumentada',
      wa_total: 'Puntaje total de dolor', wa_acwr: 'ACWR actual', wa_acwr_na: 'aún sin datos suficientes', wa_yes: 'SÍ', wa_no: 'NO',
      lbl_min: 'min', lbl_ua: 'UA'
    },
    en: {
      tab_program: 'My program', tab_report: "Today's report",
      hello: 'Hi, {name}', program_title: 'Your program',
      program_hint: 'RPE is perceived effort from 0 to 10. Max VAS is the highest pain allowed during the exercise.',
      program_empty: 'Your physiotherapist has not loaded your program yet.',
      ex_of: '{i} of {n}', series: 'Sets', reps: 'Reps', rpe: 'RPE', eva: 'Max VAS', rest: 'Rest',
      note: 'Note', novideo: 'No video', video_error: 'The video could not be loaded',
      report_title: "Today's report",
      morning_title: 'How you woke up today', session_title: 'After training',
      morning_about: 'About your session on {date}: pain during {v}/10.',
      morning_nolink: 'There is no session logged in the last 3 days. Tell us how you woke up anyway.',
      session_about: 'Tell us about your session as soon as you finish. You log next-day pain tomorrow, in "How you woke up today".',
      pending: 'Pending', done_chip: 'Done',
      duration: 'Duration (min)', effort: 'Session effort (RPE)',
      pain_during: 'Pain during or right after (VAS 0 to 10)',
      pain_next: 'Points of pain above your usual',
      pain_next_hint: '0 means the same or better than your usual morning pain.',
      stiffness: 'Morning stiffness clearly higher',
      save_session: 'Save session', save_morning: 'Save how I woke up',
      redo: 'Correct my answer', another: 'Add another session today',
      badge_ok: 'Safe / Green', badge_warn: 'Caution / Yellow', badge_bad: 'Alert / Red',
      ok_t: 'Load and response on track', ok_d: 'Your tendon is tolerating the work well. Keep following your program as is.',
      warn_t: 'Caution zone', warn_d: 'Do not increase loads in your next session. Keep the volume until you are back in green.',
      bad_during_t: 'Review the exercise', bad_during_d: 'Pain during the session was very high. Tell your physio before the next session so you can review technique or range of motion.',
      bad_nextday_t: 'Your tendon complained today', bad_nextday_d: 'You woke up with more pain or stiffness. Lower the volume or intensity next session and tell your physio how you are doing.',
      bad_acwr_t: 'Load went up too fast', bad_acwr_d: 'This week you did well above your average. Reduce the load next session to avoid a setback.',
      provisional: 'Provisional traffic light: tomorrow, once you tell us how you woke up, it is confirmed.',
      r_during_red: 'Pain during the session: {v}/10, very high.',
      r_during_yellow: 'Pain during the session: {v}/10.',
      r_next_red: 'This morning, {v} points above usual.',
      r_next_yellow: 'This morning, {v} point(s) above usual.',
      r_stiff: 'Morning stiffness increased.',
      r_acwr_red: 'ACWR {v}: recent load spike.',
      r_acwr_yellow: 'ACWR {v}: load in the caution zone.',
      r_acwr_low: 'ACWR {v}: recent load is low compared to your base.',
      m_acwr: 'ACWR (7 / 28 days)', m_pain: 'Pain score', m_during: 'VAS during',
      z_low: 'Underload', z_ok: 'Sweet spot', z_caution: 'Caution', z_peak: 'Load spike',
      acwr_wait: 'Calculated after {min} days of logging. You are at {n}.',
      saved_ok: "Saved to your physio's records.", saved_pending: 'No connection: it will be sent when you are back online.',
      saved_demo: 'Demo mode: saved only on this device.',
      wa_btn: 'Send to my physio on WhatsApp',
      wa_hint: 'WhatsApp will open with the message ready. Tap send so your physio receives it.',
      history_title: 'Last 14 days', legend_load: 'Load (AU)', legend_during: 'VAS during', legend_next: 'Next-day VAS',
      hist_title: 'Latest reports', hist_session: 'Session', hist_morning: 'Morning', hist_stiff: 'stiffness',
      chart_label: 'Chart of daily load and both VAS scores for the last 14 days',
      no_token_t: 'Your link is missing', no_token_d: 'Open the personal link your physiotherapist sent you.',
      invalid_t: 'Invalid link', invalid_d: 'Ask your physiotherapist to send your link again.',
      net_t: 'Your program could not be loaded', net_d: 'Check your connection and try again.', retry: 'Try again',
      demo_banner: 'Demo mode: sample data.', offline_banner: 'Offline: showing the last saved version.',
      loading: 'Loading…', err_required: 'Enter the session duration and effort.',
      invalid_duration: 'Duration must be between 1 and 600 minutes.',
      wa_title_s: 'SESSION REPORT', wa_title_m: 'MORNING REPORT', wa_about: 'About the session on {date}', wa_nolink: 'No recent session',
      wa_load: 'Session load', wa_pain_s: 'Pain during exercise', wa_pain_m: 'Pain traffic light (weighted)',
      wa_load2: 'Load control metrics', wa_concl_s: 'Provisional conclusion', wa_concl_m: 'System conclusion',
      wa_patient: 'Patient', wa_duration: 'Duration', wa_effort: 'Effort (RPE)', wa_ua: 'Load',
      wa_during: 'During exercise', wa_next: 'Next day (above baseline)', wa_stiff: 'Increased morning stiffness',
      wa_total: 'Total pain score', wa_acwr: 'Current ACWR', wa_acwr_na: 'not enough data yet', wa_yes: 'YES', wa_no: 'NO',
      lbl_min: 'min', lbl_ua: 'AU'
    }
  };

  /* ===================================================================
   * 3. ESTADO Y UTILIDADES
   * =================================================================== */

  var APP = root.APP_CONFIG || {};
  var state = {
    demo: false, token: '', data: null, cfg: {}, th: thresholds({}), lang: 'es',
    tab: 'program', local: [], pending: [], offline: false,
    edit: { morning: false, session: false }
  };
  var els = {};
  var observer = null;

  function ls(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch (e) { /* sin almacenamiento: la app sigue funcionando */ }
    return null;
  }
  function lsJson(k, fallback) {
    try { var raw = ls(k); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
  }
  function t(key, p) {
    var dict = I18N[state.lang] || I18N.es;
    var s = dict[key] !== undefined ? dict[key] : (I18N.es[key] !== undefined ? I18N.es[key] : key);
    if (p) Object.keys(p).forEach(function (k) { s = s.split('{' + k + '}').join(p[k]); });
    return s;
  }
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
  function svgEl(tag, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }
  function fmt(n, d) { return Number(n).toFixed(d).replace('.', state.lang === 'es' ? ',' : '.'); }
  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  function byTime(a, b) { return a.timestamp < b.timestamp ? -1 : (a.timestamp > b.timestamp ? 1 : 0); }

  function inkFor(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return '#FFFFFF';
    var n = parseInt(m[1], 16);
    var lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.6 ? '#10201F' : '#FFFFFF';
  }

  function applyBrand() {
    var b = APP.brand || {};
    var c = state.cfg || {};
    var name = c.nombre_marca || b.name || 'Seguimiento';
    var tag = c.lema !== undefined ? c.lema : (b.tagline || '');
    var logo = c.logo !== undefined && c.logo !== '' ? c.logo : (b.logo || '');
    var light = c.color_principal || b.primary || '#0F6B63';
    var dark = c.color_principal_oscuro || b.primaryDark || '#4FD1C0';
    var st = document.documentElement.style;
    st.setProperty('--brand-l', light);
    st.setProperty('--brand-l-ink', inkFor(light));
    st.setProperty('--brand-d', dark);
    st.setProperty('--brand-d-ink', inkFor(dark));
    document.title = name;
    state.brand = { name: name, tagline: tag, logo: logo };
    state.lang = (new URLSearchParams(location.search).get('lang') || c.idioma || APP.language || 'es').toLowerCase().slice(0, 2);
    if (!I18N[state.lang]) state.lang = 'es';
    document.documentElement.lang = state.lang;
    ls('fs_brand', JSON.stringify({ name: name, tagline: tag, logo: logo, light: light, dark: dark }));
  }

  function mediaUrl(src) {
    if (/^(https?:|data:|blob:)/i.test(src) || src.charAt(0) === '/') return src;
    var base = state.cfg.media_base || APP.mediaBase || 'media/';
    if (base.slice(-1) !== '/') base += '/';
    return base + src;
  }

  /* ===================================================================
   * 4. DATOS: carga, caché, reportes locales y envío
   * =================================================================== */

  function demoData() {
    var today = ymd(new Date());
    var th = thresholds({});
    var reportes = [];
    // [días atrás, minutos, RPE, EVA durante, EVA del día siguiente]. La sesión de ayer queda sin chequeo de mañana.
    var plan = [
      [20, 40, 5, 1, 0], [18, 40, 5, 2, 0], [16, 45, 5, 2, 0], [15, 40, 6, 2, 1], [13, 40, 5, 2, 0],
      [11, 45, 6, 3, 1], [10, 40, 5, 2, 0], [8, 40, 6, 2, 0], [7, 45, 6, 3, 0], [5, 40, 6, 2, 0],
      [4, 45, 6, 3, 1], [2, 45, 6, 3, 0], [1, 40, 5, 2, null]
    ];
    plan.forEach(function (p) {
      var f = addDays(today, -p[0]);
      reportes.push({
        timestamp: f + ' 19:00:00', fecha: f, tipo: 'sesion', fecha_sesion: '',
        duracion_min: p[1], rpe: p[2], ua: p[1] * p[2],
        dolor_durante: p[3], dolor_dia_siguiente: '', rigidez: '', puntaje_dolor: '', acwr: '',
        semaforo: classify({ dolor_durante: p[3], dolor_dia_siguiente: 0, rigidez: 'NO' }, null, th).label
      });
      if (p[4] !== null) {
        var m = addDays(f, 1);
        reportes.push({
          timestamp: m + ' 07:30:00', fecha: m, tipo: 'manana', fecha_sesion: f,
          duracion_min: '', rpe: '', ua: '', dolor_durante: '', dolor_dia_siguiente: p[4], rigidez: 'NO',
          puntaje_dolor: painScore(p[3], p[4]), acwr: '',
          semaforo: classify({ dolor_durante: p[3], dolor_dia_siguiente: p[4], rigidez: 'NO' }, null, th).label
        });
      }
    });
    return {
      ok: true, config: {},
      paciente: { codigo: 'DEMO', alias: 'Paciente demo', inicio: addDays(today, -21) },
      programa: [
        { bloque: 'Sesión A', ejercicio: { id: 'E01', nombre: 'Isométrico de cuádriceps en máquina', video: 'demo.mp4', indicaciones: 'Rodilla a 60 grados. Empuja de forma progresiva y sostén sin mover la pierna. Respira con normalidad.' }, series: '5', repeticiones: '45 s', rpe: '7', eva_max: '5', descanso: '90 s', notas: 'Semana 1 a 2.' },
        { bloque: 'Sesión A', ejercicio: { id: 'E02', nombre: 'Sentadilla en banco con tempo lento', video: '', indicaciones: 'Baja en 3 segundos, pausa en el banco y sube en 2 segundos. Rodillas alineadas con los pies.' }, series: '3', repeticiones: '10', rpe: '7', eva_max: '4', descanso: '90 s', notas: '' },
        { bloque: 'Sesión A', ejercicio: { id: 'E04', nombre: 'Puente de glúteo', video: '', indicaciones: 'Sube la pelvis hasta alinear hombro, cadera y rodilla. Sostén 2 segundos arriba.' }, series: '3', repeticiones: '12', rpe: '6', eva_max: '3', descanso: '60 s', notas: 'Como activación general.' }
      ],
      reportes: reportes
    };
  }

  function fetchJson(url, opts, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ms || 20000) : null;
    var o = opts || {};
    if (ctrl) o.signal = ctrl.signal;
    return fetch(url, o).then(function (r) { return r.json(); }).then(function (j) {
      if (timer) clearTimeout(timer);
      return j;
    }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }

  /* Reportes del servidor + los locales que el servidor todavía no devolvió. Los reportes sin tipo
   * (versión 1) se tratan como sesión con los dos EVA. */
  function allReports() {
    var server = (state.data && state.data.reportes) || [];
    var seen = {};
    server.forEach(function (r) { if (r.timestamp) seen[r.timestamp] = true; });
    return server.concat(state.local.filter(function (r) { return !seen[r.timestamp]; }));
  }

  function loadLocal() {
    var cutoff = addDays(ymd(new Date()), -60);
    state.local = lsJson('fs_local2_' + state.token, []).filter(function (r) { return r.fecha >= cutoff; });
    state.pending = lsJson('fs_pending2_' + state.token, []);
  }
  function saveLocal() {
    ls('fs_local2_' + state.token, JSON.stringify(state.local));
    ls('fs_pending2_' + state.token, JSON.stringify(state.pending));
  }

  function postReport(payload) {
    return fetchJson(APP.apiUrl, { method: 'POST', body: JSON.stringify(payload) }, 20000)
      .then(function (j) { if (!j || !j.ok) throw new Error((j && j.error) || 'error'); return true; });
  }

  function flushPending() {
    if (state.demo || !state.pending.length) return Promise.resolve();
    var queue = state.pending.slice();
    var chain = Promise.resolve();
    queue.forEach(function (p) {
      chain = chain.then(function () {
        return postReport(p).then(function () {
          state.pending = state.pending.filter(function (x) { return x.timestamp !== p.timestamp; });
          saveLocal();
        });
      });
    });
    return chain.catch(function () { /* se reintentará en la próxima apertura */ });
  }

  function loadData() {
    if (state.demo) {
      state.data = demoData();
      state.cfg = Object.assign({}, APP.demoConfig || {}, state.data.config || {});
      return Promise.resolve(true);
    }
    return fetchJson(APP.apiUrl + '?p=' + encodeURIComponent(state.token), null, 20000).then(function (d) {
      if (!d || !d.ok) { state.error = 'invalid'; return false; }
      state.data = d;
      state.cfg = d.config || {};
      ls('fs_cache2_' + state.token, JSON.stringify(d));
      return true;
    }).catch(function () {
      var cached = lsJson('fs_cache2_' + state.token, null);
      if (cached && cached.ok) {
        state.data = cached; state.cfg = cached.config || {}; state.offline = true;
        return true;
      }
      state.error = 'net';
      return false;
    });
  }

  /* ===================================================================
   * 5. INTERFAZ
   * =================================================================== */

  function initEls() { els.app = document.getElementById('app'); }

  function showScreen(kind) {
    els.app.textContent = '';
    els.app.appendChild(h('main', { class: 'shell' }, [
      h('div', { class: 'msg' }, [
        h('h1', { text: kind === 'loading' ? t('loading') : t(kind + '_t') }),
        kind === 'loading' ? null : h('p', { text: t(kind + '_d') }),
        kind === 'net' ? h('button', { class: 'btn', type: 'button', onclick: function () { start(); }, text: t('retry') }) : null
      ])
    ]));
  }

  function brandHeader() {
    var b = state.brand;
    function mono() { return h('div', { class: 'mono', 'aria-hidden': 'true', text: (b.name || 'F').charAt(0).toUpperCase() }); }
    var logo;
    if (b.logo) {
      logo = h('img', { class: 'logo', src: mediaUrl(b.logo), alt: '', width: '40', height: '40' });
      logo.addEventListener('error', function () { logo.replaceWith(mono()); });
    } else logo = mono();
    return h('header', { class: 'top' }, [
      logo,
      h('div', { class: 'brandtxt' }, [
        h('strong', { text: b.name }),
        b.tagline ? h('span', { text: b.tagline }) : null
      ])
    ]);
  }

  function buildShell() {
    els.app.textContent = '';
    var tabs = h('div', { class: 'tabs', role: 'tablist' }, [
      tabBtn('program', t('tab_program')),
      tabBtn('report', t('tab_report'))
    ]);
    els.programPanel = h('section', { class: 'panel-view', id: 'view-program', role: 'tabpanel' });
    els.reportPanel = h('section', { class: 'panel-view', id: 'view-report', role: 'tabpanel' });
    var banners = [];
    if (state.demo) banners.push(h('p', { class: 'banner', text: t('demo_banner') }));
    if (state.offline) banners.push(h('p', { class: 'banner', text: t('offline_banner') }));
    els.app.appendChild(h('main', { class: 'shell' }, [brandHeader()].concat(banners, [tabs, els.programPanel, els.reportPanel])));
    renderProgram();
    renderReport();
    setTab(state.tab, true);
  }

  function tabBtn(id, label) {
    return h('button', {
      type: 'button', class: 'tab', role: 'tab', id: 'tab-' + id, 'data-tab': id,
      'aria-controls': 'view-' + id, onclick: function () { setTab(id); }
    }, [label, id === 'report' ? h('i', { class: 'tabdot', 'aria-hidden': 'true' }) : null]);
  }

  function setTab(id, silent) {
    state.tab = id;
    ['program', 'report'].forEach(function (k) {
      var btn = document.getElementById('tab-' + k);
      var view = document.getElementById('view-' + k);
      if (btn) { btn.setAttribute('aria-selected', k === id ? 'true' : 'false'); }
      if (view) view.hidden = k !== id;
    });
    if (!silent) {
      try { history.replaceState(null, '', location.pathname + location.search + (id === 'report' ? '#reporte' : '')); } catch (e) { /* ignorado */ }
      window.scrollTo(0, 0);
    }
  }

  /* ---------------------------------------------------------- Programa */

  function stat(label, value, cls) {
    return h('div', { class: 'stat ' + (cls || '') }, [
      h('span', { class: 'k', text: label }),
      h('span', { class: 'v', text: String(value || '-') })
    ]);
  }

  function mediaEl(ex, reduced) {
    var src = ex.video;
    if (!src) return h('div', { class: 'media empty' }, [h('span', { text: t('novideo') })]);
    var url = mediaUrl(src);
    var wrap = h('div', { class: 'media' });
    function fail() {
      wrap.textContent = '';
      wrap.classList.add('empty');
      wrap.appendChild(h('span', { text: t('video_error') }));
    }
    if (/\.(gif|webp|png|jpe?g)$/i.test(src)) {
      var img = h('img', { src: url, alt: ex.nombre, loading: 'lazy' });
      img.addEventListener('error', fail);
      wrap.appendChild(img);
      return wrap;
    }
    var v = h('video', { muted: true, loop: true, playsinline: true, preload: 'none', 'aria-label': ex.nombre });
    v.muted = true;
    v.setAttribute('data-src', url);
    if (reduced) v.setAttribute('controls', '');
    v.addEventListener('error', fail);
    wrap.appendChild(v);
    if (observer) observer.observe(v);
    return wrap;
  }

  function renderProgram() {
    var box = els.programPanel;
    box.textContent = '';
    if (observer) observer.disconnect();
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          var v = en.target;
          if (en.isIntersecting) {
            if (!v.getAttribute('src')) v.setAttribute('src', v.getAttribute('data-src'));
            if (!reduced) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
          } else if (!v.paused) v.pause();
        });
      }, { rootMargin: '120px' });
    } else observer = null;

    var pac = state.data.paciente || {};
    box.appendChild(h('div', { class: 'intro' }, [
      h('p', { class: 'eyebrow', text: t('hello', { name: pac.alias || '' }) }),
      h('h1', { text: t('program_title') }),
      h('p', { class: 'hint', text: t('program_hint') })
    ]));

    var prog = state.data.programa || [];
    if (!prog.length) {
      box.appendChild(h('p', { class: 'empty-note', text: t('program_empty') }));
      return;
    }
    var blocks = [], map = {};
    prog.forEach(function (row) {
      var key = row.bloque || '';
      if (!map[key]) { map[key] = []; blocks.push(key); }
      map[key].push(row);
    });
    blocks.forEach(function (name) {
      var rows = map[name];
      var sec = h('div', { class: 'block' });
      if (name) sec.appendChild(h('h2', { class: 'block-title', text: name }));
      rows.forEach(function (row, i) {
        var ex = row.ejercicio || {};
        var stats = [stat(t('series'), row.series), stat(t('reps'), row.repeticiones), stat(t('rpe'), row.rpe), stat(t('eva'), row.eva_max, 'warnv')];
        if (row.descanso) stats.push(stat(t('rest'), row.descanso));
        sec.appendChild(h('article', { class: 'card ex' }, [
          mediaEl(ex, reduced),
          h('div', { class: 'ex-body' }, [
            h('p', { class: 'eyebrow', text: t('ex_of', { i: i + 1, n: rows.length }) }),
            h('h3', { text: ex.nombre || '' }),
            h('div', { class: 'stats' }, stats),
            ex.indicaciones ? h('p', { class: 'how', text: ex.indicaciones }) : null,
            row.notas ? h('p', { class: 'note', text: t('note') + ': ' + row.notas }) : null
          ])
        ]));
      });
      box.appendChild(sec);
    });
  }

  /* ----------------------------------------------------------- Reporte */

  function todays(kind) {
    var today = ymd(new Date());
    return allReports().filter(function (r) {
      return r.fecha === today && (kind === 'morning' ? isMorning(r) : !isMorning(r));
    }).sort(byTime);
  }

  function linkFor(rec, reports) {
    return rec.fecha_sesion ? { fecha: rec.fecha_sesion, during: maxDuring(reports, rec.fecha_sesion) } : null;
  }

  function resultTexts(ev) {
    var k = ev.cls.key;
    if (k === 'ok') return { badge: t('badge_ok'), title: t('ok_t'), desc: t('ok_d') };
    if (k === 'warn') return { badge: t('badge_warn'), title: t('warn_t'), desc: t('warn_d') };
    return { badge: t('badge_bad'), title: t('bad_' + ev.cls.cause + '_t'), desc: t('bad_' + ev.cls.cause + '_d') };
  }

  function acwrLine(ev) {
    return '• *' + t('wa_acwr') + ': ' + (ev.info.acwr === null ? t('wa_acwr_na') : fmt(ev.info.acwr, 2)) + '*' +
      (ev.zone ? ' (' + t('z_' + ev.zone).toLowerCase() + ')' : '');
  }

  function buildSessionText(r, ev) {
    var pac = state.data.paciente || {};
    var tx = resultTexts(ev);
    return [
      '📋 *' + t('wa_title_s') + '* (' + shortDate(r.fecha) + ')',
      t('wa_patient') + ': ' + (pac.alias || ''),
      '',
      '🏋️ *' + t('wa_load') + ':*',
      '• ' + t('wa_duration') + ': ' + r.duracion_min + ' ' + t('lbl_min'),
      '• ' + t('wa_effort') + ': ' + r.rpe + '/10',
      '• ' + t('wa_ua') + ': ' + r.ua + ' ' + t('lbl_ua'),
      '',
      '🚨 *' + t('wa_pain_s') + ':* ' + r.dolor_durante + '/10',
      '',
      '📊 *' + t('wa_load2') + ':*',
      acwrLine(ev),
      '',
      '🎯 *' + t('wa_concl_s') + ':* ' + ev.cls.label,
      '_' + tx.title + '_'
    ].join('\n');
  }

  function buildMorningText(r, ev) {
    var pac = state.data.paciente || {};
    var tx = resultTexts(ev);
    return [
      '📋 *' + t('wa_title_m') + '* (' + shortDate(r.fecha) + ')',
      t('wa_patient') + ': ' + (pac.alias || ''),
      ev.link ? t('wa_about', { date: shortDate(ev.link.fecha) }) : t('wa_nolink'),
      '',
      '🚨 *' + t('wa_pain_m') + ':*',
      '• ' + t('wa_during') + ': ' + (ev.link ? ev.during + '/10 (40%)' : '-'),
      '• ' + t('wa_next') + ': ' + r.dolor_dia_siguiente + '/10 (60%)',
      '• ' + t('wa_stiff') + ': ' + (r.rigidez === 'SI' ? t('wa_yes') + ' ⚠️' : t('wa_no')),
      '• *' + t('wa_total') + ': ' + fmt(ev.score, 1) + '/10*',
      '',
      '📊 *' + t('wa_load2') + ':*',
      acwrLine(ev),
      '',
      '🎯 *' + t('wa_concl_m') + ':* ' + ev.cls.label,
      '_' + tx.title + '_'
    ].join('\n');
  }

  function reasonLine(rs) {
    var map = {
      during_red: 'r_during_red', during_yellow: 'r_during_yellow', next_red: 'r_next_red', next_yellow: 'r_next_yellow',
      stiff: 'r_stiff', acwr_red: 'r_acwr_red', acwr_yellow: 'r_acwr_yellow', acwr_low: 'r_acwr_low'
    };
    var v = rs.v;
    if (rs.code.indexOf('acwr') === 0) v = fmt(v, 2);
    return t(map[rs.code], { v: v });
  }

  function resultCard(r) {
    var all = allReports();
    var morning = isMorning(r);
    var ev = morning ? evaluateMorning(r, linkFor(r, all), all, state.th) : evaluateSession(r, all, state.th);
    var tx = resultTexts(ev);
    var waNum = digits(state.cfg.whatsapp || APP.whatsapp);
    var text = morning ? buildMorningText(r, ev) : buildSessionText(r, ev);
    var href = 'https://wa.me/' + waNum + '?text=' + encodeURIComponent(text);
    var pending = state.pending.some(function (p) { return p.timestamp === r.timestamp; });
    var statusTxt = state.demo ? t('saved_demo') : (pending ? t('saved_pending') : t('saved_ok'));

    var acwrVal, acwrSub;
    if (ev.info.acwr !== null) { acwrVal = fmt(ev.info.acwr, 2); acwrSub = t('z_' + ev.zone); }
    else if (!ev.info.ready) { acwrVal = '--'; acwrSub = t('acwr_wait', { min: state.th.dias_minimos_acwr, n: ev.info.daysHist }); }
    else { acwrVal = '--'; acwrSub = ''; }

    return h('div', { class: 'stack' }, [
      h('div', { class: 'status', 'data-state': ev.cls.key, 'aria-live': 'polite' }, [
        h('div', { class: 'lamps', 'aria-hidden': 'true' }, [h('i', { class: 'lamp bad' }), h('i', { class: 'lamp warn' }), h('i', { class: 'lamp ok' })]),
        h('div', null, [
          h('span', { class: 'badge', text: tx.badge }),
          h('h3', { text: tx.title }),
          h('p', { text: tx.desc }),
          ev.cls.reasons.length ? h('ul', { class: 'reasons' }, ev.cls.reasons.map(function (rs) { return h('li', { text: reasonLine(rs) }); })) : null,
          ev.provisional ? h('p', { class: 'prov', text: t('provisional') }) : null
        ])
      ]),
      h('div', { class: 'metrics' }, [
        h('div', { class: 'metric' }, [
          h('span', { class: 'eyebrow', text: t('m_acwr') }),
          h('span', { class: 'big', text: acwrVal }),
          h('span', { class: 'sub', text: acwrSub })
        ]),
        h('div', { class: 'metric' }, [
          h('span', { class: 'eyebrow', text: morning ? t('m_pain') : t('m_during') }),
          h('span', { class: 'big', text: (morning ? fmt(ev.score, 1) : ev.during) + '/10' }),
          h('span', { class: 'sub', text: morning ? '40% + 60%' : '' })
        ])
      ]),
      h('a', { class: 'btn wa', href: href, target: '_blank', rel: 'noopener noreferrer', text: t('wa_btn') }),
      h('p', { class: 'hint center', text: t('wa_hint') }),
      h('p', { class: 'status-line', text: statusTxt })
    ]);
  }

  function slider(id, labelKey, hintKey, outId) {
    var out = h('output', { id: outId, for: id, text: '0' });
    var input = h('input', { type: 'range', id: id, min: '0', max: '10', step: '1', value: '0' });
    input.addEventListener('input', function () { out.textContent = input.value; });
    return h('div', { class: 'slider' }, [
      h('div', { class: 'head' }, [h('label', { for: id, text: t(labelKey) }), out]),
      input,
      h('div', { class: 'scale-ends' }, [h('span', { text: '0' }), h('span', { text: '10' })]),
      hintKey ? h('small', { text: t(hintKey) }) : null
    ]);
  }

  function sessionForm() {
    var err = h('p', { class: 'error', role: 'alert', hidden: true });
    var dur = h('input', { type: 'number', id: 'duration', min: '1', max: '600', inputmode: 'numeric', placeholder: '40' });
    var form = h('form', { class: 'form', novalidate: true }, [
      h('label', { class: 'f', for: 'duration' }, [h('span', { text: t('duration') }), dur]),
      slider('rpe', 'effort', null, 'rpeOut'),
      slider('painDuring', 'pain_during', null, 'painDuringOut'),
      err,
      h('button', { class: 'btn', type: 'submit', text: t('save_session') })
    ]);
    form.addEventListener('submit', function (e) { e.preventDefault(); submitSession(err); });
    return form;
  }

  function morningForm() {
    var form = h('form', { class: 'form', novalidate: true }, [
      slider('painNext', 'pain_next', 'pain_next_hint', 'painNextOut'),
      h('label', { class: 'check', for: 'stiff' }, [h('span', { text: t('stiffness') }), h('input', { type: 'checkbox', id: 'stiff' })]),
      h('button', { class: 'btn', type: 'submit', text: t('save_morning') })
    ]);
    form.addEventListener('submit', function (e) { e.preventDefault(); submitMorning(); });
    return form;
  }

  function store(rec) {
    state.local.push(rec);
    if (state.demo) { saveLocal(); return; }
    var payload = Object.assign({ token: state.token }, rec);
    state.pending.push(payload);
    saveLocal();
    postReport(payload).then(function () {
      state.pending = state.pending.filter(function (p) { return p.timestamp !== rec.timestamp; });
      saveLocal();
      renderReport();
    }, function () { /* queda en pendientes */ });
  }

  function submitSession(err) {
    function val(id) { return document.getElementById(id); }
    err.hidden = true;
    var dur = num(val('duration').value, NaN);
    var rpe = num(val('rpe').value, NaN);
    if (!isFinite(dur) || !isFinite(rpe)) { err.textContent = t('err_required'); err.hidden = false; return; }
    if (dur < 1 || dur > 600) { err.textContent = t('invalid_duration'); err.hidden = false; return; }
    var now = new Date();
    var rec = {
      timestamp: stamp(now), fecha: ymd(now), tipo: 'sesion', fecha_sesion: '',
      duracion_min: dur, rpe: rpe, ua: round(dur * rpe, 1),
      dolor_durante: num(val('painDuring').value, 0), dolor_dia_siguiente: '', rigidez: ''
    };
    var ev = evaluateSession(rec, allReports().concat([rec]), state.th);
    rec.puntaje_dolor = '';
    rec.acwr = ev.info.acwr === null ? '' : ev.info.acwr;
    rec.semaforo = ev.cls.label;
    state.edit.session = false;
    store(rec);
    renderReport();
    window.scrollTo(0, 0);
  }

  function submitMorning() {
    var now = new Date();
    var today = ymd(now);
    var all = allReports();
    var link = linkedSession(all, today, DIAS_ENLACE);
    var rec = {
      timestamp: stamp(now), fecha: today, tipo: 'manana', fecha_sesion: link ? link.fecha : '',
      duracion_min: '', rpe: '', ua: '',
      dolor_durante: '', dolor_dia_siguiente: num(document.getElementById('painNext').value, 0),
      rigidez: document.getElementById('stiff').checked ? 'SI' : 'NO'
    };
    var ev = evaluateMorning(rec, link, all, state.th);
    rec.puntaje_dolor = ev.score;
    rec.acwr = ev.info.acwr === null ? '' : ev.info.acwr;
    rec.semaforo = ev.cls.label;
    state.edit.morning = false;
    store(rec);
    renderReport();
    window.scrollTo(0, 0);
  }

  function chart(reports) {
    var today = ymd(new Date());
    var days = [];
    for (var i = 13; i >= 0; i--) days.push(addDays(today, -i));
    var loads = dailyLoads(reports);
    var during = {}, next = {};
    reports.slice().sort(byTime).forEach(function (r) {
      if (isMorning(r)) next[r.fecha] = num(r.dolor_dia_siguiente, 0);
      else during[r.fecha] = Math.max(during[r.fecha] || 0, num(r.dolor_durante, 0));
    });
    var W = 340, H = 150, L = 6, R = 6, T = 10, B = 22;
    var maxLoad = Math.max.apply(null, days.map(function (d) { return loads[d] || 0; }).concat([100]));
    var step = (W - L - R) / days.length;
    var bw = Math.max(6, step - 6);
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': t('chart_label') });
    [0, 0.5, 1].forEach(function (f) {
      var y = T + (H - T - B) * (1 - f);
      svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: y, y2: y, class: 'grid' }));
    });
    var ptsD = [], ptsN = [];
    days.forEach(function (d, i) {
      var x = L + step * i + (step - bw) / 2;
      var hh = (H - T - B) * ((loads[d] || 0) / maxLoad);
      if (hh > 0) svg.appendChild(svgEl('rect', { x: x, y: H - B - hh, width: bw, height: hh, rx: 2, class: 'bar' }));
      if (during[d] !== undefined) ptsD.push([x + bw / 2, T + (H - T - B) * (1 - during[d] / 10)]);
      if (next[d] !== undefined) ptsN.push([x + bw / 2, T + (H - T - B) * (1 - next[d] / 10)]);
      if (i % 3 === 1) {
        var tx = svgEl('text', { x: x + bw / 2, y: H - 6, class: 'tick', 'text-anchor': 'middle' });
        tx.textContent = shortDate(d);
        svg.appendChild(tx);
      }
    });
    function draw(pts, cls) {
      if (!pts.length) return;
      svg.appendChild(svgEl('polyline', { points: pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '), class: cls }));
      pts.forEach(function (p, i) {
        svg.appendChild(svgEl('circle', { cx: p[0], cy: p[1], r: i === pts.length - 1 ? 4 : 2.5, class: cls === 'line' ? 'dot' : 'dot dot2' }));
      });
    }
    draw(ptsN, 'line2');
    draw(ptsD, 'line');
    return svg;
  }

  function historyCard() {
    var reps = allReports();
    var list = h('div', { class: 'hist' });
    reps.slice().sort(byTime).reverse().slice(0, 8).forEach(function (r) {
      var morning = isMorning(r);
      var key = String(r.semaforo || '').toUpperCase();
      var cls = key === 'ROJO' ? 'bad' : (key === 'AMARILLO' ? 'warn' : (key === 'VERDE' ? 'ok' : ''));
      var detail = morning
        ? 'EVA +' + num(r.dolor_dia_siguiente, 0) + (String(r.rigidez).toUpperCase() === 'SI' ? ' · ' + t('hist_stiff') : '')
        : Math.round(reportLoad(r)) + ' ' + t('lbl_ua') + ' · EVA ' + num(r.dolor_durante, 0) +
          (String(r.tipo) === 'completo' && r.dolor_dia_siguiente !== '' ? ' / +' + num(r.dolor_dia_siguiente, 0) : '');
      list.appendChild(h('div', { class: 'line' }, [
        h('span', { class: 'd', text: shortDate(r.fecha) }),
        h('span', { class: 'chip', text: morning ? t('hist_morning') : t('hist_session') }),
        h('span', { class: 'l', text: detail }),
        h('i', { class: 'dotc ' + cls, 'aria-hidden': 'true' })
      ]));
    });
    return h('section', { class: 'card' }, [
      h('h2', { class: 'sec-title', text: t('history_title') }),
      chart(reps),
      h('div', { class: 'legend' }, [
        h('span', null, [h('i', { class: 'sw bar' }), t('legend_load')]),
        h('span', null, [h('i', { class: 'sw line' }), t('legend_during')]),
        h('span', null, [h('i', { class: 'sw line2' }), t('legend_next')])
      ]),
      h('h2', { class: 'sec-title sub-title', text: t('hist_title') }),
      list
    ]);
  }

  function section(title, chip, chipCls, kids) {
    return h('section', { class: 'card sec' }, [
      h('div', { class: 'sec-head' }, [
        h('h2', { text: title }),
        chip ? h('span', { class: 'chipst ' + chipCls, text: chip }) : null
      ])
    ].concat(kids));
  }

  function renderReport() {
    var box = els.reportPanel;
    box.textContent = '';
    var all = allReports();
    var today = ymd(new Date());

    // Cómo amaneciste hoy
    var morns = todays('morning');
    var link = linkedSession(all, today, DIAS_ENLACE);
    var mornPending = !morns.length && !!link;
    var mKids;
    if (morns.length && !state.edit.morning) {
      mKids = [resultCard(morns[morns.length - 1]),
        h('button', { class: 'btn ghost', type: 'button', text: t('redo'), onclick: function () { state.edit.morning = true; renderReport(); } })];
    } else {
      mKids = [h('p', { class: 'hint', text: link ? t('morning_about', { date: shortDate(link.fecha), v: link.during }) : t('morning_nolink') }), morningForm()];
    }
    var mChip = morns.length ? t('done_chip') : (mornPending ? t('pending') : '');
    var mCls = morns.length ? 'done' : 'pend';

    // Después de entrenar
    var sess = todays('session');
    var sKids;
    if (sess.length && !state.edit.session) {
      sKids = [resultCard(sess[sess.length - 1]),
        h('button', { class: 'btn ghost', type: 'button', text: t('another'), onclick: function () { state.edit.session = true; renderReport(); } })];
    } else {
      sKids = [h('p', { class: 'hint', text: t('session_about') }), sessionForm()];
    }

    box.appendChild(h('h1', { class: 'page-title', text: t('report_title') }));
    box.appendChild(section(t('morning_title'), mChip, mCls, mKids));
    box.appendChild(section(t('session_title'), sess.length ? t('done_chip') : '', 'done', sKids));
    box.appendChild(historyCard());

    var dot = document.getElementById('tab-report');
    if (dot) dot.classList.toggle('has-pending', mornPending);
  }

  /* ===================================================================
   * 6. ARRANQUE
   * =================================================================== */

  function start() {
    initEls();
    var qs = new URLSearchParams(location.search);
    var token = (qs.get('p') || '').trim();
    if (token) ls('fs_token', token); else token = ls('fs_token') || '';
    state.error = null;
    state.offline = false;

    // Marca guardada para que la primera pantalla ya salga con los colores correctos.
    var cached = lsJson('fs_brand', null);
    if (cached) {
      var st = document.documentElement.style;
      st.setProperty('--brand-l', cached.light); st.setProperty('--brand-l-ink', inkFor(cached.light));
      st.setProperty('--brand-d', cached.dark); st.setProperty('--brand-d-ink', inkFor(cached.dark));
    }
    state.demo = !APP.apiUrl || token === 'demo';
    if (state.demo) token = 'demo';
    state.token = token;

    if (!state.demo && !token) {
      state.cfg = {}; applyBrand(); showScreen('no_token'); return;
    }
    state.cfg = state.cfg || {};
    applyBrand();
    showScreen('loading');
    loadData().then(function (ok) {
      if (!ok) { applyBrand(); showScreen(state.error === 'invalid' ? 'invalid' : 'net'); return; }
      applyBrand();
      state.th = thresholds(state.cfg);
      loadLocal();
      state.tab = location.hash === '#reporte' ? 'report' : 'program';
      state.edit = { morning: false, session: false };
      buildShell();
      flushPending();
    });
  }

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

})(typeof window !== 'undefined' ? window : globalThis);
