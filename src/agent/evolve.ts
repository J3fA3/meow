import { Agent } from "./agent";
import { MissionReviewer } from "./mission_reviewer";
import { verifyLive, isLiveVerifiable, formatGradients, CANONICAL_TARGET } from "./live_verifier";
import { DeployRunner } from "./deploy_runner";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import pc from "picocolors";

export interface EvolveOptions {
  maxIterations: number;
  runTests: boolean;
  testCmd?: string;
  targetDir?: string;
  onStatus?: (status: string) => void;
}

export class EvolveHarness {
  private agent: Agent;
  private reviewer: MissionReviewer;
  private deployRunner: DeployRunner;

  constructor(agent: Agent) {
    this.agent = agent;
    this.reviewer = new MissionReviewer(agent);
    this.deployRunner = new DeployRunner();
  }

  /**
   * The Meta-Orchestration Loop.
   * Continuously iterates until the work is verified as "Done" and "Correct".
   * After static review passes, fires the live verification leg for MoFu targets.
   */
  public async execute(goal: string, options: EvolveOptions): Promise<string> {
    let iteration = 0;
    let isCoherent = false;
    let lastReviewVerdict = "";
    const targetDir = options.targetDir || CANONICAL_TARGET;

    console.log(pc.bold(pc.magenta(`\n🌀 [EVOLVE] Starting autonomous evolution loop for goal: ${goal}`)));

    while (iteration < options.maxIterations && !isCoherent) {
      iteration++;
      options.onStatus?.(`Iteration ${iteration}/${options.maxIterations}: Reasoning...`);

      // 1. Solver turn
      const turnInput = iteration === 1
        ? goal
        : `ATTENTION: Your previous attempt failed verification.
           VERDICT: ${lastReviewVerdict}
           REMAINING GOAL: ${goal}
           ACTION: Fix the logic gaps and unfinished work. DO NOT report success until ALL logic is implemented.`;

      await this.agent.chat(turnInput, options.runTests, options.testCmd, options.onStatus);

      // 2. Static verification (existing)
      options.onStatus?.(`Iteration ${iteration}: Verifying logic...`);
      lastReviewVerdict = await this.reviewer.verify(goal, options.testCmd);

      if (lastReviewVerdict.includes("MISSION COHERENT")) {
        // 3. Live verification leg — MoFu only
        if (isLiveVerifiable(targetDir)) {
          options.onStatus?.(`Iteration ${iteration}: Deploying preview...`);

          let previewUrl = "";
          let deployError = "";

          try {
            const deployResult = await this.deployRunner.deploy({ targetDir });
            previewUrl = deployResult.url;
          } catch (e: any) {
            deployError = e.message;
          }

          if (!previewUrl) {
            console.log(pc.red(`\n⚠️ [EVOLVE] Deploy failed: ${deployError}`));
            lastReviewVerdict = `DEPLOY FAILED: ${deployError}`;
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }

          options.onStatus?.(`Iteration ${iteration}: Live QA on ${previewUrl}...`);
          const verdict = await verifyLive(goal, previewUrl, targetDir);

          this.writeTelemetry(goal, previewUrl, verdict);

          if (verdict.passed) {
            isCoherent = true;
            console.log(pc.bold(pc.green(`\n✨ [EVOLVE] Goal verified live in ${iteration} iterations.`)));
            return `✅ Mission Complete (live verified).\n${lastReviewVerdict}`;
          }

          const feedback = formatGradients(verdict);
          lastReviewVerdict = feedback;
          console.log(pc.yellow(`\n⚠️ [EVOLVE] Live QA found defects (Iteration ${iteration}). Retrying...`));
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        isCoherent = true;
        console.log(pc.bold(pc.green(`\n✨ [EVOLVE] Goal achieved (static verified) in ${iteration} iterations.`)));
        return `✅ Mission Complete (static only — not live-verifiable).\n${lastReviewVerdict}`;
      } else {
        console.log(pc.yellow(`\n⚠️ [EVOLVE] Static verification failed (Iteration ${iteration}). Retrying...`));
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    return `❌ [EVOLVE] Failed after ${options.maxIterations} iterations.\nLast Review: ${lastReviewVerdict}`;
  }

  private writeTelemetry(goal: string, previewUrl: string, verdict: import("../types/verification").LiveVerdict) {
    try {
      const memDir = resolve(__dirname, "../../memory");
      if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });
      const logPath = resolve(memDir, "qa_telemetry.jsonl");

      const line = JSON.stringify({
        run_id: `qa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mission: goal.slice(0, 80),
        target_dir: CANONICAL_TARGET,
        preview_url: previewUrl,
        qa_strategy_id: verdict.qa_strategy_id,
        passed: verdict.passed,
        acceptance_passed: verdict.acceptance.filter(a => a.passed).length,
        acceptance_total: verdict.acceptance.length,
        defects_count: verdict.defects.length,
        console_errors_count: verdict.console_errors.length,
        duration_ms: verdict.qa_duration_ms,
        timestamp: verdict.timestamp,
      }) + "\n";

      writeFileSync(logPath, line, { flag: "a" });
    } catch {
      // Non-fatal
    }
  }
}