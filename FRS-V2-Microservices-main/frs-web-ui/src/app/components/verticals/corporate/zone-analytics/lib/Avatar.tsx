import React from 'react';
import { initials, ZONE_PALETTE } from './format';

/** Initials avatar (Req 9.2): no photos, no stock or mock images. */
export const Avatar: React.FC<{ name: string; size?: 'sm' | 'md' | 'lg'; seed?: number; className?: string }> = ({ name, size = 'md', seed = 0, className = '' }) => {
  const dims = size === 'sm' ? 'w-7 h-7 text-[10px]' : size === 'lg' ? 'w-14 h-14 text-base' : 'w-12 h-12 text-sm';
  const color = ZONE_PALETTE[Math.abs(seed) % ZONE_PALETTE.length];
  return (
    <div
      data-testid="avatar"
      aria-label={name}
      className={`${dims} rounded-xl flex items-center justify-center font-bold text-white shrink-0 border border-white/40 shadow-2xs ${className}`}
      style={{ backgroundColor: color }}
    >
      {initials(name)}
    </div>
  );
};
