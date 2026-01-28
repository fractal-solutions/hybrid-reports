import { agentWorkflow } from './agent.js';

async function main() {
  console.log('Starting agent workflow...');
  
  const agentFlow = agentWorkflow();
  const shared = {};
  try {
    await agentFlow.runAsync(shared);
    console.log('Agent workflow completed.');
  } catch (error) {
    console.error('Error running agent workflow:', error);
  }
}

main();