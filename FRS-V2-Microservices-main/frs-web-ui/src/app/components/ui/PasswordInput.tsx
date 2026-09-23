import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from './input';
import { cn } from './utils';

export interface PasswordInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  className?: string;
  error?: boolean;
}

export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, error, ...props }, ref) => {
    const [showPassword, setShowPassword] = useState(false);

    const togglePasswordVisibility = (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      setShowPassword((prev) => !prev);
    };

    return (
      <div className="relative flex items-center w-full">
        <Input
          type={showPassword ? 'text' : 'password'}
          className={cn('pr-10', error && 'border-red-500 focus-visible:ring-red-500', className)}
          ref={ref}
          {...props}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={togglePasswordVisibility}
          className="absolute right-3 text-slate-400 hover:text-slate-600 focus:outline-none transition-colors p-1"
          aria-label={showPassword ? 'Hide password' : 'Show password'}
        >
          {showPassword ? (
            <EyeOff className="w-4 h-4" />
          ) : (
            <Eye className="w-4 h-4" />
          )}
        </button>
      </div>
    );
  }
);

PasswordInput.displayName = 'PasswordInput';
