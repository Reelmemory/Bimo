import { createDeploymentDemoRuntime, type RuntimeBoundaryOptions } from '../demo/deployment.js';
import type { MockDeploymentScenario } from '../tools/mocks.js';
import type { RuntimeFactory } from './service.js';

export const createDemoRuntimeFactory = (scenario: MockDeploymentScenario = {}): RuntimeFactory =>
  (boundary: RuntimeBoundaryOptions) => createDeploymentDemoRuntime(scenario, boundary);
