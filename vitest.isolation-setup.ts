/**
 * Isola cada worker da máquina de quem roda a suíte.
 *
 * Sem `ADK_HUB_URL`, a CLI aponta para o Hub de PRODUÇÃO (perfil `prod`
 * padrão), e a credencial do `adk login` mora em
 * `$XDG_CONFIG_HOME/simplafy-adk` (ou `~/.config/simplafy-adk`). Sem este
 * setup, um teste que esquecesse de anular uma variável leria o login real do
 * dev e falaria com produção de verdade.
 *
 * Roda em CADA worker (setupFiles), não no `globalSetup`: é o `process.env`
 * do worker que a CLI lê, e é ele que os processos filhos (mcp-server)
 * herdam.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const casaVazia = mkdtempSync(join(tmpdir(), 'adk-test-home-'));

process.env.HOME = casaVazia;
process.env.XDG_CONFIG_HOME = join(casaVazia, '.config');

// Variáveis do shell que mudariam o alvo ou a credencial sem o teste pedir.
for (const nome of ['ADK_HUB_URL', 'ADK_AUTH_URL', 'ADK_PROFILE', 'ADK_TOKEN', 'ADK_CONFIG_DIR']) {
  delete process.env[nome];
}

// --- Guarda de rede -----------------------------------------------------------
//
// Nenhum teste fala com host real (ver `vitest.rede-guard.mjs`). A guarda
// recusa a chamada e ANOTA a tentativa; quem reprova o teste é o `afterEach`
// abaixo — o código sob teste pode engolir a exceção (o `carregarPolitica` cai
// na política embutida), e um teste verde que falou com produção é exatamente
// o sucesso falso que esta guarda existe para pegar.
//
// O arquivo de anotação vai pelo ambiente, e a guarda por `NODE_OPTIONS
// --import`: processos filhos em Node (o `mcp-server` spawnado via `npx tsx`)
// herdam os dois e anotam no mesmo arquivo.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { afterEach } from 'vitest';
import './vitest.rede-guard.mjs';

const logDeRede = join(casaVazia, 'rede-bloqueada.log');
writeFileSync(logDeRede, '');
process.env.ADK_TEST_REDE_LOG = logDeRede;

// `process.cwd()`, não `import.meta.url`: no ambiente jsdom (app-kit) a URL do
// módulo não é `file:`. O vitest roda da raiz do workspace.
const guarda = pathToFileURL(resolve(process.cwd(), 'vitest.rede-guard.mjs')).href;
const importGuarda = `--import=${guarda}`;
if (!(process.env.NODE_OPTIONS ?? '').includes(importGuarda)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${importGuarda}`.trim();
}

afterEach(() => {
  let anotado = '';
  try {
    anotado = readFileSync(logDeRede, 'utf8').trim();
  } catch {
    return;
  }
  if (!anotado) return;
  writeFileSync(logDeRede, '');
  throw new Error(
    'O teste tentou acessar a rede real (host fora de loopback/.test). ' +
      'Mocke o endpoint (msw) ou aponte ADK_HUB_URL para um Hub falso:\n' +
      anotado,
  );
});
