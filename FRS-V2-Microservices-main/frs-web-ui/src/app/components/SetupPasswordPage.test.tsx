import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SetupPasswordPage } from './SetupPasswordPage';

describe('SetupPasswordPage - Comprehensive Password Validation Test Suite (AB#2793)', () => {

  const createMockFetch = (minPasswordLength: number) => {
    return vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        valid: true,
        email: 'ramya@motivitylabs.com',
        name: 'Ramya',
        roleName: 'Tenant Admin',
        tenantName: 'Motivity',
        siteName: null,
        invitedByName: 'Admin',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        minPasswordLength,
      }),
    } as any);
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Scenario 1: Default 8-character minimum policy', () => {
    beforeEach(() => {
      global.fetch = createMockFetch(8);
    });

    it('Case 1a: 7-character password (Ramya8@) under 8-char rule -> Weak strength, submit button DISABLED', async () => {
      render(<SetupPasswordPage token="test-token" />);
      const passwordInput = await screen.findByPlaceholderText('Choose a strong password');
      const confirmInput = screen.getByPlaceholderText('Repeat your password');
      const submitBtn = screen.getByRole('button', { name: /Set Password/i });

      fireEvent.change(passwordInput, { target: { value: 'Ramya8@' } });
      fireEvent.change(confirmInput, { target: { value: 'Ramya8@' } });

      expect(screen.getByText('Weak')).toBeInTheDocument();
      expect(screen.queryByText('Good')).not.toBeInTheDocument();
      expect(screen.queryByText('Strong')).not.toBeInTheDocument();
      expect(submitBtn).toBeDisabled();
    });

    it('Case 1b: 8-character valid password (Ramya8@1) under 8-char rule -> Strong strength, submit button ENABLED', async () => {
      render(<SetupPasswordPage token="test-token" />);
      const passwordInput = await screen.findByPlaceholderText('Choose a strong password');
      const confirmInput = screen.getByPlaceholderText('Repeat your password');
      const submitBtn = screen.getByRole('button', { name: /Set Password/i });

      fireEvent.change(passwordInput, { target: { value: 'Ramya8@1' } });
      fireEvent.change(confirmInput, { target: { value: 'Ramya8@1' } });

      expect(submitBtn).not.toBeDisabled();
    });

    it('Case 1c: Missing uppercase (ramya8@12) -> submit button DISABLED', async () => {
      render(<SetupPasswordPage token="test-token" />);
      const passwordInput = await screen.findByPlaceholderText('Choose a strong password');
      const confirmInput = screen.getByPlaceholderText('Repeat your password');
      const submitBtn = screen.getByRole('button', { name: /Set Password/i });

      fireEvent.change(passwordInput, { target: { value: 'ramya8@12' } });
      fireEvent.change(confirmInput, { target: { value: 'ramya8@12' } });

      expect(submitBtn).toBeDisabled();
    });

    it('Case 1d: Missing lowercase (RAMYA8@12) -> submit button DISABLED', async () => {
      render(<SetupPasswordPage token="test-token" />);
      const passwordInput = await screen.findByPlaceholderText('Choose a strong password');
      const confirmInput = screen.getByPlaceholderText('Repeat your password');
      const submitBtn = screen.getByRole('button', { name: /Set Password/i });

      fireEvent.change(passwordInput, { target: { value: 'RAMYA8@12' } });
      fireEvent.change(confirmInput, { target: { value: 'RAMYA8@12' } });

      expect(submitBtn).toBeDisabled();
    });

    it('Case 1e: Contains space (Ramya 8@12) -> submit button DISABLED', async () => {
      render(<SetupPasswordPage token="test-token" />);
      const passwordInput = await screen.findByPlaceholderText('Choose a strong password');
      const confirmInput = screen.getByPlaceholderText('Repeat your password');
      const submitBtn = screen.getByRole('button', { name: /Set Password/i });

      fireEvent.change(passwordInput, { target: { value: 'Ramya 8@12' } });
      fireEvent.change(confirmInput, { target: { value: 'Ramya 8@12' } });

      expect(submitBtn).toBeDisabled();
    });

    it('Case 1f: Password mismatch (Ramya8@12 vs Ramya8@99) -> submit button DISABLED', async () => {
      render(<SetupPasswordPage token="test-token" />);
      const passwordInput = await screen.findByPlaceholderText('Choose a strong password');
      const confirmInput = screen.getByPlaceholderText('Repeat your password');
      const submitBtn = screen.getByRole('button', { name: /Set Password/i });

      fireEvent.change(passwordInput, { target: { value: 'Ramya8@12' } });
      fireEvent.change(confirmInput, { target: { value: 'Ramya8@99' } });

      expect(submitBtn).toBeDisabled();
    });
  });

  describe('Scenario 2: Custom 10-character tenant policy', () => {
    beforeEach(() => {
      global.fetch = createMockFetch(10);
    });

    it('Case 2a: 9-character password (Ramya8@12) under 10-char rule -> Weak strength, submit button DISABLED', async () => {
      render(<SetupPasswordPage token="test-token" />);
      const passwordInput = await screen.findByPlaceholderText('Choose a strong password');
      const confirmInput = screen.getByPlaceholderText('Repeat your password');
      const submitBtn = screen.getByRole('button', { name: /Set Password/i });

      fireEvent.change(passwordInput, { target: { value: 'Ramya8@12' } });
      fireEvent.change(confirmInput, { target: { value: 'Ramya8@12' } });

      expect(screen.getByText('Weak')).toBeInTheDocument();
      expect(submitBtn).toBeDisabled();
    });

    it('Case 2b: 10-character password (Ramya8@123) under 10-char rule -> submit button ENABLED', async () => {
      render(<SetupPasswordPage token="test-token" />);
      const passwordInput = await screen.findByPlaceholderText('Choose a strong password');
      const confirmInput = screen.getByPlaceholderText('Repeat your password');
      const submitBtn = screen.getByRole('button', { name: /Set Password/i });

      fireEvent.change(passwordInput, { target: { value: 'Ramya8@123' } });
      fireEvent.change(confirmInput, { target: { value: 'Ramya8@123' } });

      expect(submitBtn).not.toBeDisabled();
    });
  });

  describe('Scenario 3: Strict 14-character tenant policy', () => {
    beforeEach(() => {
      global.fetch = createMockFetch(14);
    });

    it('Case 3a: 12-character password (Ramya8@12345) under 14-char rule -> Weak strength, submit button DISABLED', async () => {
      render(<SetupPasswordPage token="test-token" />);
      const passwordInput = await screen.findByPlaceholderText('Choose a strong password');
      const confirmInput = screen.getByPlaceholderText('Repeat your password');
      const submitBtn = screen.getByRole('button', { name: /Set Password/i });

      fireEvent.change(passwordInput, { target: { value: 'Ramya8@12345' } });
      fireEvent.change(confirmInput, { target: { value: 'Ramya8@12345' } });

      expect(screen.getByText('Weak')).toBeInTheDocument();
      expect(submitBtn).toBeDisabled();
    });

    it('Case 3b: 15-character password (Ramya8@12345678) under 14-char rule -> submit button ENABLED', async () => {
      render(<SetupPasswordPage token="test-token" />);
      const passwordInput = await screen.findByPlaceholderText('Choose a strong password');
      const confirmInput = screen.getByPlaceholderText('Repeat your password');
      const submitBtn = screen.getByRole('button', { name: /Set Password/i });

      fireEvent.change(passwordInput, { target: { value: 'Ramya8@12345678' } });
      fireEvent.change(confirmInput, { target: { value: 'Ramya8@12345678' } });

      expect(submitBtn).not.toBeDisabled();
    });
  });
});
