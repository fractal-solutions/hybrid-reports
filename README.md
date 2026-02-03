# Monthly Support Report Agent

This project provides a modular and extensible system for generating monthly support reports for various clients. It leverages a pluggable architecture, allowing different data sources and report modules to be dynamically included based on client-specific configurations.

## Architecture Overview

The system follows a Data-View-Controller (DVC) pattern:

-   **Client Configuration (Blueprint)**: Stored in `config/<client_name>.json`, these files define which data sources (modules) are relevant for a specific client.
-   **Modular Parsers (Workers)**: Located in `src/parsers/`, each module is specialized in processing data from a particular service (e.g., Datto RMM, Zoho Tickets). They output standardized JSON snippets.
-   **Orchestrator (Manager)**: The main `src/agent.js` script acts as a manager. It reads the client's configuration, dynamically loads and runs the specified parsers, aggregates their JSON outputs, and prepares the final data for rendering.
-   **Renderer (Finishing Department)**: The `src/renderer.js` script takes the aggregated JSON, populates an HTML template, embeds any generated charts (as Base64 to avoid path issues), and outputs a high-quality PDF report.

## Setup

1.  **Bun Installation**: Ensure Bun runtime is installed on your system. Follow the instructions on [Bun's official website](https://bun.sh/docs/docs/installation).
2.  **Dependencies**: Install project dependencies using Bun:
    ```bash
    bun install
    ```
3.  **Python Virtual Environment**: The `code_interpreter` tool requires a Python environment. Create and activate a virtual environment and install `matplotlib`:
    ```bash
    python -m venv venv
    ./venv/Scripts/activate # On Windows PowerShell
    # or source venv/bin/activate # On Linux/macOS
    pip install matplotlib
    ```
4.  **Puppeteer Browser**: Puppeteer requires a browser executable. Install the recommended browser:
    ```bash
    bunx puppeteer browsers install chrome
    ```
5.  **Environment Variables**: The agent might require API keys for LLM services. Set `AGENT_LLM_API_KEY`, `AGENT_LLM_MODEL`, and `AGENT_LLM_BASE_URL` in your environment or a `.env` file.

## How to Configure Clients

Client configurations are located in the `config/` directory. Each client has a JSON file named `<sanitized_client_name>.json`.

**Example Configuration (`config/dira_immigration.json`):**
```json
{
  "client_name": "Dira Immigration Consultants Ltd",
  "report_period": "January 2026",
  "data_directory": "data/",
  "modules_to_run": [
    "datto_rmm",
    "zoho_tickets"
  ]
}
```

-   `client_name`: The full, human-readable name of the client.
-   `report_period`: The month/period the report covers.
-   `data_directory`: The base directory where raw data files for the client are stored (e.g., `data/`).
-   `modules_to_run`: A list of parser module names (corresponding to files in `src/parsers/` without the `_parser.js` suffix) to execute for this client's report.

## How to Run Reports

To generate a report for a specific client, use the following command:

```bash
bun src/index.js --client=<SanitizedClientName>
```

The generated PDF report will be saved in the `reports/` directory with a filename like `<SanitizedClientName>-<SanitizedReportPeriod>-Monthly_Report.pdf`.


## Adding New Parser Modules

To extend the system with a new data source:

1.  **Create Parser File**: In `src/parsers/`, create a new file named `<your_module_name>_parser.js` (e.g., `prtg_network_parser.js`).
2.  **Implement Workflow**: Inside this file, export a function named `<your_module_name>ParserWorkflow()` that returns a `qflow` `AsyncFlow`. This flow should:
    *   Read data relevant to its module (from `shared.data_directory`).
    *   Generate any necessary charts or visuals, saving them to `assets/`.
    *   Construct a JSON object snippet containing its extracted data.
    *   Place this JSON snippet into `shared.output`.
3.  **Update Client Config**: Add `<your_module_name>` to the 