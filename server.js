const express = require('express');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const app = express();
const PORT = 3000;
const REPORT_PATH = '/tmp/powertop/report.html';

app.use(express.static(path.join(__dirname, 'public')));

function parseReport() {
    if (!fs.existsSync(REPORT_PATH)) return null;

    const html = fs.readFileSync(REPORT_PATH, 'utf8');
    const $ = cheerio.load(html);
    const result = {};

    // System Info
    result.sysinfo = {};
    $('table.emphasis1 tr').each((i, row) => {
        const key = $(row).find('th').text().trim();
        const val = $(row).find('td').text().trim();
        if (key && val) result.sysinfo[key] = val;
    });

    // Summary stats (Target, System, CPU, GPU, GFX, VFS)
    result.summary_stats = [];
    $('ul li.summary_list').each((i, el) => {
        result.summary_stats.push($(el).text().trim());
    });

    // Top 10 Power Consumers
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

    // Software Info
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

    // Device Info
    result.devices = [];
    $('#devinfo table.emphasis2 tr.emph1').each((i, row) => {
        const cells = $(row).find('td').map((j, td) => $(td).text().trim()).get();
        if (cells.length >= 2) {
            result.devices.push({ name: cells[0], status: cells[1] });
        }
    });

    // Tuning
    result.tuning = [];
    $('#tuning table tr.tune').each((i, row) => {
        const cells = $(row).find('td').map((j, td) => $(td).text().trim()).get();
        if (cells.length >= 3) {
            result.tuning.push({
                description: cells[0],
                script: cells[1],
                status: cells[2]
            });
        }
    });

    // CPU Idle (package/core/cpu tables)
    result.cpuidle_package = [];
    result.cpuidle_cores = [];
    result.cpuidle_cpus = [];

    $('#cpuidle table.emphasis2').each((i, table) => {
        const headers = $(table).find('th.title').map((j, th) => $(th).text().trim()).get().filter(Boolean);
        const rows = [];
        $(table).find('tr').each((j, row) => {
            const cells = $(row).find('td').map((k, td) => $(td).text().trim()).get();
            if (cells.some(c => c && c !== '&nbsp;' && c.trim() !== '')) {
                rows.push(cells);
            }
        });
        if (headers[0] === 'Package') result.cpuidle_package.push({ headers, rows });
        else if (headers[0] && headers[0].startsWith('Core')) result.cpuidle_cores.push({ headers, rows });
        else result.cpuidle_cpus.push({ headers, rows });
    });

    // CPU Frequency
    result.cpufreq = [];
    $('#cpufreq table.emphasis2').each((i, table) => {
        const headers = $(table).find('th.title').map((j, th) => $(th).text().trim()).get().filter(Boolean);
        const rows = [];
        $(table).find('tr').each((j, row) => {
            const label = $(row).find('th.title').first().text().trim();
            const cells = $(row).find('td').map((k, td) => $(td).text().trim()).get();
            if (label && cells.length) rows.push({ label, cells });
        });
        if (rows.length) result.cpufreq.push({ headers, rows });
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

app.listen(PORT, () => {
    console.log(`PowerTop web interface running on http://0.0.0.0:${PORT}`);
});
