/**
 * DeployRunner — invokes the canonical deploy-to-vercel skill for MoFu targets.
 * Does NOT re-implement deploy logic. Spawns a Claude Code specialist with
 * cwd set to the target dir; the specialist reads the existing skill at:
 *   tmp/companies/mofu-notebook/.agents/skills/deploy-to-vercel/SKILL.md
 *
 * The spawned process must return `PREVIEW_URL=https://...` on stdout.
 */

import { execSync } from "child_process";
import { DeployResult } from "../types/verification";

export interface DeployConfig {
  targetDir: string;
  token?: string; // defaults to Vercel CLI auth
}

export class DeployRunner {
  /**
   * Deploy targetDir to Vercel as a preview and return the public URL.
   * Throws on deploy failure with a clear error message.
   */
  async deploy(config: DeployConfig): Promise<DeployResult> {
    const startTime = Date.now();
    const branch = this.currentBranch(config.targetDir);

    // Build the deploy command — fires the skill via Claude Code specialist
    // The skill reads .agents/skills/deploy-to-vercel/SKILL.md and handles
    // project linking, SSO disable, preview URL retrieval.
    const deployGoal = `Deploy this workspace to Vercel as a preview deployment.
Output exactly one line on stdout: PREVIEW_URL=https://<url>
No other output. Return non-zero exit code on failure.`;

    let stdout = "";
    let exitCode = 0;

    try {
      stdout = execSync(
        `claude "${deployGoal.replace(/"/g, '\\"')}" -p --dangerously-skip-permissions --permission-mode bypassPermissions`,
        {
          cwd: config.targetDir,
          env: { ...process.env },
          encoding: "utf-8",
        }
      );
    } catch (e: any) {
      exitCode = e.status;
      stdout = e.stdout || "";
    }

    const urlMatch = stdout.match(/PREVIEW_URL=(https?:\/\/[^\s]+)/);
    if (!urlMatch) {
      throw new Error(`Deploy failed. Exit: ${exitCode}. Output: ${stdout.slice(0, 300)}`);
    }

    const previewUrl = urlMatch[1];

    // Poll until URL is ready (Vercel can take ~20s after deploy completes)
    const ready = await this.pollUntilReady(previewUrl, 90000);

    return {
      url: ready.url,
      statusCode: ready.statusCode,
      duration: Date.now() - startTime,
      deployedAt: new Date().toISOString(),
      branch,
    };
  }

  private currentBranch(targetDir: string): string {
    try {
      return execSync("git branch --show-current", { cwd: targetDir, encoding: "utf-8" }).trim();
    } catch {
      return "unknown";
    }
  }

  private async pollUntilReady(url: string, timeoutMs: number): Promise<{ url: string; statusCode: number }> {
    const deadline = Date.now() + timeoutMs;
    let statusCode = 0;

    while (Date.now() < deadline) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
        clearTimeout(t);
        statusCode = res.status;

        if (res.status === 200 || res.status === 301 || res.status === 302) {
          return { url: res.url || url, statusCode: res.status };
        }
      } catch {
        // still deploying
      }
      await new Promise(r => setTimeout(r, 3000));
    }

    return { url, statusCode };
  }
}