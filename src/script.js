'use strict';
const crypto = require('crypto');
const path = require('path');

// powertop prints tunables as: echo '<value>' > '<path>';
const SCRIPT_RE = /^echo\s+'([^']*)'\s*>\s*'([^']+)'\s*;?$/;
const VALUE_RE = /^[A-Za-z0-9_.:-]{0,64}$/;
const ALLOWED_ROOTS = ['/sys/', '/proc/sys/'];

/**
 * Parse a powertop tuning/wake script into a single sysfs/procfs write.
 * Returns null for anything that is not exactly that form, so the caller
 * never has to run a shell.
 */
function parseScript(script) {
  if (typeof script !== 'string') return null;
  const m = SCRIPT_RE.exec(script.trim());
  if (!m) return null;
  const [, value, target] = m;
  if (!VALUE_RE.test(value)) return null;
  if (!target.startsWith('/')) return null;
  if (path.posix.normalize(target) !== target) return null;
  if (target.split('/').includes('..')) return null;
  if (!ALLOWED_ROOTS.some((root) => target.startsWith(root))) return null;
  return { path: target, value };
}

/** Short stable id for report items (section + description). */
function stableId(...parts) {
  return crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 10);
}

module.exports = { parseScript, stableId };
