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
  const hmsMatch = duration.match(/^(\d+)h\s+(\d+)m\s+(\d+)s$/i);
  if (hmsMatch) {
    const h = Number.parseInt(hmsMatch[1], 10);
    const m = Number.parseInt(hmsMatch[2], 10);
    const s = Number.parseInt(hmsMatch[3], 10);
    return h * 3600 + m * 60 + s;
  }
  const msMatch = duration.match(/^(\d+)m\s+(\d+)s$/i);
  if (msMatch) {
    const m = Number.parseInt(msMatch[1], 10);
    const s = Number.parseInt(msMatch[2], 10);
    return m * 60 + s;
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

function cleanPrtgLine(value) {
  return String(value || "")
    .replace(/[^\x00-\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDurationPercentPairsFromBlock(lines) {
  const pairs = [];
  const pairRegex = /\[\s*(\d+d\s+\d+h\s+\d+m\s+\d+s|\d+h\s+\d+m\s+\d+s|\d+m\s+\d+s|\d+s)\s+(\d+(?:\.\d+)?)\s*%/i;
  for (const line of lines) {
    const m = line.match(pairRegex);
    if (m) {
      pairs.push({
        duration: m[1],
        percent: Number.parseFloat(m[2]),
      });
    }
  }
  return pairs;
}

function parseMetricsFromBlockText(blockText) {
  const metricRegex = /(<\s*)?(\d[\d,]*(?:\.\d+)?)\s*(Mbit\/s|MB|msec)\b/gi;
  const metrics = [];
  let m = metricRegex.exec(blockText);
  while (m) {
    metrics.push({
      value: `${(m[1] || "").trim() ? `${(m[1] || "").trim()} ` : ""}${m[2]} ${m[3]}`
        .replace(/\s+/g, " ")
        .trim(),
      unit: m[3].toLowerCase(),
    });
    m = metricRegex.exec(blockText);
  }
  return metrics;
}

function extractNameFromSensorLine(line) {
  const nameRegex = /^(.*?)\s+(?:<\s*)?\d[\d,]*(?:\.\d+)?\s*(?:Mbit\/s|MB|msec)\b/i;
  const m = line.match(nameRegex);
  if (!m) return null;
  return m[1].replace(/\s+/g, " ").trim();
}

function parseEntryFromBlock(blockLines, reportWindowSeconds) {
  const lines = blockLines.map(cleanPrtgLine).filter(Boolean);
  if (lines.length === 0) return null;

  const compactLines = lines.filter(
    (line) =>
      !/^Local Probe \(Local Probe\)/i.test(line) &&
      !/^Serenity Spa Links\s*»?$/i.test(line) &&
      !/^PAESSLER/i.test(line) &&
      !/^Report\s*\(/i.test(line)
  );
  if (compactLines.length === 0) return null;

  const blockText = compactLines.join(" ");
  if (!/(Mbit\/s|MB|msec)/i.test(blockText)) return null;

  // Prefer a non-summary sensor line (not "Serenity Spa Links ...").
  let sensorLine = compactLines.find(
    (line) =>
      /(Mbit\/s|MB|msec)/i.test(line) &&
      !/^Serenity Spa Links/i.test(line) &&
      !/^CIM Credit Kenya/i.test(line)
  );
  if (!sensorLine) {
    sensorLine = compactLines.find((line) => /(Mbit\/s|MB|msec)/i.test(line)) || "";
  }

  let name = extractNameFromSensorLine(sensorLine) || "";
  // Handle wrapped names like "... (Tigoni" + next line starts with "DD) Ping ..."
  if (name && /\([^)]+$/i.test(name)) {
    const next = compactLines.find((line) => /^\w+\)\s+/i.test(line));
    if (next) {
      name = `${name} ${next.split(/\s+/)[0]}`.replace(/\s+/g, " ").trim();
    }
  }
  // Handle OCR wrap where current name starts with a dangling suffix e.g. "DD) Ping".
  if (/^\w+\)\s+/i.test(name)) {
    const prefixLine = compactLines.find((line) => {
      const open = (line.match(/\(/g) || []).length;
      const close = (line.match(/\)/g) || []).length;
      return open > close;
    });
    if (prefixLine) {
      const prefix = prefixLine.split(/\d+(?:\.\d+)?\s*%/)[0].trim();
      if (prefix) {
        name = `${prefix} ${name}`.replace(/\s+/g, " ").trim();
      }
    }
  }
  name = name.replace(/^Serenity Spa Links\s*»?\s*/i, "").trim();
  if (!name || /^Serenity Spa Links/i.test(name) || /^CIM Credit Kenya/i.test(name)) {
    return null;
  }

  const metricCandidates = parseMetricsFromBlockText(blockText);
  const avgMetric = metricCandidates.find((metric) => metric.unit === "mbit/s" || metric.unit === "msec");
  const dataMetric = metricCandidates.find((metric) => metric.unit === "mb");
  const avg_bandwidth = avgMetric ? avgMetric.value : "N/A";
  const total_data = dataMetric ? dataMetric.value : "N/A";

  const pairs = parseDurationPercentPairsFromBlock(compactLines);
  const uptimePair = pairs[0] || null;
  const downtimePair = pairs[1] || null;
  const uptimeDuration = uptimePair?.duration || "N/A";
  let downtimeDuration = downtimePair?.duration || "N/A";

  let uptimePct = Number.isFinite(uptimePair?.percent) ? uptimePair.percent : null;
  let downtimePct = Number.isFinite(downtimePair?.percent) ? downtimePair.percent : null;

  const upSeconds = parseDurationToSeconds(uptimeDuration);
  const downSeconds = parseDurationToSeconds(downtimeDuration);
  if (reportWindowSeconds && Number.isFinite(upSeconds) && Number.isFinite(downSeconds) && upSeconds + downSeconds > 0) {
    const upFromDur = (upSeconds / (upSeconds + downSeconds)) * 100;
    const downFromDur = 100 - upFromDur;
    uptimePct = upFromDur;
    downtimePct = downFromDur;
  } else if (reportWindowSeconds && Number.isFinite(upSeconds) && upSeconds >= 0) {
    const upFromWindow = (upSeconds / reportWindowSeconds) * 100;
    uptimePct = upFromWindow;
    downtimePct = 100 - upFromWindow;
    downtimeDuration = durationSecondsToDhms(Math.max(0, reportWindowSeconds - upSeconds));
  } else if (Number.isFinite(uptimePct) && !Number.isFinite(downtimePct)) {
    downtimePct = 100 - uptimePct;
  } else if (!Number.isFinite(uptimePct) && Number.isFinite(downtimePct)) {
    uptimePct = 100 - downtimePct;
  }

  const finalUptime = Number.isFinite(uptimePct) ? numberToPercentString(uptimePct) : "0%";
  const finalDowntime = Number.isFinite(downtimePct) ? numberToPercentString(downtimePct) : "0%";

  return {
    name,
    avg_bandwidth,
    total_data,
    uptime_percent: finalUptime,
    downtime_percent: finalDowntime,
    uptime_duration: uptimeDuration,
    downtime_duration: downtimeDuration,
  };
}

function parsePrtgLinksFromText(text) {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((line) => cleanPrtgLine(line))
    .filter(Boolean);
  const reportWindowSeconds = parseReportWindowSeconds(text);

  // Split by Local Probe markers to parse sensor blocks in multiline OCR.
  const blocks = [];
  let currentBlock = [];
  for (const line of lines) {
    if (/^Local Probe \(Local Probe\)/i.test(line)) {
      if (currentBlock.length > 0) blocks.push(currentBlock);
      currentBlock = [line];
      continue;
    }
    if (currentBlock.length > 0) {
      currentBlock.push(line);
    }
  }
  if (currentBlock.length > 0) blocks.push(currentBlock);

  const candidates = [];
  for (const block of blocks) {
    const parsed = parseEntryFromBlock(block, reportWindowSeconds);
    if (parsed) candidates.push(parsed);
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
