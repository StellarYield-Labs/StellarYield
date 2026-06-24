/**
 * Vitest Setup - Mock browser APIs for Node.js environment
 */

// Mock localStorage
const localStorageMock = (() => {
    let store: Record<string, string> = {};

    return {
        getItem: (key: string) => store[key] || null,
        setItem: (key: string, value: string) => {
            store[key] = value.toString();
        },
        removeItem: (key: string) => {
            delete store[key];
        },
        clear: () => {
            store = {};
        },
    };
})();

// Make localStorage available globally in Node.js environment
if (typeof global !== "undefined" && !global.localStorage) {
    (global as any).localStorage = localStorageMock;
}

// Mock window.matchMedia — jsdom does not implement it
if (typeof window !== "undefined" && !window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: (query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
        }),
    });
}

// Mock ResizeObserver — jsdom does not implement it, but recharts requires it
if (typeof global !== "undefined" && !global.ResizeObserver) {
    global.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
}
