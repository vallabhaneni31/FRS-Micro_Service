import { describe, it, expect } from 'vitest';
import { validateDisplayName, validateEmailFormat, validateGroupName } from './userValidation';

describe('validateDisplayName (Validation Matrix Scenarios)', () => {
  it('1 & 13 & 19: Empty or whitespace-only name -> "Display Name is required."', () => {
    expect(validateDisplayName('')).toEqual({ valid: false, error: 'Display Name is required.' });
    expect(validateDisplayName('   ')).toEqual({ valid: false, error: 'Display Name is required.' });
  });

  it('2 & 3: Single-letter names -> "Each name must contain at least 2 characters."', () => {
    expect(validateDisplayName('A')).toEqual({ valid: false, error: 'Each name must contain at least 2 characters.' });
    expect(validateDisplayName('A B')).toEqual({ valid: false, error: 'Each name must contain at least 2 characters.' });
  });

  it('4 & 9 & 14 & 16: Valid names -> Accepted', () => {
    expect(validateDisplayName('AB CD')).toEqual({ valid: true, error: null });
    expect(validateDisplayName('John Doe')).toEqual({ valid: true, error: null });
    expect(validateDisplayName('Jo')).toEqual({ valid: true, error: null });
    expect(validateDisplayName('José García')).toEqual({ valid: true, error: null });
  });

  it('5 & 6 & 7: Contains numbers -> "Display Name cannot contain numbers. Please enter alphabetic characters only."', () => {
    expect(validateDisplayName('222222222222222')).toEqual({ valid: false, error: 'Display Name cannot contain numbers. Please enter alphabetic characters only.' });
    expect(validateDisplayName('1234 John')).toEqual({ valid: false, error: 'Display Name cannot contain numbers. Please enter alphabetic characters only.' });
    expect(validateDisplayName('John123')).toEqual({ valid: false, error: 'Display Name cannot contain numbers. Please enter alphabetic characters only.' });
  });

  it('8: Special characters -> "Display Name cannot contain special characters."', () => {
    expect(validateDisplayName('John@Doe')).toEqual({ valid: false, error: 'Display Name cannot contain special characters.' });
  });

  it('10 & 11 & 12: Multiple/leading/trailing spaces -> auto-normalized', () => {
    expect(validateDisplayName('John  Doe')).toEqual({ valid: true, error: null });
    expect(validateDisplayName('  John Doe  ')).toEqual({ valid: true, error: null });
  });

  it('15: Very long name -> "Display Name cannot exceed 100 characters."', () => {
    expect(validateDisplayName('A'.repeat(101))).toEqual({ valid: false, error: 'Display Name cannot exceed 100 characters.' });
  });

  it('17: XSS script tags -> "Display Name contains invalid characters."', () => {
    expect(validateDisplayName('<script>alert(1)</script>')).toEqual({ valid: false, error: 'Display Name contains invalid characters.' });
  });
});

describe('validateGroupName', () => {
  it('should validate valid group names', () => {
    expect(validateGroupName('HR')).toEqual({ valid: true, error: null });
    expect(validateGroupName('Delhi HR Team')).toEqual({ valid: true, error: null });
    expect(validateGroupName('Group-1')).toEqual({ valid: true, error: null });
    expect(validateGroupName('R&D')).toEqual({ valid: true, error: null });
    expect(validateGroupName("Site Operator's Team")).toEqual({ valid: true, error: null });
    expect(validateGroupName('Institution Admins (IA)')).toEqual({ valid: true, error: null });
  });

  it('should fail for empty or whitespace-only group names', () => {
    expect(validateGroupName('')).toEqual({ valid: false, error: 'Group Name is required.' });
    expect(validateGroupName('   ')).toEqual({ valid: false, error: 'Group Name is required.' });
  });

  it('should fail for group names containing consecutive spaces', () => {
    expect(validateGroupName('HR  Team')).toEqual({ valid: false, error: 'Please use a single space between words.' });
  });

  it('should fail for group names that are too short or too long', () => {
    expect(validateGroupName('A')).toEqual({ valid: false, error: 'Group Name must be at least 2 characters long.' });
    expect(validateGroupName('a'.repeat(51))).toEqual({ valid: false, error: 'Group Name must not exceed 50 characters.' });
  });

  it('should fail for group names that do not start with a letter or number', () => {
    expect(validateGroupName('-HR')).toEqual({ valid: false, error: 'Group Name must start with a letter or number.' });
    expect(validateGroupName('.HR')).toEqual({ valid: false, error: 'Group Name must start with a letter or number.' });
    expect(validateGroupName(' HR')).toEqual({ valid: true, error: null }); // after trim, it's just 'HR' which is valid
  });

  it('should fail for group names without at least two alphanumeric characters', () => {
    expect(validateGroupName('.')).toEqual({ valid: false, error: 'Group Name must be at least 2 characters long.' });
    expect(validateGroupName('...')).toEqual({ valid: false, error: 'Group Name must start with a letter or number.' });
    expect(validateGroupName('A.')).toEqual({ valid: false, error: 'Group Name must contain at least 2 letters or numbers.' });
  });

  it('should fail for group names with invalid special characters', () => {
    expect(validateGroupName('HR @ Team')).toEqual({
      valid: false,
      error: "Group Name can only contain letters, numbers, spaces, and typical characters like -, _, &, (, ), ', or .",
    });
    expect(validateGroupName('HR! Team')).toEqual({
      valid: false,
      error: "Group Name can only contain letters, numbers, spaces, and typical characters like -, _, &, (, ), ', or .",
    });
  });
});
