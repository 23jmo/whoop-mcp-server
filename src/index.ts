import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import express, { Request, Response } from 'express';
import { WhoopClient } from './whoop-client.js';
import { WhoopDatabase } from './database.js';
import { WhoopSync } from './sync.js';

// Environment configuration
const config = {
  clientId: process.env.WHOOP_CLIENT_ID || '',
  clientSecret: process.env.WHOOP_CLIENT_SECRET || '',
  redirectUri: process.env.WHOOP_REDIRECT_URI || 'http://localhost:3000/callback',
  dbPath: process.env.DB_PATH || './whoop.db',
  port: parseInt(process.env.PORT || '3000', 10),
  mode: process.env.MCP_MODE || 'http', // 'stdio' or 'http'
};

// Initialize components
const db = new WhoopDatabase(config.dbPath);
const client = new WhoopClient({
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  redirectUri: config.redirectUri,
  onTokenRefresh: (tokens) => db.saveTokens(tokens),
});

// Load existing tokens
const existingTokens = db.getTokens();
if (existingTokens) {
  client.setTokens(existingTokens);
}

const sync = new WhoopSync(client, db);

// Helper functions
function formatDuration(millis: number | null): string {
  if (!millis) return 'N/A';
  const hours = Math.floor(millis / 3600000);
  const minutes = Math.floor((millis % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
}

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function getRecoveryZone(score: number): string {
  if (score >= 67) return 'Green (Well Recovered)';
  if (score >= 34) return 'Yellow (Moderate)';
  return 'Red (Needs Rest)';
}

function getStrainZone(strain: number): string {
  if (strain >= 18) return 'All Out (18-21)';
  if (strain >= 14) return 'High (14-17)';
  if (strain >= 10) return 'Moderate (10-13)';
  return 'Light (0-9)';
}

// Create MCP server
function createMcpServer() {
  const server = new Server(
    {
      name: 'whoop-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Define tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_today',
        description:
          "Get today's Whoop data including recovery score, last night's sleep, and current strain. Perfect for morning briefings.",
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'get_recovery_trends',
        description:
          'Get recovery score trends over time, including HRV and resting heart rate patterns. Useful for identifying recovery patterns.',
        inputSchema: {
          type: 'object',
          properties: {
            days: {
              type: 'number',
              description: 'Number of days to analyze (default: 14, max: 90)',
              default: 14,
            },
          },
          required: [],
        },
      },
      {
        name: 'get_sleep_analysis',
        description:
          'Get detailed sleep analysis including duration, stages, efficiency, and sleep debt. Helps optimize sleep habits.',
        inputSchema: {
          type: 'object',
          properties: {
            days: {
              type: 'number',
              description: 'Number of days to analyze (default: 14, max: 90)',
              default: 14,
            },
          },
          required: [],
        },
      },
      {
        name: 'get_strain_history',
        description:
          'Get training strain history and workout data. Useful for understanding training load and planning workouts.',
        inputSchema: {
          type: 'object',
          properties: {
            days: {
              type: 'number',
              description: 'Number of days to analyze (default: 14, max: 90)',
              default: 14,
            },
          },
          required: [],
        },
      },
      {
        name: 'sync_data',
        description:
          'Manually trigger a data sync from Whoop. Usually not needed as data syncs automatically, but useful if you want the freshest data.',
        inputSchema: {
          type: 'object',
          properties: {
            full: {
              type: 'boolean',
              description: 'Force a full 90-day sync instead of quick sync (default: false)',
              default: false,
            },
          },
          required: [],
        },
      },
      {
        name: 'get_auth_url',
        description:
          'Get the Whoop authorization URL. Use this if you need to (re)authorize the connection to Whoop.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    ],
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      // Auto-sync if needed before data queries
      if (['get_today', 'get_recovery_trends', 'get_sleep_analysis', 'get_strain_history'].includes(name)) {
        const tokens = db.getTokens();
        if (!tokens) {
          return {
            content: [
              {
                type: 'text',
                text: 'Not authenticated with Whoop. Please use get_auth_url to authorize the connection first.',
              },
            ],
          };
        }
        client.setTokens(tokens);

        // Smart sync in background
        try {
          await sync.smartSync();
        } catch (syncError) {
          console.error('Background sync failed:', syncError);
          // Continue with cached data
        }
      }

      switch (name) {
        case 'get_today': {
          const recovery = db.getLatestRecovery();
          const sleep = db.getLatestSleep();
          const cycle = db.getLatestCycle();

          if (!recovery && !sleep && !cycle) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'No data available. Try running sync_data first, or check if Whoop is authorized.',
                },
              ],
            };
          }

          let response = "# Today's Whoop Summary\n\n";

          if (recovery) {
            response += `## Recovery: ${recovery.recovery_score ?? 'N/A'}% ${recovery.recovery_score ? getRecoveryZone(recovery.recovery_score) : ''}\n`;
            response += `- **HRV**: ${recovery.hrv_rmssd?.toFixed(1) ?? 'N/A'} ms\n`;
            response += `- **Resting HR**: ${recovery.resting_hr ?? 'N/A'} bpm\n`;
            if (recovery.spo2) response += `- **SpO2**: ${recovery.spo2.toFixed(1)}%\n`;
            if (recovery.skin_temp) response += `- **Skin Temp**: ${recovery.skin_temp.toFixed(1)}°C\n`;
            response += '\n';
          }

          if (sleep) {
            const totalSleep = (sleep.total_in_bed_milli ?? 0) - (sleep.total_awake_milli ?? 0);
            response += `## Last Night's Sleep\n`;
            response += `- **Total Sleep**: ${formatDuration(totalSleep)}\n`;
            response += `- **Performance**: ${sleep.sleep_performance?.toFixed(0) ?? 'N/A'}%\n`;
            response += `- **Efficiency**: ${sleep.sleep_efficiency?.toFixed(0) ?? 'N/A'}%\n`;
            response += `- **Stages**: Light ${formatDuration(sleep.total_light_milli)}, Deep ${formatDuration(sleep.total_deep_milli)}, REM ${formatDuration(sleep.total_rem_milli)}\n`;
            if (sleep.respiratory_rate) response += `- **Respiratory Rate**: ${sleep.respiratory_rate.toFixed(1)} breaths/min\n`;
            response += '\n';
          }

          if (cycle) {
            response += `## Current Strain\n`;
            response += `- **Day Strain**: ${cycle.strain?.toFixed(1) ?? 'N/A'} ${cycle.strain ? getStrainZone(cycle.strain) : ''}\n`;
            if (cycle.kilojoule) {
              const calories = Math.round(cycle.kilojoule / 4.184);
              response += `- **Calories**: ${calories} kcal\n`;
            }
            if (cycle.avg_hr) response += `- **Avg HR**: ${cycle.avg_hr} bpm\n`;
            if (cycle.max_hr) response += `- **Max HR**: ${cycle.max_hr} bpm\n`;
          }

          return { content: [{ type: 'text', text: response }] };
        }

        case 'get_recovery_trends': {
          const days = Math.min((args as any)?.days || 14, 90);
          const trends = db.getRecoveryTrends(days);

          if (trends.length === 0) {
            return {
              content: [{ type: 'text', text: 'No recovery data available for the requested period.' }],
            };
          }

          let response = `# Recovery Trends (Last ${days} Days)\n\n`;
          response += '| Date | Recovery | HRV | RHR |\n';
          response += '|------|----------|-----|-----|\n';

          for (const day of trends) {
            response += `| ${formatDate(day.date)} | ${day.recovery_score}% | ${day.hrv?.toFixed(1) ?? 'N/A'} ms | ${day.rhr ?? 'N/A'} bpm |\n`;
          }

          // Calculate averages
          const avgRecovery = trends.reduce((sum, d) => sum + (d.recovery_score || 0), 0) / trends.length;
          const avgHrv = trends.reduce((sum, d) => sum + (d.hrv || 0), 0) / trends.length;
          const avgRhr = trends.reduce((sum, d) => sum + (d.rhr || 0), 0) / trends.length;

          response += `\n## Averages\n`;
          response += `- **Recovery**: ${avgRecovery.toFixed(0)}%\n`;
          response += `- **HRV**: ${avgHrv.toFixed(1)} ms\n`;
          response += `- **RHR**: ${avgRhr.toFixed(0)} bpm\n`;

          return { content: [{ type: 'text', text: response }] };
        }

        case 'get_sleep_analysis': {
          const days = Math.min((args as any)?.days || 14, 90);
          const trends = db.getSleepTrends(days);

          if (trends.length === 0) {
            return {
              content: [{ type: 'text', text: 'No sleep data available for the requested period.' }],
            };
          }

          let response = `# Sleep Analysis (Last ${days} Days)\n\n`;
          response += '| Date | Duration | Performance | Efficiency |\n';
          response += '|------|----------|-------------|------------|\n';

          for (const day of trends) {
            response += `| ${formatDate(day.date)} | ${day.total_sleep_hours?.toFixed(1) ?? 'N/A'}h | ${day.performance?.toFixed(0) ?? 'N/A'}% | ${day.efficiency?.toFixed(0) ?? 'N/A'}% |\n`;
          }

          // Calculate averages
          const avgDuration = trends.reduce((sum, d) => sum + (d.total_sleep_hours || 0), 0) / trends.length;
          const avgPerf = trends.reduce((sum, d) => sum + (d.performance || 0), 0) / trends.length;
          const avgEff = trends.reduce((sum, d) => sum + (d.efficiency || 0), 0) / trends.length;

          response += `\n## Averages\n`;
          response += `- **Duration**: ${avgDuration.toFixed(1)} hours\n`;
          response += `- **Performance**: ${avgPerf.toFixed(0)}%\n`;
          response += `- **Efficiency**: ${avgEff.toFixed(0)}%\n`;

          return { content: [{ type: 'text', text: response }] };
        }

        case 'get_strain_history': {
          const days = Math.min((args as any)?.days || 14, 90);
          const trends = db.getStrainTrends(days);

          if (trends.length === 0) {
            return {
              content: [{ type: 'text', text: 'No strain data available for the requested period.' }],
            };
          }

          let response = `# Strain History (Last ${days} Days)\n\n`;
          response += '| Date | Strain | Calories |\n';
          response += '|------|--------|----------|\n';

          for (const day of trends) {
            response += `| ${formatDate(day.date)} | ${day.strain?.toFixed(1) ?? 'N/A'} | ${day.calories ?? 'N/A'} kcal |\n`;
          }

          // Calculate averages
          const avgStrain = trends.reduce((sum, d) => sum + (d.strain || 0), 0) / trends.length;
          const avgCalories = trends.reduce((sum, d) => sum + (d.calories || 0), 0) / trends.length;

          response += `\n## Averages\n`;
          response += `- **Daily Strain**: ${avgStrain.toFixed(1)}\n`;
          response += `- **Daily Calories**: ${Math.round(avgCalories)} kcal\n`;

          return { content: [{ type: 'text', text: response }] };
        }

        case 'sync_data': {
          const tokens = db.getTokens();
          if (!tokens) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Not authenticated with Whoop. Please use get_auth_url to authorize first.',
                },
              ],
            };
          }
          client.setTokens(tokens);

          const full = (args as any)?.full || false;
          let stats;

          if (full) {
            stats = await sync.syncDays(90);
          } else {
            const result = await sync.smartSync();
            stats = result.stats;
            if (result.type === 'skip') {
              return {
                content: [{ type: 'text', text: 'Data is already up to date (synced within the last hour).' }],
              };
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: `Sync complete!\n- Cycles: ${stats?.cycles}\n- Recoveries: ${stats?.recoveries}\n- Sleeps: ${stats?.sleeps}\n- Workouts: ${stats?.workouts}`,
              },
            ],
          };
        }

        case 'get_auth_url': {
          const scopes = [
            'read:profile',
            'read:body_measurement',
            'read:cycles',
            'read:recovery',
            'read:sleep',
            'read:workout',
            'offline',
          ];
          const url = client.getAuthorizationUrl(scopes);

          return {
            content: [
              {
                type: 'text',
                text: `To authorize this app with Whoop:\n\n1. Visit this URL:\n${url}\n\n2. Log in and authorize the app\n3. You'll be redirected to a callback URL\n4. The authorization code will be automatically captured if the server is running\n\nNote: Make sure the redirect URI (${config.redirectUri}) matches what's configured in your Whoop app settings.`,
              },
            ],
          };
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// Start the server
async function main() {
  if (config.mode === 'stdio') {
    // Stdio mode for local development
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Whoop MCP server running on stdio');
  } else {
    // HTTP mode for remote hosting (Streamable HTTP transport)
    const app = express();

    // OAuth callback endpoint
    app.get('/callback', async (req: Request, res: Response) => {
      const code = req.query.code as string;
      if (!code) {
        res.status(400).send('Missing authorization code');
        return;
      }

      try {
        const tokens = await client.exchangeCodeForTokens(code);
        db.saveTokens(tokens);

        // Trigger initial sync
        console.log('Authorization successful, starting initial sync...');
        sync.syncDays(90).catch(console.error);

        res.send('Authorization successful! You can close this window and return to Claude.');
      } catch (error) {
        console.error('Token exchange failed:', error);
        res.status(500).send('Authorization failed. Please try again.');
      }
    });

    // Health check
    app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', authenticated: !!db.getTokens() });
    });

    // Store transports by session ID
    const transports = new Map<string, StreamableHTTPServerTransport>();

    // MCP endpoint using Streamable HTTP transport
    app.all('/mcp', async (req: Request, res: Response) => {
      // Get or create session ID
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (req.method === 'GET' || req.method === 'DELETE') {
        // Handle session management
        if (req.method === 'DELETE' && sessionId && transports.has(sessionId)) {
          const transport = transports.get(sessionId)!;
          await transport.close();
          transports.delete(sessionId);
          res.status(200).send('Session closed');
          return;
        }
      }

      // For POST requests, handle MCP messages
      if (req.method === 'POST') {
        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports.has(sessionId)) {
          // Reuse existing transport
          transport = transports.get(sessionId)!;
        } else {
          // Create new transport and server for this session
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (newSessionId) => {
              transports.set(newSessionId, transport);
              console.log(`New MCP session: ${newSessionId}`);
            },
          });

          const server = createMcpServer();
          await server.connect(transport);
        }

        // Handle the request
        await transport.handleRequest(req, res);
        return;
      }

      res.status(405).send('Method not allowed');
    });

    // Legacy SSE endpoint for backwards compatibility
    app.get('/sse', (req: Request, res: Response) => {
      res.status(410).send('SSE endpoint deprecated. Use /mcp with Streamable HTTP transport.');
    });

    app.listen(config.port, '0.0.0.0', () => {
      console.log(`Whoop MCP server running on http://0.0.0.0:${config.port}`);
      console.log(`MCP endpoint: http://localhost:${config.port}/mcp`);
      console.log(`Health check: http://localhost:${config.port}/health`);
      console.log(`OAuth callback: http://localhost:${config.port}/callback`);
    });
  }
}

main().catch(console.error);
