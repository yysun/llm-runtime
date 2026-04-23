import path from 'node:path';
import process from 'node:process';
import { config as loadDotEnv } from 'dotenv';
import {
  getGeminiE2EEnvHelp,
  parseProviderE2EFlags,
  printProviderE2EHelp,
  resolveGeminiE2ESelection,
  runProviderE2ESuite,
} from './support/llm-provider-e2e-support.js';

loadDotEnv({
  path: path.resolve(process.cwd(), '.env'),
  override: false,
  quiet: true,
});

async function main() {
  const flags = parseProviderE2EFlags(process.argv);
  if (flags.help) {
    printProviderE2EHelp('test:e2e:gemini', getGeminiE2EEnvHelp());
    return;
  }

  const selection = resolveGeminiE2ESelection(process.env);
  if (!selection && !flags.dryRun) {
    console.error('No Gemini provider configuration was found for the e2e suite.\n');
    console.error(getGeminiE2EEnvHelp());
    process.exitCode = 1;
    return;
  }

  await runProviderE2ESuite({
    selection: selection ?? {
      provider: 'google',
      model: 'dry-run-model',
      providers: {},
    },
    suiteLabel: 'LLM package Gemini e2e',
    dryRun: flags.dryRun,
  });
}

main().catch((error) => {
  console.error('gemini e2e status: FAIL');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});