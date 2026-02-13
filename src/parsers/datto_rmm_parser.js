import { AsyncFlow, AsyncNode } from "@fractal-solutions/qflow";
import { CodeInterpreterNode, PDFProcessorNode } from "@fractal-solutions/qflow/nodes";
import path from "path";
import process from "process";
import fs from "fs";

function tokenizeForMatch(value) {
  return (value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[a.length][b.length];
}

function tokenMatches(clientToken, fileTokens) {
  if (fileTokens.includes(clientToken)) return true;
  if (clientToken.length < 4) return false;

  const maxDistance = clientToken.length >= 8 ? 2 : 1;
  for (const token of fileTokens) {
    if (Math.abs(token.length - clientToken.length) > maxDistance) continue;
    if (levenshteinDistance(clientToken, token) <= maxDistance) return true;
  }
  return false;
}

function fuzzyClientMatch(clientName, fileName) {
  const clientTokens = tokenizeForMatch(clientName);
  const fileTokens = tokenizeForMatch(fileName);
  if (clientTokens.length === 0 || fileTokens.length === 0) return false;
  return clientTokens.every((clientToken) => tokenMatches(clientToken, fileTokens));
}

function sanitizeClientName(value) {
  return (value || "client").replace(/[^a-zA-Z0-9]/g, "_");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeDeviceToken(value) {
  return (value || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function extractFirstInt(text, regex) {
  if (!text) return null;
  const match = text.match(regex);
  if (!match) return null;
  const parsed = Number.parseInt((match[1] || "").replace(/,/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractServiceScore(executiveText, serviceName) {
  if (!executiveText) return null;
  const regex = new RegExp(`${escapeRegExp(serviceName)}\\s*(?:\\r?\\n)+\\s*(\\d{1,3})%`, "i");
  return extractFirstInt(executiveText, regex);
}

function extractCheckMetric(executiveText, checkLabel) {
  if (!executiveText) return null;
  const regex = new RegExp(
    `${escapeRegExp(checkLabel)}[\\s\\S]{0,280}?(\\d+)\\s*(?:\\r?\\n)+\\s*(\\d+)\\s*(?:\\r?\\n)+\\s*(\\d{1,3})%`,
    "i"
  );
  const match = executiveText.match(regex);
  if (!match) return null;
  return {
    passed: Number.parseInt(match[1], 10),
    failed: Number.parseInt(match[2], 10),
    score: Number.parseInt(match[3], 10),
  };
}

function splitSectionsByPdf(mergedText) {
  const sections = {};
  if (!mergedText) return sections;

  const regex = /--- Content from PDF:\s*(.+?)\s*---\s*([\s\S]*?)(?=(?:--- Document Break ---)|(?:--- Content from PDF:)|$)/gi;
  let match = regex.exec(mergedText);
  while (match) {
    const filename = (match[1] || "").trim();
    const content = (match[2] || "").trim();
    sections[filename] = content;
    match = regex.exec(mergedText);
  }
  return sections;
}

function findSectionByName(sections, keyword) {
  const key = Object.keys(sections).find((name) => name.toLowerCase().includes(keyword.toLowerCase()));
  return key ? sections[key] : "";
}

function extractScopedInt(section, anchor, label) {
  if (!section) return null;
  const anchorIndex = section.toLowerCase().indexOf(anchor.toLowerCase());
  if (anchorIndex < 0) return null;
  const scoped = section.slice(anchorIndex, anchorIndex + 800);
  const regex = new RegExp(`${escapeRegExp(label)}:\\s*(\\d+)`, "i");
  return extractFirstInt(scoped, regex);
}

function extractWindows10DevicesFromHealth(deviceHealthSection) {
  const devices = new Set();
  if (!deviceHealthSection) return [];
  const lines = deviceHealthSection.split(/\r?\n/).map((line) => line.trim());

  for (let i = 0; i < lines.length; i++) {
    if (!/Microsoft Windows 10/i.test(lines[i])) continue;

    for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
      const candidate = lines[j];
      if (!candidate) continue;
      if (/^DESKTOP-/i.test(candidate)) continue;
      if (/^Pro\s/i.test(candidate)) continue;
      if (/^Microsoft/i.test(candidate)) continue;
      if (/^(Disk Space|RAM|Quantity|Software|Compliant|Fully|Patched|Antivirus|Online|Under|Up to|Within Last|Warranty|Date|No Open|Alerts)$/i.test(candidate)) continue;

      if (/^(PC|PF|PW)[A-Z0-9-]+/i.test(candidate) || (/\d/.test(candidate) && candidate.length >= 6)) {
        devices.add(normalizeDeviceToken(candidate));
        break;
      }
    }
  }

  return Array.from(devices);
}

function buildPatchDeviceToUserMap(patchSection) {
  const map = {};
  if (!patchSection) return map;
  const lines = patchSection.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const deviceLine = lines[i];
    if (!/^(PC|PF|PW)[A-Z0-9-]+/i.test(deviceLine)) continue;

    const deviceKey = normalizeDeviceToken(deviceLine);
    for (let j = i + 1; j <= Math.min(i + 4, lines.length - 1); j++) {
      const candidate = lines[j];
      if (!candidate) continue;
      if (/^\d+$/.test(candidate)) continue;
      if (/^\d{2}\s[A-Z]{3}\s\d{4}/i.test(candidate)) continue;
      if (/^(Approved|Pending|Install|Error|Reboot|Required|No Data|Fully|Patched|Workstations|Patch|Status)$/i.test(candidate)) continue;
      if (/^DESKTOP-/i.test(candidate)) continue;
      if (normalizeDeviceToken(candidate) === deviceKey) continue;

      if (/^[A-Za-z][A-Za-z.' -]+$/.test(candidate) && candidate.includes(" ")) {
        map[deviceKey] = candidate;
        break;
      }
    }
  }

  return map;
}

function isLikelyDeviceId(value) {
  return /^(PC|PF|PW)[A-Z0-9-]+/i.test(value || "");
}

function isGenericCompanyOrHeaderLine(value, clientName) {
  if (!value) return true;
  const normalizedValue = value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const normalizedClient = (clientName || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (normalizedClient && normalizedValue === normalizedClient) return true;
  if (normalizedClient && normalizedClient.length >= 8 && normalizedValue.includes(normalizedClient)) return true;
  if (/^(device|description|drive|type|size|free|used|disk|workstations|report|summary|sites|devices|create date)$/i.test(value)) return true;
  if (/^description:/i.test(value)) return true;
  if (/available disk space/i.test(value)) return true;
  return false;
}

function isLikelyHumanName(value) {
  if (!value) return false;
  if (!/^[A-Za-z][A-Za-z.' -]+$/.test(value)) return false;
  if (!value.includes(" ")) return false;
  if (value.includes(":")) return false;
  if (value.split(/\s+/).length > 4) return false;
  if (/^(Device|Description|Drive|Type|Size|Free|Used|Disk|Local|Workstations|ASPIRA|Report|Summary)$/i.test(value)) {
    return false;
  }
  if (/available disk space/i.test(value)) return false;
  if (/^this report/i.test(value)) return false;
  return true;
}

function isLikelyDattoDeviceLabel(value, clientName) {
  if (!value) return false;
  if (isGenericCompanyOrHeaderLine(value, clientName)) return false;
  if (/^(C|D|E|F|G|H|I|J|K|L|M|N|O|P|Q|R|S|T|U|V|W|X|Y|Z):$/i.test(value)) return false;
  if (/^\d+(\.\d+)?(MB|GB|TB|%)$/i.test(value)) return false;
  if (/^\d+(\.\d+)?b$/i.test(value)) return false;
  if (/\d/.test(value) && /(MB|GB|TB|KB|B)/i.test(value)) return false;
  if (/^\d+$/.test(value)) return false;
  if (/^disk\d+/i.test(value)) return false;
  if (/^s\d+$/i.test(value)) return false;
  if (/^(local fixed|efi|no data)$/i.test(value)) return false;
  if (/^microsoft\s/i.test(value)) return false;
  if (/^pro\s\d/i.test(value)) return false;
  if (/\.local$/i.test(value)) return false;
  if (/macbook/i.test(value)) return false;

  // Datto names are usually one-token labels like DIRA-CAROLINE, Apex-NaomiW, PF12VD4C-Stacy.
  if (/\s{2,}/.test(value)) return false;
  if (value.split(/\s+/).length > 3) return false;
  if (!/[A-Za-z]/.test(value)) return false;

  return /[-_.]/.test(value) || /^[A-Za-z0-9]{6,}$/.test(value);
}

function extractDiskUsageEntries(deviceStorageSection, clientName) {
  if (!deviceStorageSection) return [];

  const rawLines = deviceStorageSection.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const labels = [];
  const conventionLabels = [];
  const fallbackHostLabels = [];
  const weakFallbackLabels = [];
  const genericTokens = new Set([
    "Device Name",
    "Device Description",
    "Drive Drive Type",
    "Size",
    "Free",
    "Used %",
    "Disk",
    "Local Fixed",
    "Workstations",
    "Patch",
    "Status",
    "Description",
    "Last Reboot",
    "Installed",
    "Approved",
    "Pending",
    "Not Approved",
    "C:",
    "D:",
    "ASPIRA - CIM CREDIT",
    "Device Storage Report",
    "Description:",
    "Description: This report lists all the disks available on the selected devices including their",
    "available disk space.",
  ]);

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line || genericTokens.has(line)) continue;
    if (isGenericCompanyOrHeaderLine(line, clientName)) continue;
    if (/^\d+(\.\d+)?(MB|GB|TB|%)$/i.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^disk\d+/i.test(line)) continue;
    if (/^s\d+$/i.test(line)) continue;
    if (/^(EFI|No data)$/i.test(line)) continue;
    if (/^(C|D|E|F|G|H|I|J|K|L|M|N|O|P|Q|R|S|T|U|V|W|X|Y|Z):$/i.test(line)) continue;

    if (isLikelyDeviceId(line)) {
      const normalized = line.replace(/\s+/g, " ").trim();
      labels.push(normalized);
      conventionLabels.push(normalized);
      continue;
    }

    if (isLikelyDattoDeviceLabel(line, clientName)) {
      const normalized = line.replace(/\s+/g, " ").trim();
      labels.push(normalized);
      if (/^(DESKTOP|LAPTOP)-/i.test(normalized)) {
        fallbackHostLabels.push(normalized);
      } else {
        // Prefer dashboard naming convention labels like DIRA-*, APEX-*, DWA-* and coded aliases.
        if (/^[A-Za-z0-9]+-[A-Za-z0-9][A-Za-z0-9._-]*$/i.test(normalized)) {
          conventionLabels.push(normalized);
        } else {
          weakFallbackLabels.push(normalized);
        }
      }
      continue;
    }

    // Do not prefer human-name labels for disk chart naming.
  }

  // Deterministic priority:
  // 1) Convention aliases (DIRA-*, APEX-*, DWA-*, PC*/PF*/PW* etc)
  // 2) Other non-host labels
  // 3) Hostnames (DESKTOP-/LAPTOP-)
  // 4) Any remaining labels
  const labelSource =
    conventionLabels.length > 0
      ? conventionLabels
      : weakFallbackLabels.length > 0
        ? weakFallbackLabels
        : fallbackHostLabels.length > 0
          ? fallbackHostLabels
          : labels;

  const dedupedLabels = [];
  const seenLabels = new Set();
  for (const label of labelSource) {
    const key = label.toLowerCase();
    if (!seenLabels.has(key)) {
      seenLabels.add(key);
      dedupedLabels.push(label);
    }
  }

  const percentageMatches = Array.from(deviceStorageSection.matchAll(/(\d{1,3}\.\d+)%/g))
    .map((m) => Number.parseFloat(m[1]))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 100);

  const alignCount = Math.min(dedupedLabels.length, percentageMatches.length);
  if (alignCount === 0) return [];

  const alignedEntries = [];
  for (let i = 0; i < alignCount; i++) {
    alignedEntries.push({
      label: dedupedLabels[i],
      used_percent: round1(percentageMatches[i]),
    });
  }

  const mergedByLabel = new Map();
  for (const entry of alignedEntries) {
    const key = entry.label.toLowerCase();
    const existing = mergedByLabel.get(key);
    if (!existing || entry.used_percent > existing.used_percent) {
      mergedByLabel.set(key, entry);
    }
  }

  return Array.from(mergedByLabel.values()).sort((a, b) => b.used_percent - a.used_percent);
}

function buildRecommendations(parsed) {
  const recommendations = [];

  if (parsed.device_health.compliance_percentage < 90) {
    recommendations.push(
      `Device health compliance is ${parsed.device_health.compliance_percentage}%; prioritize remediation of failed health checks this month.`
    );
  }
  if (parsed.patch_management.update_required_count > 0) {
    recommendations.push(
      `${parsed.patch_management.update_required_count} endpoints require patching or reboot; schedule a staged patching window and enforce reboot follow-up.`
    );
  }
  if (parsed.antivirus.installed_count < parsed.device_health.total_managed) {
    recommendations.push(
      `Antivirus coverage is ${parsed.antivirus.installed_count}/${parsed.device_health.total_managed}; deploy or remediate protection on uncovered endpoints.`
    );
  }
  if (parsed.device_health.metrics.disk_space.low_space_count > 0) {
    recommendations.push(
      `${parsed.device_health.metrics.disk_space.low_space_count} endpoints are below disk policy threshold; clean up storage and set automated low-space alerting.`
    );
  }
  if (parsed.device_health.metrics.ram.passed_count < parsed.device_health.metrics.ram.total_count) {
    recommendations.push("Upgrade RAM on non-compliant endpoints to meet the 3.8 GB minimum baseline.");
  }
  if (parsed.device_health.metrics.os_support.passed_count < parsed.device_health.metrics.os_support.total_count) {
    recommendations.push("Create an OS lifecycle plan for unsupported or near end-of-support devices.");
  }

  if (recommendations.length < 3) {
    recommendations.push("Review monitoring alerts weekly and close high-priority items to improve service score.");
  }
  if (recommendations.length < 3) {
    recommendations.push("Track monthly trend lines for patching, antivirus, and health checks to validate operational improvements.");
  }

  return recommendations.slice(0, 6);
}

function parseDattoMetrics(mergedText, clientName) {
  const sections = splitSectionsByPdf(mergedText);
  const deviceHealthSection = findSectionByName(sections, "device health summary");
  const executiveSection = findSectionByName(sections, "executive summary");
  const deviceStorageSection = findSectionByName(sections, "device storage");
  const patchSummarySection = findSectionByName(sections, "patch management summary");

  const totalManaged =
    extractFirstInt(deviceHealthSection, /Total Managed devices:\s*(\d+)/i) ||
    extractFirstInt(deviceHealthSection, /Devices:\s*(\d+)/i) ||
    extractFirstInt(executiveSection, /Devices:\s*(\d+)/i) ||
    0;

  const summaryPassed = extractFirstInt(deviceHealthSection, /Devices with Check Passed:\s*(\d+)/i) || 0;
  const summaryFailed = extractFirstInt(deviceHealthSection, /Devices with Checks Failed:\s*(\d+)/i) || 0;
  const compliancePercentage = totalManaged > 0 ? round1((summaryPassed / totalManaged) * 100) : 0;

  const diskMetric = extractCheckMetric(
    executiveSection,
    "Devices must have at least 15% free space on System Drive"
  );
  const ramMetric = extractCheckMetric(
    executiveSection,
    "Devices must have at least 3.8 GB of memory installed"
  );
  const osMetric = extractCheckMetric(
    executiveSection,
    "Windows Devices OS must be supported by Microsoft"
  );

  const diskPassed = diskMetric?.passed ?? summaryPassed;
  const diskFailed = diskMetric?.failed ?? summaryFailed;
  const diskTotal = diskPassed + diskFailed;
  const diskUsageEntries = extractDiskUsageEntries(deviceStorageSection, clientName);
  const diskTop10 = diskUsageEntries.slice(0, 10);
  const thresholdLowSpaceCount = diskUsageEntries.filter((entry) => entry.used_percent >= 85).length;
  const lowSpaceCount = Math.max(diskFailed, thresholdLowSpaceCount);

  const ramPassed = ramMetric?.passed ?? totalManaged;
  const ramFailed = ramMetric?.failed ?? 0;
  const ramTotal = ramPassed + ramFailed;

  const osPassed = osMetric?.passed ?? totalManaged;
  const osFailed = osMetric?.failed ?? 0;
  const osTotal = osPassed + osFailed;

  const averageScore = extractServiceScore(executiveSection, "Average Score");
  const serviceScores = {
    "Asset Management": extractServiceScore(executiveSection, "Asset Management"),
    Monitoring: extractServiceScore(executiveSection, "Monitoring"),
    "Patch Management": extractServiceScore(executiveSection, "Patch Management"),
    "Software Management": extractServiceScore(executiveSection, "Software Management"),
    Antivirus: extractServiceScore(executiveSection, "Antivirus"),
  };

  const serverAv = extractScopedInt(executiveSection, "Server Antivirus Status", "Running and Up to Date") || 0;
  const workstationAv = extractScopedInt(
    executiveSection,
    "Workstation Antivirus Status",
    "Running and Up to Date"
  ) || 0;
  const installedCount = serverAv + workstationAv;

  const fullyPatched = extractFirstInt(patchSummarySection, /Fully Patched:\s*(\d+)/i) || 0;
  const approvedPending = extractFirstInt(patchSummarySection, /Approved Pending:\s*(\d+)/i) || 0;
  const installError = extractFirstInt(patchSummarySection, /Install Error:\s*(\d+)/i) || 0;
  const rebootRequired = extractFirstInt(patchSummarySection, /Reboot Required:\s*(\d+)/i) || 0;
  const noData = extractFirstInt(patchSummarySection, /No Data:\s*(\d+)/i) || 0;
  const noPolicy = extractFirstInt(patchSummarySection, /No Policy:\s*(\d+)/i) || 0;
  const patchTotal = extractFirstInt(patchSummarySection, /Devices:\s*(\d+)/i) || 0;
  const updateRequiredCount =
    patchTotal > 0
      ? Math.max(0, patchTotal - fullyPatched)
      : approvedPending + installError + rebootRequired + noData + noPolicy;

  const windows10Devices = extractWindows10DevicesFromHealth(deviceHealthSection);
  const patchDeviceUserMap = buildPatchDeviceToUserMap(patchSummarySection);
  const windows10UsersList = Array.from(
    new Set(
      windows10Devices
        .map((deviceId) => patchDeviceUserMap[deviceId])
        .filter(Boolean)
    )
  );

  const clientNameSanitized = sanitizeClientName(clientName);
  const chartPaths = {
    services: `assets/datto_services_${clientNameSanitized}.png`,
    deviceHealth: `assets/datto_device_health_${clientNameSanitized}.png`,
    disk: `assets/datto_disk_space_${clientNameSanitized}.png`,
    antivirus: `assets/datto_antivirus_${clientNameSanitized}.png`,
    patch: `assets/datto_patch_${clientNameSanitized}.png`,
  };

  const parsed = {
    scores: {
      average_score: averageScore ?? 0,
      services_delivered_chart_path: chartPaths.services,
    },
    device_health: {
      total_managed: totalManaged,
      compliance_percentage: compliancePercentage,
      chart_path: chartPaths.deviceHealth,
      metrics: {
        disk_space: {
          passed_count: diskPassed,
          total_count: diskTotal,
          low_space_count: lowSpaceCount,
          chart_path: chartPaths.disk,
        },
        ram: {
          passed_count: ramPassed,
          total_count: ramTotal,
        },
        os_support: {
          passed_count: osPassed,
          total_count: osTotal,
        },
      },
    },
    antivirus: {
      installed_count: installedCount,
      chart_path: chartPaths.antivirus,
    },
    patch_management: {
      fully_patched_count: fullyPatched,
      update_required_count: updateRequiredCount,
      chart_path: chartPaths.patch,
      windows_10_users_list: windows10UsersList,
    },
    recommendations: [],
  };

  parsed.recommendations = buildRecommendations(parsed);
  parsed.__chart_data = {
    service_scores: serviceScores,
    average_score: parsed.scores.average_score,
    disk: {
      passed: parsed.device_health.metrics.disk_space.passed_count,
      failed: parsed.device_health.metrics.disk_space.low_space_count,
    },
    disk_top_entries: diskTop10,
    ram: {
      passed: parsed.device_health.metrics.ram.passed_count,
      failed: Math.max(0, parsed.device_health.metrics.ram.total_count - parsed.device_health.metrics.ram.passed_count),
    },
    os: {
      passed: parsed.device_health.metrics.os_support.passed_count,
      failed: Math.max(0, parsed.device_health.metrics.os_support.total_count - parsed.device_health.metrics.os_support.passed_count),
    },
    antivirus: {
      installed: parsed.antivirus.installed_count,
      missing: Math.max(0, parsed.device_health.total_managed - parsed.antivirus.installed_count),
    },
    patch: {
      fully_patched: parsed.patch_management.fully_patched_count,
      update_required: parsed.patch_management.update_required_count,
    },
  };

  return parsed;
}

export function datto_rmmParserWorkflow() {
  const codeInterpreter = new CodeInterpreterNode();
  codeInterpreter.setParams({
    interpreterPath: path.join(process.cwd(), "venv", "Scripts", "python.exe"),
  });

  const findAndProcessDattoPdfsNode = new AsyncNode();
  findAndProcessDattoPdfsNode.prepAsync = async (shared) => {
    if (typeof shared === "undefined" || shared === null) shared = {};

    const baseDataDir = shared.data_directory
      ? path.resolve(process.cwd(), shared.data_directory)
      : path.join(process.cwd(), "data");
    const dattoRmmDataDir = path.join(baseDataDir, "datto_rmm");
    console.log(`Datto RMM Parser: Looking for Datto RMM PDF files in ${dattoRmmDataDir}`);

    let dattoRmmPdfPaths = [];
    try {
      const files = fs.readdirSync(dattoRmmDataDir);
      console.log(`Datto RMM Parser: Found ${files.length} files in ${dattoRmmDataDir}`);

      const clientNameRegex = new RegExp((shared.client_name || "").replace(/[^a-zA-Z0-9]/g, ".*"), "i");
      const pdfFiles = files.filter((file) => file.toLowerCase().endsWith(".pdf"));

      for (const file of pdfFiles) {
        if (clientNameRegex.test(file)) {
          dattoRmmPdfPaths.push(path.join(dattoRmmDataDir, file));
          console.log(`Datto RMM Parser: Found Datto RMM PDF file: ${file}`);
        }
      }

      if (dattoRmmPdfPaths.length === 0) {
        console.warn("Datto RMM Parser: No PDF matches found using exact regex. Trying fuzzy matching...");
        for (const file of pdfFiles) {
          if (fuzzyClientMatch(shared.client_name, file)) {
            dattoRmmPdfPaths.push(path.join(dattoRmmDataDir, file));
            console.log(`Datto RMM Parser: Fuzzy matched PDF file: ${file}`);
          }
        }
      }
    } catch (err) {
      console.error("Datto RMM Parser: Error finding Datto RMM PDF files:", err);
    }

    shared.datto_rmm_pdf_paths = dattoRmmPdfPaths;
    return shared;
  };

  const extractPdfsTextNode = new AsyncNode();
  extractPdfsTextNode.prepAsync = async (shared) => {
    if (typeof shared === "undefined" || shared === null) shared = {};

    const pdfPaths = shared.datto_rmm_pdf_paths || [];
    if (pdfPaths.length === 0) {
      console.warn("Datto RMM Parser: No Datto RMM PDF paths found. Using empty content.");
      shared.pdfTextContent = "";
      return shared;
    }

    const allExtractedText = [];
    for (const pdfPath of pdfPaths) {
      console.log(`Datto RMM Parser: Extracting text from PDF: ${pdfPath}`);
      const localPdfProcessor = new PDFProcessorNode();
      localPdfProcessor.setParams({
        filePath: pdfPath,
        action: "extract_text",
      });

      try {
        const result = await new AsyncFlow(localPdfProcessor).runAsync({});
        if (result && result.text) {
          allExtractedText.push(`--- Content from PDF: ${path.basename(pdfPath)} ---\n${result.text}\n\n`);
        } else {
          console.warn(`Datto RMM Parser: No text extracted from ${pdfPath}.`);
        }
      } catch (error) {
        console.error(`Datto RMM Parser: Error extracting text from ${pdfPath}: ${error.message}`);
      }
    }

    const mergedContent = allExtractedText.join("\n\n\n--- Document Break ---\n\n\n");
    shared.pdfTextContent = mergedContent;
    console.log(`Datto RMM Parser: Merged extracted text content (total length: ${mergedContent.length})`);

    const clientNameSanitized = sanitizeClientName(shared.client_name);
    const mergedTextDir = path.join(process.cwd(), "data", "datto_rmm", "extracted");
    if (!fs.existsSync(mergedTextDir)) {
      fs.mkdirSync(mergedTextDir, { recursive: true });
    }
    shared.merged_datto_rmm_text_filepath = path.join(
      mergedTextDir,
      `merged_content_${clientNameSanitized}.txt`
    );
    fs.writeFileSync(shared.merged_datto_rmm_text_filepath, mergedContent);
    console.log(`Datto RMM Parser: Merged text written to ${shared.merged_datto_rmm_text_filepath}`);
    return shared;
  };

  const parseMetricsNode = new AsyncNode();
  parseMetricsNode.prepAsync = async (shared) => {
    if (typeof shared === "undefined" || shared === null) shared = {};

    const parsed = parseDattoMetrics(shared.pdfTextContent || "", shared.client_name || "client");
    shared.datto_output = parsed;

    const metricsPath = path.join(process.cwd(), "data", "datto_rmm", "extracted", `metrics_${sanitizeClientName(shared.client_name)}.json`);
    fs.writeFileSync(metricsPath, JSON.stringify(parsed, null, 2));
    console.log(`Datto RMM Parser: Deterministic metrics written to ${metricsPath}`);

    return shared;
  };

  const generateChartsNode = new AsyncNode();
  generateChartsNode.prepAsync = async (shared) => {
    if (typeof shared === "undefined" || shared === null) shared = {};
    if (!shared.datto_output || !shared.datto_output.__chart_data) {
      throw new Error("Datto RMM Parser: Missing parsed chart data for chart generation.");
    }

    const chartData = shared.datto_output.__chart_data;
    const paths = {
      services: shared.datto_output.scores.services_delivered_chart_path.replace(/\\/g, "/"),
      deviceHealth: shared.datto_output.device_health.chart_path.replace(/\\/g, "/"),
      disk: shared.datto_output.device_health.metrics.disk_space.chart_path.replace(/\\/g, "/"),
      antivirus: shared.datto_output.antivirus.chart_path.replace(/\\/g, "/"),
      patch: shared.datto_output.patch_management.chart_path.replace(/\\/g, "/"),
    };

    const pythonCode = `
import os
import json
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D

chart_data = json.loads(r'''${JSON.stringify(chartData)}''')
paths = json.loads(r'''${JSON.stringify(paths)}''')

PRIMARY = "#0047AB"
PRIMARY_ALT = "#0F66D7"
ACCENT = "#FF5733"
SUCCESS = "#2FA36B"
DANGER = "#D64545"
LIGHT = "#e6ecf5"
SURFACE = "#f4f4f4"
TEXT = "#222222"
MUTED = "#5b6878"

plt.rcParams["font.family"] = "DejaVu Sans"
plt.rcParams["axes.titlesize"] = 13
plt.rcParams["axes.labelsize"] = 10
plt.rcParams["xtick.labelsize"] = 9
plt.rcParams["ytick.labelsize"] = 9

def style_card(fig, ax, title):
    fig.patch.set_facecolor("white")
    ax.set_facecolor(SURFACE)
    ax.set_title(title, color=TEXT, pad=12, fontweight="bold")
    ax.grid(axis="y", color=LIGHT, linestyle="-", linewidth=1.0, alpha=0.9)
    ax.set_axisbelow(True)
    for side in ["top", "right"]:
        ax.spines[side].set_visible(False)
    ax.spines["left"].set_color(LIGHT)
    ax.spines["bottom"].set_color(LIGHT)
    ax.tick_params(colors=MUTED)

os.makedirs("assets", exist_ok=True)

# 1) Services Delivered chart
services = ["Asset Management", "Monitoring", "Patch Management", "Software Management", "Antivirus"]
service_values = [chart_data["service_scores"].get(s, 0) or 0 for s in services]
avg_score = chart_data.get("average_score", 0) or 0

fig, ax = plt.subplots(figsize=(9.2, 5.4), dpi=300)
style_card(fig, ax, "Services Delivered Scores")
x = np.arange(len(services))
bars = ax.bar(x, service_values, color=[PRIMARY, PRIMARY_ALT, PRIMARY, PRIMARY_ALT, PRIMARY], alpha=0.95, edgecolor="white", linewidth=1.0)
ax.axhline(avg_score, color=ACCENT, linestyle=(0, (6, 3)), linewidth=2.2)
ax.text((len(services) - 1) / 2, avg_score + 1.2, f"Average ({avg_score}%)", color=ACCENT, ha="center", va="bottom", fontsize=8.5, fontweight="bold")
ax.set_ylim(0, 100)
ax.set_ylabel("Score (%)", color=TEXT)
ax.set_xticks(x)
ax.set_xticklabels(services, rotation=18, ha="right")
for bar, val in zip(bars, service_values):
    ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 1.5, f"{val}%", ha="center", color=TEXT, fontsize=8.5, fontweight="bold")
fig.tight_layout()
fig.savefig(paths["services"], dpi=300)
plt.close(fig)

# 2) Device health checks (passed vs failed)
health_labels = ["Disk Space", "RAM", "OS Support"]
passed_vals = [chart_data["disk"]["passed"], chart_data["ram"]["passed"], chart_data["os"]["passed"]]
failed_vals = [chart_data["disk"]["failed"], chart_data["ram"]["failed"], chart_data["os"]["failed"]]

fig, ax = plt.subplots(figsize=(8.2, 5.2), dpi=300)
style_card(fig, ax, "Device Health Checks")
x = np.arange(len(health_labels))
width = 0.34
bars1 = ax.bar(x - width / 2, passed_vals, width, label="Passed", color=SUCCESS, edgecolor="white", linewidth=1.0)
bars2 = ax.bar(x + width / 2, failed_vals, width, label="Failed", color=DANGER, edgecolor="white", linewidth=1.0)
ax.set_ylabel("Endpoints", color=TEXT)
ax.set_xticks(x)
ax.set_xticklabels(health_labels)
for bars in [bars1, bars2]:
    for b in bars:
        ax.text(b.get_x() + b.get_width() / 2, b.get_height() + 0.2, f"{int(b.get_height())}", ha="center", color=TEXT, fontsize=8.5, fontweight="bold")
ax.legend(frameon=False, fontsize=8.5, loc="upper right")
fig.tight_layout()
fig.savefig(paths["deviceHealth"], dpi=300)
plt.close(fig)

# 3) Top 10 disk usage with threshold
fig, ax = plt.subplots(figsize=(7.8, 6.4), dpi=300)
style_card(fig, ax, "Top 10 Disk Space Utilization (Used %)")
top_disk = chart_data.get("disk_top_entries", [])
if top_disk:
    labels = [entry["label"] for entry in top_disk]
    vals = [entry["used_percent"] for entry in top_disk]
    colors = [ACCENT if v >= 85 else PRIMARY for v in vals]
    bars = ax.bar(labels, vals, color=colors, width=0.66, edgecolor="white", linewidth=1.0)
    ax.axhline(85, color=ACCENT, linestyle=(0, (6, 3)), linewidth=2.2, label="Threshold (15% free / 85% used)")
    ax.set_ylabel("Disk Used (%)", color=TEXT)
    ax.set_ylim(0, 100)
    small_label_set = len(labels) < 4
    label_rotation = 32 if small_label_set else 90
    label_size = 9 if small_label_set else 8
    ax.tick_params(axis="x", rotation=label_rotation, labelsize=label_size)
    for tick in ax.get_xticklabels():
        if small_label_set:
            tick.set_ha("right")
            tick.set_va("top")
        else:
            tick.set_ha("center")
            tick.set_va("top")
    for b, val in zip(bars, vals):
        ax.text(b.get_x() + b.get_width() / 2, val + 1.2, f"{val:.1f}%", ha="center", color=TEXT, fontsize=8, fontweight="bold")
    ax.legend(frameon=False, fontsize=8, loc="upper right")
else:
    labels = ["Passed", "Low Space"]
    vals = [chart_data["disk"]["passed"], chart_data["disk"]["failed"]]
    bars = ax.bar(labels, vals, color=[SUCCESS, DANGER], width=0.56, edgecolor="white", linewidth=1.0)
    ax.set_ylabel("Endpoints", color=TEXT)
    for b in bars:
        ax.text(b.get_x() + b.get_width() / 2, b.get_height() + 0.2, f"{int(b.get_height())}", ha="center", color=TEXT, fontsize=8.5, fontweight="bold")
fig.tight_layout()
if top_disk:
    bottom_margin = 0.24 if len(top_disk) < 4 else 0.40
else:
    bottom_margin = 0.18
fig.subplots_adjust(bottom=bottom_margin)
fig.savefig(paths["disk"], dpi=300)
plt.close(fig)

# 4) Antivirus installed coverage
fig, ax = plt.subplots(figsize=(7.2, 4.8), dpi=300)
style_card(fig, ax, "Antivirus Coverage")
labels = ["Installed", "Missing"]
vals = [chart_data["antivirus"]["installed"], chart_data["antivirus"]["missing"]]
bars = ax.bar(labels, vals, color=[SUCCESS, DANGER], width=0.56, edgecolor="white", linewidth=1.0)
ax.set_ylabel("Endpoints", color=TEXT)
for b in bars:
    ax.text(b.get_x() + b.get_width() / 2, b.get_height() + 0.2, f"{int(b.get_height())}", ha="center", color=TEXT, fontsize=8.5, fontweight="bold")
fig.tight_layout()
fig.savefig(paths["antivirus"], dpi=300)
plt.close(fig)

# 5) Patch status donut
fig, ax = plt.subplots(figsize=(6.7, 6.7), dpi=300)
fig.patch.set_facecolor("white")
ax.set_facecolor(SURFACE)
ax.set_title("Patch Status", color=TEXT, pad=12, fontweight="bold")
sizes = [chart_data["patch"]["fully_patched"], chart_data["patch"]["update_required"]]
labels = ["Fully Patched", "Update Required"]
colors = [SUCCESS, ACCENT]
wedges, _ = ax.pie(
    sizes,
    colors=colors,
    startangle=90,
    wedgeprops=dict(width=0.42, edgecolor="white")
)
centre_circle = plt.Circle((0, 0), 0.56, fc="white")
ax.add_artist(centre_circle)
legend_elements = [Line2D([0], [0], marker="o", color="w", label=f"{l}: {v}", markerfacecolor=c, markersize=9) for l, v, c in zip(labels, sizes, colors)]
ax.legend(handles=legend_elements, loc="lower center", bbox_to_anchor=(0.5, -0.08), frameon=False, fontsize=8.5)
fig.tight_layout()
fig.savefig(paths["patch"], dpi=300)
plt.close(fig)

print("Charts generated successfully.")
`;

    codeInterpreter.setParams({
      interpreterPath: path.join(process.cwd(), "venv", "Scripts", "python.exe"),
      requireConfirmation: false,
      code: pythonCode,
    });

    const result = await new AsyncFlow(codeInterpreter).runAsync({});
    if (result?.exitCode !== 0) {
      throw new Error(`Datto RMM Parser: Chart generation failed: ${result?.stderr || "Unknown error"}`);
    }

    return shared;
  };

  const processOutputNode = new AsyncNode();
  processOutputNode.prepAsync = async (shared) => {
    if (typeof shared === "undefined" || shared === null) shared = {};
    if (!shared.datto_output) {
      throw new Error("Datto RMM Parser: No parsed Datto output found.");
    }

    const output = JSON.parse(JSON.stringify(shared.datto_output));
    delete output.__chart_data;

    const clientNameSanitized = sanitizeClientName(shared.client_name);
    const tempFilePath = path.join(process.cwd(), `temp_datto_rmm_output_${clientNameSanitized}.json`);
    fs.writeFileSync(tempFilePath, JSON.stringify(output, null, 2));
    shared.output_filepath = tempFilePath;

    console.log(`Datto RMM Parser: Wrote output to temporary file: ${tempFilePath}`);
    return shared;
  };

  const flow = new AsyncFlow();
  flow
    .start(findAndProcessDattoPdfsNode)
    .next(extractPdfsTextNode)
    .next(parseMetricsNode)
    .next(generateChartsNode)
    .next(processOutputNode);

  return flow;
}
