#!/usr/bin/env node
// MEOW - Lightweight AI Coding Agent
// Note: better-sqlite3 requires Node.js runtime (bun:sqlite doesn't support dynamic extensions)
// The bin entry in package.json uses a wrapper to invoke via node

import { config } from "./config/env";
import { Agent } from "./agent/agent";
import { createRepl } from "./cli/repl";
import { MeowDatabase } from "./kernel/database";
import { MeowKernel } from "./kernel/kernel";

async function main() {
  const db = new MeowDatabase();
  const kernel = new MeowKernel(db);
  kernel.start();

  const agent = new Agent({
    model: config.model,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    db,
    kernel
  });

  // Support for non-interactive command mode
  const command = process.argv.slice(2).join(" ");
  if (command) {
    // --evolve flag: run via EvolveHarness instead of single agent turn
    if (command.startsWith("--evolve ")) {
      const goal = command.slice("--evolve ".length);
      (agent as any)._targetDirForAudit = "/Users/jef.adriaenssens/meow/tmp/companies/mofu-notebook";
      console.log(`🤖 [MEOW] Evolving: ${goal}`);
      const { EvolveHarness } = await import("./agent/evolve");
      const harness = new EvolveHarness(agent);
      const result = await harness.execute(goal, { maxIterations: 3, runTests: true });
      console.log("\n" + result);
      console.log("\n✅ Evolve completed.");
      await kernel.shutdown();
      process.exit(0);
    }

    // Default target workspace for MissionReviewer audits is lotus project
    (agent as any)._targetDirForAudit = "/Users/jef.adriaenssens/meow/tmp/companies/lotus";
    console.log(`🤖 [MEOW] Executing command: ${command}`);
    const response = await agent.chat(command, false, undefined, (status) => {
      process.stdout.write(`\r${status}`);
    });
    console.log("\n" + response);
    console.log("\n✅ Command completed.");
    await kernel.shutdown();
    process.exit(0);
  }

  const repl = createRepl(agent);
  await repl.start();
}

main().catch(console.error);