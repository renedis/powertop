const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const REPORT_PATH = '/tmp/powertop/report.html';

app.use(express.static(path.join(__dirname, 'public')));

app.get('/report', (req, res) => {
    if (fs.existsSync(REPORT_PATH)) {
        const html = fs.readFileSync(REPORT_PATH, 'utf8');
        res.send(html);
    } else {
        res.status(202).send('<p>PowerTop rapport wordt nog gegenereerd, even geduld... (duurt ~20 seconden)</p>');
    }
});

app.get('/api/status', (req, res) => {
    if (fs.existsSync(REPORT_PATH)) {
        const stats = fs.statSync(REPORT_PATH);
        res.json({
            available: true,
            lastUpdated: stats.mtime
        });
    } else {
        res.json({ available: false, lastUpdated: null });
    }
});

app.listen(PORT, () => {
    console.log(`PowerTop web interface draait op http://0.0.0.0:${PORT}`);
});
