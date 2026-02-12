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
6.  **Patch Qflow Agent (required after install)**: Qflow's finish tool prompts for confirmation by default. This repo includes a patch script to disable that prompt for unattended runs. Run after `bun install` or any dependency reinstall:
    ```bash
    bun patch_agent.js
    ```

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
3.  **Update Client Config**: Add `<your_module_name>` to the `modules_to_run` list for any client that needs the new module.
4.  **Template Wiring**: If the module adds a new section or fields, update:
    *   `src/templates/report.html` to include the section and placeholders.
    *   `src/templates/report_style.css` for styling.
    *   `src/renderer.js` if you need pre-processing (lists, tables, images).

## Data Layout

By default the system expects data under `data/` with module-specific subfolders. Common examples:

- `data/datto_rmm/` for Datto RMM PDFs
- `data/prtg/` for PRTG PDFs
- `data/zoho_tickets.csv` for Zoho Tickets exports

Each parser is responsible for finding and reading its own inputs relative to `shared.data_directory`.

## Report Templates

- HTML layout: `src/templates/report.html`
- Styles: `src/templates/report_style.css`
- Logo: `src/templates/eldama-logo.png`

The renderer injects CSS and images, replaces `{{placeholders}}`, and generates the final PDF.

## Troubleshooting

- **Finish tool prompt keeps asking for yes/no**: Re-run `bun patch_agent.js` after reinstalling dependencies.
- **Blank sections**: Make sure the module that provides the data is included in `modules_to_run` and that the parser output was merged into `report_data.json`.
- **Missing images**: Confirm charts were generated in `assets/` and that their paths are present in the module output JSON.
- **PDF render issues**: Reinstall the Puppeteer browser with `bunx puppeteer browsers install chrome`.

## Notes

- The final aggregated data is written to `report_data.json` before rendering.
- The PDF is written to `reports/<Client>-<Period>-Monthly_Report.pdf`.
