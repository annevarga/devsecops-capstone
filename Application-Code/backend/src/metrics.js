// Application-Code/backend/src/metrics.js
//
// This module instruments the Node.js backend with Prometheus metrics.
// It uses the official prom-client library — the same one used by
// kubernetes itself to expose metrics from its own components.
//
// WHAT THIS GIVES YOU:
//   Default metrics (auto-collected):
//     - process_cpu_seconds_total       — Node.js CPU usage
//     - process_heap_bytes              — V8 heap memory
//     - nodejs_eventloop_lag_seconds    — event loop latency (key for detecting blocking)
//     - nodejs_active_handles_total     — file descriptors, network sockets
//     - nodejs_gc_duration_seconds      — garbage collection pause times
//
//   Custom RED metrics (you define these):
//     - http_requests_total             — Rate: how many requests per second
//     - http_request_duration_seconds   — Duration: how long each request takes
//     - http_requests_in_flight         — a gauge showing concurrent requests
//     - app_errors_total                — Errors: count of 4xx and 5xx responses
//
// The RED method (Rate, Errors, Duration) is the industry-standard approach
// to answering "is my service healthy?" from a user perspective. Infrastructure
// metrics (CPU, memory) tell you about the box. RED metrics tell you about
// the experience of the people using your application.

'use strict';

const client = require('prom-client');

// ── Registry ──────────────────────────────────────────────────────────────────
// A Registry is the collection of all metrics this process exposes.
// We use the global default registry so all metrics end up at /metrics.
const register = client.register;

// Collect all default Node.js process metrics automatically.
// The prefix namespaces them so they're easy to find in Prometheus:
//   nodejs_process_cpu_seconds_total, nodejs_heap_size_total_bytes, etc.
client.collectDefaultMetrics({
    register,
    prefix: 'nodejs_',
    gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5], // seconds
});

// ── Custom Metrics ─────────────────────────────────────────────────────────────

// COUNTER: http_requests_total
// A counter only goes up. It counts every HTTP request received, labelled
// by HTTP method, route, and status code.
// In Grafana you use rate(http_requests_total[5m]) to get requests/second.
const httpRequestsTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests received',
    labelNames: ['method', 'route', 'status_code'],
    registers: [register],
});

// HISTOGRAM: http_request_duration_seconds
// A histogram measures how long things take. It tracks the distribution of
// request durations in configurable buckets (in seconds).
// In Grafana you use histogram_quantile(0.95, ...) to get p95 latency.
// Buckets: 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s, 5s, 10s
const httpRequestDurationSeconds = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [register],
});

// GAUGE: http_requests_in_flight
// A gauge goes up and down. It counts requests currently being processed.
// Useful for detecting traffic spikes that could cause resource exhaustion.
const httpRequestsInFlight = new client.Gauge({
    name: 'http_requests_in_flight',
    help: 'Number of HTTP requests currently being processed',
    registers: [register],
});

// COUNTER: app_errors_total
// Counts 4xx client errors and 5xx server errors separately.
// In Grafana: rate(app_errors_total{type="server_error"}[5m]) gives you
// error rate, which is the E in RED.
const appErrorsTotal = new client.Counter({
    name: 'app_errors_total',
    help: 'Total number of application errors by type',
    labelNames: ['type', 'route'],  // type: client_error | server_error
    registers: [register],
});

// COUNTER: mongodb_operations_total
// Tracks database operations so you can see if slow queries correlate
// with high request latency. Label by operation type and collection.
const mongoOperationsTotal = new client.Counter({
    name: 'mongodb_operations_total',
    help: 'Total number of MongoDB operations',
    labelNames: ['operation', 'collection', 'status'],  // status: success | error
    registers: [register],
});

// HISTOGRAM: mongodb_operation_duration_seconds
// How long MongoDB queries take. If this spikes, you know the bottleneck
// is the database, not your application logic.
const mongoOperationDurationSeconds = new client.Histogram({
    name: 'mongodb_operation_duration_seconds',
    help: 'Duration of MongoDB operations in seconds',
    labelNames: ['operation', 'collection'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [register],
});

// ── Express Middleware ─────────────────────────────────────────────────────────
// This middleware function wraps every Express route handler automatically.
// You call app.use(metricsMiddleware) once and every route gets instrumented.
// No need to add tracking code to each individual route handler.

function metricsMiddleware(req, res, next) {
    // Don't track the /metrics endpoint itself — that would pollute the data
    // with Prometheus's own scrape requests.
    if (req.path === '/metrics' || req.path === '/health') {
        return next();
    }

    // Record that a request has started
    httpRequestsInFlight.inc();

    // Start the latency timer
    const endTimer = httpRequestDurationSeconds.startTimer();

    // Normalise the route: replace numeric IDs with :id so that
    // /api/todos/1, /api/todos/2 etc all group together as /api/todos/:id
    // instead of creating a separate metric series for every unique ID.
    const route = normaliseRoute(req.path);

    // Hook into the response 'finish' event — fires when the response
    // has been sent to the client. This is where we record the outcome.
    res.on('finish', () => {
        const labels = {
            method:      req.method,
            route:       route,
            status_code: res.statusCode,
        };

        // Increment the request counter
        httpRequestsTotal.inc(labels);

        // Record the duration with the same labels
        endTimer(labels);

        // Decrement the in-flight gauge
        httpRequestsInFlight.dec();

        // Track errors separately for easier alerting
        if (res.statusCode >= 400 && res.statusCode < 500) {
            appErrorsTotal.inc({ type: 'client_error', route });
        } else if (res.statusCode >= 500) {
            appErrorsTotal.inc({ type: 'server_error', route });
        }
    });

    next();
}

// Replace path segments that look like IDs (pure numbers, UUIDs, MongoDB ObjectIDs)
// with the placeholder :id so metrics don't explode with high cardinality.
function normaliseRoute(path) {
    return path
        .replace(/\/[0-9a-f]{24}/g, '/:id')       // MongoDB ObjectID
        .replace(/\/[0-9a-f-]{36}/g, '/:id')       // UUID
        .replace(/\/\d+/g, '/:id');                  // numeric ID
}

// ── MongoDB Instrumentation Helper ───────────────────────────────────────────
// Wrap your database calls with this helper to get automatic timing and
// error tracking for each MongoDB operation.
//
// Usage in your route handlers:
//   const result = await trackMongoOperation('find', 'todos', () =>
//       Todo.find({ userId: req.user.id })
//   );

async function trackMongoOperation(operation, collection, fn) {
    const endTimer = mongoOperationDurationSeconds.startTimer({ operation, collection });
    try {
        const result = await fn();
        mongoOperationsTotal.inc({ operation, collection, status: 'success' });
        endTimer({ operation, collection });
        return result;
    } catch (err) {
        mongoOperationsTotal.inc({ operation, collection, status: 'error' });
        endTimer({ operation, collection });
        throw err;
    }
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
    register,
    metricsMiddleware,
    trackMongoOperation,
    // Export raw metric objects in case you need to increment them
    // directly from specific route handlers (e.g. custom business events)
    metrics: {
        httpRequestsTotal,
        httpRequestDurationSeconds,
        httpRequestsInFlight,
        appErrorsTotal,
        mongoOperationsTotal,
        mongoOperationDurationSeconds,
    },
};
