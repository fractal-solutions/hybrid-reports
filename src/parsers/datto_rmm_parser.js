import { AsyncFlow, AsyncNode } from "@fractal-solutions/qflow";
import {
  AgentNode,
  CodeInterpreterNode,
  PDFProcessorNode,
} from "@fractal-solutions/qflow/nodes";
import { GenericLLMNode } from "../nodes/GenericLLMNode.js";
import path from "path";
import process from "process";
import fs from "fs"; // Need fs for writing files

// This is a self-contained parser module for Datto RMM data.
export function dattoRmmParserWorkflow() {
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

  // 2. Map tool names to their instances
  const codeInterpreter = new CodeInterpreterNode();
  codeInterpreter.setParams({
      interpreterPath: path.join(process.cwd(), "venv", "Scripts", "python.exe")
  });
  const pdf_processor = new PDFProcessorNode();

  const availableTools = {
    code_interpreter: codeInterpreter,
    pdf_processor: pdf_processor,
  };

  // 3. Instantiate the AgentNode
  const agent = new AgentNode(agentLLM, availableTools, agentLLM); // Can use same LLM for summary
  agent.prepAsync = async (shared) => {
    // The data directory is passed in via the shared context
    const dataDirectory = shared.data_directory || 'data/';

    const goal = `
      Your goal is to act as a specialized Datto RMM Data Parser.
      You will analyze PDF files in the '${dataDirectory}' directory and extract key metrics.
      
      ### Phase 1: Data & Assets
      1.  **Analyze PDF Data**: Read the Datto RMM PDF files provided. Extract key metrics related to:
          - Device Health (Disk, RAM, OS)
          - Antivirus Status
          - Patch Status
          - Overall device counts and compliance.
      2.  **Generate Visuals**: Use the 'code_interpreter' tool (Python) to generate professional charts for the extracted data.
          - Save all images to the 'assets/' folder.
          - Required Charts for Datto RMM: Device Health, Disk Space, Antivirus Status, Patch Status.
          - Ensure chart files are saved (e.g., 'assets/datto_health_chart.png').

      ### Phase 2: The JSON Snippet
      3.  **Create JSON Data**: Construct a JSON object containing the data you found.
          - It **MUST** strictly adhere to this schema. Do not add extra keys.
          \`json
          {
            "scores": { "average_score": Number, "services_delivered_chart_path": "assets/filename.png" },
            "device_health": { 
                "total_managed": Number, "compliance_percentage": Number, "chart_path": "assets/filename.png",
                "metrics": {
                    "disk_space": { "passed_count": Number, "total_count": Number, "low_space_count": Number, "chart_path": "assets/filename.png" },
                    "ram": { "passed_count": Number, "total_count": Number },
                    "os_support": { "passed_count": Number, "total_count": Number }
                }
            },
            "antivirus": { "installed_count": Number, "chart_path": "assets/filename.png" },
            "patch_management": { 
                "fully_patched_count": Number, 
                "update_required_count": Number, 
                "chart_path": "assets/filename.png",
                "windows_10_users_list": ["User A", "User B"]
            }
          }
          \`
      4. **Final Output**: Your final response should be ONLY the JSON object you constructed. Do not add any other text or explanation.
    `;
    agent.setParams({ goal: goal }); 
  };

  // 4. Node to process the AgentNode's raw output and write to a file
  const writeOutputToFileNode = new AsyncNode();
  writeOutputToFileNode.execAsync = async (shared, execResOfAgentNode) => {
    // execResOfAgentNode should contain the raw output from the AgentNode's LLM run
    // assuming AgentNode's execAsync returns an object like { final_message: "..." }
    const res = execResOfAgentNode; 
    
    // Defensive check for the shared object passed into this node
    if (typeof shared === 'undefined' || shared === null) {
        console.warn("Datto RMM Parser: 'shared' object was undefined or null in writeOutputToFileNode.execAsync, initializing.");
        shared = {};
    }

    try {
        if (!res || !res.final_message) {
            throw new Error("AgentNode did not return a valid final_message.");
        }
        console.log('Datto RMM Parser: LLM final message from AgentNode output:', res.final_message); // Debug log
        const jsonOutput = JSON.parse(res.final_message);
        
        // Construct a unique temporary filename
        const clientNameSanitized = shared.client_name.replace(/[^a-zA-Z0-9]/g, '_');
        const tempFilePath = path.join(process.cwd(), `temp_datto_rmm_output_${clientNameSanitized}.json`);

        fs.writeFileSync(tempFilePath, JSON.stringify(jsonOutput, null, 2));
        console.log(`Datto RMM Parser: Wrote output to temporary file: ${tempFilePath}`);

        shared.output_filepath = tempFilePath; // Store the filepath in shared.output_filepath
        console.log('Datto RMM Parser: shared.output_filepath after assignment:', shared.output_filepath); // Debug log
    } catch (e) {
        console.error("Error processing and writing JSON output from Datto RMM agent:", e);
        console.log("Agent final message was:", res?.final_message);
        
        const clientNameSanitized = shared.client_name.replace(/[^a-zA-Z0-9]/g, '_');
        const errorFilePath = path.join(process.cwd(), `temp_datto_rmm_error_${clientNameSanitized}.json`);
        fs.writeFileSync(errorFilePath, JSON.stringify({ error: `Failed to parse Datto RMM output: ${e.message}`, raw_message: res?.final_message || "No final message" }, null, 2));
        shared.output_filepath = errorFilePath;
        console.log('Datto RMM Parser: shared.output_filepath after error assignment:', shared.output_filepath); // Debug log
    }
    return shared; // Important: Return the shared object for propagation
  };

  // 5. Create the flow and chain nodes
  const flow = new AsyncFlow();
  flow.start(agent);
  agent.next(writeOutputToFileNode); // Chain writeOutputToFileNode after the agent

  return flow;
}
