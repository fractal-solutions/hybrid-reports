import { AsyncNode } from "@fractal-solutions/qflow";

export class GenericLLMNode extends AsyncNode {
  async execAsync() {
    const { prompt, apiKey, model, baseUrl } = this.params;

    if (!prompt) {
      throw new Error("GenericLLMNode: Prompt (conversation history) is missing from params.");
    }
    if (!apiKey) {
      throw new Error("GenericLLMNode: API Key is not configured.");
    }
    if (!model) {
      throw new Error("GenericLLMNode: Model is not configured.");
    }
    if (!baseUrl) {
      throw new Error("GenericLLMNode: Base URL is not configured.");
    }

    let messages;
    try {
      messages = JSON.parse(prompt);
      // Ensure messages array contains objects with role and content
      if (!Array.isArray(messages) || !messages.every(msg => msg.role && msg.content !== undefined)) {
        throw new Error("GenericLLMNode: Parsed prompt is not a valid messages array.");
      }
    } catch (e) {
      throw new Error(`GenericLLMNode: Invalid prompt format. Expected stringified JSON array of messages. Error: ${e.message}`);
    }

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };

    // Construct the full API URL using the provided baseUrl
    const apiUrl = `${baseUrl}/chat/completions`;

    console.log(`[GenericLLMNode] Sending prompt to ${model} at ${apiUrl}...`);

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          model: model,
          messages: messages,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`LLM API error: ${response.status} - ${JSON.stringify(errorData)}`);
      }

      const data = await response.json();
      if (!data.choices || data.choices.length === 0 || !data.choices[0].message || typeof data.choices[0].message.content !== 'string') {
        throw new Error('Invalid response structure from LLM API or missing content.');
      }

      const llmResponse = data.choices[0].message.content.trim();
      console.log(`[GenericLLMNode] Received response from ${model}.`);
      return llmResponse;
    } catch (error) {
      console.error('GenericLLMNode: Error during API call:', error);
      throw error;
    }
  }

  async postAsync(shared, prepRes, execRes) {
    shared.llmResponse = execRes; // Store the full LLM response content
    return execRes; // Return the full LLM response content
  }
}