const state = {
  client: "",
  config: null,
};

const moduleHints = {
  datto_rmm: "Place Datto RMM PDF exports under data/datto_rmm.",
  prtg_monitoring: "Place PRTG PDF exports under data/prtg.",
  zoho_tickets: "Place Zoho export at data/zoho_tickets.csv.",
  sophos_fw:
    "Ensure data/SOPHOS/<client-like-folder>/ contains Applications.csv, Application Categories.csv, Web Categories.csv, Web Domains.csv.",
  datto_saas: "Place Datto SaaS offsite-backup screenshot(s) under data/datto_saas.",
};

const clientSelect = document.getElementById("clientSelect");
const loadClientBtn = document.getElementById("loadClientBtn");
const clientConfigView = document.getElementById("clientConfigView");
const moduleList = document.getElementById("moduleList");
const validateBtn = document.getElementById("validateBtn");
const validationSummary = document.getElementById("validationSummary");
const validationResults = document.getElementById("validationResults");
const generateBtn = document.getElementById("generateBtn");
const generateLog = document.getElementById("generateLog");
const loadReportDataBtn = document.getElementById("loadReportDataBtn");
const renderEditedBtn = document.getElementById("renderEditedBtn");
const reportJsonEditor = document.getElementById("reportJsonEditor");
const editLog = document.getElementById("editLog");

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let errText = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      errText = body.error || errText;
    } catch {
      // ignore
    }
    throw new Error(errText);
  }
  return res.json();
}

function renderModules() {
  moduleList.innerHTML = "";
  const modules = state?.config?.modules_to_run || [];
  if (modules.length === 0) {
    moduleList.innerHTML = `<p class="subtle">No modules configured for this client.</p>`;
    return;
  }
  for (const moduleName of modules) {
    const card = document.createElement("div");
    card.className = "module-card";
    card.innerHTML = `
      <p class="module-title">${moduleName}</p>
      <p class="module-hint">${moduleHints[moduleName] || "No guidance configured yet."}</p>
    `;
    moduleList.appendChild(card);
  }
}

function renderValidation(validation) {
  const entries = Object.entries(validation || {});
  if (entries.length === 0) {
    validationResults.innerHTML = `<p class="subtle">No validation results.</p>`;
    return;
  }
  const okCount = entries.filter(([, v]) => v.ok).length;
  validationSummary.textContent = `${okCount}/${entries.length} checks passing`;

  const wrapper = document.createElement("div");
  wrapper.className = "validation-grid";
  for (const [moduleName, result] of entries) {
    const item = document.createElement("div");
    item.className = `validation-item ${result.ok ? "ok" : "fail"}`;
    item.innerHTML = `
      <strong>${moduleName}</strong><br />
      <span>${result.detail}</span>
    `;
    wrapper.appendChild(item);
  }
  validationResults.innerHTML = "";
  validationResults.appendChild(wrapper);
}

async function loadClients() {
  const data = await fetchJson("/api/clients");
  clientSelect.innerHTML = "";
  for (const client of data.clients || []) {
    const option = document.createElement("option");
    option.value = client;
    option.textContent = client;
    clientSelect.appendChild(option);
  }
  if (data.clients?.length) {
    state.client = data.clients[0];
    clientSelect.value = state.client;
  }
}

async function loadClientConfig() {
  state.client = clientSelect.value;
  const data = await fetchJson(`/api/client-config?client=${encodeURIComponent(state.client)}`);
  state.config = data.config;
  clientConfigView.textContent = JSON.stringify(data.config, null, 2);
  renderModules();
}

async function validateInputs() {
  if (!state.client) return;
  const data = await fetchJson(`/api/validate-inputs?client=${encodeURIComponent(state.client)}`);
  renderValidation(data.validation);
}

async function generateReport() {
  if (!state.client) return;
  generateLog.textContent = "Generating report...";
  const data = await fetchJson("/api/generate-report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client: state.client }),
  });
  generateLog.textContent = [
    `ok: ${data.ok}`,
    `pdf: ${data.reportPdfPath}`,
    "",
    "stdout:",
    data.stdout || "",
    "",
    "stderr:",
    data.stderr || "",
  ].join("\n");
}

async function loadReportData() {
  const res = await fetch("/api/report-data");
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || "Unable to load report_data.json");
  }
  reportJsonEditor.value = await res.text();
}

async function renderEdited() {
  if (!state.client) return;
  editLog.textContent = "Rendering edited PDF...";
  const data = await fetchJson("/api/render-edited", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client: state.client,
      editedJson: reportJsonEditor.value,
    }),
  });
  editLog.textContent = [
    `ok: ${data.ok}`,
    `pdf: ${data.reportPdfPath}`,
    "",
    "stdout:",
    data.stdout || "",
    "",
    "stderr:",
    data.stderr || "",
  ].join("\n");
}

loadClientBtn.addEventListener("click", () => loadClientConfig().catch((e) => alert(e.message)));
validateBtn.addEventListener("click", () => validateInputs().catch((e) => alert(e.message)));
generateBtn.addEventListener("click", () => generateReport().catch((e) => alert(e.message)));
loadReportDataBtn.addEventListener("click", () => loadReportData().catch((e) => alert(e.message)));
renderEditedBtn.addEventListener("click", () => renderEdited().catch((e) => alert(e.message)));

clientSelect.addEventListener("change", () => {
  state.client = clientSelect.value;
});

async function boot() {
  await loadClients();
  if (state.client) await loadClientConfig();
}

boot().catch((e) => {
  alert(e.message);
});
