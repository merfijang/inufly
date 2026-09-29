import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { creatorVaults, resolvePumpCoin } from './pumpToken';
import type { RpcClient } from './solanaWatcher';

const CREATOR = 'AsNsKiwLBY4nx7kcJBw3XvdSwDss7Zobkm5KtTffeEi2';
const MINT = '5dLrnByarLiEamUE62PedLHBJJbZ63fJprqpAQohpump';

const curveAccount = (creator: string, migrated: boolean) => {
  const data = Buffer.alloc(151);
  data[48] = migrated ? 1 : 0;
  new PublicKey(creator).toBuffer().copy(data, 49);
  return { value: { data: [data.toString('base64'), 'base64'] } };
};

describe('pump.fun coin', () => {
  it('derives both creator vaults', () => {
    expect(creatorVaults(new PublicKey(CREATOR))).toEqual([
      'GE9LbYpMdnGPq2YVwYbyjgBLXK1N2whLA6azFsB1pSbM',
      '3PJf6tGKNr5DZ9NxpKaDeRcp1RA9A4KSt91KEc27DboM'
    ]);
  });

  it('reads the creator and migration state from the bonding curve', async () => {
    const rpc: RpcClient = { async call() { return curveAccount(CREATOR, true) as never; } };
    await expect(resolvePumpCoin(rpc, MINT)).resolves.toEqual({
      mint: MINT, creator: CREATOR, migrated: true,
      vaults: ['GE9LbYpMdnGPq2YVwYbyjgBLXK1N2whLA6azFsB1pSbM', '3PJf6tGKNr5DZ9NxpKaDeRcp1RA9A4KSt91KEc27DboM']
    });
  });

  it('says plainly when the coin is not from pump.fun', async () => {
    const rpc: RpcClient = { async call() { return { value: null } as never; } };
    await expect(resolvePumpCoin(rpc, MINT)).rejects.toThrow(/not a pump.fun coin/);
  });
});
