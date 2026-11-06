const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const names = ['ENDPOINT', 'API_KEY', 'DEPLOYMENT'].map(n => `AZURE_OPENAI_REALTIME_${n}`);
const fakeKey = 'fake-voice-key-not-a-credential';
const existing = Object.fromEntries(names.map((n, i) => [n, `existing-${i}`]));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azure-voice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const callsFile = path.join(dir, 'calls.jsonl');
  const targetFile = path.join(dir, 'target.json');
  const textFile = path.join(dir, 'text settings.env');
  const text = 'export OPENAI_API_KEY=must-not-be-sourced\nexport SOURCED_TEXT_FILE=yes\n';
  fs.writeFileSync(textFile, text);
  fs.writeFileSync(path.join(dir, 'az'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');
if (process.env.MOCK_FAIL === args[2]) {
  console.log(${JSON.stringify(fakeKey)});
  console.error('mock CLI failure');
  process.exit(23);
}
console.log(args[2] === 'show' ? 'mock-domain' : ${JSON.stringify(fakeKey)});
`, { mode: 0o700 });
  const target = path.join(dir, 'target.cjs');
  fs.writeFileSync(target, `require('node:fs').writeFileSync(
    ${JSON.stringify(targetFile)},
    JSON.stringify({ env: process.env, args: process.argv.slice(2) })
  );`);
  // Deliberately do not inherit credentials, shell startup hooks, or the real az PATH.
  const env = {
    PATH: dir,
    OPENAI_API_KEY: 'fake-text-key',
    AZURE_OPENAI_API_KEY: 'fake-azure-text-key',
    AZURE_OPENAI_ENDPOINT: 'https://text.invalid',
    DEPLOYMENT_NAME: 'text-deployment',
    AZURE_OPENAI_API_VERSION: '2025-04-01-preview',
    SPEC_AI_ENV_FILE: textFile,
  };
  return (extra = {}, args = []) => {
    const result = spawnSync('/bin/bash', [
      path.join(__dirname, 'azure-voice.bash'),
      'resource group', 'voice resource', 'voice deployment',
      process.execPath, target, ...args,
    ], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(fs.readFileSync(textFile, 'utf8'), text);
    const launched = fs.existsSync(targetFile)
      ? JSON.parse(fs.readFileSync(targetFile, 'utf8')) : null;
    if (launched) {
      // Bash supplies these housekeeping variables independently of voice settings.
      for (const n of ['PWD', 'SHLVL', '_']) delete launched.env[n];
    }
    return {
      ...result,
      launched,
      input: { ...env, ...extra },
      calls: fs.existsSync(callsFile)
        ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse) : [],
    };
  };
}

const showArgs = [
  'cognitiveservices', 'account', 'show',
  '--resource-group', 'resource group', '--name', 'voice resource',
  '--query', 'properties.customSubDomainName', '-o', 'tsv', '--only-show-errors',
];
const keyArgs = [
  'cognitiveservices', 'account', 'keys', 'list',
  '--resource-group', 'resource group', '--name', 'voice resource',
  '--query', 'key1', '-o', 'tsv', '--only-show-errors',
];

test('fetches only three voice exports, preserves text settings and spaced arguments', t => {
  const args = ['two words', '', 'literal * $HOME ; value'];
  const r = fixture(t)({}, args);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, [showArgs, keyArgs]);
  assert.deepEqual(r.launched, {
    args,
    env: {
      ...r.input,
      [names[0]]: 'https://mock-domain.openai.azure.com',
      [names[1]]: fakeKey,
      [names[2]]: 'voice deployment',
    },
  });
  assert.equal(r.stdout + r.stderr, '');
});

test('all existing voice exports skip az and remain unchanged', t => {
  const r = fixture(t)(existing);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, []);
  assert.deepEqual(r.launched, { args: [], env: r.input });
});

for (let mask = 1; mask < 7; mask++) {
  test(`partial voice exports (mask ${mask}) reject without az or target`, t => {
    const partial = Object.fromEntries(names.filter((_, i) => mask & (1 << i))
      .map(n => [n, existing[n]]));
    const r = fixture(t)(partial);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Set all three/);
    assert.deepEqual(r.calls, []);
    assert.equal(r.launched, null);
  });
}

for (const name of names) {
  for (const complete of [false, true]) {
    test(`empty ${name} rejects with ${complete ? 'all' : 'no other'} exports`, t => {
      const r = fixture(t)({ ...(complete ? existing : {}), [name]: '' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /must not be empty/);
      assert.deepEqual(r.calls, []);
      assert.equal(r.launched, null);
    });
  }
}

test('explicit voice env file without voice exports skips az', t => {
  const r = fixture(t)({ SPEC_AZURE_REALTIME_ENV_FILE: '/unused/voice settings.env' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, []);
  assert.deepEqual(r.launched, { args: [], env: r.input });
});

for (const complete of [false, true]) {
  test(`empty voice env file rejects with ${complete ? 'all' : 'no'} voice exports`, t => {
    const r = fixture(t)({ ...(complete ? existing : {}), SPEC_AZURE_REALTIME_ENV_FILE: '' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unset SPEC_AZURE_REALTIME_ENV_FILE or supply a nonempty file path/);
    assert.deepEqual(r.calls, []);
    assert.equal(r.launched, null);
  });
}

for (const stage of ['show', 'keys']) {
  test(`CLI ${stage} failure neither launches target nor prints key`, t => {
    const r = fixture(t)({ MOCK_FAIL: stage });
    assert.equal(r.status, 23);
    assert.deepEqual(r.calls, stage === 'show' ? [showArgs] : [showArgs, keyArgs]);
    assert.equal(r.launched, null);
    assert.match(r.stderr, /mock CLI failure/);
    assert.ok(!(r.stdout + r.stderr).includes(fakeKey));
  });
}
