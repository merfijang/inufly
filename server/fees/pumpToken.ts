// Point the server at a pump.fun coin and it works out the rest: the coin's creator, and the two
// vaults their fees land in (the bonding curve one before migration, the PumpSwap one after).
import { PublicKey } from '@solana/web3.js';
import type { RpcClient } from './solanaWatcher';

const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');

/** BondingCurve layout: 8 discriminator + 5×u64 reserves + 1 complete flag, then the creator. */
const CREATOR_OFFSET = 49;

export interface PumpCoin { mint: string; creator: string; migrated: boolean; vaults: string[] }

/** The two fee vaults of a creator. Both are derived from the creator alone, so they also carry
 * the fees of every other coin that creator made — count one coin with the mint filter. */
export function creatorVaults(creator: PublicKey) {
  const [curveVault] = PublicKey.findProgramAddressSync([Buffer.from('creator-vault'), creator.toBuffer()], PUMP);
  const [authority] = PublicKey.findProgramAddressSync([Buffer.from('creator_vault'), creator.toBuffer()], PUMP_AMM);
  const [ammVault] = PublicKey.findProgramAddressSync([authority.toBuffer(), TOKEN_PROGRAM.toBuffer(), WSOL.toBuffer()], ATA_PROGRAM);
  return [curveVault.toBase58(), ammVault.toBase58()];
}

export async function resolvePumpCoin(rpc: RpcClient, mint: string): Promise<PumpCoin> {
  const mintKey = new PublicKey(mint);
  const [curve] = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mintKey.toBuffer()], PUMP);
  const res = await rpc.call<{ value: { data: [string, string] } | null }>('getAccountInfo', [curve.toBase58(), { encoding: 'base64', commitment: 'confirmed' }]);
  if (!res?.value) throw new Error(`${mint} has no pump.fun bonding curve — it is not a pump.fun coin. Set FEE_WALLET to the address its fees are paid to instead.`);
  const data = Buffer.from(res.value.data[0], 'base64');
  if (data.length < CREATOR_OFFSET + 32) throw new Error(`bonding curve of ${mint} is ${data.length} bytes, too short to hold a creator`);
  const creator = new PublicKey(data.subarray(CREATOR_OFFSET, CREATOR_OFFSET + 32));
  return { mint, creator: creator.toBase58(), migrated: data[CREATOR_OFFSET - 1] === 1, vaults: creatorVaults(creator) };
}
