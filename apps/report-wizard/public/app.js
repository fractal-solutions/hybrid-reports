const state = {
  client: "",
  config: null,
  supportedModules: [],
};

const moduleHints = {
  datto_rmm: "Upload all 5 required PDFs for this client.",
  prtg_monitoring: "Upload the single PRTG PDF for this client.",
  zoho_tickets: "Upload the shared zoho_tickets.csv (used across clients).",
  sophos_fw: "Upload 4 Sophos CSV files for this client folder.",
  datto_saas: "Upload a Datto SaaS dashboard screenshot for this client.",
};

const moduleTooltips = {
  datto_rmm:
    "Source: Datto RMM portal -> Reports. Export these 5 PDFs for the client/site: Device Health Summary, Device Storage, Executive Summary, Hardware Lifecycle, Patch Management Summary.",
  prtg_monitoring:
    "Source: PRTG web console -> Reports. Export the client's monthly report as a single PDF and upload here.",
  zoho_tickets:
    "Source: Zoho Desk/Tickets export. Download CSV and upload as zoho_tickets.csv. This file is shared across clients.",
  sophos_fw:
    "Source: Sophos Firewall reports export. Upload 4 CSVs: Applications.csv, Application Categories.csv, Web Categories.csv, Web Domains.csv.",
  datto_saas:
    "Source: Datto SaaS dashboard. Capture/upload the offsite-backup screenshot for the selected client.",
};

const moduleUploadSlots = {
  zoho_tickets: [{ slot: "zoho_tickets_csv", label: "Zoho Tickets CSV", accept: ".csv" }],
  datto_rmm: [
    { slot: "device_health_summary", label: "Device Health Summary PDF", accept: ".pdf" },
    { slot: "device_storage", label: "Device Storage PDF", accept: ".pdf" },
    { slot: "executive_summary", label: "Executive Summary PDF", accept: ".pdf" },
    { slot: "hardware_lifecycle", label: "Hardware Lifecycle PDF", accept: ".pdf" },
    { slot: "patch_management_summary", label: "Patch Management Summary PDF", accept: ".pdf" },
  ],
  prtg_monitoring: [{ slot: "prtg_pdf", label: "PRTG PDF", accept: ".pdf" }],
  datto_saas: [{ slot: "saas_screenshot", label: "Datto SaaS Screenshot", accept: ".png,.jpg,.jpeg,.webp,.bmp" }],
  sophos_fw: [
    { slot: "applications", label: "Applications.csv", accept: ".csv" },
    { slot: "application_categories", label: "Application Categories.csv", accept: ".csv" },
    { slot: "web_categories", label: "Web Categories.csv", accept: ".csv" },
    { slot: "web_domains", label: "Web Domains.csv", accept: ".csv" },
  ],
};

const clientSelect = document.getElementById("clientSelect");
const loadClientBtn = document.getElementById("loadClientBtn");
const clientConfigView = document.getElementById("clientConfigView");
const moduleList = document.getElementById("moduleList");
const validateBtn = document.getElementById("validateBtn");
const validationSummary = document.getElementById("validationSummary");
const validationResults = document.getElementById("validationResults");
const generateBtn = document.getElementById("generateBtn");
const downloadGeneratedBtn = document.getElementById("downloadGeneratedBtn");
const generateLog = document.getElementById("generateLog");
const loadReportDataBtn = document.getElementById("loadReportDataBtn");
const renderEditedBtn = document.getElementById("renderEditedBtn");
const downloadEditedBtn = document.getElementById("downloadEditedBtn");
const reportJsonEditor = document.getElementById("reportJsonEditor");
const jsonLineNumbers = document.getElementById("jsonLineNumbers");
const editLog = document.getElementById("editLog");
const jsonValidationStatus = document.getElementById("jsonValidationStatus");
const reportPeriodInput = document.getElementById("reportPeriodInput");
const moduleCheckboxes = document.getElementById("moduleCheckboxes");
const saveConfigBtn = document.getElementById("saveConfigBtn");
const saveConfigStatus = document.getElementById("saveConfigStatus");
let latestGeneratedPdfPath = "";
let latestEditedPdfPath = "";

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

function getSelectedModulesFromUi() {
  const checked = [];
  const inputs = moduleCheckboxes.querySelectorAll("input[type=checkbox]");
  for (const input of inputs) {
    if (input.checked) checked.push(input.value);
  }
  return checked;
}

function renderModuleCheckboxes() {
  moduleCheckboxes.innerHTML = "";
  const active = new Set(state?.config?.modules_to_run || []);
  const modules = state.supportedModules || [];
  for (const moduleName of modules) {
    const row = document.createElement("label");
    row.className = "checkbox-item";
    row.innerHTML = `
      <input type="checkbox" value="${moduleName}" ${active.has(moduleName) ? "checked" : ""} />
      <span>${moduleName}</span>
    `;
    moduleCheckboxes.appendChild(row);
  }
}

function createUploadSlotElement(moduleName, slotDef) {
  const wrap = document.createElement("div");
  wrap.className = "upload-slot";

  const statusId = `status-${moduleName}-${slotDef.slot}`;
  const inputId = `input-${moduleName}-${slotDef.slot}`;

  wrap.innerHTML = `
    <p class="slot-title">${slotDef.label}</p>
    <div class="dropzone" id="dz-${moduleName}-${slotDef.slot}">Drag & drop or click to upload</div>
    <input id="${inputId}" type="file" accept="${slotDef.accept || ""}" style="display:none" />
    <div id="${statusId}" class="slot-status">Awaiting file...</div>
  `;

  const dropzone = wrap.querySelector(".dropzone");
  const input = wrap.querySelector(`#${CSS.escape(inputId)}`);
  const status = wrap.querySelector(`#${CSS.escape(statusId)}`);

  const updateStatus = (message, level = "") => {
    status.textContent = message;
    status.classList.remove("ok", "fail");
    if (level) status.classList.add(level);
  };

  const uploadOne = async (file) => {
    if (!state.client) {
      updateStatus("Load a client first.", "fail");
      return;
    }
    updateStatus(`Uploading ${file.name}...`);
    const formData = new FormData();
    formData.append("client", state.client);
    formData.append("module", moduleName);
    formData.append("slot", slotDef.slot);
    formData.append("file", file);
    try {
      const res = await fetchJson("/api/upload-module-file", {
        method: "POST",
        body: formData,
      });
      updateStatus(`Saved as ${res.storedPath}`, "ok");
      if (moduleName === "zoho_tickets" && slotDef.slot === "zoho_tickets_csv") {
        await refreshZohoStatus(updateStatus);
      }
    } catch (error) {
      updateStatus(error.message, "fail");
    }
  };

  dropzone.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    if (input.files && input.files[0]) uploadOne(input.files[0]);
    input.value = "";
  });

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("active");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("active");
  });

  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("active");
    const file = e.dataTransfer?.files?.[0];
    if (file) uploadOne(file);
  });

  if (moduleName === "zoho_tickets" && slotDef.slot === "zoho_tickets_csv") {
    refreshZohoStatus(updateStatus).catch(() => {
      updateStatus("Could not read existing zoho_tickets.csv status.", "fail");
    });
  }

  return wrap;
}

async function refreshZohoStatus(updateStatus) {
  if (!state.client) return;
  const status = await fetchJson(
    `/api/zoho-tickets-status?client=${encodeURIComponent(state.client)}`
  );
  if (status.exists) {
    updateStatus(
      `Existing file: ${status.path} | Last modified: ${status.lastModifiedDisplay}`,
      "ok"
    );
  } else {
    updateStatus(`No existing file found at ${status.path}`);
  }
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
      <div class="module-card-head">
        <p class="module-title">${moduleName}</p>
        <div class="help-wrap">
          <button type="button" class="help-btn" aria-label="How to get ${moduleName} files">?</button>
          <div class="help-tip"></div>
        </div>
      </div>
      <p class="module-hint">${moduleHints[moduleName] || "No guidance configured yet."}</p>
      <div class="upload-grid" id="upload-grid-${moduleName}"></div>
    `;
    moduleList.appendChild(card);

    const helpTip = card.querySelector(".help-tip");
    if (helpTip) {
      helpTip.textContent = moduleTooltips[moduleName] || "Upload the required files for this module.";
    }

    const grid = card.querySelector(`#${CSS.escape(`upload-grid-${moduleName}`)}`);
    const slots = moduleUploadSlots[moduleName] || [];
    for (const slotDef of slots) {
      grid.appendChild(createUploadSlotElement(moduleName, slotDef));
    }
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
  state.supportedModules = data.supportedModules || [];
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
  saveConfigStatus.textContent = "";
  const data = await fetchJson(`/api/client-config?client=${encodeURIComponent(state.client)}`);
  state.config = data.config;
  state.supportedModules = data.supportedModules || state.supportedModules;
  reportPeriodInput.value = state.config.report_period || "";
  clientConfigView.textContent = JSON.stringify(data.config, null, 2);
  renderModuleCheckboxes();
  renderModules();
}

async function saveClientConfig() {
  if (!state.client || !state.config) return;
  saveConfigStatus.textContent = "Saving...";
  const payload = {
    client: state.client,
    report_period: reportPeriodInput.value.trim(),
    modules_to_run: getSelectedModulesFromUi(),
  };
  const data = await fetchJson("/api/client-config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  state.config = data.config;
  clientConfigView.textContent = JSON.stringify(data.config, null, 2);
  renderModules();
  saveConfigStatus.textContent = "Saved.";
}

async function validateInputs() {
  if (!state.client) return;
  const data = await fetchJson(`/api/validate-inputs?client=${encodeURIComponent(state.client)}`);
  renderValidation(data.validation);
}

async function generateReport() {
  if (!state.client) return;
  downloadGeneratedBtn.disabled = true;
  latestGeneratedPdfPath = "";
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
  if (data.ok && data.reportPdfPath) {
    latestGeneratedPdfPath = data.reportPdfPath;
    downloadGeneratedBtn.disabled = false;
  }
}

async function loadReportData() {
  const res = await fetch("/api/report-data");
  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || "Unable to load report_data.json");
  }
  reportJsonEditor.value = await res.text();
  updateLineNumbers();
  validateJsonEditor();
}

async function renderEdited() {
  if (!state.client) return;
  if (!validateJsonEditor()) return;
  downloadEditedBtn.disabled = true;
  latestEditedPdfPath = "";
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
  if (data.ok && data.reportPdfPath) {
    latestEditedPdfPath = data.reportPdfPath;
    downloadEditedBtn.disabled = false;
  }
}

loadClientBtn.addEventListener("click", () => loadClientConfig().catch((e) => alert(e.message)));
saveConfigBtn.addEventListener("click", () => saveClientConfig().catch((e) => alert(e.message)));
validateBtn.addEventListener("click", () => validateInputs().catch((e) => alert(e.message)));
generateBtn.addEventListener("click", () => generateReport().catch((e) => alert(e.message)));
loadReportDataBtn.addEventListener("click", () => loadReportData().catch((e) => alert(e.message)));
renderEditedBtn.addEventListener("click", () => renderEdited().catch((e) => alert(e.message)));
downloadGeneratedBtn.addEventListener("click", () => {
  if (!latestGeneratedPdfPath) return;
  window.location.href = `/api/download-report?path=${encodeURIComponent(latestGeneratedPdfPath)}`;
});
downloadEditedBtn.addEventListener("click", () => {
  if (!latestEditedPdfPath) return;
  window.location.href = `/api/download-report?path=${encodeURIComponent(latestEditedPdfPath)}`;
});

clientSelect.addEventListener("change", () => {
  state.client = clientSelect.value;
  loadClientConfig().catch((e) => alert(e.message));
});

async function boot() {
  await loadClients();
  if (state.client) await loadClientConfig();
  renderEditedBtn.disabled = true;
  downloadGeneratedBtn.disabled = true;
  downloadEditedBtn.disabled = true;
  updateLineNumbers();
}

boot().catch((e) => {
  alert(e.message);
});

function setJsonValidationState(kind, message) {
  jsonValidationStatus.classList.remove("neutral", "valid", "invalid");
  jsonValidationStatus.classList.add(kind);
  jsonValidationStatus.textContent = message;
  reportJsonEditor.classList.remove("json-valid", "json-invalid");
  if (kind === "valid") reportJsonEditor.classList.add("json-valid");
  if (kind === "invalid") reportJsonEditor.classList.add("json-invalid");
}

function validateJsonEditor() {
  const raw = reportJsonEditor.value.trim();
  if (!raw) {
    setJsonValidationState("invalid", "JSON is empty.");
    renderEditedBtn.disabled = true;
    return false;
  }
  try {
    JSON.parse(raw);
    setJsonValidationState("valid", "JSON is valid.");
    renderEditedBtn.disabled = false;
    return true;
  } catch (error) {
    setJsonValidationState("invalid", `Invalid JSON: ${error.message}`);
    renderEditedBtn.disabled = true;
    return false;
  }
}

reportJsonEditor.addEventListener("input", () => {
  updateLineNumbers();
  validateJsonEditor();
});

reportJsonEditor.addEventListener("scroll", () => {
  jsonLineNumbers.style.transform = `translateY(-${reportJsonEditor.scrollTop}px)`;
});

function updateLineNumbers() {
  const lineCount = Math.max(1, reportJsonEditor.value.split("\n").length);
  let numbers = "";
  for (let i = 1; i <= lineCount; i++) {
    numbers += i === lineCount ? `${i}` : `${i}\n`;
  }
  jsonLineNumbers.textContent = numbers;
  jsonLineNumbers.style.transform = `translateY(-${reportJsonEditor.scrollTop}px)`;
}
