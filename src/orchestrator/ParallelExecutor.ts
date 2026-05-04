// Worker pool execution engine

import { Task, TaskResult, TaskEvents } from './Task';
import { TaskQueue } from './TaskQueue';
import { FileCoordinator } from './FileCoordinator';
import { Agent, AgentConfig } from '../agent/agent';
import { McpManager } from '../agent/mcp';
import { SkillManager } from '../agent/skills';
import { DEFAULT_TOOLS } from '../types/tool';
import { MeowKernel } from '../kernel/kernel';
import { MeowDatabase } from '../kernel/database';
import { summonAsync } from '../agent/summoner';
import { getEigentClient } from '../agent/eigent_client';

export interface WorkerConfig {
  workerId: string;
  agentConfig: AgentConfig;
  mcpManager?: McpManager;
  skillManager?: SkillManager;
  kernel: MeowKernel;
  db: MeowDatabase;
}

export interface ExecutorConfig {
  maxWorkers: number;
  taskTimeoutMs: number;
  enableParallelTools: boolean;
}

export class ParallelExecutor {
  private queue: TaskQueue;
  private coordinator: FileCoordinator;
  private workers: Map<string, WorkerConfig> = new Map();
  private runningTasks: Map<string, { task: Task; workerId: string; timeout: NodeJS.Timeout }> = new Map();
  private executorConfig: ExecutorConfig;
  private taskEvents?: TaskEvents;

  constructor(
    queue: TaskQueue,
    coordinator: FileCoordinator,
    executorConfig: ExecutorConfig,
    taskEvents?: TaskEvents
  ) {
    this.queue = queue;
    this.coordinator = coordinator;
    this.executorConfig = executorConfig;
    this.taskEvents = taskEvents;
  }

  registerWorker(worker: WorkerConfig): void {
    this.workers.set(worker.workerId, worker);
  }

  async run(): Promise<Map<string, TaskResult>> {
    return new Promise((resolve) => {
      const results = new Map<string, TaskResult>();
      const running = this.runningTasks;
      let pendingCompletions = 0;
      let resolved = false;
      const safeResolve = () => {
        if (!resolved) {
          resolved = true;
          resolve(results);
        }
      };

      const handleTimeout = (taskId: string) => {
        const exec = running.get(taskId);
        if (!exec) return;

        this.coordinator.release(taskId);
        running.delete(taskId);

        const timeoutResult: TaskResult = {
          taskId,
          success: false,
          error: `Task timed out after ${exec.task.timeoutMs}ms`,
        };

        results.set(taskId, timeoutResult);
        this.queue.complete(taskId, timeoutResult);
        this.taskEvents?.onResult?.(taskId, timeoutResult);
        pendingCompletions--;
        if (pendingCompletions === 0) safeResolve();
      };

      const dispatch = () => {
        while (this.queue.canAcceptWork()) {
          const task = this.queue.dequeue();
          if (!task) break;
          const worker = this.selectWorker(task);
          if (!worker) {
            this.queue.cancel(task.id);
            this.queue.enqueue(task);
            break;
          }

          pendingCompletions++;
          const timeout = setTimeout(() => handleTimeout(task.id), task.timeoutMs || this.executorConfig.taskTimeoutMs);
          running.set(task.id, { task, workerId: worker.workerId, timeout });
          this.taskEvents?.onStatusChange?.(task.id, 'running');

          this.executeTask(task, worker).then((result: TaskResult) => {
            results.set(task.id, result);
            clearTimeout(timeout);
            running.delete(task.id);
            this.taskEvents?.onResult?.(task.id, result);
            pendingCompletions--;
            if (pendingCompletions === 0) safeResolve();
          }).catch((error: any) => {
            const failedResult: TaskResult = {
              taskId: task.id,
              success: false,
              error: error.message || String(error),
            };
            results.set(task.id, failedResult);
            clearTimeout(timeout);
            running.delete(task.id);
            this.taskEvents?.onResult?.(task.id, failedResult);
            pendingCompletions--;
            if (pendingCompletions === 0) safeResolve();
          });
        }
      };

      dispatch();
    });
  }

  private async executeTask(task: Task, worker: WorkerConfig): Promise<TaskResult> {
    try {
      const result = task.toolName
        ? await this.executeToolTask(task, worker)
        : await this.executeAgentTask(task, worker);

      this.coordinator.release(task.id);
      this.queue.complete(task.id, result);
      return result;
    } catch (error: any) {
      const failedResult: TaskResult = {
        taskId: task.id,
        success: false,
        error: error.message || String(error),
      };
      this.coordinator.release(task.id);
      this.queue.complete(task.id, failedResult);
      return failedResult;
    }
  }

  private async executeAgentTask(task: Task, worker: WorkerConfig): Promise<TaskResult> {
    // Route through specialist if routingHint is set
    if (task.routingHint && task.routingHint !== 'claude-code') {
      return this.executeRoutedTask(task, worker);
    }

    const agent = new Agent({
      ...worker.agentConfig,
      kernel: worker.kernel,
      db: worker.db
    });

    if (worker.skillManager) agent.skillManager = worker.skillManager;
    if (worker.mcpManager) agent.mcpManager = worker.mcpManager;
    task.requiredFiles?.forEach(f => agent.addFile(f));

    const output = await agent.chat(
      task.description,
      false,
      undefined,
      (status) => this.taskEvents?.onProgress?.(task.id, status)
    );

    const artifacts = agent.getEditedFiles().map(path => ({ path, operation: 'update' as const }));

    return { taskId: task.id, success: true, output, artifacts };
  }

  /**
   * Route task through a specialist agent (claude-browseros, claude-qa, eigent, etc.).
   * - "eigent": Uses native EigentClient for multi-agent workforce.
   *   Falls back to claude-browseros (BrowserOS MCP) if Eigent backend is unavailable.
   * - "claude-browseros" / "claude-qa": Spawns Claude Code subprocess with MCP tools.
   */
  private async executeRoutedTask(task: Task, worker: WorkerConfig): Promise<TaskResult> {
    const routingHint = task.routingHint!;

    console.log(`🔮 [ParallelExecutor] Routing "${task.description.slice(0, 60)}..." via ${routingHint}`);

    try {
      // "eigent" → try native EigentClient, fall back to claude-browseros
      if (routingHint === 'eigent') {
        return await this.executeViaEigent(task);
      }

      // All other specialists (claude-browseros, claude-qa, etc.)
      const result = await summonAsync(routingHint as any, {
        goal: task.description,
        files: task.requiredFiles || [],
        monolithBlueprint: undefined,
        kernel: worker.kernel,
      });

      return {
        taskId: task.id,
        success: result.success,
        output: result.output,
        artifacts: [],
      };
    } catch (error: any) {
      return {
        taskId: task.id,
        success: false,
        error: error.message || String(error),
        artifacts: [],
      };
    }
  }

  /**
   * Execute via native EigentClient (multi-agent workforce).
   * Auto-starts the backend if not running, falls back to claude-browseros on failure.
   */
  private async executeViaEigent(task: Task): Promise<TaskResult> {
    const client = getEigentClient();

    try {
      // ensureRunning() polls health and starts the backend if needed
      await client.ensureRunning();

      const response = await client.execute(task.description);

      return {
        taskId: task.id,
        success: response.success,
        output: response.output || response.error || "No output",
        artifacts: [],
      };
    } catch (e: any) {
      console.log(`⚠️  [EIGENT] Failed: ${e.message}. Falling back to BrowserOS MCP...`);
      const result = await summonAsync('claude-browseros' as any, {
        goal: task.description,
        files: task.requiredFiles || [],
        monolithBlueprint: undefined,
        kernel: undefined,
      });
      return {
        taskId: task.id,
        success: result.success,
        output: `[via BrowserOS MCP fallback]\n${result.output}`,
        artifacts: [],
      };
    }
  }

  private async executeToolTask(task: Task, worker: WorkerConfig): Promise<TaskResult> {
    const tool = DEFAULT_TOOLS.find(t => t.name === task.toolName);
    if (!tool) throw new Error(`Tool not found: ${task.toolName}`);

    const output = await tool.execute(task.toolArgs || '', undefined);
    return { taskId: task.id, success: true, output };
  }

  private selectWorker(task: Task): WorkerConfig | null {
    const available = Array.from(this.workers.values());
    if (available.length === 0) return null;

    const workerLoads = available.map(w => {
      let count = 0;
      for (const exec of this.runningTasks.values()) {
        if (exec.workerId === w.workerId) count++;
      }
      return { worker: w, load: count };
    });

    workerLoads.sort((a, b) => a.load - b.load);
    return workerLoads[0].load < this.executorConfig.maxWorkers ? workerLoads[0].worker : null;
  }

  async executeToolsParallel(
    tools: Array<{ name: string; args: string }>
  ): Promise<Array<{ name: string; result: string; error?: string }>> {
    const results = await Promise.allSettled(
      tools.map(async ({ name, args }) => {
        const tool = DEFAULT_TOOLS.find(t => t.name === name);
        if (!tool) throw new Error(`Tool not found: ${name}`);
        return { name, result: await tool.execute(args, undefined) };
      })
    );

    return results.map((r, i) => {
      if (r.status === 'fulfilled') return { name: tools[i].name, result: r.value.result };
      return { name: tools[i].name, result: '', error: String(r.reason) };
    });
  }
}