'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseScript, stableId } = require('../src/script');

test('parseScript accepts sysfs and procfs echo scripts', () => {
  assert.deepEqual(
    parseScript("echo 'med_power_with_dipm' > '/sys/class/scsi_host/host0/link_power_management_policy';"),
    { path: '/sys/class/scsi_host/host0/link_power_management_policy', value: 'med_power_with_dipm' }
  );
  assert.deepEqual(
    parseScript(" echo '1500' > '/proc/sys/vm/dirty_writeback_centisecs'; "),
    { path: '/proc/sys/vm/dirty_writeback_centisecs', value: '1500' }
  );
  assert.deepEqual(
    parseScript("echo 'enabled' > '/sys/bus/usb/devices/1-7/power/wakeup';"),
    { path: '/sys/bus/usb/devices/1-7/power/wakeup', value: 'enabled' }
  );
  assert.deepEqual(
    parseScript("echo 'auto' > '/sys/bus/pci/devices/0000:00:14.0/power/control';"),
    { path: '/sys/bus/pci/devices/0000:00:14.0/power/control', value: 'auto' }
  );
  assert.deepEqual(parseScript("echo '0' > '/proc/sys/kernel/nmi_watchdog'"), { path: '/proc/sys/kernel/nmi_watchdog', value: '0' });
});

test('parseScript rejects anything outside the strict form', () => {
  const bad = [
    "echo 'x' > '/etc/passwd';",
    "echo 'x' > '/sys/../etc/passwd';",
    "echo 'x' > '/sys/a/../../etc/passwd';",
    "echo 'x' > '/sys//class/x';",
    "echo '$(reboot)' > '/sys/class/x';",
    "echo 'a b' > '/sys/class/x';",
    "echo 'a;b' > '/sys/class/x';",
    "echo 'x' > '/sys/class/x'; reboot",
    "ethtool -s eth0 wol d;",
    "echo x > /sys/class/x;",
    "echo 'x' > 'relative/path';",
    '',
    null,
    undefined,
    42,
  ];
  for (const s of bad) assert.equal(parseScript(s), null, String(s));
});

test('stableId is short, deterministic and section-specific', () => {
  const a = stableId('bad', 'Enable SATA link power management for host0');
  assert.match(a, /^[0-9a-f]{10}$/);
  assert.equal(a, stableId('bad', 'Enable SATA link power management for host0'));
  assert.notEqual(a, stableId('good', 'Enable SATA link power management for host0'));
});
