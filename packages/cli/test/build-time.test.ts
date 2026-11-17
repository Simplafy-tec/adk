import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSpecYaml, validateTeamSpecStructure } from '@simpla.fy/adk-contract';
import { runCli } from '../src/cli.js';
import { usarHubDeProducaoFalso } from './hub-prod-falso.js';

// Sem ADK_HUB_URL, o build consulta a política do Hub de produção: aqui ele é falso.
usarHubDeProducaoFalso();

// ADR-290 F2: `adk build`/`adk validate` julgam `kind: team` (team.yaml) pelo contrato, e `adk init team` gera o esqueleto.
// Fixtures SINTÉTICAS: nenhum texto de time real.

const t3 = (pt: string) => `{ pt: "${pt}", en: "${pt} (en)", es: "${pt} (es)" }`;

/** Um time amplo válido, com duas peças `call:` e a peça `jornada` (`spec:`) opcional. */
function yamlDoTime(slug: string, extra: { pecas?: string[]; cabecalho?: string[] } = {}): string {
  return [
    'spec_version: v1',
    'kind: team',
    `slug: ${slug}`,
    'tipo: amplo',
    'area: comercial',
    'versao: 1',
    'liberado: false',
    'avisoParceiro: false',
    'tamanho: pequeno',
    ...(extra.cabecalho ?? []),
    'vitrine:',
    `  nome: ${t3('Time Exemplo')}`,
    `  frase: ${t3('Atende e vende')}`,
    '  naPratica:',
    `    - ${t3('Um')}`,
    `    - ${t3('Dois')}`,
    `    - ${t3('Três')}`,
    `  canaisSugeridos: ${t3('WhatsApp')}`,
    `  depoisSoVoceFaz: ${t3('Conectar o canal')}`,
    '  cena: cena-exemplo',
    'equipe:',
    '  - chave: ana',
    '    papel: principal',
    `    nome: ${t3('Ana')}`,
    `    papelTitulo: ${t3('Pré-vendas')}`,
    `    oQueFaz: ${t3('Qualifica')}`,
    '    perfilDeModelo: recomendado',
    ...(extra.pecas ? ['pecas:', ...extra.pecas] : ['pecas: []']),
    'faltaPouco: []',
    '',
  ].join('\n');
}

const pecaAgente = (chave: string, rotulo = 'Agente Ana') => [
  `  - chave: ${chave}`,
  `    rotulo: ${t3(rotulo)}`,
  '    grupo: agentes',
  '    call:',
  '      ferramenta: agents-crt',
  '      argumentos: { name: "Ana" }',
  '      desfazer: agents-remove',
];

describe('adk build / validate / init — pacote de time (ADR-290 F2)', () => {
  let base: string;
  let dir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'adk-time-'));
    dir = join(base, 'time-exemplo');
    mkdirSync(dir);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const escrever = (rel: string, texto: string, raiz = dir) => {
    mkdirSync(join(raiz, rel, '..'), { recursive: true });
    writeFileSync(join(raiz, rel), texto);
  };
  const build = async (raiz = dir) => {
    const r = await runCli(['build', '--dir', raiz], { cwd: base });
    return {
      exit: r.exitCode,
      saida: JSON.parse(r.stdout) as {
        issues: Array<{ code: string; path: string }>;
        checks: Array<{ nome: string; ok: boolean; detalhe?: string }>;
      },
    };
  };

  it('pacote de time válido passa (exit 0) e avisa que a função de uma peça `call` só é conferida no servidor', async () => {
    escrever('team.yaml', yamlDoTime('time-exemplo', { pecas: pecaAgente('ana') }));
    const { exit, saida } = await build();
    expect(saida.issues).toEqual([]);
    expect(exit).toBe(0);
    const aviso = saida.checks.find((c) => c.nome === 'peças call');
    expect(aviso?.ok).toBe(true);
    expect(aviso?.detalhe).toContain('só é conferida no servidor');
    expect(aviso?.detalhe).toContain('agents-crt');
  });

  it('chave repetida reprova com o MESMO code e path do contrato (o que o servidor devolve)', async () => {
    const texto = yamlDoTime('time-exemplo', {
      pecas: [...pecaAgente('ana'), ...pecaAgente('ana', 'Outra')],
    });
    escrever('team.yaml', texto);
    const { exit, saida } = await build();
    const doContrato = validateTeamSpecStructure(parseSpecYaml(texto));
    expect(exit).toBe(1);
    expect(doContrato).toContainEqual(
      expect.objectContaining({ code: 'duplicate_team_key', path: 'pecas[1].chave' }),
    );
    for (const i of doContrato)
      expect(saida.issues).toContainEqual(expect.objectContaining({ code: i.code, path: i.path }));
  });

  it('rótulo acima de 80 caracteres reprova', async () => {
    escrever('team.yaml', yamlDoTime('time-exemplo', { pecas: pecaAgente('ana', 'x'.repeat(81)) }));
    const { exit, saida } = await build();
    expect(exit).toBe(1);
    expect(saida.issues).toContainEqual(
      expect.objectContaining({ code: 'invalid_field_value', path: 'pecas[0].rotulo.pt' }),
    );
  });

  it('referência a peça posterior reprova', async () => {
    const pecas = [
      '  - chave: funil',
      `    rotulo: ${t3('Funil')}`,
      '    grupo: crm',
      '    call:',
      '      ferramenta: pipelines-crt',
      '      argumentos: { agentId: "${peca:ana.id}" }',
      '      desfazer: pipelines-remove',
      ...pecaAgente('ana'),
    ];
    escrever('team.yaml', yamlDoTime('time-exemplo', { pecas }));
    const { exit, saida } = await build();
    expect(exit).toBe(1);
    expect(saida.issues).toContainEqual(
      expect.objectContaining({
        code: 'invalid_piece_reference',
        path: 'pecas[0].call.argumentos',
      }),
    );
  });

  it('`desfazer` nulo sem `semDesfazer` reprova', async () => {
    const pecas = [
      '  - chave: app',
      `    rotulo: ${t3('Aplicativo')}`,
      '    grupo: tools-apps',
      '    call:',
      '      ferramenta: aplicativos-instalar-aplicativo',
      '      argumentos: {}',
      '      desfazer: null',
    ];
    escrever('team.yaml', yamlDoTime('time-exemplo', { pecas }));
    const { exit, saida } = await build();
    expect(exit).toBe(1);
    expect(saida.issues).toContainEqual(
      expect.objectContaining({ code: 'undo_reason_missing', path: 'pecas[0].call.semDesfazer' }),
    );
  });

  it('o slug diferente do nome da pasta reprova', async () => {
    escrever('team.yaml', yamlDoTime('outro-nome'));
    const { exit, saida } = await build();
    expect(exit).toBe(1);
    expect(saida.issues).toContainEqual(
      expect.objectContaining({ code: 'slug_filename_mismatch', path: 'slug' }),
    );
  });

  it('segredo literal em qualquer arquivo do pacote reprova (varredura de vazamento)', async () => {
    escrever('team.yaml', yamlDoTime('time-exemplo'));
    escrever('agentes/ana.yaml', 'token: "sk-abcdefgh12345678"\n');
    const { exit, saida } = await build();
    expect(exit).toBe(1);
    expect(saida.issues).toContainEqual(expect.objectContaining({ code: 'secret_literal' }));
  });

  describe('peça `spec:` aponta para arquivo do pacote', () => {
    const pecaSpec = (arquivo: string) => [
      '  - chave: boas-vindas',
      `    rotulo: ${t3('Jornada de boas-vindas')}`,
      '    grupo: jornadas',
      '    spec:',
      '      kind: journey',
      `      arquivo: ${arquivo}`,
    ];

    it('arquivo presente: passa e o check diz quantas peças apontam', async () => {
      escrever(
        'team.yaml',
        yamlDoTime('time-exemplo', { pecas: pecaSpec('jornadas/boas-vindas.yaml') }),
      );
      escrever('jornadas/boas-vindas.yaml', 'spec_version: v1\nkind: journey\nslug: boas-vindas\n');
      const { exit, saida } = await build();
      expect(saida.issues).toEqual([]);
      expect(exit).toBe(0);
      expect(saida.checks.find((c) => c.nome === 'peças spec')?.detalhe).toContain('1 peça(s)');
    });

    it('arquivo ausente reprova com team_piece_file_missing e o path da peça', async () => {
      escrever(
        'team.yaml',
        yamlDoTime('time-exemplo', { pecas: pecaSpec('jornadas/nao-existe.yaml') }),
      );
      const { exit, saida } = await build();
      expect(exit).toBe(1);
      expect(saida.issues).toContainEqual(
        expect.objectContaining({ code: 'team_piece_file_missing', path: 'pecas[0].spec.arquivo' }),
      );
    });

    it('arquivo fora do pacote (../) reprova com team_piece_file_outside_package', async () => {
      escrever('team.yaml', yamlDoTime('time-exemplo', { pecas: pecaSpec('../fora.yaml') }));
      writeFileSync(join(base, 'fora.yaml'), 'spec_version: v1\n');
      const { exit, saida } = await build();
      expect(exit).toBe(1);
      expect(saida.issues).toContainEqual(
        expect.objectContaining({
          code: 'team_piece_file_outside_package',
          path: 'pecas[0].spec.arquivo',
        }),
      );
    });

    it('atalho (symlink) que sai da pasta reprova: o caminho parece interno, o arquivo não é', async () => {
      escrever(
        'team.yaml',
        yamlDoTime('time-exemplo', { pecas: pecaSpec('jornadas/atalho.yaml') }),
      );
      writeFileSync(join(base, 'fora.yaml'), 'spec_version: v1\n');
      mkdirSync(join(dir, 'jornadas'));
      symlinkSync(join(base, 'fora.yaml'), join(dir, 'jornadas', 'atalho.yaml'));
      const { exit, saida } = await build();
      expect(exit).toBe(1);
      expect(saida.issues).toContainEqual(
        expect.objectContaining({ code: 'team_piece_file_outside_package' }),
      );
    });
  });

  it('especialista: o check diz que a soma com o amplo só é conferida no Hub', async () => {
    const texto = yamlDoTime('time-exemplo')
      .replace(
        'tipo: amplo',
        'tipo: especialista\nsegmento: clinica\nsegmentoRotulo: ' +
          t3('Clínicas') +
          '\nherda: comercial-exemplo',
      )
      .replace(
        /equipe:[\s\S]*$/,
        'doSegmento:\n  equipe:\n    - chave: ana\n      papel: principal\n      nome: ' +
          t3('Ana') +
          '\n      papelTitulo: ' +
          t3('Pré') +
          '\n      oQueFaz: ' +
          t3('Qualifica') +
          '\n      perfilDeModelo: recomendado\n',
      );
    escrever('team.yaml', texto);
    const { exit, saida } = await build();
    expect(saida.issues).toEqual([]);
    expect(exit).toBe(0);
    expect(saida.checks.find((c) => c.nome === 'herança')?.detalhe).toContain(
      '"comercial-exemplo"',
    );
  });

  it('sem manifest.yaml nem team.yaml: invalid_document, e a mensagem cita os dois arquivos', async () => {
    const r = await runCli(['build', '--dir', dir], { cwd: base });
    expect(r.exitCode).toBe(1);
    const [primeira] = (
      JSON.parse(r.stdout) as { issues: Array<{ code: string; message: string }> }
    ).issues;
    expect(primeira.code).toBe('invalid_document');
    expect(primeira.message).toContain('team.yaml');
  });

  describe('adk validate', () => {
    it('numa pasta de pacotes valida todos e reprova se um tiver problema (exit 1, lista o que quebrou)', async () => {
      escrever('a-bom/team.yaml', yamlDoTime('a-bom'), base);
      escrever(
        'b-ruim/team.yaml',
        yamlDoTime('b-ruim', { pecas: [...pecaAgente('ana'), ...pecaAgente('ana')] }),
        base,
      );
      rmSync(dir, { recursive: true, force: true });
      const r = await runCli(['validate', '--dir', base], { cwd: base });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain('✓ team/a-bom');
      expect(r.stdout).toContain('✗ team/b-ruim');
      expect(r.stdout).toContain('duplicate_team_key pecas[1].chave');
      expect(r.stdout).toContain('2 time(s), 1 com problema.');
    });

    it('num pacote só: exit 0 quando limpo; --json traz issues e checks', async () => {
      escrever('team.yaml', yamlDoTime('time-exemplo', { pecas: pecaAgente('ana') }));
      const r = await runCli(['validate', '--dir', dir, '--json'], { cwd: base });
      expect(r.exitCode).toBe(0);
      const j = JSON.parse(r.stdout) as {
        artefatos: Array<{ kind: string; issues: unknown[]; checks: Array<{ nome: string }> }>;
      };
      expect(j.artefatos).toHaveLength(1);
      expect(j.artefatos[0]).toMatchObject({ kind: 'team', issues: [] });
      expect(j.artefatos[0].checks.map((c) => c.nome)).toContain('peças call');
    });
  });

  describe('delta do review dev7 (adk#58)', () => {
    it('B1 — atalho quebrado na pasta: o validate não cai com ENOENT e valida os pacotes que existem', async () => {
      escrever('a-bom/team.yaml', yamlDoTime('a-bom'), base);
      rmSync(dir, { recursive: true, force: true });
      symlinkSync(join(base, 'nao-existe'), join(base, 'quebrado'));
      const r = await runCli(['validate', '--dir', base], { cwd: base });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('✓ team/a-bom');
      expect(r.stdout).toContain('1 time(s), 0 com problema.');
    });

    it('B2 — repositório de clientes (orgs/) com um x/team.yaml perdido: julga as orgs e NÃO sai com exit 0 falso', async () => {
      escrever('x/team.yaml', yamlDoTime('x'), base);
      escrever('orgs/acme/tools/ruim.yaml', 'spec_version: v1\nkind: tool\nslug: ruim\n', base);
      rmSync(dir, { recursive: true, force: true });
      const r = await runCli(['validate', '--dir', base], { cwd: base });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).not.toContain('time(s)');
      expect(r.stdout).toContain('ruim.yaml');
    });

    it('B3 — arquivo cujo nome começa com «..» dentro do pacote NÃO é «fora do pacote»', async () => {
      const peca = [
        '  - chave: boas-vindas',
        `    rotulo: ${t3('Jornada de boas-vindas')}`,
        '    grupo: jornadas',
        '    spec:',
        '      kind: journey',
        '      arquivo: ..jornada.yaml',
      ];
      escrever('team.yaml', yamlDoTime('time-exemplo', { pecas: peca }));
      escrever('..jornada.yaml', 'spec_version: v1\nkind: journey\nslug: boas-vindas\n');
      const { exit, saida } = await build();
      expect(saida.issues).toEqual([]);
      expect(exit).toBe(0);
    });
  });

  describe('adk init team', () => {
    it('cria team.yaml e README, e o esqueleto passa no adk build sem edição', async () => {
      const r = await runCli(['init', 'team', 'meu-time', '--dir', join(base, 'meu-time')], {
        cwd: base,
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('não por `adk deploy`');
      const { exit, saida } = await build(join(base, 'meu-time'));
      expect(saida.issues).toEqual([]);
      expect(exit).toBe(0);
    });

    it('recusa pasta que já existe e --runtime node (só vale em mcp)', async () => {
      const ja = await runCli(['init', 'team', 'time-exemplo', '--dir', dir], { cwd: base });
      expect(ja.exitCode).toBe(1);
      const rt = await runCli(['init', 'team', 'novo-time', '--runtime', 'node'], { cwd: base });
      expect(rt.exitCode).toBe(2);
    });
  });
});
