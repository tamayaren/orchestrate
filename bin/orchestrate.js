#!/usr/bin/env node
import { main } from '../src/orchestrate.js';

main().catch(error => {
  console.error(`[orchestrate] ERROR: ${error.message}`);
  process.exitCode = 1;
});
