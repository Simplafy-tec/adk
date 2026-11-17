/**
 * `adk mcp-server` — o contrato do ADK exposto a um cliente MCP (stdio).
 *
 * Cinco tools, nenhuma delas escreve: `plan` é o mais longe que se vai, e ele
 * exige credencial. A resposta NUNCA carrega token — nem o do usuário, nem o
 * `ADK_TOKEN` do ambiente: quem chama já tem o que precisa para agir, e um
 * segredo que atravessa o transporte fica no log de quem estiver ouvindo.
 *
 * O stdout é do PROTOCOLO: nada aqui imprime em `ctx.out`.
 */

import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  AgentSpecSchema,
  JourneySpecSchema,
  SPEC_KINDS,
  SUPPORTED_SPEC_VERSIONS,
  ToolSpecSchema,
  parseSpecYaml,
  scanLeaks,
  validateSpecStructure,
  type SpecIssue,
} from '@simpla.fy/adk-contract';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { PASTAS, artefatosDaOrg } from '../artefatos.js';
import { accessToken, carregarPolitica, chamarAdk, planoDaResposta } from '../hub.js';
import { KINDS_PORTAO_PROFUNDO, NOTA_PORTAO_PROFUNDO } from '../kinds-profundos.js';
import { resolverAmbiente, type Ctx } from '../ctx.js';
import { versaoDaCli } from '../versao.js';

const SCHEMAS = {
  agent: AgentSpecSchema,
  tool: ToolSpecSchema,
  journey: JourneySpecSchema,
} as const;

function texto(valor: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(valor, null, 2) }],
    isError,
  };
}

export async function comandoMcpServer(ctx: Ctx): Promise<number> {
  const server = new McpServer({ name: 'simplafy-adk', version: versaoDaCli() });

  server.registerTool(
    'list_components',
    {
      description:
        'Kinds de componente que o ADK conhece, os templates do `adk init` e um resumo da política da plataforma.',
    },
    async () => {
      const { policy, origem } = await carregarPolitica(ctx);
      return texto({
        kinds: SPEC_KINDS,
        templates: [
          { kind: 'tool', comando: 'adk init tool <nome>', deploy: 'disponível' },
          { kind: 'mcp', comando: 'adk init mcp <nome>', deploy: 'disponível' },
          { kind: 'app', comando: 'adk init app <nome>', deploy: 'disponível' },
        ],
        spec_versions: SUPPORTED_SPEC_VERSIONS,
        policy: { origem, runtimes: policy.runtimes, package: policy.package },
      });
    },
  );

  server.registerTool(
    'get_contract',
    {
      description:
        'Contrato do spec de um kind. JSON Schema para agent | tool | journey; para ' +
        'mcp | app | table, os campos que o apply do Hub exige (o portão desses é do servidor).',
      inputSchema: { kind: z.enum(SPEC_KINDS as unknown as [string, ...string[]]) },
    },
    async ({ kind }) => {
      const schema = SCHEMAS[kind as keyof typeof SCHEMAS];
      if (schema) return texto(zodToJsonSchema(schema, kind));
      // `mcp`, `app` e `table` não têm schema público de propósito, mas são
      // kinds VÁLIDOS — anunciados pelo `list_components` logo acima.
      // Responder "kind desconhecido" mandava quem perguntou de volta para a
      // tentativa e erro contra o servidor (issue#2769).
      const profundo = KINDS_PORTAO_PROFUNDO[kind];
      if (profundo) {
        return texto({
          kind,
          contrato: 'parcial',
          julgado_por: 'apply do Hub',
          campos_obrigatorios: profundo.campos,
          nota: NOTA_PORTAO_PROFUNDO,
        });
      }
      return texto({ erro: `kind desconhecido: ${kind}` }, true);
    },
  );

  server.registerTool(
    'get_policy',
    { description: 'Política da plataforma (GET /api/v1/adk/policy, com fallback embutido).' },
    async () => texto(await carregarPolitica(ctx)),
  );

  server.registerTool(
    'validate',
    {
      description:
        'Valida um spec em YAML contra o contrato — devolve issues {code, path, message}. Não exige login.',
      inputSchema: {
        yaml: z.string().describe('Conteúdo do arquivo de spec.'),
        filename: z
          .string()
          .optional()
          .describe('Nome do arquivo, para conferir a identidade do slug.'),
      },
    },
    async ({ yaml, filename }) => {
      const issues: SpecIssue[] = [
        ...validateSpecStructure(parseSpecYaml(yaml)),
        ...scanLeaks(yaml, {
          filename: filename ?? 'spec.yaml',
          checkSlug: filename !== undefined,
        }),
      ];
      return texto({ issues });
    },
  );

  server.registerTool(
    'plan',
    {
      description:
        'Plano de aplicação de um spec numa organização (nunca aplica). Exige login ou ADK_TOKEN.',
      inputSchema: {
        yaml: z.string().optional().describe('Spec em YAML; alternativa a `dir`.'),
        dir: z.string().optional().describe('Pasta do repositório de clientes.'),
        org: z.string().describe('Id da organização no ambiente.'),
        env: z.string().optional().describe('Ambiente (default: o do perfil — prod → production).'),
      },
    },
    async ({ yaml, dir, org, env }) => {
      const token = await accessToken(ctx);
      if (!token) {
        return texto(
          {
            erro: 'Sem credencial: rode `adk login` (ou defina ADK_TOKEN) antes de pedir um plano.',
          },
          true,
        );
      }
      // Mesma fronteira do `adk plan`: sob `dir` só entram as pastas cujo
      // `org.yaml` declara ESTE id no ambiente. Sem o filtro, um repositório
      // com várias organizações mandaria a configuração de todas rotulada com
      // o único `org` informado — a de um cliente na conta de outro.
      let especificacoes: { yaml: string; rota: ReturnType<typeof rotaDoKind>; arquivo: string }[];
      if (yaml) {
        especificacoes = [{ yaml, rota: rotaDoKind(yaml), arquivo: 'spec.yaml' }];
      } else {
        // O ambiente só escolhe a pasta: com `yaml` avulso ele não entra. Sem
        // padrão próprio (mesma regra do `adk plan`): com ADK_HUB_URL de host
        // desconhecido e sem perfil, o `env` é obrigatório.
        const resolvido = resolverAmbiente(ctx, env);
        if (!resolvido.ok) return texto({ erro: resolvido.erro }, true);
        especificacoes = artefatosDaOrg(resolve(ctx.cwd, dir ?? '.'), org, resolvido.ambiente).map(
          (a) => ({ yaml: a.yaml, rota: a.rota, arquivo: `orgs/${a.org}/${a.pasta}/${a.arquivo}` }),
        );
      }
      const planos = [];
      for (const e of especificacoes) {
        if (!e.rota) {
          planos.push({ arquivo: e.arquivo, erro: 'kind não reconhecido no spec.' });
          continue;
        }
        try {
          const r = await chamarAdk(ctx, {
            rota: e.rota,
            operacao: 'plan',
            orgId: org,
            yaml: e.yaml,
          });
          // A rota `plan` responde o plano CRU; só o `apply` responde
          // `{plan, applied}`. `planoDaResposta` cobre os dois — ler `r.plan`
          // devolvia `null` em TODO plano, e um agente que lê "nada a mudar"
          // segue para o apply sem ter visto o diff (issue#2767).
          planos.push({ arquivo: e.arquivo, plan: planoDaResposta(r) });
        } catch (erro) {
          planos.push({ arquivo: e.arquivo, erro: (erro as Error).message });
        }
      }
      return texto({ planos });
    },
  );

  await server.connect(new StdioServerTransport());
  // O processo vive enquanto o transporte estiver aberto — quem encerra é o
  // cliente MCP fechando o stdin.
  return new Promise<number>((resolver) => {
    server.server.onclose = () => resolver(0);
  });
}

/** kind → rota da API, pela MESMA tabela que resolve pasta→kind no repositório. */
function rotaDoKind(yaml: string): string | null {
  const kind = (parseSpecYaml(yaml) as { kind?: unknown }).kind;
  return PASTAS.find((p) => p.kind === kind)?.rota ?? null;
}
