// Cheap fee detection: poll the vault balance, count every increase as fees.
// One request per poll no matter how busy trading is. A drop means the creator claimed
// the vault; it becomes the new baseline (fees landing in that same interval are missed).
import { pollForever, type FeeEvent, type RpcClient } from './solanaWatcher';

export class BalanceFeeWatcher {
  constructor(private readonly rpc: RpcClient, private readonly wallet: string, private last: number | null,
    private readonly onFee: (e: FeeEvent) => void) {}

  get lastBalance() { return this.last; }

  async poll() {
    const { context, value } = await this.rpc.call<{ context: { slot: number }; value: number }>('getBalance', [this.wallet, { commitment: 'confirmed' }]);
    const previous = this.last;
    this.last = value;
    if (previous !== null && value > previous) {
      this.onFee({ signature: `balance:${this.wallet}:${context.slot}`, lamports: value - previous, slot: context.slot, blockTime: Math.floor(Date.now() / 1000) });
    }
  }

  start(intervalMs: number, log: (msg: string) => void = console.error) { return pollForever(() => this.poll(), intervalMs, (m) => log(`${this.wallet}: ${m}`)); }
}
