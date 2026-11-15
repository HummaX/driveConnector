(() => {
  'use strict';
  const form = document.getElementById('login-form');
  const error = document.getElementById('login-error');
  fetch('/api/auth/me', { credentials: 'same-origin' }).then(response => {
    if (response.ok) location.replace('/');
  }).catch(() => {});
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    error.classList.add('hidden');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: document.getElementById('username').value.trim(), password: document.getElementById('password').value })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Sign-in failed. Check your credentials.');
      location.replace('/');
    } catch (problem) {
      error.textContent = problem.message || 'Could not reach the server.';
      error.classList.remove('hidden');
    } finally { button.disabled = false; }
  });
})();
