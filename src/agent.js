import { AsyncFlow, AsyncNode } from "@fractal-solutions/qflow";
import { ShellCommandNode } from "@fractal-solutions/qflow/nodes";
import fs from "fs";
import path from "path";
import process from "process";

// Helper function to merge deep objects
const isObject = (item) => item && typeof item === 'object' && !Array.isArray(item);
const mergeDeep = (target, ...sources) => {
  if (!sources.length) return target;
  const source = sources.shift();

  if (isObject(target) && isObject(source)) {
    for (const key in source) {
      if (isObject(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} });
        mergeDeep(target[key], source[key]);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }
  return mergeDeep(target, ...sources);
};

// The Orchestrator Workflow
export function agentWorkflow(clientName) {
  const flow = new AsyncFlow();
  const workflowSharedState = {}; // Our object for shared state, within agentWorkflow's scope

  // 1. Node to read client configuration
  const readConfigNode = new AsyncNode();
  // We use execAsync directly, ignoring the 'shared' parameter as we use workflowSharedState
  readConfigNode.execAsync = async () => {
    console.log('Orchestrator: Entering readConfigNode.execAsync'); // Debug log
    const configPath = path.join(process.cwd(), 'config', `${clientName}.json`);
    console.log(`Orchestrator: Reading config from ${configPath}`);
    if (!fs.existsSync(configPath)) {
      throw new Error(`Configuration file not found for client: ${clientName}`);
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    workflowSharedState.config = config; // Assign directly to our scope-level shared object
    console.log(`Orchestrator: Found ${workflowSharedState.config.modules_to_run.length} modules to run.`);
    console.log('Orchestrator: Exiting readConfigNode.execAsync, workflowSharedState.config is now:', workflowSharedState.config); // Debug log
  };

  // 2. Node to run the required parsers dynamically
  const runParsersNode = new AsyncNode();
  // We use execAsync directly, ignoring the 'shared' parameter as we use workflowSharedState
  runParsersNode.execAsync = async () => {
    console.log('Orchestrator: workflowSharedState.config at start of runParsersNode.execAsync:', workflowSharedState.config); // Debug log
    if (!workflowSharedState.config) {
        throw new Error("Orchestrator: workflowSharedState.config is missing before running parsers. Configuration was not loaded.");
    }
    const { modules_to_run, data_directory } = workflowSharedState.config;
    let finalJson = {};
    
    for (const moduleName of modules_to_run) {
      console.log(`Orchestrator: Running parser module -> ${moduleName}`);
      try {
        const parserModule = await import(`./parsers/${moduleName}_parser.js`);
        console.log(`Orchestrator: Imported parserModule for ${moduleName}:`, parserModule); // Debug log
        const workflowFunctionName = `${moduleName}ParserWorkflow`;
        console.log(`Orchestrator: Attempting to call function: ${workflowFunctionName}`); // Debug log
        const parserWorkflow = parserModule[workflowFunctionName]();
        
        // Pass the data directory and client name to the parser via its own `shared` object
        const parserShared = { 
            data_directory: data_directory, 
            client_name: workflowSharedState.config.client_name // Pass client_name from main config
        };
        await parserWorkflow.runAsync(parserShared);
        console.log('Orchestrator: parserShared.output after parser workflow:', parserShared.output); // Debug log
        
        // Merge the output from the parser
        if (parserShared.output) {
          finalJson = mergeDeep(finalJson, parserShared.output);
          console.log(`Orchestrator: Successfully merged output from ${moduleName}.`);
        } else {
          console.warn(`Orchestrator: Module ${moduleName} did not produce an output.`);
        }
      } catch (error) {
        console.error(`Orchestrator: Error running parser module ${moduleName}`, error);
        // Depending on error handling strategy, might want to re-throw or continue with warning
      }
    }

    // Add meta data
    const finalReportData = {
        meta: {
            client_name: workflowSharedState.config.client_name,
            report_month: workflowSharedState.config.report_period,
            generated_date: new Date().toLocaleDateString()
        },
        ...finalJson
    };
    
    // Write the final aggregated JSON
    const finalJsonPath = 'report_data.json';
    fs.writeFileSync(finalJsonPath, JSON.stringify(finalReportData, null, 2));
    console.log(`Orchestrator: Final aggregated ${finalJsonPath} created.`);
    workflowSharedState.finalJsonPath = finalJsonPath; // Assign to scope-level shared object
  };

  // 3. Node to run the renderer
  const renderPdfNode = new ShellCommandNode();
  // We use prepAsync, ignoring its 'shared' parameter as we use workflowSharedState
  renderPdfNode.prepAsync = async () => {
      console.log('Orchestrator: workflowSharedState.config at start of renderPdfNode.prepAsync:', workflowSharedState.config); // Debug log
      if (!workflowSharedState.config || !workflowSharedState.finalJsonPath) {
          throw new Error("Orchestrator: Missing config or finalJsonPath in workflowSharedState for PDF rendering.");
      }
      const { client_name, report_period } = workflowSharedState.config;
      const safeClientName = client_name.replace(/[^a-zA-Z0-9]/g, '_');
      const safePeriod = report_period.replace(/[^a-zA-Z0-9]/g, '_');
      const outputPdfPath = path.join('reports', `${safeClientName}-${safePeriod}-Monthly_Report.pdf`);
      
      const command = `bun src/renderer.js ${workflowSharedState.finalJsonPath} "${outputPdfPath}"`;
      console.log(`Orchestrator: Executing renderer command -> ${command}`);
      renderPdfNode.setParams({ command: command });
  };

  // Chain the nodes together
  flow.start(readConfigNode)
    .next(runParsersNode)
    .next(renderPdfNode);

  return flow;
}