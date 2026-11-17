import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

/**
 * Hub de produção FALSO para os testes de `build`/`init` que rodam sem
 * `ADK_HUB_URL`.
 *
 * Desde o perfil `prod` padrão (docs/adk-externo, ticket 01), o `adk build`
 * sem variável nenhuma consulta `GET /api/v1/adk/policy` no Hub de produção.
 * A suíte nunca fala com produção (guarda em `vitest.rede-guard.mjs`): aqui o
 * endpoint responde 404, e o build segue com a política embutida — o mesmo
 * caminho de "Hub fora do ar", que é o que esses testes exercitavam antes,
 * quando a falta de `ADK_HUB_URL` levava direto à política embutida.
 *
 * Qualquer outra chamada não mockada é erro (`onUnhandledRequest: 'error'`).
 */
export const API_PROD = 'https://api-hub-v2.simplafy.com.br';

export function usarHubDeProducaoFalso(): ReturnType<typeof setupServer> {
  const server = setupServer(
    http.get(`${API_PROD}/api/v1/adk/policy`, () => new HttpResponse(null, { status: 404 })),
  );
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
  return server;
}
