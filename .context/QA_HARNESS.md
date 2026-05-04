# MEOW QA Harness — Live Verification Loop

**Implements the long-term recommendation in `.context/QA_REVIEW.md` Section 7: "Build 'Output Validator' as part of MEOW kernel," "Schema-based output verification," "Visual diff capability."**

This document is canonical. It defines how meow verifies that work is correct — not just consistent. It extends `SOP.md §5` (Independent Verification) from a soft rule into a wired-in architecture.

---

## Why This Exists

MEOW today verifies code in two ways:

1. **`MissionReviewer.verify()`** — static checks: git diff vs goal, structural alignment, unfinished-work detection, logic coherence, SOP compliance, a Shadow Audit (independent LLM critique), and optional `npm test` execution. All of this is *text-on-text*. None of it touches the running app.
2. **`testCmd` execution inside `agent.chat()` and `MissionReviewer.verify()`** — runs `npm test` and parses stdout. This catches unit-level regressions but inherits the bias the `self-debugging-self-generated-tests.pdf` paper documents: when the same agent that wrote the code wrote (or ran) the tests, the test passing tells you the code matches the test, not that the work is correct.

The April 30 `QA_REVIEW.md` post-mortem demonstrated the cost: a PDF generation tool returned success, MEOW reported success, the file was 47 KB — and the content was a converter placeholder page. Static verification cannot catch this. **Live verification can.**

The same failure mode applies to MoFu. A MoFu mission can finish with all checks green, the build passing, the diff aligned to the goal — and the deployed app still broken: a route unwired, an env var missing, a Supabase RLS policy denying a query, a Postgres trigger rejecting an insert that the unit test mocked around. Until something opens `https://mofu-notebook.kitchen` (or a Vercel preview URL) in a real browser and exercises the user journey, "MISSION COHERENT" is a hypothesis, not a fact.

The research grounding for the architecture below sits in `/Users/jef.adriaenssens/workspace/01-projects/darwin/research/papers/`. Five papers are load-bearing:

- **`sol-ver-solver-verifier.pdf`** (arXiv:2502.14948, Meta/UCSD, Mar 2026) — establishes that solver and verifier should co-evolve, and that the verifier needs as much training signal as the solver. The mechanism: solver writes code, verifier writes tests, both filtered by execution against each other, both refined iteratively. Meow already has the solver half (Agent + EvolveHarness). It does not have the live-verifier half.
- **`reflexion-verbal-reinforcement-learning.pdf`** (arXiv:2303.11366, Shinn et al.) — failure signals become natural-language reflections, stored in an episodic memory buffer, retrieved on the next trial. 91% pass@1 on HumanEval vs GPT-4's 80%, no weight updates. EvolveHarness already injects the previous verdict as "system pressure" — that is Reflexion shape, but the verdicts today are prose blobs, not structured feedback.
- **`textgrad-automatic-differentiation.pdf`** (arXiv:2406.07496, Yuksekgonul et al., Stanford) — natural-language criticism backpropagated to *each component* of a compound AI system, not just the final output. PyTorch-style abstraction. 20% relative gain on LeetCode-Hard. The implication for meow: a structured `TextualGradient` per defect (selector, observed, expected, suggested-direction), not a wall of prose, is what enables the next agent turn to know which file to edit.
- **`self-debugging-self-generated-tests.pdf`** (arXiv:2501.12793, Peking University) — proves that *post-execution* self-debugging (look at pass/fail) suffers from self-test bias, while *in-execution* self-debugging (observe intermediate runtime states) mitigates it. For meow: the live verifier must interact with the running app — click, scroll, watch the network tab, read the console — not just check `vercel deploy` exit code.
- **`specification-gaming-reasoning-models.pdf`** (Bondarenko et al., Palisade Research, 2025) — reasoning models hack benchmarks by default. Meow's BrowserOS QA agent must be summoned with no access to the codebase or the test suite — only the deployed URL and the acceptance criteria. Architectural separation is the mechanism.

`promptbreeder-self-improvement.pdf` (arXiv:2309.16797, DeepMind) is a phase-2 input. We are explicitly **not** building strategy mutation on day one. We are building the telemetry that Promptbreeder needs. See §7 below.

---

## What Already Exists in Meow (Reuse, Don't Duplicate)

The instinct on first reading the QA problem is to invent a new orchestrator. Meow already has every primitive needed except the live-verification leg itself.

| Capability | File | Status |
|---|---|---|
| Sol-Ver outer loop (agent → review → retry with verdict as system pressure) | `src/agent/evolve.ts` (`EvolveHarness.execute`) | Built |
| Static verification (diff alignment, unfinished-work, logic coherence, SOP, Shadow Audit, testCmd) | `src/agent/mission_reviewer.ts` (`MissionReviewer.verify`) | Built |
| Architecturally-separated critique pass | `mission_reviewer.ts:108` (`shadowCritique` LLM call) | Built |
| Specialist swarm spawning | `src/agent/summoner.ts` (`summon`, `summonAsync`, `summonParallel`) | Built |
| Vercel preview deploy + auto-public (SSO disable) | `tmp/companies/mofu-notebook/.agents/skills/deploy-to-vercel/SKILL.md` (Vercel v3.0.0) | **Built and battle-tested** |
| BrowserOS MCP (navigate / get_page_content / take_snapshot / click / fill / scroll / take_screenshot) | BrowserOS MCP server (now installed and working as of 2026-05-04) | **Built and live** |
| BrowserOS specialist routing | `summoner.ts:148` (`SPECIALISTS["claude-browseros"]`), `src/agent/browseros.ts` (`BrowserOSAgent`) | Built — this is the canonical browser surface for QA |
| Mission registry, heartbeat, entanglement | `src/kernel/kernel.ts` (`MeowKernel`) | Built |
| Persistent recall + reflection storage | `src/agent/quantum_memory.ts` (`QuantumMemory.store`) | Built |
| MoFu deployment surface | `tmp/companies/mofu-notebook/{vercel.json,.vercel/project.json}` | Live; deployed at `https://mofu-notebook.kitchen` |
| MoFu target routing in `summon()` | `summoner.ts:316-318` | Built but stale path |

What is **not** built: a `LiveVerifier` class that takes a preview URL plus acceptance criteria and returns a structured verdict; a `TextualGradient` type; a hook in `EvolveHarness` to run the live verifier after the static one passes; a telemetry write that captures which QA strategy caught which class of defect; a thin TypeScript wrapper to invoke the existing `deploy-to-vercel` skill from `EvolveHarness`.

**No new deploy skill needs to be authored.** The existing `deploy-to-vercel` skill is canonical and handles the SSO-protection edge case (Vercel previews default to SSO-blocked; the skill PATCHes the project via Vercel API to make previews public). Reusing it preserves all that hard-won correctness.

---

## The Architecture (MECE)

The new harness is one method call inserted into the existing `EvolveHarness.execute()` loop. Static verification stays where it is. Live verification is its own leg. Both are mutually exclusive in scope and collectively exhaustive of "is this work correct?" — static checks the artefact, live checks reality.

```
EvolveHarness.execute(goal):
    for iteration in 1..maxIterations:
        agent.chat(goal | feedback)              ← Solver turn (existing)
        v_static = MissionReviewer.verify(goal)  ← Static leg (existing)
        if v_static.coherent:
            if isLiveVerifiable(targetDir):       ← Scope gate (new)
                preview_url = deploySkill(targetDir)            ← Vercel deploy (new skill)
                v_live = LiveVerifier.verify(goal,              ← Live leg (new)
                                             preview_url,
                                             acceptanceCriteria)
                writeTelemetry(v_live)                           ← Promptbreeder substrate (new)
                if v_live.passed:
                    return SUCCESS
                feedback = formatGradients(v_live.defects)       ← Reflexion injection (new)
                continue
            return SUCCESS                       ← Non-deployable missions stop here
        feedback = v_static.verdict
        continue
    return FAILED_AFTER_MAX_ITERATIONS
```

`isLiveVerifiable(targetDir)` is deliberately conservative on day one: it returns true only when `targetDir === /Users/jef.adriaenssens/meow/tmp/companies/mofu-notebook`. Generalising to "any directory containing `vercel.json`" is a phase-1.5 widening once the MoFu loop is stable.

---

## Components To Build

### 1. Reuse the existing `deploy-to-vercel` skill (no new skill authored)

The Vercel-authored skill at `tmp/companies/mofu-notebook/.agents/skills/deploy-to-vercel/SKILL.md` (v3.0.0) is canonical. It handles project-state detection (linked vs unlinked, has-remote vs no-remote, CLI authed vs not), picks the correct deploy method, retrieves the preview URL via `vercel ls --format json`, and crucially **auto-disables Vercel SSO protection** for previews when blocked (which happens by default — without this fix, every preview URL returns 401 to the QA agent).

Wiring: `LiveVerifier` does **not** re-implement deploy. It calls into the skill via a small TypeScript wrapper — `src/agent/deploy_runner.ts` — that spawns a `summon('claude', ctx)` with `cwd` set to the target dir (same routing pattern as `summoner.ts:316-318`). The spawned Claude Code reads the existing `.agents/skills/deploy-to-vercel/SKILL.md`, executes it, and returns the parsed preview URL via stdout.

The wrapper's only responsibilities: pass `cwd=mofuDir` and a tight goal ("Deploy this workspace to Vercel as a preview, return the public preview URL on stdout in a line matching `PREVIEW_URL=https://...`"); parse that line out of the stdout; surface failures cleanly. ~40 lines of TypeScript, no new skill markdown.

### 2. `src/agent/live_verifier.ts`

A new sibling class to `MissionReviewer`. Single responsibility: take a goal, a preview URL, and acceptance criteria; return a `LiveVerdict`. Internally it invokes the existing `summon('claude-browseros', ctx)` specialist (defined at `summoner.ts:148`), with `cwd=mofuDir` and a strict QA-only system prompt that forbids touching any source file.

Crucially, the spawned QA agent is given **only**:
- The preview URL
- The acceptance criteria (parsed from the mission goal or a `.context/MISSION.md` style file)
- The QA strategy prompt (versioned, see §5)
- The BrowserOS MCP tool surface: `mcp__browseros__new_page`, `mcp__browseros__new_hidden_page`, `mcp__browseros__get_page_content`, `mcp__browseros__take_snapshot`, `mcp__browseros__click`, `mcp__browseros__fill`, `mcp__browseros__scroll`, `mcp__browseros__take_screenshot` (and any other MCP tools the BrowserOS server exposes — the strategy prompt should be tool-list-discovered, not hard-coded)

The QA agent is given **none of**:
- The codebase contents
- The diff
- The test suite
- Any prior agent's reasoning

The architectural-separation requirement from the specification-gaming paper is enforced two ways: (a) the spawned process is fresh (no shared message history with the solver Claude); (b) the QA strategy prompt explicitly forbids `Read`/`Edit`/`Write`/`Bash` against any path inside the codebase, only BrowserOS MCP browser tools and a scoped `Write` to `scratch/qa-runs/<run_id>/` for screenshots and the verdict JSON.

**Why BrowserOS:** This is the canonical browser surface in meow. The `claude-browseros` specialist in `summoner.ts:148-178` already exists with the right system prompt skeleton, the `BrowserOSAgent` class in `src/agent/browseros.ts` already exposes the right tool list, and the BrowserOS MCP server is now installed and working. Using it preserves architectural consistency with the rest of meow rather than introducing a parallel browser stack.

**Precheck note:** the existing `summon('claude-browseros')` precheck at `summoner.ts:355` runs `browseros-cli status`. If your install path is the BrowserOS MCP server only (no `browseros-cli` binary in PATH), update the precheck to verify the MCP server is reachable instead — e.g. via `claude mcp list | grep browseros` or by attempting a no-op MCP call. Decide based on what's actually wired; this is a one-line precheck change, not an architectural change.

### 3. New types in `src/types/verification.ts`

```typescript
// TextGRAD-shaped feedback. One per defect.
export interface TextualGradient {
  surface: 'dom' | 'network' | 'console' | 'visual' | 'auth' | 'data';
  locator: string;        // CSS selector, URL pattern, console line ref, page area
  observed: string;       // What the QA agent saw
  expected: string;       // What the acceptance criterion required
  direction: string;      // Natural-language fix direction, NOT prescribed code
  severity: 'blocker' | 'major' | 'minor';
  evidence_screenshot?: string; // path to screenshot in scratch/qa-runs/
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
  qa_strategy_id: string;     // strategy version that ran (telemetry hook)
  qa_duration_ms: number;
  console_errors: string[];
  network_failures: { url: string; status: number }[];
  timestamp: string;          // ISO-8601
}
```

The agent system prompt and the QA strategy prompt produce JSON conforming to this shape. Validation is strict — a malformed verdict is treated as `passed: false` with a synthetic blocker defect "QA agent returned malformed verdict."

### 4. `EvolveHarness` integration (`src/agent/evolve.ts`)

Add `liveVerifier: LiveVerifier` and `deployRunner: DeployRunner` to the constructor. After `lastReviewVerdict.includes("MISSION COHERENT")`, branch on `isLiveVerifiable(targetDir)`. On live activation: call `deployRunner.deploy(targetDir)` → preview URL → call `liveVerifier.verify(goal, previewUrl, acceptanceCriteria)`. On live failure, format defects into a single feedback string (one `TextualGradient` per paragraph, severity-sorted) and inject as the next iteration's `turnInput`. Reuse the existing system-pressure pattern at `evolve.ts:38-43` — do not invent new feedback machinery.

Edge case: if Vercel deploy itself fails, that is a blocker defect. The verdict synthesises one from the deploy error (reasonable since the existing `deploy-to-vercel` skill already returns clear error strings on auth/network/SSO issues) and returns `passed: false`.

### 5. The QA strategy prompt — versioned, telemetry-tracked

The prompt that drives the BrowserOS QA agent lives in `skills/live-qa/strategies/v1.md`. It includes:

- Acceptance-criterion-by-criterion walk-through instructions
- A defect-discovery checklist organised by surface (DOM, network, console, visual, auth, data)
- A strict "you may not edit any file" guardrail
- A required JSON output schema matching `LiveVerdict`

Every QA run records its `qa_strategy_id` (a hash of the strategy prompt body) into the telemetry log. Future strategies (`v2.md`, `v3.md`) co-exist; `LiveVerifier` selects which to run based on a config knob (`config.qa.strategy`, default `latest`).

This versioning is what enables Promptbreeder later. Without it, you cannot tell whether a defect class is being missed because of the prompt or because of the model. With it, you have a clean A/B substrate.

### 6. Telemetry: `memory/qa_telemetry.jsonl`

One line per QA run, append-only:

```jsonl
{"run_id":"...","mission_id":"...","target_dir":"...","preview_url":"...","qa_strategy_id":"v1-a8c1","passed":true,"acceptance_passed":4,"acceptance_total":4,"defects_count":0,"console_errors_count":0,"duration_ms":47213,"timestamp":"2026-05-04T..."}
```

`missed_defects` is **not** in the day-one schema. It will be backfilled later when a downstream signal (a user bug report, a Slack canvas, a follow-up mission) traces a defect back to a QA run that should have caught it. That backfill is the Promptbreeder fitness signal.

### 7. Promptbreeder is intentionally deferred

We are not building strategy mutation on day one. We are building the substrate Promptbreeder needs:
- Versioned strategies (§5)
- Telemetry per run (§6)
- A way to mark missed defects (deferred — needs a separate "post-mortem" surface)

Once `qa_telemetry.jsonl` has ≥20 runs across ≥3 distinct defect classes, a separate skill (`skills/qa-strategy-evolver/`) will read the log, identify which strategies catch which defect classes, generate variants of underperforming strategies via mutation prompts, and run a tournament. That is phase 2. Building it earlier risks evolving prompts blindly.

---

## Sequence: A MoFu Mission, End To End

1. Jef issues a goal to meow: "Add a 'cuisine' filter to the recipe browse page." Target dir: `tmp/companies/mofu-notebook`.
2. `EvolveHarness.execute(goal, ...)` begins.
3. Iteration 1, solver turn: `agent.chat(goal, runTests=true, testCmd='bun run check')`. Agent edits files via SEARCH/REPLACE. Build passes.
4. Iteration 1, static review: `MissionReviewer.verify(goal, testCmd, mofuDir)`. Diff alignment 0.6, no TODOs, no mock returns, Shadow Audit returns PASS, `bun run check` succeeds. Verdict: MISSION COHERENT.
5. `isLiveVerifiable(mofuDir)` → true. Live leg activates.
6. `vercel-deploy` skill runs in `mofuDir`. Stdout returns `https://mofu-notebook-git-feature-cuisine-filter-jef.vercel.app`.
7. `LiveVerifier.verify(goal, preview_url, acceptanceCriteria)` summons `claude-browseros` with the v1 strategy prompt. The QA specialist:
   - Loads the preview URL
   - Walks each acceptance criterion: opens the page, locates the cuisine filter, clicks it, verifies the recipe list filters
   - Captures screenshots into `scratch/qa-runs/<run_id>/`
   - Reads console errors and network failures
   - Returns a JSON `LiveVerdict`
8. The verdict has `passed: false`: the cuisine filter renders, but clicking "Italian" produces a 500 from the Supabase Edge Function. The defect is captured as:
   ```json
   {
     "surface": "network",
     "locator": "POST /functions/v1/filter-recipes?cuisine=italian",
     "observed": "HTTP 500 — column 'recipes.cuisine' does not exist",
     "expected": "HTTP 200 with filtered recipe array",
     "direction": "Schema migration appears missing — 'cuisine' column was added to the type but not to the Supabase table",
     "severity": "blocker"
   }
   ```
9. Telemetry line written to `memory/qa_telemetry.jsonl`.
10. Defect formatted as system pressure for iteration 2's `agent.chat` call. Solver edits the migration, build still passes.
11. Iteration 2: static passes again. Live re-runs. Filter works end-to-end. `passed: true`. EvolveHarness returns success.

---

## Risk Register

| Risk | Mitigation |
|---|---|
| Vercel preview URL takes >2 min to be ready post-deploy | `LiveVerifier` polls the URL until 200 or 90 s timeout, with the QA agent only spawning after readiness |
| QA agent finds defects in features outside the goal scope ("noisy QA") | Strategy prompt explicitly scopes verification to the goal's acceptance criteria; out-of-scope defects logged but not feedback-injected |
| Specification gaming by the QA agent itself (e.g., reporting passed without actually clicking) | Strategy prompt requires screenshot per criterion; `LiveVerifier` rejects verdicts where `evidence_screenshot` is missing for any `passed: true` criterion |
| Vercel token expiry / quota | Skill returns a hard error; EvolveHarness escalates to Jef rather than retrying |
| Telemetry growth | JSONL is append-only; rotate at 100 MB or 90 days, whichever first |
| Cost: every iteration deploys + spawns a fresh BrowserOS specialist | Live leg only runs after static passes (which already gates ~70% of iterations); deploys are free on Vercel hobby tier; Claude calls are the dominant cost — capped by the existing `maxIterations` |
| `claude-browseros` MCP server unavailable | `summon('claude-browseros')` already detects this (`summoner.ts:355-360`) and throws; `LiveVerifier` returns a synthetic infrastructure-defect verdict |

---

## What This Replaces / Updates

- `.context/QA_REVIEW.md §7 Long Term` — implements the three "Long Term" recommendations (Output Validator, schema-based output verification, visual diff capability) for the MoFu surface.
- `SOP.md §5 Independent Verification` — replaces the soft `summon | claude | [task]` recommendation with a wired-in pipeline. The SOP's intent stays the same; this document specifies how it actually runs.
- `summoner.ts:316-318` (stale MoFu path `/Users/jef.adriaenssens/workspace/01-projects/mofu-notebook`) — must be updated to `/Users/jef.adriaenssens/meow/tmp/companies/mofu-notebook` as part of this work.

It does not replace `MissionReviewer`. Static review stays. The two legs are MECE.

---

## Phasing

**Phase 1 — MoFu only (1–2 working days):** vercel-deploy skill, LiveVerifier class, types, EvolveHarness wiring, v1 strategy prompt, telemetry write, QA_REVIEW backlinking. Stale path fix in summoner.ts.

**Phase 1.5 — Generalisation (deferred until ≥10 successful MoFu runs):** widen `isLiveVerifiable` to "any target dir containing vercel.json"; surface acceptance criteria parsing for non-MoFu repos.

**Phase 2 — Strategy evolution (deferred until ≥20 telemetry entries spanning ≥3 defect classes):** missed-defects backfill mechanism, qa-strategy-evolver skill, mutation-prompt evolution, tournament selection.

---

## Acceptance Criteria for the Implementation Itself

The implementation work is itself a meow mission and must be live-verified the moment the loop exists (recursive verification — meow tests its own QA harness on a small MoFu change).

1. Running `EvolveHarness.execute("Add a label 'Vegetarian by default' under the MoFu hero", { targetDir: mofuDir })` produces a Vercel preview URL, a `LiveVerdict` with the new label visible in screenshots, and a telemetry line.
2. Deliberately introducing a regression (point the label at a non-existent string key) causes `LiveVerdict.passed === false` with at least one `TextualGradient` whose `surface === 'dom'` and `direction` references the missing string.
3. Disabling `VERCEL_TOKEN` produces a clean failure with a single infrastructure-class defect, not a stack trace.
4. The QA agent's system prompt cannot be retrieved from inside its own tool calls (architectural-separation check — it does not see the diff or the codebase).

---

*Author: meow architecture. Date: 2026-05-04. Companion docs: `SOP.md`, `QA_REVIEW.md`, `ARCHITECTURE.md`. Research basis: `~/workspace/01-projects/darwin/research/papers/{sol-ver,reflexion,textgrad,self-debugging-self-generated-tests,specification-gaming-reasoning-models}.pdf`.*
