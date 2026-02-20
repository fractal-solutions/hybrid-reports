import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, "apps", "report-wizard", "public");
const CONFIG_DIR = path.join(ROOT, "config");
const SUPPORTED_MODULES = [
  "datto_rmm",
  "zoho_tickets",
  "prtg_monitoring",
  "sophos_fw",
  "datto_saas",
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function sanitizeClientId(clientId) {
  return String(clientId || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function sanitizeForFile(value) {
  return String(value || "").replace(/[^a-zA-Z0-9]/g, "_");
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function listConfigClients() {
  if (!fileExists(CONFIG_DIR)) return [];
  return fs
    .readdirSync(CONFIG_DIR)
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .map((f) => path.basename(f, ".json"))
    .sort((a, b) => a.localeCompare(b));
}

function getClientConfigPath(clientId) {
  const safeId = sanitizeClientId(clientId);
  return path.join(CONFIG_DIR, `${safeId}.json`);
}

function readClientConfig(clientId) {
  const configPath = getClientConfigPath(clientId);
  if (!fileExists(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

function writeClientConfig(clientId, config) {
  const configPath = getClientConfigPath(clientId);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function tokenize(value) {
  return (value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

function matchScore(clientName, folderName) {
  const c = tokenize(clientName);
  const f = tokenize(folderName);
  if (!c.length || !f.length) return 0;
  let matched = 0;
  for (const token of c) {
    if (f.includes(token)) matched += 1;
  }
  return matched / c.length;
}

function normalizeCompact(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isClientSpecificFile(fileName, clientName) {
  const score = matchScore(clientName, fileName);
  if (score >= 0.6) return true;

  const compactClient = normalizeCompact(clientName);
  const compactFile = normalizeCompact(fileName);
  if (!compactClient || !compactFile) return false;
  return compactFile.includes(compactClient) || compactClient.includes(compactFile);
}

function findBestClientFolder(baseDir, clientName) {
  if (!fileExists(baseDir)) return null;
  const dirs = fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  if (!dirs.length) return null;

  let best = null;
  let bestScore = -1;
  for (const dirName of dirs) {
    const score = matchScore(clientName, dirName);
    if (score > bestScore) {
      bestScore = score;
      best = dirName;
    }
  }
  if (bestScore < 0.2) return null;
  return path.join(baseDir, best);
}

function validateInputs(config) {
  const dataDirName = config.data_directory || "data";
  const dataDir = path.resolve(ROOT, dataDirName);
  const modules = Array.isArray(config.modules_to_run) ? config.modules_to_run : [];
  const result = {};

  for (const moduleName of modules) {
    if (moduleName === "datto_rmm") {
      const dir = path.join(dataDir, "datto_rmm");
      const typeRules = [
        { label: "Device Health Summary", needle: "device health summary" },
        { label: "Device Storage", needle: "device storage" },
        { label: "Executive Summary", needle: "executive summary" },
        { label: "Hardware Lifecycle", needle: "hardware lifecycle" },
        { label: "Patch Management Summary", needle: "patch management summary" },
      ];
      const pdfFiles = fileExists(dir)
        ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"))
        : [];
      const clientPdfFiles = pdfFiles.filter((f) => isClientSpecificFile(f, config.client_name));

      const missing = [];
      for (const rule of typeRules) {
        const hasType = clientPdfFiles.some((f) => f.toLowerCase().includes(rule.needle));
        if (!hasType) missing.push(rule.label);
      }

      result[moduleName] = {
        ok: missing.length === 0,
        detail:
          missing.length === 0
            ? "Found 5/5 required client PDFs in data/datto_rmm"
            : `Found ${5 - missing.length}/5 client PDFs. Missing: ${missing.join(", ")}`,
      };
      continue;
    }

    if (moduleName === "prtg_monitoring") {
      const dir = path.join(dataDir, "prtg");
      const pdfFiles = fileExists(dir)
        ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"))
        : [];
      const clientPdfFiles = pdfFiles.filter(
        (f) => f.toLowerCase().includes("prtg") && isClientSpecificFile(f, config.client_name)
      );
      result[moduleName] = {
        ok: clientPdfFiles.length > 0,
        detail:
          clientPdfFiles.length > 0
            ? `${clientPdfFiles.length} client-specific PRTG PDF(s) found in data/prtg`
            : "No client-specific PRTG PDF found in data/prtg",
      };
      continue;
    }

    if (moduleName === "zoho_tickets") {
      const csvPath = path.join(dataDir, "zoho_tickets.csv");
      result[moduleName] = {
        ok: fileExists(csvPath),
        detail: fileExists(csvPath)
          ? "Found data/zoho_tickets.csv"
          : "Missing data/zoho_tickets.csv",
      };
      continue;
    }

    if (moduleName === "sophos_fw") {
      const sophosBase = path.join(dataDir, "SOPHOS");
      const folder = findBestClientFolder(sophosBase, config.client_name);
      const required = [
        "Applications.csv",
        "Application Categories.csv",
        "Web Categories.csv",
        "Web Domains.csv",
      ];
      const missing = [];
      if (!folder) {
        result[moduleName] = {
          ok: false,
          detail: "No client-matching folder found under data/SOPHOS",
        };
      } else {
        for (const fileName of required) {
          const full = path.join(folder, fileName);
          if (!fileExists(full)) missing.push(fileName);
        }
        result[moduleName] = {
          ok: missing.length === 0,
          detail:
            missing.length === 0
              ? `Found required CSVs in ${path.basename(folder)}`
              : `Missing in ${path.basename(folder)}: ${missing.join(", ")}`,
        };
      }
      continue;
    }

    if (moduleName === "datto_saas") {
      const dir = path.join(dataDir, "datto_saas");
      const imageFiles = fileExists(dir)
        ? fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp|bmp)$/i.test(f))
        : [];
      const clientImages = imageFiles.filter((f) => isClientSpecificFile(f, config.client_name));
      result[moduleName] = {
        ok: clientImages.length > 0,
        detail:
          clientImages.length > 0
            ? `${clientImages.length} client-specific screenshot(s) found in data/datto_saas`
            : "No client-specific screenshot found in data/datto_saas",
      };
      continue;
    }

    result[moduleName] = {
      ok: true,
      detail: "No validator configured for this module yet.",
    };
  }

  return result;
}

async function runCommand(cmd) {
  const proc = Bun.spawn({
    cmd,
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

function resolveDataDir(config) {
  return path.resolve(ROOT, config.data_directory || "data");
}

function getZohoTicketsFileStatus(config) {
  const dataDir = resolveDataDir(config);
  const filePath = path.join(dataDir, "zoho_tickets.csv");
  if (!fileExists(filePath)) {
    return {
      exists: false,
      path: path.relative(ROOT, filePath).replace(/\\/g, "/"),
      lastModifiedIso: null,
      lastModifiedDisplay: null,
    };
  }

  const stats = fs.statSync(filePath);
  return {
    exists: true,
    path: path.relative(ROOT, filePath).replace(/\\/g, "/"),
    lastModifiedIso: stats.mtime.toISOString(),
    lastModifiedDisplay: stats.mtime.toLocaleString(),
  };
}

function ensureExt(originalName, fallbackExt) {
  const ext = path.extname(originalName || "").toLowerCase();
  return ext || fallbackExt;
}

async function saveUploadedFile(file, destinationPath) {
  const bytes = Buffer.from(await file.arrayBuffer());
  ensureDir(path.dirname(destinationPath));
  fs.writeFileSync(destinationPath, bytes);
}

async function storeModuleUpload(clientConfig, moduleName, slot, file) {
  if (!file || typeof file.name !== "string") {
    throw new Error("Invalid file payload.");
  }
  const dataDir = resolveDataDir(clientConfig);
  const clientLabel = sanitizeForFile(clientConfig.client_name);

  if (moduleName === "zoho_tickets") {
    const target = path.join(dataDir, "zoho_tickets.csv");
    await saveUploadedFile(file, target);
    return path.relative(ROOT, target).replace(/\\/g, "/");
  }

  if (moduleName === "datto_rmm") {
    const map = {
      device_health_summary: "Device Health Summary",
      device_storage: "Device Storage",
      executive_summary: "Executive Summary",
      hardware_lifecycle: "Hardware Lifecycle",
      patch_management_summary: "Patch Management Summary",
    };
    const prefix = map[slot];
    if (!prefix) throw new Error(`Unknown Datto RMM slot: ${slot}`);
    const target = path.join(dataDir, "datto_rmm", `${prefix} - ${clientLabel}.pdf`);
    await saveUploadedFile(file, target);
    return path.relative(ROOT, target).replace(/\\/g, "/");
  }

  if (moduleName === "prtg_monitoring") {
    const target = path.join(dataDir, "prtg", `PRTG Report - ${clientLabel}.pdf`);
    await saveUploadedFile(file, target);
    return path.relative(ROOT, target).replace(/\\/g, "/");
  }

  if (moduleName === "datto_saas") {
    const ext = ensureExt(file.name, ".png");
    const target = path.join(dataDir, "datto_saas", `Datto SaaS - ${clientLabel}${ext}`);
    await saveUploadedFile(file, target);
    return path.relative(ROOT, target).replace(/\\/g, "/");
  }

  if (moduleName === "sophos_fw") {
    const slotMap = {
      applications: "Applications.csv",
      application_categories: "Application Categories.csv",
      web_categories: "Web Categories.csv",
      web_domains: "Web Domains.csv",
    };
    const fileName = slotMap[slot];
    if (!fileName) throw new Error(`Unknown Sophos slot: ${slot}`);
    const folder = path.join(dataDir, "SOPHOS", `${clientLabel}-Sophos-FW`);
    const target = path.join(folder, fileName);
    await saveUploadedFile(file, target);
    return path.relative(ROOT, target).replace(/\\/g, "/");
  }

  throw new Error(`Upload mapping not defined for module: ${moduleName}`);
}

async function handleApi(request, pathname) {
  if (pathname === "/api/clients" && request.method === "GET") {
    return json({ clients: listConfigClients(), supportedModules: SUPPORTED_MODULES });
  }

  if (pathname === "/api/client-config" && request.method === "GET") {
    const url = new URL(request.url);
    const client = url.searchParams.get("client");
    const config = readClientConfig(client);
    if (!config) return json({ error: "Client config not found." }, 404);
    return json({ client, config, supportedModules: SUPPORTED_MODULES });
  }

  if (pathname === "/api/client-config" && request.method === "POST") {
    const body = await request.json();
    const client = sanitizeClientId(body?.client);
    if (!client) return json({ error: "Missing client." }, 400);
    const config = readClientConfig(client);
    if (!config) return json({ error: "Client config not found." }, 404);

    const reportPeriod = String(body?.report_period || "").trim();
    const modules = Array.isArray(body?.modules_to_run)
      ? body.modules_to_run.filter((m) => SUPPORTED_MODULES.includes(m))
      : [];
    if (!reportPeriod) return json({ error: "report_period is required." }, 400);
    if (modules.length === 0) return json({ error: "At least one module must be selected." }, 400);

    config.report_period = reportPeriod;
    config.modules_to_run = modules;
    writeClientConfig(client, config);
    return json({ ok: true, config });
  }

  if (pathname === "/api/upload-module-file" && request.method === "POST") {
    const form = await request.formData();
    const client = sanitizeClientId(form.get("client"));
    const moduleName = String(form.get("module") || "");
    const slot = String(form.get("slot") || "");
    const file = form.get("file");
    if (!client || !moduleName || !slot || !file) {
      return json({ error: "Missing upload params: client/module/slot/file." }, 400);
    }

    const config = readClientConfig(client);
    if (!config) return json({ error: "Client config not found." }, 404);

    if (!SUPPORTED_MODULES.includes(moduleName)) {
      return json({ error: `Unsupported module: ${moduleName}` }, 400);
    }

    const storedPath = await storeModuleUpload(config, moduleName, slot, file);
    return json({
      ok: true,
      storedPath,
      module: moduleName,
      slot,
      originalName: file.name,
    });
  }

  if (pathname === "/api/zoho-tickets-status" && request.method === "GET") {
    const url = new URL(request.url);
    const client = url.searchParams.get("client");
    const config = readClientConfig(client);
    if (!config) return json({ error: "Client config not found." }, 404);
    return json(getZohoTicketsFileStatus(config));
  }

  if (pathname === "/api/validate-inputs" && request.method === "GET") {
    const url = new URL(request.url);
    const client = url.searchParams.get("client");
    const config = readClientConfig(client);
    if (!config) return json({ error: "Client config not found." }, 404);
    return json({
      client,
      validation: validateInputs(config),
    });
  }

  if (pathname === "/api/generate-report" && request.method === "POST") {
    const body = await request.json();
    const client = sanitizeClientId(body?.client);
    if (!client) return json({ error: "Missing client." }, 400);

    const config = readClientConfig(client);
    if (!config) return json({ error: "Client config not found." }, 404);

    const run = await runCommand(["bun", "src/index.js", `--client=${client}`]);
    const safeClientName = sanitizeForFile(config.client_name);
    const safePeriod = sanitizeForFile(config.report_period);
    const pdfPath = path.join("reports", `${safeClientName}-${safePeriod}-Monthly_Report.pdf`);

    return json({
      ok: run.exitCode === 0,
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
      reportDataPath: "report_data.json",
      reportPdfPath: pdfPath,
    });
  }

  if (pathname === "/api/report-data" && request.method === "GET") {
    const reportPath = path.join(ROOT, "report_data.json");
    if (!fileExists(reportPath)) {
      return json({ error: "report_data.json not found. Generate a report first." }, 404);
    }
    const content = fs.readFileSync(reportPath, "utf-8");
    return new Response(content, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  if (pathname === "/api/render-edited" && request.method === "POST") {
    const body = await request.json();
    const client = sanitizeClientId(body?.client);
    const editedJson = body?.editedJson;
    if (!client || !editedJson) {
      return json({ error: "Missing client or editedJson payload." }, 400);
    }

    let parsed;
    try {
      parsed = JSON.parse(editedJson);
    } catch {
      return json({ error: "Edited JSON is invalid." }, 400);
    }

    const config = readClientConfig(client);
    if (!config) return json({ error: "Client config not found." }, 404);

    const tempJsonName = `temp_report_data_${client}_${Date.now()}.json`;
    const tempJsonPath = path.join(ROOT, tempJsonName);
    fs.writeFileSync(tempJsonPath, JSON.stringify(parsed, null, 2));

    const safeClientName = sanitizeForFile(config.client_name);
    const safePeriod = sanitizeForFile(config.report_period);
    const outputPdfPath = path.join(
      "reports",
      `${safeClientName}-${safePeriod}-Monthly_Report-Edited.pdf`
    );

    const run = await runCommand(["bun", "src/renderer.js", tempJsonName, outputPdfPath]);
    try {
      fs.unlinkSync(tempJsonPath);
    } catch {
      // Ignore cleanup errors
    }

    return json({
      ok: run.exitCode === 0,
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
      reportPdfPath: outputPdfPath,
    });
  }

  return null;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function serveStatic(pathname) {
  const relPath = pathname === "/" ? "/index.html" : pathname;
  const fullPath = path.join(PUBLIC_DIR, relPath);
  if (!fullPath.startsWith(PUBLIC_DIR)) return new Response("Forbidden", { status: 403 });
  if (!fileExists(fullPath)) return new Response("Not found", { status: 404 });

  return new Response(fs.readFileSync(fullPath), {
    headers: { "content-type": contentTypeFor(fullPath) },
  });
}

const port = Number(process.env.REPORT_WIZARD_PORT || 8787);

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        const apiResponse = await handleApi(request, url.pathname);
        if (apiResponse) return apiResponse;
        return json({ error: "API route not found." }, 404);
      } catch (error) {
        return json({ error: String(error?.message || error) }, 500);
      }
    }
    return serveStatic(url.pathname);
  },
});

console.log(`Report Wizard running on http://localhost:${port}`);
