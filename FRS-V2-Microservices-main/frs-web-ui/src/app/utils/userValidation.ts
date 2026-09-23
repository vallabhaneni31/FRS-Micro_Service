export const validateDisplayName = (name: string): { valid: boolean; error: string | null } => {
  if (!name || name.trim() === '') {
    return { valid: false, error: "Display Name is required." };
  }

  const normalized = name.trim().replace(/\s+/g, ' ');

  if (normalized.length > 100) {
    return { valid: false, error: "Display Name cannot exceed 100 characters." };
  }

  const hasScriptOrAngle = /[<>]/.test(normalized);
  if (hasScriptOrAngle) {
    return { valid: false, error: "Display Name contains invalid characters." };
  }

  const hasNumbers = /\d/.test(normalized);
  if (hasNumbers) {
    return { valid: false, error: "Display Name cannot contain numbers. Please enter alphabetic characters only." };
  }

  const hasSpecialChars = /[^\p{L}\p{M}\s]/u.test(normalized);
  if (hasSpecialChars) {
    return { valid: false, error: "Display Name cannot contain special characters." };
  }

  const words = normalized.split(' ');
  for (const word of words) {
    if (word.length < 2) {
      return { valid: false, error: "Each name must contain at least 2 characters." };
    }
  }

  return { valid: true, error: null };
};

export const validateEmailFormat = (email: string): { valid: boolean; error: string | null } => {
  if (!email || email.trim() === '') {
    return { valid: false, error: 'Please enter a valid email address in the format name@domain.tld.' };
  }
  const trimmed = email.trim();
  const pattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!pattern.test(trimmed)) {
    return { valid: false, error: 'Please enter a valid email address in the format name@domain.tld.' };
  }
  const parts = trimmed.split('@');
  if (parts.length !== 2) {
    return { valid: false, error: 'Please enter a valid email address in the format name@domain.tld.' };
  }
  const [username, domain] = parts;
  if (/[-._%+]{2,}/.test(username) || /^[-._%+]|[-._%+]$/.test(username) || /[-.]{2,}/.test(domain) || /^[-.]|[-.]$/.test(domain)) {
    return { valid: false, error: 'Please enter a valid email address in the format name@domain.tld.' };
  }
  
  const tld = domain.split('.').pop()?.toLowerCase() || '';
  
  const validTlds = [
    'com', 'org', 'net', 'in', 'co', 'io', 'edu', 'biz', 'info', 'tech', 'gov', 'mil',
    'uk', 'au', 'us', 'ca', 'nz', 'ac', 'eu', 'me', 'tv', 'cc', 'dev', 'app', 'xyz',
    'ai', 'health', 'design', 'online', 'store', 'int', 'aero', 'jobs', 'mobi', 'pro'
  ];
  
  if (!validTlds.includes(tld)) {
    return { valid: false, error: 'Invalid domain extension. Please use a recognized extension such as .com, .org, .in, .co, .net, .edu, or .io.' };
  }
  
  return { valid: true, error: null };
};

export const normalizeDisplayName = (name: string): string => {
  if (!name) return "";
  return name.trim().replace(/\s+/g, ' ');
};

export const formatDisplayNameInput = (value: string): string => {
  if (!value) return '';
  const noLeadingSpace = value.replace(/^\s+/, '');
  return noLeadingSpace.split(' ').map(word => {
    if (word.length === 0) return '';
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
};

export const validateGroupName = (name: string): { valid: boolean; error: string | null } => {
  if (!name || name.trim() === '') {
    return { valid: false, error: "Group Name is required." };
  }

  if (name.includes('  ')) {
    return { valid: false, error: "Please use a single space between words." };
  }

  const trimmed = name.trim();

  if (trimmed.length < 2) {
    return { valid: false, error: "Group Name must be at least 2 characters long." };
  }

  if (trimmed.length > 50) {
    return { valid: false, error: "Group Name must not exceed 50 characters." };
  }
  if (trimmed.length === 50) {
    return { valid: true, error: "Group Name must not exceed 50 characters." };
  }

  // Must start with an alphanumeric character (letter or number)
  if (!/^[\p{L}\p{N}]/u.test(trimmed)) {
    return { valid: false, error: "Group Name must start with a letter or number." };
  }

  // Must contain at least two letters or numbers to be meaningful
  const alphaNumCount = (trimmed.match(/[\p{L}\p{N}]/gu) || []).length;
  if (alphaNumCount < 2) {
    return { valid: false, error: "Group Name must contain at least 2 letters or numbers." };
  }

  // Allowed characters: letters, numbers, spaces, and typical characters like -, _, &, (, ), ', or .
  if (!/^[\p{L}\p{N}\s\-_&()'.]+$/u.test(trimmed)) {
    return { valid: false, error: "Group Name can only contain letters, numbers, spaces, and typical characters like -, _, &, (, ), ', or ." };
  }

  return { valid: true, error: null };
};

