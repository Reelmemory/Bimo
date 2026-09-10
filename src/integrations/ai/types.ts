export interface StructuredOutputRequest {
  name: string;
  systemPrompt: string;
  userPrompt: string;
  schema: Record<string, unknown>;
}

export interface StructuredOutputProvider {
  generateStructured<T>(request: StructuredOutputRequest): Promise<T>;
}
