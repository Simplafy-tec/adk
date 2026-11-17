/**
 * `adk init tool|mcp|app <nome>` — o esqueleto mínimo de um componente.
 *
 * Deliberadamente sem CLAUDE.md e sem `.env` versionado: o pacote é do cliente,
 * o segredo fica no Hub (referenciado por nome) e o `.gitignore` já nasce
 * cobrindo `.env*` e `.venv`.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { toSlug } from '@simpla.fy/adk-contract';
import type { Ctx } from '../ctx.js';

export type KindInit = 'tool' | 'mcp' | 'app' | 'team';
export type RuntimeInit = 'python' | 'node';

export function comandoInit(
  ctx: Ctx,
  kind: KindInit,
  nome: string,
  opcoes: { dir?: string; runtime?: RuntimeInit },
): number {
  const slug = toSlug(nome);
  if (!slug) {
    ctx.err(`Nome inválido: "${nome}".`);
    return 2;
  }
  // `--dir` é a RAIZ do componente (mesma semântica de `build --dir` e
  // `dev --dir`); sem ele, `./<slug>`. Sem heurística por existência ou nome
  // da pasta: o mesmo comando tem que produzir a mesma árvore sempre.
  const raiz = resolve(ctx.cwd, opcoes.dir ?? slug);
  if (existsSync(raiz)) {
    ctx.err(`A pasta ${raiz} já existe — escolha outro nome ou apague antes.`);
    return 1;
  }

  const nomeRuntime = slug.replace(/-/g, '_');
  // Runtime é ortogonal ao kind — só o COMO o componente é escrito muda. Nesta
  // fatia (Hub#2.6.26.4) só `kind: mcp` aceita `node`; a validação do valor e
  // da combinação com o kind já aconteceu em `cli.ts` antes de chegar aqui.
  const runtimeNode = kind === 'mcp' && opcoes.runtime === 'node';
  // `kind: app` é Vite+React+TS, não Python: emitir `pyproject.toml`/
  // `.python-version` aqui faria o `adk build` disparar `uv lock`/`ruff` num
  // pacote que não tem uma linha de Python. `kind: mcp --runtime node` é o
  // mesmo raciocínio, num pacote npm em vez de Vite.
  const arquivos: Record<string, string> = runtimeNode
    ? arvoreMcpNode(slug)
    : kind === 'app'
      ? arvoreApp(slug, nomeRuntime)
      : kind === 'team'
        ? arvoreTime(slug)
        : {
            'manifest.yaml': manifesto(kind, slug, nomeRuntime),
            '.python-version': '3.12\n',
            '.gitignore': ['.env*', '.venv/', '__pycache__/', 'dist/', '*.egg-info/', ''].join(
              '\n',
            ),
            'pyproject.toml': pyproject(nomeRuntime, kind),
            'dev/sample-input.json': `${JSON.stringify({ exemplo: 'troque por uma entrada real' }, null, 2)}\n`,
            'README.md': readme(kind, slug, nomeRuntime),
          };

  if (kind === 'tool') {
    arquivos[`tools/${nomeRuntime}.py`] = handlerPy(nomeRuntime);
    arquivos[`tests/test_${nomeRuntime}.py`] = testePy(nomeRuntime);
  }
  if (kind === 'mcp' && !runtimeNode) {
    arquivos['server.py'] = serverPy(nomeRuntime);
    arquivos[`tests/test_${nomeRuntime}.py`] = testeMcpPy();
    // issue#2818 — o manifesto `kind: mcp` exige `image` por digest, e digest só
    // existe depois de um build. Sem estes dois arquivos o autor percorria
    // init → build → test e travava no deploy sem nada que o levasse a uma imagem.
    arquivos['Dockerfile'] = dockerfileMcpPy();
    arquivos['.dockerignore'] = dockerignoreMcpPy();
  }

  for (const [rel, conteudo] of Object.entries(arquivos)) {
    const caminho = join(raiz, rel);
    mkdirSync(dirname(caminho), { recursive: true });
    writeFileSync(caminho, conteudo);
  }

  ctx.out(`Criado ${raiz} (${Object.keys(arquivos).length} arquivos).`);
  // Os três kinds são aceitos no deploy desde a N10 (hub#2.6.21.19). O aviso
  // de recusa que existia aqui sobreviveu à entrega que ele anunciava e passou
  // a mandar o autor não tentar justamente o que já funciona — aviso vencido é
  // pior que aviso nenhum, porque quem lê não tem como saber que a informação
  // venceu. `test/aviso-vencido.test.ts` guarda a reincidência (issue#2771).
  ctx.out(
    runtimeNode
      ? 'Próximo passo: `npm install`, depois `adk build` e `adk deploy --org <id>`.'
      : kind === 'team'
        ? 'Próximo passo: `adk build`. O time entra no Hub por PR no catálogo (`apps/api/src/times/catalogo/<slug>/`), não por `adk deploy`.'
        : 'Próximo passo: `adk build` e `adk deploy --org <id>`.',
  );
  return 0;
}

/** Texto de vitrine nos três idiomas; o autor troca os três. */
function t3(pt: string, en: string, es: string): string {
  return `{ pt: ${JSON.stringify(pt)}, en: ${JSON.stringify(en)}, es: ${JSON.stringify(es)} }`;
}

/**
 * `adk init team <slug>` (ADR-290): o menor `team.yaml` que passa no `adk build` — um time amplo, não liberado, com um membro
 * principal e nenhuma peça. As peças (`call:` ou `spec:`) e o «Falta pouco» entram depois, pelo autor.
 */
function arvoreTime(slug: string): Record<string, string> {
  const yaml = [
    'spec_version: v1',
    'kind: team',
    `slug: ${slug}`,
    'tipo: amplo',
    '# Uma das áreas: comercial, atendimento, operacoes, pos-venda, rh, gestao, marketing, financeiro.',
    'area: comercial',
    'versao: 1',
    '# Time liberado não pode ter peça «Em breve». Comece em false.',
    'liberado: false',
    'avisoParceiro: false',
    '# pequeno | grande',
    'tamanho: pequeno',
    'vitrine:',
    `  nome: ${t3('Troque pelo nome do time', 'Replace with the team name', 'Cambie por el nombre del equipo')}`,
    '  # Frase do cartão: até 110 caracteres por idioma.',
    `  frase: ${t3('Troque pela frase do cartão', 'Replace with the card sentence', 'Cambie por la frase de la tarjeta')}`,
    '  # «Na prática»: de 3 a 4 passos, até 90 caracteres cada, nos três idiomas.',
    '  naPratica:',
    `    - ${t3('Primeiro passo', 'First step', 'Primer paso')}`,
    `    - ${t3('Segundo passo', 'Second step', 'Segundo paso')}`,
    `    - ${t3('Terceiro passo', 'Third step', 'Tercer paso')}`,
    `  canaisSugeridos: ${t3('WhatsApp', 'WhatsApp', 'WhatsApp')}`,
    `  depoisSoVoceFaz: ${t3('Conectar o canal', 'Connect the channel', 'Conectar el canal')}`,
    '  # Id do asset da cena (arte do time na vitrine).',
    '  cena: cena-padrao',
    'equipe:',
    '  # `chave` é a mesma da peça `agents-crt` que cria este agente (quando o time tiver peças).',
    '  - chave: atendente',
    '    papel: principal',
    `    nome: ${t3('Troque pelo nome', 'Replace with the name', 'Cambie por el nombre')}`,
    `    papelTitulo: ${t3('Atendente', 'Attendant', 'Atendente')}`,
    `    oQueFaz: ${t3('Troque pelo que o agente faz', 'Replace with what the agent does', 'Cambie por lo que hace el agente')}`,
    '    # recomendado | rapido | barato (o perfil, não o modelo)',
    '    perfilDeModelo: recomendado',
    '# Cada peça é `call:` (função do MCP completo) OU `spec:` (arquivo do pacote). Veja o README.',
    'pecas: []',
    'faltaPouco: []',
    '',
  ].join('\n');
  const readme = [
    `# ${slug}`,
    '',
    'Pacote de time do ADK (`kind: team`, ADR-290). O arquivo é o `team.yaml`.',
    '',
    '```sh',
    'adk build      # contrato + vazamento + arquivos das peças `spec:`',
    '```',
    '',
    '## Peças',
    '',
    'Cada item de `pecas:` tem `chave`, `rotulo` (pt/en/es, até 80 caracteres), `grupo` e UMA destas formas:',
    '',
    '```yaml',
    'pecas:',
    '  - chave: atendente',
    '    rotulo: { pt: "Agente atendente", en: "Attendant agent", es: "Agente atendente" }',
    '    grupo: agentes',
    '    call:                      # chamada ao MCP completo',
    '      ferramenta: agents-crt',
    '      argumentos: { name: "Atendente", systemPrompt: "..." }',
    '      desfazer: agents-remove  # ou `desfazer: null` com `semDesfazer: { pt, en, es }`',
    '  - chave: boas-vindas',
    '    rotulo: { pt: "Jornada de boas-vindas", en: "Welcome journey", es: "Jornada de bienvenida" }',
    '    grupo: jornadas',
    '    spec:                      # arquivo do pacote num tipo declarativo do ADK',
    '      kind: journey',
    '      arquivo: jornadas/boas-vindas.yaml',
    '```',
    '',
    '`${peca:<chave>.id}` nos argumentos aponta para o id criado por uma peça ANTERIOR da lista.',
    'A função de uma peça `call:` só é conferida no servidor (o catálogo do MCP completo está lá).',
    '',
  ].join('\n');
  return { 'team.yaml': yaml, 'README.md': readme };
}

function manifesto(kind: KindInit, slug: string, nomeRuntime: string): string {
  return kind === 'mcp' ? manifestoMcp(slug) : manifestoTool(slug, nomeRuntime);
}

function manifestoTool(slug: string, nomeRuntime: string): string {
  return [
    'spec_version: v1',
    'kind: tool',
    `slug: ${slug}`,
    'definition:',
    `  name: ${nomeRuntime}`,
    `  display_name: ${slug}`,
    '  # A descrição é o contrato para o modelo decidir quando acionar: mínimo 20 caracteres.',
    `  description: TROQUE — o que ${slug} faz, quando o agente deve chamar e o que devolve.`,
    '  kind: native',
    '  input_schema:',
    '    type: object',
    '    properties: {}',
    '  # Para EMPACOTAR este código Python (runtime: script), os quatro campos',
    '  # abaixo são obrigatórios no apply — sem eles o Hub recusa com',
    '  # `unsupported_python` e `missing_limits`, mesmo com o build local verde.',
    '  # runtime: script',
    '  # python: "3.12"',
    `  # entry: tools/${nomeRuntime}.py`,
    '  # handler: handler',
    '  # limits: { cpu: 1, memory: 512, timeout: 60 }   # teto da classe',
    '',
  ].join('\n');
}

/**
 * `kind: mcp` NÃO tem a forma de uma tool (issue#2768).
 *
 * O manifesto do satélite é chapado — `name`, `image`, `url` no topo —, e o
 * esqueleto que existia aqui era o de tool, com `definition:`. Resultado: todo
 * `adk init mcp` gerava um arquivo que o apply recusava com três erros
 * (`O satélite precisa de um nome de exibição`, `precisa declarar a imagem por
 * digest`, `URL do satélite inválida: undefined`) e que o `adk build` aprovava
 * com 0 issues, porque o contrato público não julga este kind.
 *
 * `image` e `url` nascem como TROQUE porque só o autor sabe o valor; o resto
 * nasce válido, para o esqueleto não pedir edição onde não precisa.
 */
function manifestoMcp(slug: string): string {
  return [
    'spec_version: v1',
    'kind: mcp',
    `slug: ${slug}`,
    `name: ${slug}`,
    '# Imagem do satélite POR DIGEST — tag é mutável e o Hub não aceita.',
    '# Registries permitidos: ghcr.io/simplafy-tec, registry.simplafy.com.br/simplafy-tec',
    `image: TROQUE — ghcr.io/simplafy-tec/${slug}@sha256:<64 hex>`,
    '# URL pública do satélite já em execução (host público, nunca interno).',
    'url: TROQUE — https://<host>/mcp',
    '# Nomes INTERNOS das tools que o servidor expõe (snake_case).',
    'tools: []',
    '',
  ].join('\n');
}

// --- kind: mcp, runtime: node ------------------------------------------------

/**
 * Árvore de `adk init mcp --runtime node` — satélite MCP em Node/TypeScript,
 * irmão de `arvoreApp()`. O manifesto é o MESMO `manifestoMcp(slug)` chapado
 * do caminho Python — reuso direto, sem um campo novo (o runtime não é um
 * campo do manifesto, é só a decisão de COMO o `adk init`/`adk dev` escrevem
 * e sobem o componente).
 */
function arvoreMcpNode(slug: string): Record<string, string> {
  return {
    'manifest.yaml': manifestoMcp(slug),
    '.gitignore': ['.env*', 'node_modules/', 'dist/', ''].join('\n'),
    'package.json': packageJsonMcpNode(slug),
    'tsconfig.json': tsconfigMcpNode(),
    'src/server.ts': serverTsMcpNode(slug),
    'test/server.test.ts': testeMcpNode(),
    'README.md': readmeMcpNode(slug),
    Dockerfile: dockerfileMcpNode(),
    '.dockerignore': dockerignoreMcpNode(),
  };
}

function packageJsonMcpNode(slug: string): string {
  return `${JSON.stringify(
    {
      name: slug,
      private: true,
      type: 'module',
      scripts: {
        // Execução ÚNICA — quem observa e reinicia é o supervisor do `adk dev`.
        // Um `tsx watch`/nodemon aqui dobraria o consumo de inotify (o mesmo
        // ENOSPC medido no verify de 21/09) e devolveria o reinício-por-save
        // ao watcher errado.
        dev: 'tsx src/server.ts',
        test: 'tsx --test test/server.test.ts',
      },
      dependencies: {
        '@modelcontextprotocol/sdk': '^1.30.0',
      },
      devDependencies: {
        '@types/node': '^22.0.0',
        tsx: '^4.19.0',
        typescript: '^5.6.3',
      },
    },
    null,
    2,
  )}\n`;
}

function tsconfigMcpNode(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        // O teste importa `../src/server.ts` com extensão (exigência do ESM sob tsx).
        allowImportingTsExtensions: true,
        types: ['node'],
      },
      include: ['src', 'test'],
    },
    null,
    2,
  )}\n`;
}

/**
 * O servidor gerado — fail-closed por desenho (issue#2670 foi exatamente um
 * satélite respondendo `tools/list`/`tools/call` ANÔNIMO pela ingress
 * pública).
 *
 * `buildServer()` é exportada separada do `listen()` para o harness exercitar
 * 401/200/503 em processo. `MCP_TOKEN` ausente, vazio ou só espaços faz o
 * processo SUBIR mesmo assim e responder 503 em `/mcp` — nunca abrir por falta
 * de configuração; `/health` segue 200. Bind `0.0.0.0` e porta 8000 são os do
 * chart `sol-satellite`: loopback ali é o pod de pé com a probe falhando.
 */
function serverTsMcpNode(slug: string): string {
  return [
    "import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';",
    "import { timingSafeEqual } from 'node:crypto';",
    "import { pathToFileURL } from 'node:url';",
    "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
    "import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';",
    '',
    '// 0.0.0.0 explícito: em loopback o pod sobe, a probe do kubelet (que chega',
    '// pelo IP do pod) falha e o rollout morre sem log. Quem protege é o Bearer.',
    "const HOST = process.env.BIND_ADDRESS?.trim() || '0.0.0.0';",
    '// 8000 é o containerPort do chart do satélite.',
    'const PORT = Number(process.env.PORT?.trim() || 8000);',
    '',
    '/** Ausente, vazio ou só espaços têm o MESMO efeito: fail-closed. */',
    'function tokenConfigurado(): string | undefined {',
    "  const valor = process.env.MCP_TOKEN?.trim() ?? '';",
    '  return valor.length > 0 ? valor : undefined;',
    '}',
    '',
    'function bearerConfere(cabecalho: string | undefined, esperado: string): boolean {',
    "  if (!cabecalho || !cabecalho.startsWith('Bearer ')) return false;",
    "  const recebido = Buffer.from(cabecalho.slice('Bearer '.length));",
    '  const alvo = Buffer.from(esperado);',
    '  // O tamanho tem de ser conferido ANTES do `timingSafeEqual` (que lança se',
    '  // os buffers forem de tamanhos diferentes) — mas comparar por `!==` de',
    '  // tamanho não vaza mais que "não bateu": o valor e o tamanho do segredo',
    '  // nunca aparecem na resposta.',
    '  if (recebido.length !== alvo.length) return false;',
    '  return timingSafeEqual(recebido, alvo);',
    '}',
    '',
    'function responderJson(res: ServerResponse, status: number, corpo: unknown): void {',
    '  const texto = JSON.stringify(corpo);',
    "  res.writeHead(status, { 'Content-Type': 'application/json' });",
    '  res.end(texto);',
    '}',
    '',
    'function criarServidorMcp(): McpServer {',
    `  const mcp = new McpServer({ name: '${slug}', version: '0.1.0' });`,
    '  mcp.registerTool(',
    "    'ping',",
    "    { description: 'Exemplo — troque pela sua tool.' },",
    "    async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }),",
    '  );',
    '  return mcp;',
    '}',
    '',
    '/**',
    ' * `/health` fica FORA da cadeia de auth — uma probe de K8s não pode tomar',
    ' * 401 — e NUNCA responde 503: o chart aponta readiness E liveness para cá,',
    ' * e um 503 aqui vira CrashLoopBackOff que reinício nenhum conserta. O estado',
    ' * da credencial vai no CORPO, não no status.',
    ' */',
    'export function buildServer(): ReturnType<typeof createServer> {',
    '  return createServer(async (req: IncomingMessage, res: ServerResponse) => {',
    "    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);",
    '    const bearerEsperado = tokenConfigurado();',
    '',
    "    if (url.pathname === '/health') {",
    '      return responderJson(res, 200, {',
    "        status: 'ok',",
    '        token_configurado: bearerEsperado !== undefined,',
    "        ...(bearerEsperado === undefined ? { detalhe: 'MCP_TOKEN não configurado' } : {}),",
    '      });',
    '    }',
    '',
    "    if (url.pathname !== '/mcp') {",
    "      return responderJson(res, 404, { error: 'not_found' });",
    '    }',
    '',
    "    if (req.method !== 'POST') {",
    "      return responderJson(res, 405, { error: 'method_not_allowed' });",
    '    }',
    '',
    '    if (!bearerEsperado) {',
    '      // Fail-closed por configuração ausente: nunca atender sem token.',
    '      return responderJson(res, 503, {',
    "        error: 'service_unavailable',",
    "        message: 'MCP_TOKEN não configurado.',",
    '      });',
    '    }',
    '',
    '    if (!bearerConfere(req.headers.authorization, bearerEsperado)) {',
    "      res.setHeader('WWW-Authenticate', 'Bearer');",
    "      return responderJson(res, 401, { error: 'unauthorized' });",
    '    }',
    '',
    '    const transporte = new StreamableHTTPServerTransport({',
    '      sessionIdGenerator: undefined,',
    '      enableJsonResponse: true,',
    '    });',
    '    const mcp = criarServidorMcp();',
    '    await mcp.connect(transporte);',
    "    res.on('close', () => {",
    '      // Sem `.catch`, uma rejeição aqui é unhandled rejection: o Node derruba o',
    '      // processo e, no satélite, um request encerrado no meio vira pod reiniciando.',
    "      transporte.close().catch((erro: unknown) => console.error('Falha ao fechar o transporte MCP:', erro));",
    "      mcp.close().catch((erro: unknown) => console.error('Falha ao fechar o servidor MCP:', erro));",
    '    });',
    '    await transporte.handleRequest(req, res);',
    '  });',
    '}',
    '',
    '// Só sobe de verdade quando executado diretamente (`npm run dev`/`node dist/server.js`)',
    '// — importar `buildServer` (como o harness de teste faz) nunca abre uma porta.',
    'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {',
    '  const server = buildServer();',
    '  server.listen(PORT, HOST, () => {',
    '    console.error(`MCP em http://${HOST}:${PORT}/mcp`);',
    '  });',
    '}',
    '',
  ].join('\n');
}

function testeMcpNode(): string {
  return [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { buildServer } from '../src/server.ts';",
    '',
    "const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };",
    '',
    'interface RespostaJsonRpc {',
    '  result?: { tools?: unknown[]; isError?: boolean; content?: { text?: string }[] };',
    '}',
    '',
    'function corpoToolsList() {',
    "  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });",
    '}',
    '',
    'async function comServidor(usar: (base: string) => Promise<void>): Promise<void> {',
    '  const server = buildServer();',
    "  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));",
    '  const endereco = server.address();',
    "  const porta = typeof endereco === 'object' && endereco ? endereco.port : 0;",
    '  try {',
    '    await usar(`http://127.0.0.1:${porta}`);',
    '  } finally {',
    '    await new Promise<void>((resolve) => server.close(() => resolve()));',
    '  }',
    '}',
    '',
    "test('anônimo é recusado com 401 quando o token está configurado', async () => {",
    "  process.env.MCP_TOKEN = 'seg-dev';",
    '  await comServidor(async (base) => {',
    "    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: HEADERS, body: corpoToolsList() });",
    '    assert.equal(res.status, 401);',
    '  });',
    '});',
    '',
    "test('Bearer correto lista as tools com 200', async () => {",
    "  process.env.MCP_TOKEN = 'seg-dev';",
    '  await comServidor(async (base) => {',
    '    const res = await fetch(`${base}/mcp`, {',
    "      method: 'POST',",
    "      headers: { ...HEADERS, Authorization: 'Bearer seg-dev' },",
    '      body: corpoToolsList(),',
    '    });',
    '    assert.equal(res.status, 200);',
    '    const corpo = (await res.json()) as RespostaJsonRpc;',
    '    assert.ok(Array.isArray(corpo.result?.tools));',
    '  });',
    '});',
    '',
    "test('tools/call da tool de exemplo devolve o resultado — exercita a chamada, não só o registro', async () => {",
    "  process.env.MCP_TOKEN = 'seg-dev';",
    '  await comServidor(async (base) => {',
    '    const res = await fetch(`${base}/mcp`, {',
    "      method: 'POST',",
    "      headers: { ...HEADERS, Authorization: 'Bearer seg-dev' },",
    "      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ping', arguments: {} } }),",
    '    });',
    '    assert.equal(res.status, 200);',
    '    const corpo = (await res.json()) as RespostaJsonRpc;',
    '    assert.equal(corpo.result?.isError ?? false, false, JSON.stringify(corpo));',
    "    assert.equal(corpo.result?.content?.[0]?.text, 'pong');",
    '  });',
    '});',
    '',
    "test('sem MCP_TOKEN o servidor sobe e /mcp responde 503, fail-closed (mas /health continua 200)', async () => {",
    '  delete process.env.MCP_TOKEN;',
    '  await comServidor(async (base) => {',
    "    const semToken = await fetch(`${base}/mcp`, { method: 'POST', headers: HEADERS, body: corpoToolsList() });",
    '    assert.equal(semToken.status, 503);',
    '    const health = await fetch(`${base}/health`);',
    '    assert.equal(health.status, 200);',
    '  });',
    '});',
    '',
  ].join('\n');
}

function readmeMcpNode(slug: string): string {
  return [
    `# ${slug}`,
    '',
    'Satélite MCP (`kind: mcp`, runtime Node/TypeScript) do ADK da Simplafy.',
    '',
    '## Ciclo',
    '',
    '```sh',
    'npm install',
    'adk dev       # sobe o servidor (PORT, default 8000) e reinicia a cada save',
    'adk test      # harness do próprio componente (node --test via tsx)',
    'adk build     # contrato + vazamento + dependências declaradas + política',
    'adk deploy --env staging --org <orgId>',
    '```',
    '',
    '## Auth (fail-closed)',
    '',
    '- `MCP_TOKEN` é a ÚNICA entrada de segredo — vem do ambiente (no `adk dev`,',
    '  o do seu terminal) e NUNCA do código;',
    '- sem Bearer, com Bearer errado ou malformado: **401**, nunca 500;',
    '- `MCP_TOKEN` ausente, vazio ou só espaços: o processo sobe mesmo assim e',
    '  responde **503** em `/mcp` — nunca atende sem token configurado;',
    '- `GET /health` NUNCA responde 503 (é readiness/liveness do chart): sempre',
    '  **200**, com o estado da credencial no CORPO da resposta.',
    '',
    '## Regras que o `build` aplica',
    '',
    '- segredo, PII e identificador interno **reprovam** o build com o mesmo código',
    '  que o servidor devolve no apply (`secret_literal`, `pii_in_config`, `internal_id`);',
    '- dependência importada em `src/` e ausente do `package.json` reprova o build;',
    '- `.env*` não é versionado e fica FORA da varredura — é o lugar certo do segredo local.',
    '',
    '## Imagem',
    '',
    '`docker build .` gera a imagem não-root que escuta em `0.0.0.0:8000`; o `image`',
    'do `manifest.yaml` é o digest dela. A imagem instala com `npm ci`: versione o',
    '`package-lock.json` que o `npm install` gera.',
    '',
  ].join('\n');
}

/**
 * Dockerfile do satélite Node — mesmas regras do Python (`dockerfileMcpPy`):
 * NÃO-ROOT com uid numérico (o `runAsNonRoot` do kubelet só verifica uid) e o
 * `USER` depois do último `COPY`, código de root e somente leitura.
 *
 * `tsx` roda o TypeScript direto, sem etapa de compilação: é o mesmo
 * entrypoint do `adk dev`, então o que passou local é o que sobe no pod.
 */
function dockerfileMcpNode(): string {
  return [
    'FROM node:20-slim',
    '',
    'WORKDIR /app',
    '# package-lock.json é OBRIGATÓRIO (versione o lock gerado na sua máquina): sem ele o',
    '# COPY falha e o `npm ci` impede a imagem de resolver dependência por conta própria.',
    'COPY package.json package-lock.json ./',
    'RUN npm ci --no-audit --no-fund && npm cache clean --force',
    '',
    'COPY . .',
    '',
    'USER 10001',
    '',
    'ENV NODE_ENV=production BIND_ADDRESS=0.0.0.0 PORT=8000',
    'EXPOSE 8000',
    'CMD ["node_modules/.bin/tsx", "src/server.ts"]',
    '',
  ].join('\n');
}

/**
 * Sem isto o `COPY . .` leva o `node_modules` do host por cima do instalado na
 * imagem — e o `.npmrc`, que costuma guardar o token do registry, para dentro dela.
 */
function dockerignoreMcpNode(): string {
  return ['node_modules/', '.env*', '.npmrc', '.git/', 'dist/', 'test/', ''].join('\n');
}

function pyproject(nomeRuntime: string, kind: KindInit): string {
  // `kind: mcp` gera um `server.py` que importa `mcp.server.fastmcp`. Sem a
  // dependência aqui, o venv que o `adk test` monta com `uv sync` sai sem a
  // biblioteca e a suíte morre na COLETA (`ModuleNotFoundError: No module
  // named 'mcp'`) — num projeto recém-criado, antes de o autor escrever
  // qualquer linha. `tool` fica sem dependência de propósito: o handler
  // gerado só usa a stdlib, e embutir um servidor MCP que ela nunca importa
  // engordaria o bundle de toda tool.
  //
  // O TETO `<2` não é conservadorismo: na 2.x o `FastMCP` que o `server.py`
  // gerado importa foi RENOMEADO para `MCPServer` (`mcp.server.mcpserver`).
  // Sem o teto, `uv lock` resolve para a 2.x e o `adk test` volta a morrer na
  // coleta — com outra mensagem, mas no mesmo lugar. Medido: só `>=1.2`
  // reproduz o defeito. Trocar o teto exige reescrever o `serverPy` junto.
  const dependencias = kind === 'mcp' ? '["mcp>=1.2,<2", "uvicorn>=0.30"]' : '[]';
  return [
    '[project]',
    `name = "${nomeRuntime.replace(/_/g, '-')}"`,
    'version = "0.1.0"',
    '# Travado na versão que a plataforma executa — ver `adk doctor`.',
    'requires-python = "==3.12.*"',
    `dependencies = ${dependencias}`,
    '',
    '[dependency-groups]',
    'dev = ["pytest>=8", "ruff>=0.6"]',
    '',
    '# Mesma configuração do resto da casa (simplafy-ia): divergir aqui faria a',
    '# tool do cliente lintar diferente de todo o código da plataforma.',
    '[tool.ruff]',
    'target-version = "py312"',
    'line-length = 120',
    '',
    '[tool.ruff.lint]',
    'select = ["E", "F", "W", "I"]',
    '',
    '# Sem isto o teste não enxerga `tools/`: o pacote não é instalado, é',
    '# executado a partir da raiz (mesma forma que o `adk dev` carrega o handler).',
    '[tool.pytest.ini_options]',
    'pythonpath = ["."]',
    '',
  ].join('\n');
}

function handlerPy(nomeRuntime: string): string {
  return [
    '"""Handler da tool — entrada e saída são JSON serializável."""',
    '',
    '',
    'def handler(input: dict) -> dict:',
    '    """Recebe o input validado contra `input_schema` e devolve o resultado.',
    '',
    '    Segredo NUNCA vem daqui: credencial é referenciada por nome no manifesto',
    '    e resolvida pelo Hub no momento da execução.',
    '    """',
    `    return {"ok": True, "tool": "${nomeRuntime}", "echo": input}`,
    '',
  ].join('\n');
}

function testePy(nomeRuntime: string): string {
  return [
    'import json',
    'from pathlib import Path',
    '',
    `from tools.${nomeRuntime} import handler`,
    '',
    '',
    'def test_handler_devolve_dict():',
    '    entrada = json.loads(Path("dev/sample-input.json").read_text())',
    '    assert isinstance(handler(entrada), dict)',
    '',
  ].join('\n');
}

/**
 * issue#2848 — o esqueleto nasce EXIGINDO credencial.
 *
 * A URL do satélite é pública por desenho: o Hub a registra e a chama de fora
 * do cluster, e o `McpServerRegistration` manda `Authorization`. Mas header
 * enviado não é header conferido — se o servidor não valida, ele é decoração,
 * e `initialize`/`tools/list`/`tools/call` respondem a qualquer um na
 * internet. Foi exatamente o que aconteceu com o primeiro satélite de cliente:
 * FastMCP puro, sem validação, com tools que escreviam no CRM de PRODUÇÃO do
 * cliente usando a credencial que vive no pod.
 *
 * Contrato (o mesmo do runtime `node`, para os dois esqueletos não divergirem):
 *  - `/health` responde 200 SEMPRE — readiness e liveness do chart apontam
 *    para lá, e 503 ali derruba o pod em vez de proteger o que importa;
 *  - `POST /mcp` responde 503 quando falta `MCP_TOKEN`, ANTES de olhar o
 *    Bearer: sem credencial configurada não há como autenticar ninguém, e 401
 *    sugeriria que existe credencial certa;
 *  - Bearer ausente ou errado ⇒ 401 com `www-authenticate`.
 *
 * Comparação em tempo constante (`hmac.compare_digest`): comparar token com
 * `==` vaza o prefixo correto pelo tempo de resposta.
 */
function serverPy(nomeRuntime: string): string {
  return [
    '"""Esqueleto de servidor MCP (FastMCP) — publicável por `adk deploy`.',
    '',
    'A URL deste satélite é PÚBLICA: o Hub a registra e a chama de fora do',
    'cluster. Por isso a autenticação é responsabilidade DESTE processo — não',
    'do registro no Hub, que apenas envia o header.',
    '"""',
    '',
    'import hmac',
    'import os',
    '',
    'from mcp.server.fastmcp import FastMCP',
    'from starlette.responses import JSONResponse',
    'from starlette.routing import Route',
    '',
    `mcp = FastMCP("${nomeRuntime}")`,
    '',
    '',
    '@mcp.tool()',
    'def ping() -> str:',
    '    """Exemplo — troque pela sua tool."""',
    '    return "pong"',
    '',
    '',
    'def _token_configurado() -> str:',
    '    return os.environ.get("MCP_TOKEN", "").strip()',
    '',
    '',
    'async def health(_request):',
    '    # 200 SEMPRE: a probe do chart aponta para cá. Devolver 503 aqui por',
    '    # falta de credencial derruba o pod sem fechar o que está aberto.',
    '    return JSONResponse({"status": "ok", "servidor": mcp.name})',
    '',
    '',
    'class ExigirBearer:',
    '    """Fail-closed: sem token configurado ninguém entra; sem Bearer correto, 401."""',
    '',
    '    def __init__(self, app, aberto=("/health",)):',
    '        self.app = app',
    '        self.aberto = tuple(aberto)',
    '',
    '    async def __call__(self, scope, receive, send):',
    '        if scope["type"] != "http" or scope.get("path", "") in self.aberto:',
    '            await self.app(scope, receive, send)',
    '            return',
    '        esperado = _token_configurado()',
    '        if not esperado:',
    '            resp = JSONResponse(',
    '                {"error": "satelite sem credencial configurada"}, status_code=503',
    '            )',
    '            await resp(scope, receive, send)',
    '            return',
    '        recebido = ""',
    '        for nome, valor in scope.get("headers", []):',
    '            if nome.decode("latin-1").lower() == "authorization":',
    '                recebido = valor.decode("latin-1")',
    '                break',
    '        # Tempo constante: `==` vaza o prefixo correto pelo tempo de resposta.',
    '        if not hmac.compare_digest(recebido.strip(), f"Bearer {esperado}"):',
    '            resp = JSONResponse(',
    '                {"error": "credencial ausente ou invalida"},',
    '                status_code=401,',
    '                headers={"www-authenticate": "Bearer"},',
    '            )',
    '            await resp(scope, receive, send)',
    '            return',
    '        await self.app(scope, receive, send)',
    '',
    '',
    '_base = mcp.streamable_http_app()',
    '_base.routes.append(Route("/health", health, methods=["GET"]))',
    'app = ExigirBearer(_base)',
    '',
    '',
    'if __name__ == "__main__":',
    '    import uvicorn',
    '',
    '    # Transporte HTTP e bind 0.0.0.0 EXPLÍCITOS: `mcp.run()` sem argumento é',
    '    # stdio e o host default do FastMCP é loopback — nos dois casos o pod sobe,',
    '    # a probe falha e o log não diz nada. Quem protege é o Bearer, não o bind.',
    '    uvicorn.run(',
    '        app,',
    '        host=os.environ.get("BIND_ADDRESS", "").strip() or "0.0.0.0",',
    '        port=int(os.environ.get("PORT", "").strip() or "8000"),',
    '    )',
    '',
  ].join('\n');
}

/**
 * issue#2818 — Dockerfile do satélite Python.
 *
 *  - NÃO-ROOT (uid 10001): o satélite atende `tools/call` vindo da internet e o
 *    namespace `sol-*` roda com `pod-security enforce: baseline`;
 *  - dependências a partir do `pyproject.toml`/`uv.lock` (o `adk build` gera o
 *    lock), para a imagem não ter uma segunda lista de dependências;
 *  - escuta em 0.0.0.0:8000, o default do próprio `server.py` (porta do chart).
 *
 * Biblioteca de SISTEMA (ex.: pango/cairo do WeasyPrint) não entra no esqueleto:
 * o `server.py` gerado só usa Python puro. Quem adicionar uma dependência que
 * carrega lib nativa em runtime precisa instalá-la no bloco `apt-get` abaixo —
 * sem ela o `/health` responde 200 e só a primeira chamada de tool quebra.
 */
function dockerfileMcpPy(): string {
  return [
    'FROM python:3.12-slim',
    '',
    'ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1',
    '',
    '# Libs de sistema que as suas dependências carregam em runtime (ex.: WeasyPrint',
    '# → libpango-1.0-0 libcairo2 libharfbuzz0b libgdk-pixbuf-2.0-0 libfontconfig1',
    '# libfreetype6 fonts-liberation). O esqueleto não precisa de nenhuma.',
    '# RUN apt-get update && apt-get install -y --no-install-recommends <libs> \\',
    '#     && rm -rf /var/lib/apt/lists/*',
    '',
    '# uv fixado: imagem reprodutível, sem puxar a última versão a cada build.',
    'RUN pip install uv==0.10.4',
    '',
    'WORKDIR /app',
    '# uv.lock é OBRIGATÓRIO (gerado por `adk build`): sem ele o COPY falha e o',
    '# `--locked` impede a imagem de resolver dependência por conta própria.',
    'COPY pyproject.toml uv.lock ./',
    'RUN UV_NO_CACHE=1 uv sync --locked --no-dev --no-install-project',
    '',
    'COPY . .',
    '',
    '# Código e .venv ficam de root e somente leitura para o usuário que atende a',
    '# internet: sem trocar dono (não duplica a camada do .venv) e sem escrita em /app.',
    'RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin app',
    'USER 10001',
    '',
    'ENV PATH="/app/.venv/bin:$PATH" BIND_ADDRESS=0.0.0.0 PORT=8000',
    'EXPOSE 8000',
    'CMD ["python", "server.py"]',
    '',
  ].join('\n');
}

/**
 * `.dockerignore` é obrigatório, não opcional (issue#2818): sem ele `COPY . .`
 * leva o `.venv` inteiro (medido: contexto 202 MB → 1,5 MB) e um `site-packages`
 * copiado carrega caminhos absolutos do host. `.env*` também fica de fora: o
 * segredo vive no Hub, nunca na imagem.
 */
function dockerignoreMcpPy(): string {
  return [
    '.venv/',
    '__pycache__/',
    '*.pyc',
    '.env*',
    '.git/',
    'dist/',
    '*.egg-info/',
    'tests/',
    'dev/',
    '',
  ].join('\n');
}

/**
 * O harness CHAMA a tool, não só importa o servidor: dependência nativa
 * carregada em runtime (ex.: pango do WeasyPrint) passa no import e só quebra
 * na primeira chamada.
 */
function testeMcpPy(): string {
  return [
    'import asyncio',
    '',
    'from server import mcp',
    '',
    '',
    'def test_tool_de_exemplo_responde():',
    '    resultado = asyncio.run(mcp.call_tool("ping", {}))',
    '    conteudo = resultado[0] if isinstance(resultado, tuple) else resultado',
    '    assert [c.text for c in conteudo] == ["pong"]',
    '',
  ].join('\n');
}

function readme(kind: KindInit, slug: string, nomeRuntime: string): string {
  const linhas = [
    `# ${slug}`,
    '',
    `Componente \`${kind}\` do ADK da Simplafy.`,
    '',
    '## Ciclo',
    '',
    '```sh',
    'adk build     # contrato + vazamento + uv lock + ruff + política',
    'adk test      # uv run pytest',
    'adk dev       # revalida e executa o handler a cada save',
    'adk deploy --org <orgId>',
    '```',
    '',
    '## Regras que o `build` aplica',
    '',
    '- segredo, PII e identificador interno **reprovam** o build com o mesmo código',
    '  que o servidor devolve no apply (`secret_literal`, `pii_in_config`, `internal_id`);',
    '- `.env*` não é versionado e fica FORA da varredura — é o lugar certo do segredo local;',
    '- credencial de produção é referenciada por nome e resolvida no Hub.',
    '',
  ];
  if (kind === 'tool') {
    linhas.push(
      '## Assinatura do handler',
      '',
      `\`handler(input) -> dict\` em \`tools/${nomeRuntime}.py\`, executado por \`uv run\`.`,
      '',
      '> Esta é uma assinatura DIFERENTE da convenção interna do `simplafy-ia`',
      '> (`@tool` + `@mcp_tool` + pydantic, in-process no LangChain). As duas convivem:',
      '> aqui o componente é um script autônomo do cliente, lá é código da plataforma.',
      '',
    );
  } else {
    linhas.push(
      '## Publicar',
      '',
      `\`kind: ${kind}\` é aceito no deploy: declare o componente em`,
      '`orgs/<org>/' +
        (kind === 'mcp' ? 'mcp' : 'apps') +
        '/<slug>/` no repositório de clientes e rode',
      '`adk deploy --org <id>`.',
      '',
    );
  }
  return linhas.join('\n');
}

// --- kind: app --------------------------------------------------------------

/**
 * Árvore de `adk init app` — Vite + React + TS sobre `@simpla.fy/app-kit`.
 *
 * Nasce aderente de propósito: nenhuma cor literal, nenhuma fonte fora do token
 * e o logo só por `<Brand/>`. Um esqueleto que já reprovasse no próprio
 * `adk build` ensinaria o time a ignorar o `ui_adherence`.
 */
function arvoreApp(slug: string, nomeRuntime: string): Record<string, string> {
  return {
    'manifest.yaml': manifestoApp(slug, nomeRuntime),
    '.gitignore': [
      '.env*',
      'node_modules/',
      'dist/',
      '.vite/',
      'build/',
      'adk-dev/',
      'storybook-static/',
      '',
    ].join('\n'),
    'package.json': packageJsonApp(slug),
    'tsconfig.json': tsconfigApp(),
    'vite.config.ts': viteConfigApp(),
    'index.html': indexHtmlApp(slug),
    'src/main.tsx': mainTsx(),
    'src/App.tsx': appTsx(slug),
    'src/index.css': indexCssApp(),
    // O contexto que o Hub injeta na tela (org, usuária, tema). Nome diferente
    // de `sample-input.json` de propósito: app não recebe input de tool.
    'dev/sample-context.json': `${JSON.stringify(
      {
        org: { id: 'org-exemplo', name: 'Organização de exemplo' },
        user: { id: 'user-exemplo', name: 'Usuária de exemplo', roles: ['admin'] },
        theme: 'light',
      },
      null,
      2,
    )}\n`,
    'README.md': readmeApp(slug),
  };
}

function manifestoApp(slug: string, nomeRuntime: string): string {
  return [
    'spec_version: v1',
    'kind: app',
    `slug: ${slug}`,
    '# `name` e `icon` são COLUNAS do registro: o apply recusa o app sem eles',
    '# (issue#2768). Nascem válidos aqui — troque pelo nome e ícone reais.',
    `name: ${slug}`,
    'icon: puzzle',
    '# Onde o Hub encontra a tela e o bundle publicado.',
    'entryPoints:',
    '  ui: src/App.tsx',
    '  html: index.html',
    'ui:',
    '  # Lint de aderência ao design system no build E no apply (ADR-120 §5).',
    '  adherence: true',
    'definition:',
    `  name: ${nomeRuntime}`,
    `  display_name: ${slug}`,
    '  # A descrição aparece no Hub e é o contrato do app: mínimo 20 caracteres.',
    `  description: TROQUE — o que ${slug} mostra na tela e para quem serve.`,
    '  kind: native',
    '  input_schema:',
    '    type: object',
    '    properties: {}',
    '',
  ].join('\n');
}

function packageJsonApp(slug: string): string {
  return `${JSON.stringify(
    {
      name: slug,
      private: true,
      type: 'module',
      scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
      dependencies: {
        // Acompanha o release do kit: com `^0.1.0` o app gerado continuaria
        // instalando a 0.1.0 (caret em 0.x não cruza o minor) — sem o fix do
        // referrer da issue#2593, que é justamente o que faz a ponte achar o
        // host dentro do Hub.
        '@simpla.fy/app-kit': '^0.3.0',
        react: '^19.0.0',
        'react-dom': '^19.0.0',
      },
      devDependencies: {
        '@tailwindcss/vite': '^4.1.0',
        '@types/react': '^19.0.0',
        '@types/react-dom': '^19.0.0',
        '@vitejs/plugin-react': '^4.3.4',
        tailwindcss: '^4.1.0',
        typescript: '^5.6.3',
        vite: '^6.0.0',
      },
    },
    null,
    2,
  )}\n`;
}

function tsconfigApp(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['src'],
    },
    null,
    2,
  )}\n`;
}

function viteConfigApp(): string {
  return [
    "import tailwindcss from '@tailwindcss/vite';",
    "import react from '@vitejs/plugin-react';",
    "import { defineConfig } from 'vite';",
    '',
    '// 127.0.0.1, nunca 0.0.0.0: o `adk dev` embute esta tela num iframe do Hub',
    '// shell local — um servidor de desenvolvimento não sai da máquina.',
    'export default defineConfig({',
    '  plugins: [react(), tailwindcss()],',
    "  server: { host: '127.0.0.1', port: 5173 },",
    '});',
    '',
  ].join('\n');
}

function indexHtmlApp(slug: string): string {
  return [
    '<!doctype html>',
    '<html lang="pt-BR">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `    <title>${slug}</title>`,
    '  </head>',
    '  <body>',
    '    <div id="root"></div>',
    '    <script type="module" src="/src/main.tsx"></script>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

function mainTsx(): string {
  return [
    "import { StrictMode } from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import { App } from './App';",
    "import './index.css';",
    '',
    "const raiz = document.getElementById('root');",
    'if (!raiz) throw new Error(\'index.html precisa de <div id="root">.\');',
    '',
    'createRoot(raiz).render(',
    '  <StrictMode>',
    '    <App />',
    '  </StrictMode>,',
    ');',
    '',
  ].join('\n');
}

function appTsx(slug: string): string {
  return [
    "import { Brand, Button, Card, useHost } from '@simpla.fy/app-kit';",
    '',
    '/**',
    ' * O tema vem do host pela ponte — nada de cor literal aqui: o token muda',
    ' * quando a pessoa troca de tema no Hub, sem rebuild.',
    ' */',
    'export function App() {',
    '  const host = useHost();',
    '',
    '  return (',
    '    <Card>',
    '      <Brand />',
    `      <p style={{ color: 'var(--color-muted-foreground)' }}>Sua tela de ${slug} começa aqui.</p>`,
    '      <Button',
    "        onClick={() => host.toast({ variant: 'success', title: 'Olá do app' })}",
    '      >',
    '        Enviar toast ao Hub',
    '      </Button>',
    '    </Card>',
    '  );',
    '}',
    '',
  ].join('\n');
}

function indexCssApp(): string {
  return [
    "@import 'tailwindcss';",
    '/* Tokens do design system + registro deles como utilitários do Tailwind. */',
    "@import '@simpla.fy/app-kit/theme.css';",
    '',
    '/* O Tailwind não escaneia node_modules por padrão: sem isto, as classes',
    '   usadas DENTRO dos componentes do app-kit não geram utilitário. */',
    '@source "../node_modules/@simpla.fy/app-kit/dist";',
    '',
    '/* Só o token do design system entra aqui — cor literal reprova no build. */',
    'body {',
    '  margin: 0;',
    '  font-family: var(--font-sans);',
    '  background: var(--color-background);',
    '  color: var(--color-foreground);',
    '}',
    '',
  ].join('\n');
}

function readmeApp(slug: string): string {
  return [
    `# ${slug}`,
    '',
    'App do Hub (ADK `kind: app`), em Vite + React + TypeScript sobre',
    '[`@simpla.fy/app-kit`](https://www.npmjs.com/package/@simpla.fy/app-kit).',
    '',
    '## Ciclo',
    '',
    '```sh',
    'npm install',
    'adk dev       # Vite (HMR) + Hub shell local em 127.0.0.1',
    'adk build     # aderência ao design system + vazamento + política',
    '```',
    '',
    '## Regras que o `build` aplica',
    '',
    '- `ui_adherence`: cor literal, fonte fora do token e logo fora de `<Brand/>` **reprovam**',
    '  o build com o MESMO código que o apply do Hub devolve;',
    '- segredo, PII e identificador interno reprovam (`secret_literal`, `pii_in_config`, `internal_id`);',
    '- `.env*` não é versionado e fica FORA da varredura — é o lugar certo do segredo local.',
    '',
    '## Falando com o Hub',
    '',
    'A tela roda num `<iframe>`. Toda troca com o host passa pela ponte versionada',
    '(`useHost()`): `toast`, `dialog`, `navigate` e `theme`. Origem é conferida por',
    'allowlist dos dois lados — nada de autoridade (organização, token) vem do',
    '`postMessage`.',
    '',
  ].join('\n');
}
