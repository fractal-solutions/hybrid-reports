import fs from "fs";
import path from "path";

const agentPath = path.join(
  process.cwd(),
  "node_modules",
  "@fractal-solutions",
  "qflow",
  "dist",
  "agent",
  "agent.js"
);

if (!fs.existsSync(agentPath)) {
  console.error(`patch_agent: Cannot find ${agentPath}`);
  process.exit(1);
}

const original = fs.readFileSync(agentPath, "utf-8");
let updated = original;

const target = "requireFinishConfirmation = true";
const replacement = "requireFinishConfirmation = false";

if (updated.includes(target)) {
  updated = updated.replace(target, replacement);
} else if (updated.includes(replacement)) {
  console.log("patch_agent: Agent already patched.");
  process.exit(0);
} else {
  console.error("patch_agent: Expected constructor default not found. Patch not applied.");
  process.exit(1);
}

if (updated === original) {
  console.log("patch_agent: No changes made.");
  process.exit(0);
}

fs.writeFileSync(agentPath, updated, "utf-8");
console.log("patch_agent: Patched AgentNode finish confirmation default to false.");
