#!/usr/bin/env node
// Hook PreToolUse/Bash: pede confirmação humana ("ask") antes de
// `adk deploy`/`adk apply` que possa gravar em PRODUÇÃO. O apply escreve no
// Hub e não existe `adk rollback`.
//
// NEGA POR PADRÃO: só fica em silêncio quando o PRÓPRIO segmento do apply
// prova staging — `--profile staging` (sem outro --profile divergente) ou
// `ADK_PROFILE=staging`/`ADK_HUB_URL=<staging>` logo antes do `adk` — e o
// comando não tem palavra que muda ambiente/execução (eval, export, bash -c,
// `$(`…, `#` de comentário, `--` isolado). Todo o resto pergunta. `--env` não prova nada; `--yes` não dispensa
// o hook (ele só pula a trava da CLI).
//
// O process.env NÃO prova staging: o ambiente do shell do Bash pode divergir
// do process.env deste hook (o shell carrega rc, direnv, exports anteriores).
// Ele só pode piorar: ADK_HUB_URL/ADK_AUTH_URL fora de staging → pergunta.
//
// NUNCA decide "allow": plan, build e comando que não é `adk` ficam em silêncio.

const HOSTS_STAGING = new Set(['api-hub-v2-staging.simplafy.com.br', 'app-staging.simplafy.com.br']);
const OPCOES_COM_VALOR = new Set(['--profile', '--env', '--org', '--dir']);
const ATRIBUICAO = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MUDA_AMBIENTE = new RegExp(
  String.raw`(?:^|[\s;&|('"])(?:\S*/)?(?:eval|source|\.|export|declare|typeset|readonly|local|unset|read|mapfile|readarray|set|env|sudo|direnv|\{|then|do)(?=$|[\s;&|)'"])` +
    String.raw`|\bprintf\s+-v|\b(?:bash|sh|zsh|fish|dash)\s+-\w*c|\$\(|` + '`' +
    // `#` no início de palavra (comentário) e `--` isolado (fim das opções):
    // o que vem depois não chega como opção à CLI.
    String.raw`|(?:^|\s)(?:#|--(?=$|\s))`,
);

function ehStaging(url) {
  try {
    return HOSTS_STAGING.has(new URL(url).host);
  } catch {
    return false;
  }
}

/** Palavras do segmento, sem aspas e sem `(`, `)`, `` ` `` e `$(` nas pontas. */
function palavras(segmento) {
  return segmento
    .split(/\s+/)
    .map((p) => p.replace(/^[$(`'"]+|[)`'"]+$/g, ''))
    .filter(Boolean);
}

/** Subcomando do `adk`, pulando opções globais (`adk --profile prod apply`). */
function subcomando(lista) {
  for (let i = 0; i < lista.length; i++) {
    if (!lista[i].startsWith('-')) return lista[i];
    if (OPCOES_COM_VALOR.has(lista[i])) i++;
  }
  return undefined;
}

/** Todos os valores de `--profile v`/`--profile=v`. */
function perfis(doAdk) {
  return doAdk.flatMap((p, i) =>
    p === '--profile' ? [doAdk[i + 1]] : p.startsWith('--profile=') ? [p.slice(10)] : [],
  );
}

/** Valores de `NOME=v` no prefixo do `adk`. */
function inline(antesDoAdk, nome) {
  return antesDoAdk.filter((p) => p.startsWith(`${nome}=`)).map((p) => p.slice(nome.length + 1));
}

/**
 * Cada segmento com `adk apply|deploy` (ou que cita `adk` e `apply|deploy` sem
 * se deixar ler) diz se prova staging sozinho.
 */
function provasDosApplies(comando) {
  const segmentos = comando.replace(/\\\r?\n/g, ' ').split(/&&|\|\||[;|&\n]/);
  return segmentos.flatMap((segmento) => {
    const lista = palavras(segmento);
    const iAdk = lista.findIndex((p) => /(?:^|[/@])adk(?:@\S*)?$/.test(p));
    const doAdk = lista.slice(iAdk + 1);
    if (iAdk >= 0 && ['apply', 'deploy'].includes(subcomando(doAdk))) {
      const antesDoAdk = lista.slice(0, iAdk);
      const valores = [...perfis(doAdk), ...inline(antesDoAdk, 'ADK_PROFILE')];
      const hubs = inline(antesDoAdk, 'ADK_HUB_URL');
      return [
        antesDoAdk.every((p) => ATRIBUICAO.test(p)) &&
          valores.length + hubs.length > 0 &&
          valores.every((v) => v === 'staging') &&
          hubs.every(ehStaging),
      ];
    }
    return /\badk\b/.test(segmento) && /\b(?:apply|deploy)\b/.test(segmento) ? [false] : [];
  });
}

function provaStaging(comando, env) {
  const provas = provasDosApplies(comando);
  if (provas.length === 0) return true;
  const envPiora = ['ADK_HUB_URL', 'ADK_AUTH_URL'].some((n) => env[n]?.trim() && !ehStaging(env[n].trim()));
  return !envPiora && !MUDA_AMBIENTE.test(comando) && provas.every(Boolean);
}

let entrada = '';
process.stdin.on('data', (pedaco) => {
  entrada += pedaco;
});
process.stdin.on('end', () => {
  let comando = '';
  try {
    comando = JSON.parse(entrada)?.tool_input?.command ?? '';
  } catch {
    process.exit(0);
  }
  if (provaStaging(comando, process.env)) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason:
          'Este comando pode aplicar em produção: o próprio comando não prova staging. ' +
          'O apply do ADK escreve no Hub e não existe `adk rollback`. ' +
          'Confirme com um humano antes de prosseguir (para staging, escreva --profile staging no próprio comando do apply).',
      },
    }),
  );
  process.exit(0);
});
