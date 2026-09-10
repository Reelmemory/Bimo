import type { Evidence, JsonValue } from '../types/investigation.js';
import { ToolRegistry } from './registry.js';
import { RiskLevel, type Tool } from './types.js';

export interface MockDeploymentScenario {
  failFirstFix?: boolean;
  failFirstVerification?: boolean;
}

export interface MockDeploymentRuntimeState {
  fixAttempts: number;
  dependencyFixed: boolean;
  deployed: boolean;
  verificationAttempts: number;
}

const evidence = (summary: string, details: JsonValue): Evidence => ({
  id: `evidence-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  source: 'mock_deployment',
  summary,
  details,
  timestamp: new Date().toISOString(),
});

export const createMockDeploymentTools = (
  scenario: MockDeploymentScenario = {},
): { registry: ToolRegistry; state: MockDeploymentRuntimeState } => {
  const state: MockDeploymentRuntimeState = {
    fixAttempts: 0,
    dependencyFixed: false,
    deployed: false,
    verificationAttempts: 0,
  };

  const readLogs: Tool<null, { status: string; error: string }> = {
    name: 'mock_read_deployment_logs',
    description: 'Returns simulated deployment logs for development and tests.',
    riskLevel: RiskLevel.READ_ONLY,
    inputDefinition: { type: 'null' },
    async execute() {
      return {
        success: true,
        output: { status: 'failed', error: 'Build failed: dependency lockfile is out of date.' },
        evidence: [evidence('Deployment logs show a dependency/build failure.', {
          status: 'failed',
          error: 'Build failed: dependency lockfile is out of date.',
        })],
      };
    },
  };

  const fixDependency: Tool<null, { changed: boolean; attempt: number }> = {
    name: 'mock_fix_dependency',
    description: 'Simulates applying a reversible dependency fix.',
    riskLevel: RiskLevel.REVERSIBLE,
    inputDefinition: { type: 'null' },
    async execute() {
      state.fixAttempts += 1;
      const changed = !(scenario.failFirstFix && state.fixAttempts === 1);
      if (changed) state.dependencyFixed = true;
      return {
        success: true,
        output: { changed, attempt: state.fixAttempts },
        evidence: [evidence(changed ? 'Dependency fix applied.' : 'Initial dependency fix did not resolve the build.', {
          changed,
          attempt: state.fixAttempts,
        })],
      };
    },
  };

  const deploy: Tool<null, { deployed: boolean }> = {
    name: 'mock_deploy',
    description: 'Simulates a consequential deployment.',
    riskLevel: RiskLevel.CONSEQUENTIAL,
    inputDefinition: { type: 'null' },
    async execute() {
      state.deployed = state.dependencyFixed;
      return {
        success: state.deployed,
        output: { deployed: state.deployed },
        ...(state.deployed ? {} : { error: 'Deployment blocked by unresolved dependency failure.' }),
      };
    },
  };

  const verify: Tool<null, { healthy: boolean; attempt: number }> = {
    name: 'mock_verify_deployment',
    description: 'Checks simulated deployment health.',
    riskLevel: RiskLevel.READ_ONLY,
    inputDefinition: { type: 'null' },
    async execute() {
      state.verificationAttempts += 1;
      const forcedFailure = scenario.failFirstVerification && state.verificationAttempts === 1;
      const healthy = !forcedFailure && state.deployed;
      return {
        success: true,
        output: { healthy, attempt: state.verificationAttempts },
        evidence: [evidence(healthy ? 'Deployment verification passed.' : 'Deployment verification failed.', {
          healthy,
          attempt: state.verificationAttempts,
        })],
      };
    },
  };

  const registry = new ToolRegistry();
  registry.registerMany([readLogs, fixDependency, deploy, verify]);
  return { registry, state };
};
