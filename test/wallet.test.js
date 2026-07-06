import test from 'node:test';
import assert from 'node:assert/strict';

import { isValidSolanaAddress } from '../src/orchestrator/wallet.js';

test('accepts real Solana addresses', () => {
  for (const addr of [
    'So11111111111111111111111111111111111111112', // wrapped SOL
    '11111111111111111111111111111111', // system program
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC mint
    '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  ]) {
    assert.equal(isValidSolanaAddress(addr), true, addr);
  }
});

test('rejects typos and junk', () => {
  for (const bad of [
    'testkey_abc123',
    'not-a-wallet',
    '0OIl00000000000000000000000000000000', // invalid base58 chars
    '',
    'abc',
    null,
    undefined,
    12345,
  ]) {
    assert.equal(isValidSolanaAddress(bad), false, String(bad));
  }
});
