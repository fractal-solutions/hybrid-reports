import fs from "fs";
import path from "path";

const qflowRoot = path.join(
  process.cwd(),
  "node_modules",
  "@fractal-solutions",
  "qflow"
);

function ensureExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`patch_qflow: Cannot find ${filePath}`);
  }
}

function removeLinesContaining(content, needles) {
  const lines = content.split(/\r?\n/);
  const filtered = lines.filter((line) => !needles.some((needle) => line.includes(needle)));
  return filtered.join("\n");
}

function patchFile(filePath, transform) {
  ensureExists(filePath);
  const original = fs.readFileSync(filePath, "utf-8");
  const updated = transform(original);
  if (updated !== original) {
    fs.writeFileSync(filePath, updated, "utf-8");
    return true;
  }
  return false;
}

function patchPackageJson(filePath) {
  ensureExists(filePath);
  const originalRaw = fs.readFileSync(filePath, "utf-8");
  const pkg = JSON.parse(originalRaw);
  pkg.dependencies = pkg.dependencies || {};

  let changed = false;
  for (const dep of ["ssh2", "serialport", "@serialport/parser-readline"]) {
    if (Object.prototype.hasOwnProperty.call(pkg.dependencies, dep)) {
      delete pkg.dependencies[dep];
      changed = true;
    }
  }

  if (!changed) return false;
  fs.writeFileSync(filePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
  return true;
}

try {
  ensureExists(qflowRoot);

  const targets = [
    {
      file: path.join(qflowRoot, "dist", "nodes", "index.js"),
      needles: ["hardware_interaction.js", "remote_execution.js"],
    },
    {
      file: path.join(qflowRoot, "dist", "nodes", "index.d.ts"),
      needles: ["hardware_interaction.js", "remote_execution.js"],
    },
    {
      file: path.join(qflowRoot, "dist", "agent", "tools.js"),
      needles: [
        "HardwareInteractionNode",
        "RemoteExecutionNode",
        "hardware_interaction.js",
        "remote_execution.js",
      ],
    },
  ];

  let changedCount = 0;
  for (const target of targets) {
    const changed = patchFile(target.file, (content) =>
      removeLinesContaining(content, target.needles)
    );
    if (changed) {
      changedCount += 1;
      console.log(`patch_qflow: Patched ${target.file}`);
    } else {
      console.log(`patch_qflow: No changes needed for ${target.file}`);
    }
  }

  const pkgPath = path.join(qflowRoot, "package.json");
  const pkgChanged = patchPackageJson(pkgPath);
  if (pkgChanged) {
    changedCount += 1;
    console.log(`patch_qflow: Removed ssh2/serialport deps from ${pkgPath}`);
  } else {
    console.log(`patch_qflow: No dependency removals needed for ${pkgPath}`);
  }

  if (changedCount === 0) {
    console.log("patch_qflow: Already patched.");
  } else {
    console.log("patch_qflow: Patch applied successfully.");
  }
} catch (error) {
  console.error(`patch_qflow: ${error.message}`);
  process.exit(1);
}
