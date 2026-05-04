/**
 * LiveVerifier — QA leg for MEOW's QA harness.
 * Summons a browser-based QA specialist with ONLY the preview URL + acceptance
 * criteria. Cannot see the codebase, diff, or test suite.
 *
 * Target is ONLY: /Users/jef.adriaenssens/meow/tmp/companies/mofu-notebook
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";
import type {
  LiveVerdict,
  AcceptanceResult,
  TextualGradient,
  LiveVerifierConfig,
} from "../types/verification";

export const CANONICAL_TARGET = "/Users/jef.adriaenssens/meow/tmp/companies/mofu-notebook";

export function isLiveVerifiable(targetDir: string): boolean {
  return targetDir === CANONICAL_TARGET;
}

/**
 * Loads the v1 QA strategy prompt from skills/live-qa/strategies/v1.md
 */
function loadStrategy(strategyPath: string): string {
  return readFileSync(strategyPath, "utf-8");
}

/**
 * Parse acceptance criteria from a MISSION.md file in targetDir,
 * falling back to extracting goals from the free-text mission string.
 */
function parseAcceptanceCriteria(goal: string, targetDir: string): string {
  try {
    const missionPath = resolve(targetDir, ".context/MISSION.md");
    return readFileSync(missionPath, "utf-8");
  } catch {
    // Extract the core ask from the free-text goal
    return `Acceptance criteria for mission: ${goal}`;
  }
}

/**
 * Verify a deployed preview URL against the mission goal.
 * Spawns a fresh BrowserOS QA specialist with strict architectural separation.
 */
export async function verifyLive(
  goal: string,
  previewUrl: string,
  targetDir: string
): Promise<LiveVerdict> {
  const startMs = Date.now();
  const strategyPath = resolve(__dirname, "../../skills/live-qa/strategies/v1.md");
  const strategy = loadStrategy(strategyPath);
  const acceptance = parseAcceptanceCriteria(goal, targetDir);

  const qaPrompt = buildQAPrompt(goal, previewUrl, acceptance, strategy);

  // Spawn fresh QA specialist — no shared message history, no codebase access
  const cmd = `claude "${qaPrompt.replace(/"/g, '\\"')}" -p --dangerously-skip-permissions --permission-mode bypassPermissions`;

  let rawOutput = "";
  let exitCode = 0;

  try {
    rawOutput = execSync(cmd, {
      cwd: targetDir,
      env: { ...process.env },
      encoding: "utf-8",
      timeout: 120_000,
    });
  } catch (e: any) {
    exitCode = e.status || 1;
    rawOutput = e.stdout || "";
  }

  return parseVerdict(rawOutput, exitCode, startMs, previewUrl);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildQAPrompt(goal: string, previewUrl: string, acceptance: string, strategy: string): string {
  return `You are the QA Specialist for a deployed web app preview.

GOAL: ${goal}
PREVIEW_URL: ${previewUrl}
ACCEPTANCE CRITERIA: ${acceptance}

${strategy}

OUTPUT: Return a JSON object conforming to the LiveVerdict schema:
{
  "passed": boolean,
  "preview_url": string,
  "acceptance": [{"criterion": string, "passed": boolean, "observed": string, "evidence_screenshot": string}],
  "defects": [{"surface": string, "locator": string, "observed": string, "expected": string, "direction": string, "severity": string}],
  "qa_strategy_id": string,
  "qa_duration_ms": number,
  "console_errors": string[],
  "network_failures": [{"url": string, "status": number}],
  "timestamp": string
}

No code. No edits. Only browser interaction via the BrowserOS MCP tools.`;
}

interface RawQAOutput {
  passed: boolean;
  preview_url: string;
  acceptance: AcceptanceResult[];
  defects: TextualGradient[];
  qa_strategy_id: string;
  qa_duration_ms: number;
  console_errors: string[];
  network_failures: { url: string; status: number }[];
  timestamp: string;
}

function parseVerdict(raw: string, exitCode: number, startMs: number, previewUrl: string): LiveVerdict {
  // Extract JSON block from output
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return buildSyntheticDefect(
      "blocker",
      "qa_agent_returned_unparseable_output",
      `QA agent exit ${exitCode}; no JSON verdict found. Output: ${raw.slice(0, 200)}`,
      "A valid LiveVerdict JSON block was not returned. This is a QA infrastructure failure.",
      previewUrl,
      Date.now() - startMs
    );
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as RawQAOutput;

    // Validate required fields
    if (typeof parsed.passed !== "boolean" || !parsed.preview_url) {
      return buildSyntheticDefect(
        "blocker",
        "qa_agent_returned_malformed_verdict",
        JSON.stringify(parsed).slice(0, 200),
        "LiveVerdict missing 'passed' or 'preview_url' fields. Treating as failure.",
        previewUrl,
        Date.now() - startMs
      );
    }

    return {
      ...parsed,
      qa_duration_ms: parsed.qa_duration_ms || (Date.now() - startMs),
    };
  } catch {
    return buildSyntheticDefect(
      "blocker",
      "qa_agent_returned_invalid_json",
      raw.slice(0, 200),
      "QA agent returned malformed JSON. Treating as failure.",
      previewUrl,
      Date.now() - startMs
    );
  }
}

function buildSyntheticDefect(
  severity: TextualGradient["severity"],
  locator: string,
  observed: string,
  direction: string,
  previewUrl: string,
  durationMs: number
): LiveVerdict {
  return {
    passed: false,
    preview_url: previewUrl,
    acceptance: [],
    defects: [{ surface: "infrastructure", locator, observed, expected: "valid verdict", direction, severity }],
    qa_strategy_id: "v1-synthetic",
    qa_duration_ms: durationMs,
    console_errors: [],
    network_failures: [],
    timestamp: new Date().toISOString(),
  };
}

export function formatGradients(verdict: LiveVerdict): string {
  const sorted = [...verdict.defects].sort((a, b) => {
    const order = { blocker: 0, major: 1, minor: 2 };
    return order[a.severity] - order[b.severity];
  });

  return sorted
    .map(d => `[${d.severity.toUpperCase()}] ${d.direction}`)
    .join("\n");
}