#!/usr/bin/env node
/**
 * One-time interactive login for the IEC collector.
 *
 * IEC requires an Israeli ID plus an SMS/email OTP — there is no way to do
 * this unattended inside the exporter's own poll loop, so it is a separate
 * command run once (and again whenever the refresh token eventually expires):
 *
 *   docker run --rm -it -v $(pwd)/data:/data aransh/israel-utility-exporter \
 *     node dist/electricity/login-cli.js --id 123456789
 *
 * The resulting token is written to the same DATA_DIR the running exporter
 * reads from, so nothing further is needed after this succeeds.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { IECLoginError, IecClient } from './iec-client.js';

function parseArgs(argv: string[]): { id?: string; tokenFile?: string } {
  const args: { id?: string; tokenFile?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--id' && argv[i + 1]) {
      args.id = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--token-file' && argv[i + 1]) {
      args.tokenFile = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const { id, tokenFile } = parseArgs(process.argv.slice(2));
  if (!id) {
    console.error('Usage: node dist/electricity/login-cli.js --id <israeli-id> [--token-file <path>]');
    console.error('If --token-file is omitted, ELECTRICITY_TOKEN_FILE (or $DATA_DIR/iec-token.json) is used.');
    process.exitCode = 1;
    return;
  }

  const dataDir = process.env.DATA_DIR ?? '/data';
  const path = tokenFile ?? process.env.ELECTRICITY_TOKEN_FILE ?? `${dataDir}/iec-token.json`;

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const client = new IecClient(id, { log: (msg) => console.log(msg) });
    console.log(`Requesting an OTP for Israeli ID ${id}...`);
    const factorType = await client.loginWithId();
    const otp = (await rl.question(`Enter the OTP code sent via ${factorType}: `)).trim();
    await client.verifyOtp(otp);
    await client.saveTokenToFile(path);
    console.log(`\nLogin successful. Token saved to ${path}.`);
    console.log('Restart the exporter (or start it, if this was the first setup) to pick it up.');
  } catch (error) {
    if (error instanceof IECLoginError) {
      console.error(`Login failed: ${error.message}`);
    } else {
      console.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

await main();
