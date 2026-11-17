'use strict';
// Roda a suíte de API contra um Supabase SIMULADO (offline). Uso: npm test
const { spawn } = require('child_process'); const path = require('path');
const root = path.join(__dirname, '..');
const env = { ...process.env, SUPABASE_URL: 'http://localhost:4010', SUPABASE_SERVICE_ROLE_KEY: 'test-key', SUPABASE_ANON_KEY: 'anon-test', ADMIN_PASSWORD: 'SenhaForte#2026', COOKIE_SECURE: 'false', SEED_DEMO: 'true', PORT: '3055', MOCK_PORT: '4010' };
const mock = spawn('node', ['tests/mock-supabase.js'], { cwd: root, env, stdio: 'ignore' });
const dev = spawn('node', ['dev.js'], { cwd: root, env, stdio: 'ignore' });
setTimeout(() => { const t = spawn('node', ['tests/api.test.js'], { cwd: root, env, stdio: 'inherit' }); t.on('exit', c => { mock.kill(); dev.kill(); process.exit(c); }); }, 1500);
