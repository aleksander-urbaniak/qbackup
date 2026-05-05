function cookieValue(name) {
  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export async function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const csrfToken = cookieValue('qbackup_csrf');
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method) ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(options.headers || {})
    },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.details || `Request failed: ${response.status}`);
  return data;
}

export async function apiBlob(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const csrfToken = cookieValue('qbackup_csrf');
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method) ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(options.headers || {})
    },
    ...options
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || data.details || `Request failed: ${response.status}`);
  }
  return {
    blob: await response.blob(),
    filename: filenameFromDisposition(response.headers.get('Content-Disposition'))
  };
}

function filenameFromDisposition(value) {
  const match = String(value || '').match(/filename="([^"]+)"/);
  return match?.[1] || '';
}
