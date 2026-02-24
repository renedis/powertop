const express = require('express');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const app = express();
const PORT = 3000;
const REPORT_PATH = '/tmp/powertop/report.html';

app.use(express.static('public'));

app.get('/api/data', (req, res) => {
    if (!fs.existsSync(REPORT_PATH)) {
        return res.status(404).json({ error: 'Report not found yet' });
    }

    const html = fs.readFileSync(REPORT_PATH, 'utf8');
    const $ = cheerio.load(html);
    const data = {
        summary: [],
        software: [],
        cpu_idle: [],
        cpu_freq: [],
        devices: [],
        tuning: [],
        package_stats: [],
        last_updated: $('.v_p_t_r_t_v').first().text().trim() || new Date().toLocaleTimeString()
    };

    const tableToJson = (selector) => {
        const rows = [];
        $(selector).find('tr').each((i, row) => {
            const cols = [];
            $(row).find('td, th').each((j, col) => {
                cols.push($(col).text().trim());
            });
            if (cols.length > 0) rows.push(cols);
        });
        return rows;
    };

    $('#summary table tr').each((i, row) => {
        const label = $(row).find('td').first().text().trim();
        const value = $(row).find('td').last().text().trim();
        if (label && value) {
            data.summary.push({ label, value });
        }
    });

    $('#cpu_idle table').first().find('tr').each((i, row) => {
        const text = $(row).text();
        if (text.includes('Package 0')) {
            $(row).find('td').each((j, td) => {
                const val = $(td).text().trim();
                if (val.includes('(')) {
                    data.package_stats.push(val);
                }
            });
        }
    });

    data.software = tableToJson('#software table');

    data.cpu_idle = tableToJson('#cpu_idle table');

    data.cpu_freq = tableToJson('#cpu_freq table');

    $('#devices table').each((i, table) => {
        const tableData = tableToJson(table);
        const isProcessActivity = tableData.some(row => row.some(cell => cell.includes('Process Device Activity')));
        if (!isProcessActivity) {
            data.devices.push(...tableData);
        }
    });

    const tuningTable = $('#tuning table');
    if (tuningTable.length > 0) {
        data.tuning = tableToJson('#tuning table');
    } else {
        $('#tuning .p_t_r_t_v').each((i, el) => {
            const row = [];
            $(el).find('div').each((j, div) => row.push($(div).text().trim()));
            if (row.length > 0) data.tuning.push(row);
        });
    }

    res.json(data);
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
