# monthly-support-report-agent

To install dependencies:

```bash
bun install
```

To run:

```bash
bun src/index.ts
```



Project will require `markdown-pdf` (```bash bun i -g markdown-pdf```) to convert markdown to pdf, `poppler-utils` pdf tools (pdfimages, pdftotext etc.) installed to run in CLI and Python installed in the system with a ```venv/``` in the current directory and matplotlib installed.

This project was created using `bun init` in bun v1.3.6. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.