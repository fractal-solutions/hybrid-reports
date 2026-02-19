import { AsyncFlow, AsyncNode } from "@fractal-solutions/qflow";
import { CodeInterpreterNode } from "@fractal-solutions/qflow/nodes";
import fs from "fs";
import path from "path";

function sanitizeClientName(value) {
  return (value || "client").replace(/[^a-zA-Z0-9]/g, "_");
}

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

function tokenMatches(clientToken, folderTokens) {
  if (folderTokens.includes(clientToken)) return true;
  if (clientToken.length < 4) return false;
  const maxDistance = clientToken.length >= 8 ? 2 : 1;
  for (const token of folderTokens) {
    if (Math.abs(token.length - clientToken.length) > maxDistance) continue;
    if (levenshteinDistance(clientToken, token) <= maxDistance) return true;
  }
  return false;
}

function folderMatchScore(clientName, folderName) {
  const clientTokens = tokenizeForMatch(clientName);
  const folderTokens = tokenizeForMatch(folderName);
  if (clientTokens.length === 0 || folderTokens.length === 0) return 0;
  let matched = 0;
  for (const clientToken of clientTokens) {
    if (tokenMatches(clientToken, folderTokens)) matched += 1;
  }
  return matched / clientTokens.length;
}

function parseHeaderValue(csvText, label) {
  const regex = new RegExp(`^\\uFEFF?${label},(.*)$`, "mi");
  const match = csvText.match(regex);
  return match ? match[1].trim() : "";
}

function findHeaderIndex(lines, headerPrefix) {
  const needle = headerPrefix.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

function parsePercent(value) {
  return Number.parseFloat(String(value || "").replace("%", "").replace(/\s+/g, "")) || 0;
}

function parseHits(value) {
  return Number.parseFloat(String(value || "").replace(/,/g, "").replace(/\s+/g, "")) || 0;
}

function bytesToMB(value) {
  const cleaned = String(value || "").trim();
  const match = cleaned.match(/^([0-9][0-9,]*(?:\.[0-9]+)?)\s*(TB|GB|MB|KB|B)$/i);
  if (!match) return 0;
  const n = Number.parseFloat(match[1].replace(/,/g, ""));
  const unit = match[2].toUpperCase();
  if (unit === "TB") return n * 1024 * 1024;
  if (unit === "GB") return n * 1024;
  if (unit === "MB") return n;
  if (unit === "KB") return n / 1024;
  if (unit === "B") return n / (1024 * 1024);
  return 0;
}

function parseSophosTableRows(csvText, type) {
  const lines = csvText.split(/\r?\n/);
  let headerPrefix = "";
  if (type === "applications") headerPrefix = "Application/Proto:Port,";
  if (type === "application_categories") headerPrefix = "Category,Bytes,Percent";
  if (type === "web_categories") headerPrefix = "Category,Hits,Percent";
  if (type === "web_domains") headerPrefix = "Domain,Bytes,Percent";

  const headerIdx = findHeaderIndex(lines, headerPrefix);
  if (headerIdx < 0) return [];

  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    if (/^(Start Date|End Date|Server Time|Appliance|Firmware Version|Reports|Criteria)/i.test(raw)) break;
    const parts = raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length < 3) continue;

    if (type === "applications") {
      if (parts.length < 5) continue;
      const name = parts[0];
      const category = parts[1];
      const risk = parts[2];
      const percent = parts[parts.length - 1];
      const bytes = parts.slice(3, parts.length - 1).join(",");
      rows.push({
        name,
        category,
        risk,
        bytes,
        bytes_mb: bytesToMB(bytes),
        percent_value: parsePercent(percent),
        percent,
      });
      continue;
    }

    if (type === "application_categories") {
      const name = parts[0];
      const percent = parts[parts.length - 1];
      const bytes = parts.slice(1, parts.length - 1).join(",");
      rows.push({
        name,
        bytes,
        bytes_mb: bytesToMB(bytes),
        percent_value: parsePercent(percent),
        percent,
      });
      continue;
    }

    if (type === "web_categories") {
      const name = parts[0];
      const percent = parts[parts.length - 1];
      const hits = parts.slice(1, parts.length - 1).join(",");
      rows.push({
        name,
        hits,
        hits_value: parseHits(hits),
        percent_value: parsePercent(percent),
        percent,
      });
      continue;
    }

    if (type === "web_domains") {
      const name = parts[0];
      const percent = parts[parts.length - 1];
      const bytes = parts.slice(1, parts.length - 1).join(",");
      rows.push({
        name,
        bytes,
        bytes_mb: bytesToMB(bytes),
        percent_value: parsePercent(percent),
        percent,
      });
    }
  }

  return rows;
}

function topN(rows, metricKey, n = 10) {
  return [...rows]
    .sort((a, b) => (b[metricKey] || 0) - (a[metricKey] || 0))
    .slice(0, n);
}

function rowsToHtmlList(rows, formatter) {
  if (!rows || rows.length === 0) return "<li>No data available.</li>";
  return rows.map((row) => `<li>${formatter(row)}</li>`).join("\n");
}

function buildSophosDeterministicReview(appRows, appCategoryRows) {
  const reviews = [];
  if (!Array.isArray(appRows) || appRows.length === 0 || !Array.isArray(appCategoryRows) || appCategoryRows.length === 0) {
    return ["Insufficient Sophos application/category data to produce deterministic review points."];
  }

  const byTrafficApps = [...appRows].sort((a, b) => (b.bytes_mb || 0) - (a.bytes_mb || 0));
  const byTrafficCategories = [...appCategoryRows].sort((a, b) => (b.bytes_mb || 0) - (a.bytes_mb || 0));

  const topApp = byTrafficApps[0];
  const topCategory = byTrafficCategories[0];
  if (topApp) {
    reviews.push(
      `Top application by traffic is ${topApp.name} (${topApp.bytes}, ${topApp.percent}), which should be treated as a primary policy and monitoring target.`
    );
  }
  if (topCategory) {
    reviews.push(
      `Top application category is ${topCategory.name} (${topCategory.bytes}, ${topCategory.percent}); validate that its bandwidth aligns with intended business use.`
    );
  }

  const othersApp = byTrafficApps.find((r) => String(r.name || "").toLowerCase() === "others");
  if (othersApp && (othersApp.percent_value || 0) >= 20) {
    reviews.push(
      `"Others" accounts for ${othersApp.percent}; refine application signatures/policies to improve traffic attribution and reduce blind spots.`
    );
  }

  const highRiskApps = byTrafficApps.filter((r) => Number.parseInt(String(r.risk), 10) >= 3);
  const highRiskShare = highRiskApps.reduce((sum, r) => sum + (r.percent_value || 0), 0);
  if (highRiskShare >= 20) {
    reviews.push(
      `High-risk applications (risk >= 3) contribute ${highRiskShare.toFixed(2)}% of observed traffic; prioritize stricter controls and exception reviews for these flows.`
    );
  }

  const internetLeisureSet = new Set(["streaming media", "social networking", "entertainment", "games"]);
  const internetLeisureShare = byTrafficCategories
    .filter((r) => internetLeisureSet.has(String(r.name || "").toLowerCase()))
    .reduce((sum, r) => sum + (r.percent_value || 0), 0);
  if (internetLeisureShare >= 25) {
    reviews.push(
      `Streaming/Social/Entertainment categories represent ${internetLeisureShare.toFixed(2)}% of traffic; apply QoS and time-based policy controls to protect business-critical performance.`
    );
  }

  if (reviews.length < 4) {
    reviews.push("Track month-on-month top application/category drift to detect abnormal traffic shifts early.");
  }

  return reviews.slice(0, 6);
}

export function sophos_fwParserWorkflow() {
  const flow = new AsyncFlow();

  const findSophosFolderNode = new AsyncNode();
  findSophosFolderNode.prepAsync = async (shared) => {
    if (!shared) shared = {};
    if (!shared.client_name) throw new Error("Sophos Parser: Missing client_name.");

    const baseDataDir = shared.data_directory
      ? path.resolve(process.cwd(), shared.data_directory)
      : path.join(process.cwd(), "data");
    const sophosRoot = path.join(baseDataDir, "SOPHOS");
    if (!fs.existsSync(sophosRoot)) {
      throw new Error(`Sophos Parser: SOPHOS folder not found at ${sophosRoot}`);
    }

    const subdirs = fs
      .readdirSync(sophosRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    if (subdirs.length === 0) {
      throw new Error(`Sophos Parser: No client subfolders found in ${sophosRoot}`);
    }

    let best = subdirs[0];
    let bestScore = -1;
    for (const folderName of subdirs) {
      const score = folderMatchScore(shared.client_name, folderName);
      if (score > bestScore) {
        best = folderName;
        bestScore = score;
      }
    }

    shared.sophosFolderPath = path.join(sophosRoot, best);
    shared.sophosFolderName = best;
    console.log(`Sophos Parser: Selected folder "${best}" for client "${shared.client_name}" (score=${bestScore.toFixed(2)})`);
    return shared;
  };

  const parseSophosCsvNode = new AsyncNode();
  parseSophosCsvNode.prepAsync = async (shared) => {
    if (!shared) shared = {};
    const folderPath = shared.sophosFolderPath;
    if (!folderPath) throw new Error("Sophos Parser: Missing selected folder path.");

    const requiredFiles = {
      applications: "Applications.csv",
      application_categories: "Application Categories.csv",
      web_categories: "Web Categories.csv",
      web_domains: "Web Domains.csv",
    };

    const fileContents = {};
    for (const [key, fileName] of Object.entries(requiredFiles)) {
      const filePath = path.join(folderPath, fileName);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Sophos Parser: Required file missing: ${filePath}`);
      }
      fileContents[key] = fs.readFileSync(filePath, "utf8");
    }

    const reportWindow = {
      start: parseHeaderValue(fileContents.applications, "Start Date"),
      end: parseHeaderValue(fileContents.applications, "End Date"),
    };

    const appRows = parseSophosTableRows(fileContents.applications, "applications");
    const appCategoryRows = parseSophosTableRows(fileContents.application_categories, "application_categories");
    const webCategoryRows = parseSophosTableRows(fileContents.web_categories, "web_categories");
    const webDomainRows = parseSophosTableRows(fileContents.web_domains, "web_domains");

    const topApplications = topN(appRows, "bytes_mb", 10);
    const topAppCategories = topN(appCategoryRows, "bytes_mb", 10);
    const topWebCategories = topN(webCategoryRows, "hits_value", 10);
    const topWebDomains = topN(webDomainRows, "bytes_mb", 10);
    const deterministicReview = buildSophosDeterministicReview(appRows, appCategoryRows);

    const clientNameSanitized = sanitizeClientName(shared.client_name);
    const paths = {
      applications: `assets/sophos_applications_${clientNameSanitized}.png`,
      application_categories: `assets/sophos_app_categories_${clientNameSanitized}.png`,
      web_categories: `assets/sophos_web_categories_${clientNameSanitized}.png`,
      web_domains: `assets/sophos_web_domains_${clientNameSanitized}.png`,
    };

    shared.sophosData = {
      sophos_fw: {
        source_folder: shared.sophosFolderName,
        report_window: reportWindow,
        applications: {
          chart_path: paths.applications,
          top: topApplications.map((r) => ({
            name: r.name,
            bytes: r.bytes,
            bytes_mb: r.bytes_mb,
            percent: r.percent,
            percent_value: r.percent_value,
            category: r.category,
            risk: r.risk,
          })),
          top_html: rowsToHtmlList(topApplications.slice(0, 5), (r) => `${r.name} (${r.bytes}, ${r.percent})`),
        },
        application_categories: {
          chart_path: paths.application_categories,
          top: topAppCategories.map((r) => ({
            name: r.name,
            bytes: r.bytes,
            bytes_mb: r.bytes_mb,
            percent: r.percent,
            percent_value: r.percent_value,
          })),
          top_html: rowsToHtmlList(topAppCategories.slice(0, 5), (r) => `${r.name} (${r.bytes}, ${r.percent})`),
        },
        web_categories: {
          chart_path: paths.web_categories,
          top: topWebCategories.map((r) => ({
            name: r.name,
            hits: r.hits,
            hits_value: r.hits_value,
            percent: r.percent,
            percent_value: r.percent_value,
          })),
          top_html: rowsToHtmlList(topWebCategories.slice(0, 5), (r) => `${r.name} (${r.hits} hits, ${r.percent})`),
        },
        web_domains: {
          chart_path: paths.web_domains,
          top: topWebDomains.map((r) => ({
            name: r.name,
            bytes: r.bytes,
            bytes_mb: r.bytes_mb,
            percent: r.percent,
            percent_value: r.percent_value,
          })),
          top_html: rowsToHtmlList(topWebDomains.slice(0, 5), (r) => `${r.name} (${r.bytes}, ${r.percent})`),
        },
        review: deterministicReview,
      },
    };

    return shared;
  };

  const generateChartsNode = new CodeInterpreterNode();
  generateChartsNode.prepAsync = async (shared) => {
    if (!shared?.sophosData?.sophos_fw) {
      throw new Error("Sophos Parser: Missing parsed Sophos data.");
    }

    const d = shared.sophosData.sophos_fw;
    const payload = {
      applications: d.applications.top,
      app_categories: d.application_categories.top,
      web_categories: d.web_categories.top,
      web_domains: d.web_domains.top,
      paths: {
        applications: d.applications.chart_path.replace(/\\/g, "/"),
        application_categories: d.application_categories.chart_path.replace(/\\/g, "/"),
        web_categories: d.web_categories.chart_path.replace(/\\/g, "/"),
        web_domains: d.web_domains.chart_path.replace(/\\/g, "/"),
      },
    };

    const pythonCode = `
import os
import json
import numpy as np
import matplotlib.pyplot as plt

data = json.loads(r'''${JSON.stringify(payload).replace(/\\/g, "\\\\").replace(/'''/g, "\\'\\'\\'")}''')
PRIMARY = "#0047AB"
PRIMARY_ALT = "#0F66D7"
ACCENT = "#FF5733"
SURFACE = "#f4f4f4"
LIGHT = "#e6ecf5"
TEXT = "#222222"
MUTED = "#5b6878"

plt.rcParams["font.family"] = "DejaVu Sans"
plt.rcParams["axes.titlesize"] = 13
plt.rcParams["axes.labelsize"] = 10
plt.rcParams["xtick.labelsize"] = 9
plt.rcParams["ytick.labelsize"] = 9

def style_ax(fig, ax, title, xlabel):
    fig.patch.set_facecolor("white")
    ax.set_facecolor(SURFACE)
    ax.set_title(title, color=TEXT, pad=12, fontweight="bold")
    ax.set_xlabel(xlabel, color=TEXT)
    ax.grid(axis="x", color=LIGHT, linestyle="-", linewidth=1.0, alpha=0.9)
    ax.set_axisbelow(True)
    for side in ["top", "right"]:
        ax.spines[side].set_visible(False)
    ax.spines["left"].set_color(LIGHT)
    ax.spines["bottom"].set_color(LIGHT)
    ax.tick_params(colors=MUTED)

def draw_horizontal(entries, metric_key, title, xlabel, path):
    if not entries:
        fig, ax = plt.subplots(figsize=(9.0, 4.3), dpi=300)
        style_ax(fig, ax, title, xlabel)
        ax.text(0.5, 0.5, "No data available", transform=ax.transAxes, ha="center", va="center", color=MUTED)
        fig.tight_layout()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fig.savefig(path, dpi=300)
        plt.close(fig)
        return

    labels = [e["name"] for e in entries][:10]
    values = [float(e.get(metric_key, 0) or 0) for e in entries][:10]

    fig, ax = plt.subplots(figsize=(9.0, 4.4), dpi=300)
    style_ax(fig, ax, title, xlabel)
    ypos = np.arange(len(labels))
    colors = [PRIMARY if i % 2 == 0 else PRIMARY_ALT for i in range(len(labels))]
    bars = ax.barh(ypos, values, color=colors, edgecolor="white", linewidth=1.0)
    ax.set_yticks(ypos)
    ax.set_yticklabels(labels)
    ax.invert_yaxis()

    x_pad = (max(values) * 0.02) if max(values) > 0 else 0.1
    for b, v in zip(bars, values):
        ax.text(v + x_pad, b.get_y() + b.get_height()/2, f"{v:.2f}", va="center", ha="left", fontsize=8, color=TEXT, fontweight="bold")

    fig.tight_layout()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fig.savefig(path, dpi=300)
    plt.close(fig)

draw_horizontal(data["applications"], "bytes_mb", "Top Applications by Traffic", "Traffic (MB)", data["paths"]["applications"])
draw_horizontal(data["app_categories"], "bytes_mb", "Top Application Categories by Traffic", "Traffic (MB)", data["paths"]["application_categories"])
draw_horizontal(data["web_categories"], "hits_value", "Top Web Categories by Hits", "Hits", data["paths"]["web_categories"])
draw_horizontal(data["web_domains"], "bytes_mb", "Top Web Domains by Traffic", "Traffic (MB)", data["paths"]["web_domains"])

print("Sophos charts generated.")
    `;

    generateChartsNode.setParams({
      interpreterPath: path.join(process.cwd(), "venv", "Scripts", "python.exe"),
      requireConfirmation: false,
      code: pythonCode,
    });
    return shared;
  };

  generateChartsNode.postAsync = async (shared, prepRes, execRes) => {
    if (execRes.exitCode !== 0) {
      throw new Error(`Sophos Parser: Chart generation failed: ${execRes.stderr || "Unknown error"}`);
    }
  };

  const formatOutputNode = new AsyncNode();
  formatOutputNode.prepAsync = async (shared) => {
    if (!shared?.sophosData) throw new Error("Sophos Parser: Missing sophosData.");
    const clientNameSanitized = sanitizeClientName(shared.client_name);
    const tempFilePath = path.join(process.cwd(), `temp_sophos_fw_output_${clientNameSanitized}.json`);
    fs.writeFileSync(tempFilePath, JSON.stringify(shared.sophosData, null, 2));
    shared.output_filepath = tempFilePath;
    console.log(`Sophos Parser: Wrote output to temporary file: ${tempFilePath}`);
    return shared;
  };

  flow
    .start(findSophosFolderNode)
    .next(parseSophosCsvNode)
    .next(generateChartsNode)
    .next(formatOutputNode);

  return flow;
}
