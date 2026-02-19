import { AsyncFlow, AsyncNode } from "@fractal-solutions/qflow";
import fs from "fs";
import path from "path";

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

function scoreClientMatch(clientName, fileName) {
  const clientTokens = tokenizeForMatch(clientName);
  const fileTokens = tokenizeForMatch(fileName);
  if (clientTokens.length === 0 || fileTokens.length === 0) return 0;

  const joinedClient = clientTokens.join("");
  const joinedFile = fileTokens.join("");
  let matched = 0;
  for (const token of clientTokens) {
    if (tokenMatches(token, fileTokens)) matched += 1;
  }

  // Base score from token coverage
  let score = matched / clientTokens.length;

  // Bonus when compacted names contain each other (handles naming style differences)
  if (joinedFile.includes(joinedClient) || joinedClient.includes(joinedFile)) {
    score += 0.25;
  }

  return Math.min(1, score);
}

function sanitizeClientName(value) {
  return (value || "client").replace(/[^a-zA-Z0-9]/g, "_");
}

function toWorkspaceRelative(p) {
  return path.relative(process.cwd(), p).replace(/\\/g, "/");
}

export function datto_saasParserWorkflow() {
  const flow = new AsyncFlow();

  const findScreenshotNode = new AsyncNode();
  findScreenshotNode.prepAsync = async (shared) => {
    if (!shared) shared = {};
    if (!shared.client_name) {
      throw new Error("Datto SaaS Parser: Missing client_name.");
    }

    const baseDataDir = shared.data_directory
      ? path.resolve(process.cwd(), shared.data_directory)
      : path.join(process.cwd(), "data");
    const dattoSaasDir = path.join(baseDataDir, "datto_saas");
    if (!fs.existsSync(dattoSaasDir)) {
      throw new Error(`Datto SaaS Parser: Folder not found: ${dattoSaasDir}`);
    }

    const allowedExt = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);
    const files = fs
      .readdirSync(dattoSaasDir)
      .filter((f) => allowedExt.has(path.extname(f).toLowerCase()))
      .map((f) => path.join(dattoSaasDir, f));

    if (files.length === 0) {
      throw new Error(`Datto SaaS Parser: No screenshot images found in ${dattoSaasDir}`);
    }

    let bestPath = null;
    let bestScore = -1;
    for (const filePath of files) {
      const base = path.basename(filePath, path.extname(filePath));
      const score = scoreClientMatch(shared.client_name, base);
      if (score > bestScore) {
        bestScore = score;
        bestPath = filePath;
      }
    }

    if (!bestPath && files.length === 1) {
      bestPath = files[0];
    }

    if (!bestPath || (files.length > 1 && bestScore < 0.34)) {
      throw new Error(
        `Datto SaaS Parser: Could not confidently match a screenshot for client '${shared.client_name}' in ${dattoSaasDir}.`
      );
    }

    shared.datto_saas_image_path = bestPath;
    console.log(`Datto SaaS Parser: Selected screenshot ${bestPath}`);
    return shared;
  };

  const formatOutputNode = new AsyncNode();
  formatOutputNode.prepAsync = async (shared) => {
    if (!shared?.datto_saas_image_path) {
      throw new Error("Datto SaaS Parser: Missing screenshot path.");
    }

    const relPath = toWorkspaceRelative(shared.datto_saas_image_path);
    const imageName = path.basename(shared.datto_saas_image_path);
    const output = {
      datto_saas: {
        screenshot_path: relPath,
        source_filename: imageName,
        summary_note:
          "Offsite backup status is presented directly from the Datto SaaS dashboard screenshot for source-of-truth visibility.",
      },
    };

    const clientNameSanitized = sanitizeClientName(shared.client_name);
    const tempFilePath = path.join(process.cwd(), `temp_datto_saas_output_${clientNameSanitized}.json`);
    fs.writeFileSync(tempFilePath, JSON.stringify(output, null, 2));
    shared.output_filepath = tempFilePath;
    console.log(`Datto SaaS Parser: Wrote output to temporary file: ${tempFilePath}`);
    return shared;
  };

  flow.start(findScreenshotNode).next(formatOutputNode);
  return flow;
}
