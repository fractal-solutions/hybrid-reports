import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';

async function generateClientConfigs() {
    const csvPath = 'data/zoho_tickets.csv';
    const configDir = 'config';
    const defaultModules = ["datto_rmm", "zoho_tickets"]; // Default modules for all clients
    const defaultReportPeriod = "January 2026"; // Default report period

    if (!fs.existsSync(csvPath)) {
        console.error(`Error: zoho_tickets.csv not found at ${csvPath}`);
        return;
    }

    const file = fs.readFileSync(csvPath, 'utf8');
    // Find the actual header line (the one containing "Account Name")
    let headerStartIndex = 0;
    const lines = file.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("Account Name")) {
            headerStartIndex = i;
            break;
        }
    }
    const csvData = lines.slice(headerStartIndex).join('\n');

    const parseResult = Papa.parse(csvData, { header: true, skipEmptyLines: true });

    const accountNames = new Set();
    for (const row of parseResult.data) {
        if (row['Account Name'] && row['Account Name'].trim() !== '') {
            accountNames.add(row['Account Name'].trim());
        }
    }

    for (const clientOriginalName of accountNames) {
        const sanitizedClientName = clientOriginalName.replace(/[^a-zA-Z0-9]/g, '_').replace(/_{2,}/g, '_').toLowerCase();
        
        const configFilePath = path.join(configDir, `${sanitizedClientName}.json`);
        const defaultConfigFileContent = JSON.stringify({
            client_name: clientOriginalName,
            report_period: defaultReportPeriod,
            data_directory: "data/",
            modules_to_run: defaultModules
        }, null, 2);

        if (!fs.existsSync(configFilePath) || fs.readFileSync(configFilePath, 'utf8') === defaultConfigFileContent) {
            fs.writeFileSync(configFilePath, defaultConfigFileContent);
            console.log(`Generated/Updated config for: ${clientOriginalName} -> ${configFilePath}`);
        } else {
            console.log(`Config file for ${clientOriginalName} exists and has custom changes, skipping auto-generation.`);
        }
    }
    console.log('Client configurations generated successfully.');
}

generateClientConfigs().catch(console.error);