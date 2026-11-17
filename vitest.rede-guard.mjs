/**
 * Guarda de rede da suíte: nenhum teste fala com host real.
 *
 * Desde que o perfil `prod` virou o padrão da CLI (docs/adk-externo, ticket
 * 01), um teste que esquece de mockar o Hub não falha mais por "falta
 * ADK_HUB_URL": ele faz um GET de verdade em api-hub-v2.simplafy.com.br. O
 * `carregarPolitica` engole o erro e cai na política embutida, então o teste
 * seguia verde falando com PRODUÇÃO — sucesso falso dos dois lados.
 *
 * Este módulo envolve o `fetch` global: host que não é loopback nem TLD
 * reservado para teste (RFC 2606/6761) é recusado e a tentativa é anotada no
 * arquivo de `ADK_TEST_REDE_LOG`. Quem reprova o teste é o `afterEach` do
 * `vitest.isolation-setup.ts`, lendo esse arquivo — a recusa sozinha não
 * bastaria, porque o código sob teste pode engolir a exceção.
 *
 * É `.mjs` puro (sem TypeScript) porque também entra por `NODE_OPTIONS
 * --import` nos processos filhos da suíte (o `mcp-server` via `npx tsx`).
 *
 * O MSW instala o interceptor DEPOIS deste módulo e guarda este `fetch` como o
 * "original": requisição mockada nunca chega aqui; a não mockada (com
 * `onUnhandledRequest: 'bypass'`) chega e é recusada.
 */

import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';

const MARCA = Symbol.for('simplafy-adk.guarda-de-rede');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);
const TLD_DE_TESTE = /\.(test|invalid|example|localhost)$/i;

export function hostPermitido(hostname) {
  return LOOPBACK.has(hostname) || TLD_DE_TESTE.test(hostname);
}

function descrever(input, init) {
  const bruto = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
  const metodo = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
  return { url: bruto, metodo: String(metodo ?? 'GET').toUpperCase() };
}

if (typeof globalThis.fetch === 'function' && !globalThis.fetch[MARCA]) {
  const original = globalThis.fetch;
  const vigiado = function fetchVigiado(input, init) {
    const { url, metodo } = descrever(input, init);
    let hostname = '';
    try {
      hostname = new URL(url).hostname;
    } catch {
      return original(input, init);
    }
    if (!hostPermitido(hostname)) {
      const linha = `${metodo} ${url}`;
      const log = process.env.ADK_TEST_REDE_LOG;
      if (log) {
        try {
          appendFileSync(log, `${linha}\n`);
        } catch {
          // Sem onde anotar, a recusa abaixo ainda impede a chamada.
        }
      }
      return Promise.reject(new TypeError(`rede real bloqueada na suíte de testes: ${linha}`));
    }
    return original(input, init);
  };
  vigiado[MARCA] = true;
  globalThis.fetch = vigiado;
}
