# Next.js 集成指南

本指南介绍如何在 Next.js 项目中集成 KODE SDK，实现基于 Skills 的问答工具。

---

## 目录

1. [架构模式](#架构模式)
2. [直接集成模式](#直接集成模式)
3. [Worker 微服务模式](#worker-微服务模式)
4. [Skills 问答工具](#skills-问答工具)
5. [部署建议](#部署建议)

---

## 架构模式

### 模式选择

根据你的部署环境和规模需求，有三种推荐的集成模式：

| 模式 | 适用场景 | Redis 需求 | 复杂度 |
|------|---------|-----------|--------|
| **直接集成** | 小型项目，< 10 并发用户 | 否 | 低 |
| **Worker + 内存队列** | 中型项目，< 100 并发用户 | 否 | 中 |
| **Worker + Redis** | 大型项目，100+ 并发用户 | 是 | 高 |

### 关键原则

**KODE SDK 需要长时运行进程**
- ✅ **可以运行**: 独立的 Node.js 服务器、容器、VPS
- ❌ **不能运行**: Vercel Functions、Cloudflare Workers 等无状态 Serverless 环境

**Next.js 适配方案**
```
方案 1: 直接集成
Next.js (自托管) + KODE SDK
└── 使用 AgentPool 管理多个用户的 Agent

方案 2: 混合架构（推荐用于 Vercel 部署）
Next.js (Vercel) ──消息──> Worker 服务器
                    队列      └── KODE SDK
```

---

## 直接集成模式

适用于自托管的 Next.js 应用（非 Serverless）。

### 1. 安装依赖

```bash
npm install @shareai-lab/kode-sdk
```

### 2. 创建 Agent 运行时

创建 `lib/agent-runtime.ts`:

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

// 单例 Store（所有 Agent 共享）
let store: JSONStore | SqliteStore | null = null;
let templates: AgentTemplateRegistry | null = null;
let tools: ToolRegistry | null = null;
let pool: AgentPool | null = null;

export function getStore() {
  if (!store) {
    // 开发环境用 JSONStore，生产环境建议用 SqliteStore
    store = process.env.NODE_ENV === 'production'
      ? new SqliteStore('./.kode/agents.db')
      : new JSONStore('./.kode');
  }
  return store;
}

export function getTemplateRegistry() {
  if (!templates) {
    templates = new AgentTemplateRegistry();
    
    // 注册 Skills 问答模板
    templates.register({
      id: 'qa-assistant',
      systemPrompt: `你是一个智能问答助手。你可以使用 skills 工具来动态加载技能，以回答用户的问题。

当用户询问某个主题时：
1. 先检查是否有相关的 skill 可以加载
2. 使用 skills 工具加载对应的 skill
3. 根据 skill 的指导来回答用户的问题

你拥有以下工具：
- skills: 动态加载和查看技能
- fs_read: 读取文件内容
- fs_glob: 查找文件`,
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
    
    // 注册文件系统工具
    for (const tool of builtin.fs()) {
      tools.register(tool.name, () => tool);
    }
    
    // 注册 Skills 工具
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

// 获取或创建用户的 Agent
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

### 3. 创建 API 路由

#### App Router (Next.js 13+)

创建 `app/api/chat/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateAgent } from '@/lib/agent-runtime';

export const runtime = 'nodejs'; // 确保使用 Node.js 运行时

// POST: 发送消息
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
    
    // 非阻塞发送
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

// GET: 订阅实时事件流 (SSE)
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

#### Pages Router (Next.js 12 及更早版本)

创建 `pages/api/chat.ts`:

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

### 4. 前端集成

创建 `components/ChatBox.tsx`:

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
    // 连接 SSE 流
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
            <span className="animate-pulse">思考中...</span>
          </div>
        )}
      </div>
      
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="输入你的问题..."
          className="flex-1 px-4 py-2 border rounded-lg"
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={isLoading}
          className="px-6 py-2 bg-blue-500 text-white rounded-lg disabled:opacity-50"
        >
          发送
        </button>
      </form>
    </div>
  );
}
```

---

## Worker 微服务模式

适用于 Vercel 等 Serverless 部署，或需要扩展到大规模并发的场景。

### 架构图

```
Next.js (Vercel)         Worker 服务器
     |                        |
     v                        v
+----------+            +------------+
| API 路由  | ─消息队列─> | KODE SDK   |
+----------+            +------------+
     ^                        |
     |                        |
  前端 SSE <────轮询──────────+
```

### 无需 Redis 的方案

虽然 Redis 是生产环境的推荐选择，但也可以使用其他方案：

| 方案 | 适用场景 | 说明 |
|------|---------|------|
| **数据库队列** | 中小规模 | 使用 PostgreSQL/MySQL 的表作为消息队列 |
| **HTTP 轮询** | 简单场景 | Next.js API 直接调用 Worker HTTP 接口 |
| **云服务队列** | 云部署 | AWS SQS、Azure Queue、Google Pub/Sub |

### 示例：使用数据库队列

#### Worker 服务器

创建独立的 Worker 项目 `worker/index.ts`:

```typescript
import {
  Agent,
  AgentPool,
  PostgresStore,
  builtin,
  SkillsManager,
  createSkillsTool,
} from '@shareai-lab/kode-sdk';

// 创建 PostgreSQL Store
const store = await PostgresStore.create({
  host: process.env.PG_HOST!,
  port: 5432,
  database: 'kode_agents',
  user: process.env.PG_USER!,
  password: process.env.PG_PASSWORD!,
});

// 创建 Agent Pool
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
    systemPrompt: '你是一个智能问答助手...',
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

// 消息队列轮询
async function pollMessages() {
  const db = await getDbConnection(); // 你的数据库连接
  
  while (true) {
    try {
      // 从队列表中获取待处理消息
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
    // 获取或创建 Agent
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
    
    // 处理消息
    await agent.send(content);
    
    // 标记为已处理
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

// 启动 Worker
pollMessages();
```

#### Next.js API 路由

```typescript
// app/api/chat/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getDbConnection } from '@/lib/db';

export async function POST(req: NextRequest) {
  const { userId, message } = await req.json();
  
  const db = await getDbConnection();
  
  // 将消息插入队列
  await db.query(
    'INSERT INTO message_queue (user_id, content, status) VALUES ($1, $2, $3)',
    [userId, message, 'pending']
  );
  
  return NextResponse.json({ status: 'queued' });
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get('userId');
  
  // 实现轮询或 WebSocket 来获取 Agent 的输出
  // 这里简化为从数据库读取最新的对话历史
  const db = await getDbConnection();
  const result = await db.query(
    'SELECT * FROM agent_messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
    [userId]
  );
  
  return NextResponse.json(result.rows);
}
```

### 使用 Redis 的方案（可选）

如果你的项目已经使用 Redis，可以使用它作为消息队列：

```typescript
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

// Next.js API: 推送消息到 Redis 队列
await redis.lpush('agent-queue', JSON.stringify({
  userId,
  message,
  timestamp: Date.now(),
}));

// Worker: 从 Redis 队列消费消息
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

## Skills 问答工具

### 创建 Skills

在项目根目录创建 `.skills` 文件夹：

```bash
mkdir -p .skills/code-helper
```

创建 `.skills/code-helper/SKILL.md`:

```markdown
<!-- skill: code-helper -->
<!-- version: 1.0.0 -->

# 代码助手技能

这个技能帮助用户理解和编写代码。

## 功能

- 代码审查和优化建议
- 解释代码逻辑
- 生成代码示例
- 修复常见错误

## 使用方法

当用户询问代码相关问题时：

1. **理解需求**: 先了解用户想要做什么
2. **提供示例**: 给出清晰的代码示例
3. **解释原理**: 说明代码的工作原理
4. **最佳实践**: 提供优化建议

## 示例

用户: "如何在 React 中使用 useState?"

回答:
\`\`\`typescript
import { useState } from 'react';

function Counter() {
  const [count, setCount] = useState(0);
  
  return (
    <button onClick={() => setCount(count + 1)}>
      点击次数: {count}
    </button>
  );
}
\`\`\`

解释：useState 返回一个状态值和更新函数...
```

创建更多 Skills:

```bash
.skills/
├── code-helper/
│   └── SKILL.md
├── database-expert/
│   └── SKILL.md
└── api-design/
    └── SKILL.md
```

### Agent 自动加载 Skills

当用户提问时，Agent 会自动决定是否需要加载某个 skill：

```
用户: "帮我优化这段 SQL 查询"

Agent 内部思考:
1. 这是数据库相关的问题
2. 让我加载 database-expert skill

Agent 调用工具:
skills(action='load', skill_name='database-expert')

Agent 回复:
根据数据库专家技能的指导，我建议...
```

---

## 部署建议

### 自托管 (推荐)

**优点**:
- 完全控制，无冷启动
- 简单的架构
- 成本可控

**部署方案**:
1. **VPS/云主机**: 阿里云、腾讯云、AWS EC2
2. **容器平台**: Docker + K8s
3. **PaaS**: Railway、Render、Fly.io

**启动命令**:
```bash
# 生产环境
NODE_ENV=production npm run start

# 使用 PM2 守护进程
pm2 start npm --name "nextjs-agent" -- start
```

### Vercel + Worker (混合架构)

如果你必须使用 Vercel 部署 Next.js：

1. **Next.js 部署到 Vercel**
   - 只处理 API 路由和前端
   - 将消息推送到队列

2. **Worker 部署到自己的服务器**
   - 运行 KODE SDK
   - 处理长时运行的 Agent 任务

3. **共享 PostgreSQL 数据库**
   - 使用云数据库（Supabase、PlanetScale）
   - 作为消息队列和 Agent Store

### 环境变量

创建 `.env.local`:

```bash
# LLM Provider
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL_ID=claude-sonnet-4-20250514

# 数据库 (可选，生产环境推荐)
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=kode_agents
PG_USER=your_user
PG_PASSWORD=your_password

# Redis (可选)
REDIS_URL=redis://localhost:6379

# Skills 目录
SKILLS_DIR=./.skills

# Node 环境
NODE_ENV=production
```

---

## 常见问题

### Q: 可以在 Vercel 上直接运行 KODE SDK 吗？

A: 不建议。Vercel Functions 有执行时间限制（10 秒免费版，60 秒专业版），而 KODE SDK 的 Agent 可能需要运行更长时间。建议使用混合架构，Next.js 部署到 Vercel，Worker 部署到支持长时运行的平台。

### Q: 必须使用 Redis 吗？

A: 不是。Redis 是推荐的生产环境方案，但你也可以：
- 使用数据库表作为队列
- 使用云服务的消息队列（SQS、Pub/Sub）
- 对于小规模应用，甚至可以直接在 Next.js 中运行（自托管模式）

### Q: 如何限制用户只能使用特定的 Skills？

A: 使用白名单配置：

```typescript
const skillsManager = new SkillsManager('./.skills', [
  'code-helper',
  'database-expert',
  // 只有这些 skills 会被加载
]);
```

### Q: Agent 的状态保存在哪里？

A: 取决于你使用的 Store：
- `JSONStore`: 保存在本地文件系统
- `SqliteStore`: 保存在 SQLite 数据库文件
- `PostgresStore`: 保存在 PostgreSQL 数据库

在混合架构中，Worker 和 Next.js API 应该使用同一个 PostgreSQL 数据库。

### Q: 如何实现多用户隔离？

A: 为每个用户创建独立的 `agentId`:

```typescript
const agentId = `user-${userId}`;
const agent = await getOrCreateAgent(userId);
```

每个用户的对话历史和状态都是独立存储的。

---

## 下一步

- [Skills 系统详细文档](./skills.md)
- [事件系统](./events.md)
- [生产部署指南](../advanced/production.md)
- [示例代码](../../examples/)
