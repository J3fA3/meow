// Live Verification types for MEOW's QA harness

export interface DeployResult {
  url: string;
  statusCode: number;
  duration: number; // ms
  deployedAt: string;
  branch: string;
}

// TextGRAD-shaped feedback. One per defect.
export interface TextualGradient {
  surface: "dom" | "network" | "console" | "visual" | "auth" | "data" | "infrastructure";
  locator: string;        // CSS selector, URL pattern, console line ref, page area
  observed: string;       // What the QA agent saw
  expected: string;       // What the acceptance criterion required
  direction: string;      // Natural-language fix direction, NOT prescribed code
  severity: "blocker" | "major" | "minor";
  evidence_screenshot?: string;
}

export interface AcceptanceResult {
  criterion: string;
  passed: boolean;
  observed: string;
  evidence_screenshot?: string;
}

export interface LiveVerdict {
  passed: boolean;
  preview_url: string;
  acceptance: AcceptanceResult[];
  defects: TextualGradient[];
  qa_strategy_id: string;
  qa_duration_ms: number;
  console_errors: string[];
  network_failures: { url: string; status: number }[];
  timestamp: string; // ISO-8601
}

export interface VerificationStrategy {
  name: string;
  version: string;
  checks: VerificationCheck[];
}

export interface VerificationCheck {
  type: "health" | "ui" | "api" | "perf" | "security";
  label: string;
  fn: (url: string) => Promise<CheckResult>;
}

export interface CheckResult {
  pass: boolean;
  label: string;
  message?: string;
  duration?: number;
  details?: Record<string, unknown>;
}

export interface LiveVerificationReport {
  id: string;
  target: string;
  deployResult: DeployResult;
  checkResults: CheckResult[];
  overallPass: boolean;
  timestamp: string;
}

export interface LiveVerifierConfig {
  targetDir: string;
  strategies: string[];
  timeout: number; // ms per check
  concurrency: number;
}