import { join } from 'node:path';

export interface Config {
  port: number; host: string; adminToken: string | null; feeMint: string | null; feeToken: string | null; perAction: number; capSeconds: number; feeMode: 'balance' | 'transactions'; feeSource: 'mock' | 'solana'; rpcUrl: string; feeWallets: string[]; lamportsPerAttempt: number;
  mockFeeEveryMs: number; mockTotalLamports: number; pollMs: number; stateFile: string; brainDir: string; corsOrigin: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const feeSource = (env.FEE_SOURCE ?? 'mock') as Config['feeSource'];
  if (feeSource !== 'mock' && feeSource !== 'solana') throw new Error(`FEE_SOURCE must be mock or solana, got ${feeSource}`);
  // comma-separated: e.g. the pump.fun bonding-curve creator vault and the PumpSwap creator vault
  const feeWallets = (env.FEE_WALLET ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  // FEE_TOKEN finds the wallets itself (see pumpToken.ts), so only one of the two is needed
  if (feeSource === 'solana' && !feeWallets.length && !env.FEE_TOKEN?.trim()) throw new Error('FEE_SOURCE=solana needs FEE_TOKEN (a pump.fun coin) or FEE_WALLET (the address that receives the fees)');
  // balance: 1 getBalance per poll (cheap, default). transactions: per-trade exact, needs a paid RPC under load.
  // Default is balance polling: one request per wallet every few seconds, whatever the trading volume.
  // FEE_MINT asks for per-trade counting instead, which is exact per coin but costs a request per trade.
  const oneCoin = (env.FEE_MINT ?? '').trim();
  const feeMode = (env.FEE_MODE ?? (oneCoin ? 'transactions' : 'balance')) as Config['feeMode'];
  if (oneCoin && feeMode !== 'transactions') throw new Error('counting one coin needs FEE_MODE=transactions: a balance poll cannot tell which coin paid');
  if (feeMode !== 'balance' && feeMode !== 'transactions') throw new Error(`FEE_MODE must be balance or transactions, got ${feeMode}`);
  const sol = Number(env.SOL_PER_ATTEMPT ?? 0.001);
  if (!(sol > 0)) throw new Error('SOL_PER_ATTEMPT must be a positive number');
  return {
    port: Number(env.PORT ?? 8788), host: env.HOST ?? '0.0.0.0', adminToken: env.ADMIN_TOKEN?.trim() || null, feeMint: env.FEE_MINT?.trim() || null, feeToken: env.FEE_TOKEN?.trim() || null,
    capSeconds: Number(env.CAP_SECONDS ?? 180),
    perAction: Number(env.READOUT_PER_ACTION ?? 8), feeMode, feeSource, feeWallets, lamportsPerAttempt: Math.round(sol * 1e9),
    rpcUrl: env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
    mockFeeEveryMs: Number(env.MOCK_FEE_EVERY_MS ?? 4000), mockTotalLamports: env.MOCK_TOTAL_SOL ? Math.round(Number(env.MOCK_TOTAL_SOL) * 1e9) : Infinity, pollMs: Number(env.POLL_MS ?? (feeMode === 'balance' ? 5000 : 10000)),
    stateFile: env.STATE_FILE ?? join(process.cwd(), 'data', 'state.json'),
    brainDir: env.BRAIN_DIR ?? join(process.cwd(), 'brain'),
    corsOrigin: env.CORS_ORIGIN ?? '*'
  };
}
