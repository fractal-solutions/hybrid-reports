import { AsyncFlow, AsyncNode } from "@fractal-solutions/qflow";
import { CodeInterpreterNode } from "@fractal-solutions/qflow/nodes";
import path from "path";
import fs from "fs";

function sanitizeClientName(value) {
  return (value || "client").replace(/[^a-zA-Z0-9]/g, "_");
}

function escapeForPythonTripleQuoted(value) {
  return value.replace(/\\/g, "\\\\").replace(/'''/g, "\\'\\'\\'");
}

function normalizePercent(value) {
  const num = Number.parseFloat(String(value).replace("%", "").trim());
  if (!Number.isFinite(num)) return "0%";
  const rounded = Math.round(num * 1000) / 1000;
  const asStr = Number.isInteger(rounded) ? String(rounded) : String(rounded);
  return `${asStr}%`;
}

function numberToPercentString(value) {
  const bounded = Math.min(100, Math.max(0, value));
  const rounded = Math.round(bounded * 1000) / 1000;
  const asStr = Number.isInteger(rounded) ? String(rounded) : String(rounded);
  return `${asStr}%`;
}

function parseDurationToSeconds(duration) {
  if (!duration) return null;
  const dayMatch = duration.match(/(\d+)d\s+(\d+)h\s+(\d+)m\s+(\d+)s/i);
  if (dayMatch) {
    const d = Number.parseInt(dayMatch[1], 10);
    const h = Number.parseInt(dayMatch[2], 10);
    const m = Number.parseInt(dayMatch[3], 10);
    const s = Number.parseInt(dayMatch[4], 10);
    return d * 86400 + h * 3600 + m * 60 + s;
  }
  const secOnlyMatch = duration.match(/^(\d+)s$/i);
  if (secOnlyMatch) {
    return Number.parseInt(secOnlyMatch[1], 10);
  }
  return null;
}

function durationSecondsToDhms(totalSeconds) {
  const n = Number.parseInt(String(totalSeconds), 10);
  if (!Number.isFinite(n) || n < 0) return "N/A";
  const days = Math.floor(n / 86400);
  const remAfterDays = n % 86400;
  const hours = Math.floor(remAfterDays / 3600);
  const remAfterHours = remAfterDays % 3600;
  const minutes = Math.floor(remAfterHours / 60);
  const seconds = remAfterHours % 60;
  return `${days}d ${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

function parseUsDateTimeToMs(value) {
  const m = String(value || "")
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let month = Number.parseInt(m[1], 10);
  let day = Number.parseInt(m[2], 10);
  const year = Number.parseInt(m[3], 10);
  let hour = Number.parseInt(m[4], 10);
  const minute = Number.parseInt(m[5], 10);
  const second = Number.parseInt(m[6], 10);
  const ampm = m[7].toUpperCase();

  if (hour === 12 && ampm === "AM") hour = 0;
  if (hour !== 12 && ampm === "PM") hour += 12;

  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function parseReportWindowSeconds(text) {
  const windowMatch = String(text || "").match(
    /\((\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM))\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM))/i
  );
  if (!windowMatch) return null;
  const startMs = parseUsDateTimeToMs(windowMatch[1]);
  const endMs = parseUsDateTimeToMs(windowMatch[2]);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return Math.max(1, Math.round((endMs - startMs) / 1000));
}

function parsePrtgLinksFromText(text) {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/[^\x00-\x7F]+/g, " ").trim())
    .filter(Boolean);
  const reportWindowSeconds = parseReportWindowSeconds(text);

  const sensorRegex = /^(.*?)\s+(<\s*)?(\d+(?:\.\d+)?)\s*(Mbit\/s|MB|msec)\s*(\d+(?:\.\d+)?)\s*%\s*\[(\d+d\s+\d+h\s+\d+m\s+\d+s|\d+s)\s+(\d+(?:\.\d+)?)\s*%\s*\[(\d+)\]$/i;
  const skipPrefixRegex = /^(PRTG NETWORK MONITOR|Aspira Report|Average Uptime|Probe, Group, Device Sensor|Local Probe|PAESSLER|--- Page Break ---)/i;

  const candidates = [];
  for (const line of lines) {
    if (skipPrefixRegex.test(line)) continue;
    const match = line.match(sensorRegex);
    if (!match) continue;

    const name = match[1].trim();
    // Filter group/site summary rows to keep only sensor-like entries.
    if (/\([^)]+\)/.test(name) && !/Availability-Ping/i.test(name)) continue;
    if (/^CIM Credit Kenya/i.test(name)) continue;

    const comparator = (match[2] || "").trim();
    const valueNum = match[3];
    const unit = match[4];
    const uptimePercentRaw = match[5];
    const uptimeDuration = match[6];
    const uptimePercentNum = Number.parseFloat(uptimePercentRaw);
    const uptimeSeconds = parseDurationToSeconds(uptimeDuration);

    const value = `${comparator ? `${comparator} ` : ""}${valueNum} ${unit}`.replace(/\s+/g, " ").trim();
    const isBandwidth = unit.toLowerCase() === "mbit/s" || unit.toLowerCase() === "msec";
    const avg_bandwidth = isBandwidth ? value : "N/A";
    const total_data = unit.toLowerCase() === "mb" ? value : "N/A";

    let normalizedUptime = Number.isFinite(uptimePercentNum) ? uptimePercentNum : 0;
    if (reportWindowSeconds && Number.isFinite(uptimeSeconds) && uptimeSeconds >= 0) {
      const uptimeFromDuration = (uptimeSeconds / reportWindowSeconds) * 100;
      // If OCR percent is noisy, prefer duration-derived value when mismatch is large.
      if (!Number.isFinite(uptimePercentNum) || Math.abs(uptimeFromDuration - uptimePercentNum) > 5) {
        normalizedUptime = uptimeFromDuration;
      }
    }
    normalizedUptime = Math.min(100, Math.max(0, normalizedUptime));
    const normalizedDowntime = Math.min(100, Math.max(0, 100 - normalizedUptime));

    let downtimeDuration = "N/A";
    if (reportWindowSeconds && Number.isFinite(uptimeSeconds) && uptimeSeconds >= 0) {
      downtimeDuration = durationSecondsToDhms(Math.max(0, reportWindowSeconds - uptimeSeconds));
    }

    candidates.push({
      name,
      avg_bandwidth,
      total_data,
      uptime_percent: numberToPercentString(normalizedUptime),
      downtime_percent: numberToPercentString(normalizedDowntime),
      uptime_duration: uptimeDuration,
      downtime_duration: downtimeDuration,
    });
  }

  // Deduplicate by name deterministically: keep the row with richer fields.
  const byName = new Map();
  for (const entry of candidates) {
    const key = entry.name.toLowerCase();
    const score =
      (entry.avg_bandwidth !== "N/A" ? 2 : 0) +
      (entry.total_data !== "N/A" ? 2 : 0) +
      (entry.uptime_duration !== "N/A" ? 1 : 0) +
      (entry.downtime_duration !== "N/A" ? 1 : 0);

    const existing = byName.get(key);
    if (!existing || score > existing.score) {
      byName.set(key, { score, entry });
    }
  }

  return Array.from(byName.values())
    .map((item) => item.entry)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function computePrtgSummary(links) {
  if (!Array.isArray(links) || links.length === 0) {
    return {
      overall_avg_uptime_percent: "0%",
      overall_avg_downtime_percent: "0%",
      total_links_monitored: 0,
      links_with_downtime: 0,
    };
  }

  const uptimeValues = links.map((link) =>
    Number.parseFloat(String(link.uptime_percent).replace("%", "").trim()) || 0
  );
  const downtimeValues = links.map((link) =>
    Number.parseFloat(String(link.downtime_percent).replace("%", "").trim()) || 0
  );

  const avg = (arr) => arr.reduce((sum, n) => sum + n, 0) / arr.length;
  const avgUptime = Math.round(avg(uptimeValues) * 1000) / 1000;
  const avgDowntime = Math.round(avg(downtimeValues) * 1000) / 1000;
  const linksWithDowntime = downtimeValues.filter((n) => n > 0).length;

  return {
    overall_avg_uptime_percent: `${avgUptime}%`,
    overall_avg_downtime_percent: `${avgDowntime}%`,
    total_links_monitored: links.length,
    links_with_downtime: linksWithDowntime,
  };
}

export function prtg_monitoringParserWorkflow() {
  const flow = new AsyncFlow();

  const findAndProcessPrtgPdfNode = new AsyncNode();
  findAndProcessPrtgPdfNode.prepAsync = async (shared) => {
    if (!shared) shared = {};
    if (!shared.data_directory || !shared.client_name) {
      throw new Error("PRTG Parser: Missing data_directory or client_name in shared object.");
    }

    const baseDataDir = path.resolve(process.cwd(), shared.data_directory);
    const prtgDataDir = path.join(baseDataDir, "prtg");

    let prtgPdfPath = null;
    try {
      const files = fs.readdirSync(prtgDataDir);
      const clientNameRegex = new RegExp(shared.client_name.replace(/[^a-zA-Z0-9]/g, ".*"), "i");
      const pdfFile = files.find(
        (file) =>
          file.toLowerCase().includes("prtg") &&
          file.toLowerCase().endsWith(".pdf") &&
          clientNameRegex.test(file)
      );

      if (!pdfFile) {
        throw new Error(`PRTG Parser: No matching PDF found for client ${shared.client_name} in ${prtgDataDir}.`);
      }
      prtgPdfPath = path.join(prtgDataDir, pdfFile);
      console.log(`PRTG Parser: Found PDF for ${shared.client_name} at ${prtgPdfPath}`);
    } catch (error) {
      console.error(`PRTG Parser: Error accessing ${prtgDataDir}: ${error.message}`);
      throw error;
    }

    shared.prtgPdfPath = prtgPdfPath;
    return shared;
  };

  const extractPdfTextNode = new CodeInterpreterNode();
  extractPdfTextNode.prepAsync = async (shared) => {
    if (!shared) shared = {};
    if (!shared.prtgPdfPath) {
      throw new Error("PRTG Parser: Missing prtgPdfPath in shared object for PDF text extraction.");
    }

    const safePdfPath = shared.prtgPdfPath.replace(/\\/g, "\\\\");
    const outputTxtPath = path.join("data", "prtg", `extracted_text_${sanitizeClientName(shared.client_name)}.txt`);
    const safeOutputPath = outputTxtPath.replace(/\\/g, "/");
    shared.prtgExtractedTextPath = outputTxtPath;

    extractPdfTextNode.setParams({
      interpreterPath: path.join(process.cwd(), "venv", "Scripts", "python.exe"),
      requireConfirmation: false,
      code: `
import os
import pytesseract
from pdf2image import convert_from_path

pytesseract.pytesseract.tesseract_cmd = r'C:\\\\Program Files\\\\Tesseract-OCR\\\\tesseract.exe'
pdf_path = r'${safePdfPath}'
output_path = r'${safeOutputPath}'

images = convert_from_path(pdf_path, dpi=300)
extracted_text = ''
for i, image in enumerate(images):
    text = pytesseract.image_to_string(image)
    extracted_text += text + '\\n--- Page Break ---\\n'

os.makedirs(os.path.dirname(output_path), exist_ok=True)
with open(output_path, 'w', encoding='utf-8') as f:
    f.write(extracted_text)

print(f'Extracted pages: {len(images)}')
print(f'Wrote text to: {output_path}')
print(f'Extracted length: {len(extracted_text)}')
      `,
    });
  };

  extractPdfTextNode.postAsync = async (shared, prepRes, execRes) => {
    console.log("PRTG Parser: Completed PDF text extraction.");
    console.log("  Stdout:", execRes.stdout);
    console.log("  Stderr:", execRes.stderr);
    console.log("  Exit Code:", execRes.exitCode);
    if (execRes.exitCode !== 0) {
      throw new Error(`PRTG Parser: OCR extraction failed: ${execRes.stderr || "Unknown error"}`);
    }
  };

  const parsePrtgTextNode = new AsyncNode();
  parsePrtgTextNode.prepAsync = async (shared) => {
    if (!shared) shared = {};
    if (!shared.prtgExtractedTextPath) {
      throw new Error("PRTG Parser: Missing extracted text path.");
    }

    const absoluteExtractedPath = path.resolve(process.cwd(), shared.prtgExtractedTextPath);
    if (!fs.existsSync(absoluteExtractedPath)) {
      throw new Error(`PRTG Parser: Extracted text file not found at ${absoluteExtractedPath}`);
    }

    const extractedText = fs.readFileSync(absoluteExtractedPath, "utf8");
    const links = parsePrtgLinksFromText(extractedText);
    const summaryStats = computePrtgSummary(links);

    const parsed = {
      prtg_monitoring: {
        links,
        summary_stats: summaryStats,
      },
    };

    const extractedJsonPath = path.join("data", "prtg", `extracted_${sanitizeClientName(shared.client_name)}.json`);
    fs.writeFileSync(path.resolve(process.cwd(), extractedJsonPath), JSON.stringify(parsed, null, 2));
    console.log(`PRTG Parser: Deterministic extracted JSON written to ${extractedJsonPath}`);

    shared.prtgData = parsed;
    return shared;
  };

  const generateChartNode = new CodeInterpreterNode();
  generateChartNode.prepAsync = async (shared) => {
    if (!shared) shared = {};
    if (!shared.prtgData?.prtg_monitoring?.links) {
      throw new Error("PRTG Parser: Missing parsed link data for chart generation.");
    }

    const links = shared.prtgData.prtg_monitoring.links;
    const clientNameSanitized = sanitizeClientName(shared.client_name);
    const chartPathRelative = path.join("assets", `prtg_uptime_${clientNameSanitized}.png`);
    const chartPathForPython = chartPathRelative.replace(/\\/g, "/");
    shared.prtg_chart_path = chartPathRelative;

    const pythonCode = `
import matplotlib.pyplot as plt
import numpy as np
import os
import json

links_data = json.loads('''${escapeForPythonTripleQuoted(JSON.stringify(links))}''')
names = [link['name'] for link in links_data]
uptime = [float(str(link['uptime_percent']).replace('%', '').strip() or 0) for link in links_data]
downtime = [float(str(link['downtime_percent']).replace('%', '').strip() or 0) for link in links_data]

fig, ax = plt.subplots(figsize=(11, 6), dpi=300)
indices = np.arange(len(names))
width = 0.38

bars_uptime = ax.bar(indices - width/2, uptime, width, label='Uptime (%)', color='#4CAF50')
bars_downtime = ax.bar(indices + width/2, downtime, width, label='Downtime (%)', color='#E76F51')

ax.set_ylabel('Percentage (%)')
ax.set_title('PRTG Link Performance - ${shared.client_name}')
ax.set_xticks(indices)
ax.set_xticklabels(names, rotation=35, ha='right')
ax.set_ylim(0, max(100, max(uptime + downtime + [0]) * 1.15))
ax.legend()
ax.yaxis.grid(True, linestyle='--', alpha=0.4)
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)

for b in bars_uptime:
    v = b.get_height()
    ax.text(b.get_x() + b.get_width()/2, v + 0.8, f'{v:.1f}%', ha='center', va='bottom', fontsize=8)
for b in bars_downtime:
    v = b.get_height()
    ax.text(b.get_x() + b.get_width()/2, v + 0.8, f'{v:.1f}%', ha='center', va='bottom', fontsize=8)

fig.tight_layout()
os.makedirs(os.path.dirname(r"${chartPathForPython}"), exist_ok=True)
fig.savefig(r"${chartPathForPython}")
print("Chart saved to ${chartPathForPython}")
    `;

    generateChartNode.setParams({
      interpreterPath: path.join(process.cwd(), "venv", "Scripts", "python.exe"),
      requireConfirmation: false,
      code: pythonCode,
    });
    return shared;
  };

  generateChartNode.postAsync = async (shared, prepRes, execRes) => {
    if (execRes.exitCode !== 0) {
      throw new Error(`PRTG Parser: Chart generation failed: ${execRes.stderr || "Unknown error"}`);
    }
  };

  const formatOutputNode = new AsyncNode();
  formatOutputNode.prepAsync = async (shared) => {
    if (!shared) shared = {};
    if (!shared.prtgData || !shared.prtg_chart_path) {
      throw new Error("PRTG Parser: Missing parsed data or chart path for final output.");
    }

    const output = JSON.parse(JSON.stringify(shared.prtgData));
    output.prtg_monitoring.chart_path = shared.prtg_chart_path;

    const clientNameSanitized = sanitizeClientName(shared.client_name);
    const tempFilePath = path.join(process.cwd(), `temp_prtg_monitoring_output_${clientNameSanitized}.json`);

    fs.writeFileSync(tempFilePath, JSON.stringify(output, null, 2));
    shared.output_filepath = tempFilePath;
    console.log(`PRTG Parser: Wrote output to temporary file: ${tempFilePath}`);
    return shared;
  };

  flow
    .start(findAndProcessPrtgPdfNode)
    .next(extractPdfTextNode)
    .next(parsePrtgTextNode)
    .next(generateChartNode)
    .next(formatOutputNode);

  return flow;
}
