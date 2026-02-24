const express = require('express');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const app = express();
const PORT = 3000;
const REPORT_PATH = '/app/report.html';

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
        package_stats: [], // Nieuw voor de badges
        last_updated: $('.v_p_t_r_t_v').first().text().trim() || new Date().toLocaleTimeString()
    };

    // Helper om tabellen naar JSON te converteren
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

    // 1. Summary & Package Stats (Badges)
    $('#summary table tr').each((i, row) => {
        const label = $(row).find('td').first().text().trim();
        const value = $(row).find('td').last().text().trim();
        if (label && value) {
            data.summary.push({ label, value });
        }
    });

    // Specifieke extractie voor Package 0 badges (C-states)
    $('#cpu_idle table').first().find('tr').each((i, row) => {
        const text = $(row).text();
        if (text.includes('Package 0')) {
            $(row).find('td').each((j, td) => {
                const val = $(td).text().trim();
                if (val.includes('(')) {
                    // Formaat: C10 (pc10) 0.0%
                    data.package_stats.push(val);
                }
            });
        }
    });

    // 2. Software
    data.software = tableToJson('#software table');

    // 3. CPU Idle
    data.cpu_idle = tableToJson('#cpu_idle table');

    // 4. CPU Freq
    data.cpu_freq = tableToJson('#cpu_freq table');

    // 5. Devices (Filteren van Process Device Activity)
    $('#devices table').each((i, table) => {
        const tableData = tableToJson(table);
        // Alleen toevoegen als het niet de "Process Device Activity" tabel is
        const isProcessActivity = tableData.some(row => row.some(cell => cell.includes('Process Device Activity')));
        if (!isProcessActivity) {
            data.devices.push(...tableData);
        }
    });

    // 6. Tuning (Verbeterde selector)
    // PowerTop gebruikt vaak meerdere tabellen of specifieke div structuren voor tuning
    const tuningTable = $('#tuning table');
    if (tuningTable.length > 0) {
        data.tuning = tableToJson('#tuning table');
    } else {
        // Fallback voor als het in divs staat
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
