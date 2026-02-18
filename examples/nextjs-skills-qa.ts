// Next.js Skills Q&A Example
// This example demonstrates how to integrate KODE SDK in a Next.js project
// without requiring Redis, using direct integration pattern.

import './shared/load-env';

import {
  Agent,
  AgentPool,
  AgentTemplateRegistry,
  ToolRegistry,
  SandboxFactory,
  JSONStore,
  builtin,
  SkillsManager,
  createSkillsTool,
  type AgentDependencies,
} from '@shareai-lab/kode-sdk';

// ============================================================================
// Simulated Next.js Types (for standalone demo)
// ============================================================================

type NextApiRequest = {
  query: Record<string, string | string[]>;
  body: any;
  method?: string;
  on(event: 'close', listener: () => void): void;
};

type NextApiResponse = {
  setHeader(name: string, value: string): void;
  status(code: number): NextApiResponse;
  json(data: any): void;
  end(): void;
  write(chunk: string): void;
  flushHeaders?: () => void;
};

// ============================================================================
// Agent Runtime Setup (Singleton)
// ============================================================================

let dependencies: AgentDependencies | null = null;
let pool: AgentPool | null = null;

function getDependencies(): AgentDependencies {
  if (!dependencies) {
    const store = new JSONStore('./.kode-nextjs-demo');
    const templateRegistry = new AgentTemplateRegistry();
    const toolRegistry = new ToolRegistry();
    const sandboxFactory = new SandboxFactory();

    // Register Skills Q&A template
    templateRegistry.register({
      id: 'qa-assistant',
      systemPrompt: `You are an intelligent Q&A assistant that helps users by leveraging your skills.

When users ask questions:
1. First, check if there are relevant skills available using the skills tool
2. Load appropriate skills to enhance your knowledge
3. Provide comprehensive answers based on loaded skills
4. If no specific skill is needed, answer directly from your base knowledge

Available tools:
- skills: Load and manage skill modules (use action="list" to see available skills)
- fs_read: Read file contents
- fs_glob: Search for files
- bash: Execute commands (use with caution)

Example workflow:
User: "How do I set up a React component?"
1. Use skills tool to check for 'react-helper' or similar skills
2. Load the skill if available
3. Provide detailed guidance based on the skill's knowledge`,
      tools: ['skills', 'fs_read', 'fs_glob', 'bash'],
      model: {
        provider: 'anthropic',
        modelId: process.env.ANTHROPIC_MODEL_ID || 'claude-sonnet-4-20250514',
      },
    });

    // Register built-in tools
    for (const tool of builtin.fs()) {
      toolRegistry.register(tool.name, () => tool);
    }
    for (const tool of builtin.bash()) {
      toolRegistry.register(tool.name, () => tool);
    }

    // Register Skills tool
    const skillsManager = new SkillsManager('./.skills');
    const skillsTool = createSkillsTool(skillsManager);
    toolRegistry.register('skills', () => skillsTool);

    dependencies = {
      store,
      templateRegistry,
      toolRegistry,
      sandboxFactory,
    };
  }

  return dependencies;
}

function getAgentPool(): AgentPool {
  if (!pool) {
    const deps = getDependencies();
    pool = new AgentPool(deps);
  }
  return pool;
}

async function getOrCreateAgent(userId: string): Promise<Agent> {
  const pool = getAgentPool();
  const agentId = `user-${userId}`;

  // Try to get existing agent from pool
  let agent = pool.get(agentId);

  if (!agent) {
    const deps = getDependencies();
    const exists = await deps.store.exists(agentId);

    if (exists) {
      // Resume from store
      agent = await pool.resume(agentId);
      console.log(`[Agent] Resumed agent for user: ${userId}`);
    } else {
      // Spawn new agent
      agent = await pool.spawn({
        agentId,
        templateId: 'qa-assistant',
      });
      console.log(`[Agent] Created new agent for user: ${userId}`);
    }
  }

  return agent;
}

// ============================================================================
// Next.js API Handler
// ============================================================================

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const userId = (req.query.userId as string) || 'demo-user';

  // POST: Send message to agent
  if (req.method === 'POST') {
    try {
      const { message } = req.body;

      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'Message is required' });
      }

      const agent = await getOrCreateAgent(userId);

      // Send message (non-blocking)
      await agent.send(message);

      console.log(`[API] Message queued for user: ${userId}`);
      return res.status(202).json({ status: 'queued' });
    } catch (error) {
      console.error('[API] POST error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // GET: Subscribe to real-time events (Server-Sent Events)
  if (req.method === 'GET') {
    try {
      const agent = await getOrCreateAgent(userId);

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      // Parse optional 'since' parameter for resuming
      const sinceParam = req.query.since;
      const since = sinceParam
        ? { seq: Number(sinceParam), timestamp: Date.now() }
        : undefined;

      // Subscribe to progress events
      const iterator = agent.subscribe(['progress', 'monitor'], { since })[Symbol.asyncIterator]();

      console.log(`[API] SSE stream started for user: ${userId}`);

      // Stream events
      (async () => {
        try {
          for await (const envelope of { [Symbol.asyncIterator]: () => iterator }) {
            // Send event to client
            res.write(`data: ${JSON.stringify(envelope)}\n\n`);

            // Log event type
            if (envelope.event.type === 'text_chunk') {
              process.stdout.write(envelope.event.delta);
            } else if (envelope.event.type === 'tool:start') {
              console.log(`\n[Tool] ${envelope.event.call.name} started`);
            } else if (envelope.event.type === 'tool:end') {
              console.log(`[Tool] ${envelope.event.call.name} completed`);
            } else if (envelope.event.type === 'done') {
              console.log('\n[Agent] Processing complete');
              break;
            }
          }
        } catch (error) {
          console.error('[API] SSE stream error:', error);
        } finally {
          res.end();
        }
      })();

      // Handle client disconnect
      req.on('close', () => {
        console.log(`[API] SSE stream closed for user: ${userId}`);
        iterator.return?.();
      });

      return;
    } catch (error) {
      console.error('[API] GET error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  // DELETE: Clear agent history
  if (req.method === 'DELETE') {
    try {
      const pool = getAgentPool();
      const agentId = `user-${userId}`;

      // Remove from pool
      pool.remove(agentId);

      // Delete from store
      const deps = getDependencies();
      const exists = await deps.store.exists(agentId);
      if (exists) {
        await deps.store.delete(agentId);
      }

      console.log(`[API] Agent deleted for user: ${userId}`);
      return res.status(200).json({ status: 'deleted' });
    } catch (error) {
      console.error('[API] DELETE error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}

// ============================================================================
// Demo Runner (for testing without actual Next.js)
// ============================================================================

if (require.main === module) {
  console.log('='.repeat(60));
  console.log('Next.js Skills Q&A Demo');
  console.log('='.repeat(60));
  console.log('');
  console.log('This example demonstrates:');
  console.log('- Direct KODE SDK integration in Next.js');
  console.log('- Skills-based Q&A system');
  console.log('- No Redis required');
  console.log('- AgentPool for multi-user support');
  console.log('');

  async function demo() {
    const userId = 'demo-user';

    console.log('1. Creating/resuming agent...');
    const agent = await getOrCreateAgent(userId);

    console.log('2. Subscribing to events...');
    const subscription = agent.subscribe(['progress']);

    (async () => {
      for await (const envelope of subscription) {
        if (envelope.event.type === 'text_chunk') {
          process.stdout.write(envelope.event.delta);
        } else if (envelope.event.type === 'tool:start') {
          console.log(`\n[Tool] ${envelope.event.call.name} started`);
        } else if (envelope.event.type === 'tool:end') {
          console.log(`[Tool] ${envelope.event.call.name} completed`);
        } else if (envelope.event.type === 'done') {
          console.log('\n\n✓ Done\n');
          break;
        }
      }
    })();

    console.log('3. Sending message...\n');
    await agent.send('List all available skills, then tell me what you can help me with.');

    console.log('\n4. Waiting for response...\n');
  }

  demo()
    .then(() => {
      console.log('Demo completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Demo error:', error);
      process.exit(1);
    });
}
