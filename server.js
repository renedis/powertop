const express = require('express');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { execSync } = require('child_process');

const app = express();
const PORT = 3000;
const REPORT_PATH = '/tmp/powertop/report.html';

app.use(express.static(path.join(__dirname, 'public')));

function parseReport() {
    if (!fs.existsSync(REPORT_PATH)) return null;

    const html = fs.readFileSync(REPORT_PATH, 'utf8');
    const $ = cheerio.load(html);
    const result = {};

    result.sysinfo = {};
    $('table.emphasis1 tr').each((i, row) => {
        const key = $(row).find('th').text().trim();
        const val = $(row).find('td').text().trim();
        if (key && val) result.sysinfo[key] = val;
    });

    // Override sysinfo with host values (container sees its own OS/hostname)
    try {
        const hostOs = fs.readFileSync('/proc/1/root/etc/os-release', 'utf8');
        const pretty = hostOs.match(/PRETTY_NAME="?([^"\n]+)"?/);
        if (pretty) result.sysinfo['OS Information'] = pretty[1];
    } catch (e) {}
    try {
        result.sysinfo['System Name'] = fs.readFileSync('/proc/1/root/etc/hostname', 'utf8').trim();
    } catch (e) {}

    result.summary_stats = [];
    $('ul li.summary_list').each((i, el) => {
        result.summary_stats.push($(el).text().trim());
    });

    result.top_consumers = [];
    $('#summary table.emphasis2 tr.emph1').each((i, row) => {
        const cells = $(row).find('td').map((j, td) => $(td).text().trim()).get();
        if (cells.length >= 4) {
            result.top_consumers.push({
                usage: cells[0],
                events: cells[1],
                category: cells[2],
                description: cells[3]
            });
        }
    });

    result.software = [];
    $('#software table.emphasis2 tr.emph1').each((i, row) => {
        const cells = $(row).find('td').map((j, td) => $(td).text().trim()).get();
        if (cells.length >= 7) {
            result.software.push({
                usage: cells[0],
                wakeups: cells[1],
                gpu_ops: cells[2],
                disk_io: cells[3],
                gfx_wakeups: cells[4],
                category: cells[5],
                description: cells[6]
            });
        }
    });

    result.devices = [];
    $('#devinfo table.emphasis2 tr.emph1').each((i, row) => {
        const cells = $(row).find('td').map((j, td) => $(td).text().trim()).get();
        if (cells.length >= 2) {
            result.devices.push({ name: cells[0], status: cells[1] });
        }
    });

    result.tuning = {};
    const tuningDiv = $('#tuning');
    let currentCategory = 'Uncategorized';
    // Use find() for h2 and table elements rather than children() which can be unreliable
    tuningDiv.find('h2, table').each((i, el) => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'h2') {
            currentCategory = $(el).text().trim();
            if (!result.tuning[currentCategory]) result.tuning[currentCategory] = [];
        } else if (tag === 'table') {
            if (!result.tuning[currentCategory]) result.tuning[currentCategory] = [];
            $(el).find('tr.tune, tr.emph1').each((j, row) => {
                const cells = $(row).find('td').map((k, td) => $(td).text().trim()).get();
                if (cells.length >= 3) {
                    result.tuning[currentCategory].push({
                        description: cells[0],
                        script: cells[1],
                        status: cells[2]
                    });
                } else if (cells.length === 1 && cells[0]) {
                    result.tuning[currentCategory].push({
                        description: cells[0]
                    });
                }
            });
        }
    });

    result.cpuidle = [];

    $('#cpuidle table.emphasis2').each((i, table) => {
        // Tables can contain multiple sections separated by th.title rows
        // Each section: header row with th.title cells, then data rows with td cells
        let currentSection = null;
        $(table).find('tr').each((j, row) => {
            const ths = $(row).find('th.title');
            const tds = $(row).find('td');
            if (ths.length > 0 && tds.length === 0) {
                // Header row — start new section
                const names = ths.map((k, th) => $(th).text().trim()).get();
                const label = names.filter(n => n && n !== '\u00a0')[0] || '';
                if (label) {
                    currentSection = { label, rows: [] };
                    result.cpuidle.push(currentSection);
                }
            } else if (tds.length > 0 && currentSection) {
                // Data row
                const cells = tds.map((k, td) => $(td).text().trim()).get();
                const state = cells[0] || '';
                const value = cells[1] || '';
                if (state && state !== '\u00a0' && value && value !== '\u00a0') {
                    currentSection.rows.push({ state, value });
                }
            }
        });
    });

    result.cpufreq = [];

    $('#cpufreq table.emphasis2').each((i, table) => {
        let currentSection = null;
        $(table).find('tr').each((j, row) => {
            const ths = $(row).find('th.title');
            const tds = $(row).find('td');
            if (ths.length > 0 && tds.length === 0) {
                // Header row — flush previous section if it has data, start new one
                if (currentSection && currentSection.rows.length > 0) {
                    result.cpufreq.push(currentSection);
                }
                const names = ths.map((k, th) => $(th).text().trim()).get();
                const label = names.filter(n => n && n !== '\u00a0')[0] || '';
                if (label) {
                    currentSection = { label, cpus: names.slice(1).filter(n => n && n !== '\u00a0'), rows: [] };
                } else {
                    currentSection = null;
                }
            } else if (ths.length > 0 && tds.length > 0 && currentSection) {
                const label = ths.first().text().trim();
                const values = tds.map((k, td) => $(td).text().trim()).get()
                    .map(v => (v && v !== '\u00a0') ? v : '');
                if (label && label !== '\u00a0' && values.some(v => v !== '')) {
                    currentSection.rows.push({ label, values });
                }
            }
        });
        // Flush last section
        if (currentSection && currentSection.rows.length > 0) {
            result.cpufreq.push(currentSection);
        }
    });

    return result;
}

app.get('/api/data', (req, res) => {
    const data = parseReport();
    if (!data) {
        return res.status(202).json({ available: false });
    }
    const stats = fs.statSync(REPORT_PATH);
    res.json({ available: true, lastUpdated: stats.mtime, data });
});

app.get('/api/status', (req, res) => {
    if (fs.existsSync(REPORT_PATH)) {
        const stats = fs.statSync(REPORT_PATH);
        res.json({ available: true, lastUpdated: stats.mtime });
    } else {
        res.json({ available: false, lastUpdated: null });
    }
});

app.use(express.json());

app.post('/api/auto-tune', (req, res) => {
    try {
        const output = execSync('powertop --auto-tune 2>&1', {
            timeout: 30000,
            encoding: 'utf8'
        });
        res.json({ success: true, output: output || 'Auto-tune completed successfully.' });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.stderr || err.message || 'Failed to run auto-tune'
        });
    }
});

app.listen(PORT, () => {
    console.log(`PowerTop web interface running on http://0.0.0.0:${PORT}`);
});
