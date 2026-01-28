import { agentWorkflow } from './agent.js';

async function main() {
  console.log('Starting modular agent workflow...');

  // Simple command-line argument parsing
  const args = process.argv;
  const clientArg = args.find(arg => arg.startsWith('--client='));
  
  if (!clientArg) {
    console.error('Error: Client not specified. Please run with --client=<ClientName>');
    console.error('Example: bun src/index.js --client=Dira_Immigration');
    process.exit(1);
  }

  const clientName = clientArg.split('=')[1];
  console.log(`Generating report for client: ${clientName}`);

  const agentFlow = agentWorkflow(clientName);
  const shared = {};

  try {
    await agentFlow.runAsync(shared);
    console.log(`Agent workflow for ${clientName} completed.`);
  } catch (error) {
    console.error(`Error running agent workflow for ${clientName}:`, error);
  }
}

main();