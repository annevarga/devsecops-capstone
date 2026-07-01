'use strict';

const tasks              = require('./routes/tasks');
const connection         = require('./db');
const cors               = require('cors');
const express            = require('express');
const mongoose           = require('mongoose');
const { register, metricsMiddleware } = require('./src/metrics');

const app  = express();
const PORT = process.env.PORT || 3500;

connection();

app.use(express.json());
app.use(cors());
app.use(metricsMiddleware);

// Kubernetes liveness probe — is the process alive?
app.get('/healthz', (req, res) => {
    res.status(200).send('Healthy');
});

// Kubernetes readiness probe — is MongoDB connected?
app.get('/ready', (req, res) => {
    const isDbConnected = mongoose.connection.readyState === 1;
    if (isDbConnected) {
        res.status(200).send('Ready');
    } else {
        res.status(503).send('Not Ready');
    }
});

// Kubernetes startup probe
app.get('/started', (req, res) => {
    res.status(200).send('Started');
});

// Prometheus scrapes this every 15 seconds
app.get('/metrics', async (req, res) => {
    try {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
    } catch (err) {
        res.status(500).end(err.message);
    }
});

// Application routes
app.use('/api/tasks', tasks);

app.listen(PORT, () => console.log(`Listening on port ${PORT}...`));

// Clean shutdown when Kubernetes stops the pod
process.on('SIGTERM', () => {
    console.log('SIGTERM received — shutting down gracefully');
    mongoose.connection.close(() => {
        process.exit(0);
    });
});
