import { AsyncFlow, AsyncNode } from "@fractal-solutions/qflow";
import {
  AgentNode,
  PDFProcessorNode,
  CodeInterpreterNode,
  ShellCommandNode,
} from "@fractal-solutions/qflow/nodes";
import { GenericLLMNode } from "../nodes/GenericLLMNode.js";
import path from "path";
import process from "process";
import fs from "fs";

// This is a self-contained parser module for PRTG Monitoring data.
export function prtg_monitoringParserWorkflow() {
  // --- LLM Configuration ---
  const AGENT_LLM_API_KEY = process.env.AGENT_LLM_API_KEY;
  const AGENT_LLM_MODEL = process.env.AGENT_LLM_MODEL;
  const AGENT_LLM_BASE_URL = process.env.AGENT_LLM_BASE_URL;

  if (!AGENT_LLM_API_KEY) {
    throw new Error("AGENT_LLM_API_KEY is not set.");
  }

  // 1. Instantiate the LLM for the agent's reasoning
  const agentLLM = new GenericLLMNode();
  agentLLM.setParams({
    model: AGENT_LLM_MODEL,
    apiKey: AGENT_LLM_API_KEY,
    baseUrl: AGENT_LLM_BASE_URL,
  });



  // 2. Node to find and process the PRTG PDF
  const findAndProcessPrtgPdfNode = new AsyncNode();
  findAndProcessPrtgPdfNode.prepAsync = async (shared) => {
    if (typeof shared === 'undefined' || shared === null) { shared = {}; } // Defensive
    
    if (!shared.data_directory || !shared.client_name) {
        throw new Error("PRTG Parser: Missing data_directory or client_name in shared object.");
    }

    const prtgDataDir = path.join(shared.data_directory, 'prtg');
    let prtgPdfPath = null;

    // Dynamically find the PRTG PDF file for the client
    try {
        const files = fs.readdirSync(prtgDataDir);
        const clientNameRegex = new RegExp(shared.client_name.replace(/[^a-zA-Z0-9]/g, '.*'), 'i');
        const pdfFile = files.find(file => 
            file.toLowerCase().includes('prtg') && 
            file.toLowerCase().endsWith('.pdf') &&
            clientNameRegex.test(file) // Match client name in file name
        );

        if (pdfFile) {
            prtgPdfPath = path.join(prtgDataDir, pdfFile);
            console.log(`PRTG Parser: Found PDF for ${shared.client_name} at ${prtgPdfPath}`);
        } else {
            console.warn(`PRTG Parser: Could not find PRTG PDF for ${shared.client_name} in ${prtgDataDir}.`);
            throw new Error(`PRTG Parser: No matching PDF found for client ${shared.client_name} in ${prtgDataDir}.`);
        }
    } catch (e) {
        console.error(`PRTG Parser: Error accessing ${prtgDataDir}: ${e.message}`);
        throw e;
    }
    shared.prtgPdfPath = prtgPdfPath;
    return shared;
  };

    const extractPdfTextNode = new CodeInterpreterNode();
    extractPdfTextNode.prepAsync = async (shared) => {
      if (typeof shared === 'undefined' || shared === null) { shared = {}; } // Defensive
      if (!shared.prtgPdfPath) {
          throw new Error("PRTG Parser: Missing prtgPdfPath in shared object for PDF text extraction.");
      }
    // Escape backslashes for the Python string
      const safePdfPath = shared.prtgPdfPath.replace(/\\/g, '\\\\');
      extractPdfTextNode.setParams({
        interpreterPath: path.join(process.cwd(), "venv", "Scripts", "python.exe"),
        requireConfirmation: false,
        code: `
import os
import pytesseract 
from pdf2image import convert_from_path
import re

# Set Tesseract path if needed
pytesseract.pytesseract.tesseract_cmd = r'C:\\\\Program Files\\\\Tesseract-OCR\\\\tesseract.exe'

pdf_path = r'${safePdfPath}'

# Convert PDF to images
print('Converting PDF to images...')
images = convert_from_path(pdf_path, dpi=300)
print(f'Number of pages: {len(images)}')

# Extract text from each image
extracted_text = ''
for i, image in enumerate(images):
    print(f'Processing page {i+1}...')
    text = pytesseract.image_to_string(image)
    extracted_text += text + '\\n--- Page Break ---\\n'

# Save extracted text to a file for inspection
# Ensure the directory exists
os.makedirs('data/PRTG', exist_ok=True)
with open('data/PRTG/extracted_text.txt', 'w', encoding='utf-8') as f:
    f.write(extracted_text)

print('Text extraction complete. First 2000 chars:')
print(extracted_text[:2000])`

      });

    };
  extractPdfTextNode.postAsync = async (shared, prepRes, execRes) => {
    console.log("PRTG Parser: Completed PDF text extraction.");
      console.log("  Stdout:", execRes.stdout);
      console.log("  Stderr:", execRes.stderr);
      console.log("  Exit Code:", execRes.exitCode);
  };

  // 3. Setup Code Interpreter
  const codeInterpreter = new CodeInterpreterNode();
  codeInterpreter.setParams({
      interpreterPath: path.join(process.cwd(), "venv", "Scripts", "python.exe")
  });

  // Define availableTools for the AgentNode
  const availableTools = {
    code_interpreter: codeInterpreter,
    shell_command: new ShellCommandNode(),
  };
  

  // 4. AgentNode to extract structured data from PDF text
  const extractDataAgent = new AgentNode(agentLLM, availableTools, agentLLM);
  extractDataAgent.prepAsync = async (shared) => {
    if (typeof shared === 'undefined' || shared === null) { shared = {}; } // Defensive
    if (!shared.prtgPdfPath) {
        throw new Error("PRTG Parser: Missing prtgPdfPath in shared object.");
    }
    

    const goal = `
      You are an expert at parsing PRTG Network Monitor reports.
      Your goal is to extract structured link performance data for each device sensor from the data/PRTG/extracted_text.txt file.
      Dont ask for permission to use tools; just use them. In the code_interpreter ALWAYS set requireConfirmation to false.
      Some values can be N/A or 0 if not found or not applicable.
      Once you have parsed and extracted the data and it looks plausible, very quickly output the final JSON as specified STOP trying to go back and forth too much this is a very trivial section of the report.
      If you have imperfect parsing of names its okay as long as the uptime/downtime and bandwidth data is correct move on quickly. The data is more important than perfect names.
      Instead of including the entire extracted text in the code_interpreter, you will read it from the file system using the code_interpreter tool to avoid token limits.
      
      ### Input Data
      The extracted_text.txt file contains information about various network links, including uptime, downtime, and bandwidth.
      Each device entry begins with the "Local Probe (Local Probe) »" label followed by the actual entry.

      1. **Read the extracted text file**: Use the code_interpreter tool to read the contents of 'data/PRTG/extracted_text.txt'.
      2. **Analyze the text**: Parse the text to identify device sensor entries and extract the required fields.
      3. **Extract the following fields for each device sensor**:

      ### Extraction Requirements
      For each device sensor entry, extract the following fields. If a field is not present or cannot be reliably extracted, use "N/A" or "0".
      -   **Device Name**: The full name of the device sensor (e.g., "Gigiri DD LAN", "Kitisuru - JTL JTL-WAN").
      -   **Average Bandwidth**: e.g., "5.87 Mbit/s"
      -   **Total Data**: e.g., "1,658,801 MB"
      -   **Uptime Percentage**: The first uptime percentage listed, e.g., "97.941 %"
      -   **Downtime Percentage**: The first downtime percentage listed, e.g., "2.059 %"
      -   **Uptime Duration**: The first uptime duration in \`[dd hh mm ss]\` format, e.g., "27d 10h 03m 17s"
      -   **Downtime Duration**: The first downtime duration in \`[dd hh mm ss]\` format, e.g., "13h 50m 00s"
      
      ### Output Schema
      Your final response MUST be a JSON object strictly adhering to this schema. Do not add extra keys.
      \`\`\`json
      {
        "prtg_monitoring": {
          "links": [
            {
              "name": "String",
              "avg_bandwidth": "String",
              "total_data": "String",
              "uptime_percent": "String",
              "downtime_percent": "String",
              "uptime_duration": "String",
              "downtime_duration": "String"
            }
          ],
          "summary_stats": {
            "overall_avg_uptime_percent": "String", 
            "overall_avg_downtime_percent": "String", 
            "total_links_monitored": Number,
            "links_with_downtime": Number
          }
        }
      }
      \`\`\`
      - Calculate "overall_avg_uptime_percent" and "overall_avg_downtime_percent" by averaging the extracted percentages.
      - Calculate "total_links_monitored" and "links_with_downtime" from the extracted data.
      - Ensure all percentage strings include the '%' symbol.
      
      4. **Final Output**: Make a data/PRTG/extracted.json file containing the final JSON object. Do not add any other text or explanation.
    `;
    extractDataAgent.setParams({ goal: goal });
    return shared;
  };
  extractDataAgent.postAsync = async (shared, prepRes, execRes) => {
    if (typeof shared === 'undefined' || shared === null) { shared = {}; } // Defensive
    console.log("PRTG Parser: Extract Data Agent completed. Inspecting shared object and execRes:");
    console.log("Shared object after Extract Data Agent:", JSON.stringify(shared, null, 2)); // Debug log
    console.log("execRes from Extract Data Agent:", JSON.stringify(execRes, null, 2)); // Debug log
    
    // The AgentNode's postAsync (built-in) will set shared.agentOutput = execRes
    // So here, execRes is the raw string output from the LLM (the JSON string)
    shared.prtg_llm_output = execRes; // Store the raw LLM output for the next node
    return shared;
  };


  // 6. Node to generate chart from structured data
  const generateChartNode = new CodeInterpreterNode();
  generateChartNode.setParams({
    interpreterPath: path.join(process.cwd(), "venv", "Scripts", "python.exe")
  });
  generateChartNode.prepAsync = async (shared) => {
    if (typeof shared === 'undefined' || shared === null) { shared = {}; } // Defensive
    if (!shared.prtg_llm_output) {
        throw new Error("PRTG Parser: Missing LLM output from AgentNode for chart generation.");
    }
    let prtgData;
    try {
        prtgData = JSON.parse(shared.prtg_llm_output);
        if (!prtgData.prtg_monitoring || !Array.isArray(prtgData.prtg_monitoring.links)) {
            throw new Error("PRTG Parser: Invalid PRTG data structure from LLM output.");
        }
    } catch (e) {
        console.error("PRTG Parser: Error parsing LLM output for chart generation:", e);
        throw new Error(`PRTG Parser: Failed to parse LLM output JSON: ${e.message}`);
    }

    const links = prtgData.prtg_monitoring.links;
    const clientNameSanitized = shared.client_name.replace(/[^a-zA-Z0-9]/g, '_');
    const chartPathRelative = path.join('assets', `prtg_uptime_${clientNameSanitized}.png`);
    const chartPathForPython = chartPathRelative.replace(/\\/g, '/');

    shared.prtg_chart_path = chartPathRelative; // Store relative path for JSON

    const pythonCode = `
import matplotlib.pyplot as plt
import numpy as np
import os
import json

# Data passed from JavaScript
links_data = json.loads('${JSON.stringify(links)}')

# Extract names and uptime percentages
names = [link['name'] for link in links_data]
uptime_percents = [float(link['uptime_percent'].replace(' %', '')) for link in links_data]
downtime_percents = [float(link['downtime_percent'].replace(' %', '')) for link in links_data]

# Create stacked bar chart
fig, ax = plt.subplots(figsize=(10, 6))

bar_width = 0.6
indices = np.arange(len(names))

# Plot uptime
bars1 = ax.bar(indices, uptime_percents, bar_width, label='Uptime (%)', color='lightgreen')
# Plot downtime on top
bars2 = ax.bar(indices, downtime_percents, bar_width, bottom=uptime_percents, label='Downtime (%)', color='lightcoral')


ax.set_ylabel('Percentage (%)')
ax.set_title(f'Link Performance for ${shared.client_name}')
ax.set_xticks(indices)
ax.set_xticklabels(names, rotation=45, ha='right')
ax.set_ylim(0, 100) // Percentages are 0-100
ax.legend()
ax.tight_layout()

# Add percentage labels
for i in range(len(names)):
    ax.text(indices[i], uptime_percents[i] / 2, f'{uptime_percents[i]:.1f}%', ha='center', va='center', color='black', fontsize=8)
    if downtime_percents[i] > 0: // Only show downtime label if there's actual downtime
        ax.text(indices[i], uptime_percents[i] + downtime_percents[i] / 2, f'{downtime_percents[i]:.1f}%', ha='center', va='center', color='black', fontsize=8)


# Ensure assets directory exists. os.path.dirname handles platform differences.
os.makedirs(os.path.dirname(r"${chartPathForPython}"), exist_ok=True)
plt.savefig(r"${chartPathForPython}")
print(f"Chart saved to {r"${chartPathForPython}"}")
    `;
    generateChartNode.setParams({ code: pythonCode });
    return shared;
  };

  // 7. Node to format the final output and write to file
  const formatOutputNode = new AsyncNode();
  formatOutputNode.prepAsync = async (shared) => {
    if (typeof shared === 'undefined' || shared === null) { shared = {}; } // Defensive
    if (!shared.prtg_llm_output || !shared.prtg_chart_path) {
        throw new Error("PRTG Parser: Missing LLM output or chart path in shared object for final output.");
    }
    let prtgData;
    try {
        prtgData = JSON.parse(shared.prtg_llm_output);
        prtgData.prtg_monitoring.chart_path = shared.prtg_chart_path; // Add chart path to the main object
    } catch (e) {
        console.error("PRTG Parser: Error parsing LLM output for final formatting:", e);
        throw new Error(`PRTG Parser: Failed to parse LLM output JSON for final formatting: ${e.message}`);
    }

    const clientNameSanitized = shared.client_name.replace(/[^a-zA-Z0-9]/g, '_');
    const tempFilePath = path.join(process.cwd(), `temp_prtg_monitoring_output_${clientNameSanitized}.json`);

    fs.writeFileSync(tempFilePath, JSON.stringify(prtgData, null, 2));
    console.log(`PRTG Parser: Wrote output to temporary file: ${tempFilePath}`);

    shared.output_filepath = tempFilePath; // Store the filepath in shared.output_filepath
    console.log("PRTG Parser: Completed and captured output filepath.");
    return shared;
  };

  // Chain the nodes
  const flow = new AsyncFlow();
  flow.start(findAndProcessPrtgPdfNode)
    .next(extractPdfTextNode)
    .next(extractDataAgent)
    .next(generateChartNode)
    .next(formatOutputNode);

  return flow;
}
