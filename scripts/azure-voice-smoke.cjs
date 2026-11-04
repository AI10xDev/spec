// Billable live integration check. Run through azure-voice.bash after cargo build.
// Synthetic audio only; credentials and audio remain in memory, never in logs/files.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const names = ['AZURE_OPENAI_VOICE_ENDPOINT', 'AZURE_OPENAI_VOICE_API_KEY',
    'AZURE_OPENAI_WHISPER_DEPLOYMENT', 'AZURE_OPENAI_AUDIO_DEPLOYMENT'];
  const voice = Object.fromEntries(names.map(name => {
    assert.ok(process.env[name], `Missing ${name}`);
    return [name, process.env[name]];
  }));
  const endpoint = new URL(voice.AZURE_OPENAI_VOICE_ENDPOINT);
  assert.equal(endpoint.protocol, 'https:');
  assert.match(endpoint.hostname, /^[a-z0-9-]+\.openai\.azure\.com$/);
  const synthesis = await fetch(`${endpoint.origin}/openai/deployments/${encodeURIComponent(voice.AZURE_OPENAI_AUDIO_DEPLOYMENT)}/chat/completions?api-version=2025-01-01-preview`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: { 'api-key': voice.AZURE_OPENAI_VOICE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: voice.AZURE_OPENAI_AUDIO_DEPLOYMENT, modalities: ['text', 'audio'],
      audio: { voice: 'alloy', format: 'wav' }, max_completion_tokens: 512,
      messages: [{ role: 'user', content: 'Read aloud exactly this question, without answering it or adding any other words: What is two plus two?' }],
    }),
  });
  assert.equal(synthesis.status, 200, `Synthetic audio generation HTTP ${synthesis.status}`);
  const generated = await synthesis.json();
  const wav = generated.choices?.[0]?.message?.audio?.data;
  assert.equal(typeof wav, 'string');
  assert.equal(Buffer.from(wav, 'base64').toString('ascii', 0, 4), 'RIFF');

  const root = path.resolve(__dirname, '..');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-azure-voice-smoke-'));
  let server;
  try {
    server = spawn(path.join(root, 'backend/target/debug/spec'), [], {
      cwd: directory,
      env: { PATH: process.env.PATH, SPEC_WORKSPACE: directory, SPEC_PORT: '0',
        SPEC_UI_DIR: path.join(root, 'frontend/dist'), ...voice },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // The server prints a local access token at startup. Consume it without forwarding stdout.
    const address = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Smoke server startup timed out')), 15_000);
      server.once('error', () => { clearTimeout(timer); reject(new Error('Build the debug backend before the smoke check')); });
      server.once('exit', () => { clearTimeout(timer); reject(new Error('Smoke server exited before startup')); });
      server.stdout.on('data', chunk => {
        output = (output + chunk.toString()).slice(-8192);
        const match = output.match(/Spec: (http:\/\/127\.0\.0\.1:\d+)\/#token=([a-f0-9]+)/);
        if (match) { clearTimeout(timer); resolve({ origin: match[1], token: match[2] }); }
      });
      server.stderr.resume();
    });
    const headers = { Authorization: `Bearer ${address.token}`, 'Content-Type': 'application/json' };
    const config = await fetch(`${address.origin}/api/config`, { headers });
    assert.equal((await config.json()).azureVoice, true);
    const response = await fetch(`${address.origin}/api/voice/azure`, {
      method: 'POST', headers, signal: AbortSignal.timeout(130_000),
      body: JSON.stringify({ audio: wav, format: 'wav', name: 'smoke.md',
        spec: 'A synthetic arithmetic voice integration check.', output: null, messages: [] }),
    });
    assert.equal(response.status, 200, `Backend voice turn HTTP ${response.status}`);
    const result = await response.json();
    assert.match(result.transcript, /two|2/i);
    assert.match(result.answer, /four|4/i);
    assert.equal(result.format, 'mp3');
    assert.ok(Buffer.from(result.audio, 'base64').length > 100);
    console.log(JSON.stringify({ status: 'passed', transcript: result.transcript,
      answer: result.answer, outputFormat: result.format,
      audioBytes: Buffer.from(result.audio, 'base64').length }));
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
