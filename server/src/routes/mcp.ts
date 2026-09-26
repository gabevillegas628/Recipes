import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAuth } from '../auth.js';
import {
  connectorStatus,
  generateConnectorToken,
  revokeConnectorTokens,
  verifyConnectorToken,
} from '../connector.js';
import { env } from '../env.js';
import { buildMcpServer } from '../mcp.js';

/**
 * MCP endpoint for the Claude connector: POST /mcp/<token>, where the unguessable
 * token (managed on the Settings page) is the auth. Plus the settings API for it.
 */

function baseUrl(request: FastifyRequest) {
  return env.publicUrl ?? `${request.protocol}://${request.host}`;
}

export async function mcpRoutes(app: FastifyInstance) {
  app.post<{ Params: { token: string } }>('/mcp/:token', async (request, reply) => {
    if (!(await verifyConnectorToken(request.params.token))) {
      return reply.code(404).send({ error: 'Not found' });
    }

    const server = buildMcpServer(baseUrl(request));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // Stateless server: no SSE stream to open and no session to end.
  app.route<{ Params: { token: string } }>({
    method: ['GET', 'DELETE'],
    url: '/mcp/:token',
    handler: async (request, reply) => {
      if (!(await verifyConnectorToken(request.params.token))) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply
        .code(405)
        .header('Allow', 'POST')
        .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
    },
  });

  app.get('/api/connector', { preHandler: requireAuth }, async () => connectorStatus());

  /** Creates a new connector URL, revoking the previous one. The URL is only returned here. */
  app.post('/api/connector', { preHandler: requireAuth }, async (request) => {
    const token = await generateConnectorToken(request.userId);
    return { url: `${baseUrl(request)}/mcp/${token}`, ...(await connectorStatus()) };
  });

  app.delete('/api/connector', { preHandler: requireAuth }, async () => {
    await revokeConnectorTokens();
    return connectorStatus();
  });
}
