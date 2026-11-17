/**
 * `@simpla.fy/adk-contract` — o contrato de especificação do ADK.
 *
 * Funções PURAS: nada de Prisma, Nest, filesystem ou rede. É o mesmo motor dos
 * dois lados da fronteira — a CLI reprova no `build` exatamente o que o
 * servidor reprovaria no `apply`, com o mesmo código e o mesmo `path`.
 */

export * from './agent-fields.js';
export * from './agent-spec.js';
export * from './journey-spec.js';
export * from './policy.js';
export * from './reference-resolver.js';
export * from './scan-leaks.js';
export * from './spec-gates.js';
export * from './spec-yaml.js';
export * from './team-spec.js';
export * from './tool-contract.js';
export * from './tool-spec.js';
export * from './ui-adherence.js';
