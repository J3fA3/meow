/**
 * Eigent Client
 *
 * Native integration with Eigent backend for multi-agent workforce coordination.
 * Eigent runs as a FastAPI server: uv run uvicorn main:api --port 5001
 * in ~/eigent/backend/
 *
 * Auto-starts the backend if not already running (polls /health first).
 *
 * API docs:
 * - Health: GET /health (root, no prefix)
 * - Chat:  POST /api/chat → SSE stream
 * - Tasks: PUT /api/task/{id}, POST /api/task/{id}/start, etc.
 */

import { spawn } from "child_process";
import { existsSync } from "fs";

export interface EigentConfig {
  endpoint: string;
  timeout?: number;
  apiKey?: string;
  modelType?: string;
}

export interface EigentResponse {
  success: boolean;
  taskId?: string;
  projectId?: string;
  output?: string;
  error?: string;
}

export class EigentClient {
  private endpoint: string;
  private timeout: number;
  private apiKey?: string;
  private modelType: string;
  private backendPath: string;

  constructor(config: EigentConfig) {
    this.endpoint = config.endpoint || "http://localhost:5001";
    this.timeout = config.timeout || 300000;
    this.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    this.modelType = config.modelType || process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";
    this.backendPath = process.env.EIGENT_BACKEND_PATH || "/Users/jef.adriaenssens/eigent/backend";
  }

  /**
   * Check if Eigent backend is running and healthy.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.endpoint}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Ensure Eigent backend is running. Starts it if not already up.
   * Idempotent — safe to call multiple times.
   */
  async ensureRunning(): Promise<void> {
    if (await this.healthCheck()) return;

    const mainPy = `${this.backendPath}/main.py`;
    if (!existsSync(mainPy)) {
      throw new Error(`Eigent backend not found at ${mainPy}`);
    }

    console.log(`🚀 [EIGENT] Starting backend: ${mainPy}`);

    // Try uv from backend venv first, then fall back to system uv
    const uvBin = existsSync(`${this.backendPath}/.venv/bin/uv`)
      ? `${this.backendPath}/.venv/bin/uv`
      : "uv";

    const child = spawn(uvBin, ["run", "uvicorn", "main:api", "--port", "5001"], {
      cwd: this.backendPath,
      detached: true,
      stdio: "pipe",
    });

    child.unref();
    child.stderr?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log(`  [eigent] ${line}`);
    });

    // Wait for backend to come up (poll health for up to 20s)
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await this.healthCheck()) {
        console.log(`✅ [EIGENT] Backend started and healthy`);
        return;
      }
    }

    throw new Error("Eigent backend failed to start within 20s");
  }

  /**
   * Execute a goal via Eigent's multi-agent workforce.
   * Auto-starts the backend if not running, then streams the SSE response.
   */
  async execute(goal: string): Promise<EigentResponse> {
    // Ensure backend is running first
    await this.ensureRunning();

    const projectId = `meow-${Date.now()}`;
    const taskId = `task-${Math.random().toString(36).slice(2, 8)}`;

    console.log(`\n📡 [EIGENT] Creating workforce for: ${goal.substring(0, 60)}...`);
    console.log(`   project=${projectId} task=${taskId}`);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.endpoint}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_id: taskId,
          project_id: projectId,
          question: goal,
          email: "meow@eigent.local",
          model_platform: "anthropic",
          model_type: this.modelType,
          api_key: this.apiKey,
          api_url: null,
          language: "en",
          browser_port: 9222,
          cdp_browsers: [],
          max_retries: 2,
          allow_local_system: false,
          installed_mcp: { mcpServers: {} },
          bun_mirror: "",
          uvx_mirror: "",
          env_path: null,
          summary_prompt: null,
          new_agents: [],
          extra_params: null,
          search_config: null,
          user_id: "meow",
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const error = await response.text();
        return { success: false, error: `Eigent API error ${response.status}: ${error}` };
      }

      const output = await this.parseSSEStream(response);

      return { success: true, projectId, taskId, output };
    } catch (e: any) {
      const msg = e.message || String(e);
      if (msg.includes("abort")) {
        return { success: false, error: `Eigent timeout after ${this.timeout}ms` };
      }
      return { success: false, error: `Eigent connection failed: ${msg}` };
    }
  }

  private async parseSSEStream(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    const steps: string[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const json = JSON.parse(line.slice(6));
              const step = json.step || json.data?.step || "";
              const content = json.data?.content || json.content || json.message || "";

              if (content) {
                steps.push(content);
                if (step) console.log(`  [${step}] ${String(content).substring(0, 80)}`);
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return steps.join("\n");
  }
}

let _client: EigentClient | null = null;

export function getEigentClient(): EigentClient {
  if (!_client) {
    _client = new EigentClient({
      endpoint: process.env.EIGENT_ENDPOINT || "http://localhost:5001",
      timeout: parseInt(process.env.EIGENT_TIMEOUT || "300000"),
    });
  }
  return _client;
}
