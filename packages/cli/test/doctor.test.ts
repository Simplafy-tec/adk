import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

const HUB = 'http://hub-mock.test';

const server = setupServer(
  http.get(`${HUB}/api/v1/adk/policy`, () =>
    HttpResponse.json({
      spec_versions: ['v1'],
      runtimes: { node: '>=20', python: ['3.12'], uv: '>=0.4' },
      limits: { script: { default: 1, max: 2, timeout: 30 }, org: {}, node: {} },
      registries: { allowed_images: [] },
      package: { max_size_bytes: 5_000_000 },
    }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('adk doctor', () => {
  it('passa (exit 0) na máquina local: Node 20, python3/uv e git presentes', async () => {
    const result = await runCli(['doctor'], { env: { ADK_HUB_URL: HUB } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/node/i);
    expect(result.stdout).toMatch(/uv/i);
    expect(result.stdout).toMatch(/git/i);
  });

  it('sem GET /api/v1/adk/policy disponível, cai para a política embutida e ainda funciona', async () => {
    server.use(http.get(`${HUB}/api/v1/adk/policy`, () => HttpResponse.json(null, { status: 404 })));
    const result = await runCli(['doctor'], { env: { ADK_HUB_URL: HUB } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/política embutida|fallback/i);
  });
});
