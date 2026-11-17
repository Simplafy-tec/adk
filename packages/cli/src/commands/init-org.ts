/**
 * `adk init org [pasta] [--org <id>] [--dir <raiz>]` — a pasta de uma org que
 * JÁ existe no Hub (docs/adk-externo, ticket 03).
 *
 * Sem este comando, quem começa a versionar uma org escreve o `org.yaml` à mão
 * — e o `org.yaml` é a amarração de tenant que impede `--org <id>` de subir a
 * configuração de um cliente na conta de outro. Aqui ele nasce do token: só
 * entra uma org que o login alcança, no ambiente do perfil, e o `export` traz
 * em seguida o que já está no ar.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { toSlug } from '@simpla.fy/adk-contract';
import { claimsDoToken, orgsDoToken, type OrgDoToken } from '../auth.js';
import { resolverAmbiente, type Ctx } from '../ctx.js';
import { accessToken } from '../hub.js';
import { perguntar, temTerminal } from '../pergunta.js';
import { comandoExport, pastaDaOrg } from './export.js';

export interface OpcoesInitOrg {
  org?: string;
  /** Raiz do repositório de clientes (onde fica `orgs/`). */
  dir?: string;
  /** Ambiente do `org.yaml`; sem ele, o do perfil/host. */
  env?: string;
  /** Nome da pasta em `orgs/`; sem ele, o nome da org (ou o id) em kebab-case. */
  pasta?: string;
}

export async function comandoInitOrg(ctx: Ctx, opcoes: OpcoesInitOrg): Promise<number> {
  const resolvido = resolverAmbiente(ctx, opcoes.env);
  if (!resolvido.ok) {
    ctx.err(resolvido.erro);
    return 2;
  }
  const { ambiente } = resolvido;

  const token = await accessToken(ctx);
  if (!token) {
    ctx.err('Sem credencial: rode `adk login` (ou defina ADK_TOKEN) antes do `adk init org`.');
    return 1;
  }
  const orgs = orgsDoToken(claimsDoToken(token));

  const escolhida = await escolherOrg(ctx, orgs, opcoes.org);
  if (typeof escolhida === 'number') return escolhida;

  const raiz = resolve(ctx.cwd, opcoes.dir ?? '.');
  const jaDeclarada = pastaDaOrg(raiz, escolhida.orgId, ambiente);
  if (jaDeclarada) {
    ctx.err(
      `orgs/${jaDeclarada}/org.yaml já declara ${escolhida.orgId} em environments.${ambiente}. ` +
        `Para atualizar a pasta com o que está no Hub, rode \`adk export --org ${escolhida.orgId}\`.`,
    );
    return 1;
  }

  const pasta = toSlug(opcoes.pasta ?? escolhida.name ?? escolhida.orgId);
  if (!pasta) {
    ctx.err(`Nome de pasta inválido: "${opcoes.pasta}".`);
    return 2;
  }
  const destino = join(raiz, 'orgs', pasta);
  if (existsSync(destino)) {
    // Pasta existente é de outra org (ou do outro ambiente desta): mexer no
    // `org.yaml` dela mudaria a amarração de tenant sem ninguém revisar.
    ctx.err(
      `A pasta orgs/${pasta} já existe. Escolha outro nome (\`adk init org <pasta>\`) ou, se ` +
        `ela é desta org em outro ambiente, acrescente environments.${ambiente} ao org.yaml dela.`,
    );
    return 1;
  }

  mkdirSync(destino, { recursive: true });
  writeFileSync(join(destino, 'org.yaml'), `environments:\n  ${ambiente}: ${escolhida.orgId}\n`);
  ctx.out(`Criado orgs/${pasta}/org.yaml (environments.${ambiente}: ${escolhida.orgId}).`);

  const exportado = await comandoExport(ctx, { org: escolhida.orgId, env: ambiente, dir: raiz });
  if (exportado === 0) {
    ctx.out(`Próximo passo: \`adk plan --org ${escolhida.orgId}\` (só lê; nada é gravado).`);
  } else {
    // O org.yaml já foi gravado: rodar `adk init org` de novo pararia em
    // "já declara". O caminho é só repetir o export.
    const perfil = ambiente === 'staging' ? ' --profile staging' : '';
    ctx.err(
      `A pasta orgs/${pasta} foi criada, mas o export falhou. Corrija o erro acima e ` +
        `rode \`adk export --org ${escolhida.orgId}${perfil}\` de novo.`,
    );
  }
  return exportado;
}

/**
 * A org do `--org` (conferida contra o token) ou a escolhida no terminal.
 * Devolve o exit code quando não há escolha possível.
 */
async function escolherOrg(
  ctx: Ctx,
  orgs: OrgDoToken[],
  pedida: string | undefined,
): Promise<OrgDoToken | number> {
  if (pedida) {
    // Token sem lista de orgs (API key da org) não tem contra o que conferir:
    // quem recusa uma org alheia é o Hub, no export.
    if (orgs.length === 0) return { orgId: pedida, role: '—' };
    const achada = orgs.find((o) => o.orgId === pedida);
    if (achada) return achada;
    ctx.err(`O seu login não alcança a organização ${pedida}. Organizações disponíveis:`);
    listarOrgs(ctx.err, orgs);
    ctx.err(
      `Se ${pedida} é uma org nova para você, rode \`adk login\` de novo (ou \`adk login --org ${pedida}\`).`,
    );
    return 2;
  }

  if (orgs.length === 0) {
    ctx.err('O token não declara organizações: informe --org <id>.');
    return 2;
  }
  ctx.out('Organizações do seu login:');
  listarOrgs(ctx.out, orgs);
  if (!temTerminal(ctx)) {
    ctx.err('Sem terminal para escolher: rode de novo com --org <id>. Nada foi criado.');
    return 2;
  }
  const resposta = await perguntar(ctx, 'Qual organização? (número ou id):');
  const indice = /^\d+$/.test(resposta) ? Number(resposta) - 1 : -1;
  const escolhida = orgs[indice] ?? orgs.find((o) => o.orgId === resposta);
  if (escolhida) return escolhida;
  ctx.err(`"${resposta}" não é nenhuma das organizações listadas. Nada foi criado.`);
  return 2;
}

function listarOrgs(saida: (linha: string) => void, orgs: OrgDoToken[]): void {
  orgs.forEach((o, i) => {
    saida(`  ${i + 1}. ${o.orgId}${o.name ? `  ${o.name}` : ''}  ${o.role}`);
  });
}
