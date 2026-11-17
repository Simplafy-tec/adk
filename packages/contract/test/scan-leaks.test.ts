import { describe, expect, it } from 'vitest';
import { scanLeaks } from '../src/index.js';

// Porte 1:1 de simplafy-clientes/scripts/validar.mjs — mesmos fixtures de vazamento
// citados no brief (Test cases), agora como SpecIssue{code,path,message}.

describe('scanLeaks — segredo literal', () => {
  it('reprova api_key literal com 12+ caracteres', () => {
    const issues = scanLeaks('api_key: abcdef123456\n', { filename: 'agentes/ana.yaml' });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'secret_literal' }));
  });

  it('reprova sk-... como chave de API', () => {
    const issues = scanLeaks('token: sk-abcdefgh12345678\n', { filename: 'tools/x.yaml' });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'secret_literal' }));
  });

  it('reprova chave privada PEM', () => {
    const issues = scanLeaks('-----BEGIN PRIVATE KEY-----\nMIIB...\n', { filename: 'tools/x.yaml' });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'secret_literal' }));
  });
});

describe('scanLeaks — formato de chave da própria plataforma (rodada 2, finding #2)', () => {
  it('reprova sk_live_... (formato sk_ com underscore, chave do Hub)', () => {
    const issues = scanLeaks('api_key: sk_live_abcdefgh12345678\n', { filename: 'tools/x.yaml' });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'secret_literal' }));
  });

  it('reprova "token = "..."" (atribuição com =, não só :)', () => {
    const issues = scanLeaks('token = "abcdefghijklmnop"\n', { filename: 'tools/x.yaml' });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'secret_literal' }));
  });

  it('reprova "access_token: eyJ..." (token composto, \\b não casa depois de _)', () => {
    const issues = scanLeaks(
      'access_token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\n',
      { filename: 'tools/x.yaml' },
    );
    expect(issues).toContainEqual(expect.objectContaining({ code: 'secret_literal' }));
  });

  it('reprova "refresh_token: ..." (token composto)', () => {
    const issues = scanLeaks('refresh_token: abcdefghijklmnop1234\n', { filename: 'tools/x.yaml' });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'secret_literal' }));
  });

  it('não reprova token_budget: 4096 (falso positivo — não é segredo)', () => {
    const issues = scanLeaks('token_budget: 4096\n', { filename: 'tools/x.yaml' });
    expect(issues.find((i) => i.code === 'secret_literal')).toBeUndefined();
  });

  it('não reprova secret: ${REF} (referência simbólica, resolvida no Hub)', () => {
    const issues = scanLeaks('secret: ${REF}\n', { filename: 'tools/x.yaml' });
    expect(issues.find((i) => i.code === 'secret_literal')).toBeUndefined();
  });

  it('não reprova api_key_name: pipefy (nome de credencial, não o valor)', () => {
    const issues = scanLeaks('api_key_name: pipefy\n', { filename: 'tools/x.yaml' });
    expect(issues.find((i) => i.code === 'secret_literal')).toBeUndefined();
  });
});

describe('scanLeaks — PII', () => {
  it('reprova telefone brasileiro em definition', () => {
    const issues = scanLeaks('definition:\n  contato: 5511987654321\n', {
      filename: 'agentes/ana.yaml',
    });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'pii_in_config' }));
  });

  it('reprova CPF', () => {
    const issues = scanLeaks('cpf: 123.456.789-09\n', { filename: 'agentes/ana.yaml' });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'pii_in_config' }));
  });
});

describe('scanLeaks — identificador interno', () => {
  it('reprova cuid como channelId', () => {
    const issues = scanLeaks('channelId: cmxxxxxxxxxxxxxxxxxxxxxxx\n', {
      filename: 'agentes/ana.yaml',
    });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'internal_id' }));
  });
});

describe('scanLeaks — contexto de turno', () => {
  it('reprova chave oap_contact_phone (contexto do turno, não configuração)', () => {
    const issues = scanLeaks('oap_contact_phone: "5511999999999"\n', {
      filename: 'agentes/ana.yaml',
    });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'turn_context' }));
  });
});

describe('scanLeaks — slug ≠ arquivo', () => {
  it('reprova slug que não casa com o nome do arquivo', () => {
    const issues = scanLeaks('slug: outra-coisa\n', { filename: 'agentes/ana.yaml' });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'slug_filename_mismatch', path: 'slug' }),
    );
  });

  it('não reprova quando o slug casa com o arquivo', () => {
    const issues = scanLeaks('slug: ana\n', { filename: 'agentes/ana.yaml' });
    expect(issues.find((i) => i.code === 'slug_filename_mismatch')).toBeUndefined();
  });
});

describe('scanLeaks — mutation check (mesmo path do servidor)', () => {
  it('devolve o mesmo path para o mesmo segredo independente da forma de entrada (yaml vs. spec serializado)', () => {
    const viaYaml = scanLeaks('definition:\n  api_key: abcdef123456\n', { filename: 'tools/x.yaml' });
    const viaSpecSerializado = scanLeaks(
      JSON.stringify({ definition: { api_key: 'abcdef123456' } }),
      { filename: 'tools/x.yaml' },
    );
    const codeViaYaml = viaYaml.find((i) => i.code === 'secret_literal');
    const codeViaSpec = viaSpecSerializado.find((i) => i.code === 'secret_literal');
    expect(codeViaYaml).toBeDefined();
    expect(codeViaSpec).toBeDefined();
    // A asserção que faz o mutation check valer algo: não basta os DOIS
    // acharem um issue, o `path` tem que ser o MESMO — senão o servidor e a
    // CLI mostrariam paths diferentes para o mesmo segredo (AC4).
    expect(codeViaYaml?.path).toBe(codeViaSpec?.path);
    expect(codeViaYaml?.message).toBe(codeViaSpec?.message);
  });
});

describe('scanLeaks — regra de senha aceita chave com e sem aspas (paridade YAML/JSON)', () => {
  it('reprova "password: x" (YAML, chave sem aspas)', () => {
    const issues = scanLeaks('password: minhasenha123\n', { filename: 'agentes/ana.yaml' });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'secret_literal' }));
  });

  it('reprova \'"password": "x"\' (spec serializado como JSON, chave entre aspas)', () => {
    const issues = scanLeaks(JSON.stringify({ password: 'minhasenha123' }), {
      filename: 'agentes/ana.yaml',
    });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'secret_literal' }));
  });
});

// Rodada 3 (finding #1, block da review): a regex de `secret_literal` sem
// âncora à esquerda (`[\w-]*(secret|api[_-]?key|token)...`) é O(n²) — medido
// 20 KB = 450 ms, 200 KB = 48 s. Entrada sintética só com `[\w-]` contíguos
// (sem `:`/`=` que fecharia o casamento) é o pior caso: o motor tenta a
// alternação em toda posição do bloco contíguo antes de desistir.
describe('scanLeaks — orçamento de tempo (ReDoS, rodada 3 finding #1)', () => {
  it('200 KB de identificador contíguo sem separador termina em menos de 200ms', () => {
    const entrada = 'a'.repeat(200 * 1024);
    const inicio = performance.now();
    scanLeaks(entrada, { filename: 'tools/x.yaml' });
    const duracao = performance.now() - inicio;
    expect(duracao).toBeLessThan(200);
  });

  it('1 MB de identificador contíguo sem separador termina em menos de 500ms', () => {
    const entrada = 'a'.repeat(1024 * 1024);
    const inicio = performance.now();
    scanLeaks(entrada, { filename: 'tools/x.yaml' });
    const duracao = performance.now() - inicio;
    expect(duracao).toBeLessThan(500);
  });
});

// Rodada 3 (finding #2): token da plataforma (`Authorization: Bearer eyJ…`)
// tem formato JWT reconhecível e não depende de nome de chave — precisa ser
// pego mesmo sem `token:`/`api_key:` na frente.
describe('scanLeaks — JWT literal (rodada 3 finding #2)', () => {
  it('reprova um JWT literal (header.payload, três segmentos separados por ponto)', () => {
    const issues = scanLeaks(
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc2lzYXNpZ25hdHVyZQ\n',
      { filename: 'tools/x.yaml' },
    );
    expect(issues).toContainEqual(expect.objectContaining({ code: 'secret_literal' }));
  });

  it('não reprova "eyJ" curto isolado (falso positivo — não é um JWT)', () => {
    const issues = scanLeaks('nome: eyJoje\n', { filename: 'tools/x.yaml' });
    expect(issues.find((i) => i.code === 'secret_literal')).toBeUndefined();
  });
});

// issue#2594 — formato de PACOTE: a identidade é a PASTA, não o arquivo.
//
// A issue#2500 acrescentou `<slug>/manifest.yaml` ao repositório de clientes, e
// é o que `adk init tool|mcp|app` gera. Como o arquivo se chama SEMPRE
// `manifest.yaml`, a conferência contra o nome do arquivo virou uma regra
// impossível de satisfazer: `adk validate` reprovava 9 de 9 pacotes num
// repositório real, enquanto `adk deploy` aceitava os MESMOS arquivos.
describe('scanLeaks — slug no formato de pacote (issue#2594)', () => {
  it('casa o slug com a PASTA quando o arquivo é manifest.yaml', () => {
    const issues = scanLeaks('slug: prototipo-saudacao\n', {
      filename: 'orgs/acme/tools/prototipo-saudacao/manifest.yaml',
    });
    expect(issues.find((i) => i.code === 'slug_filename_mismatch')).toBeUndefined();
  });

  it('ainda reprova quando o slug não casa com a pasta', () => {
    const issues = scanLeaks('slug: outra-coisa\n', {
      filename: 'orgs/acme/tools/prototipo-saudacao/manifest.yaml',
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'slug_filename_mismatch', path: 'slug' }),
    );
  });

  it('o formato de ARQUIVO ÚNICO segue conferindo contra o nome do arquivo', () => {
    const casa = scanLeaks('slug: ana\n', { filename: 'orgs/acme/agentes/ana.yaml' });
    expect(casa.find((i) => i.code === 'slug_filename_mismatch')).toBeUndefined();
    const naoCasa = scanLeaks('slug: outra\n', { filename: 'orgs/acme/agentes/ana.yaml' });
    expect(naoCasa).toContainEqual(expect.objectContaining({ code: 'slug_filename_mismatch' }));
  });

  it('manifest.yaml SEM pasta (o caso do `adk build`) não inventa identidade', () => {
    // Aqui não há pasta de onde tirar o slug — a conferência precisa se calar
    // em vez de comparar com "manifest".
    const issues = scanLeaks('slug: qualquer-coisa\n', { filename: 'manifest.yaml' });
    expect(issues.find((i) => i.code === 'slug_filename_mismatch')).toBeUndefined();
  });
});

// issue#2603 — digest de imagem NÃO é identificador interno.
//
// `kind: mcp` é OBRIGADO a declarar a imagem por digest (tag é recusada). Um
// digest sha256 que comece com `c` casa `c[a-z0-9]{24,}` e virava `internal_id`
// — ~1 em 16 imagens, sorteado pelo conteúdo. Um rebuild podia quebrar um
// manifesto que passava, sem ninguém ter mexido nele.
describe('scanLeaks — digest de imagem não é identificador interno (issue#2603)', () => {
  const digestComC =
    'ghcr.io/simplafy-tec/prototipo-adk-satelite@sha256:ce3a575eeb1263ed3af8ad865c2ca3f36e0419dd962f37562e443fb8bc3a1a53';

  it('não reprova digest que começa com "c"', () => {
    const issues = scanLeaks(`image: ${digestComC}\n`, { filename: 'mcp/satelite/manifest.yaml' });
    expect(issues.find((i) => i.code === 'internal_id')).toBeUndefined();
  });

  it('não reprova digest que começa com outro hex', () => {
    const outro =
      'ghcr.io/simplafy-tec/x@sha256:a13a575eeb1263ed3af8ad865c2ca3f36e0419dd962f37562e443fb8bc3a1a53';
    const issues = scanLeaks(`image: ${outro}\n`, { filename: 'mcp/satelite/manifest.yaml' });
    expect(issues.find((i) => i.code === 'internal_id')).toBeUndefined();
  });

  it('CONTINUA reprovando cuid de verdade no MESMO arquivo que tem digest', () => {
    // O que não pode acontecer: isentar o digest e, de quebra, cegar a regra
    // para o resto do arquivo.
    const issues = scanLeaks(`image: ${digestComC}\nchannelId: cmxxxxxxxxxxxxxxxxxxxxxxx\n`, {
      filename: 'mcp/satelite/manifest.yaml',
    });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'internal_id' }));
  });

  it('CONTINUA reprovando uuid no mesmo arquivo que tem digest', () => {
    const issues = scanLeaks(
      `image: ${digestComC}\nexecutionId: 123e4567-e89b-12d3-a456-426614174000\n`,
      { filename: 'mcp/satelite/manifest.yaml' },
    );
    expect(issues).toContainEqual(expect.objectContaining({ code: 'internal_id' }));
  });
});

// issue#2808 — `turn_context` só acusa NOME COM VALOR ao lado, não a menção.
//
// Hoje `scanLeaks` reprova qualquer MENÇÃO a um nome de `CONTEXTO_DE_TURNO`
// (`text.includes(c)`), inclusive o placeholder `<oap_contact_phone>` — que é
// exatamente como se documenta a interface do turno para o modelo no prompt
// (bloqueava o prompt real de um cliente, linha 688, forma
// `number: <oap_contact_phone>`). O novo comportamento só acusa quando o nome
// aparece como CHAVE COM VALOR LITERAL ao lado — as três formas que o arquivo
// já trata em outras regras: `nome: valor` (YAML), `nome = valor`,
// `"nome": "valor"` (JSON). Nenhum telefone real entra aqui — o sintético
// obrigatório é `+55 11 99999-9999` (que, por ter espaço/hífen, NÃO casa a
// regra de `pii_in_config`, então a única coisa que pode acusar esse texto é
// `turn_context` — é isso que torna a asserção por `code` isolado válida).
describe('scanLeaks — turn_context só acusa nome COM VALOR (issue#2808)', () => {
  it('placeholder angular `<oap_contact_phone>` dentro de exemplo de chamada de tool não reprova (caso real do prompt real de um cliente)', () => {
    const trechoEquivalenteAoPromptV27 = [
      'Exemplo de chamada da tool crm_atualizar_contato:',
      '  parâmetros:',
      '    number: <oap_contact_phone>',
      '    mensagem: "Olá, tudo bem?"',
    ].join('\n');
    const issues = scanLeaks(trechoEquivalenteAoPromptV27, { filename: 'agentes/caderno-tecnico.yaml' });
    expect(issues.find((i) => i.code === 'turn_context')).toBeUndefined();
  });

  it('placeholder `{{oap_contact_phone}}` (mustache) não reprova', () => {
    const issues = scanLeaks('Envie a mensagem para {{oap_contact_phone}}.\n', {
      filename: 'agentes/ana.yaml',
    });
    expect(issues.find((i) => i.code === 'turn_context')).toBeUndefined();
  });

  it('placeholder `${oap_contact_phone}` (template string) não reprova', () => {
    const issues = scanLeaks('Envie a mensagem para ${oap_contact_phone}.\n', {
      filename: 'agentes/ana.yaml',
    });
    expect(issues.find((i) => i.code === 'turn_context')).toBeUndefined();
  });

  it('`oap_contact_phone: +55 11 99999-9999` (YAML, valor real sintético) reprova por turn_context — mutation check: sem a detecção de valor ao lado este teste fica vermelho', () => {
    const issues = scanLeaks('oap_contact_phone: +55 11 99999-9999\n', {
      filename: 'agentes/ana.yaml',
    });
    const turnContext = issues.find((i) => i.code === 'turn_context');
    expect(turnContext).toBeDefined();
    expect(turnContext).toEqual(
      expect.objectContaining({ path: 'oap_contact_phone' }),
    );
  });

  it('o caso já existente com aspas `oap_contact_phone: "5511999999999"` continua reprovando (forma com aspas + PII simultâneo)', () => {
    const issues = scanLeaks('oap_contact_phone: "5511999999999"\n', {
      filename: 'agentes/ana.yaml',
    });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'turn_context' }));
  });

  it('paridade JSON: `{"oap_contact_phone":"+55 11 99999-9999"}` reprova por turn_context', () => {
    const issues = scanLeaks(JSON.stringify({ oap_contact_phone: '+55 11 99999-9999' }), {
      filename: 'agentes/ana.yaml',
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'turn_context', path: 'oap_contact_phone' }),
    );
  });

  it.each(['oap_contact_name', 'crm_lead_id', 'langfuse_session_id'])(
    'para "%s": placeholder passa, "%s: valor" reprova',
    (nome) => {
      const comPlaceholder = scanLeaks(`Contexto: <${nome}>\n`, { filename: 'agentes/ana.yaml' });
      expect(comPlaceholder.find((i) => i.code === 'turn_context')).toBeUndefined();

      const comValor = scanLeaks(`${nome}: valor-de-exemplo-123\n`, { filename: 'agentes/ana.yaml' });
      expect(comValor).toContainEqual(
        expect.objectContaining({ code: 'turn_context', path: nome }),
      );
    },
  );

  it.each([
    'oap_contact_phone: "<oap_contact_phone>"',
    '{"oap_contact_phone":"{{oap_contact_phone}}"}',
    'oap_contact_phone: "{{ oap_contact_phone }}"',
    "oap_contact_phone: '${oap_contact_phone}'",
  ])('placeholder ENTRE ASPAS não reprova (%s)', (texto) => {
    const issues = scanLeaks(texto, { filename: 'agentes/ana.yaml' });
    expect(issues.find((i) => i.code === 'turn_context')).toBeUndefined();
  });

  it('regra continua VIVA no mesmo arquivo: placeholder de um nome não cega a detecção de valor de outro nome', () => {
    const texto = ['Use <oap_contact_phone> na saudação.', 'crm_lead_id: lead-12345'].join('\n');
    const issues = scanLeaks(texto, { filename: 'agentes/ana.yaml' });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'turn_context', path: 'crm_lead_id' }),
    );
    expect(issues.find((i) => i.code === 'turn_context' && i.path === 'oap_contact_phone')).toBeUndefined();
  });

  it('message e path do issue de turn_context permanecem idênticos aos de hoje (asserção literal)', () => {
    const issues = scanLeaks('oap_contact_phone: +55 11 99999-9999\n', {
      filename: 'agentes/ana.yaml',
    });
    const turnContext = issues.find((i) => i.code === 'turn_context');
    expect(turnContext?.path).toBe('oap_contact_phone');
    expect(turnContext?.message).toBe(
      '"oap_contact_phone" é contexto do turno, não configuração do agente',
    );
  });
});

describe('scanLeaks — issue#2817: ler de env var não é segredo versionado', () => {
  // A regra de segredo exige 12+ caracteres do lado direito, e `os.environ.get`
  // tem 14 — o gate acusava exatamente a prática que queremos incentivar.
  // Só entram casos que ficam vermelhos SEM o neutralizador (medido pelo review:
  // `process.env[` e `os.getenv` já passavam, por serem curtos demais).
  it.each([
    ['python', 'secret = os.environ.get("PIPEFY_OAUTH_SECRET", "").strip()'],
    ['node', 'const token = process.env.MINHA_CHAVE_DE_ACESSO;'],
    ['deno', 'const secret = Deno.env.get("MINHA_CHAVE");'],
  ])('LER de env var não é segredo versionado (%s)', (_nome, linha) => {
    const issues = scanLeaks(linha, { filename: 'server.py' });
    expect(issues.find((i) => i.code === 'secret_literal')).toBeUndefined();
  });

  it('segredo LITERAL continua reprovando — guarda contra desligar a regra', () => {
    const issues = scanLeaks('token = "ghp_abcdefghijklmnop12345"', { filename: 'server.py' });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'secret_literal' }));
  });
});

describe('scanLeaks — issue#2853: atribuição a partir de chamada e comentário não são segredo literal', () => {
  const segredo = (linha: string, filename = 'server.py') =>
    scanLeaks(linha, { filename }).some((i) => i.code === 'secret_literal');

  it.each([
    'token = contexto.token_interno()',
    'token = await contexto.token_interno()',
    'const token = obtemTokenDoHub();',
    'api_key = cliente.credencial_do_hub()',
  ])('atribuição a partir de CHAMADA passa: %s', (linha) => {
    expect(segredo(linha)).toBe(false);
  });

  it('comentário citando o padrão `token: <12+ chars>` passa (Python, JS e YAML)', () => {
    expect(segredo('# o portão reprovava token = contexto.token_interno')).toBe(false);
    expect(segredo('// token: abcdefghijklmnop é o padrão que dispara', 'app.ts')).toBe(false);
    expect(segredo('  /* api_key: abcdefghijklmnop */', 'app.ts')).toBe(false);
  });

  it('`//` e `/* */` em .md/.yaml/.ini/.py são CONTEÚDO e continuam reprovando (review rodada 3)', () => {
    for (const f of ['prompt.md', 'agent.yaml', 'conf.ini', 'server.py']) {
      expect(segredo('// token: abcdefghijklmnop1234', f), f).toBe(true);
      expect(segredo('/* api_key: abcdefghijklmnop1234 */', f), f).toBe(true);
    }
  });

  it('segredo LITERAL continua reprovando — a isenção não vira falso negativo', () => {
    expect(segredo('token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"')).toBe(true);
    expect(segredo('token = "sk-abcdefgh12345678"')).toBe(true);
    expect(segredo('token: abcdefghijklmnop1234')).toBe(true);
  });

  it('segredo de FORMATO inequívoco em comentário continua reprovando', () => {
    expect(segredo('# api_key: sk-realkey123456789')).toBe(true);
    expect(segredo('// Authorization: Bearer eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkw.')).toBe(
      true,
    );
    expect(segredo('# -----BEGIN RSA PRIVATE KEY-----')).toBe(true);
  });

  it('literal na MESMA linha de um comentário de fim de linha continua reprovando', () => {
    expect(segredo('token = "abcdefghijklmnop1234"  # valor fixo')).toBe(true);
  });
});

describe('scanLeaks — issue#2853 (review PR simplafy-adk#37): a isenção não esconde segredo real', () => {
  const segredo = (texto: string, filename = 'server.py') =>
    scanLeaks(texto, { filename }).some((i) => i.code === 'secret_literal');

  it('campo privado TS/JS `#token = "…"` continua reprovando (`#` não é comentário em ts/js)', () => {
    expect(segredo('class C {\n  #token = "abcdefghijklmnop1234";\n}', 'app.ts')).toBe(true);
    expect(segredo('class C {\n  #token = "abcdefghijklmnop1234";\n}', 'app.js')).toBe(true);
  });

  it('`/* x */ api_key = "…"` continua reprovando (só o comentário sai, não a atribuição)', () => {
    expect(segredo('/* x */ api_key = "abcdefghijklmnop1234"', 'app.ts')).toBe(true);
    expect(segredo('/* x */ api_key = "abcdefghijklmnop1234"')).toBe(true);
  });

  it('linha `#` dentro de bloco literal YAML é conteúdo e continua reprovando', () => {
    expect(segredo('prompt: |\n  # token: abcdefghijklmnop1234', 'agente.yaml')).toBe(true);
    // fora do bloco, `#` em YAML segue sendo comentário
    expect(segredo('nome: x\n# token: abcdefghijklmnop1234', 'agente.yaml')).toBe(false);
  });

  it('literal que imita chamada `abc…1234(prod)` continua reprovando', () => {
    expect(segredo('token: abcdefghijklmnop1234(prod)')).toBe(true);
  });

  it('literal embrulhado em chamada `base64.b64decode("…")` continua reprovando', () => {
    expect(segredo('api_key = base64.b64decode("abcdefghijklmnop1234")')).toBe(true);
  });

  it('o caso original da issue segue passando em py e `#` segue comentário em py', () => {
    expect(segredo('token = contexto.token_interno()')).toBe(false);
    expect(segredo('# token: abcdefghijklmnop1234')).toBe(false);
  });
});


describe('scanLeaks — issue#2853 (review 2 do PR simplafy-adk#37): na dúvida, marca', () => {
  const segredo = (texto: string, filename = 'server.py') =>
    scanLeaks(texto, { filename }).some((i) => i.code === 'secret_literal');

  it.each([
    'api_key = binascii.unhexlify(b"6162636465666768696a6b6c6d6e6f70")',
    'api_key = codecs.decode(b"abcdefghijklmnop1234")',
    'token = textwrap.dedent(r"abcdefghijklmnop1234")',
    'token = textwrap.dedent(f"abcdefghijklmnop1234")',
    'token = textwrap.dedent(u"abcdefghijklmnop1234")',
    'token = textwrap.dedent("""abcdefghijklmnop1234""")',
    'token = textwrap.dedent(\n    "abcdefghijklmnop1234"\n)',
    'token = contexto.token_interno() or "abcdefghijklmnop1234"',
    'token = contexto.token_interno(x) \\\n  + abcdefghijklmnop1234',
  ])('chamada com literal, aspas especiais ou continuação reprova: %s', (texto) => {
    expect(segredo(texto)).toBe(true);
  });

  it('literal só de letras seguido de `(…)` reprova', () => {
    expect(segredo('token: abcdefghijklmnopqrstuv(prod)')).toBe(true);
    expect(segredo('token: ABCDEFGHIJKLMNOPQRSTUV(prod)')).toBe(true);
  });

  it('linha `#`/`//` dentro de string multilinha (py, sh, ts) é conteúdo e reprova', () => {
    expect(segredo('PROMPT = """\n# token: abcdefghijklmnop1234\n"""')).toBe(true);
    expect(segredo("PROMPT = '''\n# token: abcdefghijklmnop1234\n'''")).toBe(true);
    expect(segredo('cat <<EOF\n# token: abcdefghijklmnop1234\nEOF', 'run.sh')).toBe(true);
    expect(segredo('X="linha\n# token: abcdefghijklmnop1234"', 'run.sh')).toBe(true);
    expect(segredo('const p = `\n// token: abcdefghijklmnop1234\n`;', 'app.ts')).toBe(true);
  });

  it.each([
    'prompt: |2-\n  # token: abcdefghijklmnop1234',
    'prompt: |-2\n  # token: abcdefghijklmnop1234',
    'prompt: !!str |\n  # token: abcdefghijklmnop1234',
    'prompt: &p |\n  # token: abcdefghijklmnop1234',
    'prompt: &p !!str >+\n  # token: abcdefghijklmnop1234',
    'msg: "a\n  # token: abcdefghijklmnop1234"',
  ])('YAML: `#` em bloco com modificador ou escalar com aspas multilinha reprova: %s', (texto) => {
    expect(segredo(texto, 'agente.yaml')).toBe(true);
  });

  it('isenções legítimas seguem valendo', () => {
    expect(segredo('token = contexto.token_interno()')).toBe(false);
    expect(segredo('const token = obtemTokenDoHub();')).toBe(false);
    expect(segredo('nome: x\n# token: abcdefghijklmnop1234', 'agente.yaml')).toBe(false);
  });
});
