// Consulta en ARCA (Mis Comprobantes) los comprobantes emitidos de los ultimos 12 meses
// y la tabla vigente de categorias de Monotributo. Imprime un JSON con el resumen.
// Credenciales: variables de entorno Arca_user (CUIT) y Arca_pass (clave fiscal).
// Uso: node arca/facturacion.js [salida.json]
const { chromium } = require('playwright');
const fs = require('fs');

const MAX_PASSWORD_SUBMITS = 6; // tope de envios de clave por corrida
const LOGIN = 'https://auth.afip.gob.ar/contribuyente_/login.xhtml?action=SYSTEM&system=mcmp';
const log = (...a) => console.error(...a);
const fmt = d => String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();

function stripMatrixParams(ctx) {
  // El proxy de salida rechaza URLs con ";jsessionid=..."; la cookie ya lleva la sesion.
  return ctx.route(u => u.pathname.includes(';'), route => {
    const u = new URL(route.request().url());
    u.pathname = u.pathname.replace(/;[^/]*/g, '');
    route.continue({ url: u.toString() });
  });
}

async function categorias(browser) {
  const ctx = await browser.newContext({ locale: 'es-AR' });
  const page = await ctx.newPage();
  try {
    await page.goto('https://www.arca.gob.ar/monotributo/categorias.asp', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const rows = await page.$$eval('tr', trs => trs.map(tr => [...tr.querySelectorAll('th,td')].map(c => c.innerText.trim())));
    const out = [];
    for (const r of rows) {
      if (/^[A-K]$/.test(r[0]) && /\$/.test(r[1] || '')) {
        out.push({ categoria: r[0], topeIngresosBrutos: parseFloat(r[1].replace(/[^\d,]/g, '').replace(',', '.')) });
      }
    }
    return out;
  } finally { await ctx.close(); }
}

async function abrirSesion(browser, state) {
  const ctx = await browser.newContext({ locale: 'es-AR', viewport: { width: 1400, height: 1000 } });
  await stripMatrixParams(ctx);
  const page = await ctx.newPage();
  let savedPost = null;
  page.on('request', q => {
    if (q.method() === 'POST' && q.url().includes('/mcmp/jsp/index.do') && q.postData() && !savedPost) savedPost = q.postData();
  });
  const menuOk = () => page.$('a[href*="comprobantesEmitidos"], #btnEmitidos').catch(() => null);
  for (let i = 0; i < 12 && state.pw < MAX_PASSWORD_SUBMITS; i++) {
    const r = await page.goto(LOGIN, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
    if (!r || r.status() !== 200 || !(await page.$('#F1\\:username').catch(() => null))) { await page.waitForTimeout(2000); continue; }
    await page.fill('#F1\\:username', process.env.Arca_user).catch(() => {});
    await Promise.all([page.waitForNavigation({ timeout: 30000 }).catch(() => {}), page.click('#F1\\:btnSiguiente').catch(() => {})]);
    await page.waitForTimeout(1500);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    const pw = await page.$('#F1\\:password').catch(() => null);
    if (!(pw && await pw.isVisible().catch(() => false))) continue; // el login perdio la sesion: reintentar
    await pw.fill(process.env.Arca_pass);
    state.pw++;
    await page.click('#F1\\:btnIngresar');
    await page.waitForURL(/fes\.afip\.gob\.ar.*setearContribuyente/, { timeout: 25000 }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    if (!page.url().includes('fes.afip.gob.ar')) {
      const txt = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ');
      if (/incorrect|inv[aá]lid|bloquead|Denegado|captcha/i.test(txt)) throw new Error('ARCA rechazo el ingreso: ' + txt.slice(0, 200));
      continue;
    }
    // La sesion del servicio se pierde al azar: reenviar el token original con cookies limpias
    // (no vuelve a enviar la clave).
    const pairs = (savedPost || '').split('&').filter(Boolean).map(x => {
      const k = x.indexOf('=');
      return [decodeURIComponent(x.slice(0, k).replace(/\+/g, ' ')), decodeURIComponent(x.slice(k + 1).replace(/\+/g, ' '))];
    });
    const reentrar = async () => {
      for (let k = 0; k < 20 && pairs.length; k++) {
        const all = await ctx.cookies();
        await ctx.clearCookies();
        await ctx.addCookies(all.filter(c => !c.domain.includes('fes.')));
        await page.goto('about:blank').catch(() => {});
        await page.waitForTimeout(300);
        await Promise.all([page.waitForNavigation({ timeout: 30000 }).catch(() => {}), page.evaluate(pairs => {
          const f = document.createElement('form'); f.method = 'POST'; f.action = 'https://fes.afip.gob.ar/mcmp/jsp/index.do';
          for (const [n, v] of pairs) { const el = document.createElement('input'); el.type = 'hidden'; el.name = n; el.value = v; f.appendChild(el); }
          document.body.appendChild(f); f.submit();
        }, pairs).catch(() => {})]);
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(1000);
        if (await menuOk()) return true;
      }
      return false;
    };
    if (await menuOk() || await reentrar()) return { ctx, page, reentrar };
    break;
  }
  await ctx.close();
  return null;
}

async function api(page, qs, tries = 6) {
  for (let k = 0; k < tries; k++) {
    const body = await page.evaluate(async u => {
      try { const r = await fetch(u, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } }); return await r.text(); }
      catch (e) { return ''; }
    }, '/mcmp/jsp/ajax.do?' + qs).catch(() => '');
    try { const j = JSON.parse(body); if (j && j.estado === 'ok') return j; } catch (e) {}
    await page.waitForTimeout(700);
  }
  return null;
}

async function consultar(page, desde, hasta) {
  const rango = encodeURIComponent(fmt(desde) + ' - ' + fmt(hasta)).replace(/%20/g, '+');
  const g = await api(page, 'f=generarConsulta&t=E&fechaEmision=' + rango + '&tiposComprobantes=&cuitConsultada=' + process.env.Arca_user);
  if (!g || !g.datos || !g.datos.idConsulta) return null;
  await page.waitForTimeout(3000);
  let rows = null, estado = null;
  for (let w = 0; w < 6; w++) {
    const lr = await api(page, 'f=listaResultados&id=' + encodeURIComponent(g.datos.idConsulta));
    if (!lr || !lr.datos) return null;
    rows = lr.datos.data || []; estado = lr.datos.consulta && lr.datos.consulta.estado;
    if (estado && estado !== 'PE') break;
    await page.waitForTimeout(4000);
  }
  return { rows, estado };
}

(async () => {
  if (!process.env.Arca_user || !process.env.Arca_pass) throw new Error('Faltan las variables de entorno Arca_user / Arca_pass');
  const hasta = new Date(); hasta.setDate(hasta.getDate() - 1); // ARCA informa hasta ayer inclusive
  const desde = new Date(hasta); desde.setDate(desde.getDate() - 364); // rango maximo: 365 dias
  const browser = await chromium.launch();
  const state = { pw: 0 };
  let tabla = [];
  try { tabla = await categorias(browser); } catch (e) { log('No se pudo leer la tabla de categorias:', e.message.split('\n')[0]); }
  let res = null;
  while (!res && state.pw < MAX_PASSWORD_SUBMITS) {
    const s = await abrirSesion(browser, state);
    if (!s) continue;
    for (let ronda = 0; ronda < 12 && !res; ronda++) {
      try { res = await consultar(s.page, desde, hasta); } catch (e) { log('Error en la sesion:', e.message.split('\n')[0]); }
      if (!res && !(await s.reentrar().catch(() => false))) break;
    }
    await s.ctx.close();
    log('intento de consulta:', res ? 'ok' : 'fallo', '- envios de clave:', state.pw);
  }
  await browser.close();
  if (!res) throw new Error('No se pudo completar la consulta (envios de clave: ' + state.pw + ')');

  // Columnas: 0 fecha, 1 tipo, 3 punto de venta, 4 numero, 12 receptor, penultima importe total (en pesos).
  // Notas de credito (tipos 3, 8, 13, 53 y equivalentes) restan.
  const NC = new Set(['3', '8', '13', '21', '53', '110', '112', '113', '114', '203', '208', '213']);
  const comprobantes = res.rows.map(r => ({
    fecha: r[0], tipo: r[1], puntoDeVenta: r[3], numero: r[4], receptor: r[12] || null,
    importe: (NC.has(String(r[1])) ? -1 : 1) * parseFloat(r[r.length - 2] || '0'),
  }));
  const porMes = {};
  for (const c of comprobantes) { const k = c.fecha.slice(6) + '-' + c.fecha.slice(3, 5); porMes[k] = (porMes[k] || 0) + c.importe; }
  const total = comprobantes.reduce((a, c) => a + c.importe, 0);
  const out = {
    periodo: { desde: fmt(desde), hasta: fmt(hasta) }, estadoConsulta: res.estado, enviosDeClave: state.pw,
    cantidad: comprobantes.length, total, porMes, comprobantes, categorias: tabla,
  };
  const json = JSON.stringify(out, null, 2);
  if (process.argv[2]) fs.writeFileSync(process.argv[2], json);
  console.log(json);
})().catch(e => { console.error('ERROR:', e.message.split('\n')[0]); process.exit(1); });
