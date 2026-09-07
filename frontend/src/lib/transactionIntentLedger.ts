export type IntentAction = 'deposit' | 'withdrawal' | 'zap' | 'reward_claim' | 'governance';

export type IntentPhase = 'preview' | 'signing' | 'submitted' | 'confirmed' | 'cancelled' | 'failed';

export interface TransactionIntent {
  id: string;
  walletAddress: string;
  action: IntentAction;
  targetContract: string;
  payloadHash: string;
  phase: IntentPhase;
  createdAt: number;
  updatedAt: number;
  txHash?: string;
  error?: string;
}

class TransactionIntentLedger {
  private getStorageKey(wallet: string): string {
    return `stellaryield_intents_${wallet}`;
  }

  public getIntents(wallet: string): TransactionIntent[] {
    try {
      const stored = localStorage.getItem(this.getStorageKey(wallet));
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  }

  public saveIntent(intent: TransactionIntent): void {
    const intents = this.getIntents(intent.walletAddress);
    const existingIdx = intents.findIndex((i) => i.id === intent.id);
    if (existingIdx >= 0) {
      intents[existingIdx] = intent;
    } else {
      intents.push(intent);
    }
    localStorage.setItem(this.getStorageKey(intent.walletAddress), JSON.stringify(intents));
  }

  public updatePhase(wallet: string, intentId: string, phase: IntentPhase, txHash?: string, error?: string): void {
    const intents = this.getIntents(wallet);
    const intent = intents.find((i) => i.id === intentId);
    if (intent) {
      intent.phase = phase;
      intent.updatedAt = Date.now();
      if (txHash) intent.txHash = txHash;
      if (error) intent.error = error;
      localStorage.setItem(this.getStorageKey(wallet), JSON.stringify(intents));
    }
  }
}

export const intentLedger = new TransactionIntentLedger();
