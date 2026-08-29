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
    private LAST_GLOBAL_KEY = "freeze:last:global";
    private LAST_PROTOCOL_PREFIX = "freeze:last:protocol:";

    async freezeGlobal(reason: string, actor: string): Promise<FreezeState> {
        const now = new Date();
        const state: FreezeState = {
            isFrozen: true,
            reason,
            frozenAt: now,
            updatedBy: actor,
        };
        cache.set(this.GLOBAL_KEY, state);
        cache.set(this.LAST_GLOBAL_KEY, now);
        return state;
    }

    async resumeGlobal(actor: string): Promise<FreezeState> {
        const prev = cache.get<FreezeState>(this.GLOBAL_KEY);
        const state: FreezeState = {
            isFrozen: false,
            updatedBy: actor,
            frozenAt: prev?.frozenAt,
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
        const key = `${this.PROTOCOL_PREFIX}${protocol.toLowerCase()}`;
        const lastKey = `${this.LAST_PROTOCOL_PREFIX}${protocol.toLowerCase()}`;
        cache.set(key, state);
        cache.set(lastKey, now);
        return state;
    }

    async resumeProtocol(protocol: string, actor: string): Promise<FreezeState> {
        const key = `${this.PROTOCOL_PREFIX}${protocol.toLowerCase()}`;
        const prev = cache.get<FreezeState>(key);
        const state: FreezeState = {
            isFrozen: false,
            updatedBy: actor,
            frozenAt: prev?.frozenAt,
        };
        cache.set(key, state);
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

    getLastFrozenAt(protocol?: string): Date | undefined {
        if (protocol) {
            const lastProtocol = cache.get<Date>(`${this.LAST_PROTOCOL_PREFIX}${protocol.toLowerCase()}`);
            if (lastProtocol) return lastProtocol;
            const state = cache.get<FreezeState>(`${this.PROTOCOL_PREFIX}${protocol.toLowerCase()}`);
            if (state?.frozenAt) return state.frozenAt instanceof Date ? state.frozenAt : new Date(state.frozenAt);
        }
        const lastGlobal = cache.get<Date>(this.LAST_GLOBAL_KEY);
        if (lastGlobal) return lastGlobal;
        const globalState = cache.get<FreezeState>(this.GLOBAL_KEY);
        if (globalState?.frozenAt) return globalState.frozenAt instanceof Date ? globalState.frozenAt : new Date(globalState.frozenAt);
        return undefined;
    }

    wasFrozenAfter(quotedAt: string | Date, protocol?: string): boolean {
        const quoteMs = quotedAt instanceof Date ? quotedAt.getTime() : new Date(quotedAt).getTime();
        if (Number.isNaN(quoteMs)) return false;
        const globalFrozenAt = cache.get<Date>(this.LAST_GLOBAL_KEY);
        if (globalFrozenAt && globalFrozenAt.getTime() > quoteMs) return true;
        const globalState = cache.get<FreezeState>(this.GLOBAL_KEY);
        if (globalState?.frozenAt) {
            const t = globalState.frozenAt instanceof Date ? globalState.frozenAt.getTime() : new Date(globalState.frozenAt).getTime();
            if (!Number.isNaN(t) && t > quoteMs) return true;
        }
        if (protocol) {
            const lastProtocol = cache.get<Date>(`${this.LAST_PROTOCOL_PREFIX}${protocol.toLowerCase()}`);
            if (lastProtocol && lastProtocol.getTime() > quoteMs) return true;
            const state = cache.get<FreezeState>(`${this.PROTOCOL_PREFIX}${protocol.toLowerCase()}`);
            if (state?.frozenAt) {
                const t = state.frozenAt instanceof Date ? state.frozenAt.getTime() : new Date(state.frozenAt).getTime();
                if (!Number.isNaN(t) && t > quoteMs) return true;
            }
        }
        return false;
    }

    clearAll(): void {
        cache.flushAll();
    }
}

export const freezeService = new FreezeService();
