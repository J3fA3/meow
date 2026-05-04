// LLM-based task decomposition

import { Task, TaskPriority, RoutingHint } from './Task';
import { Agent } from '../agent/agent';

export interface DecompositionOptions {
  maxSubtasks: number;
  enableImplicitParallel: boolean;
}

export class TaskDecomposer {
  private agent: Agent;
  private defaultOptions: DecompositionOptions = {
    maxSubtasks: 10,
    enableImplicitParallel: true,
  };

  constructor(agent: Agent) {
    this.agent = agent;
  }

  async decompose(
    userRequest: string,
    context: {
      availableFiles?: string[];
      existingSkills?: string[];
      mcpServers?: string[];
    },
    options?: Partial<DecompositionOptions>
  ): Promise<Task[]> {
    const opts = { ...this.defaultOptions, ...options };

    const decompositionPrompt = this.buildDecompositionPrompt(userRequest, context, opts);

    const response = await this.agent.callLLM(
      await this.agent.buildSystemPrompt(),
      [{ role: 'user', content: decompositionPrompt }]
    );

    return this.parseTasksFromResponse(response, userRequest);
  }

  private buildDecompositionPrompt(
    request: string,
    context: {
      availableFiles?: string[];
      existingSkills?: string[];
      mcpServers?: string[];
    },
    opts: DecompositionOptions
  ): string {
    return `You are a task decomposition specialist. Analyze the following user request and break it into independent subtasks that can be executed in parallel.

REQUEST: ${request}

CONTEXT:
- Available Files: ${context.availableFiles?.join(', ') || 'None specified'}
- Existing Skills: ${context.existingSkills?.join(', ') || 'None'}
- MCP Servers: ${context.mcpServers?.join(', ') || 'None'}

ROUTING HINTS (assign to tasks as needed):
- "claude-browseros": Use for web automation, QA verification, browser testing, screenshot capture, form filling, web scraping, cross-browser testing, visual regression, UI verification tasks
- "claude-qa": Use for unit testing, bug hunting, edge case analysis, documentation writing, test coverage analysis
- "eigent": Use for parallel multi-agent task execution, complex multi-step workflows requiring multiple specialized agents, and workforce-scale coordination
- "claude-code" (default): Use for code implementation, refactoring, debugging, feature development

CONSTRAINTS:
- Maximum ${opts.maxSubtasks} subtasks
- Each subtask must be independently executable
- Identify file access requirements for each subtask
- Mark dependencies between subtasks when they exist
- Tasks that modify the same file have a dependency relationship

Output format - JSON array of tasks:
[
  {
    "description": "Clear description of what this subtask does",
    "priority": "high|medium|low",
    "routingHint": "claude-browseros|claude-qa|claude-code|eigent",
    "dependencies": [{"taskId": "task-1", "required": true}],
    "requiredFiles": ["file1.ts", "file2.ts"],
    "producedFiles": [{"path": "file3.ts", "operation": "create"}],
    "reasoning": "Why this is independent/how it relates to other tasks and why this routingHint was chosen"
  }
]

JSON OUTPUT ONLY - no markdown, no explanation:`;
  }

  private parseTasksFromResponse(response: string, originalRequest: string): Task[] {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return [this.createTask(originalRequest, 'high', [])];
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.map((item: any, idx: number) =>
        this.createTask(
          item.description,
          item.priority || 'medium',
          (item.dependencies || []).map((d: any) => ({
            taskId: d.taskId,
            required: d.required ?? true,
          })),
          {
            requiredFiles: item.requiredFiles,
            producedFiles: item.producedFiles,
            routingHint: item.routingHint as RoutingHint | undefined,
          }
        )
      );
    } catch {
      return [this.createTask(originalRequest, 'high', [])];
    }
  }

  private createTask(
    description: string,
    priority: TaskPriority,
    dependencies: Task['dependencies'],
    options?: {
      requiredFiles?: string[];
      producedFiles?: Task['producedFiles'];
      routingHint?: RoutingHint;
    }
  ): Task {
    return {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      description,
      priority,
      dependencies,
      createdAt: Date.now(),
      maxRetries: 2,
      timeoutMs: 120000,
      status: 'pending',
      requiredFiles: options?.requiredFiles,
      producedFiles: options?.producedFiles,
      routingHint: options?.routingHint,
    };
  }

  decomposeSimple(taskList: string): Task[] {
    return taskList.split('/').map((desc, idx) => ({
      id: `task-simple-${idx}`,
      description: desc.trim(),
      priority: 'medium' as TaskPriority,
      dependencies: [] as Task['dependencies'],
      createdAt: Date.now(),
      maxRetries: 2,
      timeoutMs: 120000,
      status: 'pending' as const,
    }));
  }
}