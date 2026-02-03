import { AsyncFlow, AsyncNode } from "@fractal-solutions/qflow";
import {
  AgentNode,
  CodeInterpreterNode,
  PDFProcessorNode, // Re-added as it's needed locally within extractPdfsTextNode
} from "@fractal-solutions/qflow/nodes";
import { GenericLLMNode } from "../nodes/GenericLLMNode.js";
import path from "path";
import process from "process";
import fs from "fs"; // Need fs for writing files

// This is a self-contained parser module for Datto RMM data.
export function datto_rmmParserWorkflow() {
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
  
  // This availableTools will be passed to the AgentNode
  const availableTools = {
    code_interpreter: codeInterpreter,
    // PDFProcessorNode is no longer needed here as AgentNode receives pre-processed text
  };

  // --- NODES FOR THE DATTO RMM PARSER FLOW ---

  // Node to find and process Datto RMM PDF files
  const findAndProcessDattoPdfsNode = new AsyncNode();
  findAndProcessDattoPdfsNode.prepAsync = async (shared) => {
    // Defensive check
    if (typeof shared === 'undefined' || shared === null) {
      console.warn("Datto RMM Parser: 'shared' object was undefined or null in findAndProcessDattoPdfs.prepAsync, initializing.");
      shared = {};
    }

    const dattoRmmDataDir = path.join(process.cwd(), 'data', 'datto_rmm');
    console.log(`Datto RMM Parser: Looking for Datto RMM PDF files in ${dattoRmmDataDir}`);
    let dattoRmmPdfPaths = [];

    // Dynamically find the Datto RMM PDF files
    try {
      const files = fs.readdirSync(dattoRmmDataDir);
      console.log(`Datto RMM Parser: Found ${files.length} files in ${dattoRmmDataDir}`);
      const clientNameRegex = new RegExp(shared.client_name.replace(/[^a-zA-Z0-9]/g, '.*'), 'i');
      for (const file of files) {
        if (file.endsWith(".pdf") && clientNameRegex.test(file)) {
          dattoRmmPdfPaths.push(path.join(dattoRmmDataDir, file));
          console.log(`Datto RMM Parser: Found Datto RMM PDF file: ${file}`);
        }
      }
    } catch (err) {
      console.error("Error finding Datto RMM PDF files:", err);
      // Even if error, propagate shared to avoid breaking chain.
    }
    shared.datto_rmm_pdf_paths = dattoRmmPdfPaths;
    return shared; 
  };

  // Node to extract text from all found PDFs and merge them
  const extractPdfsTextNode = new AsyncNode();
  extractPdfsTextNode.prepAsync = async (shared) => { // prepAsync for extractPdfsTextNode
    if (typeof shared === 'undefined' || shared === null) { shared = {}; } // Defensive
    
    const pdfPaths = shared.datto_rmm_pdf_paths || [];
    if (pdfPaths.length === 0) {
      console.warn("Datto RMM Parser: No Datto RMM PDF paths found. Agent will receive empty text.");
      shared.pdfTextContent = ""; 
      return shared; 
    }
    
    let allExtractedText = [];

    for (const pdfPath of pdfPaths) {
      console.log(`Datto RMM Parser: Extracting text from PDF: ${pdfPath}`);
      const localPdfProcessor = new PDFProcessorNode(); // Instantiate locally for each PDF
      localPdfProcessor.setParams({
        filePath: pdfPath,
        action: 'extract_text',
      });
      
      try {
        const result = await new AsyncFlow(localPdfProcessor).runAsync({});
        if (result && result.text) {
          allExtractedText.push(`--- Content from PDF: ${path.basename(pdfPath)} ---\n` + result.text + '\n\n');
        } else {
          console.warn(`Datto RMM Parser: No text extracted from ${pdfPath}. Result:`, result);
        }
      } catch (pdfExtractError) {
        console.error(`Datto RMM Parser: Error extracting text from ${pdfPath}: ${pdfExtractError.message}`);
        allExtractedText.push(`--- Error extracting text from PDF: ${path.basename(pdfPath)} ---\nError: ${pdfExtractError.message}\n\n`);
      }
    }

    const mergedContent = allExtractedText.join('\n\n\n--- Document Break ---\n\n\n');
    
    // Store merged content directly in shared object for LLM's goal
    shared.pdfTextContent = mergedContent; 
    console.log(`Datto RMM Parser: Merged extracted text content (total length: ${mergedContent.length})`);
    
    // Also write to a temporary file for robustness/debugging, though LLM directly uses shared.pdfTextContent
    const clientNameSanitized = shared.client_name.replace(/[^a-zA-Z0-9]/g, '_');
    const mergedTextDir = path.join(process.cwd(), 'data', 'datto_rmm', 'extracted');
    if (!fs.existsSync(mergedTextDir)) {
      fs.mkdirSync(mergedTextDir, { recursive: true });
    }
    shared.merged_datto_rmm_text_filepath = path.join(mergedTextDir, `merged_content_${clientNameSanitized}.txt`);
    fs.writeFileSync(shared.merged_datto_rmm_text_filepath, mergedContent);
    console.log(`Datto RMM Parser: Merged text written to ${shared.merged_datto_rmm_text_filepath}`);

    return shared; 
  }

  // 3. Instantiate the AgentNode (LLM-driven task execution)
  const agent = new AgentNode(agentLLM, availableTools, agentLLM); // Agent still needs LLM and tools
  agent.prepAsync = async (shared) => { // This receives `parserShared` from orchestrator
    // Use the merged text content directly in the goal
    const mergedTextContent = shared.pdfTextContent;
    
    if (!mergedTextContent) {
        throw new Error("Datto RMM Parser: Merged PDF text content not found in shared object for AgentNode. Check previous extraction step.");
    }

    const goal = `
      Your goal is to act as a specialized Datto RMM Data Parser.
      You will analyze the provided consolidated text from Datto RMM PDF reports and extract key metrics.
      
      --- CONSOLIDATED DATTO RMM REPORT TEXT ---
      ${mergedTextContent}
      --- END CONSOLIDATED DATTO RMM REPORT TEXT ---

      When using code_interpreter, set requireConfirmation to false. Do not ask for permission; just use it.
      DO NOT INSTALL ANYTHING. Use only the provided tools.
      
      ### Phase 1: Data & Assets
      1.  **Analyze Text Data**: Read the consolidated text provided. Extract key metrics related to:
          - Device Health (Disk, RAM, OS)
          - Antivirus Status
          - Patch Status
          - Overall device counts and compliance.
      2.  **Generate Visuals**: Use the 'code_interpreter' tool (Python) to generate professional charts for the extracted data. (Do not ask for permission/requireConfirmation to use the tool; just use it.)
          - Save all images to the 'assets/' folder.
          - Required Charts for Datto RMM: Services Delivery Scores(Bar Chart for various services), Device Health, Disk Space(Bar Charts for each user device with thesholds shown and user names per bar), Antivirus Status(Bar Chart), Patch Status(Pie Chart).
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
    return shared; // Return shared for propagation
  };

  // Node to process the AgentNode's raw output (from shared.agentOutput) and write to a file
  const processAgentOutputNode = new AsyncNode();
  processAgentOutputNode.prepAsync = async (shared) => { // prepAsync only takes `shared`
    // Defensive check
    if (typeof shared === 'undefined' || shared === null) {
        console.warn("Datto RMM Parser: 'shared' object was undefined or null in processAgentOutputNode.prepAsync, initializing.");
        shared = {};
    }

    const rawAgentOutput = shared.agentOutput; // This is where the AgentNode puts its output!

    try {
        if (!rawAgentOutput) {
            console.warn("Datto RMM Parser: AgentNode did not place its output onto 'shared.agentOutput'. Cannot process output. Did the AgentNode complete its task?");
            throw new Error("AgentNode output not found on shared.agentOutput.");
        }
        console.log('Datto RMM Parser: Raw LLM final message from shared.agentOutput:', rawAgentOutput);
        const jsonOutput = JSON.parse(rawAgentOutput); // Parse the raw string output
        
        const clientNameSanitized = shared.client_name.replace(/[^a-zA-Z0-9]/g, '_');
        const tempFilePath = path.join(process.cwd(), `temp_datto_rmm_output_${clientNameSanitized}.json`);

        fs.writeFileSync(tempFilePath, JSON.stringify(jsonOutput, null, 2));
        console.log(`Datto RMM Parser: Wrote output to temporary file: ${tempFilePath}`);

        shared.output_filepath = tempFilePath;
        console.log('Datto RMM Parser: shared.output_filepath after assignment:', shared.output_filepath);
    } catch (e) {
        console.error("Error processing and writing JSON output from Datto RMM agent:", e);
        console.log("Agent raw output was:", rawAgentOutput); // Log the problematic raw output
        
        const clientNameSanitized = shared.client_name.replace(/[^a-zA-Z0-9]/g, '_');
        const errorFilePath = path.join(process.cwd(), `temp_datto_rmm_error_${clientNameSanitized}.json`);
        fs.writeFileSync(errorFilePath, JSON.stringify({ error: `Failed to process Datto RMM output: ${e.message}`, raw_message: rawAgentOutput || "No raw agent output" }, null, 2));
        shared.output_filepath = errorFilePath;
        console.log('Datto RMM Parser: shared.output_filepath after error assignment:', shared.output_filepath);
    }
    return shared; // Important: Return the shared object for propagation
  };

  // 5. Create the flow and chain nodes
  const flow = new AsyncFlow();
  flow.start(findAndProcessDattoPdfsNode)
    .next(extractPdfsTextNode)
    .next(agent)
    .next(processAgentOutputNode); // Chain processAgentOutputNode after the agent

  return flow;
}