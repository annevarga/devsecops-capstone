// Application-Code/backend/server.js
//
// This is the UPDATED version of your backend entry point.
// Lines marked with  ← NEW  are additions for Prometheus instrumentation.
// Everything else is the existing application code.
//
// Changes required:
//   1. require('./src/metrics') at the top
//   2. app.use(metricsMiddleware) before your routes
//   3. Add the /metrics endpoint
//   4. Add the /health endpoint (Kubernetes liveness/readiness probe)

'use strict';

const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');

// ← NEW: Import the metrics module
const { register, metricsMiddleware } = require('./src/metrics');

const app  = express();
const PORT = process.env.PORT || 8080;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ← NEW: Apply metrics middleware BEFORE your routes so every
// request gets timed. Order matters here — put this first.
app.use(metricsMiddleware);

// ── Health endpoint ───────────────────────────────────────────────────────────
// ← NEW: Kubernetes uses this for liveness and readiness probes.
// If this returns non-200, Kubernetes restarts the pod (liveness)
// or removes it from the Service load balancer (readiness).
app.get('/health', (req, res) => {
    const mongoState = mongoose.connection.readyState;
    // readyState: 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
    const healthy = mongoState === 1;

    res.status(healthy ? 200 : 503).json({
        status:   healthy ? 'ok' : 'degraded',
        mongo:    ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoState],
        uptime:   process.uptime(),
        timestamp: new Date().toISOString(),
    });
});

// ← NEW: Prometheus scrapes this endpoint on the interval defined in
// the ServiceMonitor (default: every 15 seconds). It returns all
// metrics in the Prometheus text exposition format.
// DO NOT put authentication on this endpoint if Prometheus cannot
// pass credentials. In production, restrict access via NetworkPolicy
// to allow only the Prometheus pod to reach port 8080 on /metrics.
app.get('/metrics', async (req, res) => {
    try {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
    } catch (err) {
        res.status(500).end(err.message);
    }
});

// ── Your existing routes ──────────────────────────────────────────────────────
// These stay exactly as they are — the metricsMiddleware above instruments
// them automatically without any changes to individual route handlers.

const todoRoutes = require('./src/routes/todos');
app.use('/api/todos', todoRoutes);

// If you want to track MongoDB operations with timing data, wrap your
// Mongoose calls in trackMongoOperation (imported from metrics.js):
//
// const { trackMongoOperation } = require('./src/metrics');
// const todos = await trackMongoOperation('find', 'todos', () => Todo.find({}));

// ── Database connection ───────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongodb-svc:27017/three-tier';

mongoose.connect(MONGO_URI, {
    useNewUrlParser:    true,
    useUnifiedTopology: true,
})
.then(() => {
    console.log('✓ Connected to MongoDB');
    app.listen(PORT, () => {
        console.log(`✓ Backend running on port ${PORT}`);
        console.log(`✓ Metrics available at http://localhost:${PORT}/metrics`);
        console.log(`✓ Health check at http://localhost:${PORT}/health`);
    });
})
.catch(err => {
    console.error('✗ MongoDB connection failed:', err.message);
    process.exit(1);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// When Kubernetes sends SIGTERM (before killing the pod), close the server
// gracefully. This drains in-flight requests rather than cutting them off,
// which prevents 502 errors during rolling deployments.
process.on('SIGTERM', () => {
    console.log('SIGTERM received — shutting down gracefully');
    mongoose.connection.close(() => {
        console.log('MongoDB connection closed');
        process.exit(0);
    });
});
