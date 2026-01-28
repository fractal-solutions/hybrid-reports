import { AsyncFlow } from "@fractal-solutions/qflow";
import { CodeInterpreterNode } from "@fractal-solutions/qflow/nodes";
import path from "path";

(async () => {
    const pythonCode = `file_path = 'new_file.txt'
content_to_write = """Hello, world!
This is a new text file created with Python.
We can add multiple lines of text here."""

try:
    with open(file_path, 'w', encoding='utf-8') as file:
        file.write(content_to_write)
    print(f"File '{file_path}' created successfully.")
except IOError as e:
    print(f"Error creating file: {e}")`;

    const codeInterpreter = new CodeInterpreterNode();
    codeInterpreter.setParams({
        code: pythonCode,
        timeout: 15000,
        requireConfirmation: true,
        interpreterPath: path.join(process.cwd(), "venv", "Scripts", "python.exe")
    });

    codeInterpreter.postAsync = async (shared, prepRes, execRes) => {
        console.log("Code Interpreter Output:\n", execRes);
    };

    const flow = new AsyncFlow();
    flow.start(codeInterpreter);
    try {
        await flow.runAsync({});
    } catch (error) {
        console.error("Error during flow execution:", error);
    }
})();