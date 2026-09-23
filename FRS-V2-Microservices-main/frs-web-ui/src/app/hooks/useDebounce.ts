import { useState, useEffect } from 'react';

/**
 * Custom hook to debounce a value by a specified delay.
 * Useful for debouncing API calls like duplicate email/display name pre-checks.
 */
export function useDebounce<T>(value: T, delay: number = 300): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}
