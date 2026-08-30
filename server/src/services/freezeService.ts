import NodeCache from "node-cache";

// Using NodeCache for persistence during runtime. In production, this would be in Redis/Postgres.
const cache = new NodeCache();

export interface FreezeState {
    isFrozen: boolean;
    reason?: string;
    frozenAt?: Date;
    updatedBy?: string;
}

export class FreezeService {
    private GLOBAL_KEY = "freeze:global";
    private PROTOCOL_PREFIX = "freeze:protocol:";
    private GLOBAL_LAST_FROZEN_KEY = "freeze:last:global";
    private PROTOCOL_LAST_FROZEN_PREFIX = "freeze:last:protocol:";

    async freezeGlobal(reason: string, actor: string): Promise<FreezeState> {
        const now = new Date();
        const state: FreezeState = {
            isFrozen: true,
            reason,
            frozenAt: now,
            updatedBy: actor,
        };
        cache.set(this.GLOBAL_KEY, state);
        cache.set(this.GLOBAL_LAST_FROZEN_KEY, now.toISOString());
        return state;
    }

    async resumeGlobal(actor: string): Promise<FreezeState> {
        const state: FreezeState = {
            isFrozen: false,
            updatedBy: actor,
        };
        cache.set(this.GLOBAL_KEY, state);
        return state;
    }

    async freezeProtocol(protocol: string, reason: string, actor: string): Promise<FreezeState> {
        const now = new Date();
        const state: FreezeState = {
            isFrozen: true,
            reason,
            frozenAt: now,
            updatedBy: actor,
        };
        cache.set(`${this.PROTOCOL_PREFIX}${protocol.toLowerCase()}`, state);
        cache.set(`${this.PROTOCOL_LAST_FROZEN_PREFIX}${protocol.toLowerCase()}`, now.toISOString());
        return state;
    }

    async resumeProtocol(protocol: string, actor: string): Promise<FreezeState> {
        const state: FreezeState = {
            isFrozen: false,
            updatedBy: actor,
        };
        cache.set(`${this.PROTOCOL_PREFIX}${protocol.toLowerCase()}`, state);
        return state;
    }

    isFrozen(protocol?: string): boolean {
        const globalState = cache.get<FreezeState>(this.GLOBAL_KEY);
        if (globalState?.isFrozen) return true;

        if (protocol) {
            const protocolState = cache.get<FreezeState>(`${this.PROTOCOL_PREFIX}${protocol.toLowerCase()}`);
            if (protocolState?.isFrozen) return true;
        }

        return false;
    }

    getFreezeStatus(protocol?: string): FreezeState {
        const globalState = cache.get<FreezeState>(this.GLOBAL_KEY);
        if (globalState?.isFrozen) return globalState;

        if (protocol) {
            const protocolState = cache.get<FreezeState>(`${this.PROTOCOL_PREFIX}${protocol.toLowerCase()}`);
            if (protocolState) return protocolState;
        }

        return { isFrozen: false };
    }

    /**
     * Returns the last time a freeze was enacted for the given scope.
     * Considers both global and protocol-specific freezes (returns the most recent).
     */
    getLastFreezeAt(protocol?: string): Date | null {
        let latest: Date | null = null;
        const globalRaw = cache.get<string>(this.GLOBAL_LAST_FROZEN_KEY);
        if (globalRaw) {
            const d = new Date(globalRaw);
            if (!isNaN(d.getTime())) latest = d;
        }
        if (protocol) {
            const protoRaw = cache.get<string>(`${this.PROTOCOL_LAST_FROZEN_PREFIX}${protocol.toLowerCase()}`);
            if (protoRaw) {
                const d = new Date(protoRaw);
                if (!isNaN(d.getTime())) {
                    if (!latest || d.getTime() > latest.getTime()) latest = d;
                }
            }
        }
        // If no protocol given, we only check global. If protocol given, we already considered global.
        return latest;
    }

    /**
     * Returns true if a quote created at `quotedAt` is invalidated by a freeze that happened afterwards.
     */
    isQuoteInvalidatedByFreeze(quotedAt: string | Date, protocol?: string): boolean {
        const lastFreeze = this.getLastFreezeAt(protocol);
        if (!lastFreeze) return false;
        const quotedMs = quotedAt instanceof Date ? quotedAt.getTime() : new Date(quotedAt).getTime();
        if (isNaN(quotedMs)) return false;
        return lastFreeze.getTime() > quotedMs;
    }

    /** For tests: clear all freeze state */
    clearAll(): void {
        cache.flushAll();
    }
}

export const freezeService = new FreezeService();
