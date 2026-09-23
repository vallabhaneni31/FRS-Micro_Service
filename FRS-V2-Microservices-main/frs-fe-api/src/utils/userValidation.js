export const validateDisplayName = (name) => {
  if (!name || name.trim() === '') {
    return { valid: false, error: "Display Name is required." };
  }

  if (name.includes('  ')) {
    return { valid: false, error: "Please use a single space between names." };
  }

  const trimmed = name.trim();
  
  if (trimmed.length > 30) {
    return { valid: false, error: "Display Name must not exceed 30 characters." };
  }
  
  const hasNumbers = /\d/.test(trimmed);
  if (hasNumbers) {
    return { valid: false, error: "Display Name cannot contain numbers." };
  }
  
  const hasSpecialChars = /[^\p{L}\p{M}\s]/u.test(trimmed);
  if (hasSpecialChars) {
    return { valid: false, error: "Display Name cannot contain special characters." };
  }
  
  const words = trimmed.split(' ');
  for (const word of words) {
    if (word.length < 2) {
      return { valid: false, error: "Display Name must contain at least 2 characters per name." };
    }
  }
  
  return { valid: true, error: null };
};

export const validateEmailFormat = (email) => {
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

export const normalizeDisplayName = (name) => {
  if (!name) return "";
  return name.trim().replace(/\s+/g, ' ');
};

export const formatDisplayNameInput = (value) => {
  if (!value) return '';
  const noLeadingSpace = value.replace(/^\s+/, '');
  return noLeadingSpace.split(' ').map(word => {
    if (word.length === 0) return '';
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
};
