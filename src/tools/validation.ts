import type { JsonValue } from '../types/investigation.js';
import type { Tool, ToolInputDefinition } from './types.js';

export interface ToolArgumentValidation {
  valid: boolean;
  errors: string[];
}

const typeMatches = (value: JsonValue, type: string): boolean => {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'string') return typeof value === 'string';
  return false;
};

export const validateToolArguments = <TInput>(
  tool: Tool<TInput, any>,
  input: JsonValue,
): ToolArgumentValidation => {
  const definition: ToolInputDefinition = tool.inputDefinition;
  const errors: string[] = [];
  if (!typeMatches(input, definition.type)) {
    return { valid: false, errors: [`Expected ${definition.type} input for tool "${tool.name}".`] };
  }
  if (definition.type === 'object') {
    const object = input as { [key: string]: JsonValue };
    const properties = definition.properties ?? {};
    for (const required of definition.required ?? []) {
      if (!(required in object) || object[required] === null || object[required] === '') {
        errors.push(`Missing required argument "${required}".`);
      }
    }
    for (const [name, property] of Object.entries(properties)) {
      if (name in object && !typeMatches(object[name]!, property.type)) {
        errors.push(`Argument "${name}" must be a ${property.type}.`);
      }
      if (name in object && property.enum && !property.enum.includes(object[name]!)) {
        errors.push(`Argument "${name}" is not an allowed value.`);
      }
    }
    if (definition.additionalProperties !== true) {
      for (const name of Object.keys(object)) {
        if (!(name in properties)) errors.push(`Unknown argument "${name}".`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
};
