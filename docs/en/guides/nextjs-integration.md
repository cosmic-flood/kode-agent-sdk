# Next.js Integration Guide

This guide explains how to integrate KODE SDK into your Next.js project to build a Skills-based Q&A tool.

---

## Table of Contents

1. [Architecture Patterns](#architecture-patterns)
2. [Direct Integration Pattern](#direct-integration-pattern)
3. [Worker Microservice Pattern](#worker-microservice-pattern)
4. [Skills-Based Q&A Tool](#skills-based-qa-tool)
5. [Deployment Recommendations](#deployment-recommendations)

---

## Architecture Patterns

### Pattern Selection

Based on your deployment environment and scale requirements, there are three recommended integration patterns:

| Pattern | Use Case | Redis Required | Complexity |
|---------|----------|----------------|------------|
| **Direct Integration** | Small projects, < 10 concurrent users | No | Low |
| **Worker + In-Memory Queue** | Medium projects, < 100 concurrent users | No | Medium |
| **Worker + Redis** | Large projects, 100+ concurrent users | Yes | High |

### Key Principles

**KODE SDK Requires Long-Running Processes**
- ✅ **Can Run**: Standalone Node.js server, containers, VPS
- ❌ **Cannot Run**: Vercel Functions, Cloudflare Workers, and other stateless Serverless environments

**Next.js Adaptation Solutions**
```
Option 1: Direct Integration
Next.js (Self-hosted) + KODE SDK
└── Use AgentPool to manage multiple user Agents

Option 2: Hybrid Architecture (Recommended for Vercel)
Next.js (Vercel) ──message──> Worker Server
                    queue       └── KODE SDK
```

---

## Direct Integration Pattern

Suitable for self-hosted Next.js applications (non-Serverless).

### 1. Install Dependencies

```bash
npm install @shareai-lab/kode-sdk
```

### 2. Create Agent Runtime

Create `lib/agent-runtime.ts`:

```typescript
import {
  Agent,
  AgentPool,
  AgentTemplateRegistry,
  ToolRegistry,
  SandboxFactory,
  JSONStore,
  SqliteStore,
  builtin,
  SkillsManager,
  createSkillsTool,
} from '@shareai-lab/kode-sdk';

// Singleton Store (shared across all Agents)
let store: JSONStore | SqliteStore | null = null;
let templates: AgentTemplateRegistry | null = null;
let tools: ToolRegistry | null = null;
let pool: AgentPool | null = null;

export function getStore() {
  if (!store) {
    // Use JSONStore for development, SqliteStore for production
    store = process.env.NODE_ENV === 'production'
      ? new SqliteStore('./.kode/agents.db')
      : new JSONStore('./.kode');
  }
  return store;
}

export function getTemplateRegistry() {
  if (!templates) {
    templates = new AgentTemplateRegistry();
    
    // Register Skills Q&A template
    templates.register({
      id: 'qa-assistant',
      systemPrompt: `You are an intelligent Q&A assistant. You can use the skills tool to dynamically load skills to answer user questions.

When a user asks about a topic:
1. Check if there is a relevant skill available
2. Use the skills tool to load the corresponding skill
3. Answer the user's question based on the skill's guidance

You have the following tools:
- skills: Dynamically load and view skills
- fs_read: Read file contents
- fs_glob: Find files`,
      tools: ['skills', 'fs_read', 'fs_glob'],
      model: {
        provider: 'anthropic',
        modelId: process.env.ANTHROPIC_MODEL_ID || 'claude-sonnet-4-20250514',
      },
    });
  }
  return templates;
}

export function getToolRegistry() {
  if (!tools) {
    tools = new ToolRegistry();
    
    // Register file system tools
    for (const tool of builtin.fs()) {
      tools.register(tool.name, () => tool);
    }
    
    // Register Skills tool
    const skillsManager = new SkillsManager('./.skills');
    const skillsTool = createSkillsTool(skillsManager);
    tools.register('skills', () => skillsTool);
  }
  return tools;
}

export function getAgentPool() {
  if (!pool) {
    pool = new AgentPool({
      store: getStore(),
      templateRegistry: getTemplateRegistry(),
      toolRegistry: getToolRegistry(),
      sandboxFactory: new SandboxFactory(),
    });
  }
  return pool;
}

// Get or create user's Agent
export async function getOrCreateAgent(userId: string) {
  const pool = getAgentPool();
  const agentId = `user-${userId}`;
  
  let agent = pool.get(agentId);
  if (!agent) {
    const exists = await getStore().exists(agentId);
    if (exists) {
      agent = await pool.resume(agentId);
    } else {
      agent = await pool.spawn({
        agentId,
        templateId: 'qa-assistant',
      });
    }
  }
  
  return agent;
}
```

### 3. Create API Routes

#### App Router (Next.js 13+)

Create `app/api/chat/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateAgent } from '@/lib/agent-runtime';

export const runtime = 'nodejs'; // Ensure Node.js runtime

// POST: Send message
export async function POST(req: NextRequest) {
  try {
    const { userId, message } = await req.json();
    
    if (!userId || !message) {
      return NextResponse.json(
        { error: 'Missing userId or message' },
        { status: 400 }
      );
    }
    
    const agent = await getOrCreateAgent(userId);
    
    // Non-blocking send
    await agent.send(message);
    
    return NextResponse.json({ status: 'queued' });
  } catch (error) {
    console.error('Chat API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// GET: Subscribe to real-time event stream (SSE)
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get('userId');
  
  if (!userId) {
    return NextResponse.json(
      { error: 'Missing userId' },
      { status: 400 }
    );
  }
  
  const agent = await getOrCreateAgent(userId);
  
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      
      try {
        for await (const envelope of agent.subscribe(['progress'])) {
          const data = `data: ${JSON.stringify(envelope)}\n\n`;
          controller.enqueue(encoder.encode(data));
          
          if (envelope.event.type === 'done') {
            break;
          }
        }
      } catch (error) {
        console.error('SSE stream error:', error);
      } finally {
        controller.close();
      }
    },
  });
  
  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
```

#### Pages Router (Next.js 12 and earlier)

Create `pages/api/chat.ts`:

```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import { getOrCreateAgent } from '@/lib/agent-runtime';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'POST') {
    const { userId, message } = req.body;
    
    if (!userId || !message) {
      return res.status(400).json({ error: 'Missing userId or message' });
    }
    
    try {
      const agent = await getOrCreateAgent(userId);
      await agent.send(message);
      return res.status(202).json({ status: 'queued' });
    } catch (error) {
      console.error('Chat error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
  
  if (req.method === 'GET') {
    const { userId, since } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }
    
    try {
      const agent = await getOrCreateAgent(userId as string);
      
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      const sinceOpt = since
        ? { seq: Number(since), timestamp: Date.now() }
        : undefined;
      
      const iterator = agent.subscribe(['progress'], { since: sinceOpt })[Symbol.asyncIterator]();
      
      for await (const envelope of { [Symbol.asyncIterator]: () => iterator }) {
        res.write(`data: ${JSON.stringify(envelope)}\n\n`);
        if (envelope.event.type === 'done') {
          break;
        }
      }
      
      res.end();
    } catch (error) {
      console.error('SSE error:', error);
      res.status(500).end();
    }
    
    return;
  }
  
  res.status(405).json({ error: 'Method not allowed' });
}
```

### 4. Frontend Integration

Create `components/ChatBox.tsx`:

```typescript
'use client';

import { useState, useEffect, useRef } from 'react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export default function ChatBox({ userId }: { userId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  
  useEffect(() => {
    // Connect to SSE stream
    const eventSource = new EventSource(`/api/chat?userId=${userId}`);
    eventSourceRef.current = eventSource;
    
    let currentMessage = '';
    
    eventSource.onmessage = (event) => {
      const envelope = JSON.parse(event.data);
      
      if (envelope.event.type === 'text_chunk') {
        currentMessage += envelope.event.delta;
        setMessages((prev) => {
          const newMessages = [...prev];
          if (newMessages[newMessages.length - 1]?.role === 'assistant') {
            newMessages[newMessages.length - 1].content = currentMessage;
          } else {
            newMessages.push({ role: 'assistant', content: currentMessage });
          }
          return newMessages;
        });
      }
      
      if (envelope.event.type === 'done') {
        currentMessage = '';
        setIsLoading(false);
      }
    };
    
    eventSource.onerror = () => {
      console.error('SSE connection error');
      setIsLoading(false);
    };
    
    return () => {
      eventSource.close();
    };
  }, [userId]);
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!input.trim() || isLoading) return;
    
    const userMessage = input.trim();
    setInput('');
    setIsLoading(true);
    
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    
    try {
      await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, message: userMessage }),
      });
    } catch (error) {
      console.error('Send message error:', error);
      setIsLoading(false);
    }
  };
  
  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto p-4">
      <div className="flex-1 overflow-y-auto mb-4 space-y-4">
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`p-3 rounded-lg ${
              msg.role === 'user'
                ? 'bg-blue-100 ml-auto max-w-[80%]'
                : 'bg-gray-100 mr-auto max-w-[80%]'
            }`}
          >
            {msg.content}
          </div>
        ))}
        {isLoading && messages[messages.length - 1]?.role === 'user' && (
          <div className="bg-gray-100 p-3 rounded-lg mr-auto max-w-[80%]">
            <span className="animate-pulse">Thinking...</span>
          </div>
        )}
      </div>
      
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask me anything..."
          className="flex-1 px-4 py-2 border rounded-lg"
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={isLoading}
          className="px-6 py-2 bg-blue-500 text-white rounded-lg disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}
```

---

## Worker Microservice Pattern

Suitable for Serverless deployments like Vercel, or scenarios requiring large-scale concurrency.

### Architecture Diagram

```
Next.js (Vercel)         Worker Server
     |                        |
     v                        v
+----------+            +------------+
| API Route| ─message──> | KODE SDK   |
+----------+   queue      +------------+
     ^                        |
     |                        |
  Frontend SSE <────polling───+
```

### Solutions Without Redis

While Redis is the recommended production solution, you can also use alternatives:

| Solution | Use Case | Description |
|----------|----------|-------------|
| **Database Queue** | Small to medium scale | Use PostgreSQL/MySQL tables as message queue |
| **HTTP Polling** | Simple scenarios | Next.js API directly calls Worker HTTP endpoint |
| **Cloud Service Queue** | Cloud deployment | AWS SQS, Azure Queue, Google Pub/Sub |

### Example: Using Database Queue

#### Worker Server

Create a standalone Worker project `worker/index.ts`:

```typescript
import {
  Agent,
  AgentPool,
  PostgresStore,
  builtin,
  SkillsManager,
  createSkillsTool,
} from '@shareai-lab/kode-sdk';

// Create PostgreSQL Store
const store = await PostgresStore.create({
  host: process.env.PG_HOST!,
  port: 5432,
  database: 'kode_agents',
  user: process.env.PG_USER!,
  password: process.env.PG_PASSWORD!,
});

// Create Agent Pool
const pool = new AgentPool({
  store,
  templateRegistry: createTemplateRegistry(),
  toolRegistry: createToolRegistry(),
  sandboxFactory: new SandboxFactory(),
});

function createTemplateRegistry() {
  const registry = new AgentTemplateRegistry();
  registry.register({
    id: 'qa-assistant',
    systemPrompt: 'You are an intelligent Q&A assistant...',
    tools: ['skills', 'fs_read', 'fs_glob'],
    model: {
      provider: 'anthropic',
      modelId: process.env.ANTHROPIC_MODEL_ID || 'claude-sonnet-4-20250514',
    },
  });
  return registry;
}

function createToolRegistry() {
  const registry = new ToolRegistry();
  
  for (const tool of builtin.fs()) {
    registry.register(tool.name, () => tool);
  }
  
  const skillsManager = new SkillsManager('./.skills');
  const skillsTool = createSkillsTool(skillsManager);
  registry.register('skills', () => skillsTool);
  
  return registry;
}

// Message queue polling
async function pollMessages() {
  const db = await getDbConnection(); // Your database connection
  
  while (true) {
    try {
      // Get pending messages from queue table
      const messages = await db.query(`
        SELECT * FROM message_queue 
        WHERE status = 'pending' 
        ORDER BY created_at 
        LIMIT 10
        FOR UPDATE SKIP LOCKED
      `);
      
      for (const msg of messages.rows) {
        await processMessage(msg);
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      console.error('Poll error:', error);
    }
  }
}

async function processMessage(msg: any) {
  const { id, user_id, content } = msg;
  const agentId = `user-${user_id}`;
  
  try {
    // Get or create Agent
    let agent = pool.get(agentId);
    if (!agent) {
      const exists = await store.exists(agentId);
      if (exists) {
        agent = await pool.resume(agentId);
      } else {
        agent = await pool.spawn({
          agentId,
          templateId: 'qa-assistant',
        });
      }
    }
    
    // Process message
    await agent.send(content);
    
    // Mark as processed
    await db.query(
      'UPDATE message_queue SET status = $1 WHERE id = $2',
      ['processed', id]
    );
  } catch (error) {
    console.error('Process message error:', error);
    await db.query(
      'UPDATE message_queue SET status = $1, error = $2 WHERE id = $3',
      ['failed', error.message, id]
    );
  }
}

// Start Worker
pollMessages();
```

#### Next.js API Route

```typescript
// app/api/chat/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getDbConnection } from '@/lib/db';

export async function POST(req: NextRequest) {
  const { userId, message } = await req.json();
  
  const db = await getDbConnection();
  
  // Insert message into queue
  await db.query(
    'INSERT INTO message_queue (user_id, content, status) VALUES ($1, $2, $3)',
    [userId, message, 'pending']
  );
  
  return NextResponse.json({ status: 'queued' });
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get('userId');
  
  // Implement polling or WebSocket to get Agent output
  // Simplified here to read latest conversation history from database
  const db = await getDbConnection();
  const result = await db.query(
    'SELECT * FROM agent_messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
    [userId]
  );
  
  return NextResponse.json(result.rows);
}
```

### Redis Solution (Optional)

If your project already uses Redis, you can use it as a message queue:

```typescript
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

// Next.js API: Push message to Redis queue
await redis.lpush('agent-queue', JSON.stringify({
  userId,
  message,
  timestamp: Date.now(),
}));

// Worker: Consume messages from Redis queue
while (true) {
  const msg = await redis.brpop('agent-queue', 5);
  if (msg) {
    const [, data] = msg;
    const { userId, message } = JSON.parse(data);
    await processMessage(userId, message);
  }
}
```

---

## Skills-Based Q&A Tool

### Creating Skills

Create a `.skills` folder in your project root:

```bash
mkdir -p .skills/code-helper
```

Create `.skills/code-helper/SKILL.md`:

```markdown
<!-- skill: code-helper -->
<!-- version: 1.0.0 -->

# Code Helper Skill

This skill helps users understand and write code.

## Features

- Code review and optimization suggestions
- Explain code logic
- Generate code examples
- Fix common errors

## Usage

When a user asks code-related questions:

1. **Understand requirements**: First understand what the user wants to do
2. **Provide examples**: Give clear code examples
3. **Explain principles**: Explain how the code works
4. **Best practices**: Provide optimization suggestions

## Examples

User: "How to use useState in React?"

Answer:
\`\`\`typescript
import { useState } from 'react';

function Counter() {
  const [count, setCount] = useState(0);
  
  return (
    <button onClick={() => setCount(count + 1)}>
      Clicks: {count}
    </button>
  );
}
\`\`\`

Explanation: useState returns a state value and update function...
```

Create more Skills:

```bash
.skills/
├── code-helper/
│   └── SKILL.md
├── database-expert/
│   └── SKILL.md
└── api-design/
    └── SKILL.md
```

### Agent Auto-Loading Skills

When a user asks a question, the Agent automatically decides whether to load a skill:

```
User: "Help me optimize this SQL query"

Agent internal reasoning:
1. This is a database-related question
2. Let me load the database-expert skill

Agent calls tool:
skills(action='load', skill_name='database-expert')

Agent replies:
Based on the database expert skill's guidance, I suggest...
```

---

## Deployment Recommendations

### Self-Hosted (Recommended)

**Advantages**:
- Full control, no cold starts
- Simple architecture
- Predictable costs

**Deployment Options**:
1. **VPS/Cloud Instances**: Alibaba Cloud, Tencent Cloud, AWS EC2
2. **Container Platforms**: Docker + K8s
3. **PaaS**: Railway, Render, Fly.io

**Start Command**:
```bash
# Production environment
NODE_ENV=production npm run start

# Use PM2 for process management
pm2 start npm --name "nextjs-agent" -- start
```

### Vercel + Worker (Hybrid Architecture)

If you must deploy Next.js to Vercel:

1. **Deploy Next.js to Vercel**
   - Only handle API routes and frontend
   - Push messages to queue

2. **Deploy Worker to your own server**
   - Run KODE SDK
   - Process long-running Agent tasks

3. **Share PostgreSQL Database**
   - Use cloud database (Supabase, PlanetScale)
   - Use as message queue and Agent Store

### Environment Variables

Create `.env.local`:

```bash
# LLM Provider
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL_ID=claude-sonnet-4-20250514

# Database (optional, recommended for production)
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=kode_agents
PG_USER=your_user
PG_PASSWORD=your_password

# Redis (optional)
REDIS_URL=redis://localhost:6379

# Skills directory
SKILLS_DIR=./.skills

# Node environment
NODE_ENV=production
```

---

## FAQ

### Q: Can I run KODE SDK directly on Vercel?

A: Not recommended. Vercel Functions have execution time limits (10 seconds free, 60 seconds pro), while KODE SDK Agents may need to run longer. Use a hybrid architecture: deploy Next.js to Vercel and Workers to a platform that supports long-running processes.

### Q: Is Redis required?

A: No. Redis is the recommended production solution, but you can also:
- Use database tables as queues
- Use cloud service message queues (SQS, Pub/Sub)
- For small-scale applications, you can even run directly in Next.js (self-hosted mode)

### Q: How to limit users to specific Skills only?

A: Use whitelist configuration:

```typescript
const skillsManager = new SkillsManager('./.skills', [
  'code-helper',
  'database-expert',
  // Only these skills will be loaded
]);
```

### Q: Where is Agent state saved?

A: Depends on the Store you use:
- `JSONStore`: Saved in local file system
- `SqliteStore`: Saved in SQLite database file
- `PostgresStore`: Saved in PostgreSQL database

In a hybrid architecture, Worker and Next.js API should use the same PostgreSQL database.

### Q: How to implement multi-user isolation?

A: Create independent `agentId` for each user:

```typescript
const agentId = `user-${userId}`;
const agent = await getOrCreateAgent(userId);
```

Each user's conversation history and state are stored independently.

---

## Next Steps

- [Skills System Detailed Documentation](./skills.md)
- [Event System](./events.md)
- [Production Deployment Guide](../advanced/production.md)
- [Example Code](../../examples/)
