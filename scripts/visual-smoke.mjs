import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const previewPort = 31_000 + (process.pid % 1_000);
const previewOrigin = `http://127.0.0.1:${previewPort}`;
const browserOrigin = `http://localhost:${previewPort}`;
const preview = spawn(process.execPath, ["scripts/preview-dashboard.mjs"], {
  env: { ...process.env, QVAAPPLY_PREVIEW_PORT: String(previewPort) },
  stdio: ["ignore", "pipe", "pipe"],
});

const driver = spawn("chromedriver", ["--port=9515", "--log-level=WARNING"], {
  stdio: ["ignore", "pipe", "pipe"],
});
const base = "http://127.0.0.1:9515";
let sessionId;
try {
  await waitForPreview();
  await waitForDriver();
  const created = await command("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "chrome",
        "goog:chromeOptions": {
          args: [
            "--headless=new",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--window-size=1440,1000",
          ],
        },
      },
    },
  });
  sessionId = created.value.sessionId;
  await command("POST", `/session/${sessionId}/url`, { url: browserOrigin });
  await execute("window.localStorage.setItem('qvaapply-theme', 'light'); return true");
  await command("POST", `/session/${sessionId}/url`, { url: browserOrigin });
  await waitFor(() =>
    execute("return document.querySelector('#dashboard-password') !== null"),
  );
  await screenshot("/tmp/qvaapply-login-desktop.png");
  const loginAccessibility = await assertPageQuality("Acceso");
  const password = await find("css selector", "#dashboard-password");
  await command("POST", `/session/${sessionId}/element/${password}/value`, {
    text: "preview-segura-2026",
  });
  const submit = await find("css selector", "button[type='submit']");
  await command("POST", `/session/${sessionId}/element/${submit}/click`, {});
  await waitFor(() =>
    execute("return document.querySelector('.app-shell') !== null"),
  );
  await waitFor(() =>
    execute("return document.querySelectorAll('.header-metrics .currency-badge').length === 4"),
  );
  await waitFor(() =>
    execute("return document.querySelector('.connection-state span')?.textContent === 'Conectado'"),
  );
  await screenshot("/tmp/qvaapply-dashboard-desktop.png");
  const desktop = await assertPageQuality("Cockpit");

  const markets = await find(
    "xpath",
    "//button[contains(normalize-space(.), 'Mercados')]",
  );
  await command("POST", `/session/${sessionId}/element/${markets}/click`, {});
  await waitFor(() =>
    execute("return document.body.innerText.includes('Libro ·')"),
  );
  await screenshot("/tmp/qvaapply-markets-desktop.png");
  const marketsDesktop = await assertPageQuality("Mercados");

  const operations = await find(
    "xpath",
    "//button[contains(normalize-space(.), 'Operaciones')]",
  );
  await command(
    "POST",
    `/session/${sessionId}/element/${operations}/click`,
    {},
  );
  await waitFor(() =>
    execute(
      "return document.body.innerText.includes('Operaciones con dinero')",
    ),
  );
  await screenshot("/tmp/qvaapply-operations-desktop.png");
  const operationsDesktop = await assertPageQuality("Operaciones");

  const hunting = await find(
    "xpath",
    "//button[contains(normalize-space(.), 'Cacería')]",
  );
  await command("POST", `/session/${sessionId}/element/${hunting}/click`, {});
  await waitFor(() =>
    execute("return document.querySelector('.hunting-stack') !== null"),
  );
  const huntSwitches = await execute(
    "return document.querySelectorAll('[role=switch]').length",
  );
  if (huntSwitches !== 6)
    throw new Error(
      `Se esperaban 6 controles de mercado y lado; aparecieron ${huntSwitches}.`,
    );
  const huntingDesktop = await assertPageQuality("Cacería");
  await screenshot("/tmp/qvaapply-hunting-desktop.png");
  await execute(
    "window.scrollTo(0, document.documentElement.scrollHeight); return true",
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  await screenshot("/tmp/qvaapply-hunting-log-desktop.png");
  const cancelCapture = await find(
    "xpath",
    "//button[normalize-space(.)='Cancelar aplicación']",
  );
  await command(
    "POST",
    `/session/${sessionId}/element/${cancelCapture}/click`,
    {},
  );
  await waitFor(() =>
    execute(
      "return document.body.innerText.includes('Cancelar esta aplicación')",
    ),
  );
  await screenshot("/tmp/qvaapply-hunting-cancel-desktop.png");
  const keepCapture = await find(
    "xpath",
    "//button[normalize-space(.)='Mantener aplicación']",
  );
  await command(
    "POST",
    `/session/${sessionId}/element/${keepCapture}/click`,
    {},
  );

  const cooperativeNetwork = await find(
    "xpath",
    "//button[contains(normalize-space(.), 'Red cooperativa')]",
  );
  await command("POST", `/session/${sessionId}/element/${cooperativeNetwork}/click`, {});
  await waitFor(() =>
    execute("return document.body.innerText.includes('Liquidez global')"),
  );
  const networkDesktop = await assertPageQuality("Red cooperativa");
  await screenshot("/tmp/qvaapply-cooperative-network-desktop.png");

  const capital = await find(
    "xpath",
    "//button[contains(normalize-space(.), 'Capital')]",
  );
  await command("POST", `/session/${sessionId}/element/${capital}/click`, {});
  await waitFor(() =>
    execute("return document.body.innerText.includes('Capital disponible')"),
  );
  const capitalDesktop = await assertPageQuality("Capital");
  const editOffer = await find(
    "xpath",
    "//button[normalize-space(.)='Editar']",
  );
  await command("POST", `/session/${sessionId}/element/${editOffer}/click`, {});
  await waitFor(() =>
    execute("return document.querySelector('.offer-workbench') !== null"),
  ).catch(async () => {
    const visibleText = await execute(
      "return document.body.innerText.slice(-1200)",
    );
    throw new Error(
      `El editor de Capital no apareció. Texto visible: ${visibleText}`,
    );
  });
  const capitalCalculation = await execute(
    `return document.querySelector('.offer-calculation')?.innerText || ''`,
  );
  if (
    !/0[.,]08/.test(capitalCalculation) ||
    !/1[.,]05/.test(capitalCalculation)
  )
    throw new Error(
      `El editor no muestra comisión y mediana de Clásica: ${capitalCalculation}`,
    );
  await screenshot("/tmp/qvaapply-capital-editor-desktop.png");
  const closeEditor = await find(
    "css selector",
    ".offer-workbench .icon-action",
  );
  await command(
    "POST",
    `/session/${sessionId}/element/${closeEditor}/click`,
    {},
  );
  const rebalance = await find(
    "xpath",
    "//button[contains(normalize-space(.), 'Reajustar capital')]",
  );
  await command("POST", `/session/${sessionId}/element/${rebalance}/click`, {});
  await waitFor(() =>
    execute("return document.body.innerText.includes('Reajustar ofertas de compra')"),
  );
  await executeAsync(`
    const done = arguments[arguments.length - 1];
    Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined)))
      .then(() => done(true));
  `);
  await screenshot("/tmp/qvaapply-capital-rebalance-desktop.png");
  const closeRebalance = await find(
    "xpath",
    "//button[@aria-label='Cerrar reajuste']",
  );
  await command("POST", `/session/${sessionId}/element/${closeRebalance}/click`, {});
  const cancelOffer = await find(
    "xpath",
    "//button[normalize-space(.)='Cancelar']",
  );
  await command(
    "POST",
    `/session/${sessionId}/element/${cancelOffer}/click`,
    {},
  );
  await waitFor(() =>
    execute("return document.body.innerText.includes('Eliminar esta oferta')"),
  );
  await screenshot("/tmp/qvaapply-capital-cancel-desktop.png");
  const keepOffer = await find(
    "xpath",
    "//button[normalize-space(.)='Conservar oferta']",
  );
  await command("POST", `/session/${sessionId}/element/${keepOffer}/click`, {});

  const charts = await find(
    "xpath",
    "//button[contains(normalize-space(.), 'Gráficas')]",
  );
  await command("POST", `/session/${sessionId}/element/${charts}/click`, {});
  await waitFor(() =>
    execute(
      "return document.body.innerText.includes('Fluctuación de precios')",
    ),
  );
  await command("POST", `/session/${sessionId}/window/rect`, {
    width: 1440,
    height: 540,
    x: 0,
    y: 0,
  });
  await execute(`window.__chartLayoutSamples = []; window.__chartLayoutFrames = 0;
    (function sample() {
      window.__chartLayoutSamples.push({
        viewport: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
        content: document.querySelector('#main-content')?.getBoundingClientRect().width || 0,
        chart: document.querySelector('.market-chart')?.getBoundingClientRect().width || 0
      });
      window.__chartLayoutFrames += 1;
      if (window.__chartLayoutFrames < 120) requestAnimationFrame(sample);
    })(); return true;`);
  const usdChart = await find(
    "xpath",
    "//button[contains(normalize-space(.), 'USD Prepago')]",
  );
  await command("POST", `/session/${sessionId}/element/${usdChart}/click`, {});
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  const chartLayoutSamples = await execute(
    "return window.__chartLayoutSamples",
  );
  const chartOverflowFrames = chartLayoutSamples.filter(
    (sample) => sample.scroll > sample.viewport,
  );
  const chartContentWidths = chartLayoutSamples.map((sample) => sample.content);
  const chartWidths = chartLayoutSamples.map((sample) => sample.chart);
  if (
    chartOverflowFrames.length ||
    Math.max(...chartContentWidths) - Math.min(...chartContentWidths) > 1 ||
    Math.min(...chartWidths) <= 0 ||
    Math.max(...chartWidths) - Math.min(...chartWidths) > 1
  )
    throw new Error(
      `Gráfica inestable durante actualización: ${JSON.stringify({ overflowFrames: chartOverflowFrames.length, minContent: Math.min(...chartContentWidths), maxContent: Math.max(...chartContentWidths), minChart: Math.min(...chartWidths), maxChart: Math.max(...chartWidths) })}`,
    );
  await command("POST", `/session/${sessionId}/window/rect`, {
    width: 1440,
    height: 1000,
    x: 0,
    y: 0,
  });
  await waitFor(() =>
    execute(
      "return document.querySelectorAll('.recharts-line-curve').length >= 2",
    ),
  );
  const chartRender = await execute(`return {
    surface: document.querySelector('.recharts-surface')?.getBoundingClientRect().toJSON(),
    axes: document.querySelectorAll('.recharts-cartesian-axis-tick').length,
    curves: Array.from(document.querySelectorAll('.recharts-line-curve')).map(path => ({
      d: path.getAttribute('d'), stroke: getComputedStyle(path).stroke,
      box: path.getBoundingClientRect().toJSON()
    }))
  }`);
  if (
    chartRender.axes === 0 ||
    chartRender.curves.some(
      (curve) => !curve.d || curve.box.width <= 0 || curve.box.height <= 0,
    )
  )
    throw new Error(
      `La gráfica no dibujó sus ejes o curvas: ${JSON.stringify(chartRender)}`,
    );
  await screenshot("/tmp/qvaapply-charts-desktop.png");
  const chartsDesktop = await assertPageQuality("Gráficas");

  const settings = await find(
    "xpath",
    "//button[contains(normalize-space(.), 'Estrategia')]",
  );
  await command("POST", `/session/${sessionId}/element/${settings}/click`, {});
  await waitFor(() =>
    execute(
      "return document.body.innerText.includes('Comportamiento del bot')",
    ),
  );
  const initialReviewAvailable = await execute(
    `return Array.from(document.querySelectorAll('button')).some(button => button.textContent.includes('Revisar y aprobar límites') && !button.disabled)`,
  );
  if (!initialReviewAvailable)
    throw new Error(
      "La aprobación inicial de límites no está disponible sin cambios artificiales.",
    );
  await screenshot("/tmp/qvaapply-settings-desktop.png");
  const settingsDesktop = await assertPageQuality("Estrategia");
  await assertSettingsCardsContained("Estrategia");
  const reviewSettings = await find(
    "xpath",
    "//button[contains(normalize-space(.), 'Revisar y aprobar límites')]",
  );
  await command(
    "POST",
    `/session/${sessionId}/element/${reviewSettings}/click`,
    {},
  );
  await waitFor(() =>
    execute("return document.body.innerText.includes('Revisa el impacto antes de activar')"),
  );
  await screenshot("/tmp/qvaapply-settings-review-desktop.png");
  const settingsReviewDesktop = await assertPageQuality("Revisión de estrategia");
  const closeSettingsReview = await find(
    "xpath",
    "//button[normalize-space(.)='Volver']",
  );
  await command(
    "POST",
    `/session/${sessionId}/element/${closeSettingsReview}/click`,
    {},
  );

  const audit = await find(
    "xpath",
    "//button[contains(normalize-space(.), 'Auditoría')]",
  );
  await command("POST", `/session/${sessionId}/element/${audit}/click`, {});
  await waitFor(() =>
    execute("return document.body.innerText.includes('Ofertas bloqueadas')"),
  );
  const auditDesktop = await assertPageQuality("Auditoría");
  await screenshot("/tmp/qvaapply-audit-desktop.png");
  const reviewBlocked = await find(
    "xpath",
    "//button[normalize-space(.)='Revisar y aplicar']",
  );
  await command(
    "POST",
    `/session/${sessionId}/element/${reviewBlocked}/click`,
    {},
  );
  await waitFor(() =>
    execute("return document.body.innerText.includes('Plan de liquidez')"),
  );
  await screenshot("/tmp/qvaapply-audit-review-desktop.png");
  const closeAuditDialog = await find(
    "css selector",
    ".decision-dialog .dialog-close",
  );
  await command(
    "POST",
    `/session/${sessionId}/element/${closeAuditDialog}/click`,
    {},
  );

  await command("POST", `/session/${sessionId}/window/rect`, {
    width: 390,
    height: 844,
    x: 0,
    y: 0,
  });
  await command("POST", `/session/${sessionId}/url`, { url: browserOrigin });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await screenshot("/tmp/qvaapply-dashboard-mobile.png");
  const mobile = { Cockpit: await assertPageQuality("Cockpit móvil") };
  const mobileMenu = await find(
    "css selector",
    "button[aria-label='Abrir navegación']",
  );
  await command("POST", `/session/${sessionId}/element/${mobileMenu}/click`, {});
  await waitFor(() =>
    execute("return document.querySelector('#mobile-navigation') !== null"),
  );
  const mobileNavigation = await execute(`return {
    panel: document.querySelector('.mobile-nav-panel')?.getBoundingClientRect().toJSON(),
    header: document.querySelector('.mobile-nav-heading')?.getBoundingClientRect().toJSON(),
    navigation: document.querySelector('#mobile-navigation')?.getBoundingClientRect().toJSON(),
    buttons: Array.from(document.querySelectorAll('#mobile-navigation button')).map(button => button.getBoundingClientRect().toJSON())
  }`);
  if (
    !mobileNavigation.panel ||
    mobileNavigation.panel.right > 391 ||
    mobileNavigation.buttons.some((button) => button.right > 391)
  )
    throw new Error(
      `La navegación móvil excede el viewport: ${JSON.stringify(mobileNavigation)}`,
    );
  await screenshot("/tmp/qvaapply-mobile-navigation.png");
  const closeMobileNavigation = await find(
    "css selector",
    "button[aria-label='Cerrar menú']",
  );
  await command("POST", `/session/${sessionId}/element/${closeMobileNavigation}/click`, {});
  const mobileViews = [
    ["Mercados", "Libro ·", "/tmp/qvaapply-markets-mobile.png"],
    ["Capital", "Capital disponible", "/tmp/qvaapply-capital-mobile.png"],
    [
      "Cacería",
      "Motor general pausado",
      "/tmp/qvaapply-hunting-mobile.png",
    ],
    [
      "Operaciones",
      "Operaciones con dinero",
      "/tmp/qvaapply-operations-mobile.png",
    ],
    [
      "Red cooperativa",
      "Liquidez global",
      "/tmp/qvaapply-cooperative-network-mobile.png",
    ],
    ["Gráficas", "Fluctuación de precios", "/tmp/qvaapply-charts-mobile.png"],
    [
      "Estrategia",
      "Comportamiento del bot",
      "/tmp/qvaapply-settings-mobile.png",
    ],
    ["Auditoría", "Ofertas bloqueadas", "/tmp/qvaapply-audit-mobile.png"],
  ];
  for (const [navLabel, visibleText, imagePath] of mobileViews) {
    const mobileMenu = await find(
      "xpath",
      "//button[contains(normalize-space(.), 'Secciones')]",
    );
    await command("POST", `/session/${sessionId}/element/${mobileMenu}/click`, {});
    const navigationButton = await find(
      "xpath",
      `//nav[@id='mobile-navigation']//button[contains(normalize-space(.), '${navLabel}')]`,
    );
    await command(
      "POST",
      `/session/${sessionId}/element/${navigationButton}/click`,
      {},
    );
    await waitFor(() =>
      execute(
        `return document.body.innerText.includes(${JSON.stringify(visibleText)})`,
      ),
    );
    if (navLabel === "Gráficas")
      await waitFor(() =>
        execute("return document.querySelectorAll('.recharts-line-curve').length >= 2"),
      );
    await screenshot(imagePath);
    mobile[navLabel] = await assertPageQuality(`${navLabel} móvil`);
    if (navLabel === "Capital") {
      const mobileRebalance = await find(
        "xpath",
        "//button[contains(normalize-space(.), 'Reajustar capital')]",
      );
      await command("POST", `/session/${sessionId}/element/${mobileRebalance}/click`, {});
      await waitFor(() =>
        execute("return document.querySelector('.rebalance-dialog') !== null"),
      );
      const rebalanceLayout = await execute(`return (() => {
        const dialog = document.querySelector('.rebalance-dialog');
        return {
          clientWidth: dialog?.clientWidth,
          scrollWidth: dialog?.scrollWidth,
          viewport: document.documentElement.clientWidth,
          bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
        };
      })()`);
      if (
        rebalanceLayout.scrollWidth > rebalanceLayout.clientWidth + 1 ||
        rebalanceLayout.bodyOverflow
      )
        throw new Error(`El reajuste móvil desborda: ${JSON.stringify(rebalanceLayout)}`);
      await screenshot("/tmp/qvaapply-capital-rebalance-mobile.png");
      const closeMobileRebalance = await find(
        "css selector",
        "button[aria-label='Cerrar reajuste']",
      );
      await command("POST", `/session/${sessionId}/element/${closeMobileRebalance}/click`, {});
    }
    if (navLabel === "Estrategia")
      await assertSettingsCardsContained("Estrategia móvil");
  }
  console.log(
    JSON.stringify(
      {
        loginAccessibility,
        chartRender,
        desktop: {
          Cockpit: desktop,
          Mercados: marketsDesktop,
          Operaciones: operationsDesktop,
          Cacería: huntingDesktop,
          "Red cooperativa": networkDesktop,
          Capital: capitalDesktop,
          Gráficas: chartsDesktop,
          Estrategia: settingsDesktop,
          "Revisión de estrategia": settingsReviewDesktop,
          Auditoría: auditDesktop,
        },
        mobile,
        screenshots: [
          "/tmp/qvaapply-login-desktop.png",
          "/tmp/qvaapply-dashboard-desktop.png",
          "/tmp/qvaapply-markets-desktop.png",
          "/tmp/qvaapply-operations-desktop.png",
          "/tmp/qvaapply-hunting-desktop.png",
          "/tmp/qvaapply-hunting-log-desktop.png",
          "/tmp/qvaapply-hunting-cancel-desktop.png",
          "/tmp/qvaapply-cooperative-network-desktop.png",
          "/tmp/qvaapply-capital-editor-desktop.png",
          "/tmp/qvaapply-capital-cancel-desktop.png",
          "/tmp/qvaapply-charts-desktop.png",
          "/tmp/qvaapply-settings-desktop.png",
          "/tmp/qvaapply-settings-review-desktop.png",
          "/tmp/qvaapply-audit-desktop.png",
          "/tmp/qvaapply-audit-review-desktop.png",
          "/tmp/qvaapply-dashboard-mobile.png",
          "/tmp/qvaapply-mobile-navigation.png",
          "/tmp/qvaapply-capital-rebalance-mobile.png",
          ...mobileViews.map(([, , path]) => path),
        ],
      },
      null,
      2,
    ),
  );
} finally {
  if (sessionId)
    await command("DELETE", `/session/${sessionId}`).catch(() => undefined);
  driver.kill("SIGTERM");
  preview.kill("SIGTERM");
}

async function metrics() {
  return execute(`return {
    title: document.title,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflowers: Array.from(document.querySelectorAll('body *')).map(element => ({
      element: element.tagName.toLowerCase() + (element.className && typeof element.className === 'string' ? '.' + element.className.trim().replace(/\\s+/g, '.') : ''),
      left: Math.round(element.getBoundingClientRect().left),
      right: Math.round(element.getBoundingClientRect().right),
      width: Math.round(element.getBoundingClientRect().width),
      scrollWidth: element.scrollWidth
    })).filter(item => item.right > document.documentElement.clientWidth + 1 || item.left < -1).slice(0, 12),
    buttons: document.querySelectorAll('button').length,
    unlabeledIconButtons: Array.from(document.querySelectorAll('button')).filter(b => !b.textContent.trim() && !b.getAttribute('aria-label')).length,
    headings: Array.from(document.querySelectorAll('h1,h2')).map(h => h.textContent.trim()).slice(0, 12)
  }`);
}

async function assertPageQuality(name) {
  await executeAsync(`
    const done = arguments[arguments.length - 1];
    Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined)))
      .then(() => done(true));
  `);
  const pageMetrics = await metrics();
  if (pageMetrics.horizontalOverflow)
    throw new Error(
      `${name} desborda horizontalmente: ${JSON.stringify(pageMetrics)}`,
    );
  const accessibility = await accessibilityAudit();
  if (accessibility.serious.length > 0)
    throw new Error(`WCAG ${name}: ${JSON.stringify(accessibility.serious)}`);
  return { ...pageMetrics, accessibility };
}

async function assertSettingsCardsContained(name) {
  const layout = await execute(`return {
    visibleNativeFileInputs: Array.from(document.querySelectorAll('.market-settings input[type=file]'))
      .filter(input => input.getBoundingClientRect().width > 2 || input.getBoundingClientRect().height > 2)
      .length,
    cards: Array.from(document.querySelectorAll('.market-settings')).map(card => ({
      label: card.querySelector('legend')?.textContent?.trim(),
      clientWidth: card.clientWidth,
      scrollWidth: card.scrollWidth
    }))
  }`);
  const overflowing = layout.cards.filter(
    (card) => card.scrollWidth > card.clientWidth + 1,
  );
  if (layout.visibleNativeFileInputs || overflowing.length)
    throw new Error(
      `${name} contiene controles fuera de sus tarjetas: ${JSON.stringify(layout)}`,
    );
}

async function accessibilityAudit() {
  await execute(axeSource);
  const result = await executeAsync(`
    const done = arguments[arguments.length - 1];
    axe.run(document, { resultTypes: ['violations'] })
      .then(result => done({
        total: result.violations.length,
        serious: result.violations
          .filter(item => item.impact === 'serious' || item.impact === 'critical')
          .map(item => ({
            id: item.id,
            impact: item.impact,
            nodes: item.nodes.length,
            targets: item.nodes.slice(0, 8).map(node => ({
              target: node.target,
              html: node.html,
              summary: node.failureSummary
            }))
          }))
      }))
      .catch(error => done({ total: -1, serious: [{ id: String(error), impact: 'critical', nodes: 0 }] }));
  `);
  return result;
}

async function screenshot(path) {
  const result = await command("GET", `/session/${sessionId}/screenshot`);
  writeFileSync(path, Buffer.from(result.value, "base64"));
}

async function execute(script) {
  const result = await command("POST", `/session/${sessionId}/execute/sync`, {
    script,
    args: [],
  });
  return result.value;
}

async function executeAsync(script) {
  const result = await command("POST", `/session/${sessionId}/execute/async`, {
    script,
    args: [],
  });
  return result.value;
}

async function find(using, value) {
  const result = await command("POST", `/session/${sessionId}/element`, {
    using,
    value,
  });
  return result.value["element-6066-11e4-a52e-4f735466cecf"];
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("La interfaz no alcanzó el estado esperado.");
}

async function waitForDriver() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${base}/status`);
      if (response.ok) return;
    } catch {
      /* todavía arrancando */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("ChromeDriver no inició.");
}

async function waitForPreview() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${previewOrigin}/api/session`);
      if (response.ok) return;
    } catch {
      /* todavía arrancando */
    }
    if (preview.exitCode !== null)
      throw new Error(
        `El panel de prueba terminó antes de iniciar (código ${preview.exitCode}).`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("El panel de prueba no inició.");
}

async function command(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!response.ok || payload.value?.error)
    throw new Error(payload.value?.message || `WebDriver ${response.status}`);
  return payload;
}
