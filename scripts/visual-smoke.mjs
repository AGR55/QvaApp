import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const previewPort = 31_000 + (process.pid % 1_000);
const previewOrigin = `http://127.0.0.1:${previewPort}`;
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
          args: ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,1000"],
        },
      },
    },
  });
  sessionId = created.value.sessionId;
  await command("POST", `/session/${sessionId}/url`, { url: previewOrigin });
  const password = await find("css selector", "#dashboard-password");
  await command("POST", `/session/${sessionId}/element/${password}/value`, { text: "preview-segura-2026" });
  const submit = await find("css selector", "button[type='submit']");
  await command("POST", `/session/${sessionId}/element/${submit}/click`, {});
  await waitFor(() => execute("return document.querySelector('.app-shell') !== null"));
  await screenshot("/tmp/qvaapply-dashboard-desktop.png");
  const desktop = await metrics();
  const accessibility = await accessibilityAudit();
  if (accessibility.serious.length > 0)
    throw new Error(`WCAG: ${JSON.stringify(accessibility.serious)}`);

  const operations = await find("xpath", "//button[contains(normalize-space(.), 'Operaciones')]");
  await command("POST", `/session/${sessionId}/element/${operations}/click`, {});
  await waitFor(() => execute("return document.body.innerText.includes('Operaciones con dinero')"));
  await screenshot("/tmp/qvaapply-operations-desktop.png");

  await command("POST", `/session/${sessionId}/window/rect`, { width: 390, height: 844, x: 0, y: 0 });
  await command("POST", `/session/${sessionId}/url`, { url: previewOrigin });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await screenshot("/tmp/qvaapply-dashboard-mobile.png");
  const mobile = await metrics();
  console.log(JSON.stringify({ desktop, mobile, accessibility, screenshots: ["/tmp/qvaapply-dashboard-desktop.png", "/tmp/qvaapply-operations-desktop.png", "/tmp/qvaapply-dashboard-mobile.png"] }, null, 2));
} finally {
  if (sessionId) await command("DELETE", `/session/${sessionId}`).catch(() => undefined);
  driver.kill("SIGTERM");
  preview.kill("SIGTERM");
}

async function metrics() {
  return execute(`return {
    title: document.title,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    buttons: document.querySelectorAll('button').length,
    unlabeledIconButtons: Array.from(document.querySelectorAll('button')).filter(b => !b.textContent.trim() && !b.getAttribute('aria-label')).length,
    headings: Array.from(document.querySelectorAll('h1,h2')).map(h => h.textContent.trim()).slice(0, 12)
  }`);
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
  const result = await command("POST", `/session/${sessionId}/execute/sync`, { script, args: [] });
  return result.value;
}

async function executeAsync(script) {
  const result = await command("POST", `/session/${sessionId}/execute/async`, { script, args: [] });
  return result.value;
}

async function find(using, value) {
  const result = await command("POST", `/session/${sessionId}/element`, { using, value });
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
    } catch { /* todavía arrancando */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("ChromeDriver no inició.");
}

async function waitForPreview() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${previewOrigin}/api/session`);
      if (response.ok) return;
    } catch { /* todavía arrancando */ }
    if (preview.exitCode !== null)
      throw new Error(`El panel de prueba terminó antes de iniciar (código ${preview.exitCode}).`);
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
