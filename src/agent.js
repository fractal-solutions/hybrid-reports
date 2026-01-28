import { AsyncFlow, AsyncNode } from "@fractal-solutions/qflow";
import {
  AgentNode,
  DuckDuckGoSearchNode,
  SystemNotificationNode,
  InteractiveWebviewNode,
  ShellCommandNode,
  PDFProcessorNode,
  SpreadsheetNode,
  CodeInterpreterNode,
  MemoryNode,
} from "@fractal-solutions/qflow/nodes";
import { GenericLLMNode } from "./nodes/GenericLLMNode.js";
import path from "path";
import process from "process";

export function agentWorkflow() {
  // --- Configuration ---
  const AGENT_LLM_API_KEY = process.env.AGENT_LLM_API_KEY //|| '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';
  const AGENT_LLM_MODEL = process.env.AGENT_LLM_MODEL //|| "qwen/qwen3-coder:free";
  const AGENT_LLM_BASE_URL = process.env.AGENT_LLM_BASE_URL //|| "https://openrouter.ai/api/v1";
  const AGENT_LLM_SITE_TITLE = process.env.AGENT_LLM_SITE_TITLE //|| "Eldama Support Monthly Report Agent";

  if (!AGENT_LLM_API_KEY) {
    console.warn("WARNING: AGENT_LLM_API_KEY is not set. Please set it to run the agent workflow.");
    console.warn("For OpenRouter, you can get a token from https://openrouter.ai/settings/tokens");
    // Return a dummy flow or throw an error if the key is essential
    const dummyFlow = new AsyncFlow();
    dummyFlow.start(new AsyncNode()); // Start with a dummy node
    return dummyFlow;
  }

  console.log("--- Initializing Generic Agent Workflow ---");

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

  const availableTools = {
    duckduckgo_search: new DuckDuckGoSearchNode(),
    system_notification: new SystemNotificationNode(),
    interactive_webview: new InteractiveWebviewNode(),
    shell_command: new ShellCommandNode(),
    pdf_processor: new PDFProcessorNode(),
    spreadsheet: new SpreadsheetNode(),
    memory_node: new MemoryNode(),
    code_interpreter: codeInterpreter,
  };

  // 3. Instantiate the AgentNode
  // For summarization, we can use the same LLM or a different one if needed.
  const summarizeLLM = new GenericLLMNode();
  summarizeLLM.setParams({
    model: AGENT_LLM_MODEL, 
    apiKey: AGENT_LLM_API_KEY,
    baseUrl: AGENT_LLM_BASE_URL,
  });

  const agent = new AgentNode(agentLLM, availableTools, summarizeLLM);
  agent.prepAsync = async (shared) => {
    const goal = `
      Your goal is to generate a professional monthly support report for Eldama Technologies Clients using a strict Data-View-Controller pipeline.

      ### Phase 1: Data & Assets
      1.  **Analyze Data**: Read files in the 'data/' folder. Extract key metrics (Tickets, Device Health, AV Status, Patch Status, Client Name, Month).
      2.  **Generate Visuals**: Use the 'code_interpreter' tool (Python) to generate professional charts. Make sure to generate brief enough code such that the responses are not truncated.
          - Save all images to the 'assets/' folder.
          - Required Charts:
            - **Services Score**: A visual representation of the overall score (e.g., a gauge or bar).
            - **Device Health**: A pie chart showing compliance (Passed vs Failed).
            - **Disk Space**: A chart showing disk usage distribution (A bar for each disk/user with thesholds also displayed on the chart).
            - **Antivirus**: A chart showing installed/active status.
            - **Patch Status**: A chart showing patched vs missing updates.
          - Ensure chart files are saved (e.g., 'assets/health_chart.png').

      ### Phase 2: The Contract (JSON)
      3.  **Create JSON Data**: Construct a JSON file named 'report_data.json' in the root directory.
          - It **MUST** strictly adhere to this schema:
          \`\`\`json
          {
            "meta": { 
                "client_name": "String", 
                "report_month": "String", 
                "generated_date": "String" 
            },
            "summary": { 
                "executive_summary": "A concise paragraph summarizing the month.", 
                "total_tickets": Number, 
                "av_installed": Number, 
                "fully_patched": Number 
            },
            "scores": { 
                "average_score": Number, 
                "services_delivered_chart_path": "assets/filename.png" 
            },
            "tickets": { 
                "total": Number, 
                "software_count": Number, 
                "hardware_count": Number 
            },
            "device_health": { 
                "total_managed": Number, 
                "compliance_percentage": Number, 
                "chart_path": "assets/filename.png",
                "metrics": {
                    "disk_space": { 
                        "passed_count": Number, 
                        "total_count": Number, 
                        "low_space_count": Number, 
                        "chart_path": "assets/filename.png" 
                    },
                    "ram": { "passed_count": Number, "total_count": Number },
                    "os_support": { "passed_count": Number, "total_count": Number }
                }
            },
            "antivirus": { 
                "installed_count": Number, 
                "chart_path": "assets/filename.png" 
            },
            "patch_management": { 
                "fully_patched_count": Number, 
                "update_required_count": Number, 
                "chart_path": "assets/filename.png",
                "windows_10_users_list": ["User A", "User B"]
            },
            "recommendations": ["Recommendation 1", "Recommendation 2"]
          }
          \`\`\`

      ### Phase 3: Rendering
      4.  **Render PDF**: Use the 'shell_command' tool to execute the renderer.
          - Construct the output filename: "reports/[Client_Name]-[Month]-Monthly_Report.pdf" (replace placeholders with actual data, spaces with underscores).
          - Command: \`bun src/renderer.js report_data.json "reports/Your_Filename.pdf"\`

      **Critical Instructions:**
      - Do NOT write Markdown files.
      - Do NOT use 'markdown-pdf'.
      - Ensure all JSON paths match the actual files you generated in 'assets/'.
    `;
    agent.setParams({ goal: goal }); 
  };

  // 4. Chain the nodes: Start directly with the Agent
  const flow = new AsyncFlow();
  flow.start(agent);

  return flow;
}