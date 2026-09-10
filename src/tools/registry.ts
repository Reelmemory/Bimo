import type { JsonValue } from '../types/investigation.js';
import type { Tool, ToolDescriptor } from './types.js';

type RegisteredTool = Tool<any, any>;

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register<TInput, TOutput extends JsonValue>(tool: Tool<TInput, TOutput>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`A tool named "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  registerMany(tools: Tool<any, any>[]): void {
    for (const tool of tools) this.register(tool);
  }

  get<TInput = JsonValue, TOutput extends JsonValue = JsonValue>(name: string): Tool<TInput, TOutput> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool "${name}" is not registered`);
    return tool as Tool<TInput, TOutput>;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool<any, any>[] {
    return [...this.tools.values()];
  }

  describe(): ToolDescriptor[] {
    return this.list().map(({ name, description, riskLevel, inputDefinition }) => ({
      name,
      description,
      riskLevel,
      inputDefinition,
    }));
  }
}
