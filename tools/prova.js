/* Prova de fum amb navegador real: obre l'eina, la fa servir com un
   professor i comprova el que surt a pantalla i al PDF.

       node tools/prova.js

   Abans només escrivia per pantalla i acabava sempre bé: un «*** BUIDA ***»
   passava desapercebut si ningú llegia la sortida. Ara cada comprovació
   compta i, si n'hi ha cap que falla, el procés acaba amb codi 1 (i
   l'Action de GitHub es posa en vermell). */

/* Playwright pot estar instal·lat al projecte o globalment, i la ruta
   global depèn de la màquina. Es busca als dos llocs en comptes de
   codificar-ne una: amb una ruta absoluta, aquesta ordre —que el README
   documenta— petava a la primera línia a qualsevol altre ordinador. */
function carregaPlaywright() {
  try { return require('playwright'); } catch (e) { /* no és al projecte */ }
  try {
    const arrelGlobal = require('child_process')
      .execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(require('path').join(arrelGlobal, 'playwright'));
  } catch (e) {
    console.error('Cal Playwright: npm install -D playwright && npx playwright install chromium');
    process.exit(1);
  }
}
const { chromium } = carregaPlaywright();
const path = require('path');

const arrel = path.resolve(__dirname, '..');
const URL_EINA = 'file://' + path.join(arrel, 'index.html');

let ok = 0, ko = 0;
function comprova(nom, cond, extra) {
  if (cond) { ok++; console.log('  ok    ' + nom); }
  else { ko++; console.log('  FALLA ' + nom + (extra !== undefined ? '  ' + extra : '')); }
}

/** Pàgines d'un PDF: es compten els objectes /Type /Page. */
const paginesPdf = buf => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;

(async () => {
  const nav = await chromium.launch();
  const pag = await nav.newPage({ viewport: { width: 1560, height: 1000 } });

  const errors = [];
  pag.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  pag.on('pageerror', e => errors.push('PAGEERROR ' + e.message));

  await pag.goto(URL_EINA);
  await pag.waitForTimeout(800);

  console.log('Arrencada');
  const inici = await pag.evaluate(() => ({
    sabers: document.querySelectorAll('.saber').length,
    llavor: (document.querySelector('#llavor') || {}).textContent
  }));
  comprova('es llisten els continguts', inici.sabers >= 50, inici.sabers);
  comprova('hi ha un codi de tria de cinc caràcters', /^[0-9A-Z]{5}$/.test(inici.llavor), inici.llavor);

  console.log('Composició');
  await pag.click('[data-curs="1eso"]');
  await pag.waitForTimeout(600);
  const desp = await pag.evaluate(() => ({
    preguntes: document.querySelectorAll('.pregunta').length,
    subtitol: (document.querySelector('.doc-cap .subtitol') || {}).textContent,
    katex: document.querySelectorAll('.katex').length
  }));
  comprova('«Tot el curs» dona una pregunta per contingut de 1r', desp.preguntes === 18, desp.preguntes);
  comprova('el subtítol diu el curs', desp.subtitol === 'Continguts de 1r d\'ESO', desp.subtitol);
  comprova('KaTeX compon les fórmules', desp.katex > 0, desp.katex);

  /* La volta ha d'oferir preguntes noves i no repetir-ne cap fins haver-les
     mostrat totes. És el bug de A, B, B, A, C. */
  const firma = () => pag.evaluate(() => {
    const c = document.querySelector('.pregunta-cos');
    const g = c.querySelector('svg');
    return c.textContent.replace(/\s+/g, ' ').trim() + '|' + (g ? g.outerHTML.length : 0);
  });
  const vistes = [await firma()];
  for (let k = 0; k < 12; k++) {
    await pag.evaluate(() => document.querySelector('.pregunta-eines [data-seguent]').click());
    await pag.waitForTimeout(60);
    vistes.push(await firma());
  }
  let seguides = 0;
  for (let k = 1; k < vistes.length; k++) if (vistes[k] === vistes[k - 1]) seguides++;
  comprova('⟳ no repeteix mai la pregunta que hi havia', seguides === 0, seguides);
  comprova('13 clics de ⟳ mostren almenys 10 preguntes diferents',
    new Set(vistes).size >= 10, new Set(vistes).size);

  const abans = await pag.evaluate(() => document.querySelectorAll('.q').length);
  await pag.evaluate(() => document.querySelector('[data-treu="1"]').click());
  await pag.waitForTimeout(300);
  const despres = await pag.evaluate(() => document.querySelectorAll('.q').length);
  comprova('✕ treu una pregunta i només una', despres === abans - 1, `${abans} -> ${despres}`);

  console.log('Paper');
  /* El comptador de pàgines ha de dir el mateix que el PDF real. */
  const estimat = await pag.evaluate(() =>
    +(document.querySelector('#pagines').textContent.match(/\d+/) || [0])[0]);
  const pdfProva = await pag.pdf({ format: 'A4', printBackground: true });
  const reals = paginesPdf(pdfProva);
  comprova('el comptador de pàgines encerta (±1)', Math.abs(estimat - reals) <= 1,
    `diu ${estimat}, en surten ${reals}`);

  /* El full s'ha d'imprimir des de qualsevol pestanya. En imprimir, les
     media queries es mesuren contra l'amplada del paper (uns 794 px), i per
     això la maquetació estreta s'activa sempre: si les seves regles amaguen
     .taula, surt un full en blanc. */
  for (const vista of ['full', 'curriculum', 'composicio']) {
    await pag.evaluate(v => { document.querySelector('#app').dataset.vista = v; }, vista);
    await pag.waitForTimeout(150);
    const cru = await pag.pdf({ format: 'A4', printBackground: true });
    comprova(`s'imprimeix amb contingut des de «${vista}»`, cru.length > 40000, cru.length);
  }
  await pag.evaluate(() => { document.querySelector('#app').dataset.vista = 'full'; });

  /* Cap interruptor pot buidar una pregunta: es prova el full amb les
     quatre combinacions d'«enunciats generals» i «figures». */
  for (const cap of [true, false]) {
    for (const fig of [true, false]) {
      await pag.evaluate(([c, f]) => {
        const e = document.querySelector('#encapcalaments');
        const g = document.querySelector('#figures');
        e.checked = c; e.dispatchEvent(new Event('change'));
        g.checked = f; g.dispatchEvent(new Event('change'));
      }, [cap, fig]);
      await pag.waitForTimeout(150);
      const buides = await pag.evaluate(() =>
        [...document.querySelectorAll('.pregunta-cos')]
          .filter(x => x.textContent.replace(/\s+/g, ' ').trim().length < 12 &&
                       !x.querySelector('svg')).length);
      comprova(`cap pregunta buida (enunciats=${cap}, figures=${fig})`, !buides, buides);
    }
  }

  /* Cap botó de la barra d'una pregunta pot quedar tapat. Amb l'espai de
     resposta a 0, la barra fa 74 px i la pregunta 21: sobresurt per sota i
     se superposa a la barra de la següent. */
  await pag.evaluate(() => {
    const s = document.querySelector('#espai');
    s.value = 0; s.dispatchEvent(new Event('input'));
  });
  await pag.waitForTimeout(250);
  let tapats = 0, botons = 0;
  const quantes = await pag.evaluate(() => document.querySelectorAll('.pregunta').length);
  for (let i = 1; i <= quantes; i++) {
    await pag.evaluate(j => document.querySelectorAll('.pregunta')[j - 1]
      .scrollIntoView({ block: 'center' }), i);
    await pag.hover(`.pregunta:nth-child(${i}) .pregunta-cos`);
    await pag.waitForTimeout(30);
    const r = await pag.evaluate(j => {
      const pr = document.querySelectorAll('.pregunta')[j - 1];
      return [...pr.querySelectorAll('.pregunta-eines button')].map(b => {
        const c = b.getBoundingClientRect();
        const d = document.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2);
        return !!d && (d === b || b.contains(d));
      });
    }, i);
    r.forEach(lliure => { botons++; if (!lliure) tapats++; });
  }
  comprova(`tots els botons de les preguntes es poden clicar (${botons})`, !tapats, tapats);
  await pag.evaluate(() => {
    const s = document.querySelector('#espai');
    s.value = 38; s.dispatchEvent(new Event('input'));
  });

  console.log('Clau i pla de repàs');
  await pag.click('[data-doc="clau"]');
  await pag.waitForTimeout(400);
  const files = await pag.evaluate(() => document.querySelectorAll('.clau-taula tbody tr').length);
  comprova('la clau té una fila per pregunta', files === despres, `${files} files, ${despres} preguntes`);

  await pag.click('[data-doc="pla"]');
  await pag.waitForTimeout(400);
  const pla = await pag.evaluate(() => {
    const txt = el => el.textContent.replace(/\s+/g, ' ').trim();
    return {
      continguts: document.querySelectorAll('.pla-saber').length,
      exercicis: [...document.querySelectorAll('.exercici-cos')].map(txt),
      solucions: document.querySelectorAll('.solucions-llista li').length,
      titol: (document.querySelector('.pla-sec h2') || {}).textContent
    };
  });
  comprova('el pla té un apartat per contingut marcat', pla.continguts === 18, pla.continguts);
  comprova('el pla porta 2 exercicis de pràctica per contingut', pla.exercicis.length === 36,
    pla.exercicis.length);
  comprova('una solució per exercici', pla.solucions === pla.exercicis.length,
    `${pla.solucions} de ${pla.exercicis.length}`);
  comprova('el títol del curs surt del currículum', pla.titol === 'Matemàtiques de 1r d\'ESO', pla.titol);

  /* La regla que importa: cap exercici de pràctica és una pregunta de la
     prova. Es compara el text tal com surt imprès. */
  await pag.click('[data-doc="prova"]');
  await pag.waitForTimeout(300);
  const textProva = await pag.evaluate(() => [...document.querySelectorAll('.pregunta-cos')]
    .map(el => el.textContent.replace(/\s+/g, ' ').trim()));
  const repetits = pla.exercicis.filter(t => textProva.includes(t));
  comprova('cap exercici de pràctica és una pregunta de la prova', !repetits.length,
    repetits.slice(0, 2).join(' | '));

  /* 3r d'ESO: el pla deia «Matemàtiques de 3eso» i no portava cap
     referència al llibre. */
  await pag.click('[data-curs="3eso"]');
  await pag.waitForTimeout(400);
  await pag.click('[data-doc="pla"]');
  await pag.waitForTimeout(400);
  const pla3 = await pag.evaluate(() => ({
    titols: [...document.querySelectorAll('.pla-sec h2')].map(h => h.textContent),
    llibre3: [...document.querySelectorAll('.font')].some(f => /Llibre de 3r d'ESO/.test(f.textContent)),
    sensePractica: [...document.querySelectorAll('.pla-saber')]
      .filter(li => li.querySelectorAll('.exercici').length !== 2)
      .map(li => li.querySelector('strong').textContent)
  }));
  /* Comprensió lectora de 1r i de 3r comparteixen els sis ítems del
     catàleg: el segon es quedava sense exercicis fins que app.js no hi va
     afegir variants noves dels generadors. */
  comprova('amb 1r i 3r marcats, cada contingut té els seus 2 exercicis',
    !pla3.sensePractica.length, pla3.sensePractica.join(', '));
  comprova('el pla de 3r es titula «Matemàtiques de 3r d\'ESO»',
    pla3.titols.includes('Matemàtiques de 3r d\'ESO'), pla3.titols.join(' / '));
  comprova('el pla de 3r remet al llibre de 3r', pla3.llibre3);
  await pag.click('[data-doc="prova"]');
  await pag.waitForTimeout(200);

  console.log('Adreça');
  /* L'adreça ha de tornar a muntar exactament el mateix full, capçalera
     inclosa. */
  await pag.fill('#alumne', 'Pau Serra');
  await pag.fill('#titol', 'Recuperació de 1r i 3r');
  await pag.evaluate(() => {
    const g = document.querySelector('#figures');
    g.checked = false; g.dispatchEvent(new Event('change'));
  });
  await pag.waitForTimeout(200);
  const full1 = await pag.evaluate(() => document.querySelector('#full').innerHTML);
  const hash = await pag.evaluate(() => location.hash);
  const pag2 = await nav.newPage({ viewport: { width: 1560, height: 1000 } });
  pag2.on('pageerror', e => errors.push('PAGEERROR (adreça) ' + e.message));
  await pag2.goto(URL_EINA + hash);
  await pag2.waitForTimeout(600);
  const full2 = await pag2.evaluate(() => document.querySelector('#full').innerHTML);
  comprova('l\'adreça reprodueix el full idèntic (capçalera i figures incloses)', full1 === full2);

  /* Una adreça retallada, editada a mà o amb ids que no existeixen no pot
     trencar la pàgina ni fer sortir preguntes buides. */
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64');
  for (const dolenta of ['#%%%', '#abc', '#' + b64([1, 2]),
    '#' + b64({ s: 'x', n: 'molts', p: '__proto__', q7: [['constructor', 'y'], 5, null, ['P', 7]],
                fx: ['__proto__'] })]) {
    const p3 = await nav.newPage();
    const errs = [];
    p3.on('pageerror', e => errs.push(e.message));
    await p3.goto(URL_EINA + dolenta);
    await p3.waitForTimeout(300);
    const r = await p3.evaluate(() => ({
      barra: !!document.querySelector('.barra'),
      undef: /undefined/.test(document.querySelector('#full').textContent)
    }));
    comprova(`una adreça mal formada no trenca res (${dolenta.slice(0, 12)}…)`,
      !errs.length && r.barra && !r.undef, errs.join(' | '));
    await p3.close();
  }

  console.log('Pantalla de portàtil');
  /* A 1280 px el full s'encongia fins a 592 px i ja no era el paper: ara
     fa sempre 210 mm i el zoom l'ajusta. */
  const petita = await nav.newPage({ viewport: { width: 1280, height: 720 } });
  await petita.goto(URL_EINA + hash);
  await petita.waitForTimeout(600);
  const mida = await petita.evaluate(() => {
    const f = document.querySelector('#full'), t = document.querySelector('.taula');
    return { ample: f.offsetWidth, sobresurt: t.scrollWidth > t.clientWidth,
             zoom: document.querySelector('#zoom-valor').textContent };
  });
  comprova('a 1280 px el full fa 210 mm (794 px) de maquetació', Math.abs(mida.ample - 794) <= 1,
    mida.ample);
  comprova('a 1280 px el zoom automàtic el fa cabre sense barra horitzontal',
    !mida.sobresurt, mida.zoom);

  comprova('cap error de JavaScript', !errors.length, errors.slice(0, 3).join(' | '));
  await nav.close();

  console.log(`\n${ok} correctes, ${ko} fallades`);
  process.exit(ko ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
