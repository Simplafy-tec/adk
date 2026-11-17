import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// hub#2.6.21.18 (N21) — Plugin para harnesses (skills + MCP + hooks).
//
// Padrão do repo (ver test/publish.test.ts): ler o arquivo e assertar o
// CONTEÚDO, nunca só "o arquivo existe". As skills são o mapa que o agente
// segue sem CLAUDE.md — o teste tem de reprovar se o mapa mentir ou faltar
// um passo do ciclo doctor → login → init → dev → build → test → deploy.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN_DIR = join(ROOT, 'plugin');
const SKILLS_DIR = join(PLUGIN_DIR, 'skills');

const SKILL_NAMES = [
  // ticket 06 (adk-externo): caminho de início só-produção para o integrador externo.
  'adk-comecar',
  'adk-doctor-login',
  'adk-init',
  'adk-dev',
  'adk-build',
  'adk-test',
  'adk-deploy',
] as const;

function lerSkill(nome: string): string {
  return readFileSync(join(SKILLS_DIR, nome, 'SKILL.md'), 'utf8');
}

function todasAsSkills(): string {
  return SKILL_NAMES.map(lerSkill).join('\n');
}

function frontmatter(conteudo: string): { name?: string; description?: string } {
  const m = conteudo.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const bloco = m[1];
  const nome = bloco.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const descricao = bloco.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name: nome, description: descricao };
}

// --- 1. Marketplace instalável -------------------------------------------

describe('.claude-plugin/marketplace.json', () => {
  const marketplacePath = join(ROOT, '.claude-plugin', 'marketplace.json');

  it('parseia, tem exatamente 1 plugin com source "./plugin"', () => {
    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'));
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].source).toBe('./plugin');
  });

  it('o source resolve a partir da RAIZ do repo e contém .claude-plugin/plugin.json', () => {
    // Resolver a partir de `.claude-plugin/` é a convenção ERRADA — foi o que
    // levou a versão anterior a commitar um symlink `.claude-plugin/plugin`
    // só para o teste passar. Conferido nos marketplaces reais instalados: o
    // `365-skills` declara `source: "./plugins/drawio"` e o diretório está na
    // RAIZ do repo, não dentro de `.claude-plugin/`.
    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'));
    const source = marketplace.plugins[0].source as string;
    const resolvido = resolve(ROOT, source);
    expect(existsSync(join(resolvido, '.claude-plugin', 'plugin.json'))).toBe(true);
    // E nada de segundo caminho para dentro da árvore do plugin.
    expect(existsSync(join(ROOT, '.claude-plugin', 'plugin'))).toBe(false);
  });
});

// --- 2. Manifesto enumera as skills ---------------------------------------

describe('plugin/.claude-plugin/plugin.json', () => {
  const pluginJsonPath = join(PLUGIN_DIR, '.claude-plugin', 'plugin.json');

  it('nomeia o plugin simplafy-adk e tem version/description/license', () => {
    const manifesto = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
    expect(manifesto.name).toBe('simplafy-adk');
    expect(manifesto.version).toBeTruthy();
    expect(manifesto.description).toBeTruthy();
    expect(manifesto.license).toBeTruthy();
  });

  it('skills[] lista os 7 caminhos e cada SKILL.md correspondente existe', () => {
    const manifesto = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
    expect(manifesto.skills).toHaveLength(SKILL_NAMES.length);
    for (const caminho of manifesto.skills as string[]) {
      const resolvido = resolve(PLUGIN_DIR, caminho, 'SKILL.md');
      expect(existsSync(resolvido)).toBe(true);
    }
    const nomesNoManifesto = (manifesto.skills as string[]).map((c) => c.replace(/^\.\/?skills\//, ''));
    for (const nome of SKILL_NAMES) {
      expect(nomesNoManifesto).toContain(nome);
    }
  });
});

// --- 3. Frontmatter de cada skill ------------------------------------------

describe.each(SKILL_NAMES)('plugin/skills/%s/SKILL.md — frontmatter', (nome) => {
  it('name igual ao diretório e description com gatilho "Use quando"', () => {
    const conteudo = lerSkill(nome);
    const fm = frontmatter(conteudo);
    expect(fm.name).toBe(nome);
    expect(fm.description).toBeTruthy();
    expect(fm.description).toMatch(/Use quando/);
  });
});

// --- 4/5. adk-doctor-login --------------------------------------------------

describe('plugin/skills/adk-doctor-login/SKILL.md', () => {
  it('ensina autenticar: cita adk login, adk whoami, ADK_HUB_URL e o efeito do ADK_TOKEN', () => {
    const conteudo = lerSkill('adk-doctor-login');
    expect(conteudo).toContain('adk login');
    expect(conteudo).toContain('adk whoami');
    expect(conteudo).toContain('ADK_HUB_URL');
    expect(conteudo).toMatch(/ADK_TOKEN/);
  });

  it('não fossiliza número de versão de runtime e manda consultar a fonte viva', () => {
    const conteudo = lerSkill('adk-doctor-login');
    expect(conteudo).not.toMatch(/3\.12|>=\s*0?\.?4|node\s*(>=\s*)?20/i);
    expect(conteudo).toMatch(/adk doctor|get_policy/);
  });
});

// --- 6. adk-init -------------------------------------------------------------

describe('plugin/skills/adk-init/SKILL.md', () => {
  // O `toContain('unknown_kind')` que existia aqui exigia da skill o aviso
  // "recusado até a N10" — o teste tinha virado a guarda do aviso VENCIDO
  // (issue#2771). No lugar, exige o que o autor precisa saber para o deploy
  // achar o arquivo: a pasta de cada kind.
  it('amarra app -> npm install -> adk dev nessa ordem, e diz onde cada kind mora', () => {
    const conteudo = lerSkill('adk-init');
    const idxInit = conteudo.indexOf('adk init app');
    const idxInstall = conteudo.indexOf('npm install');
    const idxDev = conteudo.indexOf('adk dev');
    expect(idxInit).toBeGreaterThan(-1);
    expect(idxInstall).toBeGreaterThan(-1);
    expect(idxDev).toBeGreaterThan(-1);
    expect(idxInit).toBeLessThan(idxInstall);
    expect(idxInstall).toBeLessThan(idxDev);
    expect(conteudo).toMatch(/orgs\/<org>\/mcp\//);
    expect(conteudo).toMatch(/orgs\/<org>\/apps\//);
  });

  // Hub#2.6.26.4 — o satélite Node é um segundo ciclo de scaffold, e a mesma
  // régua do app (init -> npm install -> dev, nessa ordem) vale para ele.
  it('descreve --runtime node e amarra init --runtime node -> npm install -> adk dev nessa ordem', () => {
    const conteudo = lerSkill('adk-init');
    const idxInitNode = conteudo.indexOf('--runtime node');
    expect(idxInitNode).toBeGreaterThan(-1);
    const idxInstall = conteudo.indexOf('npm install', idxInitNode);
    const idxDev = conteudo.indexOf('adk dev', idxInstall);
    expect(idxInstall).toBeGreaterThan(idxInitNode);
    expect(idxDev).toBeGreaterThan(idxInstall);
  });

  it('diz que o esqueleto MCP nasce exigindo Bearer (MCP_TOKEN) e com /health', () => {
    const conteudo = lerSkill('adk-init');
    expect(conteudo).toContain('MCP_TOKEN');
    expect(conteudo).toContain('/health');
    expect(conteudo).not.toContain('MCP_SERVER_TOKEN');
  });
});

// --- 7/8. adk-dev -------------------------------------------------------------

describe('plugin/skills/adk-dev/SKILL.md', () => {
  it('manda abrir o Shell (shell.html) e não a URL do app, e ensina a recuperação do Vite', () => {
    const conteudo = lerSkill('adk-dev');
    expect(conteudo).toContain('shell.html');
    expect(conteudo).toMatch(/abra esta/i);
    expect(conteudo).toContain('Vite não encontrado');
  });

  it('distingue os dois comportamentos por kind: dev/sample-input.json (tool/mcp) e Vite/HMR (app)', () => {
    const conteudo = lerSkill('adk-dev');
    expect(conteudo).toContain('dev/sample-input.json');
    expect(conteudo).toMatch(/Vite/);
    expect(conteudo).toMatch(/HMR/);
  });

  // Hub#2.6.26.4 — MCP_TOKEN é o único nome de contrato entre template, `adk
  // dev`, skills e o satélite de referência em produção; um segundo nome
  // (MCP_SERVER_TOKEN, cogitado numa versão anterior do brief) seria drift.
  it('descreve o ciclo do satélite Node ao lado do Python e cita MCP_TOKEN, nunca MCP_SERVER_TOKEN', () => {
    const conteudo = lerSkill('adk-dev');
    expect(conteudo).toMatch(/npm run dev|--runtime node/);
    expect(conteudo).toContain('MCP_TOKEN');
    expect(conteudo).toContain('PORT');
    expect(conteudo).not.toContain('MCP_SERVER_TOKEN');
  });
});

// --- 9/10. adk-build -----------------------------------------------------------

describe('plugin/skills/adk-build/SKILL.md', () => {
  it('ensina os códigos do portão e a correção de aderência de UI', () => {
    const conteudo = lerSkill('adk-build');
    expect(conteudo).toContain('secret_literal');
    expect(conteudo).toContain('pii_in_config');
    expect(conteudo).toContain('internal_id');
    expect(conteudo).toContain('ui_adherence');
    expect(conteudo).toContain('var(--color-');
    expect(conteudo).toContain('<Brand/>');
  });

  it('não copia limite numérico da política e aponta a fonte viva', () => {
    const conteudo = lerSkill('adk-build');
    expect(conteudo).not.toMatch(/5\s*MB|max_size_bytes|\d{6,}\s*bytes/);
    expect(conteudo).toMatch(/get_policy|adk doctor/);
  });

  // Hub#2.6.26.4 — `checks[]` de um pacote Node não pode ficar mudo (só
  // `tamanho`) por ausência de `pyproject.toml`.
  it('cita o portão de runtime Node: dependência importada e não declarada no package.json', () => {
    const conteudo = lerSkill('adk-build');
    expect(conteudo).toMatch(/node/i);
    expect(conteudo).toContain('package.json');
    expect(conteudo).not.toContain('MCP_SERVER_TOKEN');
  });
});

// --- 11. adk-test ----------------------------------------------------------

describe('plugin/skills/adk-test/SKILL.md', () => {
  it('cita uv run pytest e avisa que kind: app não usa adk test', () => {
    const conteudo = lerSkill('adk-test');
    expect(conteudo).toContain('uv run pytest');
    expect(conteudo).toMatch(/kind:\s*app/);
    expect(conteudo).toMatch(/não use `?adk test`?/i);
  });

  // Hub#2.6.26.4 — descreve o harness Node SEM perder o caminho Python.
  it('descreve o harness Node ao lado do uv run pytest, citando npm install para dependências ausentes', () => {
    const conteudo = lerSkill('adk-test');
    expect(conteudo).toContain('uv run pytest');
    expect(conteudo).toMatch(/node/i);
    expect(conteudo).toMatch(/npm install/);
    expect(conteudo).not.toContain('MCP_SERVER_TOKEN');
  });
});

// --- 12/13. adk-deploy -------------------------------------------------------

describe('plugin/skills/adk-deploy/SKILL.md', () => {
  it('ensina o gate: plan antes de deploy, --org obrigatório, default staging, produção explícita, irreversível', () => {
    const conteudo = lerSkill('adk-deploy');
    const idxPlan = conteudo.indexOf('adk plan');
    const idxDeploy = conteudo.indexOf('adk deploy');
    expect(idxPlan).toBeGreaterThan(-1);
    expect(idxDeploy).toBeGreaterThan(-1);
    expect(idxPlan).toBeLessThan(idxDeploy);
    expect(conteudo).toMatch(/--org/);
    expect(conteudo).toMatch(/staging/);
    expect(conteudo).toMatch(/irrevers[íi]vel/i);
    expect(conteudo).not.toMatch(/adk rollback/);
  });

  // issue#2810 — a tabela "Recuperação rápida" já lista `Informe --org <id
  // da organização>. (exit 2)`; a pré-condição nova de ADK_HUB_URL usa o
  // MESMO exit code de pré-condição e precisa aparecer no mesmo formato,
  // senão o mapa da skill fica incompleto para quem só lê a tabela.
  it('a tabela "Recuperação rápida" cita a pré-condição de ADK_HUB_URL no mesmo formato do guard de --org (exit 2)', () => {
    const conteudo = lerSkill('adk-deploy');
    expect(conteudo).toMatch(/Recuperação rápida/);
    expect(conteudo).toMatch(/ADK_HUB_URL[^\n]*\(exit 2\)/);
  });

  // Revisão (docs/adk-externo): a tabela precisa mapear as recusas NOVAS da
  // CLI (ticket 02 e 05), com o texto que a CLI imprime e o exit code dela.
  // Textos-fonte: packages/cli/src/commands/deploy.ts (confirmarProducao) e
  // packages/cli/src/ctx.ts (diverge do perfil / contradiz ADK_HUB_URL).
  it('a tabela "Recuperação rápida" mapeia apply em produção sem --yes e --env divergente, com exit 2', () => {
    const conteudo = lerSkill('adk-deploy');
    const inicio = conteudo.indexOf('## Recuperação rápida');
    expect(inicio).toBeGreaterThan(-1);
    const resto = conteudo.slice(inicio + 1);
    const fim = resto.search(/\n## /);
    const tabela = fim === -1 ? resto : resto.slice(0, fim);
    const linhas = tabela.split('\n').filter((l) => l.startsWith('|'));

    const linhaYes = linhas.find((l) => l.includes('Apply em produção'));
    expect(linhaYes).toBeDefined();
    expect(linhaYes).toContain('--yes');
    expect(linhaYes).toContain('(exit 2)');

    const linhaEnv = linhas.find((l) => l.includes('diverge do perfil'));
    expect(linhaEnv).toBeDefined();
    expect(linhaEnv).toContain('contradiz ADK_HUB_URL');
    expect(linhaEnv).toContain('(exit 2)');

    const linhaAborto = linhas.find((l) => l.includes('A resposta não confere'));
    expect(linhaAborto).toBeDefined();
    expect(linhaAborto).toContain('(exit 1)');
  });

  it('distingue pasta de componente x repositório de clientes (orgs/<pasta>, org.yaml) com exemplo sintético', () => {
    const conteudo = lerSkill('adk-deploy');
    expect(conteudo).toMatch(/orgs\/<pasta>|orgs\/[a-z0-9-]+\//);
    expect(conteudo).toContain('org.yaml');
    expect(conteudo).toMatch(/environments/);
    expect(conteudo).not.toMatch(/\bc[a-z0-9]{20,}\b/);
    expect(conteudo).not.toMatch(/agrobr|org-dev-\w+/);
  });
});

// --- 14. Nenhuma skill inventa comando --------------------------------------

it('nenhuma skill nem o README do plugin inventa comando adk export|status|logs|rollback nem cita a CLI legada .mjs', () => {
  const conteudo = todasAsSkills() + '\n' + readFileSync(join(PLUGIN_DIR, 'README.md'), 'utf8');
  expect(conteudo).not.toMatch(/adk (export|status|logs|rollback)\b/);
  expect(conteudo).not.toMatch(/packages\/adk\/bin\/adk\.mjs/);
});

// --- 15. Todo comando adk citado existe na CLI real -------------------------

it('todo comando "adk <sub>" citado nas skills existe de fato na CLI', () => {
  // Pergunta à CLI REAL (`adk --help`) em vez de fazer grep em `cli.ts`.
  // A 1ª versão grepava `.command('x')` no fonte, e isso obrigou o dev a
  // desdobrar um laço de 13 linhas em três `.command()` literais SÓ para o
  // teste enxergar — código de produção remodelado por causa do teste, num
  // arquivo que o brief declarava fora de escopo. Duas lanes pegaram.
  const ajuda = execSync('node packages/cli/dist/bin.js --help', {
    cwd: ROOT,
    encoding: 'utf8',
  });
  // O commander lista os subcomandos na seção "Commands:", um por linha.
  const subcomandosReais = new Set(
    [...ajuda.matchAll(/^\s{2}([a-z][a-z-]*)\b/gm)].map((m) => m[1]),
  );
  expect(subcomandosReais.size).toBeGreaterThan(0);

  const citados = new Set(
    [...todasAsSkills().matchAll(/\badk\s+([a-z-]+)\b/g)].map((m) => m[1]),
  );
  for (const sub of citados) {
    expect(subcomandosReais.has(sub), `adk ${sub} citado nas skills mas não existe na CLI`).toBe(
      true,
    );
  }
});

// --- 16. MCP declarado, não reimplementado ----------------------------------

describe('plugin/.mcp.json', () => {
  const mcpJsonPath = join(PLUGIN_DIR, '.mcp.json');

  it('chama o binário `adk` já instalado — NUNCA `npx -y` de nome não reivindicado', () => {
    const texto = readFileSync(mcpJsonPath, 'utf8');
    const mcp = JSON.parse(texto);
    const servidor = mcp.mcpServers['simplafy-adk'];
    expect(servidor).toBeDefined();
    expect(servidor.command).toBe('adk');
    expect((servidor.args ?? []).join(' ')).toContain('mcp-server');
    // `@simpla.fy/adk` responde 404 no npmjs (verificado). Um repo público
    // que instrui `/plugin marketplace add` com `npx -y` faria TODA instalação
    // baixar e executar um nome não reivindicado, na mesma máquina que guarda
    // a credencial do `adk login`. Se um dia virar npx, exige pin de versão.
    expect(texto).not.toMatch(/npx/);
    expect(texto).not.toMatch(/-y\b/);
    expect(servidor.env).toBeUndefined();
    expect(texto).not.toMatch(/curl|https?:\/\//);
  });
});

// --- 17. As 5 tools MCP estão ensinadas -------------------------------------

it('as 5 tools MCP (list_components, get_contract, get_policy, validate, plan) estão ensinadas em alguma skill, e plan exige login', () => {
  const conteudo = todasAsSkills();
  for (const tool of ['list_components', 'get_contract', 'get_policy', 'validate', 'plan']) {
    expect(conteudo).toContain(tool);
  }
  expect(conteudo).toMatch(/plan[^.]*(exige|precisa de|requer)[^.]*(login|ADK_TOKEN)/i);
});

// --- 18. Hook de ambiente decide "ask" para produção ------------------------

describe('plugin/hooks/hooks.json', () => {
  const hooksJsonPath = join(PLUGIN_DIR, 'hooks', 'hooks.json');

  function lerHook() {
    const hooks = JSON.parse(readFileSync(hooksJsonPath, 'utf8'));
    const preToolUse = hooks.hooks.PreToolUse as Array<{
      matcher: string;
      hooks: Array<{ type: string; command: string }>;
    }>;
    const entrada = preToolUse.find((h) => h.matcher === 'Bash');
    expect(entrada).toBeDefined();
    const comandoTemplate = entrada!.hooks[0].command as string;
    const comandoResolvido = comandoTemplate.replace('${CLAUDE_PLUGIN_ROOT}', PLUGIN_DIR);
    return comandoResolvido;
  }

  /**
   * `env` é o ambiente do PROCESSO do hook — o mesmo do Claude Code, que é o
   * que o `adk` herdaria. Sem ele, só o `process.env` isolado da suíte (sem
   * nenhum ADK_*).
   */
  function rodarHook(
    command: string,
    env: Record<string, string | undefined> = {},
  ): { stdout: string; exitCode: number } {
    const comandoResolvido = lerHook();
    try {
      const stdout = execSync(comandoResolvido, {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
      return { stdout, exitCode: 0 };
    } catch (erro: unknown) {
      const e = erro as { stdout?: string; status?: number };
      return { stdout: e.stdout ?? '', exitCode: e.status ?? 1 };
    }
  }

  it('adk deploy --org X --env prod pede confirmação (ask) citando o ambiente', () => {
    const { stdout } = rodarHook('adk deploy --org X --env prod');
    expect(stdout).toContain('"permissionDecision"');
    expect(stdout).toMatch(/"permissionDecision"\s*:\s*"ask"/);
    expect(stdout).toContain('prod');
    expect(stdout).not.toMatch(/"permissionDecision"\s*:\s*"allow"/);
  });

  it('adk deploy --org X --env staging pede confirmação: --env não prova staging', () => {
    // Decisão do maestro (docs/adk-externo, fim do gato e rato): só
    // `--profile staging` ou prefixo ADK_PROFILE/ADK_HUB_URL de staging no
    // próprio segmento provam staging. `--env` sozinho não escolhe o alvo (o
    // perfil padrão é prod), então cai em "todo o resto → ask".
    const { stdout } = rodarHook('adk deploy --org X --env staging');
    expect(stdout).toMatch(/"permissionDecision"\s*:\s*"ask"/);
  });

  // --- Os casos que a review provou que ESCAPAVAM do hook ------------------
  // Sem estes, o hook podia ser "corrigido" e nada acusaria a volta do bug:
  // o mutation check ficou VERDE ao reintroduzir cada uma das duas falhas.

  it.each([
    ['dois espaços', 'adk  deploy --org X --env prod'],
    ['tab', 'adk\tdeploy --org X --env prod'],
    ['quebra de linha', 'adk \\\n  deploy --org X --env prod'],
  ])('separador "%s" entre adk e deploy não faz o hook perder o comando', (_rotulo, comando) => {
    // O regex exigia UM espaço literal: qualquer outro separador passava em
    // silêncio, e o hook é o único controle da fatia contra escrita
    // irreversível (não existe `adk rollback`).
    const { stdout } = rodarHook(comando);
    expect(stdout).toMatch(/"permissionDecision"\s*:\s*"ask"/);
  });

  it('--env repetido: vale a ÚLTIMA ocorrência, que é a que o commander usa', () => {
    // `--env staging --env prod` tem ambiente EFETIVO `prod`. Lendo a
    // PRIMEIRA, o hook via "staging" e liberava produção sem perguntar.
    const { stdout } = rodarHook('adk deploy --org X --env staging --env prod');
    expect(stdout).toMatch(/"permissionDecision"\s*:\s*"ask"/);
    expect(stdout).toContain('prod');
  });

  it('--env=prod (com igual) também é pego', () => {
    const { stdout } = rodarHook('adk deploy --org X --env=prod');
    expect(stdout).toMatch(/"permissionDecision"\s*:\s*"ask"/);
  });

  // --- docs/adk-externo (ticket 05): o perfil/host decide, não o --env -------
  // Desde o ticket 01 o padrão da CLI é o perfil `prod`: `adk apply --org X`
  // sem nada grava em PRODUÇÃO. Calar sem --env passou a ser fail-open.

  const ASK = /"permissionDecision"\s*:\s*"ask"/;
  const API_PROD = 'https://api-hub-v2.simplafy.com.br';
  const API_STAGING = 'https://api-hub-v2-staging.simplafy.com.br';

  describe('perfil efetivo prod pede confirmação', () => {
    it.each([
      ['apply sem nada (perfil padrão é prod)', 'adk apply --org X'],
      ['deploy sem nada', 'adk deploy --org X'],
      ['--profile prod explícito', 'adk apply --profile prod --org X'],
      ['--profile=prod', 'adk apply --profile=prod --org X'],
      ['--env production explícito', 'adk apply --org X --env production'],
      ['--yes não dispensa o hook (é só a trava da CLI)', 'adk apply --org X --yes'],
      ['ADK_PROFILE=prod inline', 'ADK_PROFILE=prod adk apply --org X'],
      ['ADK_HUB_URL de produção inline', `ADK_HUB_URL=${API_PROD} adk apply --org X`],
      [
        'ADK_HUB_URL de produção inline vence --profile staging',
        `ADK_HUB_URL=${API_PROD} adk apply --profile staging --org X`,
      ],
      ['--profile repetido: vale o último (prod)', 'adk apply --profile staging --profile prod --org X'],
      ['npx @simpla.fy/adk', 'npx @simpla.fy/adk apply --org X'],
    ])('%s → ask', (_rotulo, comando) => {
      const { stdout } = rodarHook(comando);
      expect(stdout).toMatch(ASK);
      expect(stdout).not.toMatch(/allow/);
    });

    it('ADK_HUB_URL de produção no ambiente do processo → ask, mesmo com --env staging', () => {
      const { stdout } = rodarHook('adk apply --org X --env staging', { ADK_HUB_URL: API_PROD });
      expect(stdout).toMatch(ASK);
    });

    it('ADK_PROFILE=staging no ambiente, mas --profile prod no comando → ask (a flag vence)', () => {
      const { stdout } = rodarHook('adk apply --profile prod --org X', { ADK_PROFILE: 'staging' });
      expect(stdout).toMatch(ASK);
    });

    it('a mensagem diz que o alvo é produção', () => {
      const { stdout } = rodarHook('adk apply --org X');
      const motivo = JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason as string;
      expect(motivo).toMatch(/produ[çc][ãa]o|production|prod\b/i);
    });
  });

  describe('staging explícito no segmento passa em silêncio; o resto pergunta', () => {
    it.each([
      ['--profile staging', 'adk apply --profile staging --org X'],
      ['--profile=staging', 'adk apply --profile=staging --org X'],
      ['ADK_PROFILE=staging inline', 'ADK_PROFILE=staging adk apply --org X'],
      ['ADK_HUB_URL de staging inline', `ADK_HUB_URL=${API_STAGING} adk apply --org X`],
    ])('%s → silêncio', (_rotulo, comando) => {
      const { stdout } = rodarHook(comando);
      expect(stdout.trim()).toBe('');
    });

    // Antes calavam: o process.env NÃO prova mais nada (decisão do maestro).
    // O `adk` herda o ambiente do shell DEPOIS de tudo que o comando roda, e a
    // lista do que mexe nele nunca fecha. Só o próprio segmento prova staging.
    it('ADK_PROFILE=staging só no ambiente do processo → ask (o processo não prova nada)', () => {
      const { stdout } = rodarHook('adk apply --org X', { ADK_PROFILE: 'staging' });
      expect(stdout).toMatch(ASK);
    });

    it('ADK_HUB_URL de staging só no ambiente do processo → ask (o processo não prova nada)', () => {
      const { stdout } = rodarHook('adk apply --org X', { ADK_HUB_URL: API_STAGING });
      expect(stdout).toMatch(ASK);
    });

    it('--env staging sem --profile → ask (--env não prova staging)', () => {
      const { stdout } = rodarHook('adk apply --org X --env staging');
      expect(stdout).toMatch(ASK);
    });

    it('ADK_HUB_URL de host desconhecido no prefixo vence --profile staging → ask', () => {
      const { stdout } = rodarHook(
        'ADK_HUB_URL=https://hub.exemplo.invalid adk apply --profile staging --org S',
      );
      expect(stdout).toMatch(ASK);
    });
  });

  // --- Revisão (docs/adk-externo): segmentos do comando -------------------
  // O comando é dividido em segmentos (; && || | quebra de linha). Perfil,
  // --env e variável inline só valem DENTRO do segmento do adk apply/deploy;
  // `adk` com opções globais antes do subcomando também é apply/deploy.

  describe('perfil/env/variável só valem no segmento do apply', () => {
    it.each([
      ['opção global antes do subcomando: adk --profile prod apply', 'adk --profile prod apply --org X --yes'],
      ['opção global com igual: adk --profile=prod deploy', 'adk --profile=prod deploy --org X'],
      [
        '--profile do plan não vale para o apply seguinte',
        'adk plan --profile staging --org S && adk apply --org P --yes',
      ],
      ['ADK_PROFILE=staging em outro segmento (;)', 'ADK_PROFILE=staging true; adk apply --org X --yes'],
      ['--env=staging de um echo em outro segmento', 'echo --env=staging; adk apply --org X --yes'],
      ['--profile staging depois de || em outro comando', 'adk apply --org X --yes || echo --profile staging'],
      ['--profile staging depois de pipe', 'adk apply --org X --yes | tee log --profile staging'],
      ['quebra de linha separa segmentos', 'echo --profile staging\nadk apply --org X --yes'],
    ])('%s → ask', (_rotulo, comando) => {
      const { stdout } = rodarHook(comando);
      expect(stdout).toMatch(ASK);
      expect(stdout).not.toMatch(/allow/);
    });

    it.each([
      ['--profile staging no próprio apply', 'adk apply --profile staging --org S'],
      ['ADK_PROFILE=staging inline no próprio apply', 'ADK_PROFILE=staging adk apply --org S'],
      ['opção global staging antes do subcomando', 'adk --profile staging apply --org S'],
      ['plan em prod e apply em staging no segmento dele', 'adk plan --org S && adk apply --profile staging --org S'],
    ])('%s → silêncio', (_rotulo, comando) => {
      const { stdout } = rodarHook(comando);
      expect(stdout.trim()).toBe('');
    });
  });

  // --- Revisão (docs/adk-externo): ambiente alterado antes do adk ---------
  // O hook lê o ambiente do SEU processo, mas o `adk` herda o do shell DEPOIS
  // dos segmentos anteriores. Se um segmento anterior mexe em ADK_PROFILE /
  // ADK_HUB_URL / ADK_AUTH_URL (export/unset/declare/typeset/atribuição solta),
  // carrega arquivo (`source`/`.`), liga `set -a`, ou o próprio apply roda sob
  // `env -u`/`env -i`, o ambiente do processo não diz mais o alvo: é
  // indeterminado, e na dúvida pergunta. Todos com ADK_PROFILE=staging no
  // processo, que sozinho faria o hook calar.

  describe('ambiente alterado antes do adk fica indeterminado', () => {
    const PROCESSO_STAGING = { ADK_PROFILE: 'staging' };

    it.each([
      ['export ADK_PROFILE=prod; antes', 'export ADK_PROFILE=prod; adk apply --org X --yes'],
      ['export ADK_PROFILE=prod && antes', 'export ADK_PROFILE=prod && adk apply --org X --yes'],
      ['unset ADK_PROFILE antes', 'unset ADK_PROFILE; adk apply --org X --yes'],
      [
        'export ADK_HUB_URL de produção antes',
        `export ADK_HUB_URL=${API_PROD}; adk apply --org X`,
      ],
      ['declare -x ADK_PROFILE=prod antes', 'declare -x ADK_PROFILE=prod; adk apply --org X'],
      ['typeset -x ADK_PROFILE=prod antes', 'typeset -x ADK_PROFILE=prod; adk apply --org X'],
      ['atribuição solta ADK_PROFILE=prod antes', 'ADK_PROFILE=prod; adk apply --org X'],
      ['export ADK_AUTH_URL antes', 'export ADK_AUTH_URL=https://exemplo.invalid; adk apply --org X'],
      ['source .env antes', 'source .env; adk apply --org X'],
      ['. ./prod.env && antes', '. ./prod.env && adk apply --org X'],
      ['set -a antes', 'set -a; adk apply --org X'],
      [
        'env -u ADK_PROFILE desfaz o ADK_PROFILE=staging inline',
        'ADK_PROFILE=staging env -u ADK_PROFILE adk apply --org X --yes',
      ],
      ['env -i limpa o ambiente do apply', 'env -i adk apply --org X'],
    ])('%s → ask', (_rotulo, comando) => {
      const { stdout } = rodarHook(comando, PROCESSO_STAGING);
      expect(stdout).toMatch(ASK);
      expect(stdout).not.toMatch(/allow/);
    });

    it('unset ADK_HUB_URL antes (ADK_HUB_URL de staging no processo) → ask', () => {
      const { stdout } = rodarHook('unset ADK_HUB_URL; adk apply --org X --yes', {
        ...PROCESSO_STAGING,
        ADK_HUB_URL: API_STAGING,
      });
      expect(stdout).toMatch(ASK);
      expect(stdout).not.toMatch(/allow/);
    });

    // Antes calavam (o processo provava staging). Agora o processo não prova
    // nada: sem staging no próprio segmento, pergunta. E `export` de qualquer
    // variável pode carregar o alvo (`export $(cat x.env | xargs)`).
    it.each([
      ['nada mexe no ambiente', 'adk apply --org S'],
      ['export de outra variável', 'export FOO=1; adk apply --org S'],
    ])('%s (ADK_PROFILE=staging no processo) → ask', (_rotulo, comando) => {
      const { stdout } = rodarHook(comando, PROCESSO_STAGING);
      expect(stdout).toMatch(ASK);
      expect(stdout).not.toMatch(/allow/);
    });

    it.each([
      ['export $(cat x.env | xargs);', 'export $(cat x.env | xargs); adk apply --org X --yes'],
      [
        "export $(grep -v '^#' x.env | xargs) &&",
        "export $(grep -v '^#' x.env | xargs) && adk apply --org X --yes",
      ],
      ['declare -x $(cat x.env);', 'declare -x $(cat x.env); adk apply --org X --yes'],
      ['mapfile + export "${L[@]}"', 'mapfile -t L < x.env; export "${L[@]}"; adk apply --org X'],
      ['nome montado: export ${V}FILE=prod', 'V=ADK_PRO; export ${V}FILE=prod; adk apply --org X'],
    ])('carrega variáveis sem citar o nome: %s (ADK_PROFILE=staging no processo) → ask', (_rotulo, comando) => {
      const { stdout } = rodarHook(comando, PROCESSO_STAGING);
      expect(stdout).toMatch(ASK);
      expect(stdout).not.toMatch(/allow/);
    });

    // Palavra que muda ambiente/execução no comando bruto → ask MESMO com
    // staging explícito no segmento do apply: o hook não acompanha o que ela faz.
    it.each([
      ['eval', 'eval "$X"; adk apply --profile staging --org S'],
      ['source', 'source x.env; adk apply --profile staging --org S'],
      ['.', '. ./x.env; adk apply --profile staging --org S'],
      ['export', 'export $(cat x.env | xargs); adk apply --profile staging --org S'],
      ['export de outra variável', 'export FOO=1; ADK_PROFILE=staging adk apply --org S'],
      ['declare', 'declare -x $(cat x.env); adk apply --profile staging --org S'],
      ['typeset', 'typeset -x FOO=1; adk apply --profile staging --org S'],
      ['readonly', 'readonly FOO=1; adk apply --profile staging --org S'],
      ['local', 'local FOO=1; adk apply --profile staging --org S'],
      ['unset', 'unset FOO; adk apply --profile staging --org S'],
      ['read', 'read -r FOO < x.env; adk apply --profile staging --org S'],
      ['mapfile', 'mapfile -t L < x.env; adk apply --profile staging --org S'],
      ['readarray', 'readarray -t L < x.env; adk apply --profile staging --org S'],
      ['printf -v', 'printf -v FOO %s 1; adk apply --profile staging --org S'],
      ['set', 'set -a; adk apply --profile staging --org S'],
      ['env', 'env FOO=1 adk apply --profile staging --org S'],
      ['sudo', 'sudo adk apply --profile staging --org S'],
      ['direnv', 'direnv exec . adk apply --profile staging --org S'],
      ['bash -c', "bash -c 'adk apply --profile staging --org S'"],
      ['sh -c', "sh -c 'adk apply --profile staging --org S'"],
      ['zsh -c', "zsh -c 'adk apply --profile staging --org S'"],
      ['fish -c', "fish -c 'adk apply --profile staging --org S'"],
      ['dash -c', "dash -c 'adk apply --profile staging --org S'"],
      ['{', '{ adk apply --profile staging --org S; }'],
      ['then', 'if true; then adk apply --profile staging --org S; fi'],
      ['do', 'for i in 1; do adk apply --profile staging --org S; done'],
      ['$(', 'adk apply --profile staging --org $(cat org.txt)'],
      ['crase', 'adk apply --profile staging --org `cat org.txt`'],
    ])('palavra "%s" no comando → ask mesmo com staging explícito', (_rotulo, comando) => {
      const { stdout } = rodarHook(comando);
      expect(stdout).toMatch(ASK);
      expect(stdout).not.toMatch(/allow/);
    });
  });

  // --- Revisão (docs/adk-externo): negar por padrão --------------------------
  // A lista de "o que mexe no ambiente" nunca fecha (bash -c, `{ }`, if/then,
  // eval, command/builtin, direnv, sudo…). A regra inverte: o hook só cala
  // quando staging é PROVADO no próprio segmento do apply (--profile staging
  // sem outro --profile divergente, ou ADK_PROFILE/ADK_HUB_URL de staging logo
  // antes do `adk`, sem ADK_HUB_URL de produção/desconhecido) E o comando
  // bruto não tem palavra que muda ambiente/execução (eval, source, `.`,
  // export, declare, typeset, readonly, local, unset, read, mapfile,
  // readarray, printf -v, set, env, sudo, direnv, bash|sh|zsh|fish|dash -c,
  // `{`, then, do, `$(`, crase). O process.env não prova nada. O resto pergunta.

  describe('negar por padrão: staging só se provado', () => {
    const PROCESSO_STAGING = { ADK_PROFILE: 'staging' };

    it.each([
      ['bash -c que exporta prod', "bash -c 'export ADK_PROFILE=prod; adk apply --org X --yes'"],
      ['grupo { } que exporta prod', '{ export ADK_PROFILE=prod; adk apply --org X --yes; }'],
      ['if/then que exporta prod', 'if true; then export ADK_PROFILE=prod; fi; adk apply --org X --yes'],
      ['eval com aspas que exporta prod', 'eval "export ADK_PROFILE=prod"; adk apply --org X'],
      ['eval sem aspas que exporta prod', 'eval export ADK_PROFILE=prod; adk apply --org X'],
      ['command export prod', 'command export ADK_PROFILE=prod; adk apply --org X'],
      ['builtin export prod', 'builtin export ADK_PROFILE=prod; adk apply --org X'],
      ['direnv exec carrega outro ambiente', 'direnv exec . adk apply --yes'],
      ['sudo troca o ambiente', 'sudo adk apply --org X --yes'],
    ])('%s (ADK_PROFILE=staging no processo) → ask', (_rotulo, comando) => {
      const { stdout } = rodarHook(comando, PROCESSO_STAGING);
      expect(stdout).toMatch(ASK);
      expect(stdout).not.toMatch(/allow/);
    });

    it('staging só no processo e comando limpo → ask (antes calava; o processo não prova nada)', () => {
      const { stdout } = rodarHook('adk apply --org S', PROCESSO_STAGING);
      expect(stdout).toMatch(ASK);
    });

    it.each([
      ['--profile staging no próprio apply', 'adk apply --profile staging --org S'],
      ['ADK_PROFILE=staging logo antes do adk', 'ADK_PROFILE=staging adk apply --org S'],
      ['opção global --profile staging', 'adk --profile staging apply --org S'],
      ['plan antes e apply com --profile staging', 'adk plan --org S && adk apply --profile staging --org S'],
    ])('%s (nada no processo) → silêncio', (_rotulo, comando) => {
      const { stdout } = rodarHook(comando);
      expect(stdout.trim()).toBe('');
    });

    // Revisão (docs/adk-externo): `--profile staging` depois de `#` é
    // comentário do shell, e depois de `--` isolado é argumento posicional —
    // em nenhum dos dois casos o commander lê a opção, e o apply vai para o
    // perfil padrão (prod). Regra do maestro: `#` no início de palavra ou a
    // palavra `--` isolada no comando bruto → ask.
    it.each([
      ['# (comentário) antes de --profile staging', 'adk apply --org X --yes # --profile staging'],
      ['-- isolado antes de --profile staging', 'adk apply --org X --yes -- --profile staging'],
    ])('%s (nada no processo) → ask', (_rotulo, comando) => {
      const { stdout } = rodarHook(comando);
      expect(stdout).toMatch(ASK);
      expect(stdout).not.toMatch(/allow/);
    });

    it('controle: adk apply --profile staging --org S continua em silêncio', () => {
      const { stdout } = rodarHook('adk apply --profile staging --org S');
      expect(stdout.trim()).toBe('');
    });
  });

  it('adk plan sem nada (perfil prod) não decide nada: plan não escreve', () => {
    const { stdout } = rodarHook('adk plan --org X');
    expect(stdout.trim()).toBe('');
  });

  it('adk plan --org X --env prod não decide nada (plan nunca aplica)', () => {
    const { stdout } = rodarHook('adk plan --org X --env prod');
    expect(stdout.trim()).toBe('');
  });

  it('ls -la (comando não-adk) não decide nada', () => {
    const { stdout } = rodarHook('ls -la');
    expect(stdout.trim()).toBe('');
  });

  it('a saída nunca contém "allow" em nenhum dos cenários acima', () => {
    const cenarios = ['adk deploy --org X --env prod', 'adk apply --org X --env producao'];
    for (const cenario of cenarios) {
      const { stdout } = rodarHook(cenario);
      expect(stdout).not.toMatch(/allow/);
    }
  });
});

// --- 19. Sem segredo em lugar nenhum do plugin/ -----------------------------

function listarArquivos(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entradas = readdirSync(dir);
  let arquivos: string[] = [];
  for (const entrada of entradas) {
    const caminho = join(dir, entrada);
    if (statSync(caminho).isDirectory()) {
      arquivos = arquivos.concat(listarArquivos(caminho));
    } else {
      arquivos.push(caminho);
    }
  }
  return arquivos;
}

it('nenhum arquivo do plugin/ contém segredo literal, org id real ou nome de org/template real', () => {
  const arquivos = listarArquivos(PLUGIN_DIR);
  expect(arquivos.length).toBeGreaterThan(0);
  const conteudo = arquivos.map((f) => readFileSync(f, 'utf8')).join('\n');
  expect(conteudo).not.toMatch(/sk_[A-Za-z0-9]/);
  expect(conteudo).not.toMatch(/sk-[A-Za-z0-9]/);
  expect(conteudo).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  expect(conteudo).not.toMatch(/ADK_TOKEN\s*=\s*\S/);
  expect(conteudo).not.toMatch(/\bc[a-z0-9]{20,}\b/);
  expect(conteudo).not.toMatch(/agrobr|org-dev-\w+/);
});

// --- 20. README da raiz não mente mais --------------------------------------

it('README.md da raiz não descreve plugin/ como vazio/sem dono', () => {
  const conteudo = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const linhaPlugin = conteudo.split('\n').find((l) => l.includes('plugin/'));
  expect(linhaPlugin).toBeDefined();
  expect(linhaPlugin).not.toMatch(/Vazios nesta rodada/);
});

// --- 21. pt-BR obrigatório ---------------------------------------------------

it('nenhum termo pt-PT proibido aparece nas 7 skills nem no README do plugin', () => {
  const conteudo =
    todasAsSkills() + '\n' + readFileSync(join(PLUGIN_DIR, 'README.md'), 'utf8');
  const proibidos = [
    'ficheiro',
    'utilizador',
    'ecrã',
    'palavra-passe',
    'guardar',
    'telemóvel',
    'definições',
    'seleccionar',
  ];
  for (const termo of proibidos) {
    expect(conteudo.toLowerCase()).not.toContain(termo);
  }
});

// --- extra: plugin/ não entra no pnpm workspace nem quebra o build ----------

it('plugin/ não é adicionado ao pnpm-workspace.yaml (não vira packages/plugin)', () => {
  const workspace = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  expect(workspace).not.toMatch(/plugin/);
});

// issue#2776 — a proteção que faltava no incidente dos 17 vínculos é a
// distinção entre campo AUSENTE e lista VAZIA. Ela existe no servidor por
// construção (`resolverVinculos` devolve `null` quando `tools` é `undefined`),
// e ninguém a adivinha lendo o YAML: se a skill não a disser, ela não está
// dita em lugar nenhum que o autor leia.
describe('plugin/skills/adk-deploy/SKILL.md — apagar vínculo exige declaração', () => {
  it('distingue `tools:` ausente de `tools: []`, e diz o que cada um faz', () => {
    const conteudo = lerSkill('adk-deploy');
    expect(conteudo).toContain('tools: []');
    expect(conteudo).toMatch(/sem `tools:`/);
    // O efeito de cada um, não só a sintaxe.
    expect(conteudo).toMatch(/não gerencia vínculo|nada —/);
    expect(conteudo).toMatch(/remove os vínculos|DESVINCULAR/);
  });

  it('explica a adoção: vínculo da tela aparece como mudança na primeira rodada', () => {
    const conteudo = lerSkill('adk-deploy');
    expect(conteudo).toMatch(/ADOÇÃO|adoção/);
    expect(conteudo).toContain('0 aplicado(s)');
  });
});
