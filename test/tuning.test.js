'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Tuning } = require('../src/tuning');
const { parseReport } = require('../src/parser');

const report = parseReport(fs.readFileSync(path.join(__dirname, 'fixtures', 'intel-untuned.html'), 'utf8'));

function setup({ enabled = true, exclude = [], withReport = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-sys-'));
  const events = [];
  let soon = 0;
  let exclusive = 0;
  const runner = {
    latest: withReport ? { report } : null,
    exclusive: async (fn) => {
      exclusive++;
      return fn();
    },
    measureSoon: () => soon++,
  };
  const settings = { get: () => ({ tuning: { enabled, exclude } }) };
  const history = { addEvent: (kind, text) => events.push({ kind, text }) };
  const t = new Tuning({ settings, runner, history, sysfsRoot: root });
  return { t, root, events, counts: () => ({ soon, exclusive }) };
}

const bad = report.tuning.bad;
const sataPath = (n) => `/sys/class/scsi_host/host${n}/link_power_management_policy`;
const read = (root, p) => fs.readFileSync(path.join(root, p), 'utf8');

test('apply writes the value under the sysfs root, verifies, logs and re-measures', async () => {
  const { t, root, events, counts } = setup();
  const res = await t.apply([bad[0].id]);
  assert.deepEqual(res, [{ id: bad[0].id, description: bad[0].description, ok: true, verified: true }]);
  assert.equal(read(root, sataPath(0)), 'med_power_with_dipm\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'tune');
  assert.match(events[0].text, /host0/);
  assert.deepEqual(counts(), { soon: 1, exclusive: 1 });
});

test('unknown ids and unsupported scripts are reported, not thrown', async () => {
  const { t } = setup();
  const res = await t.apply(['nope']);
  assert.deepEqual(res, [{ id: 'nope', ok: false, error: 'unknown item' }]);
});

test('disabled tuning and missing report are refused', async () => {
  await assert.rejects(setup({ enabled: false }).t.apply([bad[0].id]), (e) => e.status === 403);
  await assert.rejects(setup({ enabled: false }).t.autoTune(), (e) => e.status === 403);
  await assert.rejects(setup({ withReport: false }).t.apply([bad[0].id]), (e) => e.status === 409);
});

test('autoTune applies every non-excluded item (exclude by path or description)', async () => {
  const { t, root } = setup({ exclude: [sataPath(1), 'Enable SATA link power management for host2'] });
  const out = await t.autoTune();
  assert.equal(out.applied, 2);
  assert.equal(out.skipped, 2);
  assert.equal(read(root, sataPath(0)), 'med_power_with_dipm\n');
  assert.equal(read(root, sataPath(3)), 'med_power_with_dipm\n');
  assert.equal(fs.existsSync(path.join(root, sataPath(1))), false);
  assert.equal(fs.existsSync(path.join(root, sataPath(2))), false);
});

test('toggleWake flips the live value', async () => {
  const { t, root } = setup();
  const eno1 = report.wakeup.find((w) => w.description.includes('eno1'));
  const file = path.join(root, eno1.write.path);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'disabled\n');
  assert.deepEqual(await t.toggleWake(eno1.id), { id: eno1.id, ok: true, enabled: true });
  assert.equal(read(root, eno1.write.path), 'enabled\n');
  assert.deepEqual(await t.toggleWake(eno1.id), { id: eno1.id, ok: true, enabled: false });
  await assert.rejects(t.toggleWake('missing'), (e) => e.status === 404);
});

test('apply also toggles wake items (used by impact tests)', async () => {
  const { t, root } = setup();
  const usb1 = report.wakeup.find((w) => w.description.includes('usb1'));
  const res = await t.apply([usb1.id]);
  assert.equal(res[0].ok, true);
  assert.equal(read(root, usb1.write.path), 'enabled\n', 'missing file: falls back to the script value');
});

test('annotate marks excluded tunables and live wake state', () => {
  const { t, root } = setup({ exclude: [sataPath(3)] });
  const eno1 = report.wakeup.find((w) => w.description.includes('eno1'));
  const file = path.join(root, eno1.write.path);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'enabled\n');
  const a = t.annotate(report);
  assert.deepEqual(a.tuning.bad.map((x) => x.excluded), [false, false, false, true]);
  assert.ok(a.tuning.bad.every((x) => x.applicable === true));
  assert.equal(a.wakeup.find((w) => w.id === eno1.id).enabled, true);
  assert.equal(a.wakeup.find((w) => w.description.includes('usb1')).enabled, false, 'fallback: script enables → currently disabled');
  assert.equal(report.tuning.bad[0].excluded, undefined, 'input not mutated');
});
