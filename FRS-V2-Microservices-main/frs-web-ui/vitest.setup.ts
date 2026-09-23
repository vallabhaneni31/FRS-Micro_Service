import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Stub ResizeObserver, which JSDOM doesn't implement — needed by Radix UI
// primitives (e.g. Checkbox's useSize) that any component under test may render.
if (typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof window.ResizeObserver;
}

// Stub pointer-capture APIs, which JSDOM doesn't implement — needed by
// Radix UI Select (and other primitives that use pointer capture) that any
// component under test may render.
if (typeof window.HTMLElement.prototype.hasPointerCapture === 'undefined') {
  window.HTMLElement.prototype.hasPointerCapture = () => false;
  window.HTMLElement.prototype.setPointerCapture = () => {};
  window.HTMLElement.prototype.releasePointerCapture = () => {};
}
if (typeof window.HTMLElement.prototype.scrollIntoView === 'undefined') {
  window.HTMLElement.prototype.scrollIntoView = () => {};
}

// Mock matchMedia which is not present in JSDOM
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
